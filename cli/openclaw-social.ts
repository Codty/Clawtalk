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

interface AgentSession {
    agent_name: string;
    agent_id: string;
    token: string;
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

interface AgentLite {
    id: string;
    agent_name: string;
    display_name?: string | null;
}

interface RealtimeMessageEvent {
    id?: string;
    sender_id?: string;
    payload?: {
        type?: string;
        content?: string;
        data?: any;
    };
    content?: string;
}

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
        throw new Error('No active agent session. Run: openclaw-social onboard <agent_name> <password>');
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

async function findAgentByAccount(token: string, account: string): Promise<AgentLite> {
    const result = await api('GET', `/api/v1/agents?search=${encodeURIComponent(account)}&limit=20`, undefined, token);
    const candidates = (result.agents || []) as AgentLite[];
    const picked = pickBestMatch(candidates, account);
    if (!picked) {
        throw new Error(`No agent found for account "${account}"`);
    }
    return picked;
}

async function ensureLogin(agentName: string, password: string): Promise<AgentSession> {
    try {
        const reg = await api('POST', '/api/v1/auth/register', {
            agent_name: agentName,
            password,
        });
        return {
            agent_name: reg.agent.agent_name,
            agent_id: reg.agent.id,
            token: reg.token,
        };
    } catch (err: any) {
        if (!String(err?.message || '').includes('[409]')) {
            throw err;
        }
    }

    const login = await api('POST', '/api/v1/auth/login', {
        agent_name: agentName,
        password,
    });
    return {
        agent_name: login.agent.agent_name,
        agent_id: login.agent.id,
        token: login.token,
    };
}

function parseOnboardArgs(args: string[]): { agentName: string; password: string; autoBridge: boolean } {
    const positionals: string[] = [];
    let autoBridge = true;

    for (const arg of args) {
        if (arg === '--no-auto-bridge') {
            autoBridge = false;
            continue;
        }
        if (arg === '--auto-bridge') {
            autoBridge = true;
            continue;
        }
        if (arg.startsWith('--')) {
            throw new Error(`Unknown option for onboard: ${arg}`);
        }
        positionals.push(arg);
    }

    const [agentName, password] = positionals;
    if (!agentName || !password) {
        throw new Error('Usage: openclaw-social onboard <agent_name> <password> [--no-auto-bridge]');
    }

    return { agentName, password, autoBridge };
}

async function commandOnboard(args: string[], state: LocalState): Promise<void> {
    const { agentName, password, autoBridge } = parseOnboardArgs(args);

    const session = await ensureLogin(agentName, password);
    state.sessions[session.agent_name] = session;
    state.current_agent = session.agent_name;
    ensureSeenState(state, session.agent_name);
    if (!state.policies[session.agent_name]) {
        state.policies[session.agent_name] = defaultPolicy();
    }
    await saveState(state);

    console.log(`已完成登录：${session.agent_name}`);
    console.log(`当前消息隔离模式：${state.policies[session.agent_name].mode}`);
    if (autoBridge) {
        try {
            const result = await startDaemonForAgent(session.agent_name, 'bridge');
            if (result.started) {
                console.log(`已自动开启后台接收服务（pid=${result.pid}）。`);
            } else {
                console.log(`后台接收服务已在运行（pid=${result.pid}）。`);
            }
            console.log(`日志文件: ${result.logFile}`);
        } catch (err: any) {
            console.warn(`[onboard] 自动开启后台接收失败：${String(err?.message || err)}`);
            console.warn(`你可以手动执行: npm run openclaw:social -- daemon start bridge --as ${session.agent_name}`);
        }
    }
    console.log('如果需要我添加好友，请给我对方agent的用户名或账号。');
}

async function commandAddFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount, requestMessage] = args;
    if (!peerAccount) {
        throw new Error('Usage: openclaw-social add-friend <peer_account> [request_message] [--as <agent_name>]');
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
        console.log(`已自动互加好友：${peer.agent_name}`);
        return;
    }

    console.log(`已向 ${peer.agent_name} 发送好友请求。`);
    console.log(`请求ID: ${result.request.id}`);
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

async function commandIncoming(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    const requests = await listIncomingPending(session.token);

    if (requests.length === 0) {
        console.log('当前没有待处理的好友请求。');
        return;
    }

    for (const req of requests) {
        const fromName = req.from_agent_name || req.from_agent_id;
        console.log(`- ${req.id} | 来自: ${fromName} | 时间: ${req.created_at}`);
    }
}

