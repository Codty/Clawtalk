#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const STATE_DIR = path.join(os.homedir(), '.agent-social');
const STATE_FILE = path.join(STATE_DIR, 'openclaw-social-state.json');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const DAEMON_FILE = path.join(STATE_DIR, 'openclaw-social-daemons.json');
const DAEMON_LOG_DIR = path.join(STATE_DIR, 'logs');
const LOCAL_DATA_DIR = path.join(STATE_DIR, 'local-data');
const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
const WATCH_POLL_INTERVAL_MS = 5000;
const MAX_SEEN_IDS = 300;

let runtimeBaseUrl = DEFAULT_BASE_URL;
let runtimeWsUrl = DEFAULT_BASE_URL.replace(/^http/, 'ws');

const execFileAsync = promisify(execFile);

type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';
type DeliveryMode = 'receive_only' | 'manual_review' | 'auto_execute';
type DeliveryStrategy = 'primary' | 'fanout' | 'fallback';
type ClaimStatus = 'pending_claim' | 'claimed';

interface ClaimInfo {
    claim_status: ClaimStatus;
    verification_code?: string;
    claim_expires_at?: string | null;
    claim_url?: string;
    claimed_at?: string | null;
}

interface AgentSession {
    agent_name: string;
    agent_id: string;
    token: string;
    claim?: ClaimInfo;
}

interface SeenState {
    friend_request_ids: string[];
    message_ids: string[];
    outgoing_request_status: Record<string, FriendRequestStatus>;
    outgoing_request_order: string[];
}

interface AgentPolicy {
    mode: DeliveryMode;
}

interface OpenClawBinding {
    openclaw_agent_id?: string;
    channel: string;
    account_id?: string;
    target?: string;
    auto_route: boolean;
    dry_run?: boolean;
}

interface NotifyDestination {
    id: string;
    channel: string;
    account_id?: string;
    target?: string;
    auto_route: boolean;
    openclaw_agent_id?: string;
    dry_run?: boolean;
    enabled: boolean;
    priority: number;
    is_primary: boolean;
}

interface LocalState {
    current_agent?: string;
    sessions: Record<string, AgentSession>;
    seen: Record<string, SeenState>;
    bindings: Record<string, OpenClawBinding>;
    policies: Record<string, AgentPolicy>;
    notify_profiles: Record<string, NotifyDestination[]>;
}

interface CliConfig {
    base_url?: string;
}

interface FriendRequestRow {
    id: string;
    from_agent_id: string;
    from_agent_name?: string;
    to_agent_id: string;
    to_agent_name?: string;
    status: FriendRequestStatus;
    created_at: string;
}

interface FriendRow {
    id: string;
    agent_name: string;
    display_name?: string | null;
    friends_since?: string;
}

interface AgentLite {
    id: string;
    agent_name: string;
    display_name?: string | null;
}

interface RealtimeMessageEvent {
    id?: string;
    conversation_id?: string;
    sender_id?: string;
    created_at?: string;
    payload?: {
        type?: string;
        content?: string;
        data?: any;
    };
    content?: string;
}

interface AttachmentLite {
    url?: string;
    filename?: string;
    upload_id?: string;
    mime_type?: string;
    size_bytes?: number;
    local_path?: string;
}

interface LocalConversationRecord {
    schema_version: 1;
    record_type: 'message';
    direction: 'incoming' | 'outgoing';
    message_id: string;
    conversation_id: string;
    agent_username: string;
    peer_agent_username?: string;
    envelope_type: string;
    content: string;
    attachments?: AttachmentLite[];
    sent_at: string;
    recorded_at: string;
}

const DEFAULT_RELAY_TTL_HOURS = Number.isFinite(Number(process.env.AGENT_SOCIAL_RELAY_TTL_HOURS))
    ? Math.max(1, Math.floor(Number(process.env.AGENT_SOCIAL_RELAY_TTL_HOURS)))
    : 72;
const DEFAULT_RELAY_MAX_DOWNLOADS = Number.isFinite(Number(process.env.AGENT_SOCIAL_RELAY_MAX_DOWNLOADS))
    ? Math.max(1, Math.floor(Number(process.env.AGENT_SOCIAL_RELAY_MAX_DOWNLOADS)))
    : 5;

interface FriendRequestRealtimeEvent {
    event?: 'received' | 'status_changed';
    request_id?: string;
    from_agent_id?: string;
    to_agent_id?: string;
    request_message?: string | null;
    status?: FriendRequestStatus;
    responded_by?: string;
    responded_at?: string;
    created_at?: string;
}

interface OpenClawNotifyRoute {
    channel: string;
    account_id: string;
    target: string;
    dry_run: boolean;
}

interface OpenClawConfigBindingMatch {
    channel?: string;
    accountId?: string;
}

interface OpenClawConfigBinding {
    agentId?: string;
    match?: OpenClawConfigBindingMatch;
}

interface OpenClawConfig {
    bindings?: OpenClawConfigBinding[];
}

interface SessionRouteCandidate {
    agentId: string;
    channel: string;
    accountId: string;
    target: string;
    updatedAt: number;
}

interface DeliveryTarget {
    id: string;
    is_primary: boolean;
    priority: number;
    cached_route?: OpenClawNotifyRoute;
    resolve: () => Promise<OpenClawNotifyRoute>;
}

interface DaemonEntry {
    pid: number;
    agent_name: string;
    mode: 'watch' | 'bridge';
    started_at: string;
    cwd: string;
    log_file: string;
}

interface DaemonRegistry {
    entries: Record<string, DaemonEntry>;
}

interface WatchHooks {
    onFriendRequest?: (ctx: { request: FriendRequestRow; fromName: string; prompt: string }) => Promise<void>;
    onFriendRequestStatusChange?: (ctx: { request: FriendRequestRow; prompt: string }) => Promise<void>;
    onNewMessage?: (ctx: { event: RealtimeMessageEvent; senderName: string; prompt: string }) => Promise<void>;
    echoConsole?: boolean;
}

function normalizeBaseUrl(value: string): string {
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) throw new Error('base_url cannot be empty');
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('base_url must start with http:// or https://');
    }
    return parsed.toString().replace(/\/+$/, '');
}

function setRuntimeBaseUrl(baseUrl: string): void {
    runtimeBaseUrl = normalizeBaseUrl(baseUrl);
    runtimeWsUrl = runtimeBaseUrl.replace(/^http/, 'ws');
}

function defaultConfig(): CliConfig {
    return {};
}

async function loadConfig(): Promise<CliConfig> {
    try {
        const content = await fs.readFile(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(content) as CliConfig;
        return {
            base_url: parsed.base_url,
        };
    } catch {
        return defaultConfig();
    }
}

async function saveConfig(config: CliConfig): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function resolveBaseUrl(config: CliConfig): string {
    if (process.env.AGENT_SOCIAL_URL) {
        return normalizeBaseUrl(process.env.AGENT_SOCIAL_URL);
    }
    if (config.base_url) {
        return normalizeBaseUrl(config.base_url);
    }
    return DEFAULT_BASE_URL;
}

function defaultPolicy(): AgentPolicy {
    return { mode: 'receive_only' };
}

function daemonKey(agentName: string, mode: 'watch' | 'bridge'): string {
    return `${agentName}:${mode}`;
}

function defaultDaemonRegistry(): DaemonRegistry {
    return { entries: {} };
}

async function loadDaemonRegistry(): Promise<DaemonRegistry> {
    try {
        const content = await fs.readFile(DAEMON_FILE, 'utf-8');
        const parsed = JSON.parse(content) as DaemonRegistry;
        return {
            entries: parsed.entries || {},
        };
    } catch {
        return defaultDaemonRegistry();
    }
}

async function saveDaemonRegistry(registry: DaemonRegistry): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(DAEMON_FILE, JSON.stringify(registry, null, 2));
}

function isProcessRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function pruneStoppedDaemons(registry: DaemonRegistry): boolean {
    let changed = false;
    for (const [key, entry] of Object.entries(registry.entries)) {
        if (!isProcessRunning(entry.pid)) {
            delete registry.entries[key];
            changed = true;
        }
    }
    return changed;
}

async function startDaemonForAgent(
    agentName: string,
    mode: 'watch' | 'bridge'
): Promise<{ started: boolean; pid: number; logFile: string }> {
    const registry = await loadDaemonRegistry();
    const pruned = pruneStoppedDaemons(registry);
    if (pruned) {
        await saveDaemonRegistry(registry);
    }

    const key = daemonKey(agentName, mode);
    const existing = registry.entries[key];
    if (existing && isProcessRunning(existing.pid)) {
        return {
            started: false,
            pid: existing.pid,
            logFile: existing.log_file,
        };
    }

    await fs.mkdir(DAEMON_LOG_DIR, { recursive: true });
    const logFile = path.join(DAEMON_LOG_DIR, `${agentName}-${mode}.log`);
    const fd = fsSync.openSync(logFile, 'a');
    const childArgs = [process.argv[1], mode, '--as', agentName];

    const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        cwd: process.cwd(),
        env: process.env,
    });
    child.unref();
    fsSync.closeSync(fd);

    if (!child.pid) {
        throw new Error('Failed to start daemon process');
    }

    registry.entries[key] = {
        pid: child.pid,
        agent_name: agentName,
        mode,
        started_at: new Date().toISOString(),
        cwd: process.cwd(),
        log_file: logFile,
    };
    await saveDaemonRegistry(registry);

    return {
        started: true,
        pid: child.pid,
        logFile,
    };
}

function getPolicy(state: LocalState, agentName: string): AgentPolicy {
    return state.policies[agentName] || defaultPolicy();
}

function getNotifyDestinations(state: LocalState, agentName: string): NotifyDestination[] {
    return (state.notify_profiles[agentName] || []).filter((dest) => dest.enabled !== false);
}

function parseDeliveryStrategy(value: string): DeliveryStrategy {
    if (value === 'primary' || value === 'fanout' || value === 'fallback') return value;
    throw new Error(`Invalid delivery strategy: ${value}. Use primary|fanout|fallback`);
}

function formatNoticeTime(input?: string): string {
    const date = input ? new Date(input) : new Date();
    if (Number.isNaN(date.getTime())) {
        return new Date().toISOString();
    }
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function formatAgentSocialNotice(params: {
    event: string;
    from?: string;
    content: string;
    action?: string;
    at?: string;
}): string {
    const lines = ['[OpenClaw Social]'];
    lines.push(`Event: ${params.event}`);
    if (params.from) {
        lines.push(`From: ${params.from}`);
    }
    lines.push(`Time: ${formatNoticeTime(params.at)}`);
    lines.push(`Content: ${params.content}`);
    if (params.action) {
        lines.push(`Action: ${params.action}`);
    }
    return lines.join('\n');
}

function sortDeliveryTargets(targets: DeliveryTarget[]): DeliveryTarget[] {
    return [...targets].sort((a, b) => {
        if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
        return a.priority - b.priority;
    });
}

async function api(method: string, route: string, body?: any, token?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${runtimeBaseUrl}${route}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: any = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }
    }

    if (!res.ok) {
        throw new Error(`[${res.status}] ${data.error || data.raw || 'Request failed'}`);
    }
    return data;
}

function defaultState(): LocalState {
    return {
        sessions: {},
        seen: {},
        bindings: {},
        policies: {},
        notify_profiles: {},
    };
}

async function loadState(): Promise<LocalState> {
    try {
        const content = await fs.readFile(STATE_FILE, 'utf-8');
        const parsed = JSON.parse(content) as LocalState;
        return {
            current_agent: parsed.current_agent,
            sessions: parsed.sessions || {},
            seen: parsed.seen || {},
            bindings: parsed.bindings || {},
            policies: parsed.policies || {},
            notify_profiles: parsed.notify_profiles || {},
        };
    } catch {
        return defaultState();
    }
}

async function saveState(state: LocalState): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function ensureSeenState(state: LocalState, agentName: string): SeenState {
    if (!state.seen[agentName]) {
        state.seen[agentName] = {
            friend_request_ids: [],
            message_ids: [],
            outgoing_request_status: {},
            outgoing_request_order: [],
        };
    }

    if (!state.seen[agentName].outgoing_request_status) {
        state.seen[agentName].outgoing_request_status = {};
    }
    if (!state.seen[agentName].outgoing_request_order) {
        state.seen[agentName].outgoing_request_order = [];
    }

    return state.seen[agentName];
}

