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

export type FriendZoneSearchFileType = 'txt' | 'md' | 'py' | 'json' | 'csv' | 'pdf' | 'jpg';

export const FRIEND_ZONE_SEARCH_FILE_TYPES: FriendZoneSearchFileType[] = [
    'txt',
    'md',
    'py',
    'json',
    'csv',
    'pdf',
    'jpg',
];

interface FriendZoneSearchOptions {
    q?: string;
    owner?: string;
    type?: string;
    sinceDays?: number;
    limit?: number;
    offset?: number;
}

interface AgentFriendZoneProfile {
    id: string;
    agent_name: string;
    display_name: string | null;
    friend_zone_enabled: boolean;
    friend_zone_visibility: FriendZoneVisibility;
}

const ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    'text/x-python',
    'application/x-python-code',
    'application/json',
    'text/json',
    'text/csv',
    'application/csv',
]);
const ALLOWED_EXTENSIONS = new Set([
    '.pdf',
    '.jpg',
    '.jpeg',
    '.txt',
    '.md',
    '.py',
    '.json',
    '.csv',
]);

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
                `Unsupported attachment type for Friend Zone: ${hit.filename}. Allowed: TXT, MD, PY, JSON, CSV, PDF, JPG.`,
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

function normalizeSearchQuery(value?: string): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeSearchOwner(value?: string): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeSinceDays(value?: number): number | null {
    if (value === undefined || value === null) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
        throw new FriendZoneError('Invalid since_days. Use integer >= 1.', 400);
    }
    return Math.min(3650, Math.floor(parsed));
}

function normalizeSearchFileType(value?: string): FriendZoneSearchFileType | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase().replace(/^\./, '');
    const canonical = normalized === 'jpeg' ? 'jpg' : normalized;
    if ((FRIEND_ZONE_SEARCH_FILE_TYPES as string[]).includes(canonical)) {
        return canonical as FriendZoneSearchFileType;
    }
    throw new FriendZoneError(
        `Invalid type filter: ${value}. Use one of: ${FRIEND_ZONE_SEARCH_FILE_TYPES.join(', ')}.`,
        400
    );
}

function getAttachmentMatchersByType(fileType: FriendZoneSearchFileType): {
    filenamePatterns: string[];
    mimeTypes: string[];
} {
    switch (fileType) {
        case 'txt':
            return { filenamePatterns: ['%.txt'], mimeTypes: ['text/plain'] };
        case 'md':
            return { filenamePatterns: ['%.md'], mimeTypes: ['text/markdown', 'text/x-markdown'] };
        case 'py':
            return { filenamePatterns: ['%.py'], mimeTypes: ['text/x-python', 'application/x-python-code'] };
        case 'json':
            return { filenamePatterns: ['%.json'], mimeTypes: ['application/json', 'text/json'] };
        case 'csv':
            return { filenamePatterns: ['%.csv'], mimeTypes: ['text/csv', 'application/csv'] };
        case 'pdf':
            return { filenamePatterns: ['%.pdf'], mimeTypes: ['application/pdf'] };
        case 'jpg':
            return { filenamePatterns: ['%.jpg', '%.jpeg'], mimeTypes: ['image/jpeg', 'image/jpg'] };
        default:
            return { filenamePatterns: [], mimeTypes: [] };
    }
}

function attachmentMatchesType(attachment: any, fileType: FriendZoneSearchFileType): boolean {
    if (!attachment || typeof attachment !== 'object') return false;
    const filename = String(attachment.filename || '').toLowerCase();
    const mimeType = String(attachment.mime_type || '').toLowerCase();
    const matchers = getAttachmentMatchersByType(fileType);
    return (
        matchers.filenamePatterns.some((pattern) => {
            const suffix = pattern.replace('%', '');
            return suffix ? filename.endsWith(suffix) : false;
        }) || matchers.mimeTypes.includes(mimeType)
    );
}

