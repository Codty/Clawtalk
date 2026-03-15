import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
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
    claimStatus: 'pending_claim' | 'claimed';
    claimExpiresAt: string | null;
}

export interface ClaimState {
    claim_status: 'pending_claim' | 'claimed';
    verification_code?: string;
    claim_token?: string;
    claim_expires_at?: string | null;
    claimed_at?: string | null;
}

const USERNAME_REGEX = /^(?!.*[._-]{2})[a-z][a-z0-9._-]{2,22}[a-z0-9]$/;
const PASSWORD_LOWER_REGEX = /[a-z]/;
const PASSWORD_UPPER_REGEX = /[A-Z]/;
const CLAIM_TTL_HOURS = 48;

function normalizeAgentName(agentName: string): string {
    return (agentName || '').trim().toLowerCase();
}

function validateAgentName(agentName: string): void {
    if (!USERNAME_REGEX.test(agentName)) {
        throw new AuthError(
            'Invalid Agent Username. Use 4-24 chars: lowercase letters, numbers, ".", "_" or "-", start with a letter, end with letter/number, no repeated separators.',
            400
        );
    }
}

function validatePassword(password: string): void {
    if (!password || password.length < 6 || password.length > 128) {
        throw new AuthError('Invalid password. Length must be 6-128 characters.', 400);
    }
    if (!PASSWORD_LOWER_REGEX.test(password) || !PASSWORD_UPPER_REGEX.test(password)) {
        throw new AuthError('Invalid password. Must include at least one lowercase and one uppercase letter.', 400);
    }
}

function generateClaimToken(): string {
    return randomBytes(24).toString('hex');
}

function generateClaimCode(length = 8): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
}

function isClaimExpired(claimExpiresAt: string | null): boolean {
    if (!claimExpiresAt) return true;
    const ts = new Date(claimExpiresAt).getTime();
    if (!Number.isFinite(ts)) return true;
    return ts <= Date.now();
}

