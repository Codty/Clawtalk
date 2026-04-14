import fs from 'node:fs/promises';
import {
    CONFIG_FILE,
    DAEMON_FILE,
    DEFAULT_BASE_URL,
    LEGACY_CONFIG_FILE,
    LEGACY_DAEMON_FILE,
    LEGACY_STATE_DIR,
    LEGACY_STATE_FILE,
    STATE_DIR,
    STATE_FILE,
    WATCH_MAILBOX_REMINDER_INTERVAL_MS,
    WATCH_MAILBOX_REMINDER_PENDING_STEP,
} from './constants.js';
import type {
    AgentPolicy,
    CliConfig,
    DaemonRegistry,
    LocalState,
    NotifyDestination,
    NotifyPreference,
} from './types.js';

export function normalizeBaseUrl(value: string): string {
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) throw new Error('base_url cannot be empty');
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('base_url must start with http:// or https://');
    }
    return parsed.toString().replace(/\/+$/, '');
}

function defaultConfig(): CliConfig {
    return {};
}

export async function loadConfig(): Promise<CliConfig> {
    for (const filePath of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(content) as CliConfig;
            return {
                base_url: parsed.base_url,
            };
        } catch {
            // Try next fallback path.
        }
    }
    return defaultConfig();
}

export async function saveConfig(config: CliConfig): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

export async function migrateLegacyStateDirIfNeeded(): Promise<void> {
    if (STATE_DIR === LEGACY_STATE_DIR) return;

    const hasNewDir = await pathExists(STATE_DIR);
    if (hasNewDir) return;

    const hasLegacyDir = await pathExists(LEGACY_STATE_DIR);
    if (!hasLegacyDir) return;

    try {
        await fs.rename(LEGACY_STATE_DIR, STATE_DIR);
        return;
    } catch (err: any) {
        const code = String(err?.code || '');
        if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') {
            throw err;
        }
    }

    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.cp(LEGACY_STATE_DIR, STATE_DIR, {
        recursive: true,
        errorOnExist: false,
        force: false,
    });
}

export function resolveBaseUrl(config: CliConfig): string {
    if (process.env.CLAWTALK_URL) {
        return normalizeBaseUrl(process.env.CLAWTALK_URL);
    }
    if (process.env.AGENT_SOCIAL_URL) {
        return normalizeBaseUrl(process.env.AGENT_SOCIAL_URL);
    }
    if (config.base_url) {
        return normalizeBaseUrl(config.base_url);
    }
    return DEFAULT_BASE_URL;
}

export function defaultPolicy(): AgentPolicy {
    return { mode: 'receive_only' };
}

export function getPolicy(state: LocalState, agentName: string): AgentPolicy {
    return state.policies[agentName] || defaultPolicy();
}

export function getNotifyDestinations(state: LocalState, agentName: string): NotifyDestination[] {
    return (state.notify_profiles[agentName] || []).filter((dest) => dest.enabled !== false);
}

export function defaultNotifyPreference(): NotifyPreference {
    return {
        friend_request_enabled: true,
        friend_request_status_enabled: true,
        dm_realtime_enabled: true,
        mailbox_reminder_enabled: true,
        mailbox_reminder_interval_hours: Math.max(
            1,
            Math.floor(WATCH_MAILBOX_REMINDER_INTERVAL_MS / (60 * 60 * 1000))
        ),
        mailbox_reminder_pending_step: Math.max(1, WATCH_MAILBOX_REMINDER_PENDING_STEP),
    };
}

export function getNotifyPreference(state: LocalState, agentName: string): NotifyPreference {
    const base = defaultNotifyPreference();
    const raw = state.notify_prefs?.[agentName];
    if (!raw) return base;

    const intervalHours = Number.isFinite(Number(raw.mailbox_reminder_interval_hours))
        ? Math.max(1, Math.floor(Number(raw.mailbox_reminder_interval_hours)))
        : base.mailbox_reminder_interval_hours;
    const pendingStep = Number.isFinite(Number(raw.mailbox_reminder_pending_step))
        ? Math.max(1, Math.floor(Number(raw.mailbox_reminder_pending_step)))
        : base.mailbox_reminder_pending_step;

    return {
        friend_request_enabled: raw.friend_request_enabled !== false,
        friend_request_status_enabled: raw.friend_request_status_enabled !== false,
        dm_realtime_enabled: raw.dm_realtime_enabled !== false,
        mailbox_reminder_enabled: raw.mailbox_reminder_enabled !== false,
        mailbox_reminder_interval_hours: intervalHours,
        mailbox_reminder_pending_step: pendingStep,
    };
}

export function daemonKey(agentName: string, mode: 'watch' | 'bridge'): string {
    return `${agentName}:${mode}`;
}

function defaultDaemonRegistry(): DaemonRegistry {
    return { entries: {} };
}

export async function loadDaemonRegistry(): Promise<DaemonRegistry> {
    for (const filePath of [DAEMON_FILE, LEGACY_DAEMON_FILE]) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(content) as DaemonRegistry;
            return {
                entries: parsed.entries || {},
            };
        } catch {
            // Try next fallback path.
        }
    }
    return defaultDaemonRegistry();
}

export async function saveDaemonRegistry(registry: DaemonRegistry): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(DAEMON_FILE, JSON.stringify(registry, null, 2));
}

export function isProcessRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function pruneStoppedDaemons(registry: DaemonRegistry): boolean {
    let changed = false;
    for (const [key, entry] of Object.entries(registry.entries)) {
        if (!isProcessRunning(entry.pid)) {
            delete registry.entries[key];
            changed = true;
        }
    }
    return changed;
}

function defaultState(): LocalState {
    return {
        owner_sessions: {},
        sessions: {},
        seen: {},
        bindings: {},
        policies: {},
        notify_profiles: {},
        notify_prefs: {},
        tasks: {},
    };
}

export async function loadState(): Promise<LocalState> {
    for (const filePath of [STATE_FILE, LEGACY_STATE_FILE]) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(content) as LocalState;
            return {
                current_owner: parsed.current_owner,
                owner_sessions: parsed.owner_sessions || {},
                current_agent: parsed.current_agent,
                sessions: parsed.sessions || {},
                seen: parsed.seen || {},
                bindings: parsed.bindings || {},
                policies: parsed.policies || {},
                notify_profiles: parsed.notify_profiles || {},
                notify_prefs: parsed.notify_prefs || {},
                tasks: parsed.tasks || {},
            };
        } catch {
            // Try next fallback path.
        }
    }
    return defaultState();
}

export async function saveState(state: LocalState): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}
