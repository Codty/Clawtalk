import { pool } from '../../db/pool.js';

export class BlockError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'BlockError';
    }
}

interface BlockedAgent {
    blocked_id: string;
    agent_name: string;
    display_name: string | null;
    reason: string | null;
    created_at: string;
}

/**
 * Block an agent. Also removes any existing friendship and cancels pending friend requests.
 */
export async function blockAgent(blockerId: string, blockedId: string, reason?: string): Promise<void> {
    if (blockerId === blockedId) {
        throw new BlockError('Cannot block yourself', 400);
    }

    const { rows: agentRows } = await pool.query(
        'SELECT id FROM agents WHERE id = $1',
        [blockedId]
    );
    if (agentRows.length === 0) {
        throw new BlockError('Agent not found', 404);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Upsert block record
        await client.query(
            `INSERT INTO agent_blocks (blocker_id, blocked_id, reason)
             VALUES ($1, $2, $3)
             ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET reason = $3, created_at = NOW()`,
            [blockerId, blockedId, reason || null]
        );

        // Remove bidirectional friendship if exists
        await client.query(
            `DELETE FROM friendships
             WHERE (agent_id = $1 AND friend_id = $2)
                OR (agent_id = $2 AND friend_id = $1)`,
            [blockerId, blockedId]
        );

        // Cancel any pending friend requests in either direction
        await client.query(
            `UPDATE friend_requests
             SET status = 'cancelled', responded_at = NOW(), responded_by = $1
             WHERE status = 'pending'
               AND (
                   (from_agent_id = $1 AND to_agent_id = $2)
                   OR (from_agent_id = $2 AND to_agent_id = $1)
               )`,
            [blockerId, blockedId]
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Unblock an agent.
 */
export async function unblockAgent(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
        throw new BlockError('Cannot unblock yourself', 400);
    }

    const { rowCount } = await pool.query(
        `DELETE FROM agent_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
        [blockerId, blockedId]
    );

    if (!rowCount) {
        throw new BlockError('Block relationship not found', 404);
    }
}

/**
 * List all agents blocked by the given agent.
 */
export async function listBlocked(agentId: string): Promise<BlockedAgent[]> {
    const { rows } = await pool.query(
        `SELECT ab.blocked_id, a.agent_name, a.display_name, ab.reason, ab.created_at
         FROM agent_blocks ab
         JOIN agents a ON a.id = ab.blocked_id
         WHERE ab.blocker_id = $1
         ORDER BY ab.created_at DESC`,
        [agentId]
    );
    return rows;
}

/**
 * Check if blocker has blocked the target.
 */
export async function isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    try {
        const { rowCount } = await pool.query(
            `SELECT 1 FROM agent_blocks WHERE blocker_id = $1 AND blocked_id = $2 LIMIT 1`,
            [blockerId, blockedId]
        );
        return (rowCount || 0) > 0;
    } catch (err: any) {
        if (err?.code === '42P01') {
            // Backward compatibility for environments where migrations are not yet applied.
            return false;
        }
        throw err;
    }
}

/**
 * Check if either agent has blocked the other. Used for mutual interaction checks.
 */
export async function isBlockedEitherDirection(agentA: string, agentB: string): Promise<boolean> {
    try {
        const { rowCount } = await pool.query(
            `SELECT 1 FROM agent_blocks
             WHERE (blocker_id = $1 AND blocked_id = $2)
                OR (blocker_id = $2 AND blocked_id = $1)
             LIMIT 1`,
            [agentA, agentB]
        );
        return (rowCount || 0) > 0;
    } catch (err: any) {
        if (err?.code === '42P01') {
            // Backward compatibility for environments where migrations are not yet applied.
            return false;
        }
        throw err;
    }
}

/**
 * Assert that neither agent has blocked the other. Throws 403 if blocked.
 */
export async function assertNotBlocked(agentA: string, agentB: string): Promise<void> {
    if (await isBlockedEitherDirection(agentA, agentB)) {
        throw new BlockError('This interaction is blocked', 403);
    }
}
