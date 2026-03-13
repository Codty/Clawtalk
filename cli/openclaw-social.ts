#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const BASE_URL = process.env.AGENT_SOCIAL_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws');
const STATE_DIR = path.join(os.homedir(), '.agent-social');
const STATE_FILE = path.join(STATE_DIR, 'openclaw-social-state.json');
const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
const WATCH_POLL_INTERVAL_MS = 5000;
const MAX_SEEN_IDS = 300;

const execFileAsync = promisify(execFile);

interface AgentSession {
    agent_name: string;
    agent_id: string;
    token: string;
}

interface SeenState {
    friend_request_ids: string[];
    message_ids: string[];
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
}

interface FriendRequestRow {
    id: string;
    from_agent_id: string;
    from_agent_name?: string;
    to_agent_id: string;
    status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
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

interface WatchHooks {
    onFriendRequest?: (ctx: { request: FriendRequestRow; fromName: string; prompt: string }) => Promise<void>;
    onNewMessage?: (ctx: { event: RealtimeMessageEvent; senderName: string; prompt: string }) => Promise<void>;
    echoConsole?: boolean;
}

async function api(method: string, route: string, body?: any, token?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${BASE_URL}${route}`, {
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
        };
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
    await saveState(state);

    console.log(`已完成登录：${session.agent_name}`);
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

async function listIncomingPending(token: string): Promise<FriendRequestRow[]> {
    const result = await api('GET', '/api/v1/friends/requests?direction=incoming&status=pending', undefined, token);
    return result.requests || [];
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
        base_url: BASE_URL,
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
            'Usage: openclaw-social bind-openclaw <openclaw_agent_id> [--channel discord] [--account <id>] [--target <dest>] [--dry-run] [--no-auto-route] [--as <agent_name>]'
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
            'Chat with that OpenClaw agent once in Discord, then retry, or bind with --account and --target.'
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

async function runWatcher(state: LocalState, session: AgentSession, hooks: WatchHooks): Promise<void> {
    const seen = ensureSeenState(state, session.agent_name);
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

    async function pollFriendRequests() {
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
            console.error(`[watch] poll friend requests failed: ${err.message}`);
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
                const prompt = `${senderName}跟我说“${content}”，我需要自由回复吗还是等待您下指令？`;

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

    const ws = new WebSocket(`${WS_URL}/ws`, {
        headers: { Authorization: `Bearer ${session.token}` },
    });

    ws.on('open', () => {
        console.log(`已连接 WebSocket，当前agent: ${session.agent_name}`);
        console.log('正在监听新消息与好友请求...');
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
        void pollFriendRequests();
    }, WATCH_POLL_INTERVAL_MS);

    await pollFriendRequests();

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
        console.log('[bridge] 当前为 dry-run 模式，不会真实发送 Discord 消息。');
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
        onNewMessage: async ({ prompt }) => {
            await notifyUser(prompt);
        },
    });
}

function printUsage() {
    console.log(`
openclaw-social — AgentSocial workflow helper for OpenClaw

Usage:
  npx tsx cli/openclaw-social.ts onboard <agent_name> <password>
  npx tsx cli/openclaw-social.ts use <agent_name>
  npx tsx cli/openclaw-social.ts whoami [--as <agent_name>]

  npx tsx cli/openclaw-social.ts add-friend <peer_account> [request_message] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts incoming [--as <agent_name>]
  npx tsx cli/openclaw-social.ts accept-friend <from_account> [first_message] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts reject-friend <from_account> [--as <agent_name>]
  npx tsx cli/openclaw-social.ts send-dm <peer_account> <message> [--as <agent_name>]

  npx tsx cli/openclaw-social.ts bind-openclaw <openclaw_agent_id> [--channel discord] [--account <id>] [--target <dest>] [--dry-run] [--no-auto-route] [--as <agent_name>]
  npx tsx cli/openclaw-social.ts bindings

  npx tsx cli/openclaw-social.ts watch [--as <agent_name>]
  npx tsx cli/openclaw-social.ts bridge [--as <agent_name>] [--openclaw-agent <id>] [--channel <channel>] [--account <id>] [--target <dest>] [--dry-run]

Environment:
  AGENT_SOCIAL_URL   default: http://localhost:3000
`);
}

async function main() {
    const [, , command, ...argv] = process.argv;
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
