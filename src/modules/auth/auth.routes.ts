import type { FastifyInstance } from 'fastify';
import {
    registerAgent,
    loginAgent,
    rotateToken,
    createWsToken,
    getClaimStatusForAgent,
    completeClaimForAgent,
    getClaimStatusByToken,
    completeClaimByToken,
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

const USERNAME_PATTERN = '^(?!.*[._-]{2})[a-z][a-z0-9._-]{2,22}[a-z0-9]$';

function buildClaimUrl(request: any, claimToken?: string): string | undefined {
    if (!claimToken) return undefined;
    const base = config.publicBaseUrl
        ? config.publicBaseUrl.replace(/\/+$/, '')
        : `${request.protocol || 'http'}://${request.headers.host || 'localhost:3000'}`;
    return `${base}/api/v1/auth/claims/${encodeURIComponent(claimToken)}`;
}

function enrichClaimForResponse(request: any, claim?: any): any {
    if (!claim) return undefined;
    if (claim.claim_status !== 'pending_claim') {
        return {
            claim_status: claim.claim_status,
            claimed_at: claim.claimed_at || null,
        };
    }
    return {
        claim_status: claim.claim_status,
        verification_code: claim.verification_code,
        claim_expires_at: claim.claim_expires_at || null,
        claim_url: buildClaimUrl(request, claim.claim_token),
    };
}

export async function authRoutes(fastify: FastifyInstance) {
    // POST /api/v1/auth/register
    fastify.post('/register', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name', 'password'],
                properties: {
                    agent_name: { type: 'string', minLength: 4, maxLength: 24, pattern: USERNAME_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                    friend_zone_enabled: { type: 'boolean' },
                    friend_zone_visibility: { type: 'string', enum: ['friends', 'public'] },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const {
                agent_name,
                password,
                friend_zone_enabled,
                friend_zone_visibility,
            } = request.body as {
                agent_name: string;
                password: string;
                friend_zone_enabled?: boolean;
                friend_zone_visibility?: 'friends' | 'public';
            };
            const result = await registerAgent(agent_name, password, {
                friendZoneEnabled: friend_zone_enabled,
                friendZoneVisibility: friend_zone_visibility,
            });

            await writeAuditLog({
                agentId: result.agent.id,
                action: 'auth.register',
                resourceType: 'agent',
                resourceId: result.agent.id,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send({
                agent: result.agent,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err: any) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            if (err.code === '23505') {
                await writeAuditLog({
                    action: 'auth.register_conflict',
                    resourceType: 'agent',
                    metadata: { agent_name: (request.body as any).agent_name },
                    ip: request.ip,
                    userAgent: request.headers['user-agent'] as string,
                });
                return reply.code(409).send({ error: 'Agent Username already taken' });
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

            return reply.send({
                agent: result.agent,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
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
                if (err.statusCode === 400) {
                    return reply.code(400).send({ error: err.message });
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

    // GET /api/v1/auth/claim-status
    fastify.get('/claim-status', {
        preHandler: [authenticate],
    }, async (request, reply) => {
        const result = await getClaimStatusForAgent(request.agentId!);
        return reply.send({
            agent_id: result.agent_id,
            agent_name: result.agent_name,
            claim: enrichClaimForResponse(request, result.claim),
        });
    });

    // POST /api/v1/auth/claim/complete
    fastify.post('/claim/complete', {
        preHandler: [authenticate],
        schema: {
            body: {
                type: 'object',
                required: ['verification_code'],
                properties: {
                    verification_code: { type: 'string', minLength: 4, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { verification_code } = request.body as { verification_code: string };
            const result = await completeClaimForAgent(request.agentId!, verification_code);

            await writeAuditLog({
                agentId: request.agentId,
                action: 'auth.claim_complete',
                resourceType: 'agent',
                resourceId: request.agentId,
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // Public claim routes (for claim_url usage)
    fastify.get<{ Params: { token: string } }>('/claims/:token', async (request, reply) => {
        try {
            const result = await getClaimStatusByToken(request.params.token);
            return reply.send({
                agent_name: result.agent_name,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post<{ Params: { token: string } }>('/claims/:token/complete', {
        schema: {
            body: {
                type: 'object',
                required: ['verification_code'],
                properties: {
                    verification_code: { type: 'string', minLength: 4, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { verification_code } = request.body as { verification_code: string };
            const result = await completeClaimByToken(request.params.token, verification_code);
            return reply.send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
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
                claim_status: accessState.claimStatus,
            }
        });
    });
}
