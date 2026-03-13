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
