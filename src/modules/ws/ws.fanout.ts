import Redis from 'ioredis';
import { config } from '../../config.js';
import { getAgentConnections, isDuplicate } from './ws.handler.js';
import type { RedisClient } from '../../infra/redis.js';

// Map: conversationId -> Set<agentId>
const subscriptions = new Map<string, Set<string>>();

let consumerRunning = false;
let streamConsumerRedis: RedisClient | null = null;
let pubsubRedis: RedisClient | null = null;

const CONSUMER_GROUP = config.consumerGroup;
const CONSUMER_ID = config.consumerId;

export function addSubscription(conversationId: string, agentId: string) {
    if (!subscriptions.has(conversationId)) {
        subscriptions.set(conversationId, new Set());
    }
    subscriptions.get(conversationId)!.add(agentId);
    if (config.fanoutMode === 'single_stream') {
        // Ensure consumer group exists for this stream in single instance mode.
        ensureConsumerGroup(conversationId);
    }
}

export function removeSubscription(conversationId: string, agentId: string) {
    const agents = subscriptions.get(conversationId);
    if (agents) {
        agents.delete(agentId);
        if (agents.size === 0) {
            subscriptions.delete(conversationId);
        }
    }
}

export function removeAgentSubscriptions(agentId: string) {
    for (const [conversationId, agents] of subscriptions) {
        agents.delete(agentId);
        if (agents.size === 0) {
            subscriptions.delete(conversationId);
        }
    }
}

export function getFanoutStats() {
    let totalSubscribers = 0;
    for (const set of subscriptions.values()) {
        totalSubscribers += set.size;
    }
    return {
        mode: config.fanoutMode,
        tracked_conversations: subscriptions.size,
        total_subscriptions: totalSubscribers,
        consumer_running: consumerRunning,
    };
}

async function ensureConsumerGroup(conversationId: string) {
    if (config.fanoutMode !== 'single_stream') return;
    if (!streamConsumerRedis) return;
    const streamKey = `stream:conv:${conversationId}`;
    try {
        await (streamConsumerRedis as any).xgroup('CREATE', streamKey, CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (err: any) {
        // BUSYGROUP = group already exists, that's fine
        if (!err.message?.includes('BUSYGROUP')) {
            console.error(`[Fanout] Failed to create consumer group for ${streamKey}:`, err.message);
        }
    }
}

export function startFanoutConsumer() {
    if (consumerRunning) return;
    consumerRunning = true;
    if (config.fanoutMode === 'pubsub') {
        startPubSubConsumer();
        return;
    }

    streamConsumerRedis = new Redis.default(config.redisUrl);
    for (const convId of subscriptions.keys()) {
        void ensureConsumerGroup(convId);
    }
    consumeLoop();
}

export function stopFanoutConsumer() {
    consumerRunning = false;
    if (streamConsumerRedis) {
        streamConsumerRedis.disconnect();
        streamConsumerRedis = null;
    }
    if (pubsubRedis) {
        pubsubRedis.disconnect();
        pubsubRedis = null;
    }
}

interface RealtimeEventData {
    event_id?: string;
    id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    payload: any;
    created_at: string;
}

function deliverToLocalSubscribers(conversationId: string, eventData: RealtimeEventData) {
    const subscribedAgents = subscriptions.get(conversationId);
    if (!subscribedAgents || subscribedAgents.size === 0) return;

    const agentConnections = getAgentConnections();
    const messagePayload = JSON.stringify({
        type: 'new_message',
        data: eventData,
    });

    const dedupId = eventData.event_id || eventData.id;
    for (const agentId of subscribedAgents) {
        const connections = agentConnections.get(agentId);
        if (!connections) continue;

        for (const ws of connections) {
            if (ws.readyState !== 1) continue;
            if (!isDuplicate(ws, dedupId)) {
                ws.send(messagePayload);
            }
        }
    }
}

function startPubSubConsumer() {
    if (pubsubRedis) return;
    pubsubRedis = new Redis.default(config.redisUrl);
    const pattern = `${config.realtimeChannelPrefix}*`;
    pubsubRedis.psubscribe(pattern, (err) => {
        if (err) {
            console.error(`[Fanout] Failed to subscribe pattern ${pattern}:`, err.message);
        }
    });

    pubsubRedis.on('pmessage', (_pattern: string, channel: string, message: string) => {
        if (!consumerRunning) return;
        if (!channel.startsWith(config.realtimeChannelPrefix)) return;
        const conversationId = channel.slice(config.realtimeChannelPrefix.length);
        if (!conversationId) return;

        try {
            const parsed = JSON.parse(message) as RealtimeEventData;
            if (!parsed?.id || !parsed?.conversation_id) return;
            deliverToLocalSubscribers(conversationId, parsed);
        } catch {
            // Ignore malformed event payloads.
        }
    });

    pubsubRedis.on('error', (err: Error) => {
        console.error('[Fanout] PubSub error:', err.message);
    });

    console.log(`[Fanout] Started in pubsub mode (${pattern})`);
}

function parseStreamFields(fields: string[]): Record<string, string> {
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
        data[fields[i]] = fields[i + 1];
    }
    return data;
}

async function consumeLoop() {
    if (config.fanoutMode !== 'single_stream') return;
    // Wait a moment for initial setup
    await sleep(100);

    while (consumerRunning) {
        try {
            if (subscriptions.size === 0) {
                await sleep(500);
                continue;
            }

            // Process each subscribed conversation stream
            for (const [convId] of subscriptions) {
                if (!consumerRunning) break;
                const streamKey = `stream:conv:${convId}`;

                try {
                    // XREADGROUP GROUP <group> <consumer> COUNT 50 BLOCK 0 STREAMS <key> >
                    // We use non-blocking here since we iterate over multiple streams
                    const result = await (streamConsumerRedis as any).xreadgroup(
                        'GROUP', CONSUMER_GROUP, CONSUMER_ID,
                        'COUNT', 50,
                        'STREAMS', streamKey, '>'
                    );

                    if (!result) continue;

                    for (const [_streamName, entries] of result) {
                        for (const [entryId, fields] of entries) {
                            const data = parseStreamFields(fields as string[]);
                            let payload: any = null;
                            try {
                                payload = data.payload ? JSON.parse(data.payload) : null;
                            } catch {
                                payload = null;
                            }
                            const eventData: RealtimeEventData = {
                                event_id: entryId,
                                id: data.id,
                                conversation_id: data.conversation_id,
                                sender_id: data.sender_id,
                                content: data.content,
                                payload,
                                created_at: data.created_at,
                            };
                            deliverToLocalSubscribers(convId, eventData);

                            // ACK the message after delivery attempt
                            // (at-least-once: if server crashes before ACK, Redis will redeliver)
                            try {
                                await (streamConsumerRedis as any).xack(streamKey, CONSUMER_GROUP, entryId);
                            } catch {
                                // Will be redelivered on next read, which is fine
                            }
                        }
                    }
                } catch (err: any) {
                    // Stream or group may not exist yet
                    if (err.message?.includes('NOGROUP')) {
                        await ensureConsumerGroup(convId);
                    }
                }
            }

            // Small delay between full iteration cycles
            await sleep(100);

        } catch (err: any) {
            if (!consumerRunning) break;
            console.error('[Fanout] Error:', err.message);
            await sleep(1000);
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
