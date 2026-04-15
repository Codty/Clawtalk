import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { writeAuditLog } from '../../infra/audit.js';
import { config } from '../../config.js';
import {
    createUpload,
    getUploadForDownload,
    getPublicAgentCardUploadForDownload,
    readUploadBuffer,
    UploadError,
    buildUploadContentDisposition,
    toUploadPublicView,
} from './upload.service.js';

function buildUploadUrl(request: any, id: string): string {
    if (config.publicBaseUrl) {
        const base = config.publicBaseUrl.replace(/\/+$/, '');
        return `${base}/api/v1/uploads/${id}`;
    }
    const proto = request.headers['x-forwarded-proto'] || request.protocol || 'http';
    const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}/api/v1/uploads/${id}`;
}

export async function uploadRoutes(fastify: FastifyInstance) {
    // POST /api/v1/uploads
    fastify.post('/', {
        preHandler: [authenticate],
        schema: {
            body: {
                type: 'object',
                required: ['filename', 'data_base64'],
                properties: {
                    filename: { type: 'string', minLength: 1, maxLength: 255 },
                    mime_type: { type: 'string', maxLength: 127 },
                    data_base64: { type: 'string', minLength: 1 },
                    storage_mode: { type: 'string', enum: ['persistent', 'relay'] },
                    relay_ttl_hours: { type: 'integer', minimum: 1, maximum: 720 },
                    max_downloads: { type: 'integer', minimum: 1, maximum: 1000 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = request.body as {
                filename: string;
                mime_type?: string;
                data_base64: string;
                storage_mode?: 'persistent' | 'relay';
                relay_ttl_hours?: number;
                max_downloads?: number;
            };

            const upload = await createUpload(
                request.agentId!,
                body.filename,
                body.data_base64,
                body.mime_type,
                {
                    storageMode: body.storage_mode,
                    relayTtlHours: body.relay_ttl_hours,
                    maxDownloads: body.max_downloads,
                }
            );
            const view = toUploadPublicView(upload);

            await writeAuditLog({
                agentId: request.agentId,
                action: 'upload.create',
                resourceType: 'upload',
                resourceId: view.id,
                metadata: {
                    filename: view.filename,
                    mime_type: view.mime_type,
                    size_bytes: view.size_bytes,
                    storage_mode: view.storage_mode,
                    expires_at: view.expires_at,
                    max_downloads: view.max_downloads,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send({
                ...view,
                url: buildUploadUrl(request, view.id),
            });
        } catch (err) {
            if (err instanceof UploadError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // GET /api/v1/uploads/:id
    fastify.get<{ Params: { id: string } }>('/:id', {
        schema: {
            params: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                },
            },
        },
    }, async (request, reply) => {
        const authHeader = request.headers.authorization;
        const hasBearerAuth = Boolean(authHeader && authHeader.startsWith('Bearer '));
        try {
            let upload: any;

            if (hasBearerAuth) {
                await authenticate(request, reply);
                if (reply.sent) return;
                upload = await getUploadForDownload(request.params.id, request.agentId!);
            } else {
                // Backward compatibility: old Agent Card links may still point to /api/v1/uploads/:id.
                // Allow anonymous read only when this upload belongs to an agent card.
                upload = await getPublicAgentCardUploadForDownload(request.params.id);
            }

            const data = await readUploadBuffer(upload.storage_key);

            reply.header('content-type', upload.mime_type || 'application/octet-stream');
            reply.header('content-length', String(data.length));
            reply.header('content-disposition', buildUploadContentDisposition(upload.filename));
            reply.header('x-upload-storage-mode', upload.storage_mode || 'persistent');
            if (upload.expires_at) {
                reply.header('x-upload-expires-at', new Date(upload.expires_at).toISOString());
            }
            return reply.send(data);
        } catch (err) {
            if (!hasBearerAuth && err instanceof UploadError && err.statusCode === 404) {
                return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
            }
            if (err instanceof UploadError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}
