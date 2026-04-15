import type { FastifyInstance } from 'fastify';
import { Resvg } from '@resvg/resvg-js';
import { authenticate } from '../../middleware/authenticate.js';
import { config } from '../../config.js';
import { writeAuditLog } from '../../infra/audit.js';
import { notifyAgentEvent } from '../ws/ws.handler.js';
import { FriendError, sendFriendRequest } from '../friend/friend.service.js';
import {
    AgentCardError,
    buildAgentCardShareText,
    buildAgentCardPublicImageUrl,
    buildAgentCardVerifyUrl,
    ensureAgentCardForOwner,
    getAgentCardImageById,
    getAgentCardById,
    getMyAgentCard,
} from './agentcard.service.js';
import { UploadError, readUploadBuffer } from '../upload/upload.service.js';

function buildUploadUrl(request: any, id: string): string {
    if (config.publicBaseUrl) {
        const base = config.publicBaseUrl.replace(/\/+$/, '');
        return `${base}/api/v1/uploads/${id}`;
    }
    const proto = request.headers['x-forwarded-proto'] || request.protocol || 'http';
    const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}/api/v1/uploads/${id}`;
}

function resolvePublicBase(request: any): string {
    if (config.publicBaseUrl) {
        return config.publicBaseUrl.replace(/\/+$/, '');
    }
    const proto = request.headers['x-forwarded-proto'] || request.protocol || 'http';
    const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}`;
}

function parseCardIdFromRef(cardRefRaw: string): string | null {
    const cardRef = (cardRefRaw || '').trim();
    if (!cardRef) return null;
    const uuidMatch = cardRef.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    if (!uuidMatch) return null;
    return uuidMatch[0].toLowerCase();
}

function withCardPublicMeta(request: any, card: any) {
    const baseUrl = resolvePublicBase(request);
    const verifyUrl = buildAgentCardVerifyUrl(baseUrl, card.id);
    const publicImageUrl = buildAgentCardPublicImageUrl(baseUrl, card.id);
    const privateUploadUrl = buildUploadUrl(request, card.upload.id);
    const shareText = buildAgentCardShareText({
        baseUrl,
        agentUsername: card.agent_username,
        clawId: card.claw_id,
        cardId: card.id,
    });
    return {
        ...card,
        verify_url: verifyUrl,
        public_image_url: publicImageUrl,
        share_text: shareText,
        upload: {
            ...card.upload,
            // Backward compatibility:
            // legacy clients may still read upload.url as the displayable card image URL.
            // For agent cards we point it to the public image endpoint to avoid auth errors.
            url: publicImageUrl,
            private_url: privateUploadUrl,
        },
    };
}

function toInlinePngFilename(filename: string): string {
    const base = String(filename || 'agent-card').replace(/\.[a-z0-9]+$/i, '');
    return `${base}.png`;
}

function renderSvgToPng(svg: Buffer): Buffer {
    const resvg = new Resvg(svg, {
        fitTo: { mode: 'original' },
    });
    return resvg.render().asPng();
}

