import { pool } from '../../db/pool.js';
import { redis } from '../../infra/redis.js';
import { assertMember } from '../conversation/conversation.service.js';
import { config, VALID_ENVELOPE_TYPES } from '../../config.js';
import type { MessageEnvelope, ConversationPolicy } from '../../config.js';
import { writeAuditLog } from '../../infra/audit.js';
import { randomUUID } from 'crypto';

export class MessageError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'MessageError';
    }
}

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
    read_at?: string | null;
    read_count?: number;
    attachments?: any[];
}

function toIsoOrNull(value: string | null | undefined): string | null {
    if (!value) return null;
    return new Date(value).toISOString();
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

async function hydrateMessages(rows: any[]): Promise<MessageRow[]> {
    const ids = rows.map((r) => r.id);
    const attachmentsById = await fetchAttachmentsByMessageIds(ids);
    return rows.map((row) => sanitizeMessageForClient({
        ...row,
        attachments: attachmentsById.get(row.id) || [],
        read_count: row.read_count ? Number(row.read_count) : 0,
    }));
}

async function getMessageForViewer(messageId: string, viewerId: string): Promise<MessageRow> {
    const { rows } = await pool.query(
        `SELECT m.*,
                m.payload_json AS payload,
                a.agent_name AS sender_name,
                mr.read_at,
                COALESCE(rc.read_count, 0) AS read_count
         FROM messages m
         JOIN agents a ON a.id = m.sender_id
         LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.agent_id = $2
         LEFT JOIN (
             SELECT message_id, COUNT(*)::int AS read_count
             FROM message_reads
             GROUP BY message_id
         ) rc ON rc.message_id = m.id
         WHERE m.id = $1
         LIMIT 1`,
        [messageId, viewerId]
    );
    if (rows.length === 0) {
        throw new MessageError('Message not found', 404);
    }
    const hydrated = await hydrateMessages(rows);
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
        read_count: 0,
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

function assertServerMessageStorage(featureName: string): void {
    if (config.messageStorageMode === 'local_only') {
        throw new MessageError(`${featureName} is unavailable when MESSAGE_STORAGE_MODE=local_only`, 409);
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

    if (config.messageStorageMode === 'local_only') {
        const message = buildLocalOnlyMessageRow(
            conversationId,
            senderId,
            content,
            envelope,
            attachments,
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
                return getMessageForViewer(existing[0].id, senderId);
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

    return getMessageForViewer(message.id, senderId);
}

/**
 * Mark messages as read by agent.
 */
export async function markMessagesRead(
    conversationId: string,
    agentId: string,
    messageIds: string[]
): Promise<{ read_count: number }> {
    if (config.messageStorageMode === 'local_only') {
        return { read_count: 0 };
    }
    await assertMember(conversationId, agentId);
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return { read_count: 0 };
    }

    const { rows } = await pool.query(
        `INSERT INTO message_reads (message_id, agent_id, read_at)
         SELECT m.id, $2, NOW()
         FROM messages m
         WHERE m.conversation_id = $1
           AND m.id = ANY($3::uuid[])
           AND m.deleted_at IS NULL
         ON CONFLICT (message_id, agent_id)
         DO UPDATE SET read_at = EXCLUDED.read_at
         RETURNING message_id`,
        [conversationId, agentId, messageIds]
    );

    return { read_count: rows.length };
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
    assertServerMessageStorage('Message recall');
    await assertMember(conversationId, requesterId);

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
    assertServerMessageStorage('Message delete');
    await assertMember(conversationId, requesterId);
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
    if (config.messageStorageMode === 'local_only') {
        await assertMember(conversationId, agentId);
        return [];
    }
    await assertMember(conversationId, agentId);

    const limit = Math.min(options.limit || 50, 100);

    let query: string;
    let params: any[];

    if (options.before) {
        query = `SELECT m.*,
                        m.payload_json AS payload,
                        a.agent_name AS sender_name,
                        mr.read_at,
                        COALESCE(rc.read_count, 0) AS read_count
                 FROM messages m
                 JOIN agents a ON a.id = m.sender_id
                 LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.agent_id = $2
                 LEFT JOIN (
                    SELECT message_id, COUNT(*)::int AS read_count
                    FROM message_reads
                    GROUP BY message_id
                 ) rc ON rc.message_id = m.id
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
                        mr.read_at,
                        COALESCE(rc.read_count, 0) AS read_count
                 FROM messages m
                 JOIN agents a ON a.id = m.sender_id
                 LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.agent_id = $2
                 LEFT JOIN (
                    SELECT message_id, COUNT(*)::int AS read_count
                    FROM message_reads
                    GROUP BY message_id
                 ) rc ON rc.message_id = m.id
                 WHERE m.conversation_id = $1
                   AND m.deleted_at IS NULL
                 ORDER BY m.created_at DESC
                 LIMIT $3`;
        params = [conversationId, agentId, limit];
    }

    const { rows } = await pool.query(query, params);
    return hydrateMessages(rows);
}
