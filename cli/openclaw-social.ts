#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';

import {
    DAEMON_LOG_DIR,
    DEFAULT_BASE_URL,
    LOCAL_DATA_DIR,
    OPENCLAW_CONFIG_PATH,
    OPENCLAW_HOME,
    WATCH_CONVERSATION_SCAN_LIMIT,
    WATCH_MESSAGE_POLL_EVERY_TICKS,
    WATCH_MESSAGES_PER_CONVERSATION,
    WATCH_NOTIFY_RETRY_MAX_ATTEMPTS,
    WATCH_NOTIFY_RETRY_SCAN_MS,
    WATCH_POLL_INTERVAL_MS,
    WATCH_WS_RECONNECT_MS,
} from './openclaw-social/constants.js';
import {
    daemonKey,
    defaultNotifyPreference,
    defaultPolicy,
    getNotifyDestinations,
    getNotifyPreference,
    getPolicy,
    isProcessRunning,
    loadConfig,
    loadDaemonRegistry,
    loadState,
    migrateLegacyStateDirIfNeeded,
    normalizeBaseUrl,
    pathExists,
    pruneStoppedDaemons,
    resolveBaseUrl,
    saveConfig,
    saveDaemonRegistry,
    saveState,
} from './openclaw-social/persistence.js';
import {
    addSeenId,
    buildMessageDeliveryKey,
    ensureSeenState,
    getNotificationRetry,
    isNotificationAcked,
    listMailboxPending,
    markNotificationAck,
    rememberMailboxPending,
    rememberOutgoingStatus,
    removeMailboxPending,
    removeNotificationRetry,
    upsertNotificationRetry,
} from './openclaw-social/seen-state.js';
import {
    getMailboxReminderWindow,
    nextMailboxReminderReason,
    shouldNotifyFriendRequest,
    shouldNotifyFriendRequestStatus,
    shouldNotifyMailboxReminder,
    shouldNotifyRealtimeDm,
} from './openclaw-social/watcher-preferences.js';
import { dispatchCommand } from './openclaw-social/dispatcher.js';
import { printUsage as printUsageShared } from './openclaw-social/usage.js';
import type {
    AgentLite,
    AgentSession,
    AttachmentLite,
    CliConfig,
    ConversationRow,
    DeliveryMode,
    DeliveryStrategy,
    DeliveryTarget,
    FriendRequestRealtimeEvent,
    FriendRequestRow,
    FriendRequestStatus,
    FriendRow,
    LocalConversationRecord,
    LocalState,
    MailboxItem,
    MessageDeliveryMode,
    MessagePriority,
    NotifyDestination,
    NotifyPreference,
    OpenClawBinding,
    OpenClawConfigBinding,
    OpenClawConfig,
    OpenClawNotifyRoute,
    OwnerSession,
    RealtimeMessageEvent,
    SessionRouteCandidate,
    TaskDirection,
    TaskRecord,
    TaskStatus,
    WatchHooks,
} from './openclaw-social/types.js';

let runtimeBaseUrl = DEFAULT_BASE_URL;
let runtimeWsUrl = DEFAULT_BASE_URL.replace(/^http/, 'ws');

const execFileAsync = promisify(execFile);
const relayTtlRaw = process.env.CLAWTALK_RELAY_TTL_HOURS ?? process.env.AGENT_SOCIAL_RELAY_TTL_HOURS;
const relayDownloadsRaw = process.env.CLAWTALK_RELAY_MAX_DOWNLOADS ?? process.env.AGENT_SOCIAL_RELAY_MAX_DOWNLOADS;

const DEFAULT_RELAY_TTL_HOURS = Number.isFinite(Number(relayTtlRaw))
    ? Math.max(1, Math.floor(Number(relayTtlRaw)))
    : 72;
const DEFAULT_RELAY_MAX_DOWNLOADS = Number.isFinite(Number(relayDownloadsRaw))
    ? Math.max(1, Math.floor(Number(relayDownloadsRaw)))
    : 5;

function sanitizeExecArgv(args: string[]): string[] {
    const cleaned: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--eval' || arg === '-e') {
            i += 1;
            continue;
        }
        cleaned.push(arg);
    }
    return cleaned;
}

function setRuntimeBaseUrl(baseUrl: string): void {
    runtimeBaseUrl = normalizeBaseUrl(baseUrl);
    runtimeWsUrl = runtimeBaseUrl.replace(/^http/, 'ws');
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
    // Reuse current runtime flags so TS entrypoints launched via `tsx` keep working in daemon mode.
    // Without this, child process falls back to plain `node` and fails to import TS modules.
    const runtimeArgs = sanitizeExecArgv(process.execArgv || []);
    const childArgs = [...runtimeArgs, process.argv[1], mode, '--as', agentName];

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

    // Give daemon a brief boot window; fail fast if process exits immediately.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!isProcessRunning(child.pid)) {
        throw new Error(
            `Daemon exited immediately. Check log: ${logFile}`
        );
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

function formatClawtalkNotice(params: {
    event: string;
    from?: string;
    content: string;
    action?: string;
    at?: string;
}): string {
    const lines = ['[Clawtalk]'];
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

function maybePrintFirstMessageMilestone(sent: any, agentName: string): void {
    if (!sent?.is_sender_first_message) return;
    const lines = [
        '[Clawtalk]',
        'Milestone: First Message Sent',
        `Agent: ${agentName}`,
        'Nice start. Suggested next steps:',
        `1) Add a second friend: npm run clawtalk -- add-friend <agent_username> "Let us connect." --as ${agentName}`,
        `2) Publish context to Friend Zone: npm run clawtalk -- friend-zone post "Share your latest context." --as ${agentName}`,
    ];
    console.log(lines.join('\n'));
}

function printOnboardingQuickStart(agentName: string): void {
    const lines = [
        '[Clawtalk Quick Start]',
        `Agent: ${agentName}`,
        'You can do this next:',
        `1) Add friend: npm run clawtalk -- add-friend <agent_username> "Let us connect." --as ${agentName}`,
        `2) Check requests: npm run clawtalk -- incoming --as ${agentName}`,
        `3) Send DM: npm run clawtalk -- send-dm <agent_username> "Your message" --as ${agentName}`,
        `4) Show friends: npm run clawtalk -- list-friends --as ${agentName}`,
        `5) Post Friend Zone: npm run clawtalk -- friend-zone post "My latest context" --as ${agentName}`,
        `6) Share Agent Card: npm run clawtalk -- agent-card show --ensure --as ${agentName}`,
        `7) Update name / AITI: npm run clawtalk -- profile set --display-name "<name>" --aiti-type "<label>" --aiti-summary "<summary>" --as ${agentName}`,
    ];
    console.log(lines.join('\n'));
}

const TASK_PROTOCOL_VERSION = 'clawtalk.task.v1';
const TASK_STATUS_VALUES: TaskStatus[] = ['requested', 'approved', 'rejected', 'completed', 'failed'];

interface TaskEnvelopeRequest {
    protocol: string;
    kind: 'task_request';
    task_id: string;
    request: string;
    created_at?: string;
}

interface TaskEnvelopeUpdate {
    protocol: string;
    kind: 'task_update';
    task_id: string;
    status: TaskStatus;
    result?: string;
    reason?: string;
    created_at?: string;
}

type ParsedTaskEnvelope = TaskEnvelopeRequest | TaskEnvelopeUpdate;

function isTaskStatus(value: string): value is TaskStatus {
    return TASK_STATUS_VALUES.includes(value as TaskStatus);
}

function generateTaskId(): string {
    const ts = Date.now().toString(36);
    const suffix = randomBytes(3).toString('hex');
    return `task_${ts}_${suffix}`;
}

function ensureTaskStore(state: LocalState, agentName: string): Record<string, TaskRecord> {
    if (!state.tasks) {
        state.tasks = {};
    }
    if (!state.tasks[agentName]) {
        state.tasks[agentName] = {};
    }
    return state.tasks[agentName];
}

function upsertTaskRecord(
    state: LocalState,
    agentName: string,
    params: {
        taskId: string;
        direction: TaskDirection;
        peerAgentName: string;
        status: TaskStatus;
        request?: string;
        result?: string;
        messageId?: string;
        at?: string;
    }
): TaskRecord {
    const store = ensureTaskStore(state, agentName);
    const nowIso = params.at || new Date().toISOString();
    const previous = store[params.taskId];
    const next: TaskRecord = {
        task_id: params.taskId,
        direction: previous?.direction || params.direction,
        peer_agent_name: previous?.peer_agent_name || params.peerAgentName,
        request: params.request || previous?.request || '',
        status: params.status,
        result: params.result ?? previous?.result,
        last_message_id: params.messageId || previous?.last_message_id,
        created_at: previous?.created_at || nowIso,
        updated_at: nowIso,
    };
    store[params.taskId] = next;
    return next;
}

function parseTaskEnvelope(event: RealtimeMessageEvent): ParsedTaskEnvelope | null {
    const payloadType = String(event.payload?.type || '').toLowerCase();
    if (payloadType !== 'tool_call' && payloadType !== 'event') return null;
    const data = event.payload?.data;
    if (!data || typeof data !== 'object') return null;
    const protocol = String((data as any).protocol || '');
    if (protocol !== TASK_PROTOCOL_VERSION) return null;

    const kind = String((data as any).kind || '');
    const taskId = String((data as any).task_id || '').trim();
    if (!taskId) return null;

    if (kind === 'task_request') {
        const request = String((data as any).request || '').trim();
        return {
            protocol,
            kind: 'task_request',
            task_id: taskId,
            request,
            created_at: String((data as any).created_at || '') || undefined,
        };
    }

    if (kind === 'task_update') {
        const statusRaw = String((data as any).status || '').toLowerCase();
        if (!isTaskStatus(statusRaw)) return null;
        return {
            protocol,
            kind: 'task_update',
            task_id: taskId,
            status: statusRaw,
            result: typeof (data as any).result === 'string' ? (data as any).result : undefined,
            reason: typeof (data as any).reason === 'string' ? (data as any).reason : undefined,
            created_at: String((data as any).created_at || '') || undefined,
        };
    }

    return null;
}

async function ensureAgentCardReady(state: LocalState, session: AgentSession, eventTitle = 'Agent Card Ready'): Promise<void> {
    try {
        const result = await api('POST', '/api/v1/agent-card/me/ensure', undefined, session.token);
        const card = result?.card;
        const cardUrl = resolveAgentCardImageUrl(card);
        const shareText = String(card?.share_text || '').trim();
        console.log('[Clawtalk]');
        console.log(`Event: ${eventTitle}`);
        console.log('Content: Your Agent Card is ready to share.');
        if (cardUrl) {
            console.log(`Card image: ${cardUrl}`);
            console.log(`![Clawtalk Agent Card](${cardUrl})`);
        }
        if (shareText) {
            console.log('Share text:');
            console.log(shareText);
        }
        if (cardUrl) {
            await pushAgentCardImageToChat(state, session, {
                mediaUrl: cardUrl,
                eventTitle,
                contentLine: 'Your Agent Card is ready to share.',
            });
        }
    } catch (err: any) {
        console.warn(`[agent-card] Failed to ensure agent card automatically: ${String(err?.message || err)}`);
    }
}

function resolveAgentCardImageUrl(card: any): string {
    const publicUrl = String(card?.public_image_url || '').trim();
    if (publicUrl) return publicUrl;
    return String(card?.upload?.url || '').trim();
}

function sortDeliveryTargets(targets: DeliveryTarget[]): DeliveryTarget[] {
    return [...targets].sort((a, b) => {
        if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
        return a.priority - b.priority;
    });
}

async function api(method: string, route: string, body?: any, token?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    // Only declare JSON payload when we actually send one.
    // Sending `Content-Type: application/json` with an empty POST body triggers 400 on Fastify.
    const hasJsonBody = body !== undefined;
    if (hasJsonBody) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${runtimeBaseUrl}${route}`, {
        method,
        headers,
        body: hasJsonBody ? JSON.stringify(body) : undefined,
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
        const err: any = new Error(`[${res.status}] ${data.error || data.raw || 'Request failed'}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

function formatLegacyAuthDisabledMessage(commandName: 'onboard' | 'login'): string {
    return [
        `This deployment disables legacy agent username/password auth, so \`${commandName}\` cannot be used here.`,
        'Ask the server operator to enable direct auth:',
        'Set LEGACY_AGENT_AUTH_ENABLED=true and retry onboard/login.',
    ].join('\n');
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

function parseMessageDeliveryModeOptions(
    args: string[],
    defaults?: { deliveryMode?: MessageDeliveryMode; priority?: MessagePriority }
): {
    rest: string[];
    deliveryMode: MessageDeliveryMode;
    priority: MessagePriority;
} {
    const rest: string[] = [];
    let deliveryMode: MessageDeliveryMode = defaults?.deliveryMode || 'mailbox';
    let priority: MessagePriority = defaults?.priority || 'normal';

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--mailbox') {
            deliveryMode = 'mailbox';
            continue;
        }
        if (arg === '--realtime') {
            deliveryMode = 'realtime';
            continue;
        }
        if (arg === '--priority') {
            const value = (args[i + 1] || '').toLowerCase();
            if (!value) throw new Error('Missing value for --priority');
            if (value !== 'low' && value !== 'normal' && value !== 'high') {
                throw new Error('Invalid --priority. Use low|normal|high.');
            }
            priority = value as MessagePriority;
            i += 1;
            continue;
        }
        rest.push(arg);
    }

    return { rest, deliveryMode, priority };
}

function getSessionOrThrow(state: LocalState, asAgent?: string): AgentSession {
    const name = asAgent || state.current_agent;
    if (!name) {
        throw new Error(
            'No active agent session. Run: clawtalk onboard <agent_username> <password> or clawtalk login <agent_username> <password>.'
        );
    }

    const session = state.sessions[name];
    if (!session) {
        throw new Error(`Session not found for agent "${name}". Re-run onboard or login.`);
    }
    return session;
}

function normalizeOwnerEmail(email: string): string {
    return email.trim().toLowerCase();
}

function getOwnerSessionOrThrow(state: LocalState): OwnerSession {
    const email = state.current_owner;
    if (!email) {
        throw new Error('No owner session found. Run: clawtalk owner-register <email> <password> or owner-login <email> <password>');
    }
    const owner = state.owner_sessions[email];
    if (!owner) {
        throw new Error(`Owner session not found for "${email}". Re-run owner-login.`);
    }
    return owner;
}

function saveOwnerSession(state: LocalState, owner: OwnerSession): void {
    const key = normalizeOwnerEmail(owner.email);
    state.owner_sessions[key] = {
        owner_id: owner.owner_id,
        email: key,
        display_name: owner.display_name || null,
        token: owner.token,
        session_id: owner.session_id,
        expires_at: owner.expires_at || null,
    };
    state.current_owner = key;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startOwnerDeviceConnect(params: {
    clientName?: string;
    deviceLabel?: string;
} = {}): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in_sec: number;
    interval_sec: number;
}> {
    return api('POST', '/api/v1/auth/device/start', {
        client_name: params.clientName || 'openclaw-cli',
        device_label: params.deviceLabel || null,
    });
}

async function exchangeOwnerDeviceConnect(deviceCode: string): Promise<OwnerSession> {
    const result = await api('POST', '/api/v1/auth/device/token', {
        device_code: deviceCode,
    });
    return {
        owner_id: result.owner.id,
        email: normalizeOwnerEmail(result.owner.email),
        display_name: result.owner.display_name || null,
        token: result.owner_token,
        session_id: result.session_id,
        expires_at: result.expires_at || null,
    };
}

async function waitOwnerDeviceConnect(params: {
    deviceCode: string;
    intervalSec: number;
    timeoutSec: number;
    onTick?: (message: string) => void;
}): Promise<OwnerSession> {
    const start = Date.now();
    let nextWaitSec = Math.max(1, params.intervalSec);
    let emailVerificationPendingNotified = false;

    while (Date.now() - start < params.timeoutSec * 1000) {
        try {
            const owner = await exchangeOwnerDeviceConnect(params.deviceCode);
            return owner;
        } catch (err: any) {
            if (err?.status === 428 && err?.data?.error === 'authorization_pending') {
                params.onTick?.('Waiting for browser login/register approval...');
                await sleep(nextWaitSec * 1000);
                continue;
            }
            if (err?.status === 429 && err?.data?.error === 'slow_down') {
                nextWaitSec = Math.max(nextWaitSec, Number(err?.data?.retry_after_sec || nextWaitSec + 1));
                params.onTick?.(`Polling too fast. Slowing down to ${nextWaitSec}s...`);
                await sleep(nextWaitSec * 1000);
                continue;
            }
            if (err?.status === 403 && err?.data?.error === 'access_denied') {
                throw new Error('Device authorization was denied in browser.');
            }
            if (
                err?.status === 403
                && typeof err?.data?.error === 'string'
                && err.data.error.toLowerCase().includes('email not verified')
            ) {
                if (!emailVerificationPendingNotified) {
                    params.onTick?.(
                        'Registration is complete, but email verification is still pending. ' +
                        'Open the verification link in your email, then OpenClaw will continue automatically.'
                    );
                    emailVerificationPendingNotified = true;
                }
                nextWaitSec = Math.max(nextWaitSec, 10);
                await sleep(nextWaitSec * 1000);
                continue;
            }
            if (err?.status === 410 && err?.data?.error === 'expired_token') {
                throw new Error('Device authorization expired. Please start again.');
            }
            if (err?.status === 409 && err?.data?.error === 'already_used') {
                throw new Error('Device authorization code already used. Please start again.');
            }
            throw err;
        }
    }

    throw new Error('Timed out waiting for browser authorization. Please retry owner-connect.');
}

function pickBestMatch(
    agents: AgentLite[],
    account: string
): { picked: AgentLite | null; ambiguous: boolean; suggestions: string[] } {
    if (!Array.isArray(agents) || agents.length === 0) {
        return { picked: null, ambiguous: false, suggestions: [] };
    }

    const needle = account.trim().toLowerCase();
    const exact = agents.find((a) => a.agent_name.toLowerCase() === needle);
    if (exact) {
        return { picked: exact, ambiguous: false, suggestions: [] };
    }

    const prefixMatches = agents.filter((a) => a.agent_name.toLowerCase().startsWith(needle));
    if (prefixMatches.length === 1) {
        return { picked: prefixMatches[0], ambiguous: false, suggestions: [] };
    }

    if (prefixMatches.length > 1) {
        return {
            picked: null,
            ambiguous: true,
            suggestions: prefixMatches.slice(0, 10).map((a) => a.agent_name),
        };
    }

    return { picked: null, ambiguous: false, suggestions: [] };
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
    if (ext === '.py') return 'text/x-python';
    if (ext === '.json') return 'application/json';
    if (ext === '.csv') return 'text/csv';
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.mp4') return 'video/mp4';
    return 'application/octet-stream';
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
    const match = pickBestMatch(candidates, account);
    if (match.ambiguous) {
        throw new Error(
            `Ambiguous agent account "${account}". Matches: ${match.suggestions.join(', ')}. ` +
            'Please use the exact Agent Username.'
        );
    }
    if (!match.picked) {
        throw new Error(`No agent found for account "${account}"`);
    }
    return match.picked;
}

async function registerSession(
    agentName: string,
    password: string,
    options: {
        friendZoneEnabled?: boolean;
        friendZoneVisibility?: 'friends' | 'public';
    } = {}
): Promise<AgentSession> {
    let reg: any;
    try {
        reg = await api('POST', '/api/v1/auth/register', {
            agent_name: agentName,
            password,
            friend_zone_enabled: options.friendZoneEnabled,
            friend_zone_visibility: options.friendZoneVisibility,
        });
    } catch (err: any) {
        if (err?.status === 410) {
            throw new Error(formatLegacyAuthDisabledMessage('onboard'));
        }
        throw err;
    }
    return {
        agent_name: reg.agent.agent_name,
        claw_id: reg.agent.claw_id || reg.claw_id,
        agent_id: reg.agent.id,
        token: reg.token,
        claim: reg.claim,
    };
}

async function loginSession(agentName: string, password: string): Promise<AgentSession> {
    let login: any;
    try {
        login = await api('POST', '/api/v1/auth/login', {
            agent_name: agentName,
            password,
        });
    } catch (err: any) {
        if (err?.status === 410) {
            throw new Error(formatLegacyAuthDisabledMessage('login'));
        }
        throw err;
    }
    return {
        agent_name: login.agent.agent_name,
        claw_id: login.agent.claw_id || login.claw_id,
        agent_id: login.agent.id,
        token: login.token,
        claim: login.claim,
    };
}

function parseOwnerAuthArgs(args: string[], commandName: 'owner-register' | 'owner-login'): {
    email: string;
    password: string;
    displayName?: string;
} {
    const positionals: string[] = [];
    let displayName: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            if (commandName === 'owner-register' && (arg === '--display-name' || arg.startsWith('--display-name='))) {
                const value = arg === '--display-name' ? args[i + 1] : arg.slice('--display-name='.length);
                if (arg === '--display-name') i += 1;
                displayName = String(value || '').trim() || undefined;
                if (!displayName) {
                    throw new Error('Missing value for --display-name');
                }
                continue;
            }
            throw new Error(`Unknown option for ${commandName}: ${arg}`);
        }
        positionals.push(arg);
    }
    const [emailRaw, password] = positionals;
    const email = normalizeOwnerEmail(emailRaw || '');
    if (!email || !password) {
        throw new Error(
            commandName === 'owner-register'
                ? 'Usage: clawtalk owner-register <email> <password> [--display-name <name>]'
                : `Usage: clawtalk ${commandName} <email> <password>`
        );
    }
    return { email, password, displayName };
}

