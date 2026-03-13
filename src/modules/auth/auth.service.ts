import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';

export interface AgentPayload {
    id: string;
    agent_name: string;
    token_version: number;
}

export interface TokenPayload {
    sub: string;
    agent_name: string;
    token_version: number;
    token_type?: 'access' | 'ws';
    iat?: number;
    exp?: number;
}

export interface AgentAccessState {
    exists: boolean;
    isAdmin: boolean;
    banActive: boolean;
    bannedUntil: string | null;
}

function isBanActive(isBanned: boolean, bannedUntil: string | null): boolean {
    if (!isBanned) return false;
    if (!bannedUntil) return true;
    return new Date(bannedUntil).getTime() > Date.now();
}

async function clearExpiredBan(agentId: string): Promise<void> {
    await pool.query(
        `UPDATE agents
         SET is_banned = FALSE,
             banned_reason = NULL,
             banned_at = NULL,
             banned_until = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [agentId]
    );
}

export async function getAgentAccessState(agentId: string): Promise<AgentAccessState> {
    const { rows } = await pool.query(
        'SELECT id, is_admin, is_banned, banned_until FROM agents WHERE id = $1',
        [agentId]
    );
    if (rows.length === 0) {
        return { exists: false, isAdmin: false, banActive: false, bannedUntil: null };
    }

    const row = rows[0];
    const bannedUntil = row.banned_until ? new Date(row.banned_until).toISOString() : null;
    const active = isBanActive(row.is_banned, bannedUntil);

    if (row.is_banned && !active) {
        await clearExpiredBan(agentId);
    }

    return {
        exists: true,
        isAdmin: !!row.is_admin,
        banActive: active,
        bannedUntil,
    };
}

async function isRiskWhitelistedIp(ip: string): Promise<boolean> {
    try {
        const { rowCount } = await pool.query('SELECT 1 FROM risk_whitelist WHERE ip = $1', [ip]);
        return (rowCount || 0) > 0;
    } catch (err: any) {
        if (err?.code === '42P01') {
            // Table not created yet in old environments.
            return false;
        }
        throw err;
    }
}

export async function registerAgent(agentName: string, password: string) {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
        `INSERT INTO agents (agent_name, password_hash)
     VALUES ($1, $2)
     RETURNING id, agent_name, token_version, created_at`,
        [agentName, hash]
    );
    const agent = rows[0];
    const token = signToken(agent);
    return { agent, token };
}

export async function loginAgent(agentName: string, password: string) {
    const { rows } = await pool.query(
        `SELECT id, agent_name, password_hash, token_version, is_banned, banned_until
         FROM agents
         WHERE agent_name = $1`,
        [agentName]
    );
    if (rows.length === 0) {
        throw new AuthError('Invalid credentials', 401);
    }

    const agent = rows[0];
    const bannedUntil = agent.banned_until ? new Date(agent.banned_until).toISOString() : null;
    if (isBanActive(agent.is_banned, bannedUntil)) {
        throw new AuthError('Agent is banned', 403);
    }
    if (agent.is_banned) {
        await clearExpiredBan(agent.id);
    }

    const valid = await bcrypt.compare(password, agent.password_hash);
    if (!valid) {
        throw new AuthError('Invalid credentials', 401);
    }

    const token = signToken(agent);
    return {
        agent: { id: agent.id, agent_name: agent.agent_name, token_version: agent.token_version },
        token,
    };
}

export async function rotateToken(agentId: string) {
    const { rows } = await pool.query(
        `UPDATE agents SET token_version = token_version + 1, updated_at = NOW()
     WHERE id = $1
     RETURNING id, agent_name, token_version`,
        [agentId]
    );
    if (rows.length === 0) {
        throw new AuthError('Agent not found', 404);
    }
    const agent = rows[0];
    const token = signToken(agent);

    // Publish token rotation event to force-disconnect WS connections
    await redis.publish('agent:token_rotated', agentId);

    return { agent, token };
}

export function signToken(agent: { id: string; agent_name: string; token_version: number }): string {
    return jwt.sign(
        { sub: agent.id, agent_name: agent.agent_name, token_version: agent.token_version, token_type: 'access' },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn as any }
    );
}

export function signWsToken(agent: { id: string; agent_name: string; token_version: number }): string {
    return jwt.sign(
        { sub: agent.id, agent_name: agent.agent_name, token_version: agent.token_version, token_type: 'ws' },
        config.jwtSecret,
        { expiresIn: `${config.wsTokenTtlSec}s`, issuer: config.wsTokenIssuer }
    );
}

export async function createWsToken(agentId: string) {
    const { rows } = await pool.query(
        `SELECT id, agent_name, token_version, is_banned, banned_until
         FROM agents
         WHERE id = $1`,
        [agentId]
    );
    if (rows.length === 0) {
        throw new AuthError('Agent not found', 404);
    }

    const agent = rows[0];
    const bannedUntil = agent.banned_until ? new Date(agent.banned_until).toISOString() : null;
    if (isBanActive(agent.is_banned, bannedUntil)) {
        throw new AuthError('Agent is banned', 403);
    }
    if (agent.is_banned) {
        await clearExpiredBan(agent.id);
    }

    return {
        ws_token: signWsToken(agent),
        expires_in_sec: config.wsTokenTtlSec,
    };
}

function keyPart(value: string): string {
    return encodeURIComponent(value.toLowerCase().trim());
}

function getLoginProtectionKeys(agentName: string, ip: string) {
    const combo = `${keyPart(agentName)}:${keyPart(ip)}`;
    const ipOnly = keyPart(ip);
    return {
        failCombo: `auth:login:fail:combo:${combo}`,
        failIp: `auth:login:fail:ip:${ipOnly}`,
        blockCombo: `auth:login:block:combo:${combo}`,
        blockIp: `auth:login:block:ip:${ipOnly}`,
    };
}

export async function getLoginBlockStatus(agentName: string, ip: string): Promise<{
    blocked: boolean;
    retryAfterSec: number;
}> {
    if (await isRiskWhitelistedIp(ip)) {
        return { blocked: false, retryAfterSec: 0 };
    }
    const keys = getLoginProtectionKeys(agentName, ip);
    const [comboTtlRaw, ipTtlRaw] = await Promise.all([
        redis.ttl(keys.blockCombo),
        redis.ttl(keys.blockIp),
    ]);
    const comboTtl = comboTtlRaw > 0 ? comboTtlRaw : 0;
    const ipTtl = ipTtlRaw > 0 ? ipTtlRaw : 0;
    const retryAfterSec = Math.max(comboTtl, ipTtl);
    return { blocked: retryAfterSec > 0, retryAfterSec };
}

export async function recordFailedLogin(agentName: string, ip: string): Promise<{
    blocked: boolean;
    retryAfterSec: number;
}> {
    if (await isRiskWhitelistedIp(ip)) {
        return { blocked: false, retryAfterSec: 0 };
    }
    const keys = getLoginProtectionKeys(agentName, ip);
    const [comboCount, ipCount] = await Promise.all([
        redis.incr(keys.failCombo),
        redis.incr(keys.failIp),
    ]);

    if (comboCount === 1) await redis.expire(keys.failCombo, config.authFailWindowSec);
    if (ipCount === 1) await redis.expire(keys.failIp, config.authFailWindowSec);

    const shouldBlockCombo = comboCount >= config.authFailMaxCombo;
    const shouldBlockIp = ipCount >= config.authFailMaxIp;

    if (shouldBlockCombo) {
        await redis.set(keys.blockCombo, '1', 'EX', config.authLockSec);
    }
    if (shouldBlockIp) {
        await redis.set(keys.blockIp, '1', 'EX', config.authLockSec);
    }

    if (shouldBlockCombo || shouldBlockIp) {
        return { blocked: true, retryAfterSec: config.authLockSec };
    }

    return getLoginBlockStatus(agentName, ip);
}

export async function clearLoginFailures(agentName: string, ip: string): Promise<void> {
    const keys = getLoginProtectionKeys(agentName, ip);
    // Keep IP-level counters so broad abuse protections are not reset by one successful login.
    await redis.del(keys.failCombo, keys.blockCombo);
}

export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
}

export async function validateTokenVersion(payload: TokenPayload): Promise<boolean> {
    const { rows } = await pool.query(
        'SELECT token_version FROM agents WHERE id = $1',
        [payload.sub]
    );
    if (rows.length === 0) return false;
    return rows[0].token_version === payload.token_version;
}

export class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number = 401) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AuthError';
    }
}
