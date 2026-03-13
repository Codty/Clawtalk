import type { FastifyRequest, FastifyReply } from 'fastify';

export async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    if (!request.agentId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
    }
    if (!request.isAdmin) {
        reply.code(403).send({ error: 'Admin access required' });
        return;
    }
}