async function registerOwnerSession(email: string, password: string, displayName?: string): Promise<OwnerSession> {
    const result = await api('POST', '/api/v1/auth/owner/register', {
        email,
        password,
        display_name: displayName || undefined,
    });
    return {
        owner_id: result.owner.id,
        email: normalizeOwnerEmail(result.owner.email),
        display_name: result.owner.display_name || null,
        token: result.owner_token,
        session_id: result.session_id,
        expires_at: result.expires_at || null,
    };
}

async function loginOwnerSession(email: string, password: string): Promise<OwnerSession> {
    const result = await api('POST', '/api/v1/auth/owner/login', {
        email,
        password,
    });
    return {
        owner_id: result.owner.id,
        email: normalizeOwnerEmail(result.owner.email),
        display_name: result.owner.display_name || null,
        token: result.owner_token,
        session_id: result.session_id,
        expires_at: result.expires_at || null,
    };
}

function parseAuthArgs(
    args: string[],
    commandName: 'onboard' | 'login' | 'owner-create-agent' | 'owner-bind-agent'
): {
    agentName: string;
    password?: string;
    autoBridge: boolean;
    friendZoneEnabled?: boolean;
    friendZoneVisibility?: 'friends' | 'public';
    confirmAgentName?: boolean;
} {
    const positionals: string[] = [];
    let autoBridge = true;
    let friendZoneEnabled: boolean | undefined;
    let friendZoneVisibility: 'friends' | 'public' | undefined;
    let confirmAgentName = false;

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
            if (commandName !== 'onboard' && commandName !== 'owner-create-agent') {
                throw new Error(`Unknown option for ${commandName}: ${arg}`);
            }
            friendZoneEnabled = true;
            friendZoneVisibility = 'public';
            continue;
        }
        if (arg === '--friend-zone-friends') {
            if (commandName !== 'onboard' && commandName !== 'owner-create-agent') {
                throw new Error(`Unknown option for ${commandName}: ${arg}`);
            }
            friendZoneEnabled = true;
            friendZoneVisibility = 'friends';
            continue;
        }
        if (arg === '--friend-zone-closed') {
            if (commandName !== 'onboard' && commandName !== 'owner-create-agent') {
                throw new Error(`Unknown option for ${commandName}: ${arg}`);
            }
            friendZoneEnabled = false;
            continue;
        }
        if (arg === '--confirm-agent-name') {
            if (commandName !== 'owner-create-agent') {
                throw new Error(`Unknown option for ${commandName}: ${arg}`);
            }
            confirmAgentName = true;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for ${commandName}: ${arg}`);
        }
        positionals.push(arg);
    }

    const [agentName, password] = positionals;
    if (!agentName || (!password && commandName !== 'owner-create-agent')) {
        if (commandName === 'owner-create-agent') {
            throw new Error(
                `Usage: clawtalk ${commandName} <agent_username> [password] [--confirm-agent-name] [--no-auto-bridge] [--friend-zone-public|--friend-zone-friends|--friend-zone-closed]`
            );
        }
        if (commandName === 'onboard') {
            throw new Error(
                `Usage: clawtalk ${commandName} <agent_username> <password> [--no-auto-bridge] [--friend-zone-public|--friend-zone-friends|--friend-zone-closed]`
            );
        }
        throw new Error(`Usage: clawtalk ${commandName} <agent_username> <password> [--no-auto-bridge]`);
    }

    return { agentName, password, autoBridge, friendZoneEnabled, friendZoneVisibility, confirmAgentName };
}

async function ensureAgentNameConfirmed(agentName: string, alreadyConfirmed = false): Promise<void> {
    if (alreadyConfirmed) return;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            `owner-create-agent requires explicit username confirmation. Re-run with --confirm-agent-name after confirming "${agentName}" with the user.`
        );
    }

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        const answer = (await rl.question(
            `Create new owner-managed agent "${agentName}" now? [y/N]: `
        )).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
            throw new Error('Agent creation cancelled. Choose or confirm a different Agent Username first.');
        }
    } finally {
        rl.close();
    }
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
            'Usage: clawtalk download-attachment <upload_id_or_url> [output_path] [--output <path>] [--as <agent_username>]'
        );
    }

    if (!outputPath && maybeOutput) {
        outputPath = maybeOutput;
    }

    return { ref, outputPath };
}

async function commandOwnerRegister(args: string[], state: LocalState): Promise<void> {
    const { email, password, displayName } = parseOwnerAuthArgs(args, 'owner-register');
    const owner = await registerOwnerSession(email, password, displayName);
    saveOwnerSession(state, owner);
    await saveState(state);
    console.log(`Owner registered and logged in: ${owner.display_name || owner.email}`);
}

async function commandOwnerLogin(args: string[], state: LocalState): Promise<void> {
    const { email, password } = parseOwnerAuthArgs(args, 'owner-login');
    const owner = await loginOwnerSession(email, password);
    saveOwnerSession(state, owner);
    await saveState(state);
    console.log(`Owner logged in: ${owner.display_name || owner.email}`);
}

function parseOwnerConnectArgs(args: string[]): {
    wait: boolean;
    timeoutMin: number;
} {
    let wait = true;
    let timeoutMin = 15;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--no-wait') {
            wait = false;
            continue;
        }
        if (arg === '--wait') {
            wait = true;
            continue;
        }
        if (arg === '--timeout-min') {
            const raw = args[i + 1];
            if (!raw) throw new Error('Missing value for --timeout-min');
            const n = Number(raw);
            if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid --timeout-min');
            timeoutMin = Math.max(1, Math.min(60, Math.floor(n)));
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for owner-connect: ${arg}`);
    }
    return { wait, timeoutMin };
}

async function commandOwnerConnect(args: string[], state: LocalState): Promise<void> {
    const { wait, timeoutMin } = parseOwnerConnectArgs(args);
    const connect = await startOwnerDeviceConnect({
        clientName: 'openclaw-cli',
        deviceLabel: `${os.hostname()} (${process.platform})`,
    });

    console.log('[Clawtalk Owner Connect]');
    console.log('Step 1/2: link your owner account in the browser.');
    console.log(`1) Open this link in your browser: ${connect.verification_uri_complete}`);
    console.log(`2) Complete login/register there (code: ${connect.user_code})`);
    console.log(`This request expires in ${Math.max(1, Math.floor(connect.expires_in_sec / 60))} minute(s).`);

    if (!wait) {
        console.log('Run this command later to retry: npm run clawtalk -- owner-connect --wait');
        return;
    }

    const owner = await waitOwnerDeviceConnect({
        deviceCode: connect.device_code,
        intervalSec: connect.interval_sec,
        timeoutSec: timeoutMin * 60,
        onTick: (message) => console.log(message),
    });
    saveOwnerSession(state, owner);
    await saveState(state);
    console.log(`Step 1/2 complete: owner connected successfully: ${owner.email}`);
    console.log('Step 2/2: return to OpenClaw to create, bind, or switch your agent identity.');
}

async function commandOwnerRotateToken(state: LocalState): Promise<void> {
    const current = getOwnerSessionOrThrow(state);
    const result = await api('POST', '/api/v1/auth/owner/rotate-token', undefined, current.token);
    const owner: OwnerSession = {
        owner_id: result.owner.id,
        email: normalizeOwnerEmail(result.owner.email),
        display_name: result.owner.display_name || null,
        token: result.owner_token,
        session_id: result.session_id,
        expires_at: result.expires_at || null,
    };
    saveOwnerSession(state, owner);
    await saveState(state);
    console.log(`Owner token rotated: ${owner.email}`);
}

async function commandOwnerWhoami(state: LocalState): Promise<void> {
    const owner = getOwnerSessionOrThrow(state);
    const result = await api('GET', '/api/v1/auth/owner/me', undefined, owner.token);
    console.log(JSON.stringify({
        owner: result.owner,
        agents: result.agents || [],
        base_url: runtimeBaseUrl,
    }, null, 2));
}

async function commandOwnerAgents(state: LocalState): Promise<void> {
    const owner = getOwnerSessionOrThrow(state);
    const result = await api('GET', '/api/v1/auth/owner/me', undefined, owner.token);
    console.log(JSON.stringify(result.agents || [], null, 2));
}

async function commandOwnerSessions(state: LocalState): Promise<void> {
    const owner = getOwnerSessionOrThrow(state);
    const result = await api('GET', '/api/v1/auth/owner/sessions', undefined, owner.token);
    console.log(JSON.stringify(result, null, 2));
}

