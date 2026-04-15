import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let agentAToken: string;
let agentBToken: string;
let agentAId: string;
let agentBId: string;
let agentCToken: string;
let agentDToken: string;
let agentCId: string;
let agentDId: string;

beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('Refusing to run integration tests outside NODE_ENV=test');
    }

    // Avoid flaky auth rate-limit tests across repeated local runs.
    const { redis } = await import('../src/infra/redis.js');
    await redis.flushdb();

    app = await buildApp();
    const { pool } = await import('../src/db/pool.js');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;');
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
});

afterAll(async () => {
    await app.close();
});

describe('Public Skill Endpoint', () => {
    it('should serve /skill.md for one-message onboarding', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/skill.md',
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/markdown');
        expect(res.body).toContain('name: clawtalk');
        expect(res.body).toContain('help me join Clawtalk');
    });
});

// ═══════════════════════════════════════
// Auth
// ═══════════════════════════════════════
describe('Auth', () => {
    let wsTokenForA: string;
    let ownerToken: string;
    let ownerId: string;
    let ownerManagedAgentId: string;
    let ownerManagedAgentClawId: string;
    let ownerSessionId: string;
    it('should reject invalid username/password format on register', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'BadName', password: 'abcdef' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('should register agent_a', async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/auth/register',
            payload: { agent_name: 'test_agent_a', password: 'Password123' },
        });
        expect(res.statusCode).toBe(201);
        agentAToken = res.json().token;
        agentAId = res.json().agent.id;

        const claimCode = res.json().claim?.verification_code;
        const claim = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/claim/complete',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { verification_code: claimCode },
        });
        expect(claim.statusCode).toBe(200);
    });

    it('should register agent_b', async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/auth/register',
            payload: { agent_name: 'test_agent_b', password: 'Password456' },
        });
        expect(res.statusCode).toBe(201);
        agentBToken = res.json().token;
        agentBId = res.json().agent.id;

        const claimCode = res.json().claim?.verification_code;
        const claim = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/claim/complete',
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { verification_code: claimCode },
        });
        expect(claim.statusCode).toBe(200);
    });

    it('should register owner account with email/password', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/register',
            payload: { email: 'owner1@example.com', password: 'OwnerPassA', display_name: 'Codty Owner' },
        });
        expect(res.statusCode).toBe(201);
        ownerToken = res.json().owner_token;
        ownerId = res.json().owner.id;
        expect(res.json().owner.email).toBe('owner1@example.com');
        expect(res.json().owner.display_name).toBe('Codty Owner');
        expect(typeof res.json().session_id).toBe('string');
        expect(typeof res.json().expires_at).toBe('string');
        expect(res.json().email_verification).toBeDefined();
        expect(typeof res.json().email_verification.delivery_message).toBe('string');
        expect(typeof res.json().email_verification.debug_token).toBe('string');
    });

    it('should verify owner email via confirmation token', async () => {
        const register = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/register',
            payload: { email: 'owner-verify@example.com', password: 'OwnerPassV' },
        });
        expect(register.statusCode).toBe(201);
        const verifyToken = register.json().email_verification?.debug_token as string;
        expect(typeof verifyToken).toBe('string');
        expect(verifyToken.length).toBeGreaterThan(16);

        const verify = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/verify-email/confirm',
            payload: { token: verifyToken },
        });
        expect(verify.statusCode).toBe(200);
        expect(verify.json().ok).toBe(true);
        expect(verify.json().owner.email).toBe('owner-verify@example.com');
        expect(typeof verify.json().owner.email_verified_at).toBe('string');
    });

    it('should login owner account and rotate owner token', async () => {
        const login = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/login',
            payload: { email: 'owner1@example.com', password: 'OwnerPassA' },
        });
        expect(login.statusCode).toBe(200);
        ownerToken = login.json().owner_token;
        ownerSessionId = login.json().session_id;
        expect(typeof ownerSessionId).toBe('string');
        expect(typeof login.json().expires_at).toBe('string');

        const rotated = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/rotate-token',
            headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(rotated.statusCode).toBe(200);
        ownerToken = rotated.json().owner_token;
        ownerSessionId = rotated.json().session_id;
        expect(rotated.json().owner.id).toBe(ownerId);
        expect(typeof ownerSessionId).toBe('string');
        expect(typeof rotated.json().expires_at).toBe('string');
    });

    it('should update owner display name', async () => {
        const updated = await app.inject({
            method: 'PATCH',
            url: '/api/v1/auth/owner/me',
            headers: { authorization: `Bearer ${ownerToken}` },
            payload: { display_name: 'Codty Team' },
        });
        expect(updated.statusCode).toBe(200);
        expect(updated.json().owner.display_name).toBe('Codty Team');

        const me = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/owner/me',
            headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(me.statusCode).toBe(200);
        expect(me.json().owner.display_name).toBe('Codty Team');
    });

    it('should support owner password forgot/reset flow', async () => {
        const register = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/register',
            payload: { email: 'owner-reset@example.com', password: 'OwnerPassR' },
        });
        expect(register.statusCode).toBe(201);

        const forgot = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/password/forgot',
            payload: { email: 'owner-reset@example.com' },
        });
        expect(forgot.statusCode).toBe(200);
        expect(forgot.json().ok).toBe(true);
        const resetUrl = forgot.json().reset_url as string;
        expect(typeof resetUrl).toBe('string');
        expect(resetUrl).toContain('/api/v1/auth/owner/password/reset?token=');
        const resetToken = forgot.json().debug_token as string;
        expect(typeof resetToken).toBe('string');
        expect(resetToken.length).toBeGreaterThan(16);

        const resetPageUrl = new URL(resetUrl);
        const resetPage = await app.inject({
            method: 'GET',
            url: `${resetPageUrl.pathname}${resetPageUrl.search}`,
        });
        expect(resetPage.statusCode).toBe(200);
        expect(resetPage.headers['content-type']).toContain('text/html');
        expect(resetPage.body).toContain('Reset password');

        const reset = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/password/reset',
            payload: { token: resetToken, password: 'OwnerPassR2' },
        });
        expect(reset.statusCode).toBe(200);
        expect(reset.json().ok).toBe(true);

        const oldLogin = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/login',
            payload: { email: 'owner-reset@example.com', password: 'OwnerPassR' },
        });
        expect(oldLogin.statusCode).toBe(401);

        const newLogin = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/login',
            payload: { email: 'owner-reset@example.com', password: 'OwnerPassR2' },
        });
        expect(newLogin.statusCode).toBe(200);
        expect(newLogin.json().owner.email).toBe('owner-reset@example.com');
    });

    it('should expose Clerk exchange endpoint and return disabled when not configured', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/clerk/exchange',
            payload: { clerk_token: 'mock-clerk-token' },
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toContain('Clerk auth is disabled');
    });

    it('should create owner-managed agent account', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/agents/create',
            headers: { authorization: `Bearer ${ownerToken}` },
            payload: { agent_name: 'owner_agent_01' },
        });
        expect(res.statusCode).toBe(201);
        ownerManagedAgentId = res.json().agent.id;
        ownerManagedAgentClawId = res.json().agent.claw_id;
        expect(res.json().agent.agent_name).toBe('owner_agent_01');
        expect(res.json().claim.claim_status).toBe('claimed');
    });

    it('should not let device-start onboarding traffic exhaust owner action routes', async () => {
        for (let i = 0; i < 10; i++) {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/auth/device/start',
                payload: { client_name: `demo-${i}`, device_label: `demo-device-${i}` },
            });
            expect(res.statusCode).toBe(201);
        }

        const switchRes = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/agents/switch',
            headers: { authorization: `Bearer ${ownerToken}` },
            payload: { agent_name: 'owner_agent_01' },
        });
        expect(switchRes.statusCode).toBe(200);
        expect(switchRes.json().agent.id).toBe(ownerManagedAgentId);
    });

    it('should bind existing agent account to owner and list owner agents', async () => {
        const standalone = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'bind_target_01', password: 'PasswordCd' },
        });
        expect(standalone.statusCode).toBe(201);
        const standaloneAgentId = standalone.json().agent.id as string;

        const bind = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/agents/bind',
            headers: { authorization: `Bearer ${ownerToken}` },
            payload: { agent_name: 'bind_target_01', password: 'PasswordCd' },
        });
        expect(bind.statusCode).toBe(200);
        expect(bind.json().agent.id).toBe(standaloneAgentId);
        expect(bind.json().claim.claim_status).toBe('claimed');

        const me = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/owner/me',
            headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(me.statusCode).toBe(200);
        const agentIds = me.json().agents.map((a: any) => a.id);
        expect(agentIds).toContain(standaloneAgentId);
        expect(agentIds).toContain(ownerManagedAgentId);
    });

    it('should switch active owner agent by username and claw_id', async () => {
        const byName = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/agents/switch',
            headers: { authorization: `Bearer ${ownerToken}` },
            payload: { agent_name: 'owner_agent_01' },
        });
        expect(byName.statusCode).toBe(200);
        expect(byName.json().agent.id).toBe(ownerManagedAgentId);
        expect(byName.json().agent.claw_id).toBe(ownerManagedAgentClawId);
        expect(typeof byName.json().token).toBe('string');

        const byClawId = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/agents/switch',
            headers: { authorization: `Bearer ${ownerToken}` },
            payload: { claw_id: ownerManagedAgentClawId },
        });
        expect(byClawId.statusCode).toBe(200);
        expect(byClawId.json().agent.id).toBe(ownerManagedAgentId);
    });

    it('should enforce max 5 agents per owner', async () => {
        const extraNames = ['owner_agent_02', 'owner_agent_03', 'owner_agent_04'];
        for (const name of extraNames) {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/auth/owner/agents/create',
                headers: { authorization: `Bearer ${ownerToken}` },
                payload: { agent_name: name },
            });
            expect(res.statusCode).toBe(201);
        }

        const overflow = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/agents/create',
            headers: { authorization: `Bearer ${ownerToken}` },
            payload: { agent_name: 'owner_agent_06' },
        });
        expect(overflow.statusCode).toBe(409);
        expect(overflow.json().error).toContain('up to 5 agents');
    });

    it('should list owner sessions, revoke another session, and keep current session active', async () => {
        const secondLogin = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/login',
            payload: { email: 'owner1@example.com', password: 'OwnerPassA' },
        });
        expect(secondLogin.statusCode).toBe(200);
        const secondToken = secondLogin.json().owner_token as string;
        const secondSessionId = secondLogin.json().session_id as string;
        expect(typeof secondSessionId).toBe('string');

        const sessions = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/owner/sessions',
            headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(sessions.statusCode).toBe(200);
        expect(Array.isArray(sessions.json().sessions)).toBe(true);
        expect(sessions.json().current_session_id).toBe(ownerSessionId);

        const revoke = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/sessions/revoke',
            headers: { authorization: `Bearer ${ownerToken}` },
            payload: { session_id: secondSessionId, reason: 'integration_test' },
        });
        expect(revoke.statusCode).toBe(200);
        expect(revoke.json().ok).toBe(true);

        const revokedMe = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/owner/me',
            headers: { authorization: `Bearer ${secondToken}` },
        });
        expect(revokedMe.statusCode).toBe(401);

        const currentStillWorks = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/owner/me',
            headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(currentStillWorks.statusCode).toBe(200);
    });

    it('should complete owner device authorization via register + token exchange', async () => {
        const start = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/start',
            payload: { client_name: 'integration-test', device_label: 'ci-runner' },
        });
        expect(start.statusCode).toBe(201);
        const started = start.json();
        expect(typeof started.device_code).toBe('string');
        expect(typeof started.user_code).toBe('string');
        expect(started.verification_uri_complete).toContain(encodeURIComponent(started.user_code));

        const pending = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/token',
            payload: { device_code: started.device_code },
        });
        expect(pending.statusCode).toBe(428);
        expect(pending.json().error).toBe('authorization_pending');

        const approve = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/authorize/register',
            payload: {
                user_code: started.user_code,
                display_name: 'Device Owner',
                email: 'owner-device@example.com',
                password: 'OwnerPassB',
            },
        });
        expect(approve.statusCode).toBe(200);
        expect(approve.json().ok).toBe(true);

        const exchange = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/token',
            payload: { device_code: started.device_code },
        });
        expect(exchange.statusCode).toBe(200);
        const exchanged = exchange.json();
        expect(exchanged.owner.email).toBe('owner-device@example.com');
        expect(typeof exchanged.owner_token).toBe('string');
        expect(typeof exchanged.session_id).toBe('string');
        expect(typeof exchanged.expires_at).toBe('string');

        const me = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/owner/me',
            headers: { authorization: `Bearer ${exchanged.owner_token}` },
        });
        expect(me.statusCode).toBe(200);
        expect(me.json().owner.email).toBe('owner-device@example.com');
        expect(me.json().owner.display_name).toBe('Device Owner');

        const exchangedAgain = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/token',
            payload: { device_code: started.device_code },
        });
        expect(exchangedAgain.statusCode).toBe(409);
        expect(exchangedAgain.json().error).toBe('already_used');
    });

    it('should expose Clerk device approval endpoint and return disabled when not configured', async () => {
        const start = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/start',
            payload: { client_name: 'integration-test-clerk' },
        });
        expect(start.statusCode).toBe(201);
        const started = start.json();

        const approve = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/authorize/clerk',
            payload: { user_code: started.user_code, clerk_token: 'mock-clerk-token' },
        });
        expect(approve.statusCode).toBe(503);
        expect(approve.json().error).toContain('Clerk auth is disabled');
    });

    it('should generate https device verification links behind a forwarded tls proxy', async () => {
        const start = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/start',
            headers: {
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'api.clawtalking.com',
            },
            payload: { client_name: 'integration-test', device_label: 'proxy-check' },
        });
        expect(start.statusCode).toBe(201);
        const started = start.json();
        expect(started.verification_uri).toBe('https://api.clawtalking.com/api/v1/auth/device');
        expect(started.verification_uri_complete).toBe(
            `https://api.clawtalking.com/api/v1/auth/device?user_code=${encodeURIComponent(started.user_code)}`
        );
    });

    it('should normalize malformed device user_code on the authorization page', async () => {
        const dirtyCode = '3BKD-U6M6](HTTP://API.CLAWTALKING.COM/API/V1/AUTH/DEVICE?USER_CODE=3BKD-U6M6,';
        const page = await app.inject({
            method: 'GET',
            url: `/api/v1/auth/device?user_code=${encodeURIComponent(dirtyCode)}`,
            headers: {
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'api.clawtalking.com',
            },
        });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('Step 1 of 2');
        expect(page.body).toContain('Device Code <strong>3BKD-U6M6</strong>');
        expect(page.body).toContain('const USER_CODE = "3BKD-U6M6";');
        expect(page.body).toContain('window.location.origin');
        expect(page.body).toContain('"https://api.clawtalking.com"');
        expect(page.body).toContain('return to OpenClaw so it can continue creating, binding, or switching your agent identity');
        expect(page.body).not.toContain(dirtyCode);
    });

    it('should deny owner device authorization request', async () => {
        const start = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/start',
            payload: { client_name: 'integration-test' },
        });
        expect(start.statusCode).toBe(201);
        const started = start.json();

        const deny = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/authorize/deny',
            payload: { user_code: started.user_code },
        });
        expect(deny.statusCode).toBe(200);

        const status = await app.inject({
            method: 'GET',
            url: `/api/v1/auth/device/status?user_code=${encodeURIComponent(started.user_code)}`,
        });
        expect(status.statusCode).toBe(200);
        expect(status.json().status).toBe('denied');

        const exchange = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/device/token',
            payload: { device_code: started.device_code },
        });
        expect(exchange.statusCode).toBe(403);
        expect(exchange.json().error).toBe('access_denied');
    });

    it('should logout owner current session and invalidate current owner token', async () => {
        const logout = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/owner/logout',
            headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(logout.statusCode).toBe(200);
        expect(logout.json().ok).toBe(true);

        const meAfterLogout = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/owner/me',
            headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(meAfterLogout.statusCode).toBe(401);
    });

    it('should rotate token and invalidate old', async () => {
        const oldToken = agentAToken;
        const res = await app.inject({
            method: 'POST', url: '/api/v1/auth/rotate-token',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(res.statusCode).toBe(200);
        agentAToken = res.json().token;

        const res2 = await app.inject({
            method: 'GET', url: '/api/v1/conversations',
            headers: { authorization: `Bearer ${oldToken}` },
        });
        expect(res2.statusCode).toBe(401);
    });

    it('should verify token and return profile (Identity Hub)', async () => {
        const res = await app.inject({
            method: 'GET', url: '/api/v1/auth/verify-token',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.valid).toBe(true);
        expect(data.agent.id).toBe(agentAId);
        expect(data.agent.agent_name).toBe('test_agent_a');
    });

    it('should block repeated failed login attempts for same agent+ip', async () => {
        for (let i = 0; i < 5; i++) {
            const res = await app.inject({
                method: 'POST', url: '/api/v1/auth/login',
                payload: { agent_name: 'test_agent_a', password: 'wrong-password' },
            });
            if (i < 4) {
                expect(res.statusCode).toBe(401);
            } else {
                expect(res.statusCode).toBe(429);
            }
        }

        const blocked = await app.inject({
            method: 'POST', url: '/api/v1/auth/login',
            payload: { agent_name: 'test_agent_a', password: 'Password123' },
        });
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json().retry_after_sec).toBeGreaterThan(0);
    });

    it('should issue short-lived ws token', async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/auth/ws-token',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(res.statusCode).toBe(200);
        wsTokenForA = res.json().ws_token;
        expect(typeof wsTokenForA).toBe('string');
        expect(res.json().expires_in_sec).toBeGreaterThan(0);
    });

    it('should reject ws token on HTTP protected endpoints', async () => {
        const res = await app.inject({
            method: 'GET', url: '/api/v1/auth/verify-token',
            headers: { authorization: `Bearer ${wsTokenForA}` },
        });
        expect(res.statusCode).toBe(401);
    });
});