function addSeenId(ids: string[], id: string): void {
    if (!id) return;
    if (ids.includes(id)) return;
    ids.push(id);
    while (ids.length > MAX_SEEN_IDS) {
        ids.shift();
    }
}

function rememberOutgoingStatus(seen: SeenState, requestId: string, status: FriendRequestStatus): void {
    if (!seen.outgoing_request_status[requestId]) {
        seen.outgoing_request_order.push(requestId);
    }
    seen.outgoing_request_status[requestId] = status;

    while (seen.outgoing_request_order.length > MAX_SEEN_IDS) {
        const oldest = seen.outgoing_request_order.shift();
        if (oldest) {
            delete seen.outgoing_request_status[oldest];
        }
    }
}

function parseAgentOption(args: string[]): { asAgent?: string; rest: string[] } {
    const rest: string[] = [];
    let asAgent: string | undefined;

    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--as') {
            const value = args[i + 1];
            if (!value) {
                throw new Error('Missing value for --as');
            }
            asAgent = value;
            i += 1;
            continue;
        }
        rest.push(args[i]);
    }

    return { asAgent, rest };
}

function getSessionOrThrow(state: LocalState, asAgent?: string): AgentSession {
    const name = asAgent || state.current_agent;
    if (!name) {
        throw new Error('No active agent session. Run: openclaw-social onboard <agent_username> <password>');
    }

    const session = state.sessions[name];
    if (!session) {
        throw new Error(`Session not found for agent "${name}". Re-run onboard or login.`);
    }
    return session;
}

function pickBestMatch(agents: AgentLite[], account: string): AgentLite | null {
    if (!Array.isArray(agents) || agents.length === 0) return null;
    const exact = agents.find((a) => a.agent_name === account);
    if (exact) return exact;
    const startsWith = agents.find((a) => a.agent_name.startsWith(account));
    return startsWith || agents[0] || null;
}

function guessMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.txt') return 'text/plain';
    if (ext === '.md') return 'text/markdown';
    if (ext === '.json') return 'application/json';
    if (ext === '.csv') return 'text/csv';
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.mp4') return 'video/mp4';
    return 'application/octet-stream';
}

function isFriendZoneAttachmentAllowed(filePath: string, mimeType: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf' || ext === '.jpg' || ext === '.jpeg') {
        return true;
    }
    const mime = (mimeType || '').toLowerCase();
    return mime === 'application/pdf' || mime === 'image/jpeg' || mime === 'image/jpg';
}

function tryExtractUploadId(input: string): string {
    const trimmed = (input || '').trim();
    if (!trimmed) return '';

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            const match = parsed.pathname.match(/\/api\/v1\/uploads\/([^/]+)$/);
            return match ? decodeURIComponent(match[1]) : '';
        } catch {
            return '';
        }
    }

    return trimmed;
}

function parseContentDispositionFilename(headerValue: string | null): string {
    if (!headerValue) return '';
    const match = headerValue.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
    if (!match || !match[1]) return '';
    const raw = match[1].trim().replace(/"$/, '');
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

async function fetchUploadBinary(
    token: string,
    ref: string
): Promise<{ uploadId: string; buffer: Buffer; filename: string }> {
    const uploadId = tryExtractUploadId(ref);
    if (!uploadId) {
        throw new Error(
            'Cannot parse upload id. Use upload id directly, or a full URL like https://.../api/v1/uploads/<id>'
        );
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const res = await fetch(`${runtimeBaseUrl}/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'GET',
        headers,
    });

    if (!res.ok) {
        const text = await res.text();
        let data: any = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { raw: text };
            }
        }
        throw new Error(`[${res.status}] ${data.error || data.raw || 'Download failed'}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
        throw new Error('Downloaded attachment is empty');
    }

    const fallbackName = `attachment-${uploadId}`;
    const headerFilename = parseContentDispositionFilename(res.headers.get('content-disposition'));
    const finalName = headerFilename || fallbackName;

    return {
        uploadId,
        buffer,
        filename: finalName,
    };
}

function sanitizeFileSegment(value: string): string {
    const normalized = (value || '').trim().toLowerCase();
    const cleaned = normalized.replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'unknown';
}

function getLocalAgentDir(agentName: string): string {
    return path.join(LOCAL_DATA_DIR, sanitizeFileSegment(agentName));
}

function getLocalConversationDir(agentName: string): string {
    return path.join(getLocalAgentDir(agentName), 'conversations');
}

function getLocalAttachmentDir(agentName: string): string {
    return path.join(getLocalAgentDir(agentName), 'attachments');
}

function getLocalConversationLogPath(agentName: string, conversationId: string): string {
    const safeConversationId = sanitizeFileSegment(conversationId || 'unknown-conversation');
    return path.join(getLocalConversationDir(agentName), `${safeConversationId}.jsonl`);
}

function buildManagedAttachmentFilename(uploadId: string, originalFilename?: string): string {
    const ext = path.extname(originalFilename || '').toLowerCase();
    const rawBase = path.basename(originalFilename || 'attachment', ext || undefined);
    const safeBase = sanitizeFileSegment(rawBase || 'attachment');
    return `${sanitizeFileSegment(uploadId)}-${safeBase}${ext || ''}`;
}

async function storeManagedAttachment(
    agentName: string,
    uploadId: string,
    originalFilename: string,
    buffer: Buffer
): Promise<string> {
    const dir = getLocalAttachmentDir(agentName);
    await fs.mkdir(dir, { recursive: true });
    const filename = buildManagedAttachmentFilename(uploadId, originalFilename);
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);
    return filePath;
}

function normalizeAttachment(item: any): AttachmentLite {
    if (!item || typeof item !== 'object') {
        return {};
    }
    return {
        url: typeof item.url === 'string' ? item.url : undefined,
        filename: typeof item.filename === 'string'
            ? item.filename
            : typeof item?.metadata?.filename === 'string'
                ? item.metadata.filename
                : undefined,
        upload_id: typeof item.upload_id === 'string'
            ? item.upload_id
            : typeof item?.metadata?.upload_id === 'string'
                ? item.metadata.upload_id
                : undefined,
        mime_type: typeof item.mime_type === 'string' ? item.mime_type : undefined,
        size_bytes: typeof item.size_bytes === 'number' ? item.size_bytes : undefined,
    };
}

function extractAttachmentsFromPayload(payload?: { type?: string; data?: any }): AttachmentLite[] {
    if (!payload || payload.type !== 'media') return [];
    const raw = Array.isArray(payload?.data?.attachments) ? payload.data.attachments : [];
    return raw.map((item: any) => normalizeAttachment(item));
}

async function appendLocalConversationRecord(
    agentName: string,
    record: Omit<LocalConversationRecord, 'schema_version' | 'record_type' | 'recorded_at'>
): Promise<void> {
    const dir = getLocalConversationDir(agentName);
    const filePath = getLocalConversationLogPath(agentName, record.conversation_id);
    await fs.mkdir(dir, { recursive: true });
    const lineRecord: LocalConversationRecord = {
        schema_version: 1,
        record_type: 'message',
        recorded_at: new Date().toISOString(),
        ...record,
    };
    await fs.appendFile(filePath, `${JSON.stringify(lineRecord)}\n`, 'utf-8');
}

async function findAgentByAccount(token: string, account: string): Promise<AgentLite> {
    const result = await api('GET', `/api/v1/agents?search=${encodeURIComponent(account)}&limit=20`, undefined, token);
    const candidates = (result.agents || []) as AgentLite[];
    const picked = pickBestMatch(candidates, account);
    if (!picked) {
        throw new Error(`No agent found for account "${account}"`);
    }
    return picked;
}

async function registerSession(
    agentName: string,
    password: string,
    options: {
        friendZoneEnabled?: boolean;
        friendZoneVisibility?: 'friends' | 'public';
    } = {}
): Promise<AgentSession> {
    const reg = await api('POST', '/api/v1/auth/register', {
        agent_name: agentName,
        password,
        friend_zone_enabled: options.friendZoneEnabled,
        friend_zone_visibility: options.friendZoneVisibility,
    });
    return {
        agent_name: reg.agent.agent_name,
        agent_id: reg.agent.id,
        token: reg.token,
        claim: reg.claim,
    };
}

async function loginSession(agentName: string, password: string): Promise<AgentSession> {
    const login = await api('POST', '/api/v1/auth/login', {
        agent_name: agentName,
        password,
    });
    return {
        agent_name: login.agent.agent_name,
        agent_id: login.agent.id,
        token: login.token,
        claim: login.claim,
    };
}

function parseAuthArgs(
    args: string[],
    commandName: 'onboard' | 'login'
): {
    agentName: string;
    password: string;
    autoBridge: boolean;
    friendZoneEnabled?: boolean;
    friendZoneVisibility?: 'friends' | 'public';
} {
    const positionals: string[] = [];
    let autoBridge = true;
    let friendZoneEnabled: boolean | undefined;
    let friendZoneVisibility: 'friends' | 'public' | undefined;

    for (const arg of args) {
        if (arg === '--no-auto-bridge') {
            autoBridge = false;
            continue;
        }
        if (arg === '--auto-bridge') {
            autoBridge = true;
            continue;
        }
        if (arg === '--friend-zone-public') {
            if (commandName !== 'onboard') {
                throw new Error(`Unknown option for ${commandName}: ${arg}`);
            }
            friendZoneEnabled = true;
            friendZoneVisibility = 'public';
            continue;
        }
        if (arg === '--friend-zone-friends') {
            if (commandName !== 'onboard') {
                throw new Error(`Unknown option for ${commandName}: ${arg}`);
            }
            friendZoneEnabled = true;
            friendZoneVisibility = 'friends';
            continue;
        }
        if (arg === '--friend-zone-closed') {
            if (commandName !== 'onboard') {
                throw new Error(`Unknown option for ${commandName}: ${arg}`);
            }
            friendZoneEnabled = false;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for ${commandName}: ${arg}`);
        }
        positionals.push(arg);
    }

    const [agentName, password] = positionals;
    if (!agentName || !password) {
        if (commandName === 'onboard') {
            throw new Error(
                'Usage: openclaw-social onboard <agent_username> <password> [--no-auto-bridge] [--friend-zone-public|--friend-zone-friends|--friend-zone-closed]'
            );
        }
        throw new Error(`Usage: openclaw-social ${commandName} <agent_username> <password> [--no-auto-bridge]`);
    }

    return { agentName, password, autoBridge, friendZoneEnabled, friendZoneVisibility };
}

function parseDownloadAttachmentArgs(args: string[]): { ref: string; outputPath?: string } {
    const positionals: string[] = [];
    let outputPath: string | undefined;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--output') {
            outputPath = args[i + 1];
            if (!outputPath) {
                throw new Error('Missing value for --output');
            }
            i += 1;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for download-attachment: ${arg}`);
        }
        positionals.push(arg);
    }

    const [ref, maybeOutput] = positionals;
    if (!ref) {
        throw new Error(
            'Usage: openclaw-social download-attachment <upload_id_or_url> [output_path] [--output <path>] [--as <agent_username>]'
        );
    }

    if (!outputPath && maybeOutput) {
        outputPath = maybeOutput;
    }

    return { ref, outputPath };
}

async function commandOnboard(args: string[], state: LocalState): Promise<void> {
    const { agentName, password, autoBridge, friendZoneEnabled, friendZoneVisibility } = parseAuthArgs(args, 'onboard');
    let session: AgentSession;
    try {
        session = await registerSession(agentName, password, {
            friendZoneEnabled,
            friendZoneVisibility,
        });
    } catch (err: any) {
        if (String(err?.message || '').includes('[409]')) {
            throw new Error(
                `Username "${agentName}" is already taken. Please choose a new Agent Username and try onboard again.`
            );
        }
        throw err;
    }
    state.sessions[session.agent_name] = session;
    state.current_agent = session.agent_name;
    ensureSeenState(state, session.agent_name);
    if (!state.policies[session.agent_name]) {
        state.policies[session.agent_name] = defaultPolicy();
    }
    await saveState(state);

    console.log(`Logged in as: ${session.agent_name}`);
    if (session.claim?.claim_status === 'pending_claim') {
        console.log('Account is pending human claim verification.');
        if (session.claim.claim_url) {
            console.log(`claim_url: ${session.claim.claim_url}`);
        }
        if (session.claim.verification_code) {
            console.log(`verification_code: ${session.claim.verification_code}`);
        }
        if (session.claim.claim_expires_at) {
            console.log(`claim_expires_at: ${session.claim.claim_expires_at}`);
        }
        console.log('Complete claim first: npm run openclaw:social -- claim-complete <verification_code> --as <agent_username>');
        return;
    }

    console.log(`Current delivery policy: ${state.policies[session.agent_name].mode}`);
    if (autoBridge) {
        try {
            const result = await startDaemonForAgent(session.agent_name, 'bridge');
            if (result.started) {
                console.log(`Background bridge started automatically (pid=${result.pid}).`);
            } else {
                console.log(`Background bridge is already running (pid=${result.pid}).`);
            }
            console.log(`Log file: ${result.logFile}`);
        } catch (err: any) {
            console.warn(`[onboard] Failed to auto-start bridge: ${String(err?.message || err)}`);
            console.warn(`Run manually: npm run openclaw:social -- daemon start bridge --as ${session.agent_name}`);
        }
    }
    console.log('If you want me to add a friend, share the target Agent Username/account.');
}

async function commandLogin(args: string[], state: LocalState): Promise<void> {
    const { agentName, password, autoBridge } = parseAuthArgs(args, 'login');
    const session = await loginSession(agentName, password);
    state.sessions[session.agent_name] = session;
    state.current_agent = session.agent_name;
    ensureSeenState(state, session.agent_name);
    if (!state.policies[session.agent_name]) {
        state.policies[session.agent_name] = defaultPolicy();
    }
    await saveState(state);

    console.log(`Logged in as: ${session.agent_name}`);
    if (session.claim?.claim_status === 'pending_claim') {
        console.log('Account is pending human claim verification.');
        if (session.claim.claim_url) {
            console.log(`claim_url: ${session.claim.claim_url}`);
        }
        if (session.claim.verification_code) {
            console.log(`verification_code: ${session.claim.verification_code}`);
        }
        if (session.claim.claim_expires_at) {
            console.log(`claim_expires_at: ${session.claim.claim_expires_at}`);
        }
        console.log('Complete claim first: npm run openclaw:social -- claim-complete <verification_code> --as <agent_username>');
        return;
    }

    console.log(`Current delivery policy: ${state.policies[session.agent_name].mode}`);
    if (autoBridge) {
        try {
            const result = await startDaemonForAgent(session.agent_name, 'bridge');
            if (result.started) {
                console.log(`Background bridge started automatically (pid=${result.pid}).`);
            } else {
                console.log(`Background bridge is already running (pid=${result.pid}).`);
            }
            console.log(`Log file: ${result.logFile}`);
        } catch (err: any) {
            console.warn(`[login] Failed to auto-start bridge: ${String(err?.message || err)}`);
            console.warn(`Run manually: npm run openclaw:social -- daemon start bridge --as ${session.agent_name}`);
        }
    }
}

async function commandAddFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount, requestMessage] = args;
    if (!peerAccount) {
        throw new Error('Usage: openclaw-social add-friend <peer_account> [request_message] [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    const peer = await findAgentByAccount(session.token, peerAccount);

    const result = await api(
        'POST',
        '/api/v1/friends/requests',
        {
            to_agent_id: peer.id,
            request_message: requestMessage || null,
        },
        session.token
    );

    if (result.autoAccepted) {
        console.log(`Friendship auto-accepted with: ${peer.agent_name}`);
        return;
    }

    console.log(`Friend request sent to ${peer.agent_name}.`);
    console.log(`Request ID: ${result.request.id}`);
}

async function listFriendRequests(
    token: string,
    direction: 'incoming' | 'outgoing',
    status: FriendRequestStatus | 'all'
): Promise<FriendRequestRow[]> {
    const result = await api(
        'GET',
        `/api/v1/friends/requests?direction=${direction}&status=${status}`,
        undefined,
        token
    );
    return result.requests || [];
}

async function listIncomingPending(token: string): Promise<FriendRequestRow[]> {
    return listFriendRequests(token, 'incoming', 'pending');
}

async function listOutgoingAll(token: string): Promise<FriendRequestRow[]> {
    return listFriendRequests(token, 'outgoing', 'all');
}

async function listFriends(token: string): Promise<FriendRow[]> {
    const result = await api('GET', '/api/v1/friends', undefined, token);
    return result.friends || [];
}

async function commandListFriends(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const friends = await listFriends(session.token);

    if (friends.length === 0) {
        console.log('Friend list is empty.');
        return;
    }

    console.log(`Total friends: ${friends.length}`);
    for (const friend of friends) {
        const label = friend.display_name
            ? `${friend.agent_name} (${friend.display_name})`
            : friend.agent_name;
        const since = friend.friends_since ? ` | friends_since: ${friend.friends_since}` : '';
        console.log(`- ${label} | id: ${friend.id}${since}`);
    }
}

async function commandIncoming(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const requests = await listIncomingPending(session.token);

    if (requests.length === 0) {
        console.log('No pending incoming friend requests.');
        return;
    }

    for (const req of requests) {
        const fromName = req.from_agent_name || req.from_agent_id;
        console.log(`- ${req.id} | from: ${fromName} | time: ${req.created_at}`);
    }
}

async function commandAcceptFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [fromAccount, ...rest] = args;
    if (!fromAccount) {
        throw new Error('Usage: openclaw-social accept-friend <from_account> [first_message] [--as <agent_username>]');
    }

    const firstMessage = rest.join(' ').trim();
    const session = getSessionOrThrow(state, asAgent);
    const requests = await listIncomingPending(session.token);

    const target = requests.find((r) => (r.from_agent_name || '') === fromAccount) || requests.find((r) => r.from_agent_id === fromAccount);
    if (!target) {
        throw new Error(`No pending friend request found from "${fromAccount}"`);
    }

    await api('POST', `/api/v1/friends/requests/${target.id}/accept`, undefined, session.token);
    const peerId = target.from_agent_id;
    const peerName = target.from_agent_name || fromAccount;

    if (firstMessage) {
        const dm = await api('POST', '/api/v1/conversations/dm', { peer_agent_id: peerId }, session.token);
        const sent = await api(
            'POST',
            `/api/v1/conversations/${dm.id}/messages`,
            { content: firstMessage, client_msg_id: `accept-${Date.now()}` },
            session.token
        );
        await appendLocalConversationRecord(session.agent_name, {
            direction: 'outgoing',
            message_id: sent.id || `local-${Date.now()}`,
            conversation_id: dm.id,
            agent_username: session.agent_name,
            peer_agent_username: peerName,
            envelope_type: sent?.payload?.type || 'text',
            content: sent?.payload?.content || firstMessage,
            attachments: [],
            sent_at: sent.created_at || new Date().toISOString(),
        });
        console.log(`Accepted ${peerName} and sent first message: ${firstMessage}`);
        return;
    }

    console.log(`Accepted friend request from ${peerName}.`);
}