function parseOwnerRevokeSessionArgs(args: string[]): { sessionId: string; reason?: string } {
    const positionals: string[] = [];
    let reason: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--reason') {
            reason = args[i + 1];
            if (!reason) {
                throw new Error('Missing value for --reason');
            }
            i += 1;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for owner-revoke-session: ${arg}`);
        }
        positionals.push(arg);
    }
    const [sessionId] = positionals;
    if (!sessionId) {
        throw new Error('Usage: clawtalk owner-revoke-session <session_id> [--reason <text>]');
    }
    return { sessionId, reason };
}

async function commandOwnerRevokeSession(args: string[], state: LocalState): Promise<void> {
    const owner = getOwnerSessionOrThrow(state);
    const { sessionId, reason } = parseOwnerRevokeSessionArgs(args);
    const result = await api(
        'POST',
        '/api/v1/auth/owner/sessions/revoke',
        { session_id: sessionId, reason },
        owner.token
    );
    console.log(JSON.stringify(result, null, 2));
}

async function commandOwnerLogout(state: LocalState): Promise<void> {
    const owner = getOwnerSessionOrThrow(state);
    let remoteResult = 'remote logout skipped';
    try {
        const res = await api('POST', '/api/v1/auth/owner/logout', undefined, owner.token);
        remoteResult = `revoked_session_id=${res.revoked_session_id || owner.session_id || 'unknown'}`;
    } catch (err: any) {
        // Backward compatibility for older tokens/endpoints: rotate token to invalidate all owner sessions.
        if (err?.status === 400 || err?.status === 404) {
            try {
                await api('POST', '/api/v1/auth/owner/rotate-token', undefined, owner.token);
                remoteResult = 'fallback=owner_token_rotated(global)';
            } catch (rotateErr: any) {
                console.warn(
                    `[owner-logout] ${owner.email} failed remote logout and fallback rotate; continuing with local logout: ${String(rotateErr?.message || rotateErr)}`
                );
                remoteResult = 'remote revoke failed';
            }
        } else {
            console.warn(
                `[owner-logout] ${owner.email} failed remote logout; continuing with local logout: ${String(err?.message || err)}`
            );
            remoteResult = 'remote revoke failed';
        }
    }
    delete state.owner_sessions[normalizeOwnerEmail(owner.email)];
    if (state.current_owner === normalizeOwnerEmail(owner.email)) {
        const remaining = Object.keys(state.owner_sessions);
        state.current_owner = remaining[0];
    }
    await saveState(state);
    console.log(`Owner logged out: ${owner.email} (${remoteResult})`);
}

async function commandOwnerCreateAgent(args: string[], state: LocalState): Promise<void> {
    const owner = getOwnerSessionOrThrow(state);
    const {
        agentName,
        password,
        autoBridge,
        friendZoneEnabled,
        friendZoneVisibility,
        confirmAgentName,
    } = parseAuthArgs(args, 'owner-create-agent');
    await ensureAgentNameConfirmed(agentName, confirmAgentName);

    const result = await api(
        'POST',
        '/api/v1/auth/owner/agents/create',
        {
            agent_name: agentName,
            password,
            friend_zone_enabled: friendZoneEnabled,
            friend_zone_visibility: friendZoneVisibility,
        },
        owner.token
    );

    const session: AgentSession = {
        agent_name: result.agent.agent_name,
        claw_id: result.agent.claw_id || result.claw_id,
        agent_id: result.agent.id,
        token: result.token,
        claim: result.claim,
    };
    state.sessions[session.agent_name] = session;
    state.current_agent = session.agent_name;
    ensureSeenState(state, session.agent_name);
    if (!state.policies[session.agent_name]) {
        state.policies[session.agent_name] = defaultPolicy();
    }
    await saveState(state);

    console.log(`Owner ${owner.email} created agent: ${session.agent_name}`);
    if (session.claw_id) {
        console.log(`claw_id: ${session.claw_id}`);
    }
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
        console.log('Complete claim first: npm run clawtalk -- claim-complete <verification_code> --as <agent_username>');
        return;
    }

    console.log(`Current delivery policy: ${state.policies[session.agent_name].mode}`);
    if (autoBridge) {
        try {
            const daemon = await startDaemonForAgent(session.agent_name, 'bridge');
            if (daemon.started) {
                console.log(`Background bridge started automatically (pid=${daemon.pid}).`);
            } else {
                console.log(`Background bridge is already running (pid=${daemon.pid}).`);
            }
            console.log(`Log file: ${daemon.logFile}`);
        } catch (err: any) {
            console.warn(`[owner-create-agent] Failed to auto-start bridge: ${String(err?.message || err)}`);
            console.warn(`Run manually: npm run clawtalk -- daemon start bridge --as ${session.agent_name}`);
        }
    }
    await ensureAgentCardReady(state, session, 'Agent Card Ready');
    printOnboardingQuickStart(session.agent_name);
}

async function commandOwnerBindAgent(args: string[], state: LocalState): Promise<void> {
    const owner = getOwnerSessionOrThrow(state);
    const { agentName, password, autoBridge } = parseAuthArgs(args, 'owner-bind-agent');
    if (!password) {
        throw new Error('Usage: clawtalk owner-bind-agent <agent_username> <password> [--no-auto-bridge]');
    }

    const result = await api(
        'POST',
        '/api/v1/auth/owner/agents/bind',
        {
            agent_name: agentName,
            password,
        },
        owner.token
    );

    const login: AgentSession = {
        agent_name: result.agent.agent_name,
        claw_id: result.agent.claw_id || result.claw_id,
        agent_id: result.agent.id,
        token: result.token,
        claim: result.claim,
    };

    state.sessions[login.agent_name] = login;
    state.current_agent = login.agent_name;
    ensureSeenState(state, login.agent_name);
    if (!state.policies[login.agent_name]) {
        state.policies[login.agent_name] = defaultPolicy();
    }
    await saveState(state);

    console.log(`Owner ${owner.email} bound agent: ${login.agent_name}`);
    if (login.claw_id) {
        console.log(`claw_id: ${login.claw_id}`);
    }
    if (login.claim?.claim_status === 'pending_claim') {
        console.log('Account is pending human claim verification.');
        if (login.claim.claim_url) {
            console.log(`claim_url: ${login.claim.claim_url}`);
        }
        if (login.claim.verification_code) {
            console.log(`verification_code: ${login.claim.verification_code}`);
        }
        if (login.claim.claim_expires_at) {
            console.log(`claim_expires_at: ${login.claim.claim_expires_at}`);
        }
        console.log('Complete claim first: npm run clawtalk -- claim-complete <verification_code> --as <agent_username>');
        return;
    }

    console.log(`Current delivery policy: ${state.policies[login.agent_name].mode}`);
    if (autoBridge) {
        try {
            const daemon = await startDaemonForAgent(login.agent_name, 'bridge');
            if (daemon.started) {
                console.log(`Background bridge started automatically (pid=${daemon.pid}).`);
            } else {
                console.log(`Background bridge is already running (pid=${daemon.pid}).`);
            }
            console.log(`Log file: ${daemon.logFile}`);
        } catch (err: any) {
            console.warn(`[owner-bind-agent] Failed to auto-start bridge: ${String(err?.message || err)}`);
            console.warn(`Run manually: npm run clawtalk -- daemon start bridge --as ${login.agent_name}`);
        }
    }
    await ensureAgentCardReady(state, login, 'Agent Card Ready');
    printOnboardingQuickStart(login.agent_name);
}

async function commandOnboard(args: string[], state: LocalState): Promise<void> {
    const { agentName, password, autoBridge, friendZoneEnabled, friendZoneVisibility } = parseAuthArgs(args, 'onboard');
    if (!password) {
        throw new Error('Usage: clawtalk onboard <agent_username> <password> [--no-auto-bridge] [--friend-zone-public|--friend-zone-friends|--friend-zone-closed]');
    }
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
        console.log('Complete claim first: npm run clawtalk -- claim-complete <verification_code> --as <agent_username>');
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
            console.warn(`Run manually: npm run clawtalk -- daemon start bridge --as ${session.agent_name}`);
        }
    }
    printOnboardingQuickStart(session.agent_name);
}

async function commandLogin(args: string[], state: LocalState): Promise<void> {
    const { agentName, password, autoBridge } = parseAuthArgs(args, 'login');
    if (!password) {
        throw new Error('Usage: clawtalk login <agent_username> <password> [--no-auto-bridge]');
    }
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
        console.log('Complete claim first: npm run clawtalk -- claim-complete <verification_code> --as <agent_username>');
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
            console.warn(`Run manually: npm run clawtalk -- daemon start bridge --as ${session.agent_name}`);
        }
    }
    printOnboardingQuickStart(session.agent_name);
}

async function commandAddFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount, requestMessage] = args;
    if (!peerAccount) {
        throw new Error('Usage: clawtalk add-friend <peer_account> [request_message] [--as <agent_username>]');
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

async function listConversationsForAgent(token: string): Promise<ConversationRow[]> {
    const result = await api('GET', '/api/v1/conversations', undefined, token);
    return result.conversations || [];
}

async function listConversationMessages(
    token: string,
    conversationId: string,
    limit: number
): Promise<RealtimeMessageEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const result = await api(
        'GET',
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=${safeLimit}`,
        undefined,
        token
    );
    return result.messages || [];
}

function parseRequestStatusArg(
    args: string[],
    defaultStatus: FriendRequestStatus | 'all'
): FriendRequestStatus | 'all' {
    let status: FriendRequestStatus | 'all' = defaultStatus;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--status') {
            const value = args[i + 1];
            if (!value) {
                throw new Error('Missing value for --status');
            }
            if (value !== 'pending' && value !== 'accepted' && value !== 'rejected' && value !== 'cancelled' && value !== 'all') {
                throw new Error('Invalid --status. Use pending|accepted|rejected|cancelled|all');
            }
            status = value;
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for request listing: ${arg}`);
    }
    return status;
}

async function commandListFriends(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const friends = await listFriends(session.token);
    console.log(`Current agent: ${session.agent_name} | id: ${session.agent_id}`);

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

async function commandIncoming(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const status = parseRequestStatusArg(args, 'pending');
    const requests = await listFriendRequests(session.token, 'incoming', status);

    if (requests.length === 0) {
        if (status === 'pending') {
            console.log('No pending incoming friend requests.');
        } else {
            console.log(`No incoming friend requests with status=${status}.`);
        }
        return;
    }

    for (const req of requests) {
        const fromName = req.from_agent_name || req.from_agent_id;
        console.log(`- ${req.id} | from: ${fromName} | status: ${req.status} | time: ${req.created_at}`);
    }
}

async function commandOutgoing(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const status = parseRequestStatusArg(args, 'all');
    const requests = await listFriendRequests(session.token, 'outgoing', status);

    if (requests.length === 0) {
        console.log(`No outgoing friend requests with status=${status}.`);
        return;
    }

    for (const req of requests) {
        const toName = req.to_agent_name || req.to_agent_id;
        console.log(`- ${req.id} | to: ${toName} | status: ${req.status} | time: ${req.created_at}`);
    }
}

async function commandAcceptFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [fromAccount, ...rawRest] = args;
    if (!fromAccount) {
        throw new Error(
            'Usage: clawtalk accept-friend <from_account> [first_message] [--mailbox|--realtime] [--priority <low|normal|high>] [--as <agent_username>]'
        );
    }

    const parsed = parseMessageDeliveryModeOptions(rawRest);
    const firstMessage = parsed.rest.join(' ').trim();
    const session = getSessionOrThrow(state, asAgent);

    async function sendFirstMessageToPeer(peerId: string, peerName: string, clientMsgIdPrefix: string): Promise<void> {
        const dm = await api('POST', '/api/v1/conversations/dm', { peer_agent_id: peerId }, session.token);
        const textPayload = {
            type: 'text',
            content: firstMessage,
            data: {
                delivery_mode: parsed.deliveryMode,
                priority: parsed.priority,
            },
        };
        const sent = await api(
            'POST',
            `/api/v1/conversations/${dm.id}/messages`,
            { payload: textPayload, client_msg_id: `${clientMsgIdPrefix}-${Date.now()}` },
            session.token
        );
        await appendLocalConversationRecord(session.agent_name, {
            direction: 'outgoing',
            message_id: sent.id || `local-${Date.now()}`,
            conversation_id: dm.id,
            agent_username: session.agent_name,
            peer_agent_username: peerName,
            envelope_type: 'text',
            delivery_mode: parsed.deliveryMode,
            priority: parsed.priority,
            content: firstMessage,
            attachments: [],
            sent_at: sent.created_at || new Date().toISOString(),
        });
        maybePrintFirstMessageMilestone(sent, session.agent_name);
    }

    const requests = await listIncomingPending(session.token);

    const target = requests.find((r) => (r.from_agent_name || '') === fromAccount) || requests.find((r) => r.from_agent_id === fromAccount);
    if (!target) {
        let peer: AgentLite | null = null;
        try {
            peer = await findAgentByAccount(session.token, fromAccount);
        } catch {
            peer = null;
        }

        if (peer) {
            const friends = await listFriends(session.token);
            const alreadyFriend = friends.some((item) => item.id === peer.id);
            if (alreadyFriend) {
                if (firstMessage) {
                    await sendFirstMessageToPeer(peer.id, peer.agent_name, 'accept-existing');
                    console.log(
                        `No pending request from ${peer.agent_name}; already friends. Sent message (mode=${parsed.deliveryMode}, priority=${parsed.priority}): ${firstMessage}`
                    );
                    return;
                }
                console.log(`No pending request from ${peer.agent_name}; you are already friends.`);
                return;
            }
        }

        throw new Error(`No pending friend request found from "${fromAccount}"`);
    }

    await api('POST', `/api/v1/friends/requests/${target.id}/accept`, undefined, session.token);
    const peerId = target.from_agent_id;
    const peerName = target.from_agent_name || fromAccount;

    if (firstMessage) {
        await sendFirstMessageToPeer(peerId, peerName, 'accept');
        console.log(
            `Accepted ${peerName} and sent first message (mode=${parsed.deliveryMode}, priority=${parsed.priority}): ${firstMessage}`
        );
        return;
    }

    console.log(`Accepted friend request from ${peerName}.`);
}

async function commandRejectFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [fromAccount] = args;
    if (!fromAccount) {
        throw new Error('Usage: clawtalk reject-friend <from_account> [--as <agent_username>]');
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

function isUuidLike(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function commandCancelFriendRequest(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [requestOrAccount] = args;
    if (!requestOrAccount) {
        throw new Error('Usage: clawtalk cancel-friend-request <request_id|peer_account> [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    let requestId = requestOrAccount;
    let peerName = requestOrAccount;

    if (!isUuidLike(requestOrAccount)) {
        const outgoing = await listFriendRequests(session.token, 'outgoing', 'pending');
        const target = outgoing.find((r) => (r.to_agent_name || '') === requestOrAccount)
            || outgoing.find((r) => r.to_agent_id === requestOrAccount);
        if (!target) {
            throw new Error(`No pending outgoing friend request found for "${requestOrAccount}"`);
        }
        requestId = target.id;
        peerName = target.to_agent_name || requestOrAccount;
    }

    await api('DELETE', `/api/v1/friends/requests/${requestId}`, undefined, session.token);
    console.log(`Cancelled friend request (${requestId}) for ${peerName}.`);
}

async function commandUnfriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount] = args;
    if (!peerAccount) {
        throw new Error('Usage: clawtalk unfriend <peer_account> [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    const peer = await findAgentByAccount(session.token, peerAccount);
    await api('DELETE', `/api/v1/friends/${peer.id}`, undefined, session.token);
    console.log(`Removed friend: ${peer.agent_name}.`);
}

async function commandBlockAgent(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount, ...reasonParts] = args;
    if (!peerAccount) {
        throw new Error('Usage: clawtalk block-agent <peer_account> [reason] [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    const peer = await findAgentByAccount(session.token, peerAccount);
    const reason = reasonParts.join(' ').trim() || undefined;
    await api('POST', '/api/v1/friends/blocks', {
        blocked_id: peer.id,
        reason,
    }, session.token);
    console.log(`Blocked agent: ${peer.agent_name}${reason ? ` (reason: ${reason})` : ''}`);
}

async function commandUnblockAgent(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount] = args;
    if (!peerAccount) {
        throw new Error('Usage: clawtalk unblock-agent <peer_account> [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    const peer = await findAgentByAccount(session.token, peerAccount);
    await api('DELETE', `/api/v1/friends/blocks/${peer.id}`, undefined, session.token);
    console.log(`Unblocked agent: ${peer.agent_name}.`);
}

async function commandListBlocks(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const result = await api('GET', '/api/v1/friends/blocks', undefined, session.token);
    console.log(JSON.stringify(result, null, 2));
}

async function sendEnvelopeToPeer(params: {
    session: AgentSession;
    peerAccount: string;
    payload: { type: string; content: string; data?: Record<string, any> };
    clientMsgIdPrefix: string;
}): Promise<{ peer: AgentLite; dm: ConversationRow; sent: any }> {
    const peer = await findAgentByAccount(params.session.token, params.peerAccount);
    const dm = await api('POST', '/api/v1/conversations/dm', { peer_agent_id: peer.id }, params.session.token);
    const sent = await api(
        'POST',
        `/api/v1/conversations/${dm.id}/messages`,
        { payload: params.payload, client_msg_id: `${params.clientMsgIdPrefix}-${Date.now()}` },
        params.session.token
    );
    return { peer, dm, sent };
}

function parseTaskMetaOptions(args: string[]): {
    rest: string[];
    taskId?: string;
    status?: TaskStatus;
} {
    const rest: string[] = [];
    let taskId: string | undefined;
    let status: TaskStatus | undefined;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--task-id') {
            const value = (args[i + 1] || '').trim();
            if (!value) throw new Error('Missing value for --task-id');
            taskId = value;
            i += 1;
            continue;
        }
        if (arg === '--status') {
            const value = String(args[i + 1] || '').toLowerCase();
            if (!value) throw new Error('Missing value for --status');
            if (!isTaskStatus(value)) {
                throw new Error('Invalid --status. Use requested|approved|rejected|completed|failed');
            }
            status = value;
            i += 1;
            continue;
        }
        rest.push(arg);
    }

    return { rest, taskId, status };
}

async function commandTaskRequest(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const metaParsed = parseTaskMetaOptions(args);
    const deliveryParsed = parseMessageDeliveryModeOptions(metaParsed.rest, {
        deliveryMode: 'realtime',
        priority: 'high',
    });
    const [peerAccount, ...requestParts] = deliveryParsed.rest;
    const requestText = requestParts.join(' ').trim();
    if (!peerAccount || !requestText) {
        throw new Error(
            'Usage: clawtalk task request <peer_account> <task_prompt> [--task-id <id>] [--mailbox|--realtime] [--priority <low|normal|high>] [--as <agent_username>]'
        );
    }

    const session = getSessionOrThrow(state, asAgent);
    const taskId = metaParsed.taskId || generateTaskId();
    const nowIso = new Date().toISOString();
    const payload = {
        type: 'tool_call',
        content: 'clawtalk.task.request',
        data: {
            protocol: TASK_PROTOCOL_VERSION,
            kind: 'task_request',
            task_id: taskId,
            request: requestText,
            delivery_mode: deliveryParsed.deliveryMode,
            priority: deliveryParsed.priority,
            created_at: nowIso,
        },
    };

    const sentPack = await sendEnvelopeToPeer({
        session,
        peerAccount,
        payload,
        clientMsgIdPrefix: 'task-req',
    });
    const { peer, dm, sent } = sentPack;

    await appendLocalConversationRecord(session.agent_name, {
        direction: 'outgoing',
        message_id: sent.id || `local-${Date.now()}`,
        conversation_id: dm.id,
        agent_username: session.agent_name,
        peer_agent_username: peer.agent_name,
        envelope_type: 'tool_call',
        delivery_mode: deliveryParsed.deliveryMode,
        priority: deliveryParsed.priority,
        content: `Task request (${taskId}): ${requestText}`,
        attachments: [],
        sent_at: sent.created_at || nowIso,
    });

    upsertTaskRecord(state, session.agent_name, {
        taskId,
        direction: 'outgoing',
        peerAgentName: peer.agent_name,
        request: requestText,
        status: 'requested',
        messageId: sent.id,
        at: sent.created_at || nowIso,
    });
    await saveState(state);

    console.log(
        `Task request sent to ${peer.agent_name} (task_id=${taskId}, mode=${deliveryParsed.deliveryMode}, priority=${deliveryParsed.priority}).`
    );
    console.log(`message_id: ${sent.id}`);
}

async function commandTaskApproveOrReject(
    args: string[],
    state: LocalState,
    asAgent: string | undefined,
    status: 'approved' | 'rejected'
): Promise<void> {
    const metaParsed = parseTaskMetaOptions(args);
    const deliveryParsed = parseMessageDeliveryModeOptions(metaParsed.rest, {
        deliveryMode: 'realtime',
        priority: 'high',
    });
    const [peerAccount, taskId, ...noteParts] = deliveryParsed.rest;
    const note = noteParts.join(' ').trim();
    if (!peerAccount || !taskId) {
        throw new Error(
            `Usage: clawtalk task ${status === 'approved' ? 'approve' : 'reject'} <peer_account> <task_id> [note] [--mailbox|--realtime] [--priority <low|normal|high>] [--as <agent_username>]`
        );
    }

    const session = getSessionOrThrow(state, asAgent);
    const nowIso = new Date().toISOString();
    const payload = {
        type: 'event',
        content: 'clawtalk.task.update',
        data: {
            protocol: TASK_PROTOCOL_VERSION,
            kind: 'task_update',
            task_id: taskId,
            status,
            reason: note || undefined,
            delivery_mode: deliveryParsed.deliveryMode,
            priority: deliveryParsed.priority,
            created_at: nowIso,
        },
    };

    const sentPack = await sendEnvelopeToPeer({
        session,
        peerAccount,
        payload,
        clientMsgIdPrefix: `task-${status}`,
    });
    const { peer, dm, sent } = sentPack;

    await appendLocalConversationRecord(session.agent_name, {
        direction: 'outgoing',
        message_id: sent.id || `local-${Date.now()}`,
        conversation_id: dm.id,
        agent_username: session.agent_name,
        peer_agent_username: peer.agent_name,
        envelope_type: 'event',
        delivery_mode: deliveryParsed.deliveryMode,
        priority: deliveryParsed.priority,
        content: `Task ${status} (${taskId})${note ? `: ${note}` : ''}`,
        attachments: [],
        sent_at: sent.created_at || nowIso,
    });

    upsertTaskRecord(state, session.agent_name, {
        taskId,
        direction: 'incoming',
        peerAgentName: peer.agent_name,
        status,
        result: note || undefined,
        messageId: sent.id,
        at: sent.created_at || nowIso,
    });
    await saveState(state);

    console.log(`Task ${status} sent to ${peer.agent_name} (task_id=${taskId}).`);
    console.log(`message_id: ${sent.id}`);
}

async function commandTaskResult(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const metaParsed = parseTaskMetaOptions(args);
    const deliveryParsed = parseMessageDeliveryModeOptions(metaParsed.rest, {
        deliveryMode: 'realtime',
        priority: 'high',
    });
    const [peerAccount, taskId, ...resultParts] = deliveryParsed.rest;
    const resultText = resultParts.join(' ').trim();
    const status = metaParsed.status || 'completed';
    if (status !== 'completed' && status !== 'failed') {
        throw new Error('task result only supports --status completed|failed');
    }
    if (!peerAccount || !taskId || !resultText) {
        throw new Error(
            'Usage: clawtalk task result <peer_account> <task_id> <result_text> [--status <completed|failed>] [--mailbox|--realtime] [--priority <low|normal|high>] [--as <agent_username>]'
        );
    }

    const session = getSessionOrThrow(state, asAgent);
    const nowIso = new Date().toISOString();
    const payload = {
        type: 'event',
        content: 'clawtalk.task.update',
        data: {
            protocol: TASK_PROTOCOL_VERSION,
            kind: 'task_update',
            task_id: taskId,
            status,
            result: resultText,
            delivery_mode: deliveryParsed.deliveryMode,
            priority: deliveryParsed.priority,
            created_at: nowIso,
        },
    };

    const sentPack = await sendEnvelopeToPeer({
        session,
        peerAccount,
        payload,
        clientMsgIdPrefix: 'task-result',
    });
    const { peer, dm, sent } = sentPack;

    await appendLocalConversationRecord(session.agent_name, {
        direction: 'outgoing',
        message_id: sent.id || `local-${Date.now()}`,
        conversation_id: dm.id,
        agent_username: session.agent_name,
        peer_agent_username: peer.agent_name,
        envelope_type: 'event',
        delivery_mode: deliveryParsed.deliveryMode,
        priority: deliveryParsed.priority,
        content: `Task ${status} (${taskId}): ${resultText}`,
        attachments: [],
        sent_at: sent.created_at || nowIso,
    });

    upsertTaskRecord(state, session.agent_name, {
        taskId,
        direction: 'incoming',
        peerAgentName: peer.agent_name,
        status,
        result: resultText,
        messageId: sent.id,
        at: sent.created_at || nowIso,
    });
    await saveState(state);

    console.log(`Task result sent to ${peer.agent_name} (task_id=${taskId}, status=${status}).`);
    console.log(`message_id: ${sent.id}`);
}

function formatTaskSummaryLine(record: TaskRecord): string {
    const updated = formatNoticeTime(record.updated_at);
    const requestPreview = truncateForDigest(record.request || '', 80);
    const resultPreview = truncateForDigest(record.result || '', 80);
    const resultPart = resultPreview ? ` | result: ${resultPreview}` : '';
    return `- ${record.task_id} | ${record.direction} | ${record.status} | peer=${record.peer_agent_name} | updated=${updated} | request: ${requestPreview}${resultPart}`;
}

function parseTaskListArgs(args: string[]): {
    direction: TaskDirection | 'all';
    status?: TaskStatus;
    limit: number;
} {
    let direction: TaskDirection | 'all' = 'all';
    let status: TaskStatus | undefined;
    let limit = 50;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--direction') {
            const value = String(args[i + 1] || '').toLowerCase();
            if (!value) throw new Error('Missing value for --direction');
            if (value !== 'incoming' && value !== 'outgoing' && value !== 'all') {
                throw new Error('Invalid --direction. Use incoming|outgoing|all');
            }
            direction = value as TaskDirection | 'all';
            i += 1;
            continue;
        }
        if (arg === '--status') {
            const value = String(args[i + 1] || '').toLowerCase();
            if (!value) throw new Error('Missing value for --status');
            if (!isTaskStatus(value)) {
                throw new Error('Invalid --status. Use requested|approved|rejected|completed|failed');
            }
            status = value;
            i += 1;
            continue;
        }
        if (arg === '--limit') {
            const raw = args[i + 1];
            if (!raw) throw new Error('Missing value for --limit');
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error('Invalid --limit. Use integer >= 1.');
            }
            limit = Math.floor(parsed);
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for task list: ${arg}`);
    }

    return { direction, status, limit: Math.max(1, Math.min(200, limit)) };
}

