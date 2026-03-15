function parseList(value?: string): string[] {
    if (!value) return [];
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    return value === 'true';
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
    const parsed = parseInt(value || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
    return parsed;
}

function parseFanoutMode(value: string | undefined): 'pubsub' | 'single_stream' {
    const mode = (value || 'pubsub').trim().toLowerCase();
    if (mode === 'pubsub' || mode === 'single_stream') {
        return mode;
    }
    throw new Error(`Invalid FANOUT_MODE="${value}". Use "pubsub" or "single_stream".`);
}

function parseMessageStorageMode(value: string | undefined): 'server' | 'local_only' {
    const mode = (value || 'server').trim().toLowerCase();
    if (mode === 'server' || mode === 'local_only') {
        return mode;
    }
    throw new Error(`Invalid MESSAGE_STORAGE_MODE="${value}". Use "server" or "local_only".`);
}

function isStrongJwtSecret(secret: string): boolean {
    if (secret.length < 32) return false;
    const weakMarkers = ['change-me', 'dev-secret', 'secret123', 'default', 'example'];
    const normalized = secret.toLowerCase();
    return !weakMarkers.some((marker) => normalized.includes(marker));
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const corsAllowedOrigins = parseList(process.env.CORS_ALLOWED_ORIGINS);
const corsAllowAll = parseBool(process.env.CORS_ALLOW_ALL, !isProduction);
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me-in-production!!';
const fanoutMode = parseFanoutMode(process.env.FANOUT_MODE);
const messageStorageMode = parseMessageStorageMode(process.env.MESSAGE_STORAGE_MODE);

if (isProduction) {
    if (!isStrongJwtSecret(jwtSecret)) {
        throw new Error('JWT_SECRET is missing or weak. Use a random secret with at least 32 characters.');
    }
    if (corsAllowAll) {
        throw new Error('CORS_ALLOW_ALL must be false in production.');
    }
    if (corsAllowedOrigins.length === 0) {
        throw new Error('CORS_ALLOWED_ORIGINS must be set in production.');
    }
}

export const config = {
    nodeEnv,
    isProduction,
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',

    databaseUrl: process.env.DATABASE_URL || 'postgresql://agent_social:agent_social_pwd@localhost:15432/agent_social',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6380',

    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    wsTokenTtlSec: parseInt(process.env.WS_TOKEN_TTL_SEC || '120', 10),
    wsTokenIssuer: process.env.WS_TOKEN_ISSUER || 'agent-social',
    adminBootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN || '',
    fanoutMode,
    messageStorageMode,
    realtimeChannelPrefix: process.env.REALTIME_CHANNEL_PREFIX || 'realtime:conv:',
    realtimeStreamMaxLen: parsePositiveInt(process.env.REALTIME_STREAM_MAXLEN, 5000),

    // Global default rate limit
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),

    // Per-route rate limits
    rateLimitSendMsg: parseInt(process.env.RATE_LIMIT_SEND_MSG || '30', 10),
    rateLimitReadMsg: parseInt(process.env.RATE_LIMIT_READ_MSG || '120', 10),
    rateLimitAuth: parseInt(process.env.RATE_LIMIT_AUTH || '10', 10),
    rateLimitWs: parseInt(process.env.RATE_LIMIT_WS || '5', 10),
    authFailMaxCombo: parseInt(process.env.AUTH_FAIL_MAX_COMBO || '5', 10),
    authFailMaxIp: parseInt(process.env.AUTH_FAIL_MAX_IP || '20', 10),
    authFailWindowSec: parseInt(process.env.AUTH_FAIL_WINDOW_SEC || '300', 10),
    authLockSec: parseInt(process.env.AUTH_LOCK_SEC || '900', 10),

    // Default spam protection (overridden by conversation policy)
    spamMaxPerConv: parseInt(process.env.SPAM_MAX_PER_CONV || '10', 10),
    spamWindowSec: parseInt(process.env.SPAM_WINDOW_SEC || '10', 10),

    messageTtlDays: parseInt(process.env.MESSAGE_TTL_DAYS || '3', 10),
    messageRecallWindowMinutes: parseInt(process.env.MESSAGE_RECALL_WINDOW_MINUTES || '15', 10),
    runMigrationsOnStart: parseBool(process.env.RUN_MIGRATIONS_ON_START, false),
    corsAllowAll,
    corsAllowedOrigins,
    metricsAuthToken: process.env.METRICS_AUTH_TOKEN || '',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    uploadDir: process.env.UPLOAD_DIR || './data/uploads',
    uploadMaxBytes: parsePositiveInt(process.env.UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
    uploadRelayTtlHours: parsePositiveInt(process.env.UPLOAD_RELAY_TTL_HOURS, 72),
    uploadRelayMaxDownloads: parsePositiveInt(process.env.UPLOAD_RELAY_MAX_DOWNLOADS, 5),

    // Consumer group (Redis Streams)
    consumerGroup: process.env.CONSUMER_GROUP || 'agent-social-cg',
    consumerId: process.env.CONSUMER_ID || `consumer-${process.pid}`,

    // Default conversation policy
    defaultPolicy: {
        retention_days: parseInt(process.env.DEFAULT_RETENTION_DAYS || '3', 10),
        allow_types: ['text', 'tool_call', 'event', 'media'],
        spam_max_per_window: parseInt(process.env.SPAM_MAX_PER_CONV || '10', 10),
        spam_window_sec: parseInt(process.env.SPAM_WINDOW_SEC || '10', 10),
    },

    // Presence TTL (seconds)
    presenceTtlSec: parseInt(process.env.PRESENCE_TTL_SEC || '90', 10),
};

export interface ConversationPolicy {
    retention_days?: number;
    allow_types?: string[];
    spam_max_per_window?: number;
    spam_window_sec?: number;
}

export interface MessageEnvelope {
    type: 'text' | 'tool_call' | 'event' | 'media';
    content?: string;
    data?: any;
}

export const VALID_ENVELOPE_TYPES = new Set(['text', 'tool_call', 'event', 'media']);