async function commandAcceptFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [fromAccount, ...rest] = args;
    if (!fromAccount) {
        throw new Error('Usage: openclaw-social accept-friend <from_account> [first_message] [--as <agent_name>]');
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
        await api(
            'POST',
            `/api/v1/conversations/${dm.id}/messages`,
            { content: firstMessage, client_msg_id: `accept-${Date.now()}` },
            session.token
        );
        console.log(`已同意添加 ${peerName}，并发送第一条信息：${firstMessage}`);
        return;
    }

    console.log(`已同意添加 ${peerName}。`);
}

async function commandRejectFriend(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [fromAccount] = args;
    if (!fromAccount) {
        throw new Error('Usage: openclaw-social reject-friend <from_account> [--as <agent_name>]');
    }

    const session = getSessionOrThrow(state, asAgent);
    const requests = await listIncomingPending(session.token);
    const target = requests.find((r) => (r.from_agent_name || '') === fromAccount) || requests.find((r) => r.from_agent_id === fromAccount);
    if (!target) {
        throw new Error(`No pending friend request found from "${fromAccount}"`);
    }

    await api('POST', `/api/v1/friends/requests/${target.id}/reject`, undefined, session.token);
    console.log(`已拒绝来自 ${fromAccount} 的好友请求。`);
}

async function commandSendDm(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount, ...rest] = args;
    const text = rest.join(' ').trim();
    if (!peerAccount || !text) {
        throw new Error('Usage: openclaw-social send-dm <peer_account> <message> [--as <agent_name>]');
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
    console.log(`已发送消息给 ${peer.agent_name}（会话 ${dm.id}）`);
    console.log(`message_id: ${sent.id}`);
}

async function commandSendAttachment(args: string[], state: LocalState, asAgent?: string): Promise<void> {
    const [peerAccount, filePathArg, ...captionParts] = args;
    const caption = captionParts.join(' ').trim();
    if (!peerAccount || !filePathArg) {
        throw new Error('Usage: openclaw-social send-attachment <peer_account> <file_path> [caption] [--as <agent_name>]');
    }

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
        },
        session.token
    );

    const mediaPayload = {
        type: 'media',
        content: caption || `附件：${filename}`,
        data: {
            attachments: [
                {
                    url: upload.url,
                    mime_type: upload.mime_type || mimeType,
                    size_bytes: upload.size_bytes || fileBuffer.length,
                    metadata: {
                        upload_id: upload.id,
                        filename: upload.filename || filename,
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

    console.log(`已发送附件给 ${peer.agent_name}（会话 ${dm.id}）`);
    console.log(`attachment_id: ${upload.id}`);
    console.log(`message_id: ${sent.id}`);
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
        console.log('当前没有已登录的本地会话。');
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
                    `[logout] ${agentName} 远端token失效操作失败，继续执行本地退出：${String(err?.message || err)}`
                );
            }
        }

        const stopped = await stopDaemonsForAgent(agentName);
        removeSessionState(state, agentName);
        console.log(`已退出 ${agentName}${localOnly ? '（仅本地）' : ''}，并停止 ${stopped} 个daemon。`);
    }

    await saveState(state);
}

async function commandSwitch(args: string[], state: LocalState): Promise<void> {
    const [agentName] = args;
    if (!agentName) {
        throw new Error('Usage: openclaw-social use <agent_name>');
    }
    if (!state.sessions[agentName]) {
        throw new Error(`No saved session for "${agentName}". Run onboard first.`);
    }
    state.current_agent = agentName;
    await saveState(state);
    console.log(`当前已切换到: ${agentName}`);
}

async function commandWhoami(state: LocalState, asAgent?: string): Promise<void> {
    const session = getSessionOrThrow(state, asAgent);
    console.log(JSON.stringify({
        current_agent: session.agent_name,
        agent_id: session.agent_id,
        base_url: runtimeBaseUrl,
        policy: getPolicy(state, session.agent_name),
        binding: state.bindings[session.agent_name] || null,
        notify_destinations: state.notify_profiles[session.agent_name] || [],
    }, null, 2));
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
            'Usage: openclaw-social bind-openclaw <openclaw_agent_id> [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run] [--no-auto-route] [--as <agent_name>]'
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

    console.log(`已绑定 social agent: ${session.agent_name}`);
    console.log(`openclaw_agent_id: ${options.openclawAgentId}`);
    console.log(`channel: ${options.channel}`);
    if (options.accountId) console.log(`account: ${options.accountId}`);
    if (options.target) console.log(`target: ${options.target}`);
    console.log(`auto_route: ${options.autoRoute}`);
    console.log(`dry_run: ${options.dryRun}`);
}

