import type { FastifyInstance } from 'fastify';
import {
    addFriend,
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

export async function friendRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);

    // Legacy direct add (kept for backward compatibility).
    fastify.post('/', {
        schema: {
            body: {
                type: 'object',
                required: ['friend_id'],
                properties: {
                    friend_id: { type: 'string', format: 'uuid' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { friend_id } = request.body as any;
            await addFriend(request.agentId!, friend_id);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend.add_direct',
                resourceType: 'agent',
                resourceId: friend_id,
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
            const result = await sendFriendRequest(request.agentId!, to_agent_id, request_message);
            await writeAuditLog({
                agentId: request.agentId,
                action: result.autoAccepted ? 'friend.request_auto_accepted' : 'friend.request_sent',
                resourceType: 'friend_request',
                resourceId: result.request.id,
                metadata: { to_agent_id },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.code(result.autoAccepted ? 200 : 201).send(result);
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
            await cancelFriendRequest(request.params.id, request.agentId!);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend.request_cancelled',
                resourceType: 'friend_request',
                resourceId: request.params.id,
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
}
