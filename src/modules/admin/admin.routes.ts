import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAdmin } from '../../middleware/require-admin.js';
import { writeAuditLog } from '../../infra/audit.js';
import { disconnectAgent } from '../ws/ws.handler.js';
import {
    listAuditLogs,
    banAgent,
    unbanAgent,
    bootstrapFirstAdmin,
    addRiskWhitelistIp,
    removeRiskWhitelistIp,
    listRiskWhitelist,
    AdminError,
} from './admin.service.js';

export async function adminRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);

    fastify.post('/bootstrap', {
        schema: {
            body: {
                type: 'object',
                required: ['bootstrap_token'],
                properties: {
                    bootstrap_token: { type: 'string', minLength: 8, maxLength: 256 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = request.body as { bootstrap_token: string };
            const admin = await bootstrapFirstAdmin(request.agentId!, body.bootstrap_token);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'admin.bootstrap_first_admin',
                resourceType: 'agent',
                resourceId: request.agentId,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ agent: admin });
        } catch (err) {
            if (err instanceof AdminError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.addHook('preHandler', requireAdmin);

    fastify.get('/audit-logs', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 500 },
                    offset: { type: 'integer', minimum: 0 },
                    action: { type: 'string' },
                    agent_id: { type: 'string', format: 'uuid' },
                },
            },
        },
    }, async (request, reply) => {
        const query = request.query as any;
        const logs = await listAuditLogs({
            limit: query.limit,
            offset: query.offset,
            action: query.action,
            agentId: query.agent_id,
        });
        return reply.send({ logs });
    });

    fastify.post<{ Params: { id: string } }>('/agents/:id/ban', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    reason: { type: 'string', maxLength: 512 },
                    until: { type: 'string', format: 'date-time' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = (request.body || {}) as { reason?: string; until?: string };
            const banned = await banAgent(request.agentId!, request.params.id, body);
            disconnectAgent(request.params.id, 'Banned by admin');

            await writeAuditLog({
                agentId: request.agentId,
                action: 'admin.ban_agent',
                resourceType: 'agent',
                resourceId: request.params.id,
                metadata: { reason: body.reason || null, until: body.until || null },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({ agent: banned });
        } catch (err) {
            if (err instanceof AdminError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post<{ Params: { id: string } }>('/agents/:id/unban', async (request, reply) => {
        try {
            const unbanned = await unbanAgent(request.params.id);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'admin.unban_agent',
                resourceType: 'agent',
                resourceId: request.params.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ agent: unbanned });
        } catch (err) {
            if (err instanceof AdminError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/risk-whitelist', async (_request, reply) => {
        const entries = await listRiskWhitelist();
        return reply.send({ entries });
    });

    fastify.post('/risk-whitelist', {
        schema: {
            body: {
                type: 'object',
                required: ['ip'],
                properties: {
                    ip: { type: 'string', minLength: 2, maxLength: 64 },
                    note: { type: 'string', maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = request.body as { ip: string; note?: string };
            const entry = await addRiskWhitelistIp(body.ip, request.agentId!, body.note);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'admin.whitelist_ip_add',
                resourceType: 'risk_whitelist',
                resourceId: entry.id,
                metadata: { ip: entry.ip },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.code(201).send({ entry });
        } catch (err) {
            if (err instanceof AdminError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.delete<{ Params: { id: string } }>('/risk-whitelist/:id', async (request, reply) => {
        try {
            await removeRiskWhitelistIp(request.params.id);
            await writeAuditLog({
                agentId: request.agentId,
                action: 'admin.whitelist_ip_remove',
                resourceType: 'risk_whitelist',
                resourceId: request.params.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ success: true });
        } catch (err) {
            if (err instanceof AdminError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}
