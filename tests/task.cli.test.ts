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
    tasks?: Record<string, Record<string, unknown>>;
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

const tempHomes: string[] = [];

afterEach(async () => {
    while (tempHomes.length > 0) {
        const target = tempHomes.pop()!;
        await fs.rm(target, { recursive: true, force: true });
    }
});

describe('CLI task list', () => {
    it('should list task records with filters', async () => {
        const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawtalk-task-list-'));
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
                agent_test: {
                    friend_request_ids: [],
                    message_ids: [],
                    outgoing_request_status: {},
                    outgoing_request_order: [],
                    mailbox_pending: {},
                    mailbox_pending_order: [],
                    notification_acks: {},
                    notification_ack_order: [],
                    notification_retry_queue: [],
                },
            },
            bindings: {},
            policies: {},
            notify_profiles: {},
            tasks: {
                agent_test: {
                    task_1: {
                        task_id: 'task_1',
                        direction: 'incoming',
                        peer_agent_name: 'agent_b',
                        request: 'collect latest KPI',
                        status: 'requested',
                        created_at: '2026-04-14T10:00:00.000Z',
                        updated_at: '2026-04-14T10:00:00.000Z',
                    },
                    task_2: {
                        task_id: 'task_2',
                        direction: 'outgoing',
                        peer_agent_name: 'agent_c',
                        request: 'run benchmark',
                        status: 'completed',
                        result: 'benchmark complete',
                        created_at: '2026-04-14T10:10:00.000Z',
                        updated_at: '2026-04-14T10:20:00.000Z',
                    },
                },
            },
        });

        const all = await runClawtalk(homeDir, ['task', 'list', '--as', 'agent_test']);
        expect(all.stdout).toContain('Task records for agent_test: 2');
        expect(all.stdout).toContain('task_1');
        expect(all.stdout).toContain('task_2');

        const filtered = await runClawtalk(homeDir, [
            'task',
            'list',
            '--direction',
            'outgoing',
            '--status',
            'completed',
            '--as',
            'agent_test',
        ]);
        expect(filtered.stdout).toContain('Task records for agent_test: 1');
        expect(filtered.stdout).toContain('task_2');
        expect(filtered.stdout).not.toContain('task_1');
    });

    it('should validate task list args', async () => {
        const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawtalk-task-list-fail-'));
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
                agent_test: {
                    friend_request_ids: [],
                    message_ids: [],
                    outgoing_request_status: {},
                    outgoing_request_order: [],
                    mailbox_pending: {},
                    mailbox_pending_order: [],
                    notification_acks: {},
                    notification_ack_order: [],
                    notification_retry_queue: [],
                },
            },
            bindings: {},
            policies: {},
            notify_profiles: {},
        });

        const err = await runClawtalkExpectFail(homeDir, [
            'task',
            'list',
            '--status',
            'unknown',
            '--as',
            'agent_test',
        ]);
        expect(err).toContain('Invalid --status');
    });
});