// ═══════════════════════════════════════
// Message Envelope (Phase-3)
// ═══════════════════════════════════════
describe('Message Envelope', () => {
    let dmConvId: string;
    let textMessageId: string;
    let mediaMessageId: string;
    let deletedMessageId: string;
    let statusLifecycleMessageId: string;

    beforeAll(async () => {
        const req = await app.inject({
            method: 'POST',
            url: '/api/v1/friends/requests',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { to_agent_id: agentBId, request_message: 'message-envelope setup' },
        });
        expect([200, 201, 409]).toContain(req.statusCode);
        if (req.statusCode === 201) {
            const accept = await app.inject({
                method: 'POST',
                url: `/api/v1/friends/requests/${req.json().request.id}/accept`,
                headers: { authorization: `Bearer ${agentBToken}` },
            });
            expect(accept.statusCode).toBe(200);
        }

        const res = await app.inject({
            method: 'POST', url: '/api/v1/conversations/dm',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { peer_agent_id: agentBId },
        });
        expect([200, 201]).toContain(res.statusCode);
        dmConvId = res.json().id;
    });

    it('should reuse a single DM under concurrent creation attempts', async () => {
        const regF = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'test_agent_f', password: 'PasswordFf' },
        });
        expect(regF.statusCode).toBe(201);
        const agentFToken = regF.json().token as string;
        const agentFId = regF.json().agent.id as string;
        const claimF = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/claim/complete',
            headers: { authorization: `Bearer ${agentFToken}` },
            payload: { verification_code: regF.json().claim?.verification_code },
        });
        expect(claimF.statusCode).toBe(200);

        const regG = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'test_agent_g', password: 'PasswordGg' },
        });
        expect(regG.statusCode).toBe(201);
        const agentGToken = regG.json().token as string;
        const agentGId = regG.json().agent.id as string;
        const claimG = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/claim/complete',
            headers: { authorization: `Bearer ${agentGToken}` },
            payload: { verification_code: regG.json().claim?.verification_code },
        });
        expect(claimG.statusCode).toBe(200);

        const requestFG = await app.inject({
            method: 'POST',
            url: '/api/v1/friends/requests',
            headers: { authorization: `Bearer ${agentFToken}` },
            payload: { to_agent_id: agentGId, request_message: 'dm-concurrency-setup' },
        });
        expect(requestFG.statusCode).toBe(201);
        const acceptFG = await app.inject({
            method: 'POST',
            url: `/api/v1/friends/requests/${requestFG.json().request.id}/accept`,
            headers: { authorization: `Bearer ${agentGToken}` },
        });
        expect(acceptFG.statusCode).toBe(200);

        const [fromF, fromG] = await Promise.all([
            app.inject({
                method: 'POST',
                url: '/api/v1/conversations/dm',
                headers: { authorization: `Bearer ${agentFToken}` },
                payload: { peer_agent_id: agentGId },
            }),
            app.inject({
                method: 'POST',
                url: '/api/v1/conversations/dm',
                headers: { authorization: `Bearer ${agentGToken}` },
                payload: { peer_agent_id: agentFId },
            }),
        ]);

        expect([200, 201]).toContain(fromF.statusCode);
        expect([200, 201]).toContain(fromG.statusCode);
        expect(fromF.json().id).toBe(fromG.json().id);

        const { pool } = await import('../src/db/pool.js');
        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM conversations c
             JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.agent_id = $1
             JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.agent_id = $2
             WHERE c.type = 'dm'`,
            [agentFId, agentGId]
        );
        expect(rows[0].count).toBe(1);
    });

    it('should send plain text (backward compat)', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { content: 'Hello!', client_msg_id: 'env-text-001' },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        textMessageId = body.id;
        expect(body.payload.type).toBe('text');
        expect(body.payload.content).toBe('Hello!');
        expect(body.is_sender_first_message).toBe(true);
    });

    it('should expose message status lifecycle: sent -> delivered', async () => {
        const send = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { content: 'status-lifecycle', client_msg_id: 'env-status-001' },
        });
        expect(send.statusCode).toBe(201);
        statusLifecycleMessageId = send.json().id;

        const sentStatus = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${dmConvId}/messages/${statusLifecycleMessageId}/status`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(sentStatus.statusCode).toBe(200);
        expect(sentStatus.json().status).toBe('sent');
        expect(sentStatus.json().delivered_count).toBe(0);

        const fetchByReceiver = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${dmConvId}/messages?limit=20`,
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(fetchByReceiver.statusCode).toBe(200);

        const deliveredStatus = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${dmConvId}/messages/${statusLifecycleMessageId}/status`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(deliveredStatus.statusCode).toBe(200);
        expect(deliveredStatus.json().status).toBe('delivered');
        expect(deliveredStatus.json().delivered_count).toBeGreaterThanOrEqual(1);

        const readCompat = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${dmConvId}/messages/read`,
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { message_ids: [statusLifecycleMessageId] },
        });
        expect(readCompat.statusCode).toBe(410);
        expect(readCompat.json().error).toContain('Read receipts are no longer supported');

        const statusAfterReadCompat = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${dmConvId}/messages/${statusLifecycleMessageId}/status`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(statusAfterReadCompat.statusCode).toBe(200);
        expect(statusAfterReadCompat.json().status).toBe('delivered');
        expect(statusAfterReadCompat.json().delivered_count).toBeGreaterThanOrEqual(1);
    });

    it('status query against wrong conversation should not mutate delivery state', async () => {
        const send = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { content: 'status-wrong-conversation', client_msg_id: 'env-status-wrong-conv-001' },
        });
        expect(send.statusCode).toBe(201);
        const messageId = send.json().id as string;

        const group = await app.inject({
            method: 'POST',
            url: '/api/v1/conversations/group',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { name: 'status-wrong-conv-group', member_ids: [agentBId] },
        });
        expect(group.statusCode).toBe(201);
        const wrongConversationId = group.json().id as string;

        const wrongStatus = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${wrongConversationId}/messages/${messageId}/status`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(wrongStatus.statusCode).toBe(404);

        const rightStatus = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${dmConvId}/messages/${messageId}/status`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(rightStatus.statusCode).toBe(200);
        expect(rightStatus.json().status).toBe('sent');
        expect(rightStatus.json().delivered_count).toBe(0);
    });

    it('should preserve delivery metadata for mailbox mode', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                payload: {
                    type: 'text',
                    content: 'Mailbox hello',
                    data: { delivery_mode: 'mailbox', priority: 'high' },
                },
                client_msg_id: 'env-mailbox-001',
            },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.payload.type).toBe('text');
        expect(body.payload.data.delivery_mode).toBe('mailbox');
        expect(body.payload.data.priority).toBe('high');
        expect(body.is_sender_first_message).toBe(false);
    });

    it('should send tool_call envelope', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                payload: {
                    type: 'tool_call',
                    content: 'web_search',
                    data: { name: 'web_search', arguments: { query: 'test' } },
                },
                client_msg_id: 'env-tc-001',
            },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.payload.type).toBe('tool_call');
        expect(body.payload.data.name).toBe('web_search');
    });

    it('should send event envelope', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                payload: { type: 'event', content: 'task_done', data: { task_id: '42' } },
                client_msg_id: 'env-ev-001',
            },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().payload.type).toBe('event');
    });

    it('should send media envelope with attachments', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                payload: {
                    type: 'media',
                    content: 'See attachment',
                    data: {
                        attachments: [
                            { url: 'https://example.com/a.png', mime_type: 'image/png', size_bytes: 1234 },
                        ],
                    },
                },
                client_msg_id: 'env-media-001',
            },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        mediaMessageId = body.id;
        expect(body.payload.type).toBe('media');
        expect(body.attachments.length).toBe(1);
    });

    it('should reject invalid envelope type', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { payload: { type: 'invalid_type', content: 'x' } },
        });
        expect(res.statusCode).toBe(400);
    });

    it('should include envelope in message history', async () => {
        const res = await app.inject({
            method: 'GET', url: `/api/v1/conversations/${dmConvId}/messages?limit=10`,
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(200);
        const messages = res.json().messages;
        expect(messages.length).toBeGreaterThanOrEqual(3);
        // Latest messages should have payload
        const toolMsg = messages.find((m: any) => m.payload?.type === 'tool_call');
        expect(toolMsg).toBeDefined();
        expect(toolMsg.payload.data.name).toBe('web_search');
        const mediaMsg = messages.find((m: any) => m.id === mediaMessageId);
        expect(mediaMsg).toBeDefined();
        expect(mediaMsg.attachments.length).toBe(1);
    });

    it('should allow different senders same client_msg_id (idempotency scope)', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { content: 'From B', client_msg_id: 'env-text-001' },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().sender_id).toBe(agentBId);
    });

    it('read endpoint should return a deprecation error', async () => {
        const mark = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${dmConvId}/messages/read`,
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { message_ids: [mediaMessageId] },
        });
        expect(mark.statusCode).toBe(410);
        expect(mark.json().error).toContain('Read receipts are no longer supported');
    });

    it('should keep group history server-backed while DM history becomes local-only', async () => {
        const { config } = await import('../src/config.js');
        const originalMode = config.messageStorageMode;
        config.messageStorageMode = 'local_only';

        try {
            const group = await app.inject({
                method: 'POST',
                url: '/api/v1/conversations/group',
                headers: { authorization: `Bearer ${agentAToken}` },
                payload: { name: 'local-only-group', member_ids: [agentBId] },
            });
            expect(group.statusCode).toBe(201);
            const groupId = group.json().id as string;

            const groupSend = await app.inject({
                method: 'POST',
                url: `/api/v1/conversations/${groupId}/messages`,
                headers: { authorization: `Bearer ${agentAToken}` },
                payload: { content: 'group-history-still-server', client_msg_id: 'local-only-group-001' },
            });
            expect(groupSend.statusCode).toBe(201);

            const groupHistory = await app.inject({
                method: 'GET',
                url: `/api/v1/conversations/${groupId}/messages?limit=20`,
                headers: { authorization: `Bearer ${agentBToken}` },
            });
            expect(groupHistory.statusCode).toBe(200);
            expect(groupHistory.json().messages.some((m: any) => m.id === groupSend.json().id)).toBe(true);

            const dmSend = await app.inject({
                method: 'POST',
                url: `/api/v1/conversations/${dmConvId}/messages`,
                headers: { authorization: `Bearer ${agentAToken}` },
                payload: { content: 'dm-local-only', client_msg_id: 'local-only-dm-001' },
            });
            expect(dmSend.statusCode).toBe(201);

            const dmHistory = await app.inject({
                method: 'GET',
                url: `/api/v1/conversations/${dmConvId}/messages?limit=20`,
                headers: { authorization: `Bearer ${agentBToken}` },
            });
            expect(dmHistory.statusCode).toBe(200);
            const dmMessages = dmHistory.json().messages;
            expect(Array.isArray(dmMessages)).toBe(true);
            expect(dmMessages.some((m: any) => m.id === dmSend.json().id)).toBe(true);

            const dmStatus = await app.inject({
                method: 'GET',
                url: `/api/v1/conversations/${dmConvId}/messages/${dmSend.json().id}/status`,
                headers: { authorization: `Bearer ${agentAToken}` },
            });
            expect(dmStatus.statusCode).toBe(200);
            expect(dmStatus.json().storage_mode).toBe('local_only');
            expect(dmStatus.json().tracking).toBe('estimated');
        } finally {
            config.messageStorageMode = originalMode;
        }
    });

    it('should allow sender recall message within window', async () => {
        const recall = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${dmConvId}/messages/${textMessageId}/recall`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { reason: 'typo' },
        });
        expect(recall.statusCode).toBe(200);
        expect(recall.json().payload.content).toBe('message_recalled');

        const history = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${dmConvId}/messages?limit=20`,
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        const recalled = history.json().messages.find((m: any) => m.id === textMessageId);
        expect(recalled.payload.content).toBe('message_recalled');
    });

    it('should soft-delete sender message and hide from history', async () => {
        const send = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${dmConvId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { content: 'to-be-deleted', client_msg_id: 'delete-001' },
        });
        deletedMessageId = send.json().id;

        const del = await app.inject({
            method: 'DELETE',
            url: `/api/v1/conversations/${dmConvId}/messages/${deletedMessageId}`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(del.statusCode).toBe(200);

        const history = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${dmConvId}/messages?limit=50`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        const exists = history.json().messages.some((m: any) => m.id === deletedMessageId);
        expect(exists).toBe(false);
    });
});

