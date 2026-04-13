import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { redis } from '../../infra/redis.js';

export class UploadError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'UploadError';
    }
}

type UploadStorageMode = 'persistent' | 'relay';

interface CreateUploadOptions {
    storageMode?: UploadStorageMode;
    relayTtlHours?: number;
    maxDownloads?: number;
}

function sanitizeFilename(filename: string): string {
    const base = path.basename(filename || 'attachment');
    const cleaned = base.replace(/[^\w.\- ]/g, '_').trim();
    return cleaned || 'attachment';
}

function ensureMimeType(value?: string): string {
    if (value && value.trim()) return value.trim();
    return 'application/octet-stream';
}

function toAbsoluteUploadDir(): string {
    return path.isAbsolute(config.uploadDir)
        ? config.uploadDir
        : path.resolve(process.cwd(), config.uploadDir);
}

function normalizeStorageMode(value?: string): UploadStorageMode {
    return value === 'relay' ? 'relay' : 'persistent';
}

function normalizeRelayTtlHours(value?: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    return Math.max(1, config.uploadRelayTtlHours);
}

function normalizeMaxDownloads(value?: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    return Math.max(1, config.uploadRelayMaxDownloads);
}

function nowIso(): string {
    return new Date().toISOString();
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRelayUnavailable(row: any): { unavailable: boolean; reason?: string } {
    if (row.storage_mode !== 'relay') return { unavailable: false };

    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        return { unavailable: true, reason: 'Upload relay link expired' };
    }

    const maxDownloads = row.max_downloads ? Number(row.max_downloads) : null;
    const downloadCount = row.download_count ? Number(row.download_count) : 0;
    if (maxDownloads && downloadCount >= maxDownloads) {
        return { unavailable: true, reason: 'Upload relay link reached maximum downloads' };
    }

    return { unavailable: false };
}

async function deleteUploadFile(storageKey: string): Promise<void> {
    const dir = toAbsoluteUploadDir();
    const filePath = path.join(dir, storageKey);
    try {
        await fs.unlink(filePath);
    } catch {
        // Ignore missing files.
    }
}

