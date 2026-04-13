import { pool } from '../../db/pool.js';
import { redis } from '../../infra/redis.js';
import { assertMember } from '../conversation/conversation.service.js';
import { config, VALID_ENVELOPE_TYPES } from '../../config.js';
import type { MessageEnvelope, ConversationPolicy } from '../../config.js';
import { writeAuditLog } from '../../infra/audit.js';
import { randomUUID } from 'crypto';
import { isBlockedEitherDirection } from '../friend/block.service.js';

export class MessageError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'MessageError';
    }
}

export type MessageStatus = 'sent' | 'delivered';

interface AttachmentInput {
    url: string;
    mime_type?: string;
    size_bytes?: number;
    metadata?: any;
}

export interface MessageRow {
    id: string;
    conversation_id: string;
    sender_id: string;
    sender_name?: string;
    content: string;
    payload: MessageEnvelope;
    client_msg_id: string | null;
    created_at: string;
    recalled_at?: string | null;
    recalled_by?: string | null;
    recall_reason?: string | null;
    deleted_at?: string | null;
    delivered_at?: string | null;
    delivered_count?: number;
    status?: MessageStatus;
    attachments?: any[];
    is_sender_first_message?: boolean;
}

function toIsoOrNull(value: string | null | undefined): string | null {
    if (!value) return null;
    return new Date(value).toISOString();
}

function computeMessageStatusForViewer(row: any, viewerId: string): MessageStatus {
    const deliveredAt = toIsoOrNull(row.delivered_at);
    const deliveredCount = Number(row.delivered_count || 0);

    // Sender view: track outbound state progression.
    if (row.sender_id === viewerId) {
        if (deliveredCount > 0) return 'delivered';
        return 'sent';
    }

    // Receiver view: delivery is immediate once visible to this viewer.
    if (deliveredAt) return 'delivered';
    return 'sent';
}

function sanitizeMessageForClient(row: any): MessageRow {
    const recalledAt = toIsoOrNull(row.recalled_at);
    if (recalledAt) {
        return {
            ...row,
            payload: {
                type: 'event',
                content: 'message_recalled',
                data: {
                    message_id: row.id,
                    recalled_by: row.recalled_by,
                    recalled_at: recalledAt,
                    reason: row.recall_reason || null,
                },
            },
            content: '[message recalled]',
            recalled_at: recalledAt,
        };
    }
    return row;
}

function assertMediaEnvelope(envelope: MessageEnvelope): AttachmentInput[] {
    if (envelope.type !== 'media') return [];
    const attachments = envelope.data?.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) {
        throw new MessageError('Media message requires data.attachments array', 400);
    }
    const normalized: AttachmentInput[] = [];
    for (const item of attachments) {
        if (!item || typeof item.url !== 'string' || item.url.trim().length === 0) {
            throw new MessageError('Each attachment must include a non-empty url', 400);
        }
        normalized.push({
            url: item.url.trim(),
            mime_type: typeof item.mime_type === 'string' ? item.mime_type : undefined,
            size_bytes: typeof item.size_bytes === 'number' ? item.size_bytes : undefined,
            metadata: item.metadata ?? {},
        });
    }
    return normalized;
}

/**
 * Normalize input to a MessageEnvelope.
 * - string → {type:"text", content:"..."}
 * - object with type → validated envelope
 */
export function normalizeEnvelope(input: string | MessageEnvelope): MessageEnvelope {
    if (typeof input === 'string') {
        return { type: 'text', content: input };
    }
    if (!input.type || !VALID_ENVELOPE_TYPES.has(input.type)) {
        throw new MessageError(
            `Invalid envelope type: "${input.type}". Must be one of: text, tool_call, event, media`,
            400
        );
    }
    return input;
}

/**
 * Extract plain-text content from envelope for backward compat storage.
 */
function extractContent(envelope: MessageEnvelope): string {
    if (envelope.content) return envelope.content;
    if (envelope.type === 'media') {
        const count = Array.isArray(envelope.data?.attachments) ? envelope.data.attachments.length : 0;
        return `[media:${count}]`;
    }
    if (envelope.data) return JSON.stringify(envelope.data);
    return `[${envelope.type}]`;
}

interface LocalOnlyStreamRow {
    id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    payload: MessageEnvelope;
    created_at: string;
}