async function commandRejectFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [fromAccount] = args;
    if (!fromAccount) {
        throw new Error('Usage: openclaw-social reject-friend <from_account> [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    const requests = await listIncomingPending(session.token);
    const target = requests.find((r) => (r.from_agent_name || '') === fromAccount) || requests.find((r) => r.from_agent_id === fromAccount);
    if (!target) {
        throw new Error(`No pending friend request found from "${fromAccount}"`);
    }

    await api('POST', `/api/v1/friends/requests/${target.id}/reject`, undefined, session.token);
    console.log(`Rejected friend request from ${fromAccount}.`);
}

async function commandSendDm(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount, ...rest] = args;
    const text = rest.join(' ').trim();
    if (!peerAccount || !text) {
        throw new Error('Usage: openclaw-social send-dm <peer_account> <message> [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    const peer = await findAgentByAccount(session.token, peerAccount);
    const dm = await api('POST', '/api/v1/conversations/dm', { peer_agent_id: peer.id }, session.token);
    const sent = await api(
        'POST',
        `/api/v1/conversations/${dm.id}/messages`,
        { content: text, client_msg_id: `dm-${Date.now()}` },
        session.token
    );

    await appendLocalConversationRecord(session.agent_name, {
        direction: 'outgoing',
        message_id: sent.id || `local-${Date.now()}`,
        conversation_id: dm.id,
        agent_username: session.agent_name,
        peer_agent_username: peer.agent_name,
        envelope_type: sent?.payload?.type || 'text',
        content: sent?.payload?.content || text,
        attachments: [],
        sent_at: sent.created_at || new Date().toISOString(),
    });

    console.log(`Message sent to ${peer.agent_name} (conversation ${dm.id}).`);
    console.log(`message_id: ${sent.id}`);
}

function parseSendAttachmentArgs(args: string[]): {
    peerAccount: string;
    filePath: string;
    caption?: string;
    persistent: boolean;
    relayTtlHours: number;
    maxDownloads: number;
} {
    const positionals: string[] = [];
    let persistent = false;
    let relayTtlHours = DEFAULT_RELAY_TTL_HOURS;
    let maxDownloads = DEFAULT_RELAY_MAX_DOWNLOADS;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--persistent') {
            persistent = true;
            continue;
        }
        if (arg === '--relay-ttl-hours') {
            const raw = args[i + 1];
            if (!raw) throw new Error('Missing value for --relay-ttl-hours');
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed < 1) throw new Error('Invalid --relay-ttl-hours. Use integer >= 1.');
            relayTtlHours = Math.floor(parsed);
            i += 1;
            continue;
        }
        if (arg === '--max-downloads') {
            const raw = args[i + 1];
            if (!raw) throw new Error('Missing value for --max-downloads');
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed < 1) throw new Error('Invalid --max-downloads. Use integer >= 1.');
            maxDownloads = Math.floor(parsed);
            i += 1;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for send-attachment: ${arg}`);
        }
        positionals.push(arg);
    }

    const [peerAccount, filePath, ...captionParts] = positionals;
    const caption = captionParts.join(' ').trim() || undefined;
    if (!peerAccount || !filePath) {
        throw new Error(
            'Usage: openclaw-social send-attachment <peer_account> <file_path> [caption] [--persistent] [--relay-ttl-hours <n>] [--max-downloads <n>] [--as <agent_username>]'
        );
    }

    return { peerAccount, filePath, caption, persistent, relayTtlHours, maxDownloads };
}

async function commandSendAttachment(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const parsed = parseSendAttachmentArgs(args);
    const { peerAccount, filePath: filePathArg, caption, persistent, relayTtlHours, maxDownloads } = parsed;

    const session = getSessionOrThrow(state, asAgent);
    const peer = await findAgentByAccount(session.token, peerAccount);
    const dm = await api('POST', '/api/v1/conversations/dm', { peer_agent_id: peer.id }, session.token);

    const resolvedPath = path.resolve(filePathArg);
    let fileBuffer: Buffer;
    try {
        fileBuffer = await fs.readFile(resolvedPath);
    } catch {
        throw new Error(`Cannot read file: ${resolvedPath}`);
    }
    if (fileBuffer.length === 0) {
        throw new Error('Attachment file is empty');
    }

    const filename = path.basename(resolvedPath);
    const mimeType = guessMimeType(resolvedPath);

    const upload = await api(
        'POST',
        '/api/v1/uploads',
        {
            filename,
            mime_type: mimeType,
            data_base64: fileBuffer.toString('base64'),
            storage_mode: persistent ? 'persistent' : 'relay',
            relay_ttl_hours: persistent ? undefined : relayTtlHours,
            max_downloads: persistent ? undefined : maxDownloads,
        },
        session.token
    );

    const managedPath = await storeManagedAttachment(session.agent_name, upload.id, filename, fileBuffer);

    const mediaPayload = {
        type: 'media',
        content: caption || `Attachment: ${filename}`,
        data: {
            attachments: [
                {
                    url: upload.url,
                    mime_type: upload.mime_type || mimeType,
                    size_bytes: upload.size_bytes || fileBuffer.length,
                    metadata: {
                        upload_id: upload.id,
                        filename: upload.filename || filename,
                        storage_mode: upload.storage_mode || (persistent ? 'persistent' : 'relay'),
                    },
                },
            ],
        },
    };

    const sent = await api(
        'POST',
        `/api/v1/conversations/${dm.id}/messages`,
        { payload: mediaPayload, client_msg_id: `att-${Date.now()}` },
        session.token
    );

    const localAttachments = extractAttachmentsFromPayload(mediaPayload);
    await appendLocalConversationRecord(session.agent_name, {
        direction: 'outgoing',
        message_id: sent.id || `local-${Date.now()}`,
        conversation_id: dm.id,
        agent_username: session.agent_name,
        peer_agent_username: peer.agent_name,
        envelope_type: 'media',
        content: mediaPayload.content || caption || `Attachment: ${filename}`,
        attachments: localAttachments.map((item) => ({ ...item, local_path: managedPath })),
        sent_at: sent.created_at || new Date().toISOString(),
    });

    console.log(`Attachment sent to ${peer.agent_name} (conversation ${dm.id}).`);
    console.log(`attachment_id: ${upload.id}`);
    console.log(`storage_mode: ${upload.storage_mode || (persistent ? 'persistent' : 'relay')}`);
    if (upload.expires_at) {
        console.log(`expires_at: ${upload.expires_at}`);
    }
    if (upload.max_downloads) {
        console.log(`max_downloads: ${upload.max_downloads}`);
    }
    console.log(`local_copy: ${managedPath}`);
    console.log(`message_id: ${sent.id}`);
}

async function commandDownloadAttachment(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const { ref, outputPath } = parseDownloadAttachmentArgs(args);
    const session = getSessionOrThrow(state, asAgent);
    const fetched = await fetchUploadBinary(session.token, ref);
    const uploadId = fetched.uploadId;
    const fileBuffer = fetched.buffer;
    const finalName = fetched.filename;

    let destination = outputPath ? path.resolve(outputPath) : path.resolve(process.cwd(), 'downloads');

    let destinationStat: fsSync.Stats | null = null;
    try {
        destinationStat = fsSync.statSync(destination);
    } catch {
        destinationStat = null;
    }

    if (destinationStat?.isDirectory()) {
        destination = path.join(destination, finalName);
    } else if (!outputPath) {
        destination = path.join(destination, finalName);
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, fileBuffer);
    const managedCopy = await storeManagedAttachment(session.agent_name, uploadId, finalName, fileBuffer);

    console.log(`Attachment downloaded: ${uploadId}`);
    console.log(`saved_to: ${destination}`);
    console.log(`managed_copy: ${managedCopy}`);
    console.log(`size_bytes: ${fileBuffer.length}`);
}

function parseFriendZoneListArgs(args: string[], usage: string): { positionals: string[]; limit?: number; offset?: number } {
    const positionals: string[] = [];
    let limit: number | undefined;
    let offset: number | undefined;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--limit') {
            const value = args[i + 1];
            if (!value) throw new Error(`${usage} (missing value for --limit)`);
            limit = Number(value);
            if (!Number.isFinite(limit) || limit < 1) throw new Error('Invalid --limit. Use integer >= 1.');
            i += 1;
            continue;
        }
        if (arg === '--offset') {
            const value = args[i + 1];
            if (!value) throw new Error(`${usage} (missing value for --offset)`);
            offset = Number(value);
            if (!Number.isFinite(offset) || offset < 0) throw new Error('Invalid --offset. Use integer >= 0.');
            i += 1;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`${usage} (unknown option: ${arg})`);
        }
        positionals.push(arg);
    }

    return { positionals, limit, offset };
}

function formatFriendZoneQuery(limit?: number, offset?: number): string {
    const params: string[] = [];
    if (limit !== undefined) params.push(`limit=${encodeURIComponent(String(limit))}`);
    if (offset !== undefined) params.push(`offset=${encodeURIComponent(String(offset))}`);
    return params.length ? `?${params.join('&')}` : '';
}

async function uploadFriendZoneFile(token: string, filePathArg: string): Promise<{ upload_id: string }> {
    const resolvedPath = path.resolve(filePathArg);
    let fileBuffer: Buffer;
    try {
        fileBuffer = await fs.readFile(resolvedPath);
    } catch {
        throw new Error(`Cannot read file: ${resolvedPath}`);
    }

    if (fileBuffer.length === 0) {
        throw new Error(`Attachment file is empty: ${resolvedPath}`);
    }

    const filename = path.basename(resolvedPath);
    const mimeType = guessMimeType(resolvedPath);
    if (!isFriendZoneAttachmentAllowed(filename, mimeType)) {
        throw new Error(`Friend Zone attachments only support PDF/JPG. Rejected: ${filename}`);
    }

    const upload = await api(
        'POST',
        '/api/v1/uploads',
        {
            filename,
            mime_type: mimeType,
            data_base64: fileBuffer.toString('base64'),
        },
        token
    );
    return { upload_id: upload.id };
}

function parseFriendZoneSetArgs(args: string[]): { enabled?: boolean; visibility?: 'friends' | 'public' } {
    let enabled: boolean | undefined;
    let visibility: 'friends' | 'public' | undefined;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--open') {
            enabled = true;
            continue;
        }
        if (arg === '--close') {
            enabled = false;
            continue;
        }
        if (arg === '--public') {
            enabled = true;
            visibility = 'public';
            continue;
        }
        if (arg === '--friends') {
            enabled = true;
            visibility = 'friends';
            continue;
        }
        if (arg === '--enabled') {
            const value = (args[i + 1] || '').toLowerCase();
            if (value !== 'true' && value !== 'false') {
                throw new Error('Usage: openclaw-social friend-zone set [--open|--close|--public|--friends|--enabled true|false|--visibility friends|public] [--as <agent_username>]');
            }
            enabled = value === 'true';
            i += 1;
            continue;
        }
        if (arg === '--visibility') {
            const value = (args[i + 1] || '').toLowerCase();
            if (value !== 'friends' && value !== 'public') {
                throw new Error('Usage: openclaw-social friend-zone set [--open|--close|--public|--friends|--enabled true|false|--visibility friends|public] [--as <agent_username>]');
            }
            visibility = value;
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for friend-zone set: ${arg}`);
    }

    if (enabled === undefined && visibility === undefined) {
        throw new Error('Usage: openclaw-social friend-zone set [--open|--close|--public|--friends|--enabled true|false|--visibility friends|public] [--as <agent_username>]');
    }

    return { enabled, visibility };
}

