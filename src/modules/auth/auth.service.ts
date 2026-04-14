import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';
import { sendEmail } from '../../infra/email.js';

export interface AgentPayload {
    id: string;
    claw_id?: string;
    agent_name: string;
    token_version: number;
}

export interface TokenPayload {
    sub: string;
    agent_name: string;
    sid?: string;
    owner_email?: string;
    token_version: number;
    token_type?: 'access' | 'ws' | 'owner_access';
    iat?: number;
    exp?: number;
}

export interface OwnerPayload {
    id: string;
    email: string;
    display_name?: string | null;
    token_version: number;
    email_verified_at?: string | null;
}

export interface OwnerAccessSession {
    id: string;
    owner_id: string;
    session_label: string | null;
    issued_via: string;
    channel: string | null;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
    updated_at: string;
    last_seen_at: string | null;
    expires_at: string;
    revoked_at: string | null;
    revoke_reason: string | null;
}

interface OwnerTokenIssueMeta {
    sessionLabel?: string;
    issuedVia: 'register' | 'login' | 'device' | 'rotate' | 'switch';
    channel?: string;
    ip?: string;
    userAgent?: string;
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

export interface OwnerDeviceAuthSessionPublic {
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in_sec: number;
    interval_sec: number;
}

export interface OwnerDeviceAuthStartResult extends OwnerDeviceAuthSessionPublic {
    device_code: string;
}

type OwnerDeviceAuthStatus = 'pending' | 'approved' | 'denied' | 'exchanged' | 'expired';
type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }> };
type ClerkIdentity = {
    subject: string;
    email: string;
};

const USERNAME_REGEX = /^(?!.*[._-]{2})[a-z][a-z0-9._-]{2,22}[a-z0-9]$/;
const PASSWORD_LOWER_REGEX = /[a-z]/;
const PASSWORD_UPPER_REGEX = /[A-Z]/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLAIM_TTL_HOURS = 48;
const OWNER_MAX_AGENTS = 5;
const DEVICE_USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEVICE_USER_CODE_RAW_LENGTH = 8;

function normalizeAgentName(agentName: string): string {
    return (agentName || '').trim().toLowerCase();
}

function normalizeOwnerEmail(email: string): string {
    return (email || '').trim().toLowerCase();
}

function normalizeClawId(clawId: string): string {
    return (clawId || '').trim().toLowerCase();
}

function validateAgentName(agentName: string): void {
    if (!USERNAME_REGEX.test(agentName)) {
        throw new AuthError(
            'Invalid Agent Username. Use 4-24 chars: lowercase letters, numbers, ".", "_" or "-", start with a letter, end with letter/number, no repeated separators.',
            400
        );
    }
}

function validateOwnerEmail(email: string): void {
    if (!EMAIL_REGEX.test(email)) {
        throw new AuthError('Invalid email format', 400);
    }
    if (email.length > 320) {
        throw new AuthError('Invalid email length', 400);
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

function toIsoOrNull(value: any): string | null {
    if (!value) return null;
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts)) return null;
    return new Date(ts).toISOString();
}

function mapOwnerPayload(row: any): OwnerPayload {
    return {
        id: row.id,
        email: row.email,
        display_name: row.display_name ? String(row.display_name) : null,
        token_version: row.token_version,
        email_verified_at: toIsoOrNull(row.email_verified_at),
    };
}

function normalizeOwnerDisplayName(displayName?: string | null): string | null {
    const raw = String(displayName || '').trim();
    if (!raw) return null;
    if (raw.length > 80) {
        throw new AuthError('Owner display name must be 80 characters or fewer.', 400);
    }
    return raw;
}

function assertOwnerEmailVerified(owner: OwnerPayload): void {
    if (!config.ownerRequireEmailVerified) return;
    if (owner.email_verified_at) return;
    throw new AuthError('Email not verified. Please verify your email before logging in.', 403);
}

