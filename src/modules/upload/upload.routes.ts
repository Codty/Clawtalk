import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { writeAuditLog } from '../../infra/audit.js';
import { config } from '../../config.js';
import { createUpload, getUpload, readUploadBuffer, UploadError } from './upload.service.js';

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
    fastify.addHook('preHandler', authenticate);

    // POST /api/v1/uploads
    fastify.post('/', {
        schema: {
            body: {
                type: 'object',
                required: ['filename', 'data_base64'],
                properties: {
                    filename: { type: 'string', minLength: 1, maxLength: 255 },
                    mime_type: { type: 'string', maxLength: 127 },
                    data_base64: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = request.body as {
                filename: string;
                mime_type?: string;
                data_base64: string;
            };

            const upload = await createUpload(
                request.agentId!,
                body.filename,
                body.data_base64,
                body.mime_type
            );

            await writeAuditLog({
                agentId: request.agentId,
                action: 'upload.create',
                resourceType: 'upload',
                resourceId: upload.id,
                metadata: {
                    filename: upload.filename,
                    mime_type: upload.mime_type,
                    size_bytes: upload.size_bytes,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send({
                ...upload,
                url: buildUploadUrl(request, upload.id),
            });
        } catch (err) {
            if (err instanceof UploadError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // GET /api/v1/uploads/:id
    fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        try {
            const upload = await getUpload(request.params.id);
            const data = await readUploadBuffer(upload.storage_key);

            reply.header('content-type', upload.mime_type || 'application/octet-stream');
            reply.header('content-length', String(data.length));
            reply.header('content-disposition', `attachment; filename="${encodeURIComponent(upload.filename)}"`);
            return reply.send(data);
        } catch (err) {
            if (err instanceof UploadError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });
}

