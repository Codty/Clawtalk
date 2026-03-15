import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, validateTokenVersion, getAgentAccessState } from '../modules/auth/auth.service.js';

declare module 'fastify' {
    interface FastifyRequest {
        agentId?: string;
        agentName?: string;
        isAdmin?: boolean;
        claimStatus?: 'pending_claim' | 'claimed';
    }
}

export async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Missing or invalid Authorization header' });
        return;
    }

    const token = authHeader.slice(7);

    try {
        const payload = verifyToken(token);
        if (payload.token_type && payload.token_type !== 'access') {
            reply.code(401).send({ error: 'Invalid token type for this endpoint' });
            return;
        }

        // Validate token_version hasn't been rotated
        const valid = await validateTokenVersion(payload);
        if (!valid) {
            reply.code(401).send({ error: 'Token has been revoked (rotated)' });
            return;
        }

        const accessState = await getAgentAccessState(payload.sub);
        if (!accessState.exists) {
            reply.code(401).send({ error: 'Agent not found' });
            return;
        }
        if (accessState.banActive) {
            reply.code(403).send({
                error: 'Agent is banned',
                banned_until: accessState.bannedUntil,
            });
            return;
        }

        request.claimStatus = accessState.claimStatus;
        const isAuthRoute = request.url.startsWith('/api/v1/auth/');
        if (!isAuthRoute && accessState.claimStatus !== 'claimed') {
            reply.code(403).send({
                error: 'Claim required. Complete human claim verification before using this feature.',
                claim_status: accessState.claimStatus,
                next: '/api/v1/auth/claim-status',
            });
            return;
        }

        request.agentId = payload.sub;
        request.agentName = payload.agent_name;
        request.isAdmin = accessState.isAdmin;
    } catch (err: any) {
        reply.code(401).send({ error: 'Invalid or expired token' });
    }
}