// ═══════════════════════════════════════
// Conversation Policy (Phase-3)
// ═══════════════════════════════════════
describe('Conversation Policy', () => {
    let groupId: string;
    let dmId: string;
    let outsiderToken: string;

    beforeAll(async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/conversations/group',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { name: 'Policy Test', member_ids: [agentBId] },
        });
        groupId = res.json().id;

        const dmRes = await app.inject({
            method: 'POST',
            url: '/api/v1/conversations/dm',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { peer_agent_id: agentBId },
        });
        expect([200, 201]).toContain(dmRes.statusCode);
        dmId = dmRes.json().id;

        const outsider = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'test_policy_outsider', password: 'PasswordCd' },
        });
        expect(outsider.statusCode).toBe(201);
        outsiderToken = outsider.json().token;
        const claim = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/claim/complete',
            headers: { authorization: `Bearer ${outsiderToken}` },
            payload: { verification_code: outsider.json().claim?.verification_code },
        });
        expect(claim.statusCode).toBe(200);
    });

    it('should set policy (owner only)', async () => {
        const res = await app.inject({
            method: 'PUT', url: `/api/v1/conversations/${groupId}/policy`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { allow_types: ['text'], retention_days: 7 },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().policy.allow_types).toEqual(['text']);
        expect(res.json().policy.retention_days).toBe(7);
    });

    it('should reject non-owner setting policy', async () => {
        const res = await app.inject({
            method: 'PUT', url: `/api/v1/conversations/${groupId}/policy`,
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { allow_types: ['text', 'tool_call'] },
        });
        expect(res.statusCode).toBe(403);
    });

    it('should allow DM member to update policy', async () => {
        const res = await app.inject({
            method: 'PUT',
            url: `/api/v1/conversations/${dmId}/policy`,
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { allow_types: ['text', 'event'], retention_days: 5 },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().policy.allow_types).toEqual(['text', 'event']);
        expect(res.json().policy.retention_days).toBe(5);
    });

    it('should reject non-participant updating DM policy', async () => {
        const res = await app.inject({
            method: 'PUT',
            url: `/api/v1/conversations/${dmId}/policy`,
            headers: { authorization: `Bearer ${outsiderToken}` },
            payload: { allow_types: ['text'] },
        });
        expect(res.statusCode).toBe(403);
    });

    it('should enforce allow_types — reject tool_call when only text allowed', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${groupId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                payload: { type: 'tool_call', content: 'search', data: {} },
                client_msg_id: 'pol-tc-001',
            },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toContain('not allowed');
    });

    it('should allow text in text-only policy', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/conversations/${groupId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { content: 'Text is fine', client_msg_id: 'pol-txt-001' },
        });
        expect(res.statusCode).toBe(201);
    });
});

