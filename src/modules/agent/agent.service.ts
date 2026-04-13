import { pool } from '../../db/pool.js';
import { redis } from '../../infra/redis.js';
import { config } from '../../config.js';

export class AgentError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AgentError';
    }
}

export interface AgentProfile {
    id: string;
    agent_name: string;
    display_name: string | null;
    description: string | null;
    aiti_type: string | null;
    aiti_summary: string | null;
    capabilities: string[];
    created_at: string;
    last_seen_at: string | null;
    online: boolean;
}

/**
 * Get agent profile by ID, including presence status.
 */
export async function getProfile(agentId: string): Promise<AgentProfile> {
    const { rows } = await pool.query(
        `SELECT id, agent_name, display_name, description, aiti_type, aiti_summary, capabilities, created_at, last_seen_at
     FROM agents WHERE id = $1`,
        [agentId]
    );
    if (rows.length === 0) {
        throw new AgentError('Agent not found', 404);
    }
    const agent = rows[0];
    const online = await isOnline(agentId);
    return { ...agent, online };
}

/**
 * Update own profile.
 */
export async function updateProfile(
    agentId: string,
    updates: { display_name?: string; description?: string; aiti_type?: string | null; aiti_summary?: string | null; capabilities?: string[] }
): Promise<AgentProfile> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (updates.display_name !== undefined) {
        setClauses.push(`display_name = $${paramIdx++}`);
        params.push(updates.display_name);
    }
    if (updates.description !== undefined) {
        setClauses.push(`description = $${paramIdx++}`);
        params.push(updates.description);
    }
    if (updates.aiti_type !== undefined) {
        setClauses.push(`aiti_type = $${paramIdx++}`);
        params.push(updates.aiti_type ? String(updates.aiti_type).trim() || null : null);
    }
    if (updates.aiti_summary !== undefined) {
        setClauses.push(`aiti_summary = $${paramIdx++}`);
        params.push(updates.aiti_summary ? String(updates.aiti_summary).trim() || null : null);
    }
    if (updates.capabilities !== undefined) {
        setClauses.push(`capabilities = $${paramIdx++}`);
        params.push(JSON.stringify(updates.capabilities));
    }

    if (setClauses.length === 0) {
        return getProfile(agentId);
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(agentId);

    const { rows } = await pool.query(
        `UPDATE agents SET ${setClauses.join(', ')} WHERE id = $${paramIdx}
     RETURNING id, agent_name, display_name, description, aiti_type, aiti_summary, capabilities, created_at, last_seen_at`,
        params
    );

    if (rows.length === 0) {
        throw new AgentError('Agent not found', 404);
    }

    const online = await isOnline(agentId);
    return { ...rows[0], online };
}

/**
 * List agents with pagination and presence.
 */
export async function listAgents(
    options: { limit?: number; offset?: number; search?: string } = {}
): Promise<{ agents: AgentProfile[]; total: number }> {
    const limit = Math.min(options.limit || 50, 100);
    const offset = options.offset || 0;

    let whereClause = '';
    const params: any[] = [];
    let paramIdx = 1;

    if (options.search) {
        whereClause = `WHERE agent_name ILIKE $${paramIdx} OR display_name ILIKE $${paramIdx}`;
        params.push(`%${options.search}%`);
        paramIdx++;
    }

    params.push(limit, offset);

    const { rows } = await pool.query(
        `SELECT id, agent_name, display_name, description, aiti_type, aiti_summary, capabilities, created_at, last_seen_at
     FROM agents ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        params
    );

    const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) FROM agents ${whereClause}`,
        options.search ? [params[0]] : []
    );

    // Add online status for each agent
    const agents: AgentProfile[] = await Promise.all(
        rows.map(async (row: any) => ({
            ...row,
            online: await isOnline(row.id),
        }))
    );

    return { agents, total: parseInt(countRows[0].count, 10) };
}

// ── Presence ──

const PRESENCE_PREFIX = 'presence:';

/**
 * Set agent online (called on WS connect).
 */
export async function setOnline(agentId: string): Promise<void> {
    await redis.set(`${PRESENCE_PREFIX}${agentId}`, '1', 'EX', config.presenceTtlSec);
    await pool.query(
        'UPDATE agents SET last_seen_at = NOW() WHERE id = $1',
        [agentId]
    );
}

/**
 * Refresh presence TTL (called on WS ping/activity).
 */
export async function refreshPresence(agentId: string): Promise<void> {
    await redis.expire(`${PRESENCE_PREFIX}${agentId}`, config.presenceTtlSec);
}

/**
 * Set agent offline (called on WS disconnect).
 */
export async function setOffline(agentId: string): Promise<void> {
    await redis.del(`${PRESENCE_PREFIX}${agentId}`);
    await pool.query(
        'UPDATE agents SET last_seen_at = NOW() WHERE id = $1',
        [agentId]
    );
}

/**
 * Check if agent is online.
 */
export async function isOnline(agentId: string): Promise<boolean> {
    const result = await redis.exists(`${PRESENCE_PREFIX}${agentId}`);
    return result === 1;
}