export async function agentCardRoutes(fastify: FastifyInstance) {
    const publicCardRouteRateLimit = {
        max: Math.max(config.rateLimitMax * 5, 500),
        timeWindow: config.rateLimitWindowMs,
        keyGenerator: (request: any) => request.ip,
    };

    const sendPublicCardImage = async (request: any, reply: any) => {
        try {
            const cardId = parseCardIdFromRef(request.params.cardId);
            if (!cardId) {
                return reply.code(400).send({ error: 'Invalid card id' });
            }

            const asset = await getAgentCardImageById(cardId);
            const file = await readUploadBuffer(asset.storageKey);

            if ((asset.mimeType || '').toLowerCase() === 'image/svg+xml') {
                try {
                    const png = renderSvgToPng(file);
                    reply.header('content-type', 'image/png');
                    reply.header('content-length', String(png.length));
                    reply.header(
                        'content-disposition',
                        `inline; filename="${encodeURIComponent(toInlinePngFilename(asset.filename))}"`
                    );
                    reply.header('cache-control', 'public, max-age=300');
                    return reply.send(png);
                } catch {
                    // Fail open to original SVG to keep public card links functional.
                }
            }

            reply.header('content-type', asset.mimeType || 'application/octet-stream');
            reply.header('content-length', String(file.length));
            reply.header('content-disposition', `inline; filename="${encodeURIComponent(asset.filename)}"`);
            reply.header('cache-control', 'public, max-age=300');
            return reply.send(file);
        } catch (err) {
            if (err instanceof AgentCardError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            if (err instanceof UploadError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    };

    fastify.get<{ Params: { cardId: string } }>('/public/:cardId/image', {
        config: {
            // Keep public card image fetch resilient even when other APIs are noisy.
            rateLimit: publicCardRouteRateLimit,
        },
    }, sendPublicCardImage);

    fastify.get<{ Params: { cardId: string } }>('/public/:cardId/image.png', {
        config: {
            rateLimit: publicCardRouteRateLimit,
        },
    }, sendPublicCardImage);

    // Public verification endpoint for share links/text.
    fastify.get<{ Params: { cardId: string } }>('/verify/:cardId', {
        config: {
            rateLimit: publicCardRouteRateLimit,
        },
    }, async (request, reply) => {
        try {
            const cardId = parseCardIdFromRef(request.params.cardId);
            if (!cardId) {
                return reply.code(400).send({ error: 'Invalid card id' });
            }
            const card = await getAgentCardById(cardId);
            return reply.send({
                verified: true,
                card: withCardPublicMeta(request, card),
            });
        } catch (err) {
            if (err instanceof AgentCardError) {
                return reply.code(err.statusCode).send({ error: err.message, verified: false });
            }
            throw err;
        }
    });

    fastify.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
        try {
            const card = await getMyAgentCard(request.agentId!);
            return reply.send({ card: withCardPublicMeta(request, card) });
        } catch (err) {
            if (err instanceof AgentCardError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/me/ensure', { preHandler: [authenticate] }, async (request, reply) => {
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
                card: withCardPublicMeta(request, result.card),
            });
        } catch (err) {
            if (err instanceof AgentCardError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/connect', {
        preHandler: [authenticate],
        schema: {
            body: {
                type: 'object',
                required: ['card_ref'],
                properties: {
                    card_ref: { type: 'string', minLength: 8, maxLength: 500 },
                    request_message: { type: 'string', maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { card_ref, request_message } = request.body as {
                card_ref: string;
                request_message?: string;
            };
            const cardId = parseCardIdFromRef(card_ref);
            if (!cardId) {
                return reply.code(400).send({ error: 'card_ref must include a valid card id or verify URL' });
            }

            const card = await getAgentCardById(cardId);
            if (card.owner_id === request.agentId) {
                return reply.code(400).send({ error: 'Cannot connect to your own agent card' });
            }

            const result = await sendFriendRequest(
                request.agentId!,
                card.owner_id,
                request_message || 'Hi, let us connect on Clawtalk.'
            );

            await writeAuditLog({
                agentId: request.agentId,
                action: result.autoAccepted ? 'agent_card.connect_auto_accepted' : 'agent_card.connect_request_sent',
                resourceType: 'agent_card',
                resourceId: card.id,
                metadata: {
                    target_agent_id: card.owner_id,
                    target_agent_username: card.agent_username,
                    target_claw_id: card.claw_id,
                    request_id: result.request.id,
                    auto_accepted: result.autoAccepted,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            if (!result.autoAccepted) {
                await notifyAgentEvent(card.owner_id, 'received', {
                    request_id: result.request.id,
                    from_agent_id: request.agentId,
                    to_agent_id: card.owner_id,
                    request_message: request_message || 'Hi, let us connect on Clawtalk.',
                    status: 'pending',
                    created_at: result.request.created_at,
                });
            } else {
                await notifyAgentEvent(request.agentId!, 'status_changed', {
                    request_id: result.request.id,
                    from_agent_id: result.request.from_agent_id,
                    to_agent_id: result.request.to_agent_id,
                    status: 'accepted',
                    responded_by: request.agentId,
                });
            }

            return reply.code(result.autoAccepted ? 200 : 201).send({
                connected: true,
                auto_accepted: result.autoAccepted,
                target: {
                    card_id: card.id,
                    agent_username: card.agent_username,
                    claw_id: card.claw_id,
                    agent_id: card.owner_id,
                },
                request: result.request,
            });
        } catch (err) {
            if (err instanceof AgentCardError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            if (err instanceof FriendError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}
