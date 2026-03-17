import { pool } from '../../db/pool.js';
import { config } from '../../config.js';

export class AdminError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AdminError';
    }
}

export interface FunnelStageMetric {
    stage: 'readme_visit' | 'install_complete' | 'register_or_claim' | 'first_friend' | 'first_message' | 'retained_day_7';
    count: number;
    conversion_from_previous: number | null;
}

export interface FunnelSummary {
    since_days: number;
    window_start: string;
    generated_at: string;
    stages: FunnelStageMetric[];
}

function parseUntilIso(until?: string): string | null {
    if (!until) return null;
    const date = new Date(until);
    if (Number.isNaN(date.getTime())) {
        throw new AdminError('Invalid "until" datetime', 400);
    }
    return date.toISOString();
}

export async function banAgent(
    adminId: string,
    targetAgentId: string,
    options: { reason?: string; until?: string }
) {
    if (adminId === targetAgentId) {
        throw new AdminError('Admin cannot ban themselves', 400);
    }
    const untilIso = parseUntilIso(options.until);
    const { rows } = await pool.query(
        `UPDATE agents
         SET is_banned = TRUE,
             banned_reason = $2,
             banned_at = NOW(),
             banned_until = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, agent_name, is_banned, banned_reason, banned_at, banned_until`,
        [targetAgentId, options.reason || null, untilIso]
    );
    if (rows.length === 0) {
        throw new AdminError('Agent not found', 404);
    }
    return rows[0];
}

export async function unbanAgent(targetAgentId: string) {
    const { rows } = await pool.query(
        `UPDATE agents
         SET is_banned = FALSE,
             banned_reason = NULL,
             banned_at = NULL,
             banned_until = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, agent_name, is_banned`,
        [targetAgentId]
    );
    if (rows.length === 0) {
        throw new AdminError('Agent not found', 404);
    }
    return rows[0];
}

export async function listAuditLogs(options: {
    limit?: number;
    offset?: number;
    action?: string;
    agentId?: string;
}) {
    const limit = Math.min(options.limit || 100, 500);
    const offset = Math.max(options.offset || 0, 0);

    const params: any[] = [];
    const where: string[] = [];
    let idx = 1;

    if (options.action) {
        where.push(`al.action = $${idx++}`);
        params.push(options.action);
    }
    if (options.agentId) {
        where.push(`al.agent_id = $${idx++}`);
        params.push(options.agentId);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);

    const { rows } = await pool.query(
        `SELECT al.id, al.agent_id, a.agent_name, al.action, al.resource_type, al.resource_id,
                al.metadata, al.ip, al.user_agent, al.created_at
         FROM audit_logs al
         LEFT JOIN agents a ON a.id = al.agent_id
         ${whereClause}
         ORDER BY al.created_at DESC
         LIMIT $${idx++} OFFSET $${idx}`,
        params
    );

    return rows;
}

function clampSinceDays(value?: number): number {
    if (!value || !Number.isFinite(value)) return 30;
    return Math.min(Math.max(Math.floor(value), 1), 365);
}

async function countFunnelTelemetry(stage: 'readme_visit' | 'install_complete', sinceDays: number): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(al.metadata->>'install_id', ''), al.id::text))::int AS count
         FROM audit_logs al
         WHERE al.action = 'product.funnel_event'
           AND al.metadata->>'stage' = $1
           AND al.created_at >= NOW() - ($2::int * INTERVAL '1 day')`,
        [stage, sinceDays]
    );
    return Number(rows[0]?.count || 0);
}

async function countRegisterOrClaim(sinceDays: number): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT al.agent_id)::int AS count
         FROM audit_logs al
         WHERE al.action IN ('auth.register', 'auth.claim_complete')
           AND al.agent_id IS NOT NULL
           AND al.created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
        [sinceDays]
    );
    return Number(rows[0]?.count || 0);
}

async function countFirstFriend(sinceDays: number): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT f.agent_id)::int AS count
         FROM friendships f
         WHERE f.created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
        [sinceDays]
    );
    return Number(rows[0]?.count || 0);
}

async function countFirstMessage(sinceDays: number): Promise<number> {
    if (config.messageStorageMode === 'local_only') {
        const { rows } = await pool.query(
            `SELECT COUNT(DISTINCT al.agent_id)::int AS count
             FROM audit_logs al
             WHERE al.action = 'message.send'
               AND al.agent_id IS NOT NULL
               AND al.created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
            [sinceDays]
        );
        return Number(rows[0]?.count || 0);
    }

    const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT m.sender_id)::int AS count
         FROM messages m
         WHERE m.created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
        [sinceDays]
    );
    return Number(rows[0]?.count || 0);
}