export async function createUpload(
    uploaderId: string,
    filename: string,
    dataBase64: string,
    mimeType?: string,
    options: CreateUploadOptions = {}
) {
    if (!filename || filename.trim().length === 0) {
        throw new UploadError('filename is required', 400);
    }
    if (!dataBase64 || dataBase64.trim().length === 0) {
        throw new UploadError('data_base64 is required', 400);
    }

    let buffer: Buffer;
    try {
        buffer = Buffer.from(dataBase64, 'base64');
    } catch {
        throw new UploadError('Invalid base64 data', 400);
    }

    if (!buffer || buffer.length === 0) {
        throw new UploadError('Decoded file is empty', 400);
    }
    if (buffer.length > config.uploadMaxBytes) {
        throw new UploadError(`File too large. Max ${config.uploadMaxBytes} bytes`, 413);
    }

    const safeFilename = sanitizeFilename(filename);
    const safeMime = ensureMimeType(mimeType);
    const uploadId = randomUUID();
    const ext = path.extname(safeFilename);
    const storageKey = ext ? `${uploadId}${ext}` : uploadId;
    const dir = toAbsoluteUploadDir();
    const filePath = path.join(dir, storageKey);
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    const storageMode = normalizeStorageMode(options.storageMode);
    const relayTtlHours = storageMode === 'relay' ? normalizeRelayTtlHours(options.relayTtlHours) : null;
    const maxDownloads = storageMode === 'relay' ? normalizeMaxDownloads(options.maxDownloads) : null;
    const expiresAt = storageMode === 'relay' && relayTtlHours
        ? new Date(Date.now() + relayTtlHours * 60 * 60 * 1000)
        : null;

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, buffer);

    try {
        await pool.query(
            `INSERT INTO uploads (
                id,
                uploader_id,
                filename,
                mime_type,
                size_bytes,
                storage_key,
                sha256,
                storage_mode,
                expires_at,
                max_downloads
            )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                uploadId,
                uploaderId,
                safeFilename,
                safeMime,
                buffer.length,
                storageKey,
                sha256,
                storageMode,
                expiresAt,
                maxDownloads,
            ]
        );
    } catch (err) {
        // Roll back file when db insert fails.
        await deleteUploadFile(storageKey);
        throw err;
    }

    const upload = await getUpload(uploadId);
    return upload;
}

export async function getUpload(uploadId: string) {
    if (!isUuid(uploadId)) {
        throw new UploadError('Invalid upload id', 400);
    }

    const { rows } = await pool.query(
        `SELECT id,
                uploader_id,
                filename,
                mime_type,
                size_bytes,
                storage_key,
                sha256,
                storage_mode,
                expires_at,
                max_downloads,
                download_count,
                last_downloaded_at,
                created_at
         FROM uploads
         WHERE id = $1`,
        [uploadId]
    );
    if (rows.length === 0) {
        throw new UploadError('Upload not found', 404);
    }

    return rows[0];
}

async function hasConversationAttachmentAccess(uploadId: string, viewerId: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        `SELECT 1
         FROM message_attachments ma
         JOIN messages m ON m.id = ma.message_id
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
         WHERE cm.agent_id = $2
           AND m.deleted_at IS NULL
           AND (
                ma.metadata->>'upload_id' = $1
                OR substring(ma.url from '/api/v1/uploads/([^/?#]+)') = $1
           )
         LIMIT 1`,
        [uploadId, viewerId]
    );
    return (rowCount || 0) > 0;
}

function parseStreamFields(fields: string[]): Record<string, string> {
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
        data[fields[i]] = fields[i + 1];
    }
    return data;
}

function extractUploadIdFromAttachment(attachment: any): string | null {
    if (!attachment || typeof attachment !== 'object') return null;

    const metadataUploadId = attachment.metadata?.upload_id;
    if (typeof metadataUploadId === 'string' && metadataUploadId.trim().length > 0) {
        return metadataUploadId.trim();
    }

    const directUploadId = attachment.upload_id;
    if (typeof directUploadId === 'string' && directUploadId.trim().length > 0) {
        return directUploadId.trim();
    }

    const url = typeof attachment.url === 'string' ? attachment.url : '';
    const match = url.match(/\/api\/v1\/uploads\/([0-9a-f-]{36})(?:[/?#]|$)/i);
    if (match?.[1]) {
        return match[1];
    }

    return null;
}

function payloadContainsUploadId(payload: any, uploadId: string): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const attachments = payload?.data?.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) return false;

    return attachments.some((attachment) => extractUploadIdFromAttachment(attachment) === uploadId);
}

async function hasLocalOnlyDmAttachmentAccess(uploadId: string, viewerId: string, uploaderId: string): Promise<boolean> {
    if (config.messageStorageMode !== 'local_only') return false;

    const { rows: dmRows } = await pool.query(
        `SELECT DISTINCT c.id
         FROM conversations c
         JOIN conversation_members cm_viewer
           ON cm_viewer.conversation_id = c.id
          AND cm_viewer.agent_id = $1
         JOIN conversation_members cm_uploader
           ON cm_uploader.conversation_id = c.id
          AND cm_uploader.agent_id = $2
         WHERE c.type = 'dm'`,
        [viewerId, uploaderId]
    );
    if (dmRows.length === 0) return false;

    const scanCount = Math.max(500, Math.min(10000, config.realtimeStreamMaxLen || 5000));
    for (const row of dmRows) {
        const streamKey = `stream:conv:${row.id}`;
        let entries: any[] = [];
        try {
            const raw = await (redis as any).xrevrange(streamKey, '+', '-', 'COUNT', scanCount);
            entries = Array.isArray(raw) ? raw : [];
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const rawFields = entry[1];
            if (!Array.isArray(rawFields)) continue;
            const fields = parseStreamFields(rawFields as string[]);
            const senderId = String(fields.sender_id || '');
            if (senderId !== uploaderId) continue;
            if (!fields.payload) continue;

            let payload: any = null;
            try {
                payload = JSON.parse(fields.payload);
            } catch {
                payload = null;
            }

            if (payloadContainsUploadId(payload, uploadId)) {
                return true;
            }
        }
    }

    return false;
}

async function hasFriendZoneAttachmentAccess(uploadId: string, viewerId: string): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT p.owner_id,
                a.friend_zone_enabled,
                a.friend_zone_visibility
         FROM friend_zone_posts p
         JOIN agents a ON a.id = p.owner_id
         WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(p.post_json->'attachments', '[]'::jsonb)) att
            WHERE att->>'upload_id' = $1
         )
         ORDER BY p.created_at DESC`,
        [uploadId]
    );

    for (const row of rows) {
        if (row.owner_id === viewerId) {
            return true;
        }

        if (!row.friend_zone_enabled) {
            continue;
        }

        if (row.friend_zone_visibility === 'public') {
            return true;
        }

        if (row.friend_zone_visibility === 'friends') {
            const { rowCount } = await pool.query(
                `SELECT 1
                 FROM friendships
                 WHERE agent_id = $1 AND friend_id = $2
                 LIMIT 1`,
                [viewerId, row.owner_id]
            );
            if ((rowCount || 0) > 0) {
                return true;
            }
        }
    }

    return false;
}

