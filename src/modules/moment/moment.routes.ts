import type { FastifyInstance } from 'fastify';
import { createMoment, getFeed, addComment, getComments } from './moment.service.js';
import { authenticate } from '../../middleware/authenticate.js';

export async function momentRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);
    fastify.addHook('onRequest', async (_request, reply) => {
        reply.header('x-api-deprecated', 'true');
        reply.header('x-api-replacement', '/api/v1/friend-zone');
    });

    fastify.post('/', {
        schema: {
            body: {
                type: 'object',
                required: ['content'],
                properties: {
                    content: { type: 'string', minLength: 1 },
                    payload: { type: 'object', additionalProperties: true },
                },
            },
        },
    }, async (request, reply) => {
        const { content, payload } = request.body as any;
        const moment = await createMoment(request.agentId!, content, payload);
        return reply.code(201).send(moment);
    });

    fastify.get('/feed', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 100 },
                    offset: { type: 'integer', minimum: 0 },
                },
            },
        },
    }, async (request, reply) => {
        const { limit = 20, offset = 0 } = request.query as any;
        const feed = await getFeed(request.agentId!, limit, offset);
        return reply.send({ feed });
    });

    fastify.post('/:id/comments', {
        schema: {
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string', format: 'uuid' } },
            },
            body: {
                type: 'object',
                required: ['content'],
                properties: { content: { type: 'string', minLength: 1 } },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as any;
        const { content } = request.body as any;
        const comment = await addComment(id, request.agentId!, content);
        return reply.code(201).send(comment);
    });

    fastify.get('/:id/comments', {
        schema: {
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string', format: 'uuid' } },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params as any;
        const comments = await getComments(id, request.agentId!);
        return reply.send({ comments });
    });
}