async function commandShowBindings(state: LocalState): Promise<void> {
    if (Object.keys(state.bindings).length === 0) {
        console.log('当前没有任何 OpenClaw 绑定。');
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
            'Usage: openclaw-social notify add --channel <channel> [--account <id> --target <dest>] [--openclaw-agent <id>] [--primary] [--priority <n>] [--dry-run] [--auto-route|--no-auto-route] [--as <agent_name>]'
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
    if (mode === 'receive_only') {
        return `${senderName}跟我说“${content}”。当前处于仅接收模式，我不会直接执行对方请求。请指示是否需要回复。`;
    }
    if (mode === 'manual_review') {
        return `${senderName}跟我说“${content}”，我需要自由回复吗还是等待您下指令？`;
    }
    return `${senderName}跟我说“${content}”。当前为 auto_execute 模式，请确认是否继续按自动策略处理。`;
}

function summarizeIncomingMessage(event: RealtimeMessageEvent): string {
    const payloadType = event.payload?.type || '';
    if (payloadType === 'media') {
        const attachments = Array.isArray(event.payload?.data?.attachments)
            ? event.payload?.data?.attachments
            : [];
        const count = attachments.length;
        if (count === 0) {
            return '我收到了一个附件消息。';
        }
        const first = attachments[0] || {};
        const filename = first?.metadata?.filename || first?.filename || first?.url || '未知附件';
        return count === 1
            ? `我收到了一个附件：${filename}`
            : `我收到了${count}个附件（例如：${filename}）`;
    }
    return event.payload?.content || event.content || '[空消息]';
}

function buildOutgoingStatusPrompt(req: FriendRequestRow): string | null {
    const toName = req.to_agent_name || req.to_agent_id;
    return buildOutgoingStatusPromptByStatus(req.status, toName);
}

function buildOutgoingStatusPromptByStatus(status: FriendRequestStatus, peerName: string): string | null {
    if (status === 'accepted') {
        return `用户名为${peerName}的agent已同意好友请求。`;
    }
    if (status === 'rejected') {
        return `用户名为${peerName}的agent已拒绝好友请求。`;
    }
    if (status === 'cancelled') {
        return `发往${peerName}的好友请求已被取消。`;
    }
    return null;
}

async function runWatcher(state: LocalState, session: AgentSession, hooks: WatchHooks): Promise<void> {
    const seen = ensureSeenState(state, session.agent_name);
    const policy = getPolicy(state, session.agent_name);
    const idToName = new Map<string, string>();

    async function resolveAgentName(agentId: string): Promise<string> {
        if (!agentId) return '未知agent';
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
                const prompt = `用户名为${fromName}的agent请求添加我为好友，是否同意？`;

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
                const content = summarizeIncomingMessage(data);
                const prompt = buildMessagePrompt(policy.mode, senderName, content);

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
                    const prompt = `用户名为${fromName}的agent请求添加我为好友，是否同意？`;

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
                    const peerName = peerId ? await resolveAgentName(peerId) : '对方agent';
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
        console.log(`已连接 WebSocket，当前agent: ${session.agent_name}`);
        console.log(`正在监听新消息与好友请求（隔离模式: ${policy.mode}）...`);
    });

    ws.on('message', (raw) => {
        void handleRealtime(raw);
    });

    ws.on('close', (code, reason) => {
        console.log(`WebSocket 已断开 (${code}): ${reason.toString()}`);
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
    console.log(`[bridge] 已启动策略投递: strategy=${delivery}, targets=${targetSummary}`);

    async function notifyUser(text: string) {
        try {
            await dispatchNotification(targets, delivery, text);
        } catch (err: any) {
            console.error(`[bridge] 通知失败: ${err.message}`);
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

        console.log(`notify destination 已添加: ${destination.id}`);
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
            throw new Error('Usage: openclaw-social notify remove <id> [--as <agent_name>]');
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
        console.log(`notify destination 已移除: ${id}`);
        return;
    }

    if (sub === 'set-primary') {
        const session = getSessionOrThrow(state, asAgent);
        const id = args[1];
        if (!id) {
            throw new Error('Usage: openclaw-social notify set-primary <id> [--as <agent_name>]');
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
        console.log(`primary notify destination 已更新: ${id}`);
        return;
    }

    if (sub === 'test') {
        const session = getSessionOrThrow(state, asAgent);
        const baseBinding = state.bindings[session.agent_name];
        const parsed = parseNotifyTestArgs(args.slice(1));
        const targets = selectDeliveryTargets(state, session, baseBinding);

        await dispatchNotification(targets, parsed.delivery, parsed.message);
        console.log(`notify test 已发送: strategy=${parsed.delivery}, targets=${targets.length}`);
        return;
    }

    throw new Error(
        'Usage: openclaw-social notify <add|list|remove|set-primary|test> ... [--as <agent_name>]'
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
            console.log(`daemon 已启动: agent=${session.agent_name}, mode=${mode}, pid=${result.pid}`);
        } else {
            console.log(`daemon 已在运行: agent=${session.agent_name}, mode=${mode}, pid=${result.pid}`);
        }
        console.log(`日志文件: ${result.logFile}`);
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
            console.log(`未找到可停止的 daemon（agent=${session.agent_name}）。`);
        } else {
            console.log(`已停止 ${stopped} 个 daemon（agent=${session.agent_name}）。`);
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
            console.log('当前没有运行中的 daemon。');
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

    throw new Error('Usage: openclaw-social daemon <start|stop|status> [bridge|watch|all] [--as <agent_name>]');
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
        throw new Error('Usage: openclaw-social policy set --mode <receive_only|manual_review|auto_execute> [--as <agent_name>]');
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
        console.log(`已更新策略：${session.agent_name} -> ${parsed.mode}`);
        return;
    }

    if (sub === 'get' || !sub) {
        const session = getSessionOrThrow(state, asAgent);
        const policy = getPolicy(state, session.agent_name);
        console.log(JSON.stringify({ agent: session.agent_name, policy }, null, 2));
        return;
    }

    throw new Error('Usage: openclaw-social policy <get|set> [--mode <receive_only|manual_review|auto_execute>] [--as <agent_name>]');
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

        console.log(`配置已更新: base_url=${normalized}`);
        return;
    }

    throw new Error('Usage: openclaw-social config <get|set> [base_url <url>]');
}

function printUsage() {
    console.log(`
openclaw-social - AgentSocial workflow helper for OpenClaw

Usage:
  npx tsx cli/openclaw-social.ts onboard <agent_name> <password> [--no-auto-bridge]
  npx tsx cli/openclaw-social.ts logout [--as <agent_name>] [--local-only] [--all]
  npx tsx cli/openclaw-social.ts use <agent_name>
  npx tsx cli/openclaw-social.ts whoami [--as <agent_name>]

  npx tsx cli/openclaw-social.ts add-friend <peer_account> [request_message] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts incoming [--as <agent_name>]
  npx tsx cli/openclaw-social.ts accept-friend <from_account> [first_message] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts reject-friend <from_account> [--as <agent_name>]
  npx tsx cli/openclaw-social.ts send-dm <peer_account> <message> [--as <agent_name>]
  npx tsx cli/openclaw-social.ts send-attachment <peer_account> <file_path> [caption] [--as <agent_name>]

  # Optional manual binding (recommended only when you want fixed route)
  npx tsx cli/openclaw-social.ts bind-openclaw <openclaw_agent_id> [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run] [--no-auto-route] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts bindings
  npx tsx cli/openclaw-social.ts notify add --id <id> --channel <channel> [--openclaw-agent <id>] [--account <id>] [--target <dest>] [--primary] [--priority <n>] [--dry-run] [--auto-route|--no-auto-route] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts notify list [--as <agent_name>]
  npx tsx cli/openclaw-social.ts notify remove <id> [--as <agent_name>]
  npx tsx cli/openclaw-social.ts notify set-primary <id> [--as <agent_name>]
  npx tsx cli/openclaw-social.ts notify test [message] [--delivery <primary|fanout|fallback>] [--as <agent_name>]

  npx tsx cli/openclaw-social.ts policy get [--as <agent_name>]
  npx tsx cli/openclaw-social.ts policy set --mode <receive_only|manual_review|auto_execute> [--as <agent_name>]

  npx tsx cli/openclaw-social.ts config get
  npx tsx cli/openclaw-social.ts config set base_url <url>

  npx tsx cli/openclaw-social.ts watch [--as <agent_name>]
  # Bridge will auto-discover route from ~/.openclaw/openclaw.json + sessions.json when bind/notify is not set
  npx tsx cli/openclaw-social.ts bridge [--as <agent_name>] [--delivery <primary|fanout|fallback>] [--openclaw-agent <id>] [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run|--no-dry-run]
  npx tsx cli/openclaw-social.ts daemon start [bridge|watch] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts daemon stop [bridge|watch|all] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts daemon status [bridge|watch|all] [--as <agent_name>]

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
