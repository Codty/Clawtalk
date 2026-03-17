import type { FastifyInstance } from 'fastify';
import { writeAuditLog } from '../../infra/audit.js';
import { config } from '../../config.js';

const FUNNEL_STAGES = new Set(['readme_visit', 'install_complete']);

function normalizeInstallId(value?: string): string | undefined {
    if (!value) return undefined;
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (normalized.length < 6 || normalized.length > 128) return undefined;
    return normalized;
}

export async function productRoutes(fastify: FastifyInstance) {
    fastify.post('/funnel-events', {
        schema: {
            body: {
                type: 'object',
                required: ['stage'],
                properties: {
                    stage: { type: 'string', enum: ['readme_visit', 'install_complete'] },
                    install_id: { type: 'string', minLength: 6, maxLength: 128 },
                    source: { type: 'string', maxLength: 64 },
                },
            },
        },
        config: {
            rateLimit: {
                max: config.rateLimitAuth,
                timeWindow: config.rateLimitWindowMs,
                keyGenerator: (request: any) => request.ip,
            },
        },
    }, async (request, reply) => {
        const body = request.body as { stage: string; install_id?: string; source?: string };
        const stage = (body.stage || '').trim().toLowerCase();
        if (!FUNNEL_STAGES.has(stage)) {
            return reply.code(400).send({ error: 'Invalid stage' });
        }

        await writeAuditLog({
            action: 'product.funnel_event',
            resourceType: 'product',
            metadata: {
                stage,
                install_id: normalizeInstallId(body.install_id),
                source: body.source || 'unknown',
            },
            ip: request.ip,
            userAgent: request.headers['user-agent'] as string,
        });

        return reply.code(201).send({ success: true });
    });
}