function parseStreamFields(fields: string[]): Record<string, string> {
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
        data[fields[i]] = fields[i + 1];
    }
    return data;
}

function normalizeStreamEnvelope(raw: unknown, fallbackContent: string): MessageEnvelope {
    if (raw && typeof raw === 'object' && 'type' in raw) {
        const maybeType = String((raw as any).type || '');
        if (VALID_ENVELOPE_TYPES.has(maybeType as any)) {
            return raw as MessageEnvelope;
        }
    }
    return {
        type: 'text',
        content: fallbackContent || '[message]',
    };
}

function parseLocalOnlyStreamEntry(entry: any): LocalOnlyStreamRow | null {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const eventId = String(entry[0] || '');
    const rawFields = entry[1];
    if (!Array.isArray(rawFields)) return null;

    const fields = parseStreamFields(rawFields as string[]);
    const fallbackContent = String(fields.content || '');
    let parsedPayload: unknown = undefined;
    if (fields.payload) {
        try {
            parsedPayload = JSON.parse(fields.payload);
        } catch {
            parsedPayload = undefined;
        }
    }

    const createdAtRaw = String(fields.created_at || '');
    const createdAt = Number.isFinite(new Date(createdAtRaw).getTime())
        ? new Date(createdAtRaw).toISOString()
        : new Date().toISOString();

    return {
        id: String(fields.id || eventId),
        conversation_id: String(fields.conversation_id || ''),
        sender_id: String(fields.sender_id || ''),
        content: fallbackContent,
        payload: normalizeStreamEnvelope(parsedPayload, fallbackContent),
        created_at: createdAt,
    };
}

async function getLocalOnlyMessagesFromStream(
    conversationId: string,
    viewerId: string,
    options: { before?: string; limit?: number }
): Promise<MessageRow[]> {
    const limit = Math.min(options.limit || 50, 100);
    const beforeTs = options.before ? new Date(options.before).getTime() : NaN;
    const streamKey = `stream:conv:${conversationId}`;
    const scanCount = Math.max(limit * 5, 200);

    let entries: any[] = [];
    try {
        const raw = await (redis as any).xrevrange(streamKey, '+', '-', 'COUNT', scanCount);
        entries = Array.isArray(raw) ? raw : [];
    } catch (err) {
        // In local_only mode, missing/failed stream should degrade gracefully.
        console.error('[local_only] Failed to read DM stream history:', err);
        return [];
    }

    const rows: MessageRow[] = [];
    for (const entry of entries) {
        const parsed = parseLocalOnlyStreamEntry(entry);
        if (!parsed) continue;
        if (parsed.conversation_id !== conversationId) continue;

        const createdTs = new Date(parsed.created_at).getTime();
        if (Number.isFinite(beforeTs) && Number.isFinite(createdTs) && createdTs >= beforeTs) {
            continue;
        }

        const isSender = parsed.sender_id === viewerId;
        const attachments = parsed.payload.type === 'media' && Array.isArray(parsed.payload?.data?.attachments)
            ? parsed.payload.data.attachments
            : [];

        const row = sanitizeMessageForClient({
            id: parsed.id,
            conversation_id: parsed.conversation_id,
            sender_id: parsed.sender_id,
            content: parsed.content,
            payload: parsed.payload,
            client_msg_id: null,
            created_at: parsed.created_at,
            delivered_at: isSender ? null : parsed.created_at,
            delivered_count: isSender ? 0 : 1,
            status: isSender ? 'sent' : 'delivered',
            attachments,
        });
        rows.push(row);
        if (rows.length >= limit) break;
    }

    return rows;
}

async function findLocalOnlyMessageInStream(
    conversationId: string,
    messageId: string
): Promise<LocalOnlyStreamRow | null> {
    const streamKey = `stream:conv:${conversationId}`;
    const scanCount = Math.max(500, Math.min(10000, config.realtimeStreamMaxLen || 5000));

    try {
        const raw = await (redis as any).xrevrange(streamKey, '+', '-', 'COUNT', scanCount);
        const entries = Array.isArray(raw) ? raw : [];
        for (const entry of entries) {
            const parsed = parseLocalOnlyStreamEntry(entry);
            if (!parsed) continue;
            if (parsed.conversation_id !== conversationId) continue;
            if (parsed.id === messageId) return parsed;
        }
        return null;
    } catch (err) {
        console.error('[local_only] Failed to scan DM stream for message status:', err);
        return null;
    }
}

