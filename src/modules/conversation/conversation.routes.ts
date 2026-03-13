import type { FastifyInstance } from 'fastify';
import {
    createOrGetDM,
    createGroup,
    listConversations,
    getConversation,
    addMember,
    removeMember,
    updatePolicy,
    ConversationError,
} from './conversation.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { writeAuditLog } from '../../infra/audit.js';

export async function conversationRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);

    // POST /api/v1/conversations/dm
    fastify.post('/dm', {
        schema: {
            body: {
                type: 'object',
                required: ['peer_agent_id'],
                properties: {
                    peer_agent_id: { type: 'string', format: 'uuid' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { peer_agent_id } = request.body as { peer_agent_id: string };
            const result = await createOrGetDM(request.agentId!, peer_agent_id);

            await writeAuditLog({
                agentId: request.agentId,
                action: result.created ? 'conversation.create_dm' : 'conversation.get_dm',
                resourceType: 'conversation',
                resourceId: result.conversation.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(result.created ? 201 : 200).send(result.conversation);
        } catch (err) {
            if (err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // POST /api/v1/conversations/group
    fastify.post('/group', {
        schema: {
            body: {
                type: 'object',
                required: ['name', 'member_ids'],
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 128 },
                    member_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { name, member_ids } = request.body as { name: string; member_ids: string[] };
            const conv = await createGroup(request.agentId!, name, member_ids);

            await writeAuditLog({
                agentId: request.agentId,
                action: 'conversation.create_group',
                resourceType: 'conversation',
                resourceId: conv.id,
                metadata: { member_count: member_ids.length + 1 },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send(conv);
        } catch (err) {
            if (err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // GET /api/v1/conversations
    fastify.get('/', async (request, reply) => {
        const conversations = await listConversations(request.agentId!);
        return reply.send({ conversations });
    });

    // GET /api/v1/conversations/:id
    fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        try {
            const conv = await getConversation(request.params.id, request.agentId!);
            return reply.send(conv);
        } catch (err) {
            if (err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // ── Policy ──

    // PUT /api/v1/conversations/:id/policy
    fastify.put<{ Params: { id: string } }>('/:id/policy', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    retention_days: { type: 'integer', minimum: 1, maximum: 365 },
                    allow_types: { type: 'array', items: { type: 'string' } },
                    spam_max_per_window: { type: 'integer', minimum: 1 },
                    spam_window_sec: { type: 'integer', minimum: 1 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const policy = await updatePolicy(
                request.params.id,
                request.agentId!,
                request.body as any
            );

            await writeAuditLog({
                agentId: request.agentId,
                action: 'conversation.update_policy',
                resourceType: 'conversation',
                resourceId: request.params.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({ policy });
        } catch (err) {
            if (err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // ── Members ──

    // POST /api/v1/conversations/:id/members
    fastify.post<{ Params: { id: string } }>('/:id/members', {
        schema: {
            body: {
                type: 'object',
                required: ['agent_id'],
                properties: {
                    agent_id: { type: 'string', format: 'uuid' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { agent_id } = request.body as { agent_id: string };
            await addMember(request.params.id, request.agentId!, agent_id);

            await writeAuditLog({
                agentId: request.agentId,
                action: 'conversation.add_member',
                resourceType: 'conversation',
                resourceId: request.params.id,
                metadata: { added_agent_id: agent_id },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(200).send({ ok: true });
        } catch (err) {
            if (err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // DELETE /api/v1/conversations/:id/members/:agentId
    fastify.delete<{ Params: { id: string; agentId: string } }>('/:id/members/:agentId', async (request, reply) => {
        try {
            await removeMember(request.params.id, request.agentId!, request.params.agentId);

            await writeAuditLog({
                agentId: request.agentId,
                action: 'conversation.remove_member',
                resourceType: 'conversation',
                resourceId: request.params.id,
                metadata: { removed_agent_id: request.params.agentId },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(200).send({ ok: true });
        } catch (err) {
            if (err instanceof ConversationError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}
