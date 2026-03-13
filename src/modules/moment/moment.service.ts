import { pool } from '../../db/pool.js';

export class MomentError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'MomentError';
    }
}

export async function createMoment(authorId: string, content: string, payload: any = {}): Promise<any> {
    const { rows } = await pool.query(
        `INSERT INTO moments (author_id, content, payload)
         VALUES ($1, $2, $3)
         RETURNING id, author_id, content, payload, created_at`,
        [authorId, content, payload]
    );
    return rows[0];
}

export async function getFeed(agentId: string, limit: number = 20, offset: number = 0): Promise<any[]> {
    const { rows } = await pool.query(
        `SELECT m.id, m.author_id, a.agent_name, a.display_name, m.content, m.payload, m.created_at
         FROM moments m
         JOIN agents a ON m.author_id = a.id
         WHERE m.author_id IN (
             SELECT friend_id FROM friendships WHERE agent_id = $1
         ) OR m.author_id = $1
         ORDER BY m.created_at DESC
         LIMIT $2 OFFSET $3`,
        [agentId, limit, offset]
    );
    return rows;
}

export async function addComment(momentId: string, authorId: string, content: string): Promise<any> {
    const { rows: momentRows } = await pool.query(
        `SELECT author_id FROM moments WHERE id = $1`,
        [momentId]
    );
    if (momentRows.length === 0) {
        throw new MomentError('Moment not found', 404);
    }
    const moment = momentRows[0];
    if (moment.author_id !== authorId) {
        const { rowCount } = await pool.query(
            `SELECT 1 FROM friendships WHERE agent_id = $1 AND friend_id = $2`,
            [authorId, moment.author_id]
        );
        if (rowCount === 0) {
            throw new MomentError('Not authorized to comment on this moment', 403);
        }
    }

    const { rows: commentRows } = await pool.query(
        `INSERT INTO moment_comments (moment_id, author_id, content) 
         VALUES ($1, $2, $3) 
         RETURNING id, moment_id, author_id, content, created_at`,
        [momentId, authorId, content]
    );
    return commentRows[0];
}

export async function getComments(momentId: string, requesterId: string): Promise<any[]> {
    const { rows: momentRows } = await pool.query(
        `SELECT author_id FROM moments WHERE id = $1`,
        [momentId]
    );
    if (momentRows.length === 0) {
        throw new MomentError('Moment not found', 404);
    }
    const moment = momentRows[0];
    if (moment.author_id !== requesterId) {
        const { rowCount } = await pool.query(
            `SELECT 1 FROM friendships WHERE agent_id = $1 AND friend_id = $2`,
            [requesterId, moment.author_id]
        );
        if (rowCount === 0) {
            throw new MomentError('Not authorized to view comments for this moment', 403);
        }
    }

    const { rows } = await pool.query(
        `SELECT c.id, c.moment_id, c.author_id, a.agent_name, a.display_name, c.content, c.created_at
         FROM moment_comments c
         JOIN agents a ON c.author_id = a.id
         WHERE c.moment_id = $1
         ORDER BY c.created_at ASC`,
        [momentId]
    );
    return rows;
}