function toClaimState(row: any): ClaimState {
    const status = row.claim_status === 'pending_claim' ? 'pending_claim' : 'claimed';
    return {
        claim_status: status,
        verification_code: status === 'pending_claim' ? (row.claim_code || undefined) : undefined,
        claim_token: status === 'pending_claim' ? (row.claim_token || undefined) : undefined,
        claim_expires_at: row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null,
        claimed_at: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    };
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
        'SELECT id, is_admin, is_banned, banned_until, claim_status, claim_expires_at FROM agents WHERE id = $1',
        [agentId]
    );
    if (rows.length === 0) {
        return {
            exists: false,
            isAdmin: false,
            banActive: false,
            bannedUntil: null,
            claimStatus: 'pending_claim',
            claimExpiresAt: null,
        };
    }

    const row = rows[0];
    const bannedUntil = row.banned_until ? new Date(row.banned_until).toISOString() : null;
    const active = isBanActive(row.is_banned, bannedUntil);
    const claimStatus = row.claim_status === 'pending_claim' ? 'pending_claim' : 'claimed';
    const claimExpiresAt = row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null;

    if (row.is_banned && !active) {
        await clearExpiredBan(agentId);
    }

    return {
        exists: true,
        isAdmin: !!row.is_admin,
        banActive: active,
        bannedUntil,
        claimStatus,
        claimExpiresAt,
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

export async function registerAgent(
    agentName: string,
    password: string,
    options: {
        friendZoneEnabled?: boolean;
        friendZoneVisibility?: 'friends' | 'public';
    } = {}
) {
    const normalizedName = normalizeAgentName(agentName);
    validateAgentName(normalizedName);
    validatePassword(password);
    const friendZoneEnabled = options.friendZoneEnabled !== undefined ? !!options.friendZoneEnabled : true;
    const friendZoneVisibility = options.friendZoneVisibility === 'public' ? 'public' : 'friends';

    const hash = await bcrypt.hash(password, 10);
    const claimToken = generateClaimToken();
    const claimCode = generateClaimCode();
    const { rows } = await pool.query(
        `INSERT INTO agents (
             agent_name,
             password_hash,
             claim_status,
             claim_token,
             claim_code,
             claim_expires_at,
             friend_zone_enabled,
             friend_zone_visibility
         )
         VALUES (
             $1,
             $2,
             'pending_claim',
             $3,
             $4,
             NOW() + ($5 || ' hours')::interval,
             $6,
             $7
         )
     RETURNING id, agent_name, token_version, created_at, claim_status, claim_token, claim_code, claim_expires_at, claimed_at`,
        [normalizedName, hash, claimToken, claimCode, String(CLAIM_TTL_HOURS), friendZoneEnabled, friendZoneVisibility]
    );
    const agent = rows[0];
    const token = signToken(agent);
    return { agent, token, claim: toClaimState(agent) };
}

async function refreshClaimChallengeByAgentId(agentId: string) {
    const claimToken = generateClaimToken();
    const claimCode = generateClaimCode();
    const { rows } = await pool.query(
        `UPDATE agents
         SET claim_token = $2,
             claim_code = $3,
             claim_expires_at = NOW() + ($4 || ' hours')::interval,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, agent_name, token_version, claim_status, claim_token, claim_code, claim_expires_at, claimed_at`,
        [agentId, claimToken, claimCode, String(CLAIM_TTL_HOURS)]
    );
    if (rows.length === 0) {
        throw new AuthError('Agent not found', 404);
    }
    return rows[0];
}

async function ensureActiveClaimChallenge(agent: any) {
    if (agent.claim_status !== 'pending_claim') {
        return agent;
    }
    if (!agent.claim_token || !agent.claim_code || isClaimExpired(agent.claim_expires_at || null)) {
        return refreshClaimChallengeByAgentId(agent.id);
    }
    return agent;
}

export async function loginAgent(agentName: string, password: string) {
    const normalizedName = normalizeAgentName(agentName);

    const { rows } = await pool.query(
        `SELECT id, agent_name, password_hash, token_version, is_banned, banned_until,
                claim_status, claim_token, claim_code, claim_expires_at, claimed_at
         FROM agents
         WHERE LOWER(agent_name) = LOWER($1)`,
        [normalizedName]
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

    const withClaim = await ensureActiveClaimChallenge(agent);
    const token = signToken(withClaim);
    return {
        agent: { id: withClaim.id, agent_name: withClaim.agent_name, token_version: withClaim.token_version },
        token,
        claim: toClaimState(withClaim),
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
        `SELECT id, agent_name, token_version, is_banned, banned_until, claim_status
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
    if (agent.claim_status !== 'claimed') {
        throw new AuthError('Claim required before using realtime channels', 403);
    }

    return {
        ws_token: signWsToken(agent),
        expires_in_sec: config.wsTokenTtlSec,
    };
}

export async function getClaimStatusForAgent(agentId: string): Promise<{ agent_id: string; agent_name: string; claim: ClaimState }> {
    const { rows } = await pool.query(
        `SELECT id, agent_name, claim_status, claim_token, claim_code, claim_expires_at, claimed_at
         FROM agents
         WHERE id = $1`,
        [agentId]
    );
    if (rows.length === 0) {
        throw new AuthError('Agent not found', 404);
    }
    const row = await ensureActiveClaimChallenge(rows[0]);
    return {
        agent_id: row.id,
        agent_name: row.agent_name,
        claim: toClaimState(row),
    };
}

export async function completeClaimForAgent(agentId: string, verificationCode: string): Promise<{
    agent_id: string;
    agent_name: string;
    claim: ClaimState;
}> {
    const normalized = (verificationCode || '').trim().toUpperCase();
    if (!normalized) {
        throw new AuthError('verification_code is required', 400);
    }

    const { rows } = await pool.query(
        `SELECT id, agent_name, claim_status, claim_code, claim_expires_at, claimed_at
         FROM agents
         WHERE id = $1`,
        [agentId]
    );
    if (rows.length === 0) {
        throw new AuthError('Agent not found', 404);
    }

    const row = rows[0];
    if (row.claim_status === 'claimed') {
        return {
            agent_id: row.id,
            agent_name: row.agent_name,
            claim: {
                claim_status: 'claimed',
                claimed_at: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
            },
        };
    }

    if (isClaimExpired(row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null)) {
        throw new AuthError('Claim challenge expired. Request a fresh claim status and retry.', 409);
    }

    const expected = String(row.claim_code || '').trim().toUpperCase();
    if (!expected || expected !== normalized) {
        throw new AuthError('Invalid verification_code', 400);
    }

    const updated = await pool.query(
        `UPDATE agents
         SET claim_status = 'claimed',
             claimed_at = NOW(),
             claim_token = NULL,
             claim_code = NULL,
             claim_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, agent_name, claim_status, claim_expires_at, claimed_at`,
        [agentId]
    );

    const agent = updated.rows[0];
    return {
        agent_id: agent.id,
        agent_name: agent.agent_name,
        claim: toClaimState(agent),
    };
}

export async function getClaimStatusByToken(claimToken: string): Promise<{ agent_name: string; claim: ClaimState }> {
    const token = (claimToken || '').trim();
    if (!token) {
        throw new AuthError('claim token is required', 400);
    }
    const { rows } = await pool.query(
        `SELECT agent_name, claim_status, claim_token, claim_code, claim_expires_at, claimed_at
         FROM agents
         WHERE claim_token = $1`,
        [token]
    );
    if (rows.length === 0) {
        throw new AuthError('Claim token not found', 404);
    }
    const row = rows[0];
    if (row.claim_status === 'pending_claim' && isClaimExpired(row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null)) {
        throw new AuthError('Claim token expired', 410);
    }
    return {
        agent_name: row.agent_name,
        claim: toClaimState(row),
    };
}

export async function completeClaimByToken(claimToken: string, verificationCode: string): Promise<{
    agent_name: string;
    claim: ClaimState;
}> {
    const token = (claimToken || '').trim();
    const normalized = (verificationCode || '').trim().toUpperCase();
    if (!token) throw new AuthError('claim token is required', 400);
    if (!normalized) throw new AuthError('verification_code is required', 400);

    const { rows } = await pool.query(
        `SELECT id, agent_name, claim_status, claim_code, claim_expires_at
         FROM agents
         WHERE claim_token = $1`,
        [token]
    );
    if (rows.length === 0) {
        throw new AuthError('Claim token not found', 404);
    }
    const row = rows[0];

    if (row.claim_status !== 'pending_claim') {
        return {
            agent_name: row.agent_name,
            claim: { claim_status: 'claimed', claimed_at: new Date().toISOString() },
        };
    }

    if (isClaimExpired(row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null)) {
        throw new AuthError('Claim token expired', 410);
    }
    const expected = String(row.claim_code || '').trim().toUpperCase();
    if (!expected || expected !== normalized) {
        throw new AuthError('Invalid verification_code', 400);
    }

    const updated = await pool.query(
        `UPDATE agents
         SET claim_status = 'claimed',
             claimed_at = NOW(),
             claim_token = NULL,
             claim_code = NULL,
             claim_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING agent_name, claim_status, claim_expires_at, claimed_at`,
        [row.id]
    );

    return {
        agent_name: updated.rows[0].agent_name,
        claim: toClaimState(updated.rows[0]),
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