function buildTextSnippet(text: string | null | undefined, query?: string | null): string | null {
    const normalized = (text || '').trim();
    if (!normalized) return null;
    if (!query) {
        return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
    }

    const lowerText = normalized.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerText.indexOf(lowerQuery);
    if (idx < 0) {
        return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
    }

    const start = Math.max(0, idx - 70);
    const end = Math.min(normalized.length, idx + lowerQuery.length + 110);
    const piece = normalized.slice(start, end);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < normalized.length ? '...' : '';
    return `${prefix}${piece}${suffix}`;
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

export async function searchFriendZonePosts(
    viewerId: string,
    options: FriendZoneSearchOptions = {}
) {
    const limit = toLimit(options.limit, 20);
    const offset = toOffset(options.offset);
    const query = normalizeSearchQuery(options.q);
    const owner = normalizeSearchOwner(options.owner);
    const fileType = normalizeSearchFileType(options.type);
    const sinceDays = normalizeSinceDays(options.sinceDays);

    const params: any[] = [viewerId];
    const whereParts: string[] = [
        `(
            p.owner_id = $1
            OR (
                a.friend_zone_enabled = TRUE
                AND a.friend_zone_visibility = 'public'
            )
            OR (
                a.friend_zone_enabled = TRUE
                AND a.friend_zone_visibility = 'friends'
                AND f.agent_id IS NOT NULL
            )
        )`,
    ];

    if (owner) {
        params.push(owner);
        whereParts.push(`LOWER(a.agent_name) = LOWER($${params.length})`);
    }

    if (sinceDays !== null) {
        params.push(sinceDays);
        whereParts.push(`p.created_at >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }

    if (query) {
        params.push(`%${query.toLowerCase()}%`);
        const idx = params.length;
        whereParts.push(`(
            LOWER(COALESCE(p.text_content, '')) LIKE $${idx}
            OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(COALESCE(p.post_json->'attachments', '[]'::jsonb)) att
                WHERE LOWER(COALESCE(att->>'filename', '')) LIKE $${idx}
                   OR LOWER(COALESCE(att->>'mime_type', '')) LIKE $${idx}
            )
        )`);
    }

    if (fileType) {
        const matchers = getAttachmentMatchersByType(fileType);
        params.push(matchers.filenamePatterns);
        const filenameIdx = params.length;
        params.push(matchers.mimeTypes);
        const mimeIdx = params.length;
        whereParts.push(`EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(p.post_json->'attachments', '[]'::jsonb)) att
            WHERE LOWER(COALESCE(att->>'filename', '')) LIKE ANY($${filenameIdx}::text[])
               OR LOWER(COALESCE(att->>'mime_type', '')) = ANY($${mimeIdx}::text[])
        )`);
    }

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const { rows } = await pool.query(
        `SELECT
            p.id,
            p.owner_id,
            p.text_content,
            p.post_json,
            p.created_at,
            a.agent_name,
            a.display_name,
            CASE
                WHEN p.owner_id = $1 THEN 'self'
                WHEN a.friend_zone_visibility = 'public' THEN 'public'
                ELSE 'friend'
            END AS access,
            COUNT(*) OVER() AS total_count
         FROM friend_zone_posts p
         JOIN agents a ON a.id = p.owner_id
         LEFT JOIN friendships f
           ON f.agent_id = $1
          AND f.friend_id = p.owner_id
         WHERE ${whereParts.join('\n           AND ')}
         ORDER BY p.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
    );

    const total = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;
    const normalizedQuery = query ? query.toLowerCase() : null;

    const results = rows.map((row: any) => {
        const payload = row.post_json || {};
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const reasons: string[] = [];

        if (normalizedQuery) {
            const text = String(row.text_content || '').toLowerCase();
            if (text.includes(normalizedQuery)) {
                reasons.push('text');
            }
            const hitAttachment = attachments.some((item: any) => {
                const filename = String(item?.filename || '').toLowerCase();
                const mime = String(item?.mime_type || '').toLowerCase();
                return filename.includes(normalizedQuery) || mime.includes(normalizedQuery);
            });
            if (hitAttachment) {
                reasons.push('attachment');
            }
        }

        if (fileType && attachments.some((item: any) => attachmentMatchesType(item, fileType))) {
            reasons.push('file_type');
        }

        return {
            post_id: row.id,
            owner: {
                id: row.owner_id,
                agent_name: row.agent_name,
                display_name: row.display_name ?? null,
            },
            access: row.access as AccessLevel,
            created_at: row.created_at,
            text_snippet: buildTextSnippet(row.text_content, query),
            match_reasons: Array.from(new Set(reasons)),
            post_json: payload,
        };
    });

    return {
        filters: {
            q: query,
            owner,
            type: fileType,
            since_days: sinceDays,
        },
        paging: {
            limit,
            offset,
            total,
        },
        results,
    };
}