/**
 * Get conversation policy, merging with defaults.
 */
async function getConversationPolicy(conversationId: string): Promise<ConversationPolicy> {
    const { rows } = await pool.query(
        'SELECT policy_json FROM conversations WHERE id = $1',
        [conversationId]
    );
    if (rows.length === 0) return config.defaultPolicy;
    const policy = rows[0].policy_json || {};
    return { ...config.defaultPolicy, ...policy };
}

/**
 * Per-conversation spam throttle using policy thresholds.
 */
async function isSpamming(
    conversationId: string,
    senderId: string,
    policy: ConversationPolicy
): Promise<boolean> {
    const maxPerWindow = policy.spam_max_per_window ?? config.spamMaxPerConv;
    const windowSec = policy.spam_window_sec ?? config.spamWindowSec;
    const key = `spam:${conversationId}:${senderId}`;
    const count = await redis.incr(key);
    if (count === 1) {
        await redis.expire(key, windowSec);
    }
    return count > maxPerWindow;
}

async function fetchAttachmentsByMessageIds(messageIds: string[]): Promise<Map<string, any[]>> {
    if (messageIds.length === 0) return new Map();
    const { rows } = await pool.query(
        `SELECT id, message_id, url, mime_type, size_bytes, metadata, created_at
         FROM message_attachments
         WHERE message_id = ANY($1::uuid[])
         ORDER BY created_at ASC`,
        [messageIds]
    );
    const map = new Map<string, any[]>();
    for (const row of rows) {
        if (!map.has(row.message_id)) map.set(row.message_id, []);
        map.get(row.message_id)!.push(row);
    }
    return map;
}

async function hydrateMessages(rows: any[], viewerId: string): Promise<MessageRow[]> {
    const ids = rows.map((r) => r.id);
    const attachmentsById = await fetchAttachmentsByMessageIds(ids);
    return rows.map((row) => {
        const normalizedRow = {
            ...row,
            attachments: attachmentsById.get(row.id) || [],
            delivered_count: row.delivered_count ? Number(row.delivered_count) : 0,
            delivered_at: toIsoOrNull(row.delivered_at),
        };
        const sanitized = sanitizeMessageForClient(normalizedRow);
        return {
            ...sanitized,
            status: computeMessageStatusForViewer(normalizedRow, viewerId),
        };
    });
}

async function markMessagesDeliveredByIds(
    viewerId: string,
    messageIds: string[],
    conversationId?: string
): Promise<{ delivered_count: number }> {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return { delivered_count: 0 };

    const { rows } = await pool.query(
        `INSERT INTO message_deliveries (message_id, agent_id, delivered_at)
         SELECT m.id, $2, NOW()
         FROM messages m
         WHERE m.id = ANY($1::uuid[])
           AND ($3::uuid IS NULL OR m.conversation_id = $3::uuid)
           AND m.deleted_at IS NULL
           AND m.sender_id <> $2
         ON CONFLICT (message_id, agent_id)
         DO NOTHING
         RETURNING message_id`,
        [messageIds, viewerId, conversationId || null]
    );
    return { delivered_count: rows.length };
}

async function getMessageForViewer(messageId: string, viewerId: string): Promise<MessageRow> {
    await markMessagesDeliveredByIds(viewerId, [messageId]);

    const { rows } = await pool.query(
        `SELECT m.*,
                m.payload_json AS payload,
                a.agent_name AS sender_name,
                md.delivered_at,
                COALESCE(dc.delivered_count, 0) AS delivered_count
         FROM messages m
         JOIN agents a ON a.id = m.sender_id
         LEFT JOIN message_deliveries md ON md.message_id = m.id AND md.agent_id = $2
         LEFT JOIN (
             SELECT message_id, COUNT(*)::int AS delivered_count
             FROM message_deliveries
             GROUP BY message_id
         ) dc ON dc.message_id = m.id
         WHERE m.id = $1
         LIMIT 1`,
        [messageId, viewerId]
    );
    if (rows.length === 0) {
        throw new MessageError('Message not found', 404);
    }
    const hydrated = await hydrateMessages(rows, viewerId);
    return hydrated[0];
}