function buildOwnerVerificationUrl(token: string): string | null {
    const base = (config.publicWebBaseUrl || config.publicBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return null;
    return `${base}/api/v1/auth/owner/verify-email/confirm?token=${encodeURIComponent(token)}`;
}

function buildOwnerPasswordResetUrl(token: string): string | null {
    const base = (config.publicWebBaseUrl || config.publicBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return null;
    return `${base}/api/v1/auth/owner/password/reset?token=${encodeURIComponent(token)}`;
}

function hashDeviceCode(deviceCode: string): string {
    return createHash('sha256').update(deviceCode).digest('hex');
}

function generateDeviceCode(): string {
    return randomBytes(32).toString('base64url');
}

function generateDeviceUserCode(): string {
    const bytes = randomBytes(DEVICE_USER_CODE_RAW_LENGTH);
    let raw = '';
    for (let i = 0; i < DEVICE_USER_CODE_RAW_LENGTH; i += 1) {
        raw += DEVICE_USER_CODE_ALPHABET[bytes[i] % DEVICE_USER_CODE_ALPHABET.length];
    }
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeUserCode(userCode: string): string {
    return (userCode || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/[^A-Z0-9]/g, '')
        .replace(/^(.{4})(.{0,4}).*$/, (_, a: string, b: string) => (b ? `${a}-${b}` : a));
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

function generateManagedAgentPassword(): string {
    // Hidden owner-managed credential for compatibility with legacy agent login.
    return `Aa${randomBytes(24).toString('base64url')}`;
}

function generateManagedOwnerPassword(): string {
    // Hidden owner-managed credential for third-party identity providers.
    return `Aa${randomBytes(24).toString('base64url')}`;
}

function generateOpaqueToken(): string {
    return randomBytes(32).toString('hex');
}

function hashOpaqueToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

let clerkRemoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getClerkJwks() {
    if (!config.clerkJwksUrl) {
        throw new AuthError('CLERK_JWKS_URL is not configured', 500);
    }
    if (!clerkRemoteJwks) {
        clerkRemoteJwks = createRemoteJWKSet(new URL(config.clerkJwksUrl));
    }
    return clerkRemoteJwks;
}

function extractEmailFromClerkPayload(payload: Record<string, unknown>): string {
    const candidates = [
        payload.email,
        payload.email_address,
        payload.primary_email_address,
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && EMAIL_REGEX.test(value.trim().toLowerCase())) {
            return value.trim().toLowerCase();
        }
    }
    throw new AuthError('Clerk token is missing email claim', 400);
}

async function verifyClerkIdentityToken(clerkTokenRaw: string): Promise<ClerkIdentity> {
    if (!config.clerkEnabled) {
        throw new AuthError('Clerk auth is disabled on this deployment', 503);
    }
    if (!config.clerkIssuer) {
        throw new AuthError('CLERK_ISSUER is not configured', 500);
    }

    const clerkToken = (clerkTokenRaw || '').trim();
    if (!clerkToken) {
        throw new AuthError('clerk_token is required', 400);
    }

    try {
        const { payload } = await jwtVerify(clerkToken, getClerkJwks(), {
            issuer: config.clerkIssuer,
            audience: config.clerkAudience || undefined,
        });
        if (!payload.sub) {
            throw new AuthError('Clerk token missing subject', 400);
        }
        const email = extractEmailFromClerkPayload(payload as Record<string, unknown>);
        return {
            subject: String(payload.sub),
            email,
        };
    } catch (err: any) {
        if (err instanceof AuthError) {
            throw err;
        }
        throw new AuthError('Invalid Clerk token', 401);
    }
}

function parseDurationSeconds(value: string | undefined, fallbackSec: number): number {
    const raw = (value || '').trim().toLowerCase();
    if (!raw) return fallbackSec;
    const match = raw.match(/^(\d+)\s*([smhd])?$/);
    if (!match) return fallbackSec;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return fallbackSec;
    const unit = match[2] || 's';
    if (unit === 's') return amount;
    if (unit === 'm') return amount * 60;
    if (unit === 'h') return amount * 3600;
    if (unit === 'd') return amount * 86400;
    return fallbackSec;
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
        ownerId?: string;
        autoClaim?: boolean;
        db?: Queryable;
    } = {}
) {
    const normalizedName = normalizeAgentName(agentName);
    validateAgentName(normalizedName);
    validatePassword(password);
    const friendZoneEnabled = options.friendZoneEnabled !== undefined
        ? !!options.friendZoneEnabled
        : config.friendZoneDefaultEnabled;
    const friendZoneVisibility = options.friendZoneVisibility
        ? (options.friendZoneVisibility === 'public' ? 'public' : 'friends')
        : config.friendZoneDefaultVisibility;
    const ownerId = options.ownerId || null;
    const autoClaim = options.autoClaim === true;
    const db = options.db || pool;

    const hash = await bcrypt.hash(password, 10);
    const claimToken = autoClaim ? null : generateClaimToken();
    const claimCode = autoClaim ? null : generateClaimCode();
    const claimStatus = autoClaim ? 'claimed' : 'pending_claim';
    const { rows } = await db.query(
        `INSERT INTO agents (
             agent_name,
             password_hash,
             claim_status,
             claim_token,
             claim_code,
             claim_expires_at,
             friend_zone_enabled,
             friend_zone_visibility,
             primary_owner_id,
             claimed_at
         )
         VALUES (
             $1,
             $2,
             $3,
             $4,
             $5,
             CASE
               WHEN $6 THEN NULL
               ELSE NOW() + ($7 || ' hours')::interval
             END,
             $8,
             $9,
             $10,
             CASE
               WHEN $6 THEN NOW()
               ELSE NULL
             END
         )
     RETURNING id, claw_id, agent_name, token_version, created_at, claim_status, claim_token, claim_code, claim_expires_at, claimed_at`,
        [
            normalizedName,
            hash,
            claimStatus,
            claimToken,
            claimCode,
            autoClaim,
            String(CLAIM_TTL_HOURS),
            friendZoneEnabled,
            friendZoneVisibility,
            ownerId,
        ]
    );
    const agent = rows[0];

    if (ownerId) {
        await db.query(
            `INSERT INTO owner_agent_bindings (owner_id, agent_id, role)
             VALUES ($1, $2, 'owner')
             ON CONFLICT (owner_id, agent_id) DO NOTHING`,
            [ownerId, agent.id]
        );
    }

    const token = signToken(agent);
    return { agent, token, claim: toClaimState(agent) };
}

function signOwnerToken(owner: OwnerPayload, sessionId: string): string {
    return jwt.sign(
        {
            sub: owner.id,
            agent_name: '',
            sid: sessionId,
            owner_email: owner.email,
            token_version: owner.token_version,
            token_type: 'owner_access',
        },
        config.jwtSecret,
        { expiresIn: config.ownerJwtExpiresIn as any }
    );
}

async function createOwnerAccessSession(
    ownerId: string,
    meta: OwnerTokenIssueMeta,
    db: Queryable = pool
): Promise<{ sessionId: string; expiresAt: string }> {
    const ttlSec = parseDurationSeconds(config.ownerJwtExpiresIn, 2 * 3600);
    const sessionLabel = (meta.sessionLabel || '').trim().slice(0, 256) || null;
    const channel = (meta.channel || '').trim().slice(0, 32) || null;
    const ip = (meta.ip || '').trim().slice(0, 64) || null;
    const userAgent = (meta.userAgent || '').trim().slice(0, 1024) || null;

    const { rows } = await db.query(
        `INSERT INTO owner_access_sessions (
            owner_id,
            session_label,
            issued_via,
            channel,
            ip,
            user_agent,
            last_seen_at,
            expires_at
         ) VALUES (
            $1, $2, $3, $4, $5, $6, NOW(),
            NOW() + ($7 || ' seconds')::interval
         )
         RETURNING id, expires_at`,
        [ownerId, sessionLabel, meta.issuedVia, channel, ip, userAgent, String(ttlSec)]
    );
    return {
        sessionId: rows[0].id,
        expiresAt: new Date(rows[0].expires_at).toISOString(),
    };
}

async function issueOwnerToken(
    owner: OwnerPayload,
    meta: OwnerTokenIssueMeta,
    db: Queryable = pool
): Promise<{ token: string; session_id: string; expires_at: string }> {
    const session = await createOwnerAccessSession(owner.id, meta, db);
    return {
        token: signOwnerToken(owner, session.sessionId),
        session_id: session.sessionId,
        expires_at: session.expiresAt,
    };
}

async function createOwnerAccountRecord(
    email: string,
    password: string,
    displayName?: string | null,
    db: Queryable = pool
): Promise<OwnerPayload> {
    const normalizedEmail = normalizeOwnerEmail(email);
    validateOwnerEmail(normalizedEmail);
    validatePassword(password);
    const normalizedDisplayName = normalizeOwnerDisplayName(displayName);

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
        `INSERT INTO owners (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, token_version, email_verified_at`,
        [normalizedEmail, hash, normalizedDisplayName]
    );
    return mapOwnerPayload(rows[0]);
}

async function authenticateOwnerAccount(
    email: string,
    password: string,
    options: {
        db?: Queryable;
        updateLastLogin?: boolean;
    } = {}
): Promise<OwnerPayload> {
    const db = options.db || pool;
    const normalizedEmail = normalizeOwnerEmail(email);
    validateOwnerEmail(normalizedEmail);

    const { rows } = await db.query(
        `SELECT id, email, display_name, password_hash, token_version, is_disabled, email_verified_at
         FROM owners
         WHERE LOWER(email) = LOWER($1)`,
        [normalizedEmail]
    );
    if (rows.length === 0) {
        throw new AuthError('Invalid owner credentials', 401);
    }

    const owner = rows[0];
    if (owner.is_disabled) {
        throw new AuthError('Owner account disabled', 403);
    }

    const valid = await bcrypt.compare(password, owner.password_hash);
    if (!valid) {
        throw new AuthError('Invalid owner credentials', 401);
    }

    if (options.updateLastLogin !== false) {
        await db.query(
            `UPDATE owners
             SET last_login_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [owner.id]
        );
    }

    return mapOwnerPayload(owner);
}

async function resolveOwnerByClerkIdentity(identity: ClerkIdentity): Promise<OwnerPayload> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const byIdentity = await client.query(
            `SELECT o.id, o.email, o.token_version, o.is_disabled, o.email_verified_at
                    , o.display_name
             FROM owner_identities oi
             JOIN owners o ON o.id = oi.owner_id
             WHERE oi.provider = 'clerk'
               AND oi.provider_subject = $1
             FOR UPDATE`,
            [identity.subject]
        );
        if (byIdentity.rows.length > 0) {
            const row = byIdentity.rows[0];
            if (row.is_disabled) {
                throw new AuthError('Owner account disabled', 403);
            }
            await client.query(
                `UPDATE owners
                 SET last_login_at = NOW(),
                     email_verified_at = COALESCE(email_verified_at, NOW()),
                     updated_at = NOW()
                 WHERE id = $1`,
                [row.id]
            );
            await client.query(
                `UPDATE owner_identities
                 SET provider_email = $3
                 WHERE provider = 'clerk'
                   AND provider_subject = $2
                   AND owner_id = $1`,
                [row.id, identity.subject, identity.email]
            );
            await client.query('COMMIT');
            return mapOwnerPayload({
                ...row,
                email_verified_at: row.email_verified_at || new Date().toISOString(),
            });
        }

        let ownerRow: any;
        const byEmail = await client.query(
            `SELECT id, email, display_name, token_version, is_disabled, email_verified_at
             FROM owners
             WHERE LOWER(email) = LOWER($1)
             FOR UPDATE`,
            [identity.email]
        );
        if (byEmail.rows.length > 0) {
            ownerRow = byEmail.rows[0];
            if (ownerRow.is_disabled) {
                throw new AuthError('Owner account disabled', 403);
            }
            await client.query(
                `UPDATE owners
                 SET last_login_at = NOW(),
                     email_verified_at = COALESCE(email_verified_at, NOW()),
                     updated_at = NOW()
                 WHERE id = $1`,
                [ownerRow.id]
            );
        } else {
            const managedPassword = generateManagedOwnerPassword();
            const hash = await bcrypt.hash(managedPassword, 10);
            const created = await client.query(
                `INSERT INTO owners (email, password_hash, last_login_at, email_verified_at)
                 VALUES ($1, $2, NOW(), NOW())
                 RETURNING id, email, display_name, token_version, is_disabled, email_verified_at`,
                [identity.email, hash]
            );
            ownerRow = created.rows[0];
        }

        await client.query(
            `INSERT INTO owner_identities (owner_id, provider, provider_subject, provider_email)
             VALUES ($1, 'clerk', $2, $3)
             ON CONFLICT (provider, provider_subject)
             DO UPDATE SET provider_email = EXCLUDED.provider_email`,
            [ownerRow.id, identity.subject, identity.email]
        );

        await client.query('COMMIT');
        return mapOwnerPayload({
            ...ownerRow,
            email_verified_at: ownerRow.email_verified_at || new Date().toISOString(),
        });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function registerOwner(
    email: string,
    password: string,
    displayName: string | null = null,
    meta: OwnerTokenIssueMeta = { issuedVia: 'register' }
): Promise<{
    owner: OwnerPayload;
    token: string;
    session_id: string;
    expires_at: string;
    email_verification: {
        already_verified: boolean;
        sent: boolean;
        expires_at?: string;
        verify_url?: string;
        delivery_message: string;
    };
}> {
    const owner = await createOwnerAccountRecord(email, password, displayName, pool);
    const issued = await issueOwnerToken(owner, meta);
    const emailVerification = await requestOwnerEmailVerification(owner.id, {
        requestIp: meta.ip,
        userAgent: meta.userAgent,
    });
    return {
        owner,
        token: issued.token,
        session_id: issued.session_id,
        expires_at: issued.expires_at,
        email_verification: emailVerification,
    };
}

export async function loginOwner(
    email: string,
    password: string,
    meta: OwnerTokenIssueMeta = { issuedVia: 'login' }
): Promise<{ owner: OwnerPayload; token: string; session_id: string; expires_at: string }> {
    const payload = await authenticateOwnerAccount(email, password, {
        db: pool,
        updateLastLogin: true,
    });
    assertOwnerEmailVerified(payload);
    const issued = await issueOwnerToken(payload, meta);
    return {
        owner: payload,
        token: issued.token,
        session_id: issued.session_id,
        expires_at: issued.expires_at,
    };
}

export async function loginOwnerWithClerk(
    clerkToken: string,
    meta: OwnerTokenIssueMeta = { issuedVia: 'login' }
): Promise<{ owner: OwnerPayload; token: string; session_id: string; expires_at: string }> {
    const identity = await verifyClerkIdentityToken(clerkToken);
    const owner = await resolveOwnerByClerkIdentity(identity);
    const issued = await issueOwnerToken(owner, meta);
    return {
        owner,
        token: issued.token,
        session_id: issued.session_id,
        expires_at: issued.expires_at,
    };
}

async function issueOwnerEmailVerificationToken(
    owner: OwnerPayload,
    opts: { db?: Queryable; requestIp?: string; userAgent?: string } = {}
): Promise<{ token: string; expires_at: string }> {
    const db = opts.db || pool;
    const token = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    const requestIp = (opts.requestIp || '').trim().slice(0, 64) || null;
    const userAgent = (opts.userAgent || '').trim().slice(0, 1024) || null;

    const { rows } = await db.query(
        `INSERT INTO owner_email_verification_tokens (
            owner_id, email, token_hash, expires_at, request_ip, user_agent
         ) VALUES (
            $1, $2, $3, NOW() + ($4 || ' seconds')::interval, $5, $6
         )
         RETURNING expires_at`,
        [owner.id, owner.email, tokenHash, String(config.ownerEmailVerifyTtlSec), requestIp, userAgent]
    );
    return {
        token,
        expires_at: new Date(rows[0].expires_at).toISOString(),
    };
}

async function issueOwnerPasswordResetToken(
    owner: OwnerPayload,
    opts: { db?: Queryable; requestIp?: string; userAgent?: string } = {}
): Promise<{ token: string; expires_at: string }> {
    const db = opts.db || pool;
    const token = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    const requestIp = (opts.requestIp || '').trim().slice(0, 64) || null;
    const userAgent = (opts.userAgent || '').trim().slice(0, 1024) || null;

    const { rows } = await db.query(
        `INSERT INTO owner_password_reset_tokens (
            owner_id, email, token_hash, expires_at, request_ip, user_agent
         ) VALUES (
            $1, $2, $3, NOW() + ($4 || ' seconds')::interval, $5, $6
         )
         RETURNING expires_at`,
        [owner.id, owner.email, tokenHash, String(config.ownerPasswordResetTtlSec), requestIp, userAgent]
    );

    return {
        token,
        expires_at: new Date(rows[0].expires_at).toISOString(),
    };
}

function buildVerificationEmail(ownerEmail: string, verifyToken: string) {
    const verifyUrl = buildOwnerVerificationUrl(verifyToken);
    const subject = 'Verify your Clawtalk account email';
    const text = verifyUrl
        ? `Welcome to Clawtalk.\n\nVerify your email by opening this link:\n${verifyUrl}\n\nIf you did not request this, you can ignore this email.`
        : `Welcome to Clawtalk.\n\nYour verification token is:\n${verifyToken}\n\nAsk your agent to complete email verification with this token.`;
    const html = verifyUrl
        ? `<p>Welcome to <strong>Clawtalk</strong>.</p>
           <p>Please verify your email by clicking the link below:</p>
           <p><a href="${verifyUrl}">${verifyUrl}</a></p>
           <p>If you did not request this, you can ignore this email.</p>`
        : `<p>Welcome to <strong>Clawtalk</strong>.</p>
           <p>Your verification token is:</p>
           <pre>${verifyToken}</pre>
           <p>Ask your agent to complete email verification with this token.</p>`;
    return {
        subject,
        text,
        html,
        verify_url: verifyUrl,
    };
}

function buildPasswordResetEmail(ownerEmail: string, resetToken: string) {
    const resetUrl = buildOwnerPasswordResetUrl(resetToken);
    const subject = 'Reset your Clawtalk account password';
    const text = resetUrl
        ? `Reset your Clawtalk password by opening this link:\n${resetUrl}\n\nIf you did not request this, ignore this email.`
        : `Your Clawtalk password reset token is:\n${resetToken}\n\nUse this token to reset your password.`;
    const html = resetUrl
        ? `<p>Reset your Clawtalk password by clicking the link below:</p>
           <p><a href="${resetUrl}">${resetUrl}</a></p>
           <p>If you did not request this, ignore this email.</p>`
        : `<p>Your Clawtalk password reset token is:</p><pre>${resetToken}</pre>`;
    return {
        subject,
        text,
        html,
        reset_url: resetUrl,
    };
}

export async function requestOwnerEmailVerification(
    ownerId: string,
    opts: { requestIp?: string; userAgent?: string } = {}
): Promise<{ already_verified: boolean; sent: boolean; expires_at?: string; verify_url?: string; delivery_message: string; debug_token?: string }> {
    const owner = await getOwnerProfile(ownerId);
    if (owner.email_verified_at) {
        return {
            already_verified: true,
            sent: false,
            delivery_message: 'Email already verified.',
        };
    }

    const issued = await issueOwnerEmailVerificationToken(owner, opts);
    const template = buildVerificationEmail(owner.email, issued.token);
    const delivery = await sendEmail({
        to: owner.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
    });

    return {
        already_verified: false,
        sent: delivery.sent,
        expires_at: issued.expires_at,
        verify_url: template.verify_url || undefined,
        delivery_message: delivery.message,
        ...(config.nodeEnv !== 'production' ? { debug_token: issued.token } : {}),
    };
}

export async function verifyOwnerEmailByToken(tokenRaw: string): Promise<{ owner: OwnerPayload }> {
    const token = (tokenRaw || '').trim();
    if (!token) {
        throw new AuthError('token is required', 400);
    }
    const tokenHash = hashOpaqueToken(token);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const found = await client.query(
            `SELECT t.id, t.owner_id, o.id AS owner_id_ref, o.email, o.display_name, o.token_version, o.email_verified_at
             FROM owner_email_verification_tokens t
             JOIN owners o ON o.id = t.owner_id
             WHERE t.token_hash = $1
               AND t.used_at IS NULL
               AND t.expires_at > NOW()
             FOR UPDATE`,
            [tokenHash]
        );
        if (found.rows.length === 0) {
            throw new AuthError('Invalid or expired verification token', 400);
        }
        const row = found.rows[0];
        const updatedOwner = await client.query(
            `UPDATE owners
             SET email_verified_at = COALESCE(email_verified_at, NOW()),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, email, display_name, token_version, email_verified_at`,
            [row.owner_id]
        );
        await client.query(
            `UPDATE owner_email_verification_tokens
             SET used_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [row.id]
        );
        await client.query('COMMIT');
        return { owner: mapOwnerPayload(updatedOwner.rows[0]) };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function requestOwnerPasswordReset(
    emailRaw: string,
    opts: { requestIp?: string; userAgent?: string } = {}
): Promise<{
    accepted: true;
    sent: boolean;
    reset_url?: string;
    delivery_message: string;
    delivery_attempted: boolean;
    delivery_provider: 'none' | 'resend';
    delivery_provider_message_id?: string;
    debug_token?: string;
}> {
    const email = normalizeOwnerEmail(emailRaw);
    validateOwnerEmail(email);

    const found = await pool.query(
        `SELECT id, email, display_name, token_version, email_verified_at, is_disabled
         FROM owners
         WHERE LOWER(email) = LOWER($1)`,
        [email]
    );
    if (found.rows.length === 0 || found.rows[0].is_disabled) {
        return {
            accepted: true,
            sent: false,
            delivery_message: 'If this email exists, reset instructions were sent.',
            delivery_attempted: false,
            delivery_provider: 'none',
        };
    }

    const owner = mapOwnerPayload(found.rows[0]);
    const issued = await issueOwnerPasswordResetToken(owner, opts);
    const template = buildPasswordResetEmail(owner.email, issued.token);
    const delivery = await sendEmail({
        to: owner.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
    });

    return {
        accepted: true,
        sent: delivery.sent,
        reset_url: template.reset_url || undefined,
        delivery_message: delivery.message,
        delivery_attempted: true,
        delivery_provider: delivery.provider,
        delivery_provider_message_id: delivery.provider_message_id,
        ...(config.nodeEnv !== 'production' ? { debug_token: issued.token } : {}),
    };
}

export async function resetOwnerPasswordByToken(
    tokenRaw: string,
    nextPassword: string
): Promise<{ owner: OwnerPayload }> {
    const token = (tokenRaw || '').trim();
    if (!token) {
        throw new AuthError('token is required', 400);
    }
    validatePassword(nextPassword);
    const tokenHash = hashOpaqueToken(token);
    const passwordHash = await bcrypt.hash(nextPassword, 10);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const found = await client.query(
            `SELECT t.id, t.owner_id
             FROM owner_password_reset_tokens t
             WHERE t.token_hash = $1
               AND t.used_at IS NULL
               AND t.expires_at > NOW()
             FOR UPDATE`,
            [tokenHash]
        );
        if (found.rows.length === 0) {
            throw new AuthError('Invalid or expired reset token', 400);
        }
        const row = found.rows[0];

        const ownerUpdated = await client.query(
            `UPDATE owners
             SET password_hash = $2,
                 token_version = token_version + 1,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, email, display_name, token_version, email_verified_at`,
            [row.owner_id, passwordHash]
        );
        if (ownerUpdated.rows.length === 0) {
            throw new AuthError('Owner not found', 404);
        }

        await client.query(
            `UPDATE owner_password_reset_tokens
             SET used_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [row.id]
        );
        await client.query(
            `UPDATE owner_access_sessions
             SET revoked_at = NOW(),
                 revoke_reason = COALESCE(revoke_reason, 'password_reset'),
                 updated_at = NOW()
             WHERE owner_id = $1
               AND revoked_at IS NULL`,
            [row.owner_id]
        );
        await client.query('COMMIT');
        return { owner: mapOwnerPayload(ownerUpdated.rows[0]) };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function rotateOwnerToken(
    ownerId: string,
    meta: OwnerTokenIssueMeta = { issuedVia: 'rotate' }
): Promise<{ owner: OwnerPayload; token: string; session_id: string; expires_at: string }> {
    const { rows } = await pool.query(
        `UPDATE owners
         SET token_version = token_version + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, email, display_name, token_version, email_verified_at`,
        [ownerId]
    );
    if (rows.length === 0) {
        throw new AuthError('Owner not found', 404);
    }
    const owner = mapOwnerPayload(rows[0]);
    const issued = await issueOwnerToken(owner, meta);
    return {
        owner,
        token: issued.token,
        session_id: issued.session_id,
        expires_at: issued.expires_at,
    };
}

export async function getOwnerProfile(ownerId: string): Promise<OwnerPayload> {
    const { rows } = await pool.query(
        `SELECT id, email, display_name, token_version, email_verified_at
         FROM owners
         WHERE id = $1`,
        [ownerId]
    );
    if (rows.length === 0) {
        throw new AuthError('Owner not found', 404);
    }
    return mapOwnerPayload(rows[0]);
}

export async function updateOwnerProfile(
    ownerId: string,
    updates: { display_name?: string | null }
): Promise<OwnerPayload> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (updates.display_name !== undefined) {
        setClauses.push(`display_name = $${paramIdx++}`);
        params.push(normalizeOwnerDisplayName(updates.display_name));
    }

    if (setClauses.length === 0) {
        return getOwnerProfile(ownerId);
    }

    setClauses.push('updated_at = NOW()');
    params.push(ownerId);

    const { rows } = await pool.query(
        `UPDATE owners
         SET ${setClauses.join(', ')}
         WHERE id = $${paramIdx}
         RETURNING id, email, display_name, token_version, email_verified_at`,
        params
    );
    if (rows.length === 0) {
        throw new AuthError('Owner not found', 404);
    }
    return mapOwnerPayload(rows[0]);
}

function mapOwnerAccessSession(row: any): OwnerAccessSession {
    return {
        id: row.id,
        owner_id: row.owner_id,
        session_label: row.session_label || null,
        issued_via: row.issued_via,
        channel: row.channel || null,
        ip: row.ip || null,
        user_agent: row.user_agent || null,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
        last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
        expires_at: new Date(row.expires_at).toISOString(),
        revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        revoke_reason: row.revoke_reason || null,
    };
}

export async function listOwnerAccessSessions(ownerId: string): Promise<OwnerAccessSession[]> {
    const { rows } = await pool.query(
        `SELECT id, owner_id, session_label, issued_via, channel, ip, user_agent,
                created_at, updated_at, last_seen_at, expires_at, revoked_at, revoke_reason
         FROM owner_access_sessions
         WHERE owner_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [ownerId]
    );
    return rows.map(mapOwnerAccessSession);
}

export async function revokeOwnerAccessSession(ownerId: string, sessionId: string, reason = 'manual_revoke'): Promise<boolean> {
    const normalized = (sessionId || '').trim();
    if (!normalized) {
        throw new AuthError('session_id is required', 400);
    }
    const { rowCount } = await pool.query(
        `UPDATE owner_access_sessions
         SET revoked_at = NOW(),
             revoke_reason = $3,
             updated_at = NOW()
         WHERE id = $1
           AND owner_id = $2
           AND revoked_at IS NULL`,
        [normalized, ownerId, reason.slice(0, 64)]
    );
    return (rowCount || 0) > 0;
}

export async function touchOwnerAccessSession(ownerId: string, sessionId: string): Promise<void> {
    if (!sessionId) return;
    await pool.query(
        `UPDATE owner_access_sessions
         SET last_seen_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND owner_id = $2`,
        [sessionId, ownerId]
    );
}

export async function listOwnerAgents(ownerId: string): Promise<Array<{
    id: string;
    claw_id: string;
    agent_name: string;
    claim_status: 'pending_claim' | 'claimed';
    created_at: string;
    friends_count: number;
}>> {
    const { rows } = await pool.query(
        `SELECT a.id,
                a.claw_id,
                a.agent_name,
                a.claim_status,
                a.created_at,
                (SELECT COUNT(*)::int FROM friendships f WHERE f.agent_id = a.id) AS friends_count
         FROM owner_agent_bindings oab
         JOIN agents a ON a.id = oab.agent_id
         WHERE oab.owner_id = $1
         ORDER BY oab.created_at ASC`,
        [ownerId]
    );
    return rows.map((row) => ({
        id: row.id,
        claw_id: row.claw_id,
        agent_name: row.agent_name,
        claim_status: row.claim_status === 'pending_claim' ? 'pending_claim' : 'claimed',
        created_at: new Date(row.created_at).toISOString(),
        friends_count: row.friends_count ?? 0,
    }));
}

export async function createAgentForOwner(
    ownerId: string,
    agentName: string,
    password?: string,
    options: {
        friendZoneEnabled?: boolean;
        friendZoneVisibility?: 'friends' | 'public';
    } = {}
) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ownerRow = await client.query(
            `SELECT id FROM owners WHERE id = $1 FOR UPDATE`,
            [ownerId]
        );
        if (ownerRow.rows.length === 0) {
            throw new AuthError('Owner not found', 404);
        }

        const quota = await client.query(
            `SELECT COUNT(*)::int AS c
             FROM owner_agent_bindings
             WHERE owner_id = $1`,
            [ownerId]
        );
        if ((quota.rows[0]?.c || 0) >= OWNER_MAX_AGENTS) {
            throw new AuthError(`Owner can manage up to ${OWNER_MAX_AGENTS} agents`, 409);
        }

        const requestedPassword = (password || '').trim();
        if (!config.ownerPasswordlessAgentEnabled && !requestedPassword) {
            throw new AuthError('Owner-managed agent password is required in this deployment.', 400);
        }
        const effectivePassword = requestedPassword || generateManagedAgentPassword();
        const result = await registerAgent(agentName, effectivePassword, {
            ...options,
            ownerId,
            autoClaim: true,
            db: client,
        });
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function bindAgentToOwner(ownerId: string, agentName: string, password: string): Promise<{
    agent: { id: string; claw_id: string; agent_name: string; token_version: number };
    claim: ClaimState;
    token: string;
}> {
    await getOwnerProfile(ownerId);
    const login = await loginAgent(agentName, password);
    const agentId = login.agent.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ownerRow = await client.query(
            `SELECT id FROM owners WHERE id = $1 FOR UPDATE`,
            [ownerId]
        );
        if (ownerRow.rows.length === 0) {
            throw new AuthError('Owner not found', 404);
        }

        const quota = await client.query(
            `SELECT COUNT(*)::int AS c
             FROM owner_agent_bindings
             WHERE owner_id = $1`,
            [ownerId]
        );
        if ((quota.rows[0]?.c || 0) >= OWNER_MAX_AGENTS) {
            const alreadyBound = await client.query(
                `SELECT 1 FROM owner_agent_bindings
                 WHERE owner_id = $1 AND agent_id = $2`,
                [ownerId, agentId]
            );
            if (alreadyBound.rows.length === 0) {
                throw new AuthError(`Owner can manage up to ${OWNER_MAX_AGENTS} agents`, 409);
            }
        }

        const ownerCheck = await client.query(
            'SELECT primary_owner_id FROM agents WHERE id = $1',
            [agentId]
        );
        if (ownerCheck.rows.length === 0) {
            throw new AuthError('Agent not found', 404);
        }
        const primaryOwnerId = ownerCheck.rows[0].primary_owner_id as string | null;
        if (primaryOwnerId && primaryOwnerId !== ownerId) {
            throw new AuthError('This agent is already managed by another owner', 409);
        }

        await client.query(
            `INSERT INTO owner_agent_bindings (owner_id, agent_id, role)
             VALUES ($1, $2, 'owner')
             ON CONFLICT (owner_id, agent_id) DO NOTHING`,
            [ownerId, agentId]
        );

        const claimed = await client.query(
            `UPDATE agents
             SET primary_owner_id = COALESCE(primary_owner_id, $2),
                 claim_status = 'claimed',
                 claimed_at = COALESCE(claimed_at, NOW()),
                 claim_token = NULL,
                 claim_code = NULL,
                 claim_expires_at = NULL,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, claw_id, agent_name, token_version, claim_status, claim_expires_at, claimed_at`,
            [agentId, ownerId]
        );
        const updated = claimed.rows[0];
        await client.query('COMMIT');

        return {
            agent: {
                id: updated.id,
                claw_id: updated.claw_id,
                agent_name: updated.agent_name,
                token_version: updated.token_version,
            },
            claim: toClaimState(updated),
            token: signToken(updated),
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function switchOwnerAgent(ownerId: string, params: {
    claw_id?: string;
    agent_name?: string;
}): Promise<{
    agent: { id: string; claw_id: string; agent_name: string; token_version: number };
    token: string;
    claim: ClaimState;
}> {
    const clawId = params.claw_id ? normalizeClawId(params.claw_id) : '';
    const agentName = params.agent_name ? normalizeAgentName(params.agent_name) : '';
    if (!clawId && !agentName) {
        throw new AuthError('claw_id or agent_name is required', 400);
    }

    const values: any[] = [ownerId];
    let where = '';
    if (clawId) {
        values.push(clawId);
        where = `a.claw_id = $${values.length}`;
    } else {
        values.push(agentName);
        where = `LOWER(a.agent_name) = LOWER($${values.length})`;
    }

    const { rows } = await pool.query(
        `SELECT a.id, a.claw_id, a.agent_name, a.token_version, a.claim_status, a.claim_expires_at, a.claimed_at
         FROM owner_agent_bindings oab
         JOIN agents a ON a.id = oab.agent_id
         WHERE oab.owner_id = $1
           AND ${where}
         LIMIT 1`,
        values
    );
    if (rows.length === 0) {
        throw new AuthError('Agent not found under this owner', 404);
    }
    const agent = rows[0];
    return {
        agent: {
            id: agent.id,
            claw_id: agent.claw_id,
            agent_name: agent.agent_name,
            token_version: agent.token_version,
        },
        token: signToken(agent),
        claim: toClaimState(agent),
    };
}

function buildOwnerDeviceAuthPublic(
    verificationBaseUrl: string,
    userCode: string,
    expiresInSec: number,
    intervalSec: number
): OwnerDeviceAuthSessionPublic {
    const base = verificationBaseUrl.replace(/\/+$/, '');
    const verificationUri = `${base}/api/v1/auth/device`;
    return {
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
        expires_in_sec: expiresInSec,
        interval_sec: intervalSec,
    };
}

export async function startOwnerDeviceAuth(params: {
    verificationBaseUrl: string;
    clientName?: string;
    deviceLabel?: string;
    scopes?: string[];
}): Promise<OwnerDeviceAuthStartResult> {
    const verificationBaseUrl = (params.verificationBaseUrl || '').trim();
    if (!verificationBaseUrl) {
        throw new AuthError('verification base URL is required', 500);
    }

    const ttlSec = Math.max(60, config.ownerDeviceAuthTtlSec);
    const intervalSec = Math.min(60, Math.max(1, config.ownerDeviceAuthPollIntervalSec));
    const clientName = (params.clientName || 'openclaw-cli').trim().slice(0, 128) || 'openclaw-cli';
    const deviceLabel = (params.deviceLabel || '').trim().slice(0, 256) || null;
    const scopes = Array.isArray(params.scopes) ? params.scopes.slice(0, 16) : ['owner:auth'];

    for (let attempt = 0; attempt < 6; attempt += 1) {
        const deviceCode = generateDeviceCode();
        const userCode = generateDeviceUserCode();
        const deviceCodeHash = hashDeviceCode(deviceCode);

        try {
            await pool.query(
                `INSERT INTO owner_device_auth_sessions (
                    device_code_hash,
                    user_code,
                    status,
                    client_name,
                    device_label,
                    requested_scopes,
                    interval_sec,
                    expires_at
                ) VALUES (
                    $1,
                    $2,
                    'pending',
                    $3,
                    $4,
                    $5::jsonb,
                    $6,
                    NOW() + ($7 || ' seconds')::interval
                )`,
                [
                    deviceCodeHash,
                    userCode,
                    clientName,
                    deviceLabel,
                    JSON.stringify(scopes),
                    intervalSec,
                    String(ttlSec),
                ]
            );

            return {
                device_code: deviceCode,
                ...buildOwnerDeviceAuthPublic(verificationBaseUrl, userCode, ttlSec, intervalSec),
            };
        } catch (err: any) {
            if (err?.code === '23505') {
                continue;
            }
            throw err;
        }
    }

    throw new AuthError('Failed to create device authorization session. Please retry.', 503);
}

async function updateOwnerDeviceSessionStatus(
    client: any,
    sessionId: string,
    status: OwnerDeviceAuthStatus,
    fields: Partial<{
        owner_id: string | null;
        approved_at: boolean;
        denied_at: boolean;
        exchanged_at: boolean;
    }> = {}
): Promise<void> {
    const updates: string[] = ['status = $2', 'updated_at = NOW()'];
    const values: any[] = [sessionId, status];
    let idx = 3;
    if (fields.owner_id !== undefined) {
        updates.push(`owner_id = $${idx}`);
        values.push(fields.owner_id);
        idx += 1;
    }
    if (fields.approved_at) updates.push('approved_at = NOW()');
    if (fields.denied_at) updates.push('denied_at = NOW()');
    if (fields.exchanged_at) updates.push('exchanged_at = NOW()');
    await client.query(
        `UPDATE owner_device_auth_sessions
         SET ${updates.join(', ')}
         WHERE id = $1`,
        values
    );
}

export async function authorizeOwnerDeviceAuth(params: {
    userCode: string;
    email: string;
    password: string;
    displayName?: string | null;
    mode: 'login' | 'register';
}): Promise<{ owner: OwnerPayload }> {
    const userCode = normalizeUserCode(params.userCode);
    if (!userCode || userCode.length < 9) {
        throw new AuthError('Invalid user code', 400);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, status, expires_at
             FROM owner_device_auth_sessions
             WHERE user_code = $1
             FOR UPDATE`,
            [userCode]
        );
        if (rows.length === 0) {
            throw new AuthError('User code not found', 404);
        }

        const session = rows[0];
        if (session.status === 'denied') throw new AuthError('This request was denied. Start again from your device.', 409);
        if (session.status === 'exchanged') throw new AuthError('This request is already completed. Start again from your device.', 409);
        if (session.status === 'approved') throw new AuthError('This request is already approved. Return to your device.', 409);
        if (session.status === 'expired') throw new AuthError('This request has expired. Start again from your device.', 410);

        const expired = new Date(session.expires_at).getTime() <= Date.now();
        if (expired) {
            await updateOwnerDeviceSessionStatus(client, session.id, 'expired');
            throw new AuthError('This request has expired. Start again from your device.', 410);
        }

        let owner: OwnerPayload;
        if (params.mode === 'register') {
            try {
                owner = await createOwnerAccountRecord(params.email, params.password, params.displayName, client);
            } catch (err: any) {
                if (err?.code === '23505') {
                    throw new AuthError('This email is already registered. Please use login.', 409);
                }
                throw err;
            }
        } else {
            owner = await authenticateOwnerAccount(params.email, params.password, {
                db: client,
                updateLastLogin: true,
            });
            assertOwnerEmailVerified(owner);
        }

        await updateOwnerDeviceSessionStatus(client, session.id, 'approved', {
            owner_id: owner.id,
            approved_at: true,
        });
        await client.query('COMMIT');
        return { owner };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function authorizeOwnerDeviceAuthWithClerk(params: {
    userCode: string;
    clerkToken: string;
}): Promise<{ owner: OwnerPayload }> {
    const userCode = normalizeUserCode(params.userCode);
    if (!userCode || userCode.length < 9) {
        throw new AuthError('Invalid user code', 400);
    }

    const identity = await verifyClerkIdentityToken(params.clerkToken);
    const owner = await resolveOwnerByClerkIdentity(identity);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, status, expires_at
             FROM owner_device_auth_sessions
             WHERE user_code = $1
             FOR UPDATE`,
            [userCode]
        );
        if (rows.length === 0) {
            throw new AuthError('User code not found', 404);
        }

        const session = rows[0];
        if (session.status === 'denied') throw new AuthError('This request was denied. Start again from your device.', 409);
        if (session.status === 'exchanged') throw new AuthError('This request is already completed. Start again from your device.', 409);
        if (session.status === 'approved') throw new AuthError('This request is already approved. Return to your device.', 409);
        if (session.status === 'expired') throw new AuthError('This request has expired. Start again from your device.', 410);

        const expired = new Date(session.expires_at).getTime() <= Date.now();
        if (expired) {
            await updateOwnerDeviceSessionStatus(client, session.id, 'expired');
            throw new AuthError('This request has expired. Start again from your device.', 410);
        }

        await updateOwnerDeviceSessionStatus(client, session.id, 'approved', {
            owner_id: owner.id,
            approved_at: true,
        });
        await client.query('COMMIT');
        return { owner };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function denyOwnerDeviceAuth(userCodeRaw: string): Promise<void> {
    const userCode = normalizeUserCode(userCodeRaw);
    if (!userCode) {
        throw new AuthError('Invalid user code', 400);
    }
    const { rowCount } = await pool.query(
        `UPDATE owner_device_auth_sessions
         SET status = 'denied',
             denied_at = NOW(),
             updated_at = NOW()
         WHERE user_code = $1
           AND status = 'pending'`,
        [userCode]
    );
    if (!rowCount) {
        throw new AuthError('User code not found or already handled', 404);
    }
}

export async function exchangeOwnerDeviceAuthToken(deviceCodeRaw: string): Promise<{
    owner: OwnerPayload;
    token: string;
    session_id: string;
    expires_at: string;
}> {
    const deviceCode = (deviceCodeRaw || '').trim();
    if (!deviceCode) {
        throw new AuthError('device_code is required', 400);
    }
    const deviceCodeHash = hashDeviceCode(deviceCode);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            `SELECT id, status, owner_id, client_name, device_label, interval_sec, last_polled_at, poll_count, expires_at
             FROM owner_device_auth_sessions
             WHERE device_code_hash = $1
             FOR UPDATE`,
            [deviceCodeHash]
        );
        if (rows.length === 0) {
            throw new AuthError('Invalid device_code', 404);
        }
        const session = rows[0];

        const expired = new Date(session.expires_at).getTime() <= Date.now();
        if (expired && session.status !== 'exchanged') {
            await updateOwnerDeviceSessionStatus(client, session.id, 'expired');
            throw new AuthError('expired_token', 410);
        }

        if (session.status === 'pending') {
            const nowMs = Date.now();
            const lastPolledMs = session.last_polled_at ? new Date(session.last_polled_at).getTime() : 0;
            const waitMs = Math.max(0, (Number(session.interval_sec) || 5) * 1000 - (nowMs - lastPolledMs));
            if (waitMs > 0) {
                throw new AuthError(`slow_down:${Math.ceil(waitMs / 1000)}`, 429);
            }

            await client.query(
                `UPDATE owner_device_auth_sessions
                 SET poll_count = poll_count + 1,
                     last_polled_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $1`,
                [session.id]
            );
            throw new AuthError('authorization_pending', 428);
        }

        if (session.status === 'denied') throw new AuthError('access_denied', 403);
        if (session.status === 'expired') throw new AuthError('expired_token', 410);
        if (session.status === 'exchanged') throw new AuthError('already_used', 409);
        if (session.status !== 'approved') throw new AuthError('Invalid authorization status', 409);
        if (!session.owner_id) throw new AuthError('Owner is not attached to this device request', 409);

        const owner = await getOwnerProfile(session.owner_id);
        assertOwnerEmailVerified(owner);
        const issued = await issueOwnerToken(owner, {
            issuedVia: 'device',
            sessionLabel: session.device_label || session.client_name || 'owner-device-connect',
            channel: 'device_connect',
        }, client);
        await updateOwnerDeviceSessionStatus(client, session.id, 'exchanged', { exchanged_at: true });
        await client.query('COMMIT');
        return {
            owner,
            token: issued.token,
            session_id: issued.session_id,
            expires_at: issued.expires_at,
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function getOwnerDeviceAuthSessionByUserCode(userCodeRaw: string): Promise<{
    status: OwnerDeviceAuthStatus;
    expires_at: string;
}> {
    const userCode = normalizeUserCode(userCodeRaw);
    if (!userCode) {
        throw new AuthError('Invalid user code', 400);
    }
    const { rows } = await pool.query(
        `SELECT status, expires_at
         FROM owner_device_auth_sessions
         WHERE user_code = $1`,
        [userCode]
    );
    if (rows.length === 0) {
        throw new AuthError('User code not found', 404);
    }
    return {
        status: rows[0].status as OwnerDeviceAuthStatus,
        expires_at: new Date(rows[0].expires_at).toISOString(),
    };
}

export async function expireStaleOwnerDeviceAuthSessions(limit = 2000): Promise<number> {
    const { rowCount } = await pool.query(
        `WITH target AS (
            SELECT id
            FROM owner_device_auth_sessions
            WHERE status IN ('pending', 'approved')
              AND expires_at <= NOW()
            ORDER BY expires_at ASC
            LIMIT $1
         )
         UPDATE owner_device_auth_sessions s
         SET status = 'expired',
             updated_at = NOW()
         FROM target
         WHERE s.id = target.id`,
        [Math.max(1, limit)]
    );
    return rowCount || 0;
}

export async function expireStaleOwnerAccessSessions(limit = 5000): Promise<number> {
    const { rowCount } = await pool.query(
        `WITH target AS (
            SELECT id
            FROM owner_access_sessions
            WHERE revoked_at IS NULL
              AND expires_at <= NOW()
            ORDER BY expires_at ASC
            LIMIT $1
         )
         UPDATE owner_access_sessions s
         SET revoked_at = NOW(),
             revoke_reason = COALESCE(revoke_reason, 'expired'),
             updated_at = NOW()
         FROM target
         WHERE s.id = target.id`,
        [Math.max(1, limit)]
    );
    return rowCount || 0;
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
        `SELECT id, claw_id, agent_name, password_hash, token_version, is_banned, banned_until,
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
        agent: { id: withClaim.id, claw_id: withClaim.claw_id, agent_name: withClaim.agent_name, token_version: withClaim.token_version },
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

export function tryVerifyToken(token: string): TokenPayload | null {
    try {
        return verifyToken(token);
    } catch {
        return null;
    }
}

export async function validateTokenVersion(payload: TokenPayload): Promise<boolean> {
    if (!payload.sub || !Number.isFinite(payload.token_version)) return false;
    const { rows } = await pool.query(
        'SELECT token_version FROM agents WHERE id = $1',
        [payload.sub]
    );
    if (rows.length === 0) return false;
    return rows[0].token_version === payload.token_version;
}

export async function validateOwnerTokenVersion(payload: TokenPayload): Promise<boolean> {
    if (!payload.sub || !Number.isFinite(payload.token_version)) return false;
    if (payload.token_type !== 'owner_access') return false;
    const { rows } = await pool.query(
        'SELECT token_version, is_disabled FROM owners WHERE id = $1',
        [payload.sub]
    );
    if (rows.length === 0) return false;
    if (rows[0].is_disabled) return false;
    if (rows[0].token_version !== payload.token_version) return false;

    const sid = (payload.sid || '').trim();
    if (!sid) {
        return !config.ownerSessionSidRequired;
    }

    const session = await pool.query(
        `SELECT id
         FROM owner_access_sessions
         WHERE id = $1
           AND owner_id = $2
           AND revoked_at IS NULL
           AND expires_at > NOW()`,
        [sid, payload.sub]
    );
    if (session.rows.length === 0) {
        return false;
    }

    await touchOwnerAccessSession(payload.sub, sid);
    return true;
}

export class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number = 401) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AuthError';
    }
}
