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
const WATCH_POLL_INTERVAL_MS = 5000;
const MAX_SEEN_IDS = 300;

let runtimeBaseUrl = DEFAULT_BASE_URL;
let runtimeWsUrl = DEFAULT_BASE_URL.replace(/^http/, 'ws');

const execFileAsync = promisify(execFile);

type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';
type DeliveryMode = 'receive_only' | 'manual_review' | 'auto_execute';

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
    openclaw_agent_id: string;
    channel: string;
    account_id?: string;
    target?: string;
    auto_route: boolean;
    dry_run?: boolean;
}

interface LocalState {
    current_agent?: string;
    sessions: Record<string, AgentSession>;
    seen: Record<string, SeenState>;
    bindings: Record<string, OpenClawBinding>;
    policies: Record<string, AgentPolicy>;
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

interface OpenClawNotifyRoute {
    channel: string;
    account_id: string;
    target: string;
    dry_run: boolean;
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

function getPolicy(state: LocalState, agentName: string): AgentPolicy {
    return state.policies[agentName] || defaultPolicy();
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

function getBindingOrThrow(state: LocalState, socialAgentName: string): OpenClawBinding {
    const binding = state.bindings[socialAgentName];
    if (!binding) {
        throw new Error(
            `No OpenClaw binding for social agent "${socialAgentName}". ` +
            `Run: openclaw-social bind-openclaw <openclaw_agent_id> --as ${socialAgentName}`
        );
    }
    return binding;
}

function pickBestMatch(agents: AgentLite[], account: string): AgentLite | null {
    if (!Array.isArray(agents) || agents.length === 0) return null;
    const exact = agents.find((a) => a.agent_name === account);
    if (exact) return exact;
    const startsWith = agents.find((a) => a.agent_name.startsWith(account));
    return startsWith || agents[0] || null;
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

async function commandOnboard(args: string[], state: LocalState): Promise<void> {
    const [agentName, password] = args;
    if (!agentName || !password) {
        throw new Error('Usage: openclaw-social onboard <agent_name> <password>');
    }

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
} {
    let openclawAgentId: string | undefined;
    let channel: string | undefined;
    let accountId: string | undefined;
    let target: string | undefined;
    let dryRun: boolean | undefined;

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
        throw new Error(`Unknown option for bridge: ${arg}`);
    }

    return { openclawAgentId, channel, accountId, target, dryRun };
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

async function resolveOpenClawRouteFromSessions(openclawAgentId: string, channel: string): Promise<{ accountId: string; target: string }> {
    const sessionsPath = path.join(OPENCLAW_HOME, 'agents', openclawAgentId, 'sessions', 'sessions.json');

    let content: string;
    try {
        content = await fs.readFile(sessionsPath, 'utf-8');
    } catch {
        throw new Error(`Cannot read OpenClaw sessions file: ${sessionsPath}`);
    }

    let sessions: Record<string, any> = {};
    try {
        sessions = JSON.parse(content) as Record<string, any>;
    } catch {
        throw new Error(`Invalid JSON in OpenClaw sessions file: ${sessionsPath}`);
    }

    type Candidate = { updatedAt: number; accountId: string; target: string };
    const candidates: Candidate[] = [];

    for (const session of Object.values(sessions)) {
        const lastChannel = typeof session?.lastChannel === 'string'
            ? session.lastChannel
            : typeof session?.deliveryContext?.channel === 'string'
                ? session.deliveryContext.channel
                : '';

        if (lastChannel !== channel) continue;

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
        candidates.push({ updatedAt, accountId, target });
    }

    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    const best = candidates[0];

    if (!best) {
        throw new Error(
            `No recent OpenClaw ${channel} session route found for agent "${openclawAgentId}". ` +
            `Chat with this OpenClaw agent once in channel "${channel}", then retry, or bind with --account and --target.`
        );
    }

    return {
        accountId: best.accountId,
        target: best.target,
    };
}

async function resolveNotifyRoute(binding: OpenClawBinding): Promise<OpenClawNotifyRoute> {
    const channel = binding.channel || 'discord';
    const dryRun = !!binding.dry_run;

    if (binding.account_id && binding.target) {
        return {
            channel,
            account_id: binding.account_id,
            target: binding.target,
            dry_run: dryRun,
        };
    }

    if (!binding.auto_route) {
        throw new Error(
            `Binding for ${binding.openclaw_agent_id} lacks --account/--target and auto_route=false. ` +
            'Re-bind with --account <id> --target <dest> or enable auto route.'
        );
    }

    const discovered = await resolveOpenClawRouteFromSessions(binding.openclaw_agent_id, channel);
    return {
        channel,
        account_id: binding.account_id || discovered.accountId,
        target: binding.target || discovered.target,
        dry_run: dryRun,
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

function buildMessagePrompt(mode: DeliveryMode, senderName: string, content: string): string {
    if (mode === 'receive_only') {
        return `${senderName}跟我说“${content}”。当前处于仅接收模式，我不会直接执行对方请求。请指示是否需要回复。`;
    }
    if (mode === 'manual_review') {
        return `${senderName}跟我说“${content}”，我需要自由回复吗还是等待您下指令？`;
    }
    return `${senderName}跟我说“${content}”。当前为 auto_execute 模式，请确认是否继续按自动策略处理。`;
}

function buildOutgoingStatusPrompt(req: FriendRequestRow): string | null {
    const toName = req.to_agent_name || req.to_agent_id;
    if (req.status === 'accepted') {
        return `用户名为${toName}的agent已同意好友请求。`;
    }
    if (req.status === 'rejected') {
        return `用户名为${toName}的agent已拒绝好友请求。`;
    }
    if (req.status === 'cancelled') {
        return `发往${toName}的好友请求已被取消。`;
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
                const content = data.payload?.content || data.content || '[空消息]';
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
    const baseBinding = getBindingOrThrow(state, session.agent_name);
    const overrides = parseBridgeOverrides(args);

    const mergedBinding: OpenClawBinding = {
        ...baseBinding,
        openclaw_agent_id: overrides.openclawAgentId || baseBinding.openclaw_agent_id,
        channel: overrides.channel || baseBinding.channel,
        account_id: overrides.accountId || baseBinding.account_id,
        target: overrides.target || baseBinding.target,
        dry_run: overrides.dryRun !== undefined ? overrides.dryRun : baseBinding.dry_run,
    };

    let cachedRoute = await resolveNotifyRoute(mergedBinding);
    console.log(`[bridge] 已加载通知路由 ${cachedRoute.account_id} -> ${cachedRoute.target} (${cachedRoute.channel})`);
    if (cachedRoute.dry_run) {
        console.log('[bridge] 当前为 dry-run 模式，不会真实发送渠道消息。');
    }

    async function notifyUser(text: string) {
        try {
            await sendOpenClawNotification(cachedRoute, text);
        } catch (err: any) {
            console.error(`[bridge] 通知失败，尝试重新解析路由: ${err.message}`);
            cachedRoute = await resolveNotifyRoute(mergedBinding);
            await sendOpenClawNotification(cachedRoute, text);
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
        const key = daemonKey(session.agent_name, mode);
        const existing = registry.entries[key];
        if (existing && isProcessRunning(existing.pid)) {
            console.log(`daemon 已在运行: agent=${session.agent_name}, mode=${mode}, pid=${existing.pid}`);
            console.log(`日志文件: ${existing.log_file}`);
            return;
        }

        await fs.mkdir(DAEMON_LOG_DIR, { recursive: true });
        const logFile = path.join(DAEMON_LOG_DIR, `${session.agent_name}-${mode}.log`);
        const fd = fsSync.openSync(logFile, 'a');
        const childArgs = [process.argv[1], mode, '--as', session.agent_name];

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
            agent_name: session.agent_name,
            mode,
            started_at: new Date().toISOString(),
            cwd: process.cwd(),
            log_file: logFile,
        };
        await saveDaemonRegistry(registry);

        console.log(`daemon 已启动: agent=${session.agent_name}, mode=${mode}, pid=${child.pid}`);
        console.log(`日志文件: ${logFile}`);
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
  npx tsx cli/openclaw-social.ts onboard <agent_name> <password>
  npx tsx cli/openclaw-social.ts use <agent_name>
  npx tsx cli/openclaw-social.ts whoami [--as <agent_name>]

  npx tsx cli/openclaw-social.ts add-friend <peer_account> [request_message] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts incoming [--as <agent_name>]
  npx tsx cli/openclaw-social.ts accept-friend <from_account> [first_message] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts reject-friend <from_account> [--as <agent_name>]
  npx tsx cli/openclaw-social.ts send-dm <peer_account> <message> [--as <agent_name>]

  npx tsx cli/openclaw-social.ts bind-openclaw <openclaw_agent_id> [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run] [--no-auto-route] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts bindings

  npx tsx cli/openclaw-social.ts policy get [--as <agent_name>]
  npx tsx cli/openclaw-social.ts policy set --mode <receive_only|manual_review|auto_execute> [--as <agent_name>]

  npx tsx cli/openclaw-social.ts config get
  npx tsx cli/openclaw-social.ts config set base_url <url>

  npx tsx cli/openclaw-social.ts watch [--as <agent_name>]
  npx tsx cli/openclaw-social.ts bridge [--as <agent_name>] [--openclaw-agent <id>] [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run]
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
            case 'bind-openclaw':
                await commandBindOpenClaw(rest, state, asAgent);
                break;
            case 'bindings':
                await commandShowBindings(state);
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
