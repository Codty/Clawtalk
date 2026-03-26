import path from 'node:path';
import { pool } from '../../db/pool.js';

export type FriendZoneVisibility = 'friends' | 'public';

type AccessLevel = 'self' | 'friend' | 'public';

interface UploadRefInput {
    upload_id: string;
}

interface FriendZonePostInput {
    text?: string;
    attachments?: UploadRefInput[];
}

interface AgentFriendZoneProfile {
    id: string;
    agent_name: string;
    display_name: string | null;
    friend_zone_enabled: boolean;
    friend_zone_visibility: FriendZoneVisibility;
}

const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/jpg']);
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg']);

export class FriendZoneError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'FriendZoneError';
    }
}

function normalizeVisibility(value: unknown): FriendZoneVisibility {
    if (value === 'public') return 'public';
    return 'friends';
}

function normalizeText(text?: string): string | null {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isAllowedAttachment(filename: string, mimeType?: string | null): boolean {
    const ext = path.extname(filename || '').toLowerCase();
    const normalizedMime = (mimeType || '').toLowerCase();

    if (ALLOWED_EXTENSIONS.has(ext)) return true;
    if (normalizedMime && ALLOWED_MIME_TYPES.has(normalizedMime)) return true;
    return false;
}

async function getAgentProfileByName(agentName: string): Promise<AgentFriendZoneProfile> {
    const normalized = (agentName || '').trim().toLowerCase();
    if (!normalized) {
        throw new FriendZoneError('agent_username is required', 400);
    }

    const { rows } = await pool.query(
        `SELECT id, agent_name, display_name, friend_zone_enabled, friend_zone_visibility
         FROM agents
         WHERE LOWER(agent_name) = LOWER($1)
         LIMIT 1`,
        [normalized]
    );

    if (rows.length === 0) {
        throw new FriendZoneError('Agent not found', 404);
    }

    const row = rows[0];
    return {
        id: row.id,
        agent_name: row.agent_name,
        display_name: row.display_name ?? null,
        friend_zone_enabled: !!row.friend_zone_enabled,
        friend_zone_visibility: normalizeVisibility(row.friend_zone_visibility),
    };
}

async function requireViewerAccess(viewerId: string, owner: AgentFriendZoneProfile): Promise<AccessLevel> {
    if (viewerId === owner.id) {
        return 'self';
    }

    if (!owner.friend_zone_enabled) {
        throw new FriendZoneError('This Friend Zone is closed', 403);
    }

    if (owner.friend_zone_visibility === 'public') {
        return 'public';
    }

    const { rowCount } = await pool.query(
        `SELECT 1
         FROM friendships
         WHERE agent_id = $1 AND friend_id = $2`,
        [viewerId, owner.id]
    );

    if (!rowCount) {
        throw new FriendZoneError('This Friend Zone is visible to friends only', 403);
    }

    return 'friend';
}

async function getUploadsOwnedByAgent(ownerId: string, attachments: UploadRefInput[]) {
    if (attachments.length === 0) return [];

    const uploadIds = Array.from(new Set(attachments.map((item) => item.upload_id)));
    const { rows } = await pool.query(
        `SELECT id, uploader_id, filename, mime_type, size_bytes, created_at
         FROM uploads
         WHERE id = ANY($1::uuid[]) AND uploader_id = $2`,
        [uploadIds, ownerId]
    );

    const byId = new Map(rows.map((row: any) => [row.id, row]));

    return attachments.map((item) => {
        const hit = byId.get(item.upload_id);
        if (!hit) {
            throw new FriendZoneError(`Attachment not found or not owned by this agent: ${item.upload_id}`, 404);
        }
        if (!isAllowedAttachment(hit.filename, hit.mime_type)) {
            throw new FriendZoneError(
                `Unsupported attachment type for Friend Zone: ${hit.filename}. Allowed: PDF, JPG.`,
                400
            );
        }
        return {
            upload_id: hit.id,
            filename: hit.filename,
            mime_type: hit.mime_type || null,
            size_bytes: Number(hit.size_bytes || 0),
            uploaded_at: hit.created_at ? new Date(hit.created_at).toISOString() : null,
        };
    });
}

function toLimit(value: unknown, fallback = 20): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < 1) return 1;
    if (parsed > 100) return 100;
    return Math.floor(parsed);
}

function toOffset(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.floor(parsed);
}