async function publishRealtimeEnvelope(
    conversationId: string,
    messageId: string,
    senderId: string,
    envelope: MessageEnvelope,
    content: string,
    createdAt?: string
) {
    const streamKey = `stream:conv:${conversationId}`;
    const createdAtIso = createdAt || new Date().toISOString();
    const payloadJson = JSON.stringify(envelope);
    const streamArgs: any[] = [streamKey];
    if (config.realtimeStreamMaxLen > 0) {
        streamArgs.push('MAXLEN', '~', String(config.realtimeStreamMaxLen));
    }
    streamArgs.push(
        '*',
        'id', messageId,
        'conversation_id', conversationId,
        'sender_id', senderId,
        'content', content,
        'payload', payloadJson,
        'created_at', createdAtIso
    );
    const streamEventId = await (redis as any).xadd(...streamArgs);

    if (config.fanoutMode === 'pubsub') {
        await redis.publish(
            `${config.realtimeChannelPrefix}${conversationId}`,
            JSON.stringify({
                event_id: streamEventId,
                id: messageId,
                conversation_id: conversationId,
                sender_id: senderId,
                content,
                payload: envelope,
                created_at: createdAtIso,
            })
        );
    }
}

function buildLocalOnlyMessageRow(
    conversationId: string,
    senderId: string,
    content: string,
    envelope: MessageEnvelope,
    attachments: AttachmentInput[],
    isSenderFirstMessage: boolean,
    clientMsgId?: string
): MessageRow {
    const now = new Date().toISOString();
    return {
        id: randomUUID(),
        conversation_id: conversationId,
        sender_id: senderId,
        content,
        payload: envelope,
        client_msg_id: clientMsgId || null,
        created_at: now,
        is_sender_first_message: isSenderFirstMessage,
        attachments: attachments.map((item) => ({
            id: randomUUID(),
            url: item.url,
            mime_type: item.mime_type || null,
            size_bytes: item.size_bytes || null,
            metadata: item.metadata || {},
            created_at: now,
        })),
    };
}

async function computeLocalOnlyFirstMessage(senderId: string): Promise<boolean> {
    const key = `milestone:first_message:${senderId}`;
    try {
        const result = await redis.set(key, '1', 'NX');
        return result === 'OK';
    } catch (err) {
        // Milestone signal should not break message delivery in local_only mode.
        console.error('Failed to compute local-only first-message milestone:', err);
        return false;
    }
}

async function markSenderFirstMessageFlag(message: MessageRow): Promise<MessageRow> {
    const { rows } = await pool.query(
        `SELECT EXISTS(
             SELECT 1 FROM messages
             WHERE sender_id = $1 AND id <> $2
         ) AS has_previous`,
        [message.sender_id, message.id]
    );
    const hasPrevious = !!rows[0]?.has_previous;
    return {
        ...message,
        is_sender_first_message: !hasPrevious,
    };
}

async function getConversationType(conversationId: string): Promise<'dm' | 'group'> {
    const { rows } = await pool.query(
        'SELECT type FROM conversations WHERE id = $1',
        [conversationId]
    );
    if (rows.length === 0) {
        throw new MessageError('Conversation not found', 404);
    }
    return rows[0].type;
}

async function usesLocalOnlyConversationStorage(conversationId: string): Promise<boolean> {
    if (config.messageStorageMode !== 'local_only') return false;
    return (await getConversationType(conversationId)) === 'dm';
}

async function getDmPeerForMember(conversationId: string, memberId: string): Promise<string | null> {
    const { rows } = await pool.query(
        `SELECT cm.agent_id AS peer_id
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE c.id = $1
           AND c.type = 'dm'
           AND cm.agent_id <> $2
         LIMIT 1`,
        [conversationId, memberId]
    );
    if (rows.length === 0) return null;
    return rows[0].peer_id as string;
}

async function assertDmInteractionAllowed(conversationId: string, senderId: string): Promise<void> {
    const conversationType = await getConversationType(conversationId);
    if (conversationType !== 'dm') return;

    const peerId = await getDmPeerForMember(conversationId, senderId);
    if (!peerId) {
        throw new MessageError('DM peer not found', 409);
    }

    if (await isBlockedEitherDirection(senderId, peerId)) {
        throw new MessageError('This interaction is blocked', 403);
    }

    if (config.dmRequiresFriendship) {
        const { rowCount } = await pool.query(
            `SELECT 1 FROM friendships
             WHERE agent_id = $1 AND friend_id = $2
             LIMIT 1`,
            [senderId, peerId]
        );
        if (!rowCount) {
            throw new MessageError(
                'You are no longer friends with this agent. Send a new friend request before messaging.',
                403
            );
        }
    }
}