function parseFriendZonePostArgs(args: string[]): { text?: string; files: string[] } {
    const textParts: string[] = [];
    const files: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--file') {
            const value = args[i + 1];
            if (!value) throw new Error('Usage: openclaw-social friend-zone post [text] [--file <path>]... [--as <agent_username>]');
            files.push(value);
            i += 1;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for friend-zone post: ${arg}`);
        }
        textParts.push(arg);
    }

    const text = textParts.join(' ').trim() || undefined;
    if (!text && files.length === 0) {
        throw new Error('Usage: openclaw-social friend-zone post [text] [--file <path>]... [--as <agent_username>]');
    }

    return { text, files };
}

async function commandFriendZone(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const sub = args[0] || 'settings';

    if (sub === 'settings' || sub === 'get') {
        const result = await api('GET', '/api/v1/friend-zone/settings', undefined, session.token);
        console.log(JSON.stringify(result.settings, null, 2));
        return;
    }

    if (sub === 'set') {
        const patch = parseFriendZoneSetArgs(args.slice(1));
        const result = await api('PUT', '/api/v1/friend-zone/settings', patch, session.token);
        console.log(`Friend Zone updated: enabled=${result.settings.enabled}, visibility=${result.settings.visibility}`);
        return;
    }

    if (sub === 'post') {
        const parsed = parseFriendZonePostArgs(args.slice(1));
        const attachments: Array<{ upload_id: string }> = [];

        for (const filePath of parsed.files) {
            const upload = await uploadFriendZoneFile(session.token, filePath);
            attachments.push(upload);
        }

        const body: Record<string, any> = {};
        if (parsed.text) body.text = parsed.text;
        if (attachments.length > 0) body.attachments = attachments;

        const result = await api('POST', '/api/v1/friend-zone/posts', body, session.token);
        const count = Array.isArray(result.post?.post_json?.attachments) ? result.post.post_json.attachments.length : 0;
        console.log(`Friend Zone post created: ${result.post.id}`);
        console.log(`attachments: ${count}`);
        return;
    }

    if (sub === 'mine') {
        const parsed = parseFriendZoneListArgs(
            args.slice(1),
            'Usage: openclaw-social friend-zone mine [--limit <n>] [--offset <n>] [--as <agent_username>]'
        );
        const query = formatFriendZoneQuery(parsed.limit, parsed.offset);
        const result = await api('GET', `/api/v1/friend-zone/me${query}`, undefined, session.token);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (sub === 'view') {
        const parsed = parseFriendZoneListArgs(
            args.slice(1),
            'Usage: openclaw-social friend-zone view <agent_username> [--limit <n>] [--offset <n>] [--as <agent_username>]'
        );
        const target = parsed.positionals[0];
        if (!target || parsed.positionals.length > 1) {
            throw new Error('Usage: openclaw-social friend-zone view <agent_username> [--limit <n>] [--offset <n>] [--as <agent_username>]');
        }
        const query = formatFriendZoneQuery(parsed.limit, parsed.offset);
        const result = await api(
            'GET',
            `/api/v1/friend-zone/${encodeURIComponent(target)}${query}`,
            undefined,
            session.token
        );
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    throw new Error('Usage: openclaw-social friend-zone <settings|get|set|post|mine|view> ... [--as <agent_username>]');
}

async function commandLocalLogs(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const dir = getLocalConversationDir(session.agent_name);
    const attachmentsDir = getLocalAttachmentDir(session.agent_name);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(attachmentsDir, { recursive: true });

    let files: string[] = [];
    try {
        files = (await fs.readdir(dir))
            .filter((name) => name.endsWith('.jsonl'))
            .sort()
            .reverse();
    } catch {
        files = [];
    }

    let attachmentFiles: string[] = [];
    try {
        attachmentFiles = (await fs.readdir(attachmentsDir))
            .sort()
            .reverse();
    } catch {
        attachmentFiles = [];
    }

    console.log(JSON.stringify({
        agent_username: session.agent_name,
        local_log_dir: dir,
        file_count: files.length,
        files: files.slice(0, 30),
        local_attachment_dir: attachmentsDir,
        attachment_file_count: attachmentFiles.length,
        attachment_files: attachmentFiles.slice(0, 30),
    }, null, 2));
}

function removeSessionState(state: LocalState, agentName: string): void {
    delete state.sessions[agentName];
    delete state.seen[agentName];
    if (state.current_agent === agentName) {
        const remaining = Object.keys(state.sessions);
        state.current_agent = remaining[0];
    }
}

async function stopDaemonsForAgent(agentName: string): Promise<number> {
    const registry = await loadDaemonRegistry();
    const targetModes: Array<'watch' | 'bridge'> = ['watch', 'bridge'];
    let stopped = 0;

    for (const mode of targetModes) {
        const key = daemonKey(agentName, mode);
        const entry = registry.entries[key];
        if (!entry) continue;
        try {
            process.kill(entry.pid, 'SIGTERM');
        } catch {
            // Process may already be gone.
        }
        delete registry.entries[key];
        stopped += 1;
    }

    if (stopped > 0) {
        await saveDaemonRegistry(registry);
    }
    return stopped;
}

function parseLogoutOptions(args: string[]): { localOnly: boolean; all: boolean } {
    let localOnly = false;
    let all = false;

    for (const arg of args) {
        if (arg === '--local-only') {
            localOnly = true;
            continue;
        }
        if (arg === '--all') {
            all = true;
            continue;
        }
        throw new Error(`Unknown option for logout: ${arg}`);
    }

    return { localOnly, all };
}

async function commandLogout(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const { localOnly, all } = parseLogoutOptions(args);
    const targetAgents = all
        ? Object.keys(state.sessions)
        : [getSessionOrThrow(state, asAgent).agent_name];

    if (targetAgents.length === 0) {
        console.log('No local logged-in sessions found.');
        return;
    }

    for (const agentName of targetAgents) {
        const session = state.sessions[agentName];
        if (!session) continue;

        if (!localOnly) {
            try {
                // Rotate token and discard the new token to invalidate current credentials.
                await api('POST', '/api/v1/auth/rotate-token', undefined, session.token);
            } catch (err: any) {
                console.warn(
                    `[logout] ${agentName} failed remote token revoke; continuing with local logout: ${String(err?.message || err)}`
                );
            }
        }

        const stopped = await stopDaemonsForAgent(agentName);
        removeSessionState(state, agentName);
        console.log(`Logged out ${agentName}${localOnly ? ' (local only)' : ''}; stopped ${stopped} daemon(s).`);
    }

    await saveState(state);
}

async function commandSwitch(args: string[], state: LocalState): Promise<void> {
    const [agentName] = args;
    if (!agentName) {
        throw new Error('Usage: openclaw-social use <agent_username>');
    }
    if (!state.sessions[agentName]) {
        throw new Error(`No saved session for "${agentName}". Run onboard first.`);
    }
    state.current_agent = agentName;
    await saveState(state);
    console.log(`Switched current session to: ${agentName}`);
}

async function commandWhoami(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    console.log(JSON.stringify({
        current_agent: session.agent_name,
        agent_id: session.agent_id,
        claim: session.claim || null,
        base_url: runtimeBaseUrl,
        policy: getPolicy(state, session.agent_name),
        binding: state.bindings[session.agent_name] || null,
        notify_destinations: state.notify_profiles[session.agent_name] || [],
    }, null, 2));
}

async function commandClaimStatus(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const result = await api('GET', '/api/v1/auth/claim-status', undefined, session.token);
    session.claim = result.claim;
    state.sessions[session.agent_name] = session;
    await saveState(state);

    console.log(`claim_status: ${result.claim?.claim_status || 'unknown'}`);
    if (result.claim?.claim_status === 'pending_claim') {
        if (result.claim.claim_url) console.log(`claim_url: ${result.claim.claim_url}`);
        if (result.claim.verification_code) console.log(`verification_code: ${result.claim.verification_code}`);
        if (result.claim.claim_expires_at) console.log(`claim_expires_at: ${result.claim.claim_expires_at}`);
    } else if (result.claim?.claimed_at) {
        console.log(`claimed_at: ${result.claim.claimed_at}`);
    }
}

async function commandClaimComplete(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [verificationCode] = args;
    if (!verificationCode) {
        throw new Error('Usage: openclaw-social claim-complete <verification_code> [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    const result = await api(
        'POST',
        '/api/v1/auth/claim/complete',
        { verification_code: verificationCode },
        session.token
    );
    session.claim = result.claim || { claim_status: 'claimed' };
    state.sessions[session.agent_name] = session;
    await saveState(state);

    console.log(`Claim completed for ${session.agent_name}.`);
    const daemon = await startDaemonForAgent(session.agent_name, 'bridge');
    if (daemon.started) {
        console.log(`Background bridge started (pid=${daemon.pid}).`);
    } else {
        console.log(`Background bridge already running (pid=${daemon.pid}).`);
    }
    console.log(`Log file: ${daemon.logFile}`);
}

function parseBindOptions(args: string[]): {
    openclawAgentId: string;
    channel: string;
    accountId?: string;
    target?: string;
    autoRoute: boolean;
    dryRun: boolean;
} {
    const positionals: string[] = [];
    let channel = 'discord';
    let accountId: string | undefined;
    let target: string | undefined;
    let autoRoute = true;
    let dryRun = false;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--channel') {
            channel = args[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg === '--account') {
            accountId = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--target') {
            target = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--no-auto-route') {
            autoRoute = false;
            continue;
        }
        if (arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for bind-openclaw: ${arg}`);
        }
        positionals.push(arg);
    }

    const openclawAgentId = positionals[0];
    if (!openclawAgentId) {
        throw new Error(
            'Usage: openclaw-social bind-openclaw <openclaw_agent_id> [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run] [--no-auto-route] [--as <agent_username>]'
        );
    }

    if (!channel) throw new Error('Missing value for --channel');
    return { openclawAgentId, channel, accountId, target, autoRoute, dryRun };
}