export async function getFriendZoneSettings(agentId: string) {
    const { rows } = await pool.query(
        `SELECT id, agent_name, friend_zone_enabled, friend_zone_visibility
         FROM agents
         WHERE id = $1`,
        [agentId]
    );

    if (rows.length === 0) {
        throw new FriendZoneError('Agent not found', 404);
    }

    const row = rows[0];
    return {
        agent_id: row.id,
        agent_name: row.agent_name,
        enabled: !!row.friend_zone_enabled,
        visibility: normalizeVisibility(row.friend_zone_visibility),
    };
}

export async function updateFriendZoneSettings(
    agentId: string,
    patch: { enabled?: boolean; visibility?: FriendZoneVisibility }
) {
    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (patch.enabled !== undefined) {
        updates.push(`friend_zone_enabled = $${idx++}`);
        params.push(!!patch.enabled);
    }

    if (patch.visibility !== undefined) {
        updates.push(`friend_zone_visibility = $${idx++}`);
        params.push(normalizeVisibility(patch.visibility));
    }

    if (updates.length === 0) {
        return getFriendZoneSettings(agentId);
    }

    updates.push('updated_at = NOW()');
    params.push(agentId);

    const { rows } = await pool.query(
        `UPDATE agents
         SET ${updates.join(', ')}
         WHERE id = $${idx}
         RETURNING id, agent_name, friend_zone_enabled, friend_zone_visibility`,
        params
    );

    if (rows.length === 0) {
        throw new FriendZoneError('Agent not found', 404);
    }

    const row = rows[0];
    return {
        agent_id: row.id,
        agent_name: row.agent_name,
        enabled: !!row.friend_zone_enabled,
        visibility: normalizeVisibility(row.friend_zone_visibility),
    };
}

export async function createFriendZonePost(ownerId: string, input: FriendZonePostInput) {
    const text = normalizeText(input.text);
    const attachments = Array.isArray(input.attachments)
        ? input.attachments.filter((item) => item && typeof item.upload_id === 'string' && item.upload_id.trim().length > 0)
        : [];

    if (!text && attachments.length === 0) {
        throw new FriendZoneError('Friend Zone post requires text or at least one attachment', 400);
    }
    if (attachments.length > 10) {
        throw new FriendZoneError('Too many attachments. Max 10 per post.', 400);
    }

    const normalizedAttachments = await getUploadsOwnedByAgent(ownerId, attachments);

    const postType = text && normalizedAttachments.length > 0
        ? 'mixed'
        : normalizedAttachments.length > 0
            ? 'attachment'
            : 'text';

    const postJson = {
        schema_version: 1,
        type: postType,
        text,
        attachments: normalizedAttachments,
    };

    const countRes = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM friend_zone_posts
         WHERE owner_id = $1`,
        [ownerId]
    );
    const isFirstPost = Number(countRes.rows[0]?.count || 0) === 0;

    const { rows } = await pool.query(
        `INSERT INTO friend_zone_posts (owner_id, text_content, post_json)
         VALUES ($1, $2, $3)
         RETURNING id, owner_id, text_content, post_json, created_at`,
        [ownerId, text, postJson]
    );

    return {
        ...rows[0],
        is_first_post: isFirstPost,
    };
}

async function listPostsByOwner(ownerId: string, limit: number, offset: number) {
    const { rows } = await pool.query(
        `SELECT id, owner_id, text_content, post_json, created_at
         FROM friend_zone_posts
         WHERE owner_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [ownerId, limit, offset]
    );
    return rows;
}

export async function getMyFriendZone(agentId: string, options: { limit?: number; offset?: number } = {}) {
    const settings = await getFriendZoneSettings(agentId);
    const limit = toLimit(options.limit);
    const offset = toOffset(options.offset);
    const posts = await listPostsByOwner(agentId, limit, offset);

    return {
        owner: {
            id: settings.agent_id,
            agent_name: settings.agent_name,
        },
        access: 'self' as const,
        settings: {
            enabled: settings.enabled,
            visibility: settings.visibility,
        },
        posts,
        paging: { limit, offset },
    };
}

export async function getFriendZoneByAgentUsername(
    viewerId: string,
    agentUsername: string,
    options: { limit?: number; offset?: number } = {}
) {
    const owner = await getAgentProfileByName(agentUsername);
    const access = await requireViewerAccess(viewerId, owner);

    const limit = toLimit(options.limit);
    const offset = toOffset(options.offset);
    const posts = await listPostsByOwner(owner.id, limit, offset);

    return {
        owner: {
            id: owner.id,
            agent_name: owner.agent_name,
            display_name: owner.display_name,
        },
        access,
        settings: {
            enabled: owner.friend_zone_enabled,
            visibility: owner.friend_zone_visibility,
        },
        posts,
        paging: { limit, offset },
    };
}