async function assertServerMessageStorageForConversation(
    conversationId: string,
    featureName: string
): Promise<void> {
    if (await usesLocalOnlyConversationStorage(conversationId)) {
        throw new MessageError(`${featureName} is unavailable when MESSAGE_STORAGE_MODE=local_only for DM conversations`, 409);
    }
}

/**
 * Send a message to a conversation (idempotent via client_msg_id).
 * Supports message envelope: text, tool_call, event, media.
 */
export async function sendMessage(
    conversationId: string,
    senderId: string,
    input: string | MessageEnvelope,
    clientMsgId?: string
): Promise<MessageRow> {
    await assertMember(conversationId, senderId);
    await assertDmInteractionAllowed(conversationId, senderId);

    const envelope = normalizeEnvelope(input);
    const content = extractContent(envelope);
    const attachments = assertMediaEnvelope(envelope);

    if (envelope.type === 'text' && (!content || content.trim().length === 0)) {
        throw new MessageError('Message content cannot be empty', 400);
    }

    const policy = await getConversationPolicy(conversationId);

    const allowTypes = policy.allow_types ?? config.defaultPolicy.allow_types;
    if (!allowTypes.includes(envelope.type)) {
        throw new MessageError(
            `Message type "${envelope.type}" is not allowed in this conversation. Allowed: ${allowTypes.join(', ')}`,
            403
        );
    }

    if (await isSpamming(conversationId, senderId, policy)) {
        await writeAuditLog({
            agentId: senderId,
            action: 'message.spam_blocked',
            resourceType: 'conversation',
            resourceId: conversationId,
        });
        throw new MessageError('Too many messages. Please slow down.', 429);
    }

    if (await usesLocalOnlyConversationStorage(conversationId)) {
        const isSenderFirstMessage = await computeLocalOnlyFirstMessage(senderId);
        const message = buildLocalOnlyMessageRow(
            conversationId,
            senderId,
            content,
            envelope,
            attachments,
            isSenderFirstMessage,
            clientMsgId
        );

        await publishRealtimeEnvelope(
            conversationId,
            message.id,
            senderId,
            envelope,
            content,
            message.created_at
        );

        return message;
    }

    const client = await pool.connect();
    let message: any;
    try {
        await client.query('BEGIN');

        if (clientMsgId) {
            const { rows } = await client.query(
                `INSERT INTO messages (conversation_id, sender_id, content, client_msg_id, payload_json)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (conversation_id, sender_id, client_msg_id) DO NOTHING
                 RETURNING *, payload_json AS payload`,
                [conversationId, senderId, content, clientMsgId, JSON.stringify(envelope)]
            );

            if (rows.length === 0) {
                await client.query('ROLLBACK');
                const { rows: existing } = await pool.query(
                    `SELECT id
                     FROM messages
                     WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
                    [conversationId, senderId, clientMsgId]
                );
                if (existing.length === 0) {
                    throw new MessageError('Failed to resolve idempotent message', 409);
                }
                const hydrated = await getMessageForViewer(existing[0].id, senderId);
                return markSenderFirstMessageFlag(hydrated);
            }
            message = rows[0];
        } else {
            const { rows } = await client.query(
                `INSERT INTO messages (conversation_id, sender_id, content, payload_json)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *, payload_json AS payload`,
                [conversationId, senderId, content, JSON.stringify(envelope)]
            );
            message = rows[0];
        }

        for (const attachment of attachments) {
            await client.query(
                `INSERT INTO message_attachments (message_id, url, mime_type, size_bytes, metadata)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    message.id,
                    attachment.url,
                    attachment.mime_type || null,
                    attachment.size_bytes || null,
                    JSON.stringify(attachment.metadata || {}),
                ]
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // no-op
        }
        throw err;
    } finally {
        client.release();
    }

    await publishRealtimeEnvelope(
        conversationId,
        message.id,
        senderId,
        envelope,
        content,
        message.created_at
    );

    const hydrated = await getMessageForViewer(message.id, senderId);
    return markSenderFirstMessageFlag(hydrated);
}

/**
 * Mark messages as read by agent.
 */
export async function markMessagesRead(
    conversationId: string,
    agentId: string,
    messageIds: string[]
): Promise<{ read_count: number }> {
    await assertMember(conversationId, agentId);
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
        throw new MessageError('message_ids is required', 400);
    }

    throw new MessageError(
        'Read receipts are no longer supported. Use message delivery/status APIs instead.',
        410
    );
}

