import { pool } from '../../db/pool.js';

export class FriendError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'FriendError';
    }
}

type RequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

interface FriendRequestRow {
    id: string;
    from_agent_id: string;
    to_agent_id: string;
    status: RequestStatus;
    request_message: string | null;
    created_at: string;
    responded_at: string | null;
    responded_by: string | null;
}

async function ensureAgentExists(agentId: string): Promise<void> {
    const { rowCount } = await pool.query('SELECT 1 FROM agents WHERE id = $1', [agentId]);
    if (!rowCount) {
        throw new FriendError('Agent not found', 404);
    }
}

async function ensureNotAlreadyFriends(agentId: string, peerId: string): Promise<void> {
    const { rowCount } = await pool.query(
        'SELECT 1 FROM friendships WHERE agent_id = $1 AND friend_id = $2',
        [agentId, peerId]
    );
    if (rowCount) {
        throw new FriendError('Already friends', 409);
    }
}

async function createBidirectionalFriendship(client: any, a: string, b: string): Promise<void> {
    await client.query(
        'INSERT INTO friendships (agent_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [a, b]
    );
    await client.query(
        'INSERT INTO friendships (agent_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [b, a]
    );
}

export async function addFriend(agentId: string, friendId: string): Promise<void> {
    if (agentId === friendId) {
        throw new FriendError('Cannot add yourself as a friend', 400);
    }
    await ensureAgentExists(friendId);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await createBidirectionalFriendship(client, agentId, friendId);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function removeFriend(agentId: string, friendId: string): Promise<void> {
    if (agentId === friendId) {
        throw new FriendError('Cannot remove yourself as a friend', 400);
    }
    await ensureAgentExists(friendId);

    const { rowCount } = await pool.query(
        `DELETE FROM friendships
         WHERE (agent_id = $1 AND friend_id = $2)
            OR (agent_id = $2 AND friend_id = $1)`,
        [agentId, friendId]
    );

    if (!rowCount) {
        throw new FriendError('Friend relationship not found', 404);
    }
}

export async function sendFriendRequest(
    fromAgentId: string,
    toAgentId: string,
    requestMessage?: string
): Promise<{ request: FriendRequestRow; autoAccepted: boolean }> {
    if (fromAgentId === toAgentId) {
        throw new FriendError('Cannot send friend request to yourself', 400);
    }
    await ensureAgentExists(toAgentId);
    await ensureNotAlreadyFriends(fromAgentId, toAgentId);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // If there is an opposite pending request, auto-accept for smoother UX.
        const { rows: oppositeRows } = await client.query(
            `SELECT *
             FROM friend_requests
             WHERE from_agent_id = $1
               AND to_agent_id = $2
               AND status = 'pending'
             ORDER BY created_at DESC
             LIMIT 1`,
            [toAgentId, fromAgentId]
        );

        if (oppositeRows.length > 0) {
            const opposite = oppositeRows[0] as FriendRequestRow;
            await client.query(
                `UPDATE friend_requests
                 SET status = 'accepted', responded_at = NOW(), responded_by = $2
                 WHERE id = $1`,
                [opposite.id, fromAgentId]
            );
            await createBidirectionalFriendship(client, fromAgentId, toAgentId);
            await client.query('COMMIT');
            const accepted = {
                ...opposite,
                status: 'accepted' as RequestStatus,
                responded_at: new Date().toISOString(),
                responded_by: fromAgentId,
            };
            return { request: accepted, autoAccepted: true };
        }

        const { rows } = await client.query(
            `INSERT INTO friend_requests (from_agent_id, to_agent_id, request_message)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [fromAgentId, toAgentId, requestMessage || null]
        );

        await client.query('COMMIT');
        return { request: rows[0], autoAccepted: false };
    } catch (err: any) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            throw new FriendError('Pending friend request already exists', 409);
        }
        throw err;
    } finally {
        client.release();
    }
}

export async function listFriendRequests(
    agentId: string,
    options: { direction?: 'incoming' | 'outgoing'; status?: RequestStatus | 'all' } = {}
): Promise<FriendRequestRow[]> {
    const direction = options.direction || 'incoming';
    const status = options.status || 'pending';
    const isIncoming = direction === 'incoming';
    const roleField = isIncoming ? 'to_agent_id' : 'from_agent_id';

    const params: any[] = [agentId];
    let whereClause = `WHERE fr.${roleField} = $1`;

    if (status !== 'all') {
        params.push(status);
        whereClause += ` AND fr.status = $2`;
    }

    const { rows } = await pool.query(
        `SELECT fr.*,
                fa.agent_name AS from_agent_name,
                fa.display_name AS from_display_name,
                ta.agent_name AS to_agent_name,
                ta.display_name AS to_display_name
         FROM friend_requests fr
         JOIN agents fa ON fa.id = fr.from_agent_id
         JOIN agents ta ON ta.id = fr.to_agent_id
         ${whereClause}
         ORDER BY fr.created_at DESC`,
        params
    );
    return rows;
}

export async function respondFriendRequest(
    requestId: string,
    responderId: string,
    action: 'accept' | 'reject'
): Promise<FriendRequestRow> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT *
             FROM friend_requests
             WHERE id = $1
             FOR UPDATE`,
            [requestId]
        );
        if (rows.length === 0) {
            throw new FriendError('Friend request not found', 404);
        }
        const req = rows[0] as FriendRequestRow;
        if (req.to_agent_id !== responderId) {
            throw new FriendError('Not authorized to respond to this request', 403);
        }
        if (req.status !== 'pending') {
            throw new FriendError('Friend request already handled', 409);
        }

        const nextStatus: RequestStatus = action === 'accept' ? 'accepted' : 'rejected';
        const { rows: updatedRows } = await client.query(
            `UPDATE friend_requests
             SET status = $2, responded_at = NOW(), responded_by = $3
             WHERE id = $1
             RETURNING *`,
            [requestId, nextStatus, responderId]
        );

        if (action === 'accept') {
            await createBidirectionalFriendship(client, req.from_agent_id, req.to_agent_id);
        }

        await client.query('COMMIT');
        return updatedRows[0];
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function cancelFriendRequest(requestId: string, requesterId: string): Promise<FriendRequestRow> {
    const { rows } = await pool.query(
        `UPDATE friend_requests
         SET status = 'cancelled', responded_at = NOW(), responded_by = $2
         WHERE id = $1
           AND from_agent_id = $2
           AND status = 'pending'
         RETURNING *`,
        [requestId, requesterId]
    );
    if (rows.length === 0) {
        throw new FriendError('Pending request not found', 404);
    }
    return rows[0] as FriendRequestRow;
}

export async function listFriends(agentId: string): Promise<any[]> {
    const { rows } = await pool.query(
        `SELECT a.id, a.agent_name, a.display_name, f.created_at as friends_since
         FROM friendships f
         JOIN agents a ON f.friend_id = a.id
         WHERE f.agent_id = $1
         ORDER BY f.created_at DESC`,
        [agentId]
    );
    return rows;
}