async function assertUploadDownloadAccess(uploadId: string, viewerId: string, uploaderId: string): Promise<void> {
    if (viewerId === uploaderId) return;

    if (await hasConversationAttachmentAccess(uploadId, viewerId)) return;
    if (await hasLocalOnlyDmAttachmentAccess(uploadId, viewerId, uploaderId)) return;
    if (await hasFriendZoneAttachmentAccess(uploadId, viewerId)) return;

    throw new UploadError('Not authorized to download this upload', 403);
}

export async function getUploadForDownload(uploadId: string, viewerId: string) {
    if (!isUuid(uploadId)) {
        throw new UploadError('Invalid upload id', 400);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            `SELECT id,
                    uploader_id,
                    filename,
                    mime_type,
                    size_bytes,
                    storage_key,
                    sha256,
                    storage_mode,
                    expires_at,
                    max_downloads,
                    download_count,
                    last_downloaded_at,
                    created_at
             FROM uploads
             WHERE id = $1
             FOR UPDATE`,
            [uploadId]
        );

        if (rows.length === 0) {
            throw new UploadError('Upload not found', 404);
        }

        let row = rows[0];
        await assertUploadDownloadAccess(uploadId, viewerId, row.uploader_id);
        const relayState = isRelayUnavailable(row);
        if (relayState.unavailable) {
            throw new UploadError(relayState.reason || 'Upload is unavailable', 410);
        }

        if (row.storage_mode === 'relay') {
            const { rows: updatedRows } = await client.query(
                `UPDATE uploads
                 SET download_count = download_count + 1,
                     last_downloaded_at = NOW(),
                     expires_at = CASE
                         WHEN max_downloads IS NOT NULL AND download_count + 1 >= max_downloads
                             THEN COALESCE(expires_at, NOW())
                         ELSE expires_at
                     END
                 WHERE id = $1
                 RETURNING id,
                           uploader_id,
                           filename,
                           mime_type,
                           size_bytes,
                           storage_key,
                           sha256,
                           storage_mode,
                           expires_at,
                           max_downloads,
                           download_count,
                           last_downloaded_at,
                           created_at`,
                [uploadId]
            );
            row = updatedRows[0];
        }

        await client.query('COMMIT');
        return row;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // no-op
        }
        throw err;
    } finally {
        client.release();
    }
}

export async function readUploadBuffer(storageKey: string): Promise<Buffer> {
    const dir = toAbsoluteUploadDir();
    const filePath = path.join(dir, storageKey);
    try {
        return await fs.readFile(filePath);
    } catch {
        throw new UploadError('Upload file missing', 404);
    }
}

export async function purgeExpiredRelayUploads(limit = 500): Promise<number> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;

    const { rows: candidates } = await pool.query(
        `SELECT id, storage_key
         FROM uploads
         WHERE storage_mode = 'relay'
           AND (
             (expires_at IS NOT NULL AND expires_at <= NOW())
             OR (max_downloads IS NOT NULL AND download_count >= max_downloads)
           )
         ORDER BY COALESCE(expires_at, created_at) ASC
         LIMIT $1`,
        [safeLimit]
    );

    if (candidates.length === 0) {
        return 0;
    }

    const ids = candidates.map((row: any) => row.id);
    const storageKeys = candidates.map((row: any) => row.storage_key);

    await pool.query(
        `DELETE FROM uploads
         WHERE id = ANY($1::uuid[])`,
        [ids]
    );

    for (const key of storageKeys) {
        await deleteUploadFile(key);
    }

    return ids.length;
}

export function buildUploadContentDisposition(filename: string): string {
    return `attachment; filename="${encodeURIComponent(filename)}"`;
}

export function toUploadPublicView(upload: any): any {
    return {
        id: upload.id,
        uploader_id: upload.uploader_id,
        filename: upload.filename,
        mime_type: upload.mime_type,
        size_bytes: Number(upload.size_bytes || 0),
        storage_mode: upload.storage_mode || 'persistent',
        expires_at: upload.expires_at ? new Date(upload.expires_at).toISOString() : null,
        max_downloads: upload.max_downloads ? Number(upload.max_downloads) : null,
        download_count: Number(upload.download_count || 0),
        last_downloaded_at: upload.last_downloaded_at ? new Date(upload.last_downloaded_at).toISOString() : null,
        created_at: upload.created_at ? new Date(upload.created_at).toISOString() : nowIso(),
    };
}