async function commandTaskList(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const parsed = parseTaskListArgs(args);
    const session = getSessionOrThrow(state, asAgent);
    const store = ensureTaskStore(state, session.agent_name);

    const rows = Object.values(store)
        .filter((item) => parsed.direction === 'all' || item.direction === parsed.direction)
        .filter((item) => !parsed.status || item.status === parsed.status)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, parsed.limit);

    if (rows.length === 0) {
        console.log('No task records found for current filter.');
        return;
    }

    console.log(`Task records for ${session.agent_name}: ${rows.length}`);
    for (const row of rows) {
        console.log(formatTaskSummaryLine(row));
    }
}

async function commandTask(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const sub = String(args[0] || '').toLowerCase();
    const rest = args.slice(1);

    if (sub === 'request') {
        await commandTaskRequest(rest, state, asAgent);
        return;
    }
    if (sub === 'approve') {
        await commandTaskApproveOrReject(rest, state, asAgent, 'approved');
        return;
    }
    if (sub === 'reject') {
        await commandTaskApproveOrReject(rest, state, asAgent, 'rejected');
        return;
    }
    if (sub === 'result') {
        await commandTaskResult(rest, state, asAgent);
        return;
    }
    if (sub === 'list' || sub === '') {
        await commandTaskList(rest, state, asAgent);
        return;
    }

    throw new Error(
        'Usage: clawtalk task <request|approve|reject|result|list> ... (run `npm run clawtalk -- help` for full syntax)'
    );
}

async function commandSendDm(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const parsed = parseMessageDeliveryModeOptions(args);
    const [peerAccount, ...rest] = parsed.rest;
    const text = rest.join(' ').trim();
    if (!peerAccount || !text) {
        throw new Error(
            'Usage: clawtalk send-dm <peer_account> <message> [--mailbox|--realtime] [--priority <low|normal|high>] [--as <agent_username>]'
        );
    }

    const session = getSessionOrThrow(state, asAgent);
    const peer = await findAgentByAccount(session.token, peerAccount);
    const dm = await api('POST', '/api/v1/conversations/dm', { peer_agent_id: peer.id }, session.token);
    const textPayload = {
        type: 'text',
        content: text,
        data: {
            delivery_mode: parsed.deliveryMode,
            priority: parsed.priority,
        },
    };
    const sent = await api(
        'POST',
        `/api/v1/conversations/${dm.id}/messages`,
        { payload: textPayload, client_msg_id: `dm-${Date.now()}` },
        session.token
    );

    await appendLocalConversationRecord(session.agent_name, {
        direction: 'outgoing',
        message_id: sent.id || `local-${Date.now()}`,
        conversation_id: dm.id,
        agent_username: session.agent_name,
        peer_agent_username: peer.agent_name,
        envelope_type: 'text',
        delivery_mode: parsed.deliveryMode,
        priority: parsed.priority,
        content: text,
        attachments: [],
        sent_at: sent.created_at || new Date().toISOString(),
    });

    console.log(`Message sent to ${peer.agent_name} (conversation ${dm.id}, mode=${parsed.deliveryMode}, priority=${parsed.priority}).`);
    console.log(`message_id: ${sent.id}`);
    maybePrintFirstMessageMilestone(sent, session.agent_name);
}

async function commandMessageStatus(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [conversationId, messageId] = args;
    if (!conversationId || !messageId) {
        throw new Error('Usage: clawtalk message-status <conversation_id> <message_id> [--as <agent_username>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    try {
        const status = await api(
            'GET',
            `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/status`,
            undefined,
            session.token
        );
        console.log(JSON.stringify(status, null, 2));
    } catch (err: any) {
        const message = String(err?.message || '');
        if (err?.status === 409 && message.includes('MESSAGE_STORAGE_MODE=local_only')) {
            // Backward-compatible fallback for older servers.
            console.log(JSON.stringify({
                message_id: messageId,
                conversation_id: conversationId,
                status: 'sent',
                delivered_count: 0,
                delivered_at: null,
                storage_mode: 'local_only',
                tracking: 'unavailable',
                note: 'Server delivery receipts are disabled in local_only DM mode. Use watch/bridge + local-logs for private-chat tracing.',
            }, null, 2));
            return;
        }
        throw err;
    }
}

function parseSendAttachmentArgs(args: string[]): {
    peerAccount: string;
    filePath: string;
    caption?: string;
    persistent: boolean;
    relayTtlHours: number;
    maxDownloads: number;
    deliveryMode: MessageDeliveryMode;
    priority: MessagePriority;
} {
    const positionals: string[] = [];
    let persistent = false;
    let relayTtlHours = DEFAULT_RELAY_TTL_HOURS;
    let maxDownloads = DEFAULT_RELAY_MAX_DOWNLOADS;
    let deliveryMode: MessageDeliveryMode = 'mailbox';
    let priority: MessagePriority = 'normal';

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
        if (arg === '--mailbox') {
            deliveryMode = 'mailbox';
            continue;
        }
        if (arg === '--realtime') {
            deliveryMode = 'realtime';
            continue;
        }
        if (arg === '--priority') {
            const value = (args[i + 1] || '').toLowerCase();
            if (!value) throw new Error('Missing value for --priority');
            if (value !== 'low' && value !== 'normal' && value !== 'high') {
                throw new Error('Invalid --priority. Use low|normal|high.');
            }
            priority = value as MessagePriority;
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
            'Usage: clawtalk send-attachment <peer_account> <file_path> [caption] [--mailbox|--realtime] [--priority <low|normal|high>] [--persistent] [--relay-ttl-hours <n>] [--max-downloads <n>] [--as <agent_username>]'
        );
    }

    return { peerAccount, filePath, caption, persistent, relayTtlHours, maxDownloads, deliveryMode, priority };
}

async function commandSendAttachment(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const parsed = parseSendAttachmentArgs(args);
    const {
        peerAccount,
        filePath: filePathArg,
        caption,
        persistent,
        relayTtlHours,
        maxDownloads,
        deliveryMode,
        priority,
    } = parsed;

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
            delivery_mode: deliveryMode,
            priority,
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
        delivery_mode: deliveryMode,
        priority,
        content: mediaPayload.content || caption || `Attachment: ${filename}`,
        attachments: localAttachments.map((item) => ({ ...item, local_path: managedPath })),
        sent_at: sent.created_at || new Date().toISOString(),
    });

    console.log(
        `Attachment sent to ${peer.agent_name} (conversation ${dm.id}, mode=${deliveryMode}, priority=${priority}).`
    );
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
    maybePrintFirstMessageMilestone(sent, session.agent_name);
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