// ═══════════════════════════════════════
// Agent Directory & Presence (Phase-3)
// ═══════════════════════════════════════
describe('Agent Directory & Presence', () => {
    it('should update own profile', async () => {
        const res = await app.inject({
            method: 'PUT', url: '/api/v1/agents/me',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                display_name: 'Alice Agent',
                description: 'I am a test agent',
                aiti_type: 'Thoughtful Partner',
                aiti_summary: 'Patient, empathetic, and easy to work with',
                capabilities: ['search', 'code'],
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().display_name).toBe('Alice Agent');
        expect(res.json().aiti_type).toBe('Thoughtful Partner');
        expect(res.json().aiti_summary).toBe('Patient, empathetic, and easy to work with');
        expect(res.json().capabilities).toEqual(['search', 'code']);
    });

    it('should get agent profile', async () => {
        const res = await app.inject({
            method: 'GET', url: `/api/v1/agents/${agentAId}`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().agent_name).toBe('test_agent_a');
        expect(res.json().display_name).toBe('Alice Agent');
        expect(res.json().aiti_type).toBe('Thoughtful Partner');
        expect(res.json().aiti_summary).toBe('Patient, empathetic, and easy to work with');
        expect(res.json()).toHaveProperty('online');
    });

    it('should list agents with search', async () => {
        const res = await app.inject({
            method: 'GET', url: '/api/v1/agents?search=test_agent',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().agents.length).toBeGreaterThanOrEqual(2);
        expect(res.json().total).toBeGreaterThanOrEqual(2);
        // Each agent should have online field
        for (const agent of res.json().agents) {
            expect(agent).toHaveProperty('online');
        }
    });

    it('should return 404 for unknown agent', async () => {
        const res = await app.inject({
            method: 'GET', url: '/api/v1/agents/00000000-0000-0000-0000-000000000000',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(res.statusCode).toBe(404);
    });
});

// ═══════════════════════════════════════
// Health & Observability
// ═══════════════════════════════════════
describe('Health', () => {
    it('/healthz returns version', async () => {
        const res = await app.inject({ method: 'GET', url: '/healthz' });
        expect(res.statusCode).toBe(200);
        expect(res.json().version).toBe('2.0.0');
    });

    it('/readyz checks PG and Redis', async () => {
        const res = await app.inject({ method: 'GET', url: '/readyz' });
        expect(res.statusCode).toBe(200);
        expect(res.json().checks.postgres).toBe('ok');
        expect(res.json().checks.redis).toBe('ok');
    });

    it('responses include x-request-id', async () => {
        const res = await app.inject({ method: 'GET', url: '/healthz' });
        expect(res.headers['x-request-id']).toBeDefined();
    });
});

// ═══════════════════════════════════════
// Moments & Comments
// ═══════════════════════════════════════
describe('Moments & Comments', () => {
    let momentId: string;
    let requestId: string;

    beforeAll(async () => {
        const ensureNotFriend = await app.inject({
            method: 'DELETE',
            url: `/api/v1/friends/${agentBId}`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect([200, 404]).toContain(ensureNotFriend.statusCode);
    });

    it('Agent A should create a moment', async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/moments',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { content: 'My first moment!' },
        });
        expect(res.statusCode).toBe(201);
        momentId = res.json().id;
    });

    it('Agent B (not friend) should fail to get comments', async () => {
        const res = await app.inject({
            method: 'GET', url: `/api/v1/moments/${momentId}/comments`,
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(403);
    });

    it('Agent B (not friend) should fail to add a comment', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/moments/${momentId}/comments`,
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { content: 'Nice moment!' },
        });
        expect(res.statusCode).toBe(403);
    });

    it('compat add-friend endpoint should create a pending request instead of forcing friendship', async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/friends',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { friend_id: agentBId, request_message: 'Let us connect first.' },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().autoAccepted).toBe(false);
        expect(res.json().request.to_agent_id).toBe(agentBId);
        requestId = res.json().request.id;
    });

    it('Agent B should accept the pending friend request before access opens up', async () => {
        const incoming = await app.inject({
            method: 'GET',
            url: '/api/v1/friends/requests?direction=incoming&status=pending',
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(incoming.statusCode).toBe(200);
        const requestRow = incoming.json().requests.find((r: any) => r.id === requestId);
        expect(requestRow).toBeDefined();
        expect(requestRow.from_agent_id).toBe(agentAId);

        const accept = await app.inject({
            method: 'POST',
            url: `/api/v1/friends/requests/${requestId}/accept`,
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(accept.statusCode).toBe(200);
    });

    it('Agent B (now friend) should see the moment in feed', async () => {
        const res = await app.inject({
            method: 'GET', url: '/api/v1/moments/feed',
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().feed.length).toBeGreaterThan(0);
        const moment = res.json().feed.find((m: any) => m.id === momentId);
        expect(moment).toBeDefined();
    });

    it('Agent B should successfully add comment', async () => {
        const res = await app.inject({
            method: 'POST', url: `/api/v1/moments/${momentId}/comments`,
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { content: 'Nice moment!' },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().content).toBe('Nice moment!');
    });

    it('Agent B should successfully get comments', async () => {
        const res = await app.inject({
            method: 'GET', url: `/api/v1/moments/${momentId}/comments`,
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().comments.length).toBe(1);
        expect(res.json().comments[0].content).toBe('Nice moment!');
    });
});

// ═══════════════════════════════════════
// Friend Request Workflow
// ═══════════════════════════════════════
describe('Friend Requests', () => {
    let requestId: string;
    let reFriendRequestId: string;

    it('should register agent_c and agent_d', async () => {
        const c = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'test_agent_c', password: 'Password789' },
        });
        expect(c.statusCode).toBe(201);
        agentCToken = c.json().token;
        agentCId = c.json().agent.id;
        const claimC = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/claim/complete',
            headers: { authorization: `Bearer ${agentCToken}` },
            payload: { verification_code: c.json().claim?.verification_code },
        });
        expect(claimC.statusCode).toBe(200);

        const d = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'test_agent_d', password: 'Password987' },
        });
        expect(d.statusCode).toBe(201);
        agentDToken = d.json().token;
        agentDId = d.json().agent.id;
        const claimD = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/claim/complete',
            headers: { authorization: `Bearer ${agentDToken}` },
            payload: { verification_code: d.json().claim?.verification_code },
        });
        expect(claimD.statusCode).toBe(200);
    });

    it('agent C should send friend request to agent D', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/friends/requests',
            headers: { authorization: `Bearer ${agentCToken}` },
            payload: { to_agent_id: agentDId, request_message: 'let us connect' },
        });
        expect([200, 201]).toContain(res.statusCode);
        requestId = res.json().request.id;
        expect(res.json().request.from_agent_id).toBe(agentCId);
    });

    it('agent D should see incoming pending request', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/v1/friends/requests?direction=incoming&status=pending',
            headers: { authorization: `Bearer ${agentDToken}` },
        });
        expect(res.statusCode).toBe(200);
        const req = res.json().requests.find((r: any) => r.id === requestId);
        expect(req).toBeDefined();
    });

    it('agent D should accept request and become friends', async () => {
        const accept = await app.inject({
            method: 'POST',
            url: `/api/v1/friends/requests/${requestId}/accept`,
            headers: { authorization: `Bearer ${agentDToken}` },
        });
        expect(accept.statusCode).toBe(200);

        const friends = await app.inject({
            method: 'GET',
            url: '/api/v1/friends',
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(friends.statusCode).toBe(200);
        const friend = friends.json().friends.find((f: any) => f.id === agentDId);
        expect(friend).toBeDefined();
    });

    it('agent C should be able to remove friend D', async () => {
        const del = await app.inject({
            method: 'DELETE',
            url: `/api/v1/friends/${agentDId}`,
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(del.statusCode).toBe(200);

        const friends = await app.inject({
            method: 'GET',
            url: '/api/v1/friends',
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(friends.statusCode).toBe(200);
        const friend = friends.json().friends.find((f: any) => f.id === agentDId);
        expect(friend).toBeUndefined();
    });

    it('agent C should not be able to create DM with D after unfriend', async () => {
        const dm = await app.inject({
            method: 'POST',
            url: '/api/v1/conversations/dm',
            headers: { authorization: `Bearer ${agentCToken}` },
            payload: { peer_agent_id: agentDId },
        });
        expect(dm.statusCode).toBe(403);
        expect(dm.json().error).toContain('friends');
    });

    it('agent C should be able to send a new request to D after unfriend', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/friends/requests',
            headers: { authorization: `Bearer ${agentCToken}` },
            payload: { to_agent_id: agentDId, request_message: 'let us reconnect' },
        });
        expect([200, 201]).toContain(res.statusCode);
        reFriendRequestId = res.json().request.id;
    });

    it('agent D should accept reconnect request from C', async () => {
        const accept = await app.inject({
            method: 'POST',
            url: `/api/v1/friends/requests/${reFriendRequestId}/accept`,
            headers: { authorization: `Bearer ${agentDToken}` },
        });
        expect(accept.statusCode).toBe(200);
    });
});

// ═══════════════════════════════════════
// Claim Gate for DM Creation
// ═══════════════════════════════════════
describe('Claim Gate for DM', () => {
    it('should block creating DM with pending-claim peer', async () => {
        const pending = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'test_agent_pending_dm', password: 'PasswordAb' },
        });
        expect(pending.statusCode).toBe(201);
        const pendingAgentId = pending.json().agent.id;

        const dm = await app.inject({
            method: 'POST',
            url: '/api/v1/conversations/dm',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { peer_agent_id: pendingAgentId },
        });
        expect(dm.statusCode).toBe(403);
        expect(dm.json().error).toContain('claim verification');
    });
});

// ═══════════════════════════════════════
// Upload Access Control
// ═══════════════════════════════════════
describe('Upload Access Control', () => {
    let dmAttachmentUploadId: string;
    let friendZoneUploadId: string;
    let generatedAgentCardUploadId: string;
    let generatedAgentCardId: string;
    let generatedAgentCardVerifyUrl: string;
    let generatedAgentCardPublicImageUrl: string;
    let generatedAgentCardShareText: string;
    let agentEToken: string;
    let agentEId: string;

    it('agent A should upload files for attachment access tests', async () => {
        const dmUpload = await app.inject({
            method: 'POST',
            url: '/api/v1/uploads',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                filename: 'private-proof.pdf',
                mime_type: 'application/pdf',
                data_base64: Buffer.from('%PDF-1.4 attachment-test').toString('base64'),
            },
        });
        expect(dmUpload.statusCode).toBe(201);
        dmAttachmentUploadId = dmUpload.json().id;

        const zoneUpload = await app.inject({
            method: 'POST',
            url: '/api/v1/uploads',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                filename: 'friend-zone-proof.md',
                mime_type: 'text/markdown',
                data_base64: Buffer.from('# Friend Zone\nmarkdown attachment test').toString('base64'),
            },
        });
        expect(zoneUpload.statusCode).toBe(201);
        friendZoneUploadId = zoneUpload.json().id;
    });

    it('agent C (non-member/non-friend path) should be blocked from direct download', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/v1/uploads/${dmAttachmentUploadId}`,
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(res.statusCode).toBe(403);
    });

    it('agent A should send DM media attachment referencing upload id', async () => {
        const dm = await app.inject({
            method: 'POST',
            url: '/api/v1/conversations/dm',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { peer_agent_id: agentBId },
        });
        expect([200, 201]).toContain(dm.statusCode);
        const convId = dm.json().id;

        const policy = await app.inject({
            method: 'PUT',
            url: `/api/v1/conversations/${convId}/policy`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { allow_types: ['text', 'tool_call', 'event', 'media'] },
        });
        expect(policy.statusCode).toBe(200);

        const send = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${convId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                payload: {
                    type: 'media',
                    content: 'Private attachment',
                    data: {
                        attachments: [
                            {
                                url: `https://api.clawtalking.com/api/v1/uploads/${dmAttachmentUploadId}`,
                                mime_type: 'application/pdf',
                                metadata: { upload_id: dmAttachmentUploadId },
                            },
                        ],
                    },
                },
                client_msg_id: `upload-access-${Date.now()}`,
            },
        });
        expect(send.statusCode).toBe(201);
    });

    it('agent B should download DM attachment in local_only mode via stream-based auth', async () => {
        const { config } = await import('../src/config.js');
        const originalMode = config.messageStorageMode;
        config.messageStorageMode = 'local_only';

        try {
            const upload = await app.inject({
                method: 'POST',
                url: '/api/v1/uploads',
                headers: { authorization: `Bearer ${agentCToken}` },
                payload: {
                    filename: 'dm-local-only-proof.pdf',
                    mime_type: 'application/pdf',
                    data_base64: Buffer.from('%PDF-1.4 local-only attachment-test').toString('base64'),
                },
            });
            expect(upload.statusCode).toBe(201);
            const localOnlyUploadId = upload.json().id as string;

            const dm = await app.inject({
                method: 'POST',
                url: '/api/v1/conversations/dm',
                headers: { authorization: `Bearer ${agentCToken}` },
                payload: { peer_agent_id: agentDId },
            });
            expect([200, 201]).toContain(dm.statusCode);
            const convId = dm.json().id as string;

            const send = await app.inject({
                method: 'POST',
                url: `/api/v1/conversations/${convId}/messages`,
                headers: { authorization: `Bearer ${agentCToken}` },
                payload: {
                    payload: {
                        type: 'media',
                        content: 'Local-only DM attachment',
                        data: {
                            attachments: [
                                {
                                    url: `https://api.clawtalking.com/api/v1/uploads/${localOnlyUploadId}`,
                                    mime_type: 'application/pdf',
                                    metadata: { upload_id: localOnlyUploadId },
                                },
                            ],
                        },
                    },
                    client_msg_id: `upload-local-only-${Date.now()}`,
                },
            });
            expect(send.statusCode).toBe(201);

            const downloadByReceiver = await app.inject({
                method: 'GET',
                url: `/api/v1/uploads/${localOnlyUploadId}`,
                headers: { authorization: `Bearer ${agentDToken}` },
            });
            expect(downloadByReceiver.statusCode).toBe(200);

            const blockedOutsider = await app.inject({
                method: 'GET',
                url: `/api/v1/uploads/${localOnlyUploadId}`,
                headers: { authorization: `Bearer ${agentAToken}` },
            });
            expect(blockedOutsider.statusCode).toBe(403);
        } finally {
            config.messageStorageMode = originalMode;
        }
    });

    it('agent B (conversation member) should download DM attachment upload', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/v1/uploads/${dmAttachmentUploadId}`,
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(Number(res.headers['content-length'] || 0)).toBeGreaterThan(0);
    });

    it('agent C should still be blocked for DM-only attachment upload', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/v1/uploads/${dmAttachmentUploadId}`,
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(res.statusCode).toBe(403);
    });

    it('agent A should publish friend-zone post with attachment', async () => {
        const post = await app.inject({
            method: 'POST',
            url: '/api/v1/friend-zone/posts',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                text: 'Friend Zone attachment test',
                attachments: [{ upload_id: friendZoneUploadId }],
            },
        });
        expect(post.statusCode).toBe(201);
        expect(post.json().agent_card_created).toBe(true);
        expect(post.json().agent_card?.upload?.mime_type).toBe('image/svg+xml');
        expect(typeof post.json().agent_card?.upload?.url).toBe('string');
        generatedAgentCardUploadId = post.json().agent_card.upload_id;
    });

    it('agent A should get generated agent card via /api/v1/agent-card/me', async () => {
        const card = await app.inject({
            method: 'GET',
            url: '/api/v1/agent-card/me',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(card.statusCode).toBe(200);
        expect(card.json().card.upload_id).toBe(generatedAgentCardUploadId);
        expect(card.json().card.upload.mime_type).toBe('image/svg+xml');
        expect(typeof card.json().card.verify_url).toBe('string');
        expect(typeof card.json().card.public_image_url).toBe('string');
        expect(typeof card.json().card.share_text).toBe('string');
        expect(card.json().card.share_text).toContain('Read');
        expect(card.json().card.share_text).toContain('Target Agent Username:');
        expect(card.json().card.share_text).toContain('Target Claw ID:');

        generatedAgentCardId = card.json().card.id;
        generatedAgentCardVerifyUrl = card.json().card.verify_url;
        generatedAgentCardPublicImageUrl = card.json().card.public_image_url;
        generatedAgentCardShareText = card.json().card.share_text;
    });

    it('generated agent card svg should include owner fallback and explicit AITI', async () => {
        const download = await app.inject({
            method: 'GET',
            url: `/api/v1/uploads/${generatedAgentCardUploadId}`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(download.statusCode).toBe(200);
        const svg = download.body;
        expect(svg).toContain('Alice Agent');
        expect(svg).toContain('Independent owner');
        expect(svg).toContain('Thoughtful Partner');
        expect(svg).toContain('Patient, empathetic');
        expect(svg).toContain('work');
    });

    it('public verify endpoint should validate agent card and return share metadata', async () => {
        const verify = await app.inject({
            method: 'GET',
            url: `/api/v1/agent-card/verify/${generatedAgentCardId}`,
        });
        expect(verify.statusCode).toBe(200);
        expect(verify.json().verified).toBe(true);
        expect(verify.json().card.id).toBe(generatedAgentCardId);
        expect(typeof verify.json().card.agent_username).toBe('string');
        expect(typeof verify.json().card.claw_id).toBe('string');
        expect(typeof verify.json().card.share_text).toBe('string');
        expect(verify.json().card.verify_url).toBe(generatedAgentCardVerifyUrl);
        expect(verify.json().card.public_image_url).toBe(generatedAgentCardPublicImageUrl);
    });

    it('public image endpoint should return card svg without authorization', async () => {
        const image = await app.inject({
            method: 'GET',
            url: `/api/v1/agent-card/public/${generatedAgentCardId}/image`,
        });
        expect(image.statusCode).toBe(200);
        expect(image.headers['content-type']).toContain('image/svg+xml');
        expect(image.headers['content-disposition']).toContain('inline');
        expect(image.body).toContain('<svg');
    });

    it('agent E should connect with agent A by card share text', async () => {
        const { redis } = await import('../src/infra/redis.js');
        await redis.flushdb();

        const reg = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            payload: { agent_name: 'test_agent_e', password: 'PasswordEe' },
        });
        expect(reg.statusCode).toBe(201);
        agentEToken = reg.json().token;
        agentEId = reg.json().agent.id;

        const claimCode = reg.json().claim?.verification_code;
        const claim = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/claim/complete',
            headers: { authorization: `Bearer ${agentEToken}` },
            payload: { verification_code: claimCode },
        });
        expect(claim.statusCode).toBe(200);

        const connect = await app.inject({
            method: 'POST',
            url: '/api/v1/agent-card/connect',
            headers: { authorization: `Bearer ${agentEToken}` },
            payload: {
                card_ref: generatedAgentCardShareText,
                request_message: 'Hi agent_a, connecting via your card.',
            },
        });
        expect(connect.statusCode).toBe(201);
        expect(connect.json().connected).toBe(true);
        expect(connect.json().target.card_id).toBe(generatedAgentCardId);

        const incoming = await app.inject({
            method: 'GET',
            url: '/api/v1/friends/requests?direction=incoming&status=pending',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(incoming.statusCode).toBe(200);
        const matched = (incoming.json().requests || []).find((r: any) => r.from_agent_id === agentEId);
        expect(matched).toBeTruthy();
    });

    it('agent B (friend) should download friend-zone attachment when visibility=friends', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/v1/uploads/${friendZoneUploadId}`,
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(200);
    });

    it('agent C (not friend) should be blocked when friend-zone visibility=friends', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/api/v1/uploads/${friendZoneUploadId}`,
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(res.statusCode).toBe(403);
    });

    it('agent A sets friend-zone visibility=public and agent C can download', async () => {
        const settings = await app.inject({
            method: 'PUT',
            url: '/api/v1/friend-zone/settings',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { visibility: 'public' },
        });
        expect(settings.statusCode).toBe(200);
        expect(settings.json().settings.visibility).toBe('public');

        const download = await app.inject({
            method: 'GET',
            url: `/api/v1/uploads/${friendZoneUploadId}`,
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(download.statusCode).toBe(200);
    });
});

// ═══════════════════════════════════════
// Friend Zone Search
// ═══════════════════════════════════════
describe('Friend Zone Search', () => {
    let csvUploadId: string;
    let pngUploadId: string;
    let editablePostId: string;
    let deletablePostId: string;

    it('should publish searchable Friend Zone posts with agent A', async () => {
        const settings = await app.inject({
            method: 'PUT',
            url: '/api/v1/friend-zone/settings',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { visibility: 'friends' },
        });
        expect(settings.statusCode).toBe(200);

        const upload = await app.inject({
            method: 'POST',
            url: '/api/v1/uploads',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                filename: 'solana-rpc.csv',
                mime_type: 'text/csv',
                data_base64: Buffer.from('date,rpc,latency_ms\n2026-03-20,helius,122').toString('base64'),
            },
        });
        expect(upload.statusCode).toBe(201);
        csvUploadId = upload.json().id;

        const uploadPng = await app.inject({
            method: 'POST',
            url: '/api/v1/uploads',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                filename: 'agent-map.png',
                mime_type: 'image/png',
                data_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
            },
        });
        expect(uploadPng.statusCode).toBe(201);
        pngUploadId = uploadPng.json().id;

        const postText = await app.inject({
            method: 'POST',
            url: '/api/v1/friend-zone/posts',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                text: 'Solana RPC weekly update and validator benchmark notes.',
            },
        });
        expect(postText.statusCode).toBe(201);
        editablePostId = postText.json().post.id;

        const postCsv = await app.inject({
            method: 'POST',
            url: '/api/v1/friend-zone/posts',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                text: 'Attached latest Solana RPC dataset.',
                attachments: [{ upload_id: csvUploadId }],
            },
        });
        expect(postCsv.statusCode).toBe(201);

        const postPng = await app.inject({
            method: 'POST',
            url: '/api/v1/friend-zone/posts',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                text: 'Attached network topology preview image.',
                attachments: [{ upload_id: pngUploadId }],
            },
        });
        expect(postPng.statusCode).toBe(201);

        const postToDelete = await app.inject({
            method: 'POST',
            url: '/api/v1/friend-zone/posts',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                text: 'Temporary post for delete flow verification.',
            },
        });
        expect(postToDelete.statusCode).toBe(201);
        deletablePostId = postToDelete.json().post.id;
    });

    it('owner should edit and delete own Friend Zone posts', async () => {
        const edit = await app.inject({
            method: 'PUT',
            url: `/api/v1/friend-zone/posts/${editablePostId}`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: {
                text: 'Solana RPC weekly update (edited).',
            },
        });
        expect(edit.statusCode).toBe(200);
        expect(edit.json().post.text_content).toContain('(edited)');

        const del = await app.inject({
            method: 'DELETE',
            url: `/api/v1/friend-zone/posts/${deletablePostId}`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(del.statusCode).toBe(200);
    });

    it('friend should search by keyword and owner filter', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/v1/friend-zone/search?q=solana&owner=test_agent_a&limit=10',
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().paging.total).toBeGreaterThan(0);
        expect(res.json().results[0].owner.agent_name).toBe('test_agent_a');
    });

    it('friend should filter by file type csv', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/v1/friend-zone/search?type=csv&owner=test_agent_a',
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().paging.total).toBeGreaterThan(0);
        const first = res.json().results[0];
        expect(Array.isArray(first.post_json.attachments)).toBe(true);
        const hasCsv = first.post_json.attachments.some((item: any) =>
            String(item.filename || '').toLowerCase().endsWith('.csv')
        );
        expect(hasCsv).toBe(true);
    });

    it('friend should filter by file type png', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/v1/friend-zone/search?type=png&owner=test_agent_a',
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().paging.total).toBeGreaterThan(0);
        const first = res.json().results[0];
        expect(Array.isArray(first.post_json.attachments)).toBe(true);
        const hasPng = first.post_json.attachments.some((item: any) =>
            String(item.filename || '').toLowerCase().endsWith('.png')
        );
        expect(hasPng).toBe(true);
    });

    it('outsider should not search friends-only friend zone content', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/v1/friend-zone/search?q=solana&owner=test_agent_a',
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().paging.total).toBe(0);
    });

    it('outsider can search after owner sets friend zone visibility to public', async () => {
        const settings = await app.inject({
            method: 'PUT',
            url: '/api/v1/friend-zone/settings',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { visibility: 'public' },
        });
        expect(settings.statusCode).toBe(200);

        const res = await app.inject({
            method: 'GET',
            url: '/api/v1/friend-zone/search?q=solana&owner=test_agent_a',
            headers: { authorization: `Bearer ${agentCToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().paging.total).toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════
// Product Funnel Telemetry
// ═══════════════════════════════════════
describe('Product Funnel Telemetry', () => {
    it('should accept anonymous funnel events', async () => {
        const readmeRes = await app.inject({
            method: 'POST',
            url: '/api/v1/product/funnel-events',
            payload: { stage: 'readme_visit', install_id: 'it-install-001', source: 'integration_test' },
        });
        expect(readmeRes.statusCode).toBe(201);

        const installRes = await app.inject({
            method: 'POST',
            url: '/api/v1/product/funnel-events',
            payload: { stage: 'install_complete', install_id: 'it-install-001', source: 'integration_test' },
        });
        expect(installRes.statusCode).toBe(201);
    });
});

// ═══════════════════════════════════════
// Admin Controls
// ═══════════════════════════════════════
describe('Admin Controls', () => {
    it('should promote agent A to admin in test setup', async () => {
        const { pool } = await import('../src/db/pool.js');
        await pool.query('UPDATE agents SET is_admin = TRUE WHERE id = $1', [agentAId]);
    });

    it('admin should ban and unban agent B', async () => {
        const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const banRes = await app.inject({
            method: 'POST',
            url: `/api/v1/admin/agents/${agentBId}/ban`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { reason: 'policy test', until },
        });
        expect(banRes.statusCode).toBe(200);
        expect(banRes.json().agent.is_banned).toBe(true);

        const bannedAccess = await app.inject({
            method: 'GET',
            url: '/api/v1/conversations',
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(bannedAccess.statusCode).toBe(403);

        const unbanRes = await app.inject({
            method: 'POST',
            url: `/api/v1/admin/agents/${agentBId}/unban`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(unbanRes.statusCode).toBe(200);
        expect(unbanRes.json().agent.is_banned).toBe(false);

        const accessBack = await app.inject({
            method: 'GET',
            url: '/api/v1/conversations',
            headers: { authorization: `Bearer ${agentBToken}` },
        });
        expect(accessBack.statusCode).toBe(200);
    });

    it('admin should manage risk whitelist and query audit logs', async () => {
        const add = await app.inject({
            method: 'POST',
            url: '/api/v1/admin/risk-whitelist',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { ip: '127.0.0.1', note: 'local test host' },
        });
        expect(add.statusCode).toBe(201);
        const entryId = add.json().entry.id;

        const list = await app.inject({
            method: 'GET',
            url: '/api/v1/admin/risk-whitelist',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(list.statusCode).toBe(200);
        const found = list.json().entries.find((e: any) => e.id === entryId);
        expect(found).toBeDefined();

        const logs = await app.inject({
            method: 'GET',
            url: '/api/v1/admin/audit-logs?action=admin.whitelist_ip_add',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(logs.statusCode).toBe(200);
        expect(logs.json().logs.length).toBeGreaterThan(0);

        const del = await app.inject({
            method: 'DELETE',
            url: `/api/v1/admin/risk-whitelist/${entryId}`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(del.statusCode).toBe(200);
    });

    it('admin should read funnel summary', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/v1/admin/funnel?since_days=90',
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.since_days).toBe(90);
        expect(Array.isArray(body.stages)).toBe(true);
        const readme = body.stages.find((s: any) => s.stage === 'readme_visit');
        const install = body.stages.find((s: any) => s.stage === 'install_complete');
        const firstMessage = body.stages.find((s: any) => s.stage === 'first_message');
        expect(readme).toBeDefined();
        expect(install).toBeDefined();
        expect(firstMessage).toBeDefined();
        expect(readme.count).toBeGreaterThan(0);
        expect(install.count).toBeGreaterThan(0);
        expect(firstMessage.count).toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════
// Audit Sanitization
// ═══════════════════════════════════════
describe('Audit Sanitization', () => {
    it('should not store message content in audit', async () => {
        const { pool } = await import('../src/db/pool.js');
        const res = await app.inject({
            method: 'POST', url: '/api/v1/conversations/dm',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { peer_agent_id: agentBId },
        });
        const convId = res.json().id;

        await app.inject({
            method: 'POST', url: `/api/v1/conversations/${convId}/messages`,
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { content: 'AUDIT_SECRET_CONTENT', client_msg_id: 'audit-p3-001' },
        });

        const { rows } = await pool.query(
            `SELECT metadata::text FROM audit_logs WHERE action = 'message.send' ORDER BY created_at DESC LIMIT 1`
        );
        expect(rows[0].metadata).not.toContain('AUDIT_SECRET_CONTENT');
    });

    it('should sanitize nested sensitive fields in audit metadata', async () => {
        const { pool } = await import('../src/db/pool.js');
        const { writeAuditLog } = await import('../src/infra/audit.js');

        await writeAuditLog({
            agentId: agentAId,
            action: 'audit.nested_redaction_test',
            resourceType: 'test',
            metadata: {
                keep: 'ok',
                nested: {
                    token: 'nested-token-value',
                    password: 'nested-password',
                    safe: 'safe-value',
                },
                list: [
                    { secret: 'list-secret', note: 'list-safe' },
                ],
            } as any,
        });

        const { rows } = await pool.query(
            `SELECT metadata::text FROM audit_logs WHERE action = 'audit.nested_redaction_test' ORDER BY created_at DESC LIMIT 1`
        );
        const metadataText = rows[0].metadata as string;
        expect(metadataText).not.toContain('nested-token-value');
        expect(metadataText).not.toContain('nested-password');
        expect(metadataText).not.toContain('list-secret');
        expect(metadataText).toContain('safe-value');
    });
});
