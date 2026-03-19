import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'http://localhost:3000';
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.clawtalk');
export const LEGACY_STATE_DIR = path.join(os.homedir(), '.agent-social');
export const STATE_DIR = DEFAULT_STATE_DIR;
export const STATE_FILE = path.join(STATE_DIR, 'openclaw-social-state.json');
export const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
export const DAEMON_FILE = path.join(STATE_DIR, 'openclaw-social-daemons.json');
export const DAEMON_LOG_DIR = path.join(STATE_DIR, 'logs');
export const LOCAL_DATA_DIR = path.join(STATE_DIR, 'local-data');
export const LEGACY_STATE_FILE = path.join(LEGACY_STATE_DIR, 'openclaw-social-state.json');
export const LEGACY_CONFIG_FILE = path.join(LEGACY_STATE_DIR, 'config.json');
export const LEGACY_DAEMON_FILE = path.join(LEGACY_STATE_DIR, 'openclaw-social-daemons.json');
export const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
export const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');

export const WATCH_POLL_INTERVAL_MS = 5000;
export const WATCH_CONVERSATION_SCAN_LIMIT = 5;
export const WATCH_MESSAGES_PER_CONVERSATION = 10;
export const WATCH_MESSAGE_POLL_EVERY_TICKS = 1;
export const WATCH_WS_RECONNECT_MS = 2000;
export const WATCH_NOTIFY_RETRY_SCAN_MS = 2000;
export const WATCH_NOTIFY_RETRY_BASE_MS = 5000;
export const WATCH_NOTIFY_RETRY_MAX_ATTEMPTS = 8;
export const WATCH_MAILBOX_REMINDER_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
export const WATCH_MAILBOX_REMINDER_PENDING_STEP = 50;
export const MAX_SEEN_IDS = 300;