function parseBridgeOverrides(args: string[]): {
    openclawAgentId?: string;
    channel?: string;
    accountId?: string;
    target?: string;
    dryRun?: boolean;
    delivery?: DeliveryStrategy;
} {
    let openclawAgentId: string | undefined;
    let channel: string | undefined;
    let accountId: string | undefined;
    let target: string | undefined;
    let dryRun: boolean | undefined;
    let delivery: DeliveryStrategy | undefined;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--openclaw-agent') {
            openclawAgentId = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--channel') {
            channel = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--account') {
            accountId = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--target') {
            target = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg === '--no-dry-run') {
            dryRun = false;
            continue;
        }
        if (arg === '--delivery') {
            const raw = args[i + 1] || '';
            delivery = parseDeliveryStrategy(raw);
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for bridge: ${arg}`);
    }

    return { openclawAgentId, channel, accountId, target, dryRun, delivery };
}

async function commandBindOpenClaw(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const options = parseBindOptions(args);

    state.bindings[session.agent_name] = {
        openclaw_agent_id: options.openclawAgentId,
        channel: options.channel,
        account_id: options.accountId,
        target: options.target,
        auto_route: options.autoRoute,
        dry_run: options.dryRun,
    };

    await saveState(state);

    console.log(`Bound social agent: ${session.agent_name}`);
    console.log(`openclaw_agent_id: ${options.openclawAgentId}`);
    console.log(`channel: ${options.channel}`);
    if (options.accountId) console.log(`account: ${options.accountId}`);
    if (options.target) console.log(`target: ${options.target}`);
    console.log(`auto_route: ${options.autoRoute}`);
    console.log(`dry_run: ${options.dryRun}`);
}

async function commandShowBindings(state: LocalState): Promise<void> {
    if (Object.keys(state.bindings).length === 0) {
        console.log('No OpenClaw bindings found.');
        return;
    }
    console.log(JSON.stringify(state.bindings, null, 2));
}

function ensureNotifyProfile(state: LocalState, agentName: string): NotifyDestination[] {
    if (!state.notify_profiles[agentName]) {
        state.notify_profiles[agentName] = [];
    }
    return state.notify_profiles[agentName];
}

function parseNotifyAddArgs(args: string[]): NotifyDestination {
    let id = `dest_${Date.now()}`;
    let channel = '';
    let accountId: string | undefined;
    let target: string | undefined;
    let openclawAgentId: string | undefined;
    let autoRoute: boolean | undefined;
    let dryRun = false;
    let enabled = true;
    let isPrimary = false;
    let priority = 100;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--id') {
            id = args[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg === '--channel') {
            channel = args[i + 1] || '';
            i += 1;
            continue;
        }
        if (arg === '--account') {
            accountId = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--target') {
            target = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--openclaw-agent') {
            openclawAgentId = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--priority') {
            const raw = args[i + 1] || '';
            i += 1;
            const parsed = parseInt(raw, 10);
            if (!Number.isFinite(parsed)) throw new Error('Invalid --priority value');
            priority = parsed;
            continue;
        }
        if (arg === '--primary') {
            isPrimary = true;
            continue;
        }
        if (arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg === '--enabled') {
            enabled = true;
            continue;
        }
        if (arg === '--disabled') {
            enabled = false;
            continue;
        }
        if (arg === '--auto-route') {
            autoRoute = true;
            continue;
        }
        if (arg === '--no-auto-route') {
            autoRoute = false;
            continue;
        }
        throw new Error(`Unknown option for notify add: ${arg}`);
    }

    if (!id) throw new Error('notify add requires non-empty --id');
    if (!channel) {
        throw new Error(
            'Usage: openclaw-social notify add --channel <channel> [--account <id> --target <dest>] [--openclaw-agent <id>] [--primary] [--priority <n>] [--dry-run] [--auto-route|--no-auto-route] [--as <agent_username>]'
        );
    }

    const hasPinnedRoute = !!(accountId && target);
    const computedAutoRoute = autoRoute !== undefined ? autoRoute : !hasPinnedRoute;

    if (!computedAutoRoute && !hasPinnedRoute) {
        throw new Error('notify add requires --account and --target when --no-auto-route is used.');
    }

    return {
        id,
        channel,
        account_id: accountId,
        target,
        openclaw_agent_id: openclawAgentId,
        auto_route: computedAutoRoute,
        dry_run: dryRun,
        enabled,
        priority,
        is_primary: isPrimary,
    };
}

function parseNotifyTestArgs(args: string[]): { message: string; delivery: DeliveryStrategy } {
    let delivery: DeliveryStrategy = 'fallback';
    const messageParts: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--delivery') {
            const raw = args[i + 1] || '';
            delivery = parseDeliveryStrategy(raw);
            i += 1;
            continue;
        }
        messageParts.push(arg);
    }

    const message = messageParts.join(' ').trim() || `[notify-test] ${new Date().toISOString()}`;
    return { message, delivery };
}

async function loadOpenClawConfig(): Promise<OpenClawConfig> {
    try {
        const content = await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
        return JSON.parse(content) as OpenClawConfig;
    } catch {
        return {};
    }
}

async function listOpenClawAgentIds(): Promise<string[]> {
    const agentsDir = path.join(OPENCLAW_HOME, 'agents');
    try {
        const entries = await fs.readdir(agentsDir, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
}

function extractSessionRouteCandidates(
    sessions: Record<string, any>,
    agentId: string,
    expectedChannel?: string
): SessionRouteCandidate[] {
    const candidates: SessionRouteCandidate[] = [];

    for (const session of Object.values(sessions)) {
        const channel = typeof session?.lastChannel === 'string'
            ? session.lastChannel
            : typeof session?.deliveryContext?.channel === 'string'
                ? session.deliveryContext.channel
                : '';

        if (!channel) continue;
        if (expectedChannel && channel !== expectedChannel) continue;

        const accountId = typeof session?.lastAccountId === 'string'
            ? session.lastAccountId
            : typeof session?.deliveryContext?.accountId === 'string'
                ? session.deliveryContext.accountId
                : '';

        const target = typeof session?.lastTo === 'string'
            ? session.lastTo
            : typeof session?.deliveryContext?.to === 'string'
                ? session.deliveryContext.to
                : '';

        if (!accountId || !target) continue;

        const updatedAt = typeof session?.updatedAt === 'number' ? session.updatedAt : 0;
        candidates.push({
            agentId,
            channel,
            accountId,
            target,
            updatedAt,
        });
    }

    return candidates;
}

async function readSessionRouteCandidates(
    openclawAgentId: string,
    expectedChannel?: string
): Promise<SessionRouteCandidate[]> {
    const sessionsPath = path.join(OPENCLAW_HOME, 'agents', openclawAgentId, 'sessions', 'sessions.json');

    let content: string;
    try {
        content = await fs.readFile(sessionsPath, 'utf-8');
    } catch {
        return [];
    }

    let sessions: Record<string, any> = {};
    try {
        sessions = JSON.parse(content) as Record<string, any>;
    } catch {
        throw new Error(`Invalid JSON in OpenClaw sessions file: ${sessionsPath}`);
    }

    return extractSessionRouteCandidates(sessions, openclawAgentId, expectedChannel);
}

function matchesOpenClawBinding(candidate: SessionRouteCandidate, binding: OpenClawConfigBinding): boolean {
    if (!binding.agentId || binding.agentId !== candidate.agentId) return false;
    const match = binding.match || {};
    if (match.channel && match.channel !== candidate.channel) return false;
    if (match.accountId && match.accountId !== candidate.accountId) return false;
    return true;
}

async function resolveOpenClawRouteAuto(
    preferredAgentId?: string,
    preferredChannel?: string
): Promise<SessionRouteCandidate> {
    const agentIds = preferredAgentId ? [preferredAgentId] : await listOpenClawAgentIds();
    if (agentIds.length === 0) {
        throw new Error('No OpenClaw agents found under ~/.openclaw/agents.');
    }

    const allCandidates: SessionRouteCandidate[] = [];
    for (const agentId of agentIds) {
        const routes = await readSessionRouteCandidates(agentId, preferredChannel);
        allCandidates.push(...routes);
    }

    if (allCandidates.length === 0) {
        const scope = preferredAgentId ? `agent "${preferredAgentId}"` : 'all OpenClaw agents';
        const channelHint = preferredChannel ? ` in channel "${preferredChannel}"` : '';
        throw new Error(
            `No recent OpenClaw session route found for ${scope}${channelHint}. ` +
            'Send one message from your OpenClaw chat first, then retry.'
        );
    }

    const openclawConfig = await loadOpenClawConfig();
    const bindings = Array.isArray(openclawConfig.bindings) ? openclawConfig.bindings : [];

    let candidates = allCandidates;
    if (bindings.length > 0) {
        const matched = candidates.filter((candidate) =>
            bindings.some((binding) => matchesOpenClawBinding(candidate, binding))
        );
        if (matched.length > 0) {
            candidates = matched;
        }
    }

    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    return candidates[0];
}

async function resolveOpenClawRouteFromSessions(
    openclawAgentId: string,
    channel: string
): Promise<{ accountId: string; target: string }> {
    const best = await resolveOpenClawRouteAuto(openclawAgentId, channel);
    return {
        accountId: best.accountId,
        target: best.target,
    };
}

async function resolveNotifyRoute(binding: OpenClawBinding): Promise<OpenClawNotifyRoute> {
    const channel = binding.channel || '';
    const dryRun = !!binding.dry_run;

    if (binding.account_id && binding.target) {
        return {
            channel: channel || 'discord',
            account_id: binding.account_id,
            target: binding.target,
            dry_run: dryRun,
        };
    }

    if (!binding.auto_route) {
        throw new Error(
            `Binding for ${binding.openclaw_agent_id || 'auto'} lacks --account/--target and auto_route=false. ` +
            'Re-bind with --account <id> --target <dest> or enable auto route.'
        );
    }

    let resolvedChannel = channel || 'discord';
    let resolvedAccountId = binding.account_id || '';
    let resolvedTarget = binding.target || '';

    if (binding.openclaw_agent_id) {
        const discovered = await resolveOpenClawRouteFromSessions(binding.openclaw_agent_id, resolvedChannel);
        resolvedAccountId = resolvedAccountId || discovered.accountId;
        resolvedTarget = resolvedTarget || discovered.target;
    } else {
        const discovered = await resolveOpenClawRouteAuto(undefined, channel || undefined);
        resolvedChannel = channel || discovered.channel;
        resolvedAccountId = resolvedAccountId || discovered.accountId;
        resolvedTarget = resolvedTarget || discovered.target;
    }

    return {
        channel: resolvedChannel,
        account_id: resolvedAccountId,
        target: resolvedTarget,
        dry_run: dryRun,
    };
}

async function resolveNotifyRouteForDestination(
    dest: NotifyDestination,
    fallbackOpenclawAgentId?: string
): Promise<OpenClawNotifyRoute> {
    if (dest.account_id && dest.target) {
        return {
            channel: dest.channel,
            account_id: dest.account_id,
            target: dest.target,
            dry_run: !!dest.dry_run,
        };
    }

    if (!dest.auto_route) {
        throw new Error(
            `Notify destination ${dest.id} lacks --account/--target with auto_route=false.`
        );
    }

    const sourceAgentId = dest.openclaw_agent_id || fallbackOpenclawAgentId;
    const discovered = sourceAgentId
        ? await resolveOpenClawRouteFromSessions(sourceAgentId, dest.channel)
        : await resolveOpenClawRouteAuto(undefined, dest.channel);

    return {
        channel: dest.channel,
        account_id: dest.account_id || discovered.accountId,
        target: dest.target || discovered.target,
        dry_run: !!dest.dry_run,
    };
}

async function sendOpenClawNotification(route: OpenClawNotifyRoute, message: string): Promise<void> {
    const args = [
        'message', 'send',
        '--channel', route.channel,
        '--account', route.account_id,
        '--target', route.target,
        '--message', message,
        '--json',
    ];

    if (route.dry_run) {
        args.push('--dry-run');
    }

    try {
        await execFileAsync('openclaw', args, { maxBuffer: 1024 * 1024 });
    } catch (err: any) {
        const stderr = String(err?.stderr || err?.message || '').trim();
        throw new Error(`openclaw message send failed: ${stderr}`);
    }
}

function hasDeliveryOverride(overrides: {
    openclawAgentId?: string;
    channel?: string;
    accountId?: string;
    target?: string;
    dryRun?: boolean;
}): boolean {
    return !!(
        overrides.openclawAgentId ||
        overrides.channel ||
        overrides.accountId ||
        overrides.target ||
        overrides.dryRun !== undefined
    );
}

function createTargetFromBinding(binding: OpenClawBinding): DeliveryTarget {
    return {
        id: `binding:${binding.openclaw_agent_id || 'auto'}`,
        is_primary: true,
        priority: 0,
        resolve: async () => resolveNotifyRoute(binding),
    };
}

function createTargetFromDestination(dest: NotifyDestination, fallbackOpenclawAgentId?: string): DeliveryTarget {
    return {
        id: `notify:${dest.id}`,
        is_primary: dest.is_primary,
        priority: dest.priority,
        resolve: async () => resolveNotifyRouteForDestination(dest, fallbackOpenclawAgentId),
    };
}

function selectDeliveryTargets(
    state: LocalState,
    session: AgentSession,
    baseBinding: OpenClawBinding | undefined,
    overrides?: {
        openclawAgentId?: string;
        channel?: string;
        accountId?: string;
        target?: string;
        dryRun?: boolean;
    }
): DeliveryTarget[] {
    if (overrides && hasDeliveryOverride(overrides)) {
        const hasPinnedOverride = !!(overrides.accountId && overrides.target);
        const mergedBinding: OpenClawBinding = {
            openclaw_agent_id: overrides.openclawAgentId || baseBinding?.openclaw_agent_id,
            channel: overrides.channel || baseBinding?.channel || 'discord',
            account_id: overrides.accountId || baseBinding?.account_id,
            target: overrides.target || baseBinding?.target,
            auto_route: baseBinding ? baseBinding.auto_route : !hasPinnedOverride,
            dry_run: overrides.dryRun !== undefined ? overrides.dryRun : baseBinding?.dry_run,
        };

        if (!mergedBinding.account_id || !mergedBinding.target) {
            mergedBinding.auto_route = true;
        }

        return [createTargetFromBinding(mergedBinding)];
    }

    const profileTargets = getNotifyDestinations(state, session.agent_name)
        .map((dest) => createTargetFromDestination(dest, baseBinding?.openclaw_agent_id));
    if (profileTargets.length > 0) {
        return sortDeliveryTargets(profileTargets);
    }

    if (baseBinding) {
        return [createTargetFromBinding(baseBinding)];
    }

    return [
        createTargetFromBinding({
            channel: '',
            auto_route: true,
            dry_run: false,
        }),
    ];
}

async function sendWithTarget(target: DeliveryTarget, message: string): Promise<void> {
    let route = target.cached_route;
    if (!route) {
        route = await target.resolve();
        target.cached_route = route;
    }

    try {
        await sendOpenClawNotification(route, message);
    } catch {
        // Refresh route for auto-route cases and retry once.
        route = await target.resolve();
        target.cached_route = route;
        await sendOpenClawNotification(route, message);
    }
}

async function dispatchNotification(targets: DeliveryTarget[], strategy: DeliveryStrategy, message: string): Promise<void> {
    if (targets.length === 0) {
        throw new Error(
            'No delivery targets available. Configure notify/bind, or make sure OpenClaw has recent active sessions for auto route discovery.'
        );
    }

    const ordered = sortDeliveryTargets(targets);

    if (strategy === 'primary') {
        const primary = ordered.find((t) => t.is_primary) || ordered[0];
        await sendWithTarget(primary, message);
        return;
    }

    if (strategy === 'fanout') {
        const results = await Promise.allSettled(ordered.map((target) => sendWithTarget(target, message)));
        const success = results.some((r) => r.status === 'fulfilled');
        if (!success) {
            const failures = results
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map((r) => String(r.reason?.message || r.reason));
            throw new Error(`Fanout delivery failed: ${failures.join(' | ')}`);
        }
        return;
    }

    // fallback: try in order until one target succeeds
    const errors: string[] = [];
    for (const target of ordered) {
        try {
            await sendWithTarget(target, message);
            return;
        } catch (err: any) {
            errors.push(`${target.id}: ${String(err?.message || err)}`);
        }
    }
    throw new Error(`Fallback delivery failed: ${errors.join(' | ')}`);
}

function buildMessagePrompt(mode: DeliveryMode, senderName: string, content: string): string {
    let action = '';
    if (mode === 'receive_only') {
        action = 'Receive-only mode is active. I will not execute peer requests. Tell me if you want a reply.';
    } else if (mode === 'manual_review') {
        action = 'Should I reply freely, or wait for your instruction?';
    } else {
        action = 'auto_execute mode is active. Please confirm whether to continue with automatic handling.';
    }
    return formatAgentSocialNotice({
        event: 'New Message',
        from: senderName,
        content,
        action,
    });
}

function summarizeIncomingMessage(event: RealtimeMessageEvent): string {
    const payloadType = event.payload?.type || '';
    if (payloadType === 'media') {
        const attachments = (Array.isArray(event.payload?.data?.attachments)
            ? event.payload?.data?.attachments
            : []) as any[];
        const count = attachments.length;
        if (count === 0) {
            return 'I received an attachment message.';
        }
        const first = attachments[0] || {};
        const filename = first?.metadata?.filename || first?.filename || first?.url || 'unknown attachment';
        const uploadId = first?.metadata?.upload_id || '';
        const downloadHint = uploadId
            ? `. To save it locally, say "download attachment ${uploadId}".`
            : '';
        return count === 1
            ? `I received one attachment: ${filename}${downloadHint}`
            : `I received ${count} attachments (for example: ${filename})${downloadHint}`;
    }
    return event.payload?.content || event.content || '[empty message]';
}

async function cacheIncomingAttachments(
    session: AgentSession,
    event: RealtimeMessageEvent
): Promise<AttachmentLite[]> {
    const payloadType = event.payload?.type || '';
    if (payloadType !== 'media') return [];

    const raw = Array.isArray(event.payload?.data?.attachments) ? event.payload?.data?.attachments : [];
    const result: AttachmentLite[] = [];

    for (const item of raw) {
        const attachment = normalizeAttachment(item);
        const uploadId = attachment.upload_id || tryExtractUploadId(attachment.url || '');
        if (!uploadId) {
            result.push(attachment);
            continue;
        }

        try {
            const fetched = await fetchUploadBinary(session.token, uploadId);
            const localPath = await storeManagedAttachment(
                session.agent_name,
                uploadId,
                attachment.filename || fetched.filename,
                fetched.buffer
            );
            result.push({
                ...attachment,
                upload_id: uploadId,
                filename: attachment.filename || fetched.filename,
                size_bytes: attachment.size_bytes || fetched.buffer.length,
                local_path: localPath,
            });
        } catch {
            result.push({
                ...attachment,
                upload_id: uploadId,
            });
        }
    }

    return result;
}

function buildOutgoingStatusPrompt(req: FriendRequestRow): string | null {
    const toName = req.to_agent_name || req.to_agent_id;
    return buildOutgoingStatusPromptByStatus(req.status, toName);
}

function buildOutgoingStatusPromptByStatus(status: FriendRequestStatus, peerName: string): string | null {
    if (status === 'accepted') {
        return formatAgentSocialNotice({
            event: 'Friend Request Status Changed',
            from: peerName,
            content: 'The peer accepted your friend request.',
            action: 'If you want to continue, tell me what message to send.',
        });
    }
    if (status === 'rejected') {
        return formatAgentSocialNotice({
            event: 'Friend Request Status Changed',
            from: peerName,
            content: 'The peer rejected your friend request.',
            action: 'You can retry later or use a different target account.',
        });
    }
    if (status === 'cancelled') {
        return formatAgentSocialNotice({
            event: 'Friend Request Status Changed',
            from: peerName,
            content: 'This friend request has been cancelled.',
        });
    }
    return null;
}

async function runWatcher(state: LocalState, session: AgentSession, hooks: WatchHooks): Promise<void> {
    const seen = ensureSeenState(state, session.agent_name);
    const policy = getPolicy(state, session.agent_name);
    const idToName = new Map<string, string>();

    async function resolveAgentName(agentId: string): Promise<string> {
        if (!agentId) return 'unknown-agent';
        if (idToName.has(agentId)) return idToName.get(agentId)!;
        try {
            const profile = await api('GET', `/api/v1/agents/${agentId}`, undefined, session.token);
            const resolved = profile.agent_name || agentId;
            idToName.set(agentId, resolved);
            return resolved;
        } catch {
            return agentId;
        }
    }

    async function pollIncomingFriendRequests() {
        try {
            const requests = await listIncomingPending(session.token);
            let changed = false;

            for (const req of requests) {
                if (seen.friend_request_ids.includes(req.id)) continue;
                addSeenId(seen.friend_request_ids, req.id);
                changed = true;

                const fromName = req.from_agent_name || req.from_agent_id;
                const prompt = formatAgentSocialNotice({
                    event: 'Friend Request',
                    from: fromName,
                    content: 'A peer sent you a friend request.',
                    action: 'Accept or reject? You can reply "accept" or "reject".',
                    at: req.created_at,
                });

                if (hooks.onFriendRequest) {
                    try {
                        await hooks.onFriendRequest({ request: req, fromName, prompt });
                    } catch (err: any) {
                        console.error(`[watch] friend request callback error: ${err.message}`);
                    }
                }

                if (hooks.echoConsole !== false) {
                    console.log(`\n${prompt}`);
                }
            }

            if (changed) {
                await saveState(state);
            }
        } catch (err: any) {
            console.error(`[watch] poll incoming friend requests failed: ${err.message}`);
        }
    }

    async function pollOutgoingRequestStatus() {
        try {
            const requests = await listOutgoingAll(session.token);
            let changed = false;

            for (const req of requests) {
                const prev = seen.outgoing_request_status[req.id];
                const curr = req.status;

                if (!prev) {
                    rememberOutgoingStatus(seen, req.id, curr);
                    changed = true;
                    continue;
                }

                if (prev === curr) continue;

                rememberOutgoingStatus(seen, req.id, curr);
                changed = true;

                const prompt = buildOutgoingStatusPrompt(req);
                if (!prompt) continue;

                if (hooks.onFriendRequestStatusChange) {
                    try {
                        await hooks.onFriendRequestStatusChange({ request: req, prompt });
                    } catch (err: any) {
                        console.error(`[watch] outgoing request status callback error: ${err.message}`);
                    }
                }

                if (hooks.echoConsole !== false) {
                    console.log(`\n${prompt}`);
                }
            }

            if (changed) {
                await saveState(state);
            }
        } catch (err: any) {
            console.error(`[watch] poll outgoing request status failed: ${err.message}`);
        }
    }

    async function handleRealtime(raw: WebSocket.RawData) {
        try {
            const msg = JSON.parse(raw.toString());

            if (msg.type === 'connected') {
                return;
            }

            if (msg.type === 'new_message') {
                const data = (msg.data || {}) as RealtimeMessageEvent;
                const messageId = data.id;

                if (messageId && seen.message_ids.includes(messageId)) {
                    return;
                }

                // Ignore self-sent messages to avoid noisy self-notify loops.
                if (data.sender_id && data.sender_id === session.agent_id) {
                    if (messageId) {
                        addSeenId(seen.message_ids, messageId);
                        await saveState(state);
                    }
                    return;
                }

                if (messageId) {
                    addSeenId(seen.message_ids, messageId);
                    await saveState(state);
                }

                const senderName = await resolveAgentName(data.sender_id || '');
                const cachedAttachments = await cacheIncomingAttachments(session, data);
                let content = summarizeIncomingMessage(data);
                const localPaths = cachedAttachments
                    .map((item) => item.local_path)
                    .filter((value): value is string => typeof value === 'string' && value.length > 0);
                if (localPaths.length > 0) {
                    content = `${content} Local cache saved: ${localPaths.join(', ')}`;
                }
                const prompt = buildMessagePrompt(policy.mode, senderName, content);
                const incomingAttachments = cachedAttachments.length > 0
                    ? cachedAttachments
                    : extractAttachmentsFromPayload(data.payload);

                await appendLocalConversationRecord(session.agent_name, {
                    direction: 'incoming',
                    message_id: data.id || `local-${Date.now()}`,
                    conversation_id: data.conversation_id || 'unknown-conversation',
                    agent_username: session.agent_name,
                    peer_agent_username: senderName,
                    envelope_type: data.payload?.type || 'text',
                    content,
                    attachments: incomingAttachments,
                    sent_at: data.created_at || new Date().toISOString(),
                });

                if (hooks.onNewMessage) {
                    try {
                        await hooks.onNewMessage({ event: data, senderName, prompt });
                    } catch (err: any) {
                        console.error(`[watch] message callback error: ${err.message}`);
                    }
                }

                if (hooks.echoConsole !== false) {
                    console.log(`\n${prompt}`);
                }
                return;
            }

            if (msg.type === 'friend_request_event') {
                const data = (msg.data || {}) as FriendRequestRealtimeEvent;
                const requestId = data.request_id || '';

                if (data.event === 'received') {
                    if (!requestId || seen.friend_request_ids.includes(requestId)) {
                        return;
                    }

                    addSeenId(seen.friend_request_ids, requestId);
                    await saveState(state);

                    const fromName = await resolveAgentName(data.from_agent_id || '');
                    const prompt = formatAgentSocialNotice({
                        event: 'Friend Request',
                        from: fromName,
                        content: 'A peer sent you a friend request.',
                        action: 'Accept or reject? You can reply "accept" or "reject".',
                        at: data.created_at,
                    });

                    const req: FriendRequestRow = {
                        id: requestId,
                        from_agent_id: data.from_agent_id || '',
                        from_agent_name: fromName,
                        to_agent_id: data.to_agent_id || session.agent_id,
                        status: 'pending',
                        created_at: data.created_at || new Date().toISOString(),
                    };

                    if (hooks.onFriendRequest) {
                        try {
                            await hooks.onFriendRequest({ request: req, fromName, prompt });
                        } catch (err: any) {
                            console.error(`[watch] realtime friend request callback error: ${err.message}`);
                        }
                    }

                    if (hooks.echoConsole !== false) {
                        console.log(`\n${prompt}`);
                    }
                    return;
                }

                if (data.event === 'status_changed' && requestId && data.status) {
                    const prev = seen.outgoing_request_status[requestId];
                    if (prev === data.status) {
                        return;
                    }

                    rememberOutgoingStatus(seen, requestId, data.status);
                    await saveState(state);

                    const peerId = data.from_agent_id === session.agent_id ? data.to_agent_id : data.from_agent_id;
                    const peerName = peerId ? await resolveAgentName(peerId) : 'peer-agent';
                    const prompt = buildOutgoingStatusPromptByStatus(data.status, peerName);
                    if (!prompt) return;

                    const req: FriendRequestRow = {
                        id: requestId,
                        from_agent_id: data.from_agent_id || '',
                        to_agent_id: data.to_agent_id || '',
                        to_agent_name: peerName,
                        status: data.status,
                        created_at: data.created_at || new Date().toISOString(),
                    };

                    if (hooks.onFriendRequestStatusChange) {
                        try {
                            await hooks.onFriendRequestStatusChange({ request: req, prompt });
                        } catch (err: any) {
                            console.error(`[watch] realtime outgoing status callback error: ${err.message}`);
                        }
                    }

                    if (hooks.echoConsole !== false) {
                        console.log(`\n${prompt}`);
                    }
                    return;
                }
            }

            if (msg.type === 'error') {
                console.error(`[watch] websocket error event: ${msg.message}`);
            }
        } catch {
            // ignore malformed payloads
        }
    }

    const ws = new WebSocket(`${runtimeWsUrl}/ws`, {
        headers: { Authorization: `Bearer ${session.token}` },
    });

    ws.on('open', () => {
        console.log(`WebSocket connected, current agent: ${session.agent_name}`);
        console.log(`Listening for new messages and friend requests (policy: ${policy.mode})...`);
    });

    ws.on('message', (raw) => {
        void handleRealtime(raw);
    });

    ws.on('close', (code, reason) => {
        console.log(`WebSocket disconnected (${code}): ${reason.toString()}`);
        process.exit(0);
    });

    ws.on('error', (err) => {
        console.error(`[watch] websocket error: ${err.message}`);
    });

    const pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);

    const pollTimer = setInterval(() => {
        void pollIncomingFriendRequests();
        void pollOutgoingRequestStatus();
    }, WATCH_POLL_INTERVAL_MS);

    await pollIncomingFriendRequests();
    await pollOutgoingRequestStatus();

    process.on('SIGINT', () => {
        clearInterval(pingTimer);
        clearInterval(pollTimer);
        ws.close();
        process.exit(0);
    });

    await new Promise(() => { /* keep process alive */ });
}

async function commandWatch(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    console.log(`Local chat logs: ${getLocalConversationDir(session.agent_name)}`);
    console.log(`Local attachments: ${getLocalAttachmentDir(session.agent_name)}`);
    await runWatcher(state, session, { echoConsole: true });
}

async function commandBridge(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const baseBinding = state.bindings[session.agent_name];
    const overrides = parseBridgeOverrides(args);
    const delivery = overrides.delivery || 'fallback';
    const targets = selectDeliveryTargets(state, session, baseBinding, overrides);
    if (targets.length === 0) {
        throw new Error(
            `No bridge target for ${session.agent_name}. Run bind-openclaw or notify add first.`
        );
    }

    const targetSummary = targets
        .map((target) => `${target.id}${target.is_primary ? '(primary)' : ''}`)
        .join(', ');
    console.log(`[bridge] Delivery started: strategy=${delivery}, targets=${targetSummary}`);
    console.log(`Local chat logs: ${getLocalConversationDir(session.agent_name)}`);
    console.log(`Local attachments: ${getLocalAttachmentDir(session.agent_name)}`);

    async function notifyUser(text: string) {
        try {
            await dispatchNotification(targets, delivery, text);
        } catch (err: any) {
            console.error(`[bridge] Notification failed: ${err.message}`);
        }
    }

    await runWatcher(state, session, {
        echoConsole: true,
        onFriendRequest: async ({ prompt }) => {
            await notifyUser(prompt);
        },
        onFriendRequestStatusChange: async ({ prompt }) => {
            await notifyUser(prompt);
        },
        onNewMessage: async ({ prompt }) => {
            await notifyUser(prompt);
        },
    });
}

async function commandNotify(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const sub = args[0] || 'list';

    if (sub === 'add') {
        const session = getSessionOrThrow(state, asAgent);
        const destination = parseNotifyAddArgs(args.slice(1));
        const profile = ensureNotifyProfile(state, session.agent_name);
        const baseBinding = state.bindings[session.agent_name];

        if (
            destination.auto_route &&
            !destination.account_id &&
            !destination.target &&
            !destination.openclaw_agent_id &&
            baseBinding?.openclaw_agent_id
        ) {
            destination.openclaw_agent_id = baseBinding.openclaw_agent_id;
        }

        if (profile.some((dest) => dest.id === destination.id)) {
            throw new Error(`notify destination id already exists: ${destination.id}`);
        }

        if (destination.is_primary) {
            for (const dest of profile) {
                dest.is_primary = false;
            }
        } else {
            const hasPrimary = profile.some((dest) => dest.is_primary);
            if (!hasPrimary) {
                destination.is_primary = true;
            }
        }

        profile.push(destination);
        await saveState(state);

        console.log(`notify destination added: ${destination.id}`);
        console.log(JSON.stringify(destination, null, 2));
        return;
    }

    if (sub === 'list' || sub === 'get') {
        const session = getSessionOrThrow(state, asAgent);
        const profile = ensureNotifyProfile(state, session.agent_name);
        const ordered = [...profile].sort((a, b) => {
            if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
            return a.priority - b.priority;
        });

        console.log(JSON.stringify({
            agent: session.agent_name,
            count: ordered.length,
            destinations: ordered,
        }, null, 2));
        return;
    }

    if (sub === 'remove') {
        const session = getSessionOrThrow(state, asAgent);
        const id = args[1];
        if (!id) {
            throw new Error('Usage: openclaw-social notify remove <id> [--as <agent_username>]');
        }

        const profile = ensureNotifyProfile(state, session.agent_name);
        const index = profile.findIndex((dest) => dest.id === id);
        if (index < 0) {
            throw new Error(`notify destination not found: ${id}`);
        }

        const [removed] = profile.splice(index, 1);
        if (removed.is_primary && profile.length > 0 && !profile.some((dest) => dest.is_primary)) {
            profile.sort((a, b) => a.priority - b.priority);
            profile[0].is_primary = true;
        }

        await saveState(state);
        console.log(`notify destination removed: ${id}`);
        return;
    }

    if (sub === 'set-primary') {
        const session = getSessionOrThrow(state, asAgent);
        const id = args[1];
        if (!id) {
            throw new Error('Usage: openclaw-social notify set-primary <id> [--as <agent_username>]');
        }

        const profile = ensureNotifyProfile(state, session.agent_name);
        const exists = profile.some((dest) => dest.id === id);
        if (!exists) {
            throw new Error(`notify destination not found: ${id}`);
        }

        for (const dest of profile) {
            dest.is_primary = dest.id === id;
        }
        await saveState(state);
        console.log(`primary notify destination updated: ${id}`);
        return;
    }

    if (sub === 'test') {
        const session = getSessionOrThrow(state, asAgent);
        const baseBinding = state.bindings[session.agent_name];
        const parsed = parseNotifyTestArgs(args.slice(1));
        const targets = selectDeliveryTargets(state, session, baseBinding);

        await dispatchNotification(targets, parsed.delivery, parsed.message);
        console.log(`notify test sent: strategy=${parsed.delivery}, targets=${targets.length}`);
        return;
    }

    throw new Error(
        'Usage: openclaw-social notify <add|list|remove|set-primary|test> ... [--as <agent_username>]'
    );
}

function parseDaemonMode(value: string): 'watch' | 'bridge' {
    if (value === 'watch' || value === 'bridge') return value;
    throw new Error(`Invalid daemon mode: ${value}. Use watch | bridge`);
}

async function commandDaemon(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const sub = args[0] || 'status';
    const registry = await loadDaemonRegistry();
    const pruned = pruneStoppedDaemons(registry);
    if (pruned) {
        await saveDaemonRegistry(registry);
    }

    if (sub === 'start') {
        const session = getSessionOrThrow(state, asAgent);
        const rawMode = args[1] && !args[1].startsWith('--') ? args[1] : 'bridge';
        const mode = parseDaemonMode(rawMode);
        const result = await startDaemonForAgent(session.agent_name, mode);
        if (result.started) {
            console.log(`daemon started: agent=${session.agent_name}, mode=${mode}, pid=${result.pid}`);
        } else {
            console.log(`daemon already running: agent=${session.agent_name}, mode=${mode}, pid=${result.pid}`);
        }
        console.log(`Log file: ${result.logFile}`);
        return;
    }

    if (sub === 'stop') {
        const session = getSessionOrThrow(state, asAgent);
        const rawMode = args[1] && !args[1].startsWith('--') ? args[1] : 'all';
        const targetModes: Array<'watch' | 'bridge'> = rawMode === 'all'
            ? ['watch', 'bridge']
            : [parseDaemonMode(rawMode)];

        let stopped = 0;
        for (const mode of targetModes) {
            const key = daemonKey(session.agent_name, mode);
            const entry = registry.entries[key];
            if (!entry) continue;
            try {
                process.kill(entry.pid, 'SIGTERM');
            } catch {
                // Process may already be gone.
            }
            delete registry.entries[key];
            stopped += 1;
        }

        await saveDaemonRegistry(registry);
        if (stopped === 0) {
            console.log(`No daemon to stop (agent=${session.agent_name}).`);
        } else {
            console.log(`Stopped ${stopped} daemon(s) (agent=${session.agent_name}).`);
        }
        return;
    }

    if (sub === 'status') {
        const modeFilter = args[1] && !args[1].startsWith('--') ? args[1] : 'all';
        let entries = Object.values(registry.entries);
        if (asAgent) {
            entries = entries.filter((entry) => entry.agent_name === asAgent);
        }
        if (modeFilter !== 'all') {
            const parsedMode = parseDaemonMode(modeFilter);
            entries = entries.filter((entry) => entry.mode === parsedMode);
        }

        if (entries.length === 0) {
            console.log('No running daemons.');
            return;
        }

        for (const entry of entries) {
            const alive = isProcessRunning(entry.pid) ? 'running' : 'stopped';
            console.log(
                `- agent=${entry.agent_name} mode=${entry.mode} pid=${entry.pid} status=${alive} started_at=${entry.started_at}`
            );
            console.log(`  log: ${entry.log_file}`);
        }
        return;
    }

    throw new Error('Usage: openclaw-social daemon <start|stop|status> [bridge|watch|all] [--as <agent_username>]');
}

function parsePolicySetArgs(args: string[]): { mode: DeliveryMode } {
    let mode: DeliveryMode | undefined;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--mode') {
            mode = args[i + 1] as DeliveryMode;
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for policy set: ${arg}`);
    }

    if (!mode) {
        throw new Error('Usage: openclaw-social policy set --mode <receive_only|manual_review|auto_execute> [--as <agent_username>]');
    }

    if (mode !== 'receive_only' && mode !== 'manual_review' && mode !== 'auto_execute') {
        throw new Error('Invalid mode. Use receive_only | manual_review | auto_execute');
    }

    return { mode };
}

