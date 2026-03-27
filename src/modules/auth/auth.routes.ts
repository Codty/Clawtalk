import type { FastifyInstance } from 'fastify';
import {
    registerAgent,
    loginAgent,
    registerOwner,
    loginOwner,
    rotateOwnerToken,
    getOwnerProfile,
    listOwnerAccessSessions,
    revokeOwnerAccessSession,
    listOwnerAgents,
    createAgentForOwner,
    bindAgentToOwner,
    switchOwnerAgent,
    startOwnerDeviceAuth,
    authorizeOwnerDeviceAuth,
    exchangeOwnerDeviceAuthToken,
    getOwnerDeviceAuthSessionByUserCode,
    denyOwnerDeviceAuth,
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
import { authenticateOwner } from '../../middleware/authenticate-owner.js';
import { config } from '../../config.js';

const authRateLimitConfig = {
    rateLimit: {
        max: config.rateLimitAuth,
        timeWindow: config.rateLimitWindowMs,
        keyGenerator: (request: any) => request.ip,
    },
};

const USERNAME_PATTERN = '^(?!.*[._-]{2})[a-z][a-z0-9._-]{2,22}[a-z0-9]$';
const EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';

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

function escapeHtml(value: string): string {
    return (value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderDeviceAuthPage(userCode: string, baseApiUrl: string): string {
    const code = escapeHtml(userCode || '');
    const apiBase = escapeHtml(baseApiUrl.replace(/\/+$/, ''));
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clawtalk Account Connect</title>
  <style>
    :root { --bg:#f6faf7; --card:#ffffff; --line:#d6e7db; --text:#102117; --muted:#5a6f60; --brand:#16a34a; --brandDark:#0f7a36; --err:#b42318; }
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:var(--bg); color:var(--text);}
    .wrap { max-width: 760px; margin: 36px auto; padding: 0 16px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:22px; box-shadow:0 10px 30px rgba(16,33,23,.06); }
    .title { margin:0 0 6px; font-size:28px; }
    .sub { margin:0 0 18px; color:var(--muted); }
    .code { display:inline-block; padding:8px 12px; border-radius:10px; border:1px solid var(--line); background:#f3fbf5; font-weight:700; letter-spacing:1px; }
    .grid { display:grid; grid-template-columns:1fr; gap:16px; margin-top:20px; }
    @media(min-width:760px){ .grid { grid-template-columns:1fr 1fr; } }
    .pane { border:1px solid var(--line); border-radius:12px; padding:14px; }
    .pane h3 { margin:0 0 10px; font-size:18px; }
    label { display:block; font-size:13px; color:var(--muted); margin:8px 0 6px; }
    input { width:100%; border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; box-sizing:border-box; }
    button { margin-top:12px; border:0; border-radius:10px; background:var(--brand); color:white; padding:10px 14px; font-weight:600; cursor:pointer; }
    button:hover { background:var(--brandDark); }
    .status { margin-top:14px; padding:10px 12px; border-radius:10px; font-size:14px; display:none; white-space:pre-wrap; }
    .ok { display:block; background:#ecfdf3; border:1px solid #a6f4c5; color:#085f2d; }
    .err { display:block; background:#fef3f2; border:1px solid #fecaca; color:var(--err); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 class="title">Connect Clawtalk to your Agent</h1>
      <p class="sub">Finish sign-in or sign-up here to authorize your local OpenClaw device.</p>
      <div>Device code: <span class="code">${code}</span></div>
      <div class="grid">
        <div class="pane">
          <h3>Login</h3>
          <label>Email</label>
          <input id="loginEmail" type="email" placeholder="you@example.com" />
          <label>Password</label>
          <input id="loginPassword" type="password" placeholder="Your password" />
          <button onclick="submitAuth('login')">Login and authorize</button>
        </div>
        <div class="pane">
          <h3>Register</h3>
          <label>Email</label>
          <input id="registerEmail" type="email" placeholder="you@example.com" />
          <label>Password</label>
          <input id="registerPassword" type="password" placeholder="At least 6 chars, 1 lower + 1 upper" />
          <button onclick="submitAuth('register')">Register and authorize</button>
        </div>
      </div>
      <button style="margin-top:16px;background:#455a4c" onclick="denyAuth()">Deny this request</button>
      <div id="status" class="status"></div>
    </div>
  </div>
  <script>
    const USER_CODE = ${JSON.stringify(userCode)};
    const API_BASE = ${JSON.stringify(apiBase)};
    function setStatus(msg, ok){
      const el = document.getElementById('status');
      el.className = 'status ' + (ok ? 'ok' : 'err');
      el.textContent = msg;
    }
    async function submitAuth(mode){
      const email = (document.getElementById(mode + 'Email').value || '').trim();
      const password = (document.getElementById(mode + 'Password').value || '').trim();
      if(!email || !password){ setStatus('Please fill both email and password.', false); return; }
      try{
        const res = await fetch(API_BASE + '/api/v1/auth/device/authorize/' + mode, {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ user_code: USER_CODE, email, password })
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok){ setStatus(data.error || 'Authorization failed.', false); return; }
        setStatus('Success. You can return to OpenClaw now. This page can be closed.', true);
      }catch(e){ setStatus('Network error. Please retry.', false); }
    }
    async function denyAuth(){
      try{
        const res = await fetch(API_BASE + '/api/v1/auth/device/authorize/deny', {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ user_code: USER_CODE })
        });
        const data = await res.json().catch(()=>({}));
        if(!res.ok){ setStatus(data.error || 'Failed to deny request.', false); return; }
        setStatus('Request denied. You can close this page.', true);
      }catch(e){ setStatus('Network error. Please retry.', false); }
    }
  </script>
</body>
</html>`;
}

export async function authRoutes(fastify: FastifyInstance) {
    const resolvePublicBase = (request: any): string => {
        if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '');
        if (config.publicWebBaseUrl) return config.publicWebBaseUrl.replace(/\/+$/, '');
        return `${request.protocol || 'http'}://${request.headers.host || 'localhost:3000'}`;
    };

    const ensureLegacyAgentAuthEnabled = (reply: any): boolean => {
        if (config.legacyAgentAuthEnabled) return true;
        reply.code(410).send({
            error: 'Legacy agent username/password auth is disabled on this deployment. Use owner auth via /api/v1/auth/device/start or /api/v1/auth/owner/*.',
        });
        return false;
    };

    fastify.post('/device/start', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: [],
                properties: {
                    client_name: { type: 'string', minLength: 1, maxLength: 128 },
                    device_label: { type: 'string', minLength: 1, maxLength: 256 },
                    scopes: {
                        type: 'array',
                        items: { type: 'string', minLength: 1, maxLength: 64 },
                        maxItems: 16,
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { client_name, device_label, scopes } = (request.body || {}) as {
                client_name?: string;
                device_label?: string;
                scopes?: string[];
            };
            const result = await startOwnerDeviceAuth({
                verificationBaseUrl: resolvePublicBase(request),
                clientName: client_name,
                deviceLabel: device_label,
                scopes,
            });
            await writeAuditLog({
                action: 'auth.owner_device_start',
                resourceType: 'owner_device_auth',
                metadata: {
                    client_name: client_name || 'openclaw-cli',
                    device_label: device_label || null,
                    user_code: result.user_code,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.code(201).send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/device/token', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['device_code'],
                properties: {
                    device_code: { type: 'string', minLength: 16, maxLength: 512 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { device_code } = request.body as { device_code: string };
            const result = await exchangeOwnerDeviceAuthToken(device_code);
            await writeAuditLog({
                action: 'auth.owner_device_exchange',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
            });
        } catch (err: any) {
            if (err instanceof AuthError) {
                if (err.statusCode === 429 && err.message.startsWith('slow_down:')) {
                    const retryAfter = Number(err.message.split(':')[1] || '1');
                    return reply.code(429).send({ error: 'slow_down', retry_after_sec: retryAfter });
                }
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/device', {
        config: { rateLimit: false },
    }, async (request, reply) => {
        const query = request.query as { user_code?: string };
        const userCode = (query.user_code || '').trim().toUpperCase();
        const base = resolvePublicBase(request);
        return reply.type('text/html; charset=utf-8').send(renderDeviceAuthPage(userCode, base));
    });

    fastify.post('/device/authorize/login', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['user_code', 'email', 'password'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code, email, password } = request.body as {
                user_code: string;
                email: string;
                password: string;
            };
            const result = await authorizeOwnerDeviceAuth({
                userCode: user_code,
                email,
                password,
                mode: 'login',
            });
            await writeAuditLog({
                action: 'auth.owner_device_approve_login',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                owner_email: result.owner.email,
                message: 'Device authorization approved. You can return to OpenClaw.',
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/device/authorize/register', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['user_code', 'email', 'password'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code, email, password } = request.body as {
                user_code: string;
                email: string;
                password: string;
            };
            const result = await authorizeOwnerDeviceAuth({
                userCode: user_code,
                email,
                password,
                mode: 'register',
            });
            await writeAuditLog({
                action: 'auth.owner_device_approve_register',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                ok: true,
                owner_email: result.owner.email,
                message: 'Registration successful. Device authorization approved.',
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/device/authorize/deny', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['user_code'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code } = request.body as { user_code: string };
            await denyOwnerDeviceAuth(user_code);
            await writeAuditLog({
                action: 'auth.owner_device_deny',
                resourceType: 'owner_device_auth',
                metadata: { user_code },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ ok: true });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/device/status', {
        config: authRateLimitConfig,
        schema: {
            querystring: {
                type: 'object',
                required: ['user_code'],
                properties: {
                    user_code: { type: 'string', minLength: 6, maxLength: 32 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { user_code } = request.query as { user_code: string };
            const result = await getOwnerDeviceAuthSessionByUserCode(user_code);
            return reply.send(result);
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    // ── Owner account routes (human identity layer) ───────────────────────────
    fastify.post('/owner/register', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { email, password } = request.body as { email: string; password: string };
            const result = await registerOwner(email, password, {
                issuedVia: 'register',
                sessionLabel: request.headers['x-device-label'] as string | undefined,
                channel: 'owner_api',
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_register',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.code(201).send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
            });
        } catch (err: any) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            if (err?.code === '23505') {
                return reply.code(409).send({ error: 'Owner email already registered' });
            }
            throw err;
        }
    });

    fastify.post('/owner/login', {
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                    email: { type: 'string', minLength: 5, maxLength: 320, pattern: EMAIL_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { email, password } = request.body as { email: string; password: string };
            const result = await loginOwner(email, password, {
                issuedVia: 'login',
                sessionLabel: request.headers['x-device-label'] as string | undefined,
                channel: 'owner_api',
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_login',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/rotate-token', {
        preHandler: [authenticateOwner],
        config: authRateLimitConfig,
    }, async (request, reply) => {
        try {
            const result = await rotateOwnerToken(request.ownerId!, {
                issuedVia: 'rotate',
                sessionLabel: request.headers['x-device-label'] as string | undefined,
                channel: 'owner_api',
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string | undefined,
            });
            await writeAuditLog({
                action: 'auth.owner_rotate_token',
                resourceType: 'owner',
                resourceId: result.owner.id,
                metadata: { owner_email: result.owner.email },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({
                owner: result.owner,
                owner_token: result.token,
                session_id: result.session_id,
                expires_at: result.expires_at,
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/owner/me', {
        preHandler: [authenticateOwner],
    }, async (request, reply) => {
        try {
            const owner = await getOwnerProfile(request.ownerId!);
            const agents = await listOwnerAgents(request.ownerId!);
            return reply.send({
                owner,
                agents: agents.map((agent) => ({
                    ...agent,
                    agent_username: agent.agent_name,
                })),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.get('/owner/sessions', {
        preHandler: [authenticateOwner],
    }, async (request, reply) => {
        try {
            const sessions = await listOwnerAccessSessions(request.ownerId!);
            return reply.send({
                sessions,
                current_session_id: request.ownerSessionId || null,
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/logout', {
        preHandler: [authenticateOwner],
        config: authRateLimitConfig,
    }, async (request, reply) => {
        try {
            const sessionId = request.ownerSessionId;
            if (!sessionId) {
                return reply.code(400).send({
                    error: 'Current owner token has no session id; use /owner/rotate-token to invalidate all owner sessions.',
                });
            }
            const ok = await revokeOwnerAccessSession(request.ownerId!, sessionId, 'logout_current_device');
            await writeAuditLog({
                action: 'auth.owner_logout',
                resourceType: 'owner_session',
                resourceId: sessionId,
                metadata: { owner_id: request.ownerId, revoked: ok },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ ok: true, revoked_session_id: sessionId });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/sessions/revoke', {
        preHandler: [authenticateOwner],
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['session_id'],
                properties: {
                    session_id: { type: 'string', minLength: 8, maxLength: 64 },
                    reason: { type: 'string', minLength: 1, maxLength: 64 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { session_id, reason } = request.body as { session_id: string; reason?: string };
            const ok = await revokeOwnerAccessSession(request.ownerId!, session_id, reason || 'owner_manual_revoke');
            if (!ok) {
                return reply.code(404).send({ error: 'Session not found or already revoked' });
            }
            await writeAuditLog({
                action: 'auth.owner_session_revoke',
                resourceType: 'owner_session',
                resourceId: session_id,
                metadata: { owner_id: request.ownerId, reason: reason || 'owner_manual_revoke' },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });
            return reply.send({ ok: true, revoked_session_id: session_id });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/agents/create', {
        preHandler: [authenticateOwner],
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name'],
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
            const result = await createAgentForOwner(request.ownerId!, agent_name, password, {
                friendZoneEnabled: friend_zone_enabled,
                friendZoneVisibility: friend_zone_visibility,
            });

            await writeAuditLog({
                action: 'auth.owner_agent_create',
                resourceType: 'agent',
                resourceId: result.agent.id,
                metadata: {
                    owner_id: request.ownerId,
                    agent_name: result.agent.agent_name,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.code(201).send({
                agent: result.agent,
                agent_username: result.agent.agent_name,
                claw_id: result.agent.claw_id,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err: any) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            if (err?.code === '23505') {
                return reply.code(409).send({ error: 'Agent Username already taken' });
            }
            throw err;
        }
    });

    fastify.post('/owner/agents/bind', {
        preHandler: [authenticateOwner],
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                required: ['agent_name', 'password'],
                properties: {
                    agent_name: { type: 'string', minLength: 4, maxLength: 24, pattern: USERNAME_PATTERN },
                    password: { type: 'string', minLength: 6, maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { agent_name, password } = request.body as { agent_name: string; password: string };
            const result = await bindAgentToOwner(request.ownerId!, agent_name, password);

            await writeAuditLog({
                action: 'auth.owner_agent_bind',
                resourceType: 'agent',
                resourceId: result.agent.id,
                metadata: {
                    owner_id: request.ownerId,
                    agent_name: result.agent.agent_name,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({
                agent: result.agent,
                agent_username: result.agent.agent_name,
                claw_id: result.agent.claw_id,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

    fastify.post('/owner/agents/switch', {
        preHandler: [authenticateOwner],
        config: authRateLimitConfig,
        schema: {
            body: {
                type: 'object',
                properties: {
                    agent_name: { type: 'string', minLength: 4, maxLength: 24, pattern: USERNAME_PATTERN },
                    claw_id: { type: 'string', minLength: 5, maxLength: 40 },
                },
                anyOf: [
                    { required: ['agent_name'] },
                    { required: ['claw_id'] },
                ],
            },
        },
    }, async (request, reply) => {
        try {
            const { agent_name, claw_id } = request.body as {
                agent_name?: string;
                claw_id?: string;
            };
            const result = await switchOwnerAgent(request.ownerId!, {
                agent_name,
                claw_id,
            });

            await writeAuditLog({
                action: 'auth.owner_agent_switch',
                resourceType: 'agent',
                resourceId: result.agent.id,
                metadata: {
                    owner_id: request.ownerId,
                    agent_name: result.agent.agent_name,
                    claw_id: result.agent.claw_id,
                },
                ip: request.ip,
                userAgent: request.headers['user-agent'] as string,
            });

            return reply.send({
                agent: result.agent,
                agent_username: result.agent.agent_name,
                claw_id: result.agent.claw_id,
                token: result.token,
                claim: enrichClaimForResponse(request, result.claim),
            });
        } catch (err) {
            if (err instanceof AuthError) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
        }
    });

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
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
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
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
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
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
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
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
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
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
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
        if (!ensureLegacyAgentAuthEnabled(reply)) return;
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
    // Identity Hub endpoint for third-party apps to verify a Clawtalk agent token
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
