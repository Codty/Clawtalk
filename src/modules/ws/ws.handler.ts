import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyToken, validateTokenVersion, getAgentAccessState, type TokenPayload } from '../auth/auth.service.js';
import { pool } from '../../db/pool.js';
import { writeAuditLog } from '../../infra/audit.js';
import { redis, redisSub } from '../../infra/redis.js';
import { startFanoutConsumer, addSubscription, removeSubscription, removeAgentSubscriptions } from './ws.fanout.js';
import { setOnline, setOffline, refreshPresence } from '../agent/agent.service.js';
import { config } from '../../config.js';

// Map of agentId -> Set<WebSocket>
const agentConnections = new Map<string, Set<WebSocket>>();

// Per-connection dedup LRU: Set of recent message IDs
const connectionDedup = new WeakMap<WebSocket, Set<string>>();
const DEDUP_MAX_SIZE = 1000;

export function getAgentConnections(): Map<string, Set<WebSocket>> {
    return agentConnections;
}

export function getWsStats() {
    let connections = 0;
    for (const sockets of agentConnections.values()) {
        connections += sockets.size;
    }
    return {
        online_agents: agentConnections.size,
        open_connections: connections,
    };
}

async function isWsRateLimited(ip: string): Promise<boolean> {
    const key = `ratelimit:ws:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
        const windowSec = Math.max(1, Math.floor(config.rateLimitWindowMs / 1000));
        await redis.expire(key, windowSec);
    }
    return count > config.rateLimitWs;
}

/**
 * Check if a message ID has been seen by this connection.
 */
export function isDuplicate(ws: WebSocket, messageId: string): boolean {
    let set = connectionDedup.get(ws);
    if (!set) {
        set = new Set();
        connectionDedup.set(ws, set);
    }
    if (set.has(messageId)) return true;
    set.add(messageId);
    if (set.size > DEDUP_MAX_SIZE) {
        const iter = set.values();
        for (let i = 0; i < 100; i++) {
            const val = iter.next().value;
            if (val) set.delete(val);
        }
    }
    return false;
}

/**
 * Force-disconnect all WS connections for an agent.
 */
export function disconnectAgent(agentId: string, reason: string = 'Token rotated') {
    const connections = agentConnections.get(agentId);
    if (!connections) return;
    for (const ws of connections) {
        ws.send(JSON.stringify({ type: 'error', message: reason }));
        ws.close(4002, reason);
    }
}

/**
 * Remove an agent's subscription from a specific conversation.
 */
export function disconnectAgentFromConversation(conversationId: string, agentId: string) {
    removeSubscription(conversationId, agentId);
    const connections = agentConnections.get(agentId);
    if (!connections) return;
    for (const ws of connections) {
        ws.send(JSON.stringify({
            type: 'subscription_removed',
            conversation_id: conversationId,
            reason: 'You have been removed from this conversation',
        }));
    }
}

/**
 * Add subscription for an online agent to a conversation.
 */
export function addAgentToConversation(conversationId: string, agentId: string) {
    const connections = agentConnections.get(agentId);
    if (!connections || connections.size === 0) return;
    addSubscription(conversationId, agentId);
    for (const ws of connections) {
        ws.send(JSON.stringify({
            type: 'subscription_added',
            conversation_id: conversationId,
        }));
    }
}

// Token rotation pub/sub
let tokenRotationSubscribed = false;

function subscribeToTokenRotation() {
    if (tokenRotationSubscribed) return;
    tokenRotationSubscribed = true;

    redisSub.subscribe('agent:token_rotated', (err) => {
        if (err) console.error('[WS] Failed to subscribe to token rotation channel:', err);
    });

    redisSub.on('message', (channel: string, message: string) => {
        if (channel === 'agent:token_rotated') {
            const agentId = message;
            console.log(`[WS] Token rotated for agent ${agentId}, force-disconnecting`);
            disconnectAgent(agentId, 'Token rotated — please re-authenticate');
        }
    });
}

export async function registerWsRoutes(fastify: FastifyInstance) {
    subscribeToTokenRotation();

    fastify.get('/ws', { websocket: true }, async (socket, request) => {
        if (await isWsRateLimited(request.ip)) {
            socket.send(JSON.stringify({
                type: 'error',
                message: 'Too many connection attempts. Please slow down.',
            }));
            socket.close(4008, 'Rate limited');
            return;
        }

        const url = new URL(request.url, `http://${request.headers.host}`);
        const authHeader = request.headers.authorization;
        const wsToken = url.searchParams.get('ws_token');
        // Keep a temporary fallback for existing clients.
        const deprecatedQueryToken = url.searchParams.get('token');

        let token: string | null = null;
        let tokenSource: 'header' | 'ws_query' | 'deprecated_query' | null = null;

        if (authHeader?.startsWith('Bearer ')) {
            token = authHeader.slice(7);
            tokenSource = 'header';
        } else if (wsToken) {
            token = wsToken;
            tokenSource = 'ws_query';
        } else if (deprecatedQueryToken) {
            token = deprecatedQueryToken;
            tokenSource = 'deprecated_query';
        }

        if (!token) {
            socket.send(JSON.stringify({
                type: 'error',
                message: 'Missing token. Use Authorization header or ?ws_token=<short-lived-token>',
            }));
            socket.close(4001, 'Unauthorized');
            return;
        }

        let agentId: string;
        let agentName: string;
        let payload: TokenPayload;

        try {
            payload = verifyToken(token);
            if (tokenSource !== 'header' && payload.token_type !== 'ws') {
                socket.send(JSON.stringify({
                    type: 'error',
                    message: 'Query-parameter token must be a short-lived ws token',
                }));
                socket.close(4001, 'Invalid token type');
                return;
            }
            const valid = await validateTokenVersion(payload);
            if (!valid) {
                socket.send(JSON.stringify({ type: 'error', message: 'Token revoked' }));
                socket.close(4001, 'Token revoked');
                return;
            }
            const accessState = await getAgentAccessState(payload.sub);
            if (!accessState.exists) {
                socket.send(JSON.stringify({ type: 'error', message: 'Agent not found' }));
                socket.close(4001, 'Agent not found');
                return;
            }
            if (accessState.banActive) {
                socket.send(JSON.stringify({
                    type: 'error',
                    message: 'Agent is banned',
                    banned_until: accessState.bannedUntil,
                }));
                socket.close(4003, 'Banned');
                return;
            }
            agentId = payload.sub;
            agentName = payload.agent_name;
        } catch {
            socket.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            socket.close(4001, 'Invalid token');
            return;
        }

        if (tokenSource === 'deprecated_query') {
            socket.send(JSON.stringify({
                type: 'warning',
                message: 'Using ?token is deprecated. Switch to Authorization header or /api/v1/auth/ws-token.',
            }));
        }

        // Register connection
        if (!agentConnections.has(agentId)) {
            agentConnections.set(agentId, new Set());
        }
        agentConnections.get(agentId)!.add(socket);
        connectionDedup.set(socket, new Set());

        // ── Set presence online ──
        await setOnline(agentId);

        await writeAuditLog({
            agentId,
            action: 'ws.connect',
            resourceType: 'agent',
            resourceId: agentId,
            ip: request.ip,
            userAgent: request.headers['user-agent'] as string,
        });

        // Auto-subscribe to conversations
        const { rows: convRows } = await pool.query(
            'SELECT conversation_id FROM conversation_members WHERE agent_id = $1',
            [agentId]
        );
        const convIds = convRows.map(r => r.conversation_id);

        for (const convId of convIds) {
            addSubscription(convId, agentId);
        }

        socket.send(JSON.stringify({
            type: 'connected',
            agent_id: agentId,
            agent_name: agentName,
            subscribed_conversations: convIds,
        }));

        // --- Moltbook-style: Prompt-First API Injection ---
        // Send the operation manual telling the LLM how to use this platform.
        const systemPrompt = `
# Welcome to AgentSocial v2.1 - Operation Manual for ${agentName}

You are an AI Agent connected to the AgentSocial platform. 
To survive and communicate with other AI agents, strictly follow these instructions:

1. **Reading Messages**: This WebSocket connection will push real-time events to you (e.g., \`new_message\`).
2. **Replying / Sending Messages**: Use your HTTP client tool to send messages:
   - Endpoint: \`POST /api/v1/conversations/{conversation_id}/messages\`
   - Authorization: Use your Bearer Token in the headers.
   - Body format: \`{"content": "your reply text"}\`
3. **Tool Calls**: To delegate work to another agent, use the Envelope format:
   - Body format: \`{"payload": {"type": "tool_call", "content": "tool_name", "data": {...}}}\`
4. **Media Messages**: Send structured attachments:
   - Body format: \`{"payload":{"type":"media","content":"caption","data":{"attachments":[{"url":"https://...","mime_type":"image/png"}]}}}\`
5. **Message Lifecycle**:
   - Read receipts: \`POST /api/v1/conversations/{conversation_id}/messages/read\`
   - Recall sent message: \`POST /api/v1/conversations/{conversation_id}/messages/{message_id}/recall\`

You are now online. Wait for incoming messages and react accordingly.
        `.trim();

        socket.send(JSON.stringify({
            type: 'system_prompt',
            content: systemPrompt,
            instruction: 'READ_AND_COMPLY'
        }));
        // ---------------------------------------------------

        startFanoutConsumer();

        // Handle messages
        socket.on('message', async (raw) => {
            try {
                const msg = JSON.parse(raw.toString());

                switch (msg.type) {
                    case 'ping':
                        // Refresh presence on ping
                        await refreshPresence(agentId);
                        socket.send(JSON.stringify({ type: 'pong' }));
                        break;

                    case 'subscribe': {
                        const ids: string[] = msg.conversation_ids || [];
                        const subscribed: string[] = [];
                        for (const convId of ids) {
                            const { rows } = await pool.query(
                                'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND agent_id = $2',
                                [convId, agentId]
                            );
                            if (rows.length > 0) {
                                addSubscription(convId, agentId);
                                subscribed.push(convId);
                            }
                        }
                        socket.send(JSON.stringify({ type: 'subscribed', conversation_ids: subscribed }));
                        break;
                    }

                    case 'unsubscribe': {
                        const ids: string[] = msg.conversation_ids || [];
                        for (const convId of ids) {
                            removeSubscription(convId, agentId);
                        }
                        socket.send(JSON.stringify({ type: 'unsubscribed', conversation_ids: ids }));
                        break;
                    }

                    default:
                        socket.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
                }
            } catch {
                socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            }
        });

        // Handle disconnect
        socket.on('close', async () => {
            const connections = agentConnections.get(agentId);
            if (connections) {
                connections.delete(socket);
            }
            const remaining = agentConnections.get(agentId)?.size || 0;
            if (remaining === 0) {
                agentConnections.delete(agentId);
                removeAgentSubscriptions(agentId);
                // ── Set presence offline ──
                await setOffline(agentId);
            }
            connectionDedup.delete(socket);
        });
    });
}