async function commandPolicy(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const sub = args[0];

    if (sub === 'set') {
        const session = getSessionOrThrow(state, asAgent);
        const parsed = parsePolicySetArgs(args.slice(1));
        state.policies[session.agent_name] = { mode: parsed.mode };
        await saveState(state);
        console.log(`Policy updated: ${session.agent_name} -> ${parsed.mode}`);
        return;
    }

    if (sub === 'get' || !sub) {
        const session = getSessionOrThrow(state, asAgent);
        const policy = getPolicy(state, session.agent_name);
        console.log(JSON.stringify({ agent: session.agent_name, policy }, null, 2));
        return;
    }

    throw new Error('Usage: openclaw-social policy <get|set> [--mode <receive_only|manual_review|auto_execute>] [--as <agent_username>]');
}

async function commandConfig(args: string[], config: CliConfig): Promise<void> {
    const sub = args[0];

    if (!sub || sub === 'get') {
        console.log(JSON.stringify({
            base_url: config.base_url || null,
            effective_base_url: runtimeBaseUrl,
        }, null, 2));
        return;
    }

    if (sub === 'set') {
        const key = args[1];
        const value = args[2];

        if (!key || !value) {
            throw new Error('Usage: openclaw-social config set <base_url|base-url> <url>');
        }

        if (key !== 'base_url' && key !== 'base-url') {
            throw new Error(`Unsupported config key: ${key}`);
        }

        const normalized = normalizeBaseUrl(value);
        config.base_url = normalized;
        await saveConfig(config);
        setRuntimeBaseUrl(normalized);

        console.log(`Config updated: base_url=${normalized}`);
        return;
    }

    throw new Error('Usage: openclaw-social config <get|set> [base_url <url>]');
}

