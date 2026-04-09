import type { FastifyInstance } from 'fastify';
import {
    sendMessage,
    getMessages,
    getMessageStatus,
    markMessagesRead,
    recallMessage,
    deleteMessage,
    MessageError,
} from './message.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { writeAuditLog } from '../../infra/audit.js';
import { ConversationError } from '../conversation/conversation.service.js';
import { config } from '../../config.js';

export async function messageRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);

    // POST /api/v1/conversations/:id/messages
    fastify.post<{ Params: { id: string } }>('/:id/messages', {
        schema: {
            body: {
                type: 'object',
                // Either 'content' (string, backward compat) or 'payload' (envelope object)
                properties: {
                    content: { type: 'string', minLength: 1, maxLength: 4096 },
                    payload: {
                        type: 'object',
                        properties: {
                            type: { type: 'string', enum: ['text', 'tool_call', 'event', 'media'] },
                            content: { type: 'string', maxLength: 4096 },
                            data: {},
                        },
                        required: ['type'],
                    },
                    client_msg_id: { type: 'string', maxLength: 128 },
                },
            },
        },
        config: {
            rateLimit: {
                max: config.rateLimitSendMsg,
                timeWindow: config.rateLimitWindowMs,
                keyGenerator: (request: any) => request.agentId || request.ip,
            },
        },
    }, async (request, reply) => {
        try {
            const body = request.body as {
                content?: string;
                payload?: { type: string; content?: string; data?: any };
                client_msg_id?: string;
            };

            const input = body.payload || body.content;
            if (!input) {
                return reply.code(400).send({ error: 'Either "content" or "payload" is required' });
            }

            const message = await sendMessage(request.params.id, request.agentId!, input as any, body.client_msg_id);

            await writeAuditLog({
                agentId: request.agentId,
                action: 'message.send',
                resourceType: 'message',
                resourceId: message.id,
                metadata: { conversation_id: request.params.id, envelope_type: message.payload?.type },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send(message);
        } catch (err) {
            if (err instanceof MessageError || err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // POST /api/v1/conversations/:id/messages/read
    fastify.post<{ Params: { id: string } }>('/:id/messages/read', {
        schema: {
            body: {
                type: 'object',
                required: ['message_ids'],
                properties: {
                    message_ids: { type: 'array', minItems: 1, items: { type: 'string', format: 'uuid' } },
                },
            },
        },
        config: {
            rateLimit: {
                max: config.rateLimitReadMsg,
                timeWindow: config.rateLimitWindowMs,
                keyGenerator: (request: any) => request.agentId || request.ip,
            },
        },
    }, async (request, reply) => {
        try {
            const { message_ids } = request.body as { message_ids: string[] };
            await markMessagesRead(request.params.id, request.agentId!, message_ids);
            return reply.send({ read_count: 0 });
        } catch (err) {
            if (err instanceof MessageError || err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // POST /api/v1/conversations/:id/messages/:messageId/recall
    fastify.post<{ Params: { id: string; messageId: string } }>('/:id/messages/:messageId/recall', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    reason: { type: 'string', maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = (request.body || {}) as { reason?: string };
            const message = await recallMessage(
                request.params.id,
                request.params.messageId,
                request.agentId!,
                body.reason
            );
            await writeAuditLog({
                agentId: request.agentId,
                action: 'message.recall',
                resourceType: 'message',
                resourceId: request.params.messageId,
                metadata: { conversation_id: request.params.id },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send(message);
        } catch (err) {
            if (err instanceof MessageError || err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // DELETE /api/v1/conversations/:id/messages/:messageId
    fastify.delete<{ Params: { id: string; messageId: string } }>('/:id/messages/:messageId', async (request, reply) => {
        try {
            await deleteMessage(request.params.id, request.params.messageId, request.agentId!);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'message.delete',
                resourceType: 'message',
                resourceId: request.params.messageId,
                metadata: { conversation_id: request.params.id },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ success: true });
        } catch (err) {
            if (err instanceof MessageError || err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // GET /api/v1/conversations/:id/messages
    fastify.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
        '/:id/messages',
        {
            config: {
                rateLimit: {
                    max: config.rateLimitReadMsg,
                    timeWindow: config.rateLimitWindowMs,
                    keyGenerator: (request: any) => request.agentId || request.ip,
                },
            },
        },
        async (request, reply) => {
            try {
                const { before, limit } = request.query;
                const messages = await getMessages(request.params.id, request.agentId!, {
                    before,
                    limit: limit ? parseInt(limit, 10) : undefined,
                });
                return reply.send({ messages });
            } catch (err) {
                if (err instanceof ConversationError || err instanceof MessageError) {
                    return reply.code(err.statusCode).send({ error: err.message });
                }
                throw err;
            }
        }
    );

    // GET /api/v1/conversations/:id/messages/:messageId/status
    fastify.get<{ Params: { id: string; messageId: string } }>(
        '/:id/messages/:messageId/status',
        {
            config: {
                rateLimit: {
                    max: config.rateLimitReadMsg,
                    timeWindow: config.rateLimitWindowMs,
                    keyGenerator: (request: any) => request.agentId || request.ip,
                },
            },
        },
        async (request, reply) => {
            try {
                const status = await getMessageStatus(
                    request.params.id,
                    request.params.messageId,
                    request.agentId!
                );
                return reply.send(status);
            } catch (err) {
                if (err instanceof ConversationError || err instanceof MessageError) {
                    return reply.code(err.statusCode).send({ error: err.message });
                }
                throw err;
            }
        }
    );
}
