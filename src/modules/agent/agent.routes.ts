import type { FastifyInstance } from 'fastify';
import { getProfile, updateProfile, listAgents, AgentError } from './agent.service.js';
import { authenticate } from '../../middleware/authenticate.js';

export async function agentRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);

    // GET /api/v1/agents — list agents with presence
    fastify.get<{ Querystring: { limit?: string; offset?: string; search?: string } }>(
        '/',
        async (request, reply) => {
            const { limit, offset, search } = request.query;
            const result = await listAgents({
                limit: limit ? parseInt(limit, 10) : undefined,
                offset: offset ? parseInt(offset, 10) : undefined,
                search,
            });
            return reply.send(result);
        }
    );

    // GET /api/v1/agents/:id — get agent profile + presence
    fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        try {
            const profile = await getProfile(request.params.id);
            return reply.send(profile);
        } catch (err) {
            if (err instanceof AgentError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // PUT /api/v1/agents/me — update own profile
    fastify.put('/me', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    display_name: { type: 'string', maxLength: 128 },
                    description: { type: 'string', maxLength: 2048 },
                    aiti_type: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
                    aiti_summary: { anyOf: [{ type: 'string', maxLength: 160 }, { type: 'null' }] },
                    capabilities: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const profile = await updateProfile(request.agentId!, request.body as any);
            return reply.send(profile);
        } catch (err) {
            if (err instanceof AgentError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}