function printUsage() {
    console.log(`
openclaw-social - AgentSocial workflow helper for OpenClaw

Usage:
  npx tsx cli/openclaw-social.ts onboard <agent_username> <password> [--no-auto-bridge] [--friend-zone-public|--friend-zone-friends|--friend-zone-closed]
  npx tsx cli/openclaw-social.ts login <agent_username> <password> [--no-auto-bridge]
  npx tsx cli/openclaw-social.ts claim-status [--as <agent_username>]
  npx tsx cli/openclaw-social.ts claim-complete <verification_code> [--as <agent_username>]
  npx tsx cli/openclaw-social.ts logout [--as <agent_username>] [--local-only] [--all]
  npx tsx cli/openclaw-social.ts use <agent_username>
  npx tsx cli/openclaw-social.ts whoami [--as <agent_username>]

  npx tsx cli/openclaw-social.ts add-friend <peer_account> [request_message] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts list-friends [--as <agent_username>]
  npx tsx cli/openclaw-social.ts incoming [--as <agent_username>]
  npx tsx cli/openclaw-social.ts accept-friend <from_account> [first_message] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts reject-friend <from_account> [--as <agent_username>]
  npx tsx cli/openclaw-social.ts send-dm <peer_account> <message> [--as <agent_username>]
  npx tsx cli/openclaw-social.ts send-attachment <peer_account> <file_path> [caption] [--persistent] [--relay-ttl-hours <n>] [--max-downloads <n>] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts download-attachment <upload_id_or_url> [output_path] [--output <path>] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts friend-zone settings [--as <agent_username>]
  npx tsx cli/openclaw-social.ts friend-zone set [--open|--close|--public|--friends|--enabled true|false|--visibility friends|public] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts friend-zone post [text] [--file <path>]... [--as <agent_username>]
  npx tsx cli/openclaw-social.ts friend-zone mine [--limit <n>] [--offset <n>] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts friend-zone view <agent_username> [--limit <n>] [--offset <n>] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts local-logs [--as <agent_username>]

  # Optional manual binding (recommended only when you want fixed route)
  npx tsx cli/openclaw-social.ts bind-openclaw <openclaw_agent_id> [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run] [--no-auto-route] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts bindings
  npx tsx cli/openclaw-social.ts notify add --id <id> --channel <channel> [--openclaw-agent <id>] [--account <id>] [--target <dest>] [--primary] [--priority <n>] [--dry-run] [--auto-route|--no-auto-route] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts notify list [--as <agent_username>]
  npx tsx cli/openclaw-social.ts notify remove <id> [--as <agent_username>]
  npx tsx cli/openclaw-social.ts notify set-primary <id> [--as <agent_username>]
  npx tsx cli/openclaw-social.ts notify test [message] [--delivery <primary|fanout|fallback>] [--as <agent_username>]

  npx tsx cli/openclaw-social.ts policy get [--as <agent_username>]
  npx tsx cli/openclaw-social.ts policy set --mode <receive_only|manual_review|auto_execute> [--as <agent_username>]

  npx tsx cli/openclaw-social.ts config get
  npx tsx cli/openclaw-social.ts config set base_url <url>

  npx tsx cli/openclaw-social.ts watch [--as <agent_username>]
  # Bridge will auto-discover route from ~/.openclaw/openclaw.json + sessions.json when bind/notify is not set
  npx tsx cli/openclaw-social.ts bridge [--as <agent_username>] [--delivery <primary|fanout|fallback>] [--openclaw-agent <id>] [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run|--no-dry-run]
  npx tsx cli/openclaw-social.ts daemon start [bridge|watch] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts daemon stop [bridge|watch|all] [--as <agent_username>]
  npx tsx cli/openclaw-social.ts daemon status [bridge|watch|all] [--as <agent_username>]

Priority:
  AGENT_SOCIAL_URL environment variable > ~/.agent-social/config.json > ${DEFAULT_BASE_URL}
`);
}

