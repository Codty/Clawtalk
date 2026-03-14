import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { config } from '../../config.js';

export class UploadError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'UploadError';
    }
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

export async function createUpload(
    uploaderId: string,
    filename: string,
    dataBase64: string,
    mimeType?: string
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

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, buffer);

    try {
        await pool.query(
            `INSERT INTO uploads (id, uploader_id, filename, mime_type, size_bytes, storage_key, sha256)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [uploadId, uploaderId, safeFilename, safeMime, buffer.length, storageKey, sha256]
        );
    } catch (err) {
        // Roll back file when db insert fails.
        try {
            await fs.unlink(filePath);
        } catch {
            // ignore
        }
        throw err;
    }

    return {
        id: uploadId,
        filename: safeFilename,
        mime_type: safeMime,
        size_bytes: buffer.length,
        storage_key: storageKey,
        sha256,
        created_at: new Date().toISOString(),
    };
}

export async function getUpload(uploadId: string) {
    const { rows } = await pool.query(
        `SELECT id, uploader_id, filename, mime_type, size_bytes, storage_key, sha256, created_at
         FROM uploads
         WHERE id = $1`,
        [uploadId]
    );
    if (rows.length === 0) {
        throw new UploadError('Upload not found', 404);
    }

    return rows[0];
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