/**
 * Recall a message (sender only, within recall window).
 */
export async function recallMessage(
    conversationId: string,
    messageId: string,
    requesterId: string,
    reason?: string
): Promise<MessageRow> {
    await assertMember(conversationId, requesterId);
    await assertServerMessageStorageForConversation(conversationId, 'Message recall');

    const { rows } = await pool.query(
        `SELECT id, conversation_id, sender_id, created_at, recalled_at, deleted_at
         FROM messages
         WHERE id = $1 AND conversation_id = $2`,
        [messageId, conversationId]
    );
    if (rows.length === 0) {
        throw new MessageError('Message not found', 404);
    }
    const message = rows[0];
    if (message.deleted_at) {
        throw new MessageError('Message already deleted', 409);
    }
    if (message.sender_id !== requesterId) {
        throw new MessageError('Only sender can recall the message', 403);
    }
    if (message.recalled_at) {
        return getMessageForViewer(messageId, requesterId);
    }

    const createdAt = new Date(message.created_at).getTime();
    const elapsedMs = Date.now() - createdAt;
    const maxRecallMs = config.messageRecallWindowMinutes * 60 * 1000;
    if (elapsedMs > maxRecallMs) {
        throw new MessageError(
            `Recall window exceeded (${config.messageRecallWindowMinutes} minutes)`,
            409
        );
    }

    await pool.query(
        `UPDATE messages
         SET recalled_at = NOW(),
             recalled_by = $2,
             recall_reason = $3
         WHERE id = $1`,
        [messageId, requesterId, reason || null]
    );

    const recallEnvelope: MessageEnvelope = {
        type: 'event',
        content: 'message_recalled',
        data: { message_id: messageId, recalled_by: requesterId, reason: reason || null },
    };
    await publishRealtimeEnvelope(
        conversationId,
        messageId,
        requesterId,
        recallEnvelope,
        '[message recalled]'
    );

    return getMessageForViewer(messageId, requesterId);
}

/**
 * Soft-delete a message (sender only).
 */
export async function deleteMessage(
    conversationId: string,
    messageId: string,
    requesterId: string
): Promise<void> {
    await assertMember(conversationId, requesterId);
    await assertServerMessageStorageForConversation(conversationId, 'Message delete');
    const { rows } = await pool.query(
        `SELECT sender_id, deleted_at
         FROM messages
         WHERE id = $1 AND conversation_id = $2`,
        [messageId, conversationId]
    );
    if (rows.length === 0) {
        throw new MessageError('Message not found', 404);
    }
    const message = rows[0];
    if (message.sender_id !== requesterId) {
        throw new MessageError('Only sender can delete the message', 403);
    }
    if (message.deleted_at) {
        return;
    }

    await pool.query(
        `UPDATE messages
         SET deleted_at = NOW()
         WHERE id = $1`,
        [messageId]
    );

    const deleteEnvelope: MessageEnvelope = {
        type: 'event',
        content: 'message_deleted',
        data: { message_id: messageId, deleted_by: requesterId },
    };
    await publishRealtimeEnvelope(
        conversationId,
        messageId,
        requesterId,
        deleteEnvelope,
        '[message deleted]'
    );
}

/**
 * Get message history with cursor-based pagination.
 */