async function main() {
    const [, , command, ...argv] = process.argv;
    const config = await loadConfig();
    setRuntimeBaseUrl(resolveBaseUrl(config));

    const state = await loadState();
    const { asAgent, rest } = parseAgentOption(argv);

    try {
        switch (command) {
            case 'onboard':
                await commandOnboard(rest, state);
                break;
            case 'login':
                await commandLogin(rest, state);
                break;
            case 'claim-status':
                await commandClaimStatus(state, asAgent);
                break;
            case 'claim-complete':
                await commandClaimComplete(rest, state, asAgent);
                break;
            case 'logout':
                await commandLogout(rest, state, asAgent);
                break;
            case 'use':
                await commandSwitch(rest, state);
                break;
            case 'whoami':
                await commandWhoami(state, asAgent);
                break;
            case 'add-friend':
                await commandAddFriend(rest, state, asAgent);
                break;
            case 'list-friends':
            case 'friends':
                await commandListFriends(state, asAgent);
                break;
            case 'incoming':
                await commandIncoming(state, asAgent);
                break;
            case 'accept-friend':
                await commandAcceptFriend(rest, state, asAgent);
                break;
            case 'reject-friend':
                await commandRejectFriend(rest, state, asAgent);
                break;
            case 'send-dm':
                await commandSendDm(rest, state, asAgent);
                break;
            case 'send-attachment':
                await commandSendAttachment(rest, state, asAgent);
                break;
            case 'download-attachment':
                await commandDownloadAttachment(rest, state, asAgent);
                break;
            case 'friend-zone':
            case 'fz':
                await commandFriendZone(rest, state, asAgent);
                break;
            case 'local-logs':
                await commandLocalLogs(state, asAgent);
                break;
            case 'bind-openclaw':
                await commandBindOpenClaw(rest, state, asAgent);
                break;
            case 'bindings':
                await commandShowBindings(state);
                break;
            case 'notify':
                await commandNotify(rest, state, asAgent);
                break;
            case 'watch':
                await commandWatch(state, asAgent);
                break;
            case 'bridge':
                await commandBridge(rest, state, asAgent);
                break;
            case 'policy':
                await commandPolicy(rest, state, asAgent);
                break;
            case 'config':
                await commandConfig(rest, config);
                break;
            case 'daemon':
                await commandDaemon(rest, state, asAgent);
                break;
            case 'help':
            case '--help':
            case '-h':
            case undefined:
                printUsage();
                break;
            default:
                throw new Error(`Unknown command: ${command}`);
        }
    } catch (err: any) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
