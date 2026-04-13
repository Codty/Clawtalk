import { pool } from '../../db/pool.js';
import { disconnectAgentFromConversation, addAgentToConversation } from '../ws/ws.handler.js';
import type { ConversationPolicy } from '../../config.js';
import { config } from '../../config.js';
import { isBlockedEitherDirection } from '../friend/block.service.js';

export class ConversationError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'ConversationError';
    }
}

function canonicalDmPair(agentId: string, peerAgentId: string): [string, string] {
    return agentId < peerAgentId
        ? [agentId, peerAgentId]
        : [peerAgentId, agentId];
}

/**
 * Create or return existing DM between two agents.
 */
export async function createOrGetDM(agentId: string, peerAgentId: string) {
    if (agentId === peerAgentId) {
        throw new ConversationError('Cannot create DM with yourself', 400);
    }

    const { rows: peerRows } = await pool.query(
        'SELECT id, claim_status FROM agents WHERE id = $1',
        [peerAgentId]
    );
    if (peerRows.length === 0) {
        throw new ConversationError('Peer agent not found', 404);
    }
    if (peerRows[0].claim_status !== 'claimed') {
        throw new ConversationError(
            'Peer agent must complete claim verification before DM can be created',
            403
        );
    }

    // Issue #9: Check block status before DM creation
    if (await isBlockedEitherDirection(agentId, peerAgentId)) {
        throw new ConversationError('This interaction is blocked', 403);
    }

    // Issue #1: Enforce friendship requirement for new DMs (configurable)
    if (config.dmRequiresFriendship) {
        // Allow re-opening existing DMs even without friendship
        const { rows: existingDm } = await pool.query(
            `SELECT c.id
             FROM conversations c
             JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.agent_id = $1
             JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.agent_id = $2
             WHERE c.type = 'dm'
             LIMIT 1`,
            [agentId, peerAgentId]
        );
        if (existingDm.length === 0) {
            const { rowCount: isFriend } = await pool.query(
                `SELECT 1 FROM friendships
                 WHERE agent_id = $1 AND friend_id = $2
                 LIMIT 1`,
                [agentId, peerAgentId]
            );
            if (!isFriend) {
                throw new ConversationError(
                    'You must be friends before creating a DM. Send a friend request first.',
                    403
                );
            }
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const [pairA, pairB] = canonicalDmPair(agentId, peerAgentId);
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
            [pairA, pairB]
        );

        const { rows: existing } = await client.query(
            `SELECT c.id, c.type, c.name, c.created_at, c.policy_json
             FROM conversations c
             JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.agent_id = $1
             JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.agent_id = $2
             WHERE c.type = 'dm'
             ORDER BY c.created_at ASC
             LIMIT 1`,
            [agentId, peerAgentId]
        );

        if (existing.length > 0) {
            await client.query('COMMIT');
            return { conversation: existing[0], created: false };
        }

        const { rows: convRows } = await client.query(
            `INSERT INTO conversations (type) VALUES ('dm') RETURNING *`
        );
        const conv = convRows[0];

        await client.query(
            `INSERT INTO conversation_members (conversation_id, agent_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
            [conv.id, agentId, peerAgentId]
        );
        await client.query('COMMIT');

        addAgentToConversation(conv.id, agentId);
        addAgentToConversation(conv.id, peerAgentId);

        return { conversation: conv, created: true };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Create a group conversation.
 */
export async function createGroup(ownerId: string, name: string, memberIds: string[]) {
    const allMembers = new Set([ownerId, ...memberIds]);

    // Issue #11: Validate friendship for all members when DM_REQUIRES_FRIENDSHIP is enabled
    if (config.dmRequiresFriendship) {
        const nonFriendIds: string[] = [];
        for (const memberId of memberIds) {
            if (memberId === ownerId) continue;
            const { rowCount } = await pool.query(
                'SELECT 1 FROM friendships WHERE agent_id = $1 AND friend_id = $2',
                [ownerId, memberId]
            );
            if (!rowCount) nonFriendIds.push(memberId);
        }
        if (nonFriendIds.length > 0) {
            throw new ConversationError(
                `Cannot add non-friends to group. Send friend requests first.`,
                403
            );
        }
    }

    // Issue #9: Check block status for all members
    for (const memberId of memberIds) {
        if (memberId === ownerId) continue;
        if (await isBlockedEitherDirection(ownerId, memberId)) {
            throw new ConversationError('Cannot add blocked agents to group', 403);
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: convRows } = await client.query(
            `INSERT INTO conversations (type, name, owner_id) VALUES ('group', $1, $2) RETURNING *`,
            [name, ownerId]
        );
        const conv = convRows[0];

        for (const memberId of allMembers) {
            const role = memberId === ownerId ? 'owner' : 'member';
            await client.query(
                `INSERT INTO conversation_members (conversation_id, agent_id, role) VALUES ($1, $2, $3)`,
                [conv.id, memberId, role]
            );
        }

        await client.query('COMMIT');

        for (const memberId of allMembers) {
            addAgentToConversation(conv.id, memberId);
        }

        return conv;
    } catch (err: any) {
        await client.query('ROLLBACK');
        if (err.code === '23503') {
            throw new ConversationError('One or more agent IDs not found', 404);
        }
        throw err;
    } finally {
        client.release();
    }
}

/**
 * List conversations for an agent.
 */
export async function listConversations(agentId: string) {
    const { rows } = await pool.query(
        `SELECT c.id, c.type, c.name, c.owner_id, c.created_at, c.policy_json, cm.role, cm.joined_at
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE cm.agent_id = $1
     ORDER BY c.created_at DESC`,
        [agentId]
    );
    return rows;
}

/**
 * Get conversation details with members.
 */
export async function getConversation(conversationId: string, agentId: string) {
    await assertMember(conversationId, agentId);

    const { rows: convRows } = await pool.query(
        'SELECT * FROM conversations WHERE id = $1',
        [conversationId]
    );
    if (convRows.length === 0) {
        throw new ConversationError('Conversation not found', 404);
    }

    const { rows: members } = await pool.query(
        `SELECT cm.agent_id, a.agent_name, cm.role, cm.joined_at
     FROM conversation_members cm
     JOIN agents a ON a.id = cm.agent_id
     WHERE cm.conversation_id = $1`,
        [conversationId]
    );

    return { ...convRows[0], members };
}

/**
 * Get conversation policy (merged with defaults).
 */
export function getPolicy(policyJson: any): ConversationPolicy {
    return { ...config.defaultPolicy, ...(policyJson || {}) };
}

/**
 * Update conversation policy.
 * - Group: owner only
 * - DM: participants only
 */
export async function updatePolicy(
    conversationId: string,
    requesterId: string,
    policy: ConversationPolicy
): Promise<ConversationPolicy> {
    await assertCanUpdatePolicy(conversationId, requesterId);

    // Validate allow_types
    const validTypes = new Set(['text', 'tool_call', 'event', 'media']);
    if (policy.allow_types) {
        for (const t of policy.allow_types) {
            if (!validTypes.has(t)) {
                throw new ConversationError(`Invalid type in allow_types: "${t}"`, 400);
            }
        }
    }

    const { rows } = await pool.query(
        `UPDATE conversations
     SET policy_json = policy_json || $1::jsonb
     WHERE id = $2
     RETURNING policy_json`,
        [JSON.stringify(policy), conversationId]
    );

    return getPolicy(rows[0].policy_json);
}

async function assertCanUpdatePolicy(conversationId: string, requesterId: string): Promise<void> {
    const { rows } = await pool.query(
        'SELECT type, owner_id FROM conversations WHERE id = $1',
        [conversationId]
    );
    if (rows.length === 0) {
        throw new ConversationError('Conversation not found', 404);
    }

    const conversation = rows[0];
    if (conversation.type === 'group') {
        if (conversation.owner_id !== requesterId) {
            throw new ConversationError('Only the group owner can update policy', 403);
        }
        return;
    }

    if (conversation.type === 'dm') {
        const { rows: memberRows } = await pool.query(
            'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND agent_id = $2',
            [conversationId, requesterId]
        );
        if (memberRows.length === 0) {
            throw new ConversationError('Only DM participants can update policy', 403);
        }
        return;
    }

    throw new ConversationError(`Unsupported conversation type for policy update: ${conversation.type}`, 400);
}

/**
 * Add member to group (owner only).
 */
export async function addMember(conversationId: string, requesterId: string, newAgentId: string) {
    await assertOwner(conversationId, requesterId);

    if (config.dmRequiresFriendship) {
        const { rowCount: isFriend } = await pool.query(
            'SELECT 1 FROM friendships WHERE agent_id = $1 AND friend_id = $2 LIMIT 1',
            [requesterId, newAgentId]
        );
        if (!isFriend) {
            throw new ConversationError('Cannot add non-friends to group. Send friend requests first.', 403);
        }
    }

    if (await isBlockedEitherDirection(requesterId, newAgentId)) {
        throw new ConversationError('Cannot add blocked agents to group', 403);
    }

    try {
        await pool.query(
            `INSERT INTO conversation_members (conversation_id, agent_id, role) VALUES ($1, $2, 'member')`,
            [conversationId, newAgentId]
        );
        addAgentToConversation(conversationId, newAgentId);
    } catch (err: any) {
        if (err.code === '23505') {
            throw new ConversationError('Agent is already a member', 409);
        }
        if (err.code === '23503') {
            throw new ConversationError('Agent not found', 404);
        }
        throw err;
    }
}

/**
 * Remove member from group (owner only).
 */
export async function removeMember(conversationId: string, requesterId: string, targetAgentId: string) {
    await assertOwner(conversationId, requesterId);

    if (requesterId === targetAgentId) {
        throw new ConversationError('Owner cannot remove themselves', 400);
    }

    const { rowCount } = await pool.query(
        `DELETE FROM conversation_members WHERE conversation_id = $1 AND agent_id = $2`,
        [conversationId, targetAgentId]
    );

    if (rowCount === 0) {
        throw new ConversationError('Agent is not a member', 404);
    }

    disconnectAgentFromConversation(conversationId, targetAgentId);
}

/**
 * Assert agent is a member of the conversation.
 */
export async function assertMember(conversationId: string, agentId: string) {
    const { rows } = await pool.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND agent_id = $2',
        [conversationId, agentId]
    );
    if (rows.length === 0) {
        throw new ConversationError('Not a member of this conversation', 403);
    }
}

/**
 * Assert agent is the owner of the conversation.
 */
async function assertOwner(conversationId: string, agentId: string) {
    const { rows } = await pool.query(
        'SELECT type, owner_id FROM conversations WHERE id = $1',
        [conversationId]
    );
    if (rows.length === 0) {
        throw new ConversationError('Conversation not found', 404);
    }
    if (rows[0].type !== 'group') {
        throw new ConversationError('Cannot modify members of a DM', 400);
    }
    if (rows[0].owner_id !== agentId) {
        throw new ConversationError('Only the group owner can manage members', 403);
    }
}

/**
 * Issue #5: Allow non-owner members to leave a group conversation.
 */
export async function leaveGroup(conversationId: string, agentId: string): Promise<void> {
    const { rows } = await pool.query(
        'SELECT type, owner_id FROM conversations WHERE id = $1',
        [conversationId]
    );
    if (rows.length === 0) {
        throw new ConversationError('Conversation not found', 404);
    }
    if (rows[0].type !== 'group') {
        throw new ConversationError('Cannot leave a DM conversation', 400);
    }
    if (rows[0].owner_id === agentId) {
        throw new ConversationError(
            'Owner cannot leave the group. Transfer ownership first or delete the group.',
            400
        );
    }

    const { rowCount } = await pool.query(
        'DELETE FROM conversation_members WHERE conversation_id = $1 AND agent_id = $2',
        [conversationId, agentId]
    );
    if (rowCount === 0) {
        throw new ConversationError('Not a member of this group', 404);
    }
    disconnectAgentFromConversation(conversationId, agentId);
}

/**
 * Issue #14: Transfer group ownership to another member.
 */
export async function transferOwnership(
    conversationId: string,
    currentOwnerId: string,
    newOwnerId: string
): Promise<void> {
    if (currentOwnerId === newOwnerId) {
        throw new ConversationError('New owner must be different from current owner', 400);
    }

    await assertOwner(conversationId, currentOwnerId);
    await assertMember(conversationId, newOwnerId);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'UPDATE conversations SET owner_id = $1 WHERE id = $2',
            [newOwnerId, conversationId]
        );
        await client.query(
            `UPDATE conversation_members SET role = 'member'
             WHERE conversation_id = $1 AND agent_id = $2`,
            [conversationId, currentOwnerId]
        );
        await client.query(
            `UPDATE conversation_members SET role = 'owner'
             WHERE conversation_id = $1 AND agent_id = $2`,
            [conversationId, newOwnerId]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
