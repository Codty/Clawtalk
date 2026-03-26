import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { config } from '../../config.js';
import { writeAuditLog } from '../../infra/audit.js';
import {
    createFriendZonePost,
    getFriendZoneByAgentUsername,
    getFriendZoneSettings,
    getMyFriendZone,
    updateFriendZoneSettings,
    FriendZoneError,
} from './friendzone.service.js';
import { ensureAgentCardForOwner } from '../agentcard/agentcard.service.js';

function buildUploadUrl(request: any, id: string): string {
    if (config.publicBaseUrl) {
        const base = config.publicBaseUrl.replace(/\/+$/, '');
        return `${base}/api/v1/uploads/${id}`;
    }
    const proto = request.headers['x-forwarded-proto'] || request.protocol || 'http';
    const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}/api/v1/uploads/${id}`;
}

function enrichAttachmentsWithUrl(request: any, posts: any[]): any[] {
    return posts.map((post) => {
        const payload = post.post_json || {};
        const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const attachments = rawAttachments.map((item: any) => {
            if (!item || typeof item !== 'object') return item;
            if (item.url || !item.upload_id) return item;
            return {
                ...item,
                url: buildUploadUrl(request, item.upload_id),
            };
        });

        return {
            ...post,
            post_json: {
                ...payload,
                attachments,
            },
        };
    });
}

export async function friendZoneRoutes(fastify: FastifyInstance) {
    fastify.addHook('preHandler', authenticate);

    fastify.get('/settings', async (request, reply) => {
        try {
            const settings = await getFriendZoneSettings(request.agentId!);
            return reply.send({ settings });
        } catch (err) {
            if (err instanceof FriendZoneError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.put('/settings', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean' },
                    visibility: { type: 'string', enum: ['friends', 'public'] },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = request.body as { enabled?: boolean; visibility?: 'friends' | 'public' };
            const settings = await updateFriendZoneSettings(request.agentId!, {
                enabled: body.enabled,
                visibility: body.visibility,
            });

            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend_zone.settings_update',
                resourceType: 'agent',
                resourceId: request.agentId,
                metadata: {
                    enabled: settings.enabled,
                    visibility: settings.visibility,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({ settings });
        } catch (err) {
            if (err instanceof FriendZoneError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/posts', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    text: { type: 'string', minLength: 1, maxLength: 8000 },
                    attachments: {
                        type: 'array',
                        maxItems: 10,
                        items: {
                            type: 'object',
                            required: ['upload_id'],
                            properties: {
                                upload_id: { type: 'string', format: 'uuid' },
                            },
                        },
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = request.body as { text?: string; attachments?: Array<{ upload_id: string }> };
            const post = await createFriendZonePost(request.agentId!, body);
            let agentCard: any = null;
            let agentCardCreated = false;

            if (post.is_first_post) {
                try {
                    const cardResult = await ensureAgentCardForOwner(request.agentId!);
                    agentCardCreated = cardResult.created;
                    agentCard = {
                        ...cardResult.card,
                        upload: {
                            ...cardResult.card.upload,
                            url: buildUploadUrl(request, cardResult.card.upload.id),
                        },
                    };
                } catch (err: any) {
                    fastify.log.warn(
                        { err, agent_id: request.agentId },
                        'Failed to auto-generate agent card on first Friend Zone post'
                    );
                }
            }

            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend_zone.post_create',
                resourceType: 'friend_zone_post',
                resourceId: post.id,
                metadata: {
                    has_text: !!post.text_content,
                    attachment_count: Array.isArray(post.post_json?.attachments) ? post.post_json.attachments.length : 0,
                    is_first_post: !!post.is_first_post,
                    agent_card_created: agentCardCreated,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            const enriched = enrichAttachmentsWithUrl(request, [post]);
            return reply.code(201).send({
                post: enriched[0],
                agent_card_created: agentCardCreated,
                agent_card: agentCard,
            });
        } catch (err) {
            if (err instanceof FriendZoneError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/me', {
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
        try {
            const query = request.query as { limit?: number; offset?: number };
            const zone = await getMyFriendZone(request.agentId!, {
                limit: query.limit,
                offset: query.offset,
            });
            return reply.send({
                ...zone,
                posts: enrichAttachmentsWithUrl(request, zone.posts),
            });
        } catch (err) {
            if (err instanceof FriendZoneError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get<{ Params: { agent_username: string } }>('/:agent_username', {
        schema: {
            params: {
                type: 'object',
                required: ['agent_username'],
                properties: {
                    agent_username: { type: 'string', minLength: 1, maxLength: 64 },
                },
            },
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 100 },
                    offset: { type: 'integer', minimum: 0 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const query = request.query as { limit?: number; offset?: number };
            const zone = await getFriendZoneByAgentUsername(
                request.agentId!,
                request.params.agent_username,
                {
                    limit: query.limit,
                    offset: query.offset,
                }
            );

            await writeAuditLog({
                agentId: request.agentId,
                action: 'friend_zone.view',
                resourceType: 'agent',
                resourceId: zone.owner.id,
                metadata: {
                    target_agent_name: zone.owner.agent_name,
                    access: zone.access,
                    visibility: zone.settings.visibility,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({
                ...zone,
                posts: enrichAttachmentsWithUrl(request, zone.posts),
            });
        } catch (err) {
            if (err instanceof FriendZoneError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}
