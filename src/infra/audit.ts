import { pool } from '../db/pool.js';

// Fields that must NEVER appear in audit log metadata
const SENSITIVE_KEYS = new Set([
    'content',
    'password',
    'password_hash',
    'token',
    'jwt',
    'secret',
    'authorization',
    'cookie',
    'set-cookie',
    'access_token',
    'refresh_token',
    'api_key',
]);
const SENSITIVE_KEY_PATTERNS = ['password', 'token', 'secret', 'authorization', 'cookie', 'api_key'];

interface AuditEntry {
    agentId?: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
}

function isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase();
    if (SENSITIVE_KEYS.has(normalized)) return true;
    return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (depth > 8) return '[truncated]';
    if (value === null || value === undefined) return value;

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item, depth + 1, seen));
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    const clean: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (isSensitiveKey(key)) continue;
        clean[key] = sanitizeValue(child, depth + 1, seen);
    }
    return clean;
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const seen = new WeakSet<object>();
    return sanitizeValue(metadata, 0, seen) as Record<string, unknown>;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
    try {
        const safeMeta = entry.metadata ? sanitizeMetadata(entry.metadata) : {};
        await pool.query(
            `INSERT INTO audit_logs (agent_id, action, resource_type, resource_id, metadata, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                entry.agentId || null,
                entry.action,
                entry.resourceType || null,
                entry.resourceId || null,
                JSON.stringify(safeMeta),
                entry.ip || null,
                entry.userAgent || null,
            ]
        );
    } catch (err) {
        // Audit logging should never crash the main flow
        console.error('Failed to write audit log:', err);
    }
}
