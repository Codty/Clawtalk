import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface CliStateSeed {
    current_agent: string;
    sessions: Record<string, { agent_name: string; agent_id: string; token: string }>;
    seen: Record<string, unknown>;
    bindings: Record<string, unknown>;
    policies: Record<string, unknown>;
    notify_profiles: Record<string, unknown>;
    notify_prefs?: Record<string, unknown>;
}

async function seedState(homeDir: string, state: CliStateSeed): Promise<void> {
    const stateDir = path.join(homeDir, '.clawtalk');
    await fs.mkdir(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'openclaw-social-state.json');
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

async function runClawtalk(homeDir: string, args: string[]) {
    const env = {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
    };
    return execFileAsync(NPM_BIN, ['run', '-s', 'clawtalk', '--', ...args], {
        cwd: ROOT,
        env,
    });
}

async function runClawtalkExpectFail(homeDir: string, args: string[]): Promise<string> {
    try {
        await runClawtalk(homeDir, args);
        throw new Error('Expected command to fail but it succeeded');
    } catch (err: any) {
        return String(err?.stderr || err?.stdout || err?.message || err);
    }
}

async function readState(homeDir: string): Promise<any> {
    const statePath = path.join(homeDir, '.clawtalk', 'openclaw-social-state.json');
    const raw = await fs.readFile(statePath, 'utf-8');
    return JSON.parse(raw);
}

const tempHomes: string[] = [];

afterEach(async () => {
    while (tempHomes.length > 0) {
        const target = tempHomes.pop()!;
        await fs.rm(target, { recursive: true, force: true });
    }
});

function makeMailboxSeen(count: number) {
    const mailbox_pending: Record<string, any> = {};
    const mailbox_pending_order: string[] = [];
    for (let i = 1; i <= count; i += 1) {
        const id = `msg-${i}`;
        mailbox_pending[id] = {
            message_id: id,
            conversation_id: 'conv-1',
            from_agent_name: 'peer_a',
            content: `message-${i}`,
            envelope_type: 'text',
            created_at: `2026-03-30T0${i}:00:00.000Z`,
            priority: 'normal',
        };
        mailbox_pending_order.push(id);
    }
    return {
        friend_request_ids: [],
        message_ids: [],
        outgoing_request_status: {},
        outgoing_request_order: [],
        mailbox_pending,
        mailbox_pending_order,
        mailbox_first_pending_at: '2026-03-30T01:00:00.000Z',
        mailbox_last_notified_at: '2026-03-30T12:00:00.000Z',
        mailbox_last_threshold_bucket: 2,
        notification_acks: {},
        notification_ack_order: [],
        notification_retry_queue: [],
    };
}

describe('CLI inbox done/ack', () => {
    it('should support inbox done --all and reset reminder cadence fields', async () => {
        const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawtalk-inbox-all-'));
        tempHomes.push(homeDir);

        await seedState(homeDir, {
            current_agent: 'agent_test',
            sessions: {
                agent_test: {
                    agent_name: 'agent_test',
                    agent_id: 'agent-test-id',
                    token: 'dummy-token',
                },
            },
            seen: {
                agent_test: makeMailboxSeen(2),
            },
            bindings: {},
            policies: {},
            notify_profiles: {},
        });

        const res = await runClawtalk(homeDir, ['inbox', 'done', '--all', '--as', 'agent_test']);
        expect(res.stdout).toContain('Marked mailbox items as done: removed=2');

        const state = await readState(homeDir);
        const seen = state.seen.agent_test;
        expect(seen.mailbox_pending_order).toEqual([]);
        expect(seen.mailbox_pending).toEqual({});
        expect(seen.mailbox_first_pending_at).toBeUndefined();
        expect(seen.mailbox_last_notified_at).toBeUndefined();
        expect(seen.mailbox_last_threshold_bucket).toBe(0);
    });

    it('should allow inbox done without id when exactly one pending item exists', async () => {
        const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawtalk-inbox-single-'));
        tempHomes.push(homeDir);

        await seedState(homeDir, {
            current_agent: 'agent_test',
            sessions: {
                agent_test: {
                    agent_name: 'agent_test',
                    agent_id: 'agent-test-id',
                    token: 'dummy-token',
                },
            },
            seen: {
                agent_test: makeMailboxSeen(1),
            },
            bindings: {},
            policies: {},
            notify_profiles: {},
        });

        const res = await runClawtalk(homeDir, ['inbox', 'done', '--as', 'agent_test']);
        expect(res.stdout).toContain('Marked mailbox item as done: msg-1');

        const state = await readState(homeDir);
        expect(state.seen.agent_test.mailbox_pending_order).toEqual([]);
    });

    it('should fail inbox done without id when multiple pending items exist', async () => {
        const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawtalk-inbox-usage-'));
        tempHomes.push(homeDir);

        await seedState(homeDir, {
            current_agent: 'agent_test',
            sessions: {
                agent_test: {
                    agent_name: 'agent_test',
                    agent_id: 'agent-test-id',
                    token: 'dummy-token',
                },
            },
            seen: {
                agent_test: makeMailboxSeen(2),
            },
            bindings: {},
            policies: {},
            notify_profiles: {},
        });

        const err = await runClawtalkExpectFail(homeDir, ['inbox', 'done', '--as', 'agent_test']);
        expect(err).toContain('clawtalk inbox done <message_id>');
        expect(err).toContain('clawtalk inbox done --all');
    });
});

