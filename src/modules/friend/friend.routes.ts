import type { FastifyInstance } from 'fastify';
import {
    removeFriend,
    sendFriendRequest,
    listFriendRequests,
    respondFriendRequest,
    cancelFriendRequest,
    listFriends,
    FriendError,
} from './friend.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { writeAuditLog } from '../../infra/audit.js';
import { notifyAgentEvent } from '../ws/ws.handler.js';

export async function friendRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);

    async function createFriendRequestFlow(
        request: any,
        reply: any,
        toAgentId: string,
        requestMessage?: string,
        auditAction = 'friend.request_sent_compat'
    ) {
        const result = await sendFriendRequest(request.agentId!, toAgentId, requestMessage);
        await writeAuditLog({
            agentId: request.agentId,
            action: result.autoAccepted ? 'friend.request_auto_accepted' : auditAction,
            resourceType: 'friend_request',
            resourceId: result.request.id,
            metadata: { to_agent_id: toAgentId },
            ip: request.ip,
            userAgent: request.headers['user-agent'] as string,
        });

        if (!result.autoAccepted) {
            await notifyAgentEvent(toAgentId, 'received', {
                request_id: result.request.id,
                from_agent_id: request.agentId,
                to_agent_id: toAgentId,
                request_message: requestMessage || null,
                status: 'pending',
                created_at: result.request.created_at,
            });
        } else {
            await notifyAgentEvent(request.agentId!, 'status_changed', {
                request_id: result.request.id,
                from_agent_id: result.request.from_agent_id,
                to_agent_id: result.request.to_agent_id,
                status: 'accepted',
                responded_by: request.agentId,
            });
        }

        return reply.code(result.autoAccepted ? 200 : 201).send(result);
    }

    // Compatibility alias: this endpoint now creates a friend request instead of forcing friendship.
    fastify.post('/', {
        schema: {
            body: {
                type: 'object',
                required: ['friend_id'],
                properties: {
                    friend_id: { type: 'string', format: 'uuid' },
                    request_message: { type: 'string', maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { friend_id, request_message } = request.body as {
                friend_id: string;
                request_message?: string;
            };
            return await createFriendRequestFlow(
                request,
                reply,
                friend_id,
                request_message,
                'friend.request_sent_compat'
            );
        } catch (err) {
            if (err instanceof FriendError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/', async (request, reply) => {
        const friends = await listFriends(request.agentId!);
        return reply.send({ friends });
    });

    fastify.delete<{ Params: { friendId: string } }>('/:friendId', {
        schema: {
            params: {
                type: 'object',
                required: ['friendId'],
                properties: {
                    friendId: { type: 'string', format: 'uuid' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            await removeFriend(request.agentId!, request.params.friendId);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend.remove',
                resourceType: 'agent',
                resourceId: request.params.friendId,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ success: true });
        } catch (err) {
            if (err instanceof FriendError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // New workflow: send request
    fastify.post('/requests', {
        schema: {
            body: {
                type: 'object',
                required: ['to_agent_id'],
                properties: {
                    to_agent_id: { type: 'string', format: 'uuid' },
                    request_message: { type: 'string', maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { to_agent_id, request_message } = request.body as any;
            return await createFriendRequestFlow(
                request,
                reply,
                to_agent_id,
                request_message,
                'friend.request_sent'
            );
        } catch (err) {
            if (err instanceof FriendError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // List incoming/outgoing requests
    fastify.get('/requests', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    direction: { type: 'string', enum: ['incoming', 'outgoing'] },
                    status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'cancelled', 'all'] },
                },
            },
        },
    }, async (request, reply) => {
        const query = request.query as any;
        const requests = await listFriendRequests(request.agentId!, {
            direction: query.direction,
            status: query.status,
        });
        return reply.send({ requests });
    });

    fastify.post<{ Params: { id: string } }>('/requests/:id/accept', async (request, reply) => {
        try {
            const requestRow = await respondFriendRequest(request.params.id, request.agentId!, 'accept');
            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend.request_accepted',
                resourceType: 'friend_request',
                resourceId: request.params.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            await notifyAgentEvent(requestRow.from_agent_id, 'status_changed', {
                request_id: requestRow.id,
                from_agent_id: requestRow.from_agent_id,
                to_agent_id: requestRow.to_agent_id,
                status: requestRow.status,
                responded_by: request.agentId,
                responded_at: requestRow.responded_at,
            });

            return reply.send({ request: requestRow });
        } catch (err) {
            if (err instanceof FriendError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post<{ Params: { id: string } }>('/requests/:id/reject', async (request, reply) => {
        try {
            const requestRow = await respondFriendRequest(request.params.id, request.agentId!, 'reject');
            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend.request_rejected',
                resourceType: 'friend_request',
                resourceId: request.params.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            await notifyAgentEvent(requestRow.from_agent_id, 'status_changed', {
                request_id: requestRow.id,
                from_agent_id: requestRow.from_agent_id,
                to_agent_id: requestRow.to_agent_id,
                status: requestRow.status,
                responded_by: request.agentId,
                responded_at: requestRow.responded_at,
            });

            return reply.send({ request: requestRow });
        } catch (err) {
            if (err instanceof FriendError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.delete<{ Params: { id: string } }>('/requests/:id', async (request, reply) => {
        try {
            const requestRow = await cancelFriendRequest(request.params.id, request.agentId!);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend.request_cancelled',
                resourceType: 'friend_request',
                resourceId: request.params.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            await notifyAgentEvent(requestRow.to_agent_id, 'status_changed', {
                request_id: requestRow.id,
                from_agent_id: requestRow.from_agent_id,
                to_agent_id: requestRow.to_agent_id,
                status: requestRow.status,
                responded_by: request.agentId,
                responded_at: requestRow.responded_at,
            });

            return reply.send({ success: true });
        } catch (err) {
            if (err instanceof FriendError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}
