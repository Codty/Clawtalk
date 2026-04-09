import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { conversationRoutes } from './modules/conversation/conversation.routes.js';
import { messageRoutes } from './modules/message/message.routes.js';
import { agentRoutes } from './modules/agent/agent.routes.js';
import { friendRoutes } from './modules/friend/friend.routes.js';
import { momentRoutes } from './modules/moment/moment.routes.js';
import { friendZoneRoutes } from './modules/friendzone/friendzone.routes.js';
import { productRoutes } from './modules/product/product.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { uploadRoutes } from './modules/upload/upload.routes.js';
import { agentCardRoutes } from './modules/agentcard/agentcard.routes.js';
import { registerWsRoutes } from './modules/ws/ws.handler.js';
import { getFanoutStats } from './modules/ws/ws.fanout.js';
import { getWsStats } from './modules/ws/ws.handler.js';
import { redis } from './infra/redis.js';
import { pool } from './db/pool.js';
import { CLAWTALK_PUBLIC_SKILL_MD } from './public/skill-md.js';
import { tryVerifyToken } from './modules/auth/auth.service.js';

export const APP_VERSION = '2.0.0';

export async function buildApp() {
    const isDev = process.env.NODE_ENV !== 'production';
    const corsAllowlist = new Set(config.corsAllowedOrigins);

    const app = Fastify({
        logger: isDev
            ? {
                level: 'info',
                transport: {
                    target: 'pino-pretty',
                    options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
                },
            }
            : { level: 'info' },
        genReqId: () => randomUUID(),
    });

    await app.register(cors, {
        origin(origin, callback) {
            if (config.corsAllowAll || !origin) {
                callback(null, true);
                return;
            }
            if (corsAllowlist.has(origin)) {
                callback(null, true);
                return;
            }
            callback(new Error('Origin not allowed by CORS policy'), false);
        },
    });

    await app.register(rateLimit, {
        max: config.rateLimitMax,
        timeWindow: config.rateLimitWindowMs,
        redis,
        keyGenerator: async (request) => {
            const authHeader = request.headers.authorization;
            if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
                const payload = tryVerifyToken(authHeader.slice(7));
                if (payload?.sub) {
                    return `${payload.token_type || 'access'}:${payload.sub}`;
                }
            }
            return request.ip;
        },
    });

    await app.register(fastifyWebsocket);

    // Request ID propagation
    app.addHook('onRequest', async (request, reply) => {
        reply.header('x-request-id', request.id);
    });

    // ── Health endpoints ──
    app.get('/healthz', { config: { rateLimit: false } }, async () => ({
        status: 'ok',
        version: APP_VERSION,
        timestamp: new Date().toISOString(),
    }));

    app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
        const checks: Record<string, string> = {};
        let healthy = true;

        try { await pool.query('SELECT 1'); checks.postgres = 'ok'; }
        catch { checks.postgres = 'error'; healthy = false; }

        try { await redis.ping(); checks.redis = 'ok'; }
        catch { checks.redis = 'error'; healthy = false; }

        return reply.code(healthy ? 200 : 503).send({
            status: healthy ? 'ready' : 'not_ready',
            version: APP_VERSION,
            checks,
            timestamp: new Date().toISOString(),
        });
    });

    app.get('/health', { config: { rateLimit: false } }, async () => ({
        status: 'ok', version: APP_VERSION, timestamp: new Date().toISOString(),
    }));

    app.get('/skill.md', { config: { rateLimit: false } }, async (_request, reply) => {
        return reply
            .type('text/markdown; charset=utf-8')
            .send(CLAWTALK_PUBLIC_SKILL_MD);
    });

    app.get('/metrics', { config: { rateLimit: false } }, async (request, reply) => {
        if (config.metricsAuthToken) {
            const token = request.headers['x-metrics-token'];
            if (token !== config.metricsAuthToken) {
                return reply.code(401).send({ error: 'Unauthorized metrics access' });
            }
        }
        return {
            version: APP_VERSION,
            uptime_sec: Math.floor(process.uptime()),
            memory: process.memoryUsage(),
            websocket: getWsStats(),
            fanout: getFanoutStats(),
            timestamp: new Date().toISOString(),
        };
    });

    // ── API routes ──
    await app.register(authRoutes, { prefix: '/api/v1/auth' });
    await app.register(productRoutes, { prefix: '/api/v1/product' });
    await app.register(conversationRoutes, { prefix: '/api/v1/conversations' });
    await app.register(messageRoutes, { prefix: '/api/v1/conversations' });
    await app.register(agentRoutes, { prefix: '/api/v1/agents' });
    await app.register(friendRoutes, { prefix: '/api/v1/friends' });
    await app.register(momentRoutes, { prefix: '/api/v1/moments' });
    await app.register(friendZoneRoutes, { prefix: '/api/v1/friend-zone' });
    await app.register(uploadRoutes, { prefix: '/api/v1/uploads' });
    await app.register(agentCardRoutes, { prefix: '/api/v1/agent-card' });
    await app.register(adminRoutes, { prefix: '/api/v1/admin' });

    // WebSocket
    await app.register(registerWsRoutes);

    // Error handler
    app.setErrorHandler((error: any, request, reply) => {
        if (error.statusCode === 429) {
            return reply.code(429).send({
                error: 'Too many requests. Please slow down.',
                request_id: request.id,
            });
        }
        app.log.error({ err: error, request_id: request.id }, error.message);
        return reply.code(error.statusCode || 500).send({
            error: error.message || 'Internal Server Error',
            request_id: request.id,
        });
    });

    return app;
}