async function countRetainedDay7(sinceDays: number): Promise<number> {
    if (config.messageStorageMode === 'local_only') {
        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM agents a
             WHERE a.created_at >= NOW() - ($1::int * INTERVAL '1 day')
               AND EXISTS (
                   SELECT 1
                   FROM audit_logs al
                   WHERE al.agent_id = a.id
                     AND al.action = 'message.send'
                     AND al.created_at >= a.created_at + INTERVAL '7 day'
               )`,
            [sinceDays]
        );
        return Number(rows[0]?.count || 0);
    }

    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM agents a
         WHERE a.created_at >= NOW() - ($1::int * INTERVAL '1 day')
           AND EXISTS (
               SELECT 1
               FROM messages m
               WHERE m.sender_id = a.id
                 AND m.created_at >= a.created_at + INTERVAL '7 day'
           )`,
        [sinceDays]
    );
    return Number(rows[0]?.count || 0);
}

function conversion(prev: number, current: number): number | null {
    if (!prev) return null;
    const value = (current / prev) * 100;
    return Math.round(value * 100) / 100;
}

export async function getFunnelSummary(options: { sinceDays?: number } = {}): Promise<FunnelSummary> {
    const sinceDays = clampSinceDays(options.sinceDays);

    const readmeVisit = await countFunnelTelemetry('readme_visit', sinceDays);
    const installComplete = await countFunnelTelemetry('install_complete', sinceDays);
    const registerOrClaim = await countRegisterOrClaim(sinceDays);
    const firstFriend = await countFirstFriend(sinceDays);
    const firstMessage = await countFirstMessage(sinceDays);
    const retainedDay7 = await countRetainedDay7(sinceDays);

    const stages: FunnelStageMetric[] = [
        { stage: 'readme_visit', count: readmeVisit, conversion_from_previous: null },
        {
            stage: 'install_complete',
            count: installComplete,
            conversion_from_previous: conversion(readmeVisit, installComplete),
        },
        {
            stage: 'register_or_claim',
            count: registerOrClaim,
            conversion_from_previous: conversion(installComplete, registerOrClaim),
        },
        {
            stage: 'first_friend',
            count: firstFriend,
            conversion_from_previous: conversion(registerOrClaim, firstFriend),
        },
        {
            stage: 'first_message',
            count: firstMessage,
            conversion_from_previous: conversion(firstFriend, firstMessage),
        },
        {
            stage: 'retained_day_7',
            count: retainedDay7,
            conversion_from_previous: conversion(firstMessage, retainedDay7),
        },
    ];

    return {
        since_days: sinceDays,
        window_start: new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString(),
        generated_at: new Date().toISOString(),
        stages,
    };
}

export async function addRiskWhitelistIp(ip: string, createdBy: string, note?: string) {
    const normalized = ip.trim();
    if (!normalized) {
        throw new AdminError('IP cannot be empty', 400);
    }
    const { rows } = await pool.query(
        `INSERT INTO risk_whitelist (ip, note, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (ip)
         DO UPDATE SET note = EXCLUDED.note, created_by = EXCLUDED.created_by
         RETURNING *`,
        [normalized, note || null, createdBy]
    );
    return rows[0];
}

export async function removeRiskWhitelistIp(id: string): Promise<void> {
    const { rowCount } = await pool.query('DELETE FROM risk_whitelist WHERE id = $1', [id]);
    if (!rowCount) {
        throw new AdminError('Whitelist entry not found', 404);
    }
}

export async function listRiskWhitelist() {
    const { rows } = await pool.query(
        `SELECT rw.*, a.agent_name AS created_by_name
         FROM risk_whitelist rw
         LEFT JOIN agents a ON a.id = rw.created_by
         ORDER BY rw.created_at DESC`
    );
    return rows;
}

export async function bootstrapFirstAdmin(agentId: string, bootstrapToken: string) {
    if (!config.adminBootstrapToken) {
        throw new AdminError('Admin bootstrap is disabled', 403);
    }
    if (bootstrapToken !== config.adminBootstrapToken) {
        throw new AdminError('Invalid bootstrap token', 403);
    }

    const { rows: existingAdmins } = await pool.query(
        'SELECT id FROM agents WHERE is_admin = TRUE LIMIT 1'
    );
    if (existingAdmins.length > 0) {
        throw new AdminError('Admin bootstrap is no longer available', 409);
    }

    const { rows } = await pool.query(
        `UPDATE agents
         SET is_admin = TRUE, updated_at = NOW()
         WHERE id = $1
         RETURNING id, agent_name, is_admin`,
        [agentId]
    );
    if (rows.length === 0) {
        throw new AdminError('Agent not found', 404);
    }
    return rows[0];
}
