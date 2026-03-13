import type { FastifyInstance } from 'fastify';
import {
    registerAgent,
    loginAgent,
    rotateToken,
    createWsToken,
    getLoginBlockStatus,
    recordFailedLogin,
    clearLoginFailures,
    getAgentAccessState,
    AuthError,
} from './auth.service.js';
import { writeAuditLog } from '../../infra/audit.js';
import { authenticate } from '../../middleware/authenticate.js';
import { config } from '../../config.js';

const authRateLimitConfig = {
    rateLimit: {
        max: config.rateLimitAuth,
        timeWindow: config.rateLimitWindowMs,
        keyGenerator: (request: any) => request.ip,
    },
};

export async function authRoutes(fastify: FastifyInstance) {
    // POST /api/v1/auth/register
    fastify.post('/register', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name', 'password'],
                properties: {
                    agent_name: { type: 'string', minLength: 2, maxLength: 64 },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { agent_name, password } = request.body as { agent_name: string; password: string };
            const result = await registerAgent(agent_name, password);

            await writeAuditLog({
                agentId: result.agent.id,
                action: 'auth.register',
                resourceType: 'agent',
                resourceId: result.agent.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send(result);
        } catch (err: any) {
            if (err.code === '23505') {
                await writeAuditLog({
                    action: 'auth.register_conflict',
                    resourceType: 'agent',
                    metadata: { agent_name: (request.body as any).agent_name },
                    ip: request.ip,
                    userAgent: request.headers['user-agent'] as string,
                });
                return reply.code(409).send({ error: 'Agent name already taken' });
            }
            throw err;
        }
    });

    // POST /api/v1/auth/login
    fastify.post('/login', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name', 'password'],
                properties: {
                    agent_name: { type: 'string' },
                    password: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { agent_name, password } = request.body as { agent_name: string; password: string };
            const blockState = await getLoginBlockStatus(agent_name, request.ip);
            if (blockState.blocked) {
                await writeAuditLog({
                    action: 'auth.login_blocked',
                    resourceType: 'agent',
                    metadata: { agent_name, retry_after_sec: blockState.retryAfterSec },
                    ip: request.ip,
                    userAgent: request.headers['user-agent'] as string,
                });
                return reply.code(429).send({
                    error: 'Too many failed login attempts. Try again later.',
                    retry_after_sec: blockState.retryAfterSec,
                });
            }

            const result = await loginAgent(agent_name, password);
            await clearLoginFailures(agent_name, request.ip);

            await writeAuditLog({
                agentId: result.agent.id,
                action: 'auth.login',
                resourceType: 'agent',
                resourceId: result.agent.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                if (err.statusCode === 403) {
                    await writeAuditLog({
                        action: 'auth.login_banned',
                        resourceType: 'agent',
                        metadata: { agent_name: (request.body as any).agent_name },
                        ip: request.ip,
                        userAgent: request.headers['user-agent'] as string,
                    });
                    return reply.code(403).send({ error: err.message });
                }
                const blockState = await recordFailedLogin(
                    (request.body as any).agent_name || '',
                    request.ip
                );
                await writeAuditLog({
                    action: 'auth.login_failed',
                    resourceType: 'agent',
                    metadata: {
                        agent_name: (request.body as any).agent_name,
                        blocked: blockState.blocked,
                        retry_after_sec: blockState.retryAfterSec,
                    },
                    ip: request.ip,
                    userAgent: request.headers['user-agent'] as string,
                });
                fastify.log.warn(
                    { ip: request.ip, agent_name: (request.body as any).agent_name },
                    'Authentication failed'
                );
                if (blockState.blocked) {
                    return reply.code(429).send({
                        error: 'Too many failed login attempts. Try again later.',
                        retry_after_sec: blockState.retryAfterSec,
                    });
                }
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // POST /api/v1/auth/rotate-token
    fastify.post('/rotate-token', {
        preHandler: [authenticate],
        config: authRateLimitConfig,
    }, async (request, reply) => {
        const agentId = request.agentId!;
        const result = await rotateToken(agentId);

        await writeAuditLog({
            agentId,
            action: 'auth.rotate_token',
            resourceType: 'agent',
            resourceId: agentId,
            ip: request.ip,
            userAgent: request.headers['user-agent'] as string,
        });

        return reply.send(result);
    });

    // POST /api/v1/auth/ws-token
    // Issue short-lived WebSocket token to avoid exposing access token in URL params.
    fastify.post('/ws-token', {
        preHandler: [authenticate],
        config: authRateLimitConfig,
    }, async (request, reply) => {
        const result = await createWsToken(request.agentId!);
        return reply.send(result);
    });

    // GET /api/v1/auth/verify-token
    // Identity Hub endpoint for third-party apps to verify a Moltbook/AgentSocial token
    fastify.get('/verify-token', {
        preHandler: [authenticate],
    }, async (request, reply) => {
        // If authenticate passes, the token is valid, and we have request.agentId
        // Let's return the basic profile info of the agent
        const { getProfile } = await import('../agent/agent.service.js');
        const agent = await getProfile(request.agentId!);
        
        if (!agent) {
            return reply.code(404).send({ error: 'Agent not found' });
        }
        const accessState = await getAgentAccessState(request.agentId!);
        
        return reply.send({
            valid: true,
            agent: {
                id: agent.id,
                agent_name: agent.agent_name,
                display_name: agent.display_name,
                capabilities: agent.capabilities,
                is_admin: accessState.isAdmin,
            }
        });
    });
}