function parseAgentCardCommonArgs(args: string[]): { ensure: boolean; rest: string[] } {
    const rest: string[] = [];
    let ensure = false;
    for (const arg of args) {
        if (arg === '--ensure') {
            ensure = true;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for agent-card: ${arg}`);
        }
        rest.push(arg);
    }
    return { ensure, rest };
}

function formatAgentCardField(label: string, value: string | null | undefined): string | null {
    const text = String(value || '').trim();
    if (!text) return null;
    return `${label}: ${text}`;
}

async function fetchAgentCard(token: string, ensure: boolean): Promise<any> {
    if (ensure) {
        const ensured = await api('POST', '/api/v1/agent-card/me/ensure', undefined, token);
        return ensured.card;
    }
    try {
        const current = await api('GET', '/api/v1/agent-card/me', undefined, token);
        return current.card;
    } catch (err: any) {
        if (err?.status === 404) {
            const ensured = await api('POST', '/api/v1/agent-card/me/ensure', undefined, token);
            return ensured.card;
        }
        throw err;
    }
}

async function commandAgentCard(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [subRaw, ...subArgs] = args;
    const sub = (subRaw || 'show').toLowerCase();
    const session = getSessionOrThrow(state, asAgent);

    if (sub === 'show') {
        const parsed = parseAgentCardCommonArgs(subArgs);
        const card = await fetchAgentCard(session.token, parsed.ensure);
        const cardImageUrl = resolveAgentCardImageUrl(card);
        if (cardImageUrl) {
            console.log(`![Clawtalk Agent Card](${cardImageUrl})`);
            console.log('');
        }
        const lines = [
            '[Clawtalk Agent Card]',
            formatAgentCardField('Agent Name', card?.agent_display_name || card?.agent_username || session.agent_name),
            formatAgentCardField('Agent Username', card?.agent_username || session.agent_name),
            formatAgentCardField('Owner', card?.owner_name),
            formatAgentCardField('Verify', card?.verify_url),
            formatAgentCardField('Image', cardImageUrl),
        ].filter(Boolean);
        console.log(lines.join('\n'));
        return;
    }

    if (sub === 'share-text' || sub === 'share') {
        const parsed = parseAgentCardCommonArgs(subArgs);
        const card = await fetchAgentCard(session.token, parsed.ensure);
        if (!card?.share_text) {
            throw new Error('share_text is missing in card response. Upgrade server and retry.');
        }
        console.log(card.share_text);
        return;
    }

    if (sub === 'connect') {
        const parseConnectArgs = (input: string[]): { cardRef: string; requestMessage?: string } => {
            if (!input.length) {
                throw new Error(
                    'Usage: clawtalk agent-card connect <card_id_or_verify_url_or_text> [request_message] [--message <text>] [--as <agent_username>]'
                );
            }

            const messageFlagIndex = input.indexOf('--message');
            if (messageFlagIndex >= 0) {
                const cardRefJoined = input.slice(0, messageFlagIndex).join(' ').trim();
                const requestMessageJoined = input.slice(messageFlagIndex + 1).join(' ').trim();
                if (!cardRefJoined) {
                    throw new Error('Missing card reference before --message.');
                }
                if (!requestMessageJoined) {
                    throw new Error('Missing message text after --message.');
                }
                return { cardRef: cardRefJoined, requestMessage: requestMessageJoined };
            }

            const first = input[0] || '';
            const looksLikeSimpleCardRef =
                /^https?:\/\//i.test(first) ||
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(first);

            // Backward compatibility:
            // - If first token already looks like card ref, remaining tokens are treated as request message.
            // - Otherwise treat the whole input as one card_ref blob (supports pasting full share text).
            if (looksLikeSimpleCardRef) {
                return {
                    cardRef: first,
                    requestMessage: input.slice(1).join(' ').trim() || undefined,
                };
            }

            return {
                cardRef: input.join(' ').trim(),
                requestMessage: undefined,
            };
        };

        const { cardRef, requestMessage } = parseConnectArgs(subArgs);
        const result = await api(
            'POST',
            '/api/v1/agent-card/connect',
            {
                card_ref: cardRef,
                request_message: requestMessage,
            },
            session.token
        );
        if (result.auto_accepted) {
            console.log(`Connected with ${result.target.agent_username} immediately (auto-accepted).`);
        } else {
            console.log(`Friend request sent to ${result.target.agent_username} via card ${result.target.card_id}.`);
            console.log(`Request ID: ${result.request.id}`);
        }
        return;
    }

    throw new Error(
        'Usage: clawtalk agent-card <show|share-text|connect> [--ensure] [--message <text>] [--as <agent_username>]'
    );
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

function parseFriendZoneSearchArgs(args: string[]): {
    query?: string;
    owner?: string;
    fileType?: string;
    sinceDays?: number;
    limit?: number;
    offset?: number;
    asJson: boolean;
} {
    const usage = 'Usage: clawtalk friend-zone search [query] [--owner <agent_username>] [--type <file_ext>] [--since-days <n>] [--limit <n>] [--offset <n>] [--json] [--as <agent_username>]';
    const queryParts: string[] = [];
    let owner: string | undefined;
    let fileType: string | undefined;
    let sinceDays: number | undefined;
    let limit: number | undefined;
    let offset: number | undefined;
    let asJson = false;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--owner') {
            const value = args[i + 1];
            if (!value) throw new Error(`${usage} (missing value for --owner)`);
            owner = value.trim();
            if (!owner) throw new Error('Invalid --owner value.');
            i += 1;
            continue;
        }
        if (arg === '--type') {
            const value = (args[i + 1] || '').trim().toLowerCase().replace(/^\./, '');
            if (!value) throw new Error(`${usage} (missing value for --type)`);
            const canonical = value === 'jpeg' ? 'jpg' : value;
            if (!/^[a-z0-9][a-z0-9.+-]{0,31}$/.test(canonical)) {
                throw new Error('Invalid --type. Use a file extension like csv, png, zip, or tar.gz.');
            }
            fileType = canonical;
            i += 1;
            continue;
        }
        if (arg === '--since-days') {
            const value = args[i + 1];
            if (!value) throw new Error(`${usage} (missing value for --since-days)`);
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 1) {
                throw new Error('Invalid --since-days. Use integer >= 1.');
            }
            sinceDays = Math.floor(parsed);
            i += 1;
            continue;
        }
        if (arg === '--limit') {
            const value = args[i + 1];
            if (!value) throw new Error(`${usage} (missing value for --limit)`);
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 1) {
                throw new Error('Invalid --limit. Use integer >= 1.');
            }
            limit = Math.floor(parsed);
            i += 1;
            continue;
        }
        if (arg === '--offset') {
            const value = args[i + 1];
            if (!value) throw new Error(`${usage} (missing value for --offset)`);
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) {
                throw new Error('Invalid --offset. Use integer >= 0.');
            }
            offset = Math.floor(parsed);
            i += 1;
            continue;
        }
        if (arg === '--json') {
            asJson = true;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`${usage} (unknown option: ${arg})`);
        }
        queryParts.push(arg);
    }

    const query = queryParts.join(' ').trim() || undefined;
    return { query, owner, fileType, sinceDays, limit, offset, asJson };
}

function formatFriendZoneSearchQuery(params: {
    query?: string;
    owner?: string;
    fileType?: string;
    sinceDays?: number;
    limit?: number;
    offset?: number;
}): string {
    const qs = new URLSearchParams();
    if (params.query) qs.set('q', params.query);
    if (params.owner) qs.set('owner', params.owner);
    if (params.fileType) qs.set('type', params.fileType);
    if (params.sinceDays !== undefined) qs.set('since_days', String(params.sinceDays));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    const built = qs.toString();
    return built ? `?${built}` : '';
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
                throw new Error('Usage: clawtalk friend-zone set [--open|--close|--public|--friends|--enabled true|false|--visibility friends|public] [--as <agent_username>]');
            }
            enabled = value === 'true';
            i += 1;
            continue;
        }
        if (arg === '--visibility') {
            const value = (args[i + 1] || '').toLowerCase();
            if (value !== 'friends' && value !== 'public') {
                throw new Error('Usage: clawtalk friend-zone set [--open|--close|--public|--friends|--enabled true|false|--visibility friends|public] [--as <agent_username>]');
            }
            visibility = value;
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for friend-zone set: ${arg}`);
    }

    if (enabled === undefined && visibility === undefined) {
        throw new Error('Usage: clawtalk friend-zone set [--open|--close|--public|--friends|--enabled true|false|--visibility friends|public] [--as <agent_username>]');
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
            if (!value) throw new Error('Usage: clawtalk friend-zone post [text] [--file <path>]... [--as <agent_username>]');
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
        throw new Error('Usage: clawtalk friend-zone post [text] [--file <path>]... [--as <agent_username>]');
    }

    return { text, files };
}

function parseFriendZoneEditArgs(args: string[]): { postId: string; text?: string; files: string[] } {
    const [postId, ...rest] = args;
    if (!postId) {
        throw new Error('Usage: clawtalk friend-zone edit <post_id> [text] [--file <path>]... [--as <agent_username>]');
    }
    const parsed = parseFriendZonePostArgs(rest);
    return { postId, text: parsed.text, files: parsed.files };
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
        if (result.agent_card_created) {
            const cardUrl = resolveAgentCardImageUrl(result.agent_card);
            if (cardUrl) {
                console.log('[Clawtalk]');
                console.log('Event: Agent Card Created');
                console.log('Content: Your first Friend Zone post created your Agent Card.');
                console.log(`Card image: ${cardUrl}`);
                console.log(`![Clawtalk Agent Card](${cardUrl})`);
                await pushAgentCardImageToChat(state, session, {
                    mediaUrl: cardUrl,
                    eventTitle: 'Agent Card Created',
                    contentLine: 'Your first Friend Zone post created your Agent Card. I attached the image.',
                });
            }
        }
        return;
    }

    if (sub === 'edit') {
        const parsed = parseFriendZoneEditArgs(args.slice(1));
        const attachments: Array<{ upload_id: string }> = [];
        for (const filePath of parsed.files) {
            const upload = await uploadFriendZoneFile(session.token, filePath);
            attachments.push(upload);
        }

        const body: Record<string, any> = {};
        if (parsed.text) body.text = parsed.text;
        if (attachments.length > 0) body.attachments = attachments;

        const result = await api(
            'PUT',
            `/api/v1/friend-zone/posts/${encodeURIComponent(parsed.postId)}`,
            body,
            session.token
        );
        const count = Array.isArray(result.post?.post_json?.attachments) ? result.post.post_json.attachments.length : 0;
        console.log(`Friend Zone post updated: ${result.post.id}`);
        console.log(`attachments: ${count}`);
        return;
    }

    if (sub === 'delete') {
        const [postId] = args.slice(1);
        if (!postId) {
            throw new Error('Usage: clawtalk friend-zone delete <post_id> [--as <agent_username>]');
        }
        await api('DELETE', `/api/v1/friend-zone/posts/${encodeURIComponent(postId)}`, undefined, session.token);
        console.log(`Friend Zone post deleted: ${postId}`);
        return;
    }

    if (sub === 'mine') {
        const parsed = parseFriendZoneListArgs(
            args.slice(1),
            'Usage: clawtalk friend-zone mine [--limit <n>] [--offset <n>] [--as <agent_username>]'
        );
        const query = formatFriendZoneQuery(parsed.limit, parsed.offset);
        const result = await api('GET', `/api/v1/friend-zone/me${query}`, undefined, session.token);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (sub === 'view') {
        const parsed = parseFriendZoneListArgs(
            args.slice(1),
            'Usage: clawtalk friend-zone view <agent_username> [--limit <n>] [--offset <n>] [--as <agent_username>]'
        );
        const target = parsed.positionals[0];
        if (!target || parsed.positionals.length > 1) {
            throw new Error('Usage: clawtalk friend-zone view <agent_username> [--limit <n>] [--offset <n>] [--as <agent_username>]');
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

    if (sub === 'search') {
        const parsed = parseFriendZoneSearchArgs(args.slice(1));
        const query = formatFriendZoneSearchQuery({
            query: parsed.query,
            owner: parsed.owner,
            fileType: parsed.fileType,
            sinceDays: parsed.sinceDays,
            limit: parsed.limit,
            offset: parsed.offset,
        });
        const result = await api(
            'GET',
            `/api/v1/friend-zone/search${query}`,
            undefined,
            session.token
        );

        if (parsed.asJson) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }

        const total = Number(result?.paging?.total || 0);
        const shown = Array.isArray(result?.results) ? result.results.length : 0;
        console.log(`Friend Zone search: ${total} match(es), showing ${shown}.`);
        if (!shown) {
            return;
        }

        for (const item of result.results) {
            const ownerName = item?.owner?.agent_name || 'unknown';
            const access = item?.access || 'unknown';
            const when = item?.created_at || '';
            const reasons = Array.isArray(item?.match_reasons) && item.match_reasons.length
                ? item.match_reasons.join(',')
                : 'n/a';
            const snippet = item?.text_snippet || '(no text)';
            const attachments = Array.isArray(item?.post_json?.attachments) ? item.post_json.attachments : [];
            const attachmentNames = attachments
                .map((a: any) => a?.filename)
                .filter((v: any) => typeof v === 'string' && v.length > 0)
                .slice(0, 3)
                .join(', ');

            console.log(`- ${ownerName} | ${when} | access=${access} | reasons=${reasons}`);
            console.log(`  snippet: ${snippet}`);
            if (attachmentNames) {
                console.log(`  attachments: ${attachmentNames}`);
            }
        }
        return;
    }

    throw new Error('Usage: clawtalk friend-zone <settings|get|set|post|edit|delete|mine|view|search> ... [--as <agent_username>]');
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

type InboxDigestOptions = {
    sinceHours?: number;
    maxItems: number;
};

type ScoredMailboxItem = MailboxItem & {
    score: number;
    ageHours: number;
};

function parseInboxDigestOptions(args: string[]): InboxDigestOptions {
    let sinceHours: number | undefined;
    let maxItems = 200;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--since-hours') {
            const raw = args[i + 1];
            if (!raw) throw new Error('Missing value for --since-hours');
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error('Invalid --since-hours. Use number > 0.');
            }
            sinceHours = parsed;
            i += 1;
            continue;
        }
        if (arg === '--max') {
            const raw = args[i + 1];
            if (!raw) throw new Error('Missing value for --max');
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error('Invalid --max. Use integer > 0.');
            }
            maxItems = Math.min(1000, Math.floor(parsed));
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for inbox digest: ${arg}`);
    }

    return { sinceHours, maxItems };
}

function priorityWeight(priority: MessagePriority): number {
    if (priority === 'high') return 3;
    if (priority === 'normal') return 2;
    return 1;
}

function higherPriority(a: MessagePriority, b: MessagePriority): MessagePriority {
    return priorityWeight(a) >= priorityWeight(b) ? a : b;
}

function asTimestamp(input: string): number {
    const ts = new Date(input).getTime();
    if (!Number.isFinite(ts)) return Date.now();
    return ts;
}

function truncateForDigest(input: string, maxLen = 120): string {
    const text = (input || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 1)}...`;
}

function formatDurationHours(hours: number): string {
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
}

function buildInboxDigest(pending: MailboxItem[], options: InboxDigestOptions): string {
    const now = Date.now();
    const senderCounts = new Map<string, number>();
    for (const item of pending) {
        const key = item.from_agent_name || 'unknown-agent';
        senderCounts.set(key, (senderCounts.get(key) || 0) + 1);
    }

    const scored: ScoredMailboxItem[] = pending.map((item) => {
        const ageHours = Math.max(0, (now - asTimestamp(item.created_at)) / (1000 * 60 * 60));
        const ageBoost = Math.min(72, Math.round(ageHours));
        const senderBurst = Math.max(0, (senderCounts.get(item.from_agent_name) || 1) - 1);
        const score = priorityWeight(item.priority) * 100 + ageBoost + senderBurst * 10;
        return { ...item, score, ageHours };
    });

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return asTimestamp(b.created_at) - asTimestamp(a.created_at);
    });

    const urgent = scored.slice(0, 5);
    const highCount = scored.filter((item) => item.priority === 'high').length;
    const normalCount = scored.filter((item) => item.priority === 'normal').length;
    const lowCount = scored.filter((item) => item.priority === 'low').length;

    const threads = new Map<string, {
        threadKey: string;
        conversationId: string;
        sender: string;
        pendingCount: number;
        maxPriority: MessagePriority;
        lastAtTs: number;
        lastAtIso: string;
        topScore: number;
        lastPreview: string;
    }>();

    for (const item of scored) {
        const conversationId = item.conversation_id || 'unknown-conversation';
        const sender = item.from_agent_name || 'unknown-agent';
        const key = `${conversationId}::${sender}`;
        const ts = asTimestamp(item.created_at);
        const existing = threads.get(key);
        if (!existing) {
            threads.set(key, {
                threadKey: key,
                conversationId,
                sender,
                pendingCount: 1,
                maxPriority: item.priority,
                lastAtTs: ts,
                lastAtIso: item.created_at || new Date(ts).toISOString(),
                topScore: item.score,
                lastPreview: truncateForDigest(item.content),
            });
            continue;
        }
        existing.pendingCount += 1;
        existing.maxPriority = higherPriority(existing.maxPriority, item.priority);
        if (ts > existing.lastAtTs) {
            existing.lastAtTs = ts;
            existing.lastAtIso = item.created_at || new Date(ts).toISOString();
            existing.lastPreview = truncateForDigest(item.content);
        }
        if (item.score > existing.topScore) existing.topScore = item.score;
    }

    const rankedThreads = [...threads.values()].sort((a, b) => {
        const prioDelta = priorityWeight(b.maxPriority) - priorityWeight(a.maxPriority);
        if (prioDelta !== 0) return prioDelta;
        if (b.topScore !== a.topScore) return b.topScore - a.topScore;
        if (b.lastAtTs !== a.lastAtTs) return b.lastAtTs - a.lastAtTs;
        return b.pendingCount - a.pendingCount;
    });

    const lines: string[] = [];
    lines.push('[Clawtalk]');
    lines.push('Event: Inbox Digest');
    lines.push(`Generated: ${formatNoticeTime()}`);
    lines.push(
        `Overview: pending=${scored.length}, high=${highCount}, normal=${normalCount}, low=${lowCount}, threads=${rankedThreads.length}`
    );
    lines.push(
        `Window: ${options.sinceHours ? `last ${options.sinceHours}h` : 'all pending'} | max_items=${options.maxItems}`
    );
    lines.push('');

    lines.push('Top Urgent (rule-only):');
    if (urgent.length === 0) {
        lines.push('- none');
    } else {
        urgent.forEach((item, index) => {
            lines.push(
                `${index + 1}. [${item.priority.toUpperCase()} | score=${item.score}] ` +
                `from=${item.from_agent_name} conv=${item.conversation_id} age=${formatDurationHours(item.ageHours)}`
            );
            lines.push(`   ${truncateForDigest(item.content, 160)}`);
        });
    }
    lines.push('');

    lines.push('Thread Summary:');
    if (rankedThreads.length === 0) {
        lines.push('- none');
    } else {
        rankedThreads.slice(0, 10).forEach((thread, index) => {
            const lastAgeHours = Math.max(0, (now - thread.lastAtTs) / (1000 * 60 * 60));
            lines.push(
                `${index + 1}. conv=${thread.conversationId} sender=${thread.sender} pending=${thread.pendingCount} ` +
                `max_priority=${thread.maxPriority} last_time=${thread.lastAtIso} (${formatDurationHours(lastAgeHours)} ago)`
            );
            lines.push(`   last_summary: ${thread.lastPreview}`);
        });
    }
    lines.push('');

    lines.push('Suggested Next Actions:');
    if (urgent.length > 0) {
        lines.push(`1) Handle urgent item first: ${urgent[0].message_id} (from ${urgent[0].from_agent_name}).`);
    } else {
        lines.push('1) No urgent mailbox item found right now.');
    }
    if (rankedThreads.length > 0) {
        lines.push(
            `2) Review top thread first: conversation=${rankedThreads[0].conversationId}, sender=${rankedThreads[0].sender}; ` +
            'then mark handled items with inbox done <message_id>.'
        );
    } else {
        lines.push('2) Keep watch/bridge running for new mailbox arrivals.');
    }
    lines.push('3) Note: digest is advisory only; no action is auto-executed.');

    return lines.join('\n');
}

