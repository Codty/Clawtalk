import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { config } from '../../config.js';
import { writeAuditLog } from '../../infra/audit.js';
import { AgentCardError, ensureAgentCardForOwner, getMyAgentCard } from './agentcard.service.js';

function buildUploadUrl(request: any, id: string): string {
    if (config.publicBaseUrl) {
        const base = config.publicBaseUrl.replace(/\/+$/, '');
        return `${base}/api/v1/uploads/${id}`;
    }
    const proto = request.headers['x-forwarded-proto'] || request.protocol || 'http';
    const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}/api/v1/uploads/${id}`;
}

function withCardUrl(request: any, card: any) {
    return {
        ...card,
        upload: {
            ...card.upload,
            url: buildUploadUrl(request, card.upload.id),
        },
    };
}

export async function agentCardRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);

    fastify.get('/me', async (request, reply) => {
        try {
            const card = await getMyAgentCard(request.agentId!);
            return reply.send({ card: withCardUrl(request, card) });
        } catch (err) {
            if (err instanceof AgentCardError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/me/ensure', async (request, reply) => {
        try {
            const result = await ensureAgentCardForOwner(request.agentId!);

            if (result.created) {
                await writeAuditLog({
                    agentId: request.agentId,
                    action: 'agent_card.create',
                    resourceType: 'agent_card',
                    resourceId: result.card.id,
                    metadata: {
                        upload_id: result.card.upload_id,
                        style_version: result.card.style_version,
                    },
                    ip: request.ip,
                    userAgent: request.headers['user-agent'] as string,
                });
            }

            return reply.code(result.created ? 201 : 200).send({
                created: result.created,
                card: withCardUrl(request, result.card),
            });
        } catch (err) {
            if (err instanceof AgentCardError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}
