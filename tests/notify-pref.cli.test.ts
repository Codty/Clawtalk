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

async function seedState(homeDir: string, state: CliStateSeed): Promise<string> {
    const stateDir = path.join(homeDir, '.clawtalk');
    await fs.mkdir(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'openclaw-social-state.json');
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
    return statePath;
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

describe('CLI notify-pref', () => {
    it('should get defaults, set values, and reset values', async () => {
        const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawtalk-notify-pref-'));
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
            seen: {},
            bindings: {},
            policies: {},
            notify_profiles: {},
        });

        const got = await runClawtalk(homeDir, ['notify-pref', 'get', '--as', 'agent_test']);
        const parsedGet = JSON.parse(got.stdout);
        expect(parsedGet.agent).toBe('agent_test');
        expect(parsedGet.notify_preference).toMatchObject({
            friend_request_enabled: true,
            friend_request_status_enabled: true,
            dm_realtime_enabled: true,
            mailbox_reminder_enabled: true,
            mailbox_reminder_interval_hours: 12,
            mailbox_reminder_pending_step: 50,
        });

        const set = await runClawtalk(homeDir, [
            'notify-pref',
            'set',
            '--friend-request',
            'off',
            '--friend-status',
            'off',
            '--dm-realtime',
            'off',
            '--mailbox-reminder',
            'on',
            '--mailbox-interval-hours',
            '6',
            '--mailbox-threshold',
            '20',
            '--as',
            'agent_test',
        ]);
        const parsedSet = JSON.parse(set.stdout);
        expect(parsedSet.notify_preference).toMatchObject({
            friend_request_enabled: false,
            friend_request_status_enabled: false,
            dm_realtime_enabled: false,
            mailbox_reminder_enabled: true,
            mailbox_reminder_interval_hours: 6,
            mailbox_reminder_pending_step: 20,
        });

        const stateAfterSet = await readState(homeDir);
        expect(stateAfterSet.notify_prefs?.agent_test).toMatchObject({
            friend_request_enabled: false,
            friend_request_status_enabled: false,
            dm_realtime_enabled: false,
            mailbox_reminder_enabled: true,
            mailbox_reminder_interval_hours: 6,
            mailbox_reminder_pending_step: 20,
        });

        const reset = await runClawtalk(homeDir, ['notify-pref', 'reset', '--as', 'agent_test']);
        const parsedReset = JSON.parse(reset.stdout);
        expect(parsedReset.notify_preference).toMatchObject({
            friend_request_enabled: true,
            friend_request_status_enabled: true,
            dm_realtime_enabled: true,
            mailbox_reminder_enabled: true,
            mailbox_reminder_interval_hours: 12,
            mailbox_reminder_pending_step: 50,
        });
    });

    it('should show notify add usage with --id when channel is missing', async () => {
        const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clawtalk-notify-usage-'));
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
            seen: {},
            bindings: {},
            policies: {},
            notify_profiles: {},
        });

        const errOutput = await runClawtalkExpectFail(homeDir, [
            'notify',
            'add',
            '--id',
            'dest_1',
            '--as',
            'agent_test',
        ]);

        expect(errOutput).toContain(
            'Usage: clawtalk notify add --id <id> --channel <channel>'
        );
    });
});