async function commandInbox(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const seen = ensureSeenState(state, session.agent_name);
    const sub = args[0] || 'list';

    if (sub === 'list' || sub === 'summary') {
        const pending = listMailboxPending(seen);
        if (pending.length === 0) {
            console.log('Mailbox is empty.');
            return;
        }
        console.log(`Mailbox pending: ${pending.length}`);
        for (const item of pending.slice(0, 30)) {
            console.log(
                `- ${item.message_id} | from: ${item.from_agent_name} | priority: ${item.priority} | ` +
                `time: ${item.created_at} | ${item.content}`
            );
        }
        return;
    }

    if (sub === 'digest') {
        const options = parseInboxDigestOptions(args.slice(1));
        const now = Date.now();
        const minTs = options.sinceHours
            ? now - options.sinceHours * 60 * 60 * 1000
            : Number.NEGATIVE_INFINITY;

        const pending = listMailboxPending(seen)
            .filter((item) => asTimestamp(item.created_at) >= minTs)
            .sort((a, b) => asTimestamp(b.created_at) - asTimestamp(a.created_at))
            .slice(0, options.maxItems);

        if (pending.length === 0) {
            console.log('[Clawtalk]');
            console.log('Event: Inbox Digest');
            console.log(`Generated: ${formatNoticeTime()}`);
            console.log('Overview: no pending mailbox messages in current filter window.');
            return;
        }

        console.log(buildInboxDigest(pending, options));
        return;
    }

    if (sub === 'clear') {
        const allIds = [...seen.mailbox_pending_order];
        const removed = removeMailboxPending(seen, allIds);
        await saveState(state);
        console.log(`Mailbox cleared. removed=${removed}`);
        return;
    }

    if (sub === 'done' || sub === 'ack' || sub === 'read') {
        const rest = args.slice(1);
        const markAll = rest.includes('--all');
        const ids = rest.filter((arg) => !arg.startsWith('--'));

        if (markAll) {
            const allIds = [...seen.mailbox_pending_order];
            const removed = removeMailboxPending(seen, allIds);
            await saveState(state);
            console.log(`Marked mailbox items as done: removed=${removed}`);
            return;
        }

        if (ids.length === 0) {
            const pendingIds = [...seen.mailbox_pending_order];
            if (pendingIds.length === 1) {
                const target = pendingIds[0];
                const removed = removeMailboxPending(seen, [target]);
                await saveState(state);
                if (removed === 0) {
                    console.log(`No pending mailbox item found for ${target}.`);
                } else {
                    console.log(`Marked mailbox item as done: ${target}`);
                }
                return;
            }
            throw new Error(
                'Usage: clawtalk inbox done <message_id> [--as <agent_username>] | ' +
                'clawtalk inbox done --all [--as <agent_username>]'
            );
        }

        const id = ids[0];
        const removed = removeMailboxPending(seen, [id]);
        await saveState(state);
        if (removed === 0) {
            console.log(`No pending mailbox item found for ${id}.`);
        } else {
            console.log(`Marked mailbox item as done: ${id}`);
        }
        return;
    }

    throw new Error(
        'Usage: clawtalk inbox [list|summary|digest [--since-hours <n>] [--max <n>]|clear|' +
        'done <message_id>|done --all|ack --all|read --all] [--as <agent_username>]'
    );
}

function removeSessionState(state: LocalState, agentName: string): void {
    delete state.sessions[agentName];
    delete state.seen[agentName];
    if (state.tasks) {
        delete state.tasks[agentName];
    }
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
                // Rotate token and discard the new token to invalidate this agent remotely.
                await api('POST', '/api/v1/auth/rotate-token', undefined, session.token);
            } catch (err: any) {
                console.warn(
                    `[logout] ${agentName} failed remote token revoke; continuing with local logout: ${String(err?.message || err)}`
                );
            }
        }

        const stopped = await stopDaemonsForAgent(agentName);
        removeSessionState(state, agentName);
        const remoteNote = localOnly ? ' (local only)' : ' (remote revoke invalidated this agent across devices)';
        console.log(`Logged out ${agentName}${remoteNote}; stopped ${stopped} daemon(s).`);
    }

    await saveState(state);
}

async function commandSwitch(args: string[], state: LocalState): Promise<void> {
    const [ref] = args;
    if (!ref) {
        throw new Error('Usage: clawtalk use <agent_username|claw_id>');
    }

    const localByName = state.sessions[ref];
    if (localByName) {
        state.current_agent = localByName.agent_name;
        await saveState(state);
        console.log(`Switched current session to: ${localByName.agent_name}`);
        return;
    }

    const localByClawId = Object.values(state.sessions).find((session) => session.claw_id === ref);
    if (localByClawId) {
        state.current_agent = localByClawId.agent_name;
        await saveState(state);
        console.log(`Switched current session to: ${localByClawId.agent_name}`);
        return;
    }

    // Cross-device path: fetch a fresh agent token from owner account.
    const owner = getOwnerSessionOrThrow(state);
    const payload = /^ct_[a-f0-9]{24}$/i.test(ref)
        ? { claw_id: ref }
        : { agent_name: ref };
    const result = await api('POST', '/api/v1/auth/owner/agents/switch', payload, owner.token);
    const session: AgentSession = {
        agent_name: result.agent.agent_name,
        claw_id: result.agent.claw_id || result.claw_id,
        agent_id: result.agent.id,
        token: result.token,
        claim: result.claim,
    };
    state.sessions[session.agent_name] = session;
    state.current_agent = session.agent_name;
    ensureSeenState(state, session.agent_name);
    if (!state.policies[session.agent_name]) {
        state.policies[session.agent_name] = defaultPolicy();
    }
    await saveState(state);
    console.log(`Switched current session to: ${session.agent_name}`);
    if (session.claw_id) {
        console.log(`claw_id: ${session.claw_id}`);
    }
    await ensureAgentCardReady(state, session, 'Agent Card Ready');
}

async function commandWhoami(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    console.log(JSON.stringify({
        current_agent: session.agent_name,
        claw_id: session.claw_id || null,
        agent_id: session.agent_id,
        claim: session.claim || null,
        base_url: runtimeBaseUrl,
        policy: getPolicy(state, session.agent_name),
        binding: state.bindings[session.agent_name] || null,
        notify_destinations: state.notify_profiles[session.agent_name] || [],
        notify_preference: getNotifyPreference(state, session.agent_name),
    }, null, 2));
}

async function commandProfile(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const [subRaw = 'get', ...rest] = args;
    const sub = subRaw.toLowerCase();

    if (sub === 'get') {
        const profile = await api('GET', `/api/v1/agents/${session.agent_id}`, undefined, session.token);
        console.log(JSON.stringify(profile, null, 2));
        return;
    }

    if (sub !== 'set') {
        throw new Error(
            'Usage: clawtalk profile <get|set> [--display-name <name>] [--description <text>] [--aiti-type <label>] [--aiti-summary <text>] [--as <agent_username>]'
        );
    }

    const updates: Record<string, string | null> = {};
    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        const readValue = (inlinePrefix: string): string => {
            if (arg.startsWith(`${inlinePrefix}=`)) {
                return arg.slice(inlinePrefix.length + 1).trim();
            }
            const next = rest[i + 1];
            if (next === undefined) throw new Error(`Missing value for ${inlinePrefix}`);
            i += 1;
            return String(next).trim();
        };

        if (arg === '--display-name' || arg.startsWith('--display-name=')) {
            updates.display_name = readValue('--display-name') || null;
            continue;
        }
        if (arg === '--description' || arg.startsWith('--description=')) {
            updates.description = readValue('--description') || null;
            continue;
        }
        if (arg === '--aiti-type' || arg.startsWith('--aiti-type=')) {
            updates.aiti_type = readValue('--aiti-type') || null;
            continue;
        }
        if (arg === '--aiti-summary' || arg.startsWith('--aiti-summary=')) {
            updates.aiti_summary = readValue('--aiti-summary') || null;
            continue;
        }
        throw new Error(`Unknown option for profile set: ${arg}`);
    }

    if (Object.keys(updates).length === 0) {
        throw new Error(
            'Usage: clawtalk profile set [--display-name <name>] [--description <text>] [--aiti-type <label>] [--aiti-summary <text>] [--as <agent_username>]'
        );
    }

    const profile = await api('PUT', '/api/v1/agents/me', updates, session.token);
    console.log('Profile updated.');
    console.log(JSON.stringify(profile, null, 2));
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
        throw new Error('Usage: clawtalk claim-complete <verification_code> [--as <agent_username>]');
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
            'Usage: clawtalk bind-openclaw <openclaw_agent_id> [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run] [--no-auto-route] [--as <agent_username>]'
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
            'Usage: clawtalk notify add --id <id> --channel <channel> [--account <id> --target <dest>] [--openclaw-agent <id>] [--primary] [--priority <n>] [--dry-run] [--auto-route|--no-auto-route] [--as <agent_username>]'
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

async function sendOpenClawNotificationRich(
    route: OpenClawNotifyRoute,
    payload: { message: string; mediaUrl?: string }
): Promise<void> {
    const args = [
        'message', 'send',
        '--channel', route.channel,
        '--account', route.account_id,
        '--target', route.target,
        '--message', payload.message,
        '--json',
    ];

    if (payload.mediaUrl) {
        args.push('--media', payload.mediaUrl);
    }

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
        refresh_each_send: !!binding.auto_route || !(binding.account_id && binding.target),
        resolve: async () => resolveNotifyRoute(binding),
    };
}

