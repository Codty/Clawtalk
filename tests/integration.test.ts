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
    app = await buildApp();
    const { pool } = await import('../src/db/pool.js');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;');
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
});

afterAll(async () => {
    await app.close();
});

// ═══════════════════════════════════════
// Auth
// ═══════════════════════════════════════
describe('Auth', () => {
    let wsTokenForA: string;
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

    beforeAll(async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/conversations/dm',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { peer_agent_id: agentBId },
        });
        dmConvId = res.json().id;
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

    it('should mark message as read and expose read_count', async () => {
        const mark = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${dmConvId}/messages/read`,
            headers: { authorization: `Bearer ${agentBToken}` },
            payload: { message_ids: [mediaMessageId] },
        });
        expect(mark.statusCode).toBe(200);
        expect(mark.json().read_count).toBe(1);

        const res = await app.inject({
            method: 'GET',
            url: `/api/v1/conversations/${dmConvId}/messages?limit=20`,
            headers: { authorization: `Bearer ${agentAToken}` },
        });
        const mediaMsg = res.json().messages.find((m: any) => m.id === mediaMessageId);
        expect(mediaMsg.read_count).toBeGreaterThanOrEqual(1);
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

    beforeAll(async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/conversations/group',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { name: 'Policy Test', member_ids: [agentBId] },
        });
        groupId = res.json().id;
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
                capabilities: ['search', 'code'],
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().display_name).toBe('Alice Agent');
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

    it('should become friends', async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/friends',
            headers: { authorization: `Bearer ${agentAToken}` },
            payload: { friend_id: agentBId },
        });
        expect(res.statusCode).toBe(200);
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
