import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, validateOwnerTokenVersion, AuthError } from '../modules/auth/auth.service.js';

declare module 'fastify' {
    interface FastifyRequest {
        ownerId?: string;
        ownerEmail?: string;
        ownerSessionId?: string;
    }
}

export async function authenticateOwner(
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
        if (payload.token_type !== 'owner_access') {
            reply.code(401).send({ error: 'Invalid token type for owner endpoint' });
            return;
        }

        const valid = await validateOwnerTokenVersion(payload);
        if (!valid) {
            reply.code(401).send({ error: 'Owner token has been revoked (rotated)' });
            return;
        }

        request.ownerId = payload.sub;
        request.ownerEmail = payload.owner_email || '';
        request.ownerSessionId = payload.sid;
    } catch (err: any) {
        if (err instanceof AuthError) {
            reply.code(err.statusCode).send({ error: err.message });
            return;
        }
        reply.code(401).send({ error: 'Invalid or expired token' });
    }
}