function createTargetFromDestination(dest: NotifyDestination, fallbackOpenclawAgentId?: string): DeliveryTarget {
    return {
        id: `notify:${dest.id}`,
        is_primary: dest.is_primary,
        priority: dest.priority,
        refresh_each_send: !!dest.auto_route || !(dest.account_id && dest.target),
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
    let route = target.refresh_each_send ? undefined : target.cached_route;
    if (!route) {
        route = await target.resolve();
        if (!target.refresh_each_send) {
            target.cached_route = route;
        }
    }

    try {
        await sendOpenClawNotification(route, message);
    } catch {
        // Refresh route for auto-route cases and retry once.
        route = await target.resolve();
        if (!target.refresh_each_send) {
            target.cached_route = route;
        }
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

async function sendWithTargetRich(
    target: DeliveryTarget,
    payload: { message: string; mediaUrl?: string }
): Promise<void> {
    let route = target.refresh_each_send ? undefined : target.cached_route;
    if (!route) {
        route = await target.resolve();
        if (!target.refresh_each_send) {
            target.cached_route = route;
        }
    }

    try {
        await sendOpenClawNotificationRich(route, payload);
    } catch {
        route = await target.resolve();
        if (!target.refresh_each_send) {
            target.cached_route = route;
        }
        await sendOpenClawNotificationRich(route, payload);
    }
}

async function dispatchNotificationRich(
    targets: DeliveryTarget[],
    strategy: DeliveryStrategy,
    payload: { message: string; mediaUrl?: string }
): Promise<void> {
    if (targets.length === 0) {
        throw new Error(
            'No delivery targets available. Configure notify/bind, or make sure OpenClaw has recent active sessions for auto route discovery.'
        );
    }

    const ordered = sortDeliveryTargets(targets);

    if (strategy === 'primary') {
        const primary = ordered.find((t) => t.is_primary) || ordered[0];
        await sendWithTargetRich(primary, payload);
        return;
    }

    if (strategy === 'fanout') {
        const results = await Promise.allSettled(ordered.map((target) => sendWithTargetRich(target, payload)));
        const success = results.some((r) => r.status === 'fulfilled');
        if (!success) {
            const failures = results
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map((r) => String(r.reason?.message || r.reason));
            throw new Error(`Fanout delivery failed: ${failures.join(' | ')}`);
        }
        return;
    }

    const errors: string[] = [];
    for (const target of ordered) {
        try {
            await sendWithTargetRich(target, payload);
            return;
        } catch (err: any) {
            errors.push(`${target.id}: ${String(err?.message || err)}`);
        }
    }
    throw new Error(`Fallback delivery failed: ${errors.join(' | ')}`);
}

async function pushAgentCardImageToChat(
    state: LocalState,
    session: AgentSession,
    params: {
        mediaUrl: string;
        eventTitle: string;
        contentLine: string;
    }
): Promise<void> {
    const mediaUrl = String(params.mediaUrl || '').trim();
    if (!mediaUrl) return;

    const caption = [
        '[Clawtalk]',
        `Event: ${params.eventTitle}`,
        `Agent: ${session.agent_name}`,
        `Content: ${params.contentLine}`,
        'Action: Share this card image to let another agent connect with you.',
    ].join('\n');

    const baseBinding = state.bindings[session.agent_name];
    const targets = selectDeliveryTargets(state, session, baseBinding);
    try {
        await dispatchNotificationRich(targets, 'fallback', { message: caption, mediaUrl });
    } catch (err: any) {
        console.warn(
            `[agent-card] failed to push card image to chat. reason=${String(err?.message || err)}`
        );
    }
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
    return formatClawtalkNotice({
        event: 'New Message',
        from: senderName,
        content,
        action,
    });
}

function getMessageDeliveryMode(event: RealtimeMessageEvent): MessageDeliveryMode {
    const raw = String(event.payload?.data?.delivery_mode || '').toLowerCase();
    return raw === 'realtime' ? 'realtime' : 'mailbox';
}

function getMessagePriority(event: RealtimeMessageEvent): MessagePriority {
    const raw = String(event.payload?.data?.priority || '').toLowerCase();
    if (raw === 'low' || raw === 'normal' || raw === 'high') {
        return raw;
    }
    return 'normal';
}

function buildMailboxPrompt(
    senderName: string,
    content: string,
    pendingCount: number,
    reason: 'interval' | 'threshold',
    thresholdStep: number,
    intervalHours: number
): string {
    const reasonLine = reason === 'threshold'
        ? `Pending mailbox reached ${thresholdStep}+ items.`
        : `Scheduled mailbox reminder (${intervalHours}h interval).`;
    return formatClawtalkNotice({
        event: 'Mailbox Reminder',
        from: senderName,
        content: `${reasonLine} Pending mailbox messages: ${pendingCount}. Latest: ${truncateForDigest(content, 160)}`,
        action: 'Say "inbox digest" to review by thread, then "inbox done --all" after handling (or disable reminder with "notify-pref set --mailbox-reminder off").',
    });
}

function renderTaskRequestContent(task: TaskEnvelopeRequest): string {
    const requestText = task.request || '[empty task prompt]';
    return `Task ID: ${task.task_id}. Request: ${requestText}`;
}

function renderTaskUpdateContent(task: TaskEnvelopeUpdate): string {
    const detail = task.result || task.reason || '';
    const detailPart = detail ? ` Detail: ${detail}` : '';
    return `Task ID: ${task.task_id}. Status: ${task.status}.${detailPart}`;
}

function buildTaskPrompt(
    currentAgentName: string,
    senderName: string,
    task: ParsedTaskEnvelope
): string {
    if (task.kind === 'task_request') {
        return formatClawtalkNotice({
            event: 'Task Request',
            from: senderName,
            content: renderTaskRequestContent(task),
            action:
                `Ask user to approve/reject. If approved and done, send result: ` +
                `npm run clawtalk -- task result ${senderName} ${task.task_id} "<result>" --as ${currentAgentName}`,
        });
    }

    if (task.status === 'approved') {
        return formatClawtalkNotice({
            event: 'Task Update',
            from: senderName,
            content: renderTaskUpdateContent(task),
            action: 'Peer accepted the task. Wait for completion update.',
        });
    }

    if (task.status === 'rejected') {
        return formatClawtalkNotice({
            event: 'Task Update',
            from: senderName,
            content: renderTaskUpdateContent(task),
            action: 'Peer rejected the task. You can revise prompt and resend a new task.',
        });
    }

    return formatClawtalkNotice({
        event: 'Task Result',
        from: senderName,
        content: renderTaskUpdateContent(task),
        action: 'Review result and deliver the final answer to your user.',
    });
}

function summarizeIncomingMessage(event: RealtimeMessageEvent): string {
    const task = parseTaskEnvelope(event);
    if (task) {
        return task.kind === 'task_request'
            ? renderTaskRequestContent(task)
            : renderTaskUpdateContent(task);
    }
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
        return formatClawtalkNotice({
            event: 'Friend Request Status Changed',
            from: peerName,
            content: 'The peer accepted your friend request.',
            action: 'If you want to continue, tell me what message to send.',
        });
    }
    if (status === 'rejected') {
        return formatClawtalkNotice({
            event: 'Friend Request Status Changed',
            from: peerName,
            content: 'The peer rejected your friend request.',
            action: 'You can retry later or use a different target account.',
        });
    }
    if (status === 'cancelled') {
        return formatClawtalkNotice({
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
    const NOTIFY_PREF_REFRESH_MS = 2000;
    let notifyPref = getNotifyPreference(state, session.agent_name);
    let notifyPrefLastRefreshAt = 0;
    const idToName = new Map<string, string>();
    let retryWorkerRunning = false;

    function currentNotifyPref(): NotifyPreference {
        return notifyPref;
    }

    async function refreshNotifyPrefIfNeeded(force = false): Promise<void> {
        const now = Date.now();
        if (!force && now - notifyPrefLastRefreshAt < NOTIFY_PREF_REFRESH_MS) {
            return;
        }
        notifyPrefLastRefreshAt = now;
        try {
            const latest = await loadState();
            notifyPref = getNotifyPreference(latest, session.agent_name);
        } catch {
            // Keep current in-memory preference when state file is temporarily unavailable.
        }
    }

    async function persistWatcherState(): Promise<void> {
        // Persist watcher-owned seen state while preserving other state parts
        // that might be concurrently changed by another CLI process.
        try {
            const latest = await loadState();
            latest.seen = latest.seen || {};
            latest.seen[session.agent_name] = seen;
            latest.tasks = latest.tasks || {};
            if (state.tasks?.[session.agent_name]) {
                latest.tasks[session.agent_name] = state.tasks[session.agent_name];
            }
            await saveState(latest);
            notifyPref = getNotifyPreference(latest, session.agent_name);
            notifyPrefLastRefreshAt = Date.now();
        } catch {
            state.seen[session.agent_name] = seen;
            await saveState(state);
        }
    }

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

    async function deliverNewMessageWithReliability(payload: {
        key: string;
        event: RealtimeMessageEvent;
        senderName: string;
        prompt: string;
    }, source: 'incoming' | 'retry'): Promise<void> {
        const retryState = getNotificationRetry(seen, payload.key);
        const previousAttempts = retryState?.attempts || 0;

        if (isNotificationAcked(seen, payload.key)) {
            removeNotificationRetry(seen, payload.key);
            return;
        }

        if (!hooks.onNewMessage) {
            markNotificationAck(seen, payload.key, 'new_message', previousAttempts);
            removeNotificationRetry(seen, payload.key);
            await persistWatcherState();
            return;
        }

        try {
            await hooks.onNewMessage({ event: payload.event, senderName: payload.senderName, prompt: payload.prompt });
            markNotificationAck(seen, payload.key, 'new_message', previousAttempts + 1);
            removeNotificationRetry(seen, payload.key);
            await persistWatcherState();

            if (source === 'retry') {
                console.log(`[watch] retry delivered: key=${payload.key}, attempts=${previousAttempts + 1}`);
            }
            return;
        } catch (err: any) {
            const attempts = previousAttempts + 1;
            const errorText = String(err?.message || err);

            if (attempts >= WATCH_NOTIFY_RETRY_MAX_ATTEMPTS) {
                removeNotificationRetry(seen, payload.key);
                // Mark as terminally handled to avoid duplicate re-delivery loops.
                markNotificationAck(seen, payload.key, 'new_message', attempts);
                await persistWatcherState();

                console.error(
                    `[watch] notification dropped after ${attempts} attempts: key=${payload.key}; last_error=${errorText}`
                );
                if (hooks.echoConsole !== false) {
                    const failurePrompt = formatClawtalkNotice({
                        event: 'Delivery Failed',
                        from: payload.senderName,
                        content: 'A peer message could not be forwarded after max retries.',
                        action: 'Please check local logs and decide whether to manually notify/reply.',
                    });
                    console.log(`\n${failurePrompt}`);
                }
                return;
            }

            const retryItem = upsertNotificationRetry(seen, {
                key: payload.key,
                type: 'new_message',
                event: payload.event,
                sender_name: payload.senderName,
                prompt: payload.prompt,
                attempts,
                created_at: retryState?.created_at || new Date().toISOString(),
                last_error: errorText,
            });
            await persistWatcherState();
            console.warn(
                `[watch] message callback failed (attempt=${attempts}/${WATCH_NOTIFY_RETRY_MAX_ATTEMPTS}), ` +
                `retry_at=${retryItem.next_retry_at}, key=${payload.key}, error=${errorText}`
            );
        }
    }

    async function processNotificationRetryQueue(): Promise<void> {
        if (retryWorkerRunning || shuttingDown) return;
        retryWorkerRunning = true;
        try {
            const now = Date.now();
            const due = seen.notification_retry_queue
                .filter((item) => {
                    const at = new Date(item.next_retry_at).getTime();
                    if (!Number.isFinite(at)) return true;
                    return at <= now;
                })
                .sort((a, b) => {
                    const aTs = new Date(a.next_retry_at).getTime();
                    const bTs = new Date(b.next_retry_at).getTime();
                    return (Number.isFinite(aTs) ? aTs : 0) - (Number.isFinite(bTs) ? bTs : 0);
                });

            for (const item of due) {
                await deliverNewMessageWithReliability(
                    {
                        key: item.key,
                        event: item.event,
                        senderName: item.sender_name,
                        prompt: item.prompt,
                    },
                    'retry'
                );
            }
        } finally {
            retryWorkerRunning = false;
        }
    }

    async function maybeNotifyMailboxReminder(ctx?: {
        event?: RealtimeMessageEvent;
        senderName?: string;
        content?: string;
    }): Promise<void> {
        await refreshNotifyPrefIfNeeded();
        const pref = currentNotifyPref();
        if (!shouldNotifyMailboxReminder(pref)) return;

        const pending = listMailboxPending(seen);
        const pendingCount = pending.length;
        if (pendingCount <= 0) {
            seen.mailbox_last_threshold_bucket = 0;
            return;
        }

        const reminderWindow = getMailboxReminderWindow(pref);
        const { thresholdStep, intervalHours, intervalMs } = reminderWindow;
        const nowTs = Date.now();
        const reason = nextMailboxReminderReason(seen, pendingCount, nowTs, pref);
        if (!reason) return;

        const latest = pending[pending.length - 1];
        const senderSet = new Set(
            pending
                .map((item) => (item.from_agent_name || '').trim())
                .filter((name) => name.length > 0)
        );
        const fallbackSender = latest?.from_agent_name || ctx?.senderName || 'peer-agent';
        const senderName = senderSet.size <= 1
            ? fallbackSender
            : `${fallbackSender} (+${Math.max(1, senderSet.size - 1)} others)`;
        const content = latest?.content || ctx?.content || 'You have pending mailbox messages.';
        const prompt = buildMailboxPrompt(senderName, content, pendingCount, reason, thresholdStep, intervalHours);

        const slot = reason === 'threshold'
            ? Math.floor(pendingCount / thresholdStep)
            : Math.floor(nowTs / intervalMs);
        const reminderKey = `mailbox-reminder:${reason}:${slot}`;
        if (isNotificationAcked(seen, reminderKey)) return;
        const existingRetry = getNotificationRetry(seen, reminderKey);
        if (existingRetry) {
            const retryAt = new Date(existingRetry.next_retry_at).getTime();
            if (Number.isFinite(retryAt) && retryAt > nowTs) return;
        }

        const reminderEvent: RealtimeMessageEvent = ctx?.event || {
            id: `mailbox-reminder-${slot}`,
            conversation_id: latest?.conversation_id || 'mailbox',
            sender_name: senderName,
            created_at: new Date(nowTs).toISOString(),
            payload: {
                type: 'event',
                content: prompt,
                data: {
                    delivery_mode: 'mailbox',
                    priority: 'normal',
                    mailbox_pending: pendingCount,
                    reminder_reason: reason,
                },
            },
        };

        await deliverNewMessageWithReliability(
            {
                key: reminderKey,
                event: reminderEvent,
                senderName,
                prompt,
            },
            'incoming'
        );

        if (isNotificationAcked(seen, reminderKey)) {
            seen.mailbox_last_notified_at = new Date(nowTs).toISOString();
            seen.mailbox_last_threshold_bucket = Math.floor(
                pendingCount / thresholdStep
            );
            await persistWatcherState();
            if (hooks.echoConsole !== false) {
                console.log(`\n${prompt}`);
            }
        }
    }

    async function handleIncomingMessageEvent(data: RealtimeMessageEvent): Promise<void> {
        await refreshNotifyPrefIfNeeded();
        const pref = currentNotifyPref();
        const messageId = data.id;

        if (messageId && seen.message_ids.includes(messageId)) {
            return;
        }

        // Ignore self-sent messages to avoid noisy self-notify loops.
        if (data.sender_id && data.sender_id === session.agent_id) {
            if (messageId) {
                addSeenId(seen.message_ids, messageId);
                await persistWatcherState();
            }
            return;
        }

        const deliveryKey = buildMessageDeliveryKey(data);
        if (isNotificationAcked(seen, deliveryKey)) {
            return;
        }

        const existingRetry = getNotificationRetry(seen, deliveryKey);
        if (existingRetry) {
            const retryAt = new Date(existingRetry.next_retry_at).getTime();
            if (Number.isFinite(retryAt) && retryAt > Date.now()) {
                return;
            }
        }

        if (messageId) {
            addSeenId(seen.message_ids, messageId);
            await persistWatcherState();
        }

        const senderName = data.sender_name || await resolveAgentName(data.sender_id || '');
        const deliveryMode = getMessageDeliveryMode(data);
        const priority = getMessagePriority(data);
        const taskEnvelope = parseTaskEnvelope(data);
        if (taskEnvelope) {
            const at = data.created_at || taskEnvelope.created_at || new Date().toISOString();
            if (taskEnvelope.kind === 'task_request') {
                upsertTaskRecord(state, session.agent_name, {
                    taskId: taskEnvelope.task_id,
                    direction: 'incoming',
                    peerAgentName: senderName,
                    request: taskEnvelope.request || '',
                    status: 'requested',
                    messageId: data.id,
                    at,
                });
            } else {
                const existing = ensureTaskStore(state, session.agent_name)[taskEnvelope.task_id];
                upsertTaskRecord(state, session.agent_name, {
                    taskId: taskEnvelope.task_id,
                    direction: existing?.direction || 'outgoing',
                    peerAgentName: senderName,
                    request: existing?.request || '',
                    status: taskEnvelope.status,
                    result: taskEnvelope.result || taskEnvelope.reason,
                    messageId: data.id,
                    at,
                });
            }
            await persistWatcherState();
        }
        const cachedAttachments = await cacheIncomingAttachments(session, data);
        let content = summarizeIncomingMessage(data);
        const localPaths = cachedAttachments
            .map((item) => item.local_path)
            .filter((value): value is string => typeof value === 'string' && value.length > 0);
        if (localPaths.length > 0) {
            content = `${content} Local cache saved: ${localPaths.join(', ')}`;
        }
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
            delivery_mode: deliveryMode,
            priority,
            content,
            attachments: incomingAttachments,
            sent_at: data.created_at || new Date().toISOString(),
        });

        const prompt = taskEnvelope
            ? buildTaskPrompt(session.agent_name, senderName, taskEnvelope)
            : buildMessagePrompt(policy.mode, senderName, content);
        if (deliveryMode === 'mailbox') {
            const mailboxId = data.id || `mailbox-${Date.now()}`;
            rememberMailboxPending(seen, {
                message_id: mailboxId,
                conversation_id: data.conversation_id || 'unknown-conversation',
                from_agent_name: senderName,
                content,
                envelope_type: data.payload?.type || 'text',
                created_at: data.created_at || new Date().toISOString(),
                priority,
            });
            await persistWatcherState();

            // New default behavior: mailbox messages are still queued for inbox/digest,
            // but also pushed immediately to the user channel.
            if (shouldNotifyRealtimeDm(pref)) {
                await deliverNewMessageWithReliability(
                    {
                        key: deliveryKey,
                        event: data,
                        senderName,
                        prompt,
                    },
                    'incoming'
                );

                if (hooks.echoConsole !== false) {
                    console.log(`\n${prompt}`);
                }
            } else if (!messageId) {
                // For no-id events that are intentionally muted, ack once to avoid looped duplicates.
                markNotificationAck(seen, deliveryKey, 'new_message', 0);
                removeNotificationRetry(seen, deliveryKey);
                await persistWatcherState();
            }

            await maybeNotifyMailboxReminder({ event: data, senderName, content });
            return;
        }

        if (!shouldNotifyRealtimeDm(pref)) {
            markNotificationAck(seen, deliveryKey, 'new_message', 0);
            removeNotificationRetry(seen, deliveryKey);
            await persistWatcherState();
            return;
        }

        await deliverNewMessageWithReliability(
            {
                key: deliveryKey,
                event: data,
                senderName,
                prompt,
            },
            'incoming'
        );

        if (hooks.echoConsole !== false) {
            console.log(`\n${prompt}`);
        }
    }

    async function pollIncomingFriendRequests() {
        try {
            await refreshNotifyPrefIfNeeded();
            const pref = currentNotifyPref();
            const requests = await listIncomingPending(session.token);
            let changed = false;

            for (const req of requests) {
                if (seen.friend_request_ids.includes(req.id)) continue;
                addSeenId(seen.friend_request_ids, req.id);
                changed = true;

                const fromName = req.from_agent_name || req.from_agent_id;
                const prompt = formatClawtalkNotice({
                    event: 'Friend Request',
                    from: fromName,
                    content: 'A peer sent you a friend request.',
                    action: 'Accept or reject? You can reply "accept" or "reject".',
                    at: req.created_at,
                });

                if (shouldNotifyFriendRequest(pref) && hooks.onFriendRequest) {
                    try {
                        await hooks.onFriendRequest({ request: req, fromName, prompt });
                    } catch (err: any) {
                        console.error(`[watch] friend request callback error: ${err.message}`);
                    }
                }

                if (shouldNotifyFriendRequest(pref) && hooks.echoConsole !== false) {
                    console.log(`\n${prompt}`);
                }
            }

            if (changed) {
                await persistWatcherState();
            }
        } catch (err: any) {
            console.error(`[watch] poll incoming friend requests failed: ${err.message}`);
        }
    }

    async function pollOutgoingRequestStatus() {
        try {
            await refreshNotifyPrefIfNeeded();
            const pref = currentNotifyPref();
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

                if (shouldNotifyFriendRequestStatus(pref) && hooks.onFriendRequestStatusChange) {
                    try {
                        await hooks.onFriendRequestStatusChange({ request: req, prompt });
                    } catch (err: any) {
                        console.error(`[watch] outgoing request status callback error: ${err.message}`);
                    }
                }

                if (shouldNotifyFriendRequestStatus(pref) && hooks.echoConsole !== false) {
                    console.log(`\n${prompt}`);
                }
            }

            if (changed) {
                await persistWatcherState();
            }
        } catch (err: any) {
            console.error(`[watch] poll outgoing request status failed: ${err.message}`);
        }
    }

    async function pollRecentMessages() {
        try {
            const conversations = await listConversationsForAgent(session.token);
            for (const conv of conversations.slice(0, WATCH_CONVERSATION_SCAN_LIMIT)) {
                const messages = await listConversationMessages(
                    session.token,
                    conv.id,
                    WATCH_MESSAGES_PER_CONVERSATION
                );
                if (!Array.isArray(messages) || messages.length === 0) continue;

                // API returns DESC; replay oldest first for stable user-facing order.
                const ordered = [...messages].reverse();
                for (const row of ordered) {
                    await handleIncomingMessageEvent({
                        ...row,
                        conversation_id: row.conversation_id || conv.id,
                    });
                }
            }
        } catch (err: any) {
            console.error(`[watch] poll recent messages failed: ${err.message}`);
        }
    }

    async function handleRealtime(raw: WebSocket.RawData) {
        try {
            await refreshNotifyPrefIfNeeded();
            const pref = currentNotifyPref();
            const msg = JSON.parse(raw.toString());

            if (msg.type === 'connected') {
                return;
            }

            if (msg.type === 'new_message') {
                const data = (msg.data || {}) as RealtimeMessageEvent;
                await handleIncomingMessageEvent(data);
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
                    await persistWatcherState();

                    const fromName = await resolveAgentName(data.from_agent_id || '');
                    const prompt = formatClawtalkNotice({
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

                    if (shouldNotifyFriendRequest(pref) && hooks.onFriendRequest) {
                        try {
                            await hooks.onFriendRequest({ request: req, fromName, prompt });
                        } catch (err: any) {
                            console.error(`[watch] realtime friend request callback error: ${err.message}`);
                        }
                    }

                    if (shouldNotifyFriendRequest(pref) && hooks.echoConsole !== false) {
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
                    await persistWatcherState();

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

                    if (shouldNotifyFriendRequestStatus(pref) && hooks.onFriendRequestStatusChange) {
                        try {
                            await hooks.onFriendRequestStatusChange({ request: req, prompt });
                        } catch (err: any) {
                            console.error(`[watch] realtime outgoing status callback error: ${err.message}`);
                        }
                    }

                    if (shouldNotifyFriendRequestStatus(pref) && hooks.echoConsole !== false) {
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

    let ws: WebSocket | null = null;
    let shuttingDown = false;
    let connecting = false;
    let hasConnectedOnce = false;
    let reconnectDelayMs = WATCH_WS_RECONNECT_MS;

    function connectWebSocket() {
        if (shuttingDown || connecting) return;
        connecting = true;

        const current = new WebSocket(`${runtimeWsUrl}/ws`, {
            headers: { Authorization: `Bearer ${session.token}` },
        });
        ws = current;

        current.on('open', () => {
            connecting = false;
            reconnectDelayMs = WATCH_WS_RECONNECT_MS;
            if (!hasConnectedOnce) {
                const pref = currentNotifyPref();
                console.log(`WebSocket connected, current agent: ${session.agent_name}`);
                console.log(
                    `Listening for events (policy: ${policy.mode}, dm_realtime=${pref.dm_realtime_enabled ? 'on' : 'off'}, ` +
                    `friend_request=${pref.friend_request_enabled ? 'on' : 'off'}, ` +
                    `friend_status=${pref.friend_request_status_enabled ? 'on' : 'off'}, ` +
                    `mailbox_reminder=${pref.mailbox_reminder_enabled ? 'on' : 'off'})...`
                );
                hasConnectedOnce = true;
            } else {
                console.log(`WebSocket reconnected, current agent: ${session.agent_name}`);
            }
        });

        current.on('message', (raw) => {
            if (ws !== current) return;
            void handleRealtime(raw);
        });

        current.on('close', (code, reason) => {
            if (ws === current) {
                ws = null;
            }
            connecting = false;
            if (shuttingDown) return;
            const retryDelayMs = reconnectDelayMs;
            console.warn(
                `[watch] websocket disconnected (${code}): ${reason.toString()}. ` +
                `Will retry in ${retryDelayMs}ms; polling fallback remains active.`
            );
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000);
            setTimeout(() => connectWebSocket(), retryDelayMs);
        });

        current.on('error', (err) => {
            connecting = false;
            console.error(`[watch] websocket error: ${err.message}`);
        });
    }

    connectWebSocket();

    const pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);

    let pollTick = 0;
    const pollTimer = setInterval(() => {
        pollTick += 1;
        void pollIncomingFriendRequests();
        void pollOutgoingRequestStatus();
        void maybeNotifyMailboxReminder();
        if (pollTick % WATCH_MESSAGE_POLL_EVERY_TICKS === 0) {
            void pollRecentMessages();
        }
    }, WATCH_POLL_INTERVAL_MS);

    const retryTimer = setInterval(() => {
        void processNotificationRetryQueue();
    }, WATCH_NOTIFY_RETRY_SCAN_MS);

    await pollIncomingFriendRequests();
    await pollOutgoingRequestStatus();
    await pollRecentMessages();

    const shutdown = () => {
        shuttingDown = true;
        clearInterval(pingTimer);
        clearInterval(pollTimer);
        clearInterval(retryTimer);
        if (ws) {
            ws.close();
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

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
            throw new Error('Usage: clawtalk notify remove <id> [--as <agent_username>]');
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
            throw new Error('Usage: clawtalk notify set-primary <id> [--as <agent_username>]');
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
        'Usage: clawtalk notify <add|list|remove|set-primary|test> ... [--as <agent_username>]'
    );
}

function parseOnOff(value: string, flag: string): boolean {
    const normalized = (value || '').trim().toLowerCase();
    if (normalized === 'on' || normalized === 'true') return true;
    if (normalized === 'off' || normalized === 'false') return false;
    throw new Error(`Invalid ${flag} value: ${value}. Use on|off.`);
}

function parsePositiveInteger(value: string, flag: string, min: number, max?: number): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new Error(`Invalid ${flag} value: ${value}. Use an integer.`);
    }
    if (parsed < min) {
        throw new Error(`Invalid ${flag} value: ${value}. Must be >= ${min}.`);
    }
    if (typeof max === 'number' && parsed > max) {
        throw new Error(`Invalid ${flag} value: ${value}. Must be <= ${max}.`);
    }
    return parsed;
}

function parseNotifyPrefSetArgs(args: string[]): Partial<NotifyPreference> {
    const patch: Partial<NotifyPreference> = {};

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--friend-request') {
            patch.friend_request_enabled = parseOnOff(args[i + 1] || '', '--friend-request');
            i += 1;
            continue;
        }
        if (arg === '--friend-status') {
            patch.friend_request_status_enabled = parseOnOff(args[i + 1] || '', '--friend-status');
            i += 1;
            continue;
        }
        if (arg === '--dm-realtime') {
            patch.dm_realtime_enabled = parseOnOff(args[i + 1] || '', '--dm-realtime');
            i += 1;
            continue;
        }
        if (arg === '--mailbox-reminder') {
            patch.mailbox_reminder_enabled = parseOnOff(args[i + 1] || '', '--mailbox-reminder');
            i += 1;
            continue;
        }
        if (arg === '--mailbox-interval-hours') {
            patch.mailbox_reminder_interval_hours = parsePositiveInteger(
                args[i + 1] || '',
                '--mailbox-interval-hours',
                1,
                168
            );
            i += 1;
            continue;
        }
        if (arg === '--mailbox-threshold') {
            patch.mailbox_reminder_pending_step = parsePositiveInteger(
                args[i + 1] || '',
                '--mailbox-threshold',
                1
            );
            i += 1;
            continue;
        }
        throw new Error(`Unknown option for notify-pref set: ${arg}`);
    }

    if (Object.keys(patch).length === 0) {
        throw new Error(
            'Usage: clawtalk notify-pref set [--friend-request on|off] [--friend-status on|off] [--dm-realtime on|off] [--mailbox-reminder on|off] [--mailbox-interval-hours <n>] [--mailbox-threshold <n>] [--as <agent_username>]'
        );
    }

    return patch;
}

async function commandNotifyPref(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const sub = args[0] || 'get';

    if (sub === 'get' || sub === 'list') {
        const prefs = getNotifyPreference(state, session.agent_name);
        console.log(JSON.stringify({
            agent: session.agent_name,
            notify_preference: prefs,
        }, null, 2));
        return;
    }

    if (sub === 'set') {
        const patch = parseNotifyPrefSetArgs(args.slice(1));
        const merged: NotifyPreference = {
            ...getNotifyPreference(state, session.agent_name),
            ...patch,
        };
        state.notify_prefs[session.agent_name] = merged;
        await saveState(state);
        console.log(JSON.stringify({
            agent: session.agent_name,
            notify_preference: merged,
        }, null, 2));
        return;
    }

    if (sub === 'reset') {
        const reset = defaultNotifyPreference();
        state.notify_prefs[session.agent_name] = reset;
        await saveState(state);
        console.log(JSON.stringify({
            agent: session.agent_name,
            notify_preference: reset,
        }, null, 2));
        return;
    }

    throw new Error(
        'Usage: clawtalk notify-pref <get|set|reset> [--friend-request on|off] [--friend-status on|off] [--dm-realtime on|off] [--mailbox-reminder on|off] [--mailbox-interval-hours <n>] [--mailbox-threshold <n>] [--as <agent_username>]'
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

    throw new Error('Usage: clawtalk daemon <start|stop|status> [bridge|watch|all] [--as <agent_username>]');
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
        throw new Error('Usage: clawtalk policy set --mode <receive_only|manual_review|auto_execute> [--as <agent_username>]');
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

    throw new Error('Usage: clawtalk policy <get|set> [--mode <receive_only|manual_review|auto_execute>] [--as <agent_username>]');
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
            throw new Error('Usage: clawtalk config set <base_url|base-url> <url>');
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

    throw new Error('Usage: clawtalk config <get|set> [base_url <url>]');
}

async function commandGuided(state: LocalState): Promise<void> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        console.log('Clawtalk guided setup started.');
        console.log(`Current API base_url: ${runtimeBaseUrl}`);
        console.log('Guided setup uses direct agent register/login flow by default.');

        const localSessions = Object.values(state.sessions || {});
        if (localSessions.length > 0) {
            console.log('Local agent sessions found:');
            for (const session of localSessions) {
                const currentMark = state.current_agent === session.agent_name ? ' (current)' : '';
                const claw = session.claw_id ? `, ${session.claw_id}` : '';
                console.log(`- ${session.agent_name}${claw}${currentMark}`);
            }
        }

        const actionRaw = (await rl.question(
            localSessions.length > 0
                ? 'Choose action [use/register/login] (default: use): '
                : 'Choose action [register/login] (default: register): '
        )).trim().toLowerCase();
        const action = localSessions.length > 0
            ? (actionRaw === 'register' || actionRaw === 'login' ? actionRaw : 'use')
            : (actionRaw === 'login' ? 'login' : 'register');

        if (action === 'use') {
            const target = (await rl.question('Use which agent (agent_username or claw_id): ')).trim();
            if (!target) {
                throw new Error('Agent reference cannot be empty.');
            }
            await commandSwitch([target], state);
        } else if (action === 'register') {
            const agentUsername = (await rl.question('Agent Username to register: ')).trim();
            if (!agentUsername) {
                throw new Error('Agent Username cannot be empty.');
            }
            const agentPassword = (await rl.question('Password: ')).trim();
            if (!agentPassword) {
                throw new Error('Password cannot be empty.');
            }
            const authArgs = [agentUsername, agentPassword];
            const friendZoneRaw = (await rl.question(
                'Friend Zone visibility [friends/public/closed] (default: friends): '
            )).trim().toLowerCase();
            if (friendZoneRaw === 'public') {
                authArgs.push('--friend-zone-public');
            } else if (friendZoneRaw === 'closed') {
                authArgs.push('--friend-zone-closed');
            } else {
                authArgs.push('--friend-zone-friends');
            }
            try {
                await commandOnboard(authArgs, state);
            } catch (err: any) {
                const message = String(err?.message || err);
                if (message.includes('Legacy agent username/password auth is disabled')) {
                    console.error('Direct register/login is disabled on this server.');
                    console.error('Set LEGACY_AGENT_AUTH_ENABLED=true on the server, then retry guided.');
                    return;
                }
                throw err;
            }
        } else {
            const agentUsername = (await rl.question('Agent Username to login: ')).trim();
            if (!agentUsername) {
                throw new Error('Agent Username cannot be empty.');
            }
            const agentPassword = (await rl.question('Password: ')).trim();
            if (!agentPassword) {
                throw new Error('Password cannot be empty.');
            }
            try {
                await commandLogin([agentUsername, agentPassword], state);
            } catch (err: any) {
                const message = String(err?.message || err);
                if (message.includes('Legacy agent username/password auth is disabled')) {
                    console.error('Direct register/login is disabled on this server.');
                    console.error('Set LEGACY_AGENT_AUTH_ENABLED=true on the server, then retry guided.');
                    return;
                }
                throw err;
            }
        }

        const finalSession = getSessionOrThrow(state);
        await commandPolicy(['set', '--mode', 'receive_only'], state, finalSession.agent_name);
        await commandWhoami(state, finalSession.agent_name);
        console.log('Clawtalk is ready.');
        printOnboardingQuickStart(finalSession.agent_name);
    } finally {
        rl.close();
    }
}

async function commandDoctor(state: LocalState): Promise<void> {
    const expectedProjectDir = path.join(OPENCLAW_HOME, 'clawtalk');
    const expectedSkillsDir = path.join(OPENCLAW_HOME, 'skills', 'clawtalk');
    const expectedSkillFile = path.join(expectedSkillsDir, 'SKILL.md');
    const expectedSkillAdapter = path.join(expectedSkillsDir, 'skill', 'agent_social_skill.ts');

    const checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> = [];

    const projectOk = await pathExists(path.join(expectedProjectDir, 'package.json'));
    checks.push({
        name: 'project_dir',
        status: projectOk ? 'ok' : 'fail',
        detail: projectOk
            ? `Found project at ${expectedProjectDir}`
            : `Project not found at ${expectedProjectDir}`,
    });

    const cwdOk = path.resolve(process.cwd()) === path.resolve(expectedProjectDir);
    checks.push({
        name: 'current_workdir',
        status: cwdOk ? 'ok' : 'warn',
        detail: cwdOk
            ? `Working directory is ${expectedProjectDir}`
            : `Current directory is ${process.cwd()} (recommended: ${expectedProjectDir})`,
    });

    const skillFileOk = await pathExists(expectedSkillFile);
    checks.push({
        name: 'skill_file',
        status: skillFileOk ? 'ok' : 'fail',
        detail: skillFileOk
            ? `Found skill manifest at ${expectedSkillFile}`
            : `Missing skill manifest at ${expectedSkillFile}`,
    });

    const skillAdapterOk = await pathExists(expectedSkillAdapter);
    checks.push({
        name: 'skill_adapter',
        status: skillAdapterOk ? 'ok' : 'warn',
        detail: skillAdapterOk
            ? `Found skill adapter at ${expectedSkillAdapter}`
            : `Missing skill adapter at ${expectedSkillAdapter}`,
    });

    const openclawConfigOk = await pathExists(OPENCLAW_CONFIG_PATH);
    checks.push({
        name: 'openclaw_config',
        status: openclawConfigOk ? 'ok' : 'warn',
        detail: openclawConfigOk
            ? `Found OpenClaw config at ${OPENCLAW_CONFIG_PATH}`
            : `OpenClaw config not found at ${OPENCLAW_CONFIG_PATH}`,
    });

    try {
        const ready = await api('GET', '/readyz');
        const postgres = ready?.checks?.postgres;
        const redis = ready?.checks?.redis;
        const readyOk = postgres === 'ok' && redis === 'ok';
        checks.push({
            name: 'server_readyz',
            status: readyOk ? 'ok' : 'warn',
            detail: `base_url=${runtimeBaseUrl}, postgres=${postgres || 'unknown'}, redis=${redis || 'unknown'}`,
        });
    } catch (err: any) {
        checks.push({
            name: 'server_readyz',
            status: 'fail',
            detail: `Cannot reach ${runtimeBaseUrl}/readyz: ${String(err?.message || err)}`,
        });
    }

    const sessionCount = Object.keys(state.sessions || {}).length;
    checks.push({
        name: 'local_sessions',
        status: sessionCount > 0 ? 'ok' : 'warn',
        detail: sessionCount > 0
            ? `${sessionCount} local Clawtalk session(s) found`
            : 'No local sessions found. Run guided first, or use onboard/login.',
    });

    const ownerSessionCount = Object.keys(state.owner_sessions || {}).length;
    checks.push({
        name: 'local_owner_sessions',
        status: ownerSessionCount > 0 ? 'ok' : 'warn',
        detail: ownerSessionCount > 0
            ? `${ownerSessionCount} local owner session(s) found`
            : 'No local owner session found (optional). Use owner-* commands only if you need owner mode.',
    });

    const hasFail = checks.some((c) => c.status === 'fail');
    const hasWarn = checks.some((c) => c.status === 'warn');
    const overall = hasFail ? 'fail' : hasWarn ? 'warn' : 'ok';

    console.log(JSON.stringify({
        overall,
        expected_paths: {
            project_dir: expectedProjectDir,
            skills_dir: expectedSkillsDir,
            openclaw_config: OPENCLAW_CONFIG_PATH,
        },
        effective_base_url: runtimeBaseUrl,
        checks,
    }, null, 2));
}

function printUsage() {
    printUsageShared(DEFAULT_BASE_URL);
}

async function main() {
    const [, , command, ...argv] = process.argv;
    await migrateLegacyStateDirIfNeeded();
    const config = await loadConfig();
    setRuntimeBaseUrl(resolveBaseUrl(config));

    const state = await loadState();
    const { asAgent, rest } = parseAgentOption(argv);

    try {
        await dispatchCommand({
            command,
            rest,
            state,
            config,
            asAgent,
            handlers: {
                commandOwnerConnect,
                commandOwnerRegister,
                commandOwnerLogin,
                commandOwnerRotateToken,
                commandOwnerWhoami,
                commandOwnerLogout,
                commandOwnerAgents,
                commandOwnerSessions,
                commandOwnerRevokeSession,
                commandOwnerCreateAgent,
                commandOwnerBindAgent,
                commandOnboard,
                commandLogin,
                commandClaimStatus,
                commandClaimComplete,
                commandLogout,
                commandSwitch,
                commandWhoami,
                commandProfile,
                commandAddFriend,
                commandUnfriend,
                commandListFriends,
                commandBlockAgent,
                commandUnblockAgent,
                commandListBlocks,
                commandIncoming,
                commandOutgoing,
                commandAcceptFriend,
                commandRejectFriend,
                commandCancelFriendRequest,
                commandSendDm,
                commandTask,
                commandMessageStatus,
                commandSendAttachment,
                commandDownloadAttachment,
                commandAgentCard,
                commandInbox,
                commandFriendZone,
                commandLocalLogs,
                commandBindOpenClaw,
                commandShowBindings,
                commandNotify,
                commandNotifyPref,
                commandWatch,
                commandBridge,
                commandPolicy,
                commandConfig,
                commandGuided,
                commandDoctor,
                commandDaemon,
                printUsage,
            },
        });
    } catch (err: any) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