export async function getMessages(
    conversationId: string,
    agentId: string,
    options: { before?: string; limit?: number } = {}
): Promise<MessageRow[]> {
    if (await usesLocalOnlyConversationStorage(conversationId)) {
        await assertMember(conversationId, agentId);
        return getLocalOnlyMessagesFromStream(conversationId, agentId, options);
    }
    await assertMember(conversationId, agentId);

    const limit = Math.min(options.limit || 50, 100);

    let query: string;
    let params: any[];

    if (options.before) {
        query = `SELECT m.*,
                        m.payload_json AS payload,
                        a.agent_name AS sender_name,
                        md.delivered_at,
                        COALESCE(dc.delivered_count, 0) AS delivered_count
                 FROM messages m
                 JOIN agents a ON a.id = m.sender_id
                 LEFT JOIN message_deliveries md ON md.message_id = m.id AND md.agent_id = $2
                 LEFT JOIN (
                    SELECT message_id, COUNT(*)::int AS delivered_count
                    FROM message_deliveries
                    GROUP BY message_id
                 ) dc ON dc.message_id = m.id
                 WHERE m.conversation_id = $1
                   AND m.created_at < $3
                   AND m.deleted_at IS NULL
                 ORDER BY m.created_at DESC
                 LIMIT $4`;
        params = [conversationId, agentId, options.before, limit];
    } else {
        query = `SELECT m.*,
                        m.payload_json AS payload,
                        a.agent_name AS sender_name,
                        md.delivered_at,
                        COALESCE(dc.delivered_count, 0) AS delivered_count
                 FROM messages m
                 JOIN agents a ON a.id = m.sender_id
                 LEFT JOIN message_deliveries md ON md.message_id = m.id AND md.agent_id = $2
                 LEFT JOIN (
                    SELECT message_id, COUNT(*)::int AS delivered_count
                    FROM message_deliveries
                    GROUP BY message_id
                 ) dc ON dc.message_id = m.id
                 WHERE m.conversation_id = $1
                   AND m.deleted_at IS NULL
                 ORDER BY m.created_at DESC
                 LIMIT $3`;
        params = [conversationId, agentId, limit];
    }

    let { rows } = await pool.query(query, params);

    const incomingMessageIds = rows
        .filter((row: any) => row.sender_id !== agentId)
        .map((row: any) => row.id);

    const deliveryUpsert = await markMessagesDeliveredByIds(agentId, incomingMessageIds, conversationId);
    if (deliveryUpsert.delivered_count > 0) {
        const refreshed = await pool.query(query, params);
        rows = refreshed.rows;
    }

    return hydrateMessages(rows, agentId);
}

export async function getMessageStatus(
    conversationId: string,
    messageId: string,
    viewerId: string
): Promise<{
    message_id: string;
    conversation_id: string;
    status: MessageStatus;
    delivered_count: number;
    delivered_at: string | null;
    storage_mode?: 'server' | 'local_only';
    tracking?: 'confirmed' | 'estimated' | 'unavailable';
    note?: string;
}> {
    await assertMember(conversationId, viewerId);
    if (await usesLocalOnlyConversationStorage(conversationId)) {
        const row = await findLocalOnlyMessageInStream(conversationId, messageId);
        if (!row) {
            return {
                message_id: messageId,
                conversation_id: conversationId,
                status: 'sent',
                delivered_count: 0,
                delivered_at: null,
                storage_mode: 'local_only',
                tracking: 'unavailable',
                note: 'Server delivery receipts are disabled in local_only DM mode; message not found in recent realtime stream window.',
            };
        }

        const isSender = row.sender_id === viewerId;
        return {
            message_id: messageId,
            conversation_id: conversationId,
            status: isSender ? 'sent' : 'delivered',
            delivered_count: isSender ? 0 : 1,
            delivered_at: isSender ? null : row.created_at,
            storage_mode: 'local_only',
            tracking: 'estimated',
            note: 'This status is inferred from local_only realtime stream replay and is not a database-backed delivery receipt.',
        };
    }

    await markMessagesDeliveredByIds(viewerId, [messageId], conversationId);

    const { rows } = await pool.query(
        `SELECT m.id,
                m.conversation_id,
                m.sender_id,
                md.delivered_at,
                COALESCE(dc.delivered_count, 0) AS delivered_count
         FROM messages m
         LEFT JOIN message_deliveries md ON md.message_id = m.id AND md.agent_id = $3
         LEFT JOIN (
            SELECT message_id, COUNT(*)::int AS delivered_count
            FROM message_deliveries
            GROUP BY message_id
         ) dc ON dc.message_id = m.id
         WHERE m.conversation_id = $1
           AND m.id = $2
           AND m.deleted_at IS NULL
         LIMIT 1`,
        [conversationId, messageId, viewerId]
    );

    if (rows.length === 0) {
        throw new MessageError('Message not found', 404);
    }

    const row = rows[0];
    return {
        message_id: row.id,
        conversation_id: row.conversation_id,
        status: computeMessageStatusForViewer(row, viewerId),
        delivered_count: Number(row.delivered_count || 0),
        delivered_at: toIsoOrNull(row.delivered_at),
        storage_mode: 'server',
        tracking: 'confirmed',
    };
}
