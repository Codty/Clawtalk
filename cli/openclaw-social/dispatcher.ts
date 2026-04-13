import type { CliConfig, LocalState } from './types.js';

export interface DispatcherHandlers {
    commandOwnerConnect: (args: string[], state: LocalState) => Promise<void>;
    commandOwnerRegister: (args: string[], state: LocalState) => Promise<void>;
    commandOwnerLogin: (args: string[], state: LocalState) => Promise<void>;
    commandOwnerRotateToken: (state: LocalState) => Promise<void>;
    commandOwnerWhoami: (state: LocalState) => Promise<void>;
    commandOwnerLogout: (state: LocalState) => Promise<void>;
    commandOwnerAgents: (state: LocalState) => Promise<void>;
    commandOwnerSessions: (state: LocalState) => Promise<void>;
    commandOwnerRevokeSession: (args: string[], state: LocalState) => Promise<void>;
    commandOwnerCreateAgent: (args: string[], state: LocalState) => Promise<void>;
    commandOwnerBindAgent: (args: string[], state: LocalState) => Promise<void>;
    commandOnboard: (args: string[], state: LocalState) => Promise<void>;
    commandLogin: (args: string[], state: LocalState) => Promise<void>;
    commandClaimStatus: (state: LocalState, asAgent?: string) => Promise<void>;
    commandClaimComplete: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandLogout: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandSwitch: (args: string[], state: LocalState) => Promise<void>;
    commandWhoami: (state: LocalState, asAgent?: string) => Promise<void>;
    commandProfile: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandAddFriend: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandUnfriend: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandListFriends: (state: LocalState, asAgent?: string) => Promise<void>;
    commandIncoming: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandOutgoing: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandAcceptFriend: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandRejectFriend: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandCancelFriendRequest: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandSendDm: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandMessageStatus: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandSendAttachment: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandDownloadAttachment: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandAgentCard: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandInbox: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandFriendZone: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandLocalLogs: (state: LocalState, asAgent?: string) => Promise<void>;
    commandBindOpenClaw: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandShowBindings: (state: LocalState) => Promise<void>;
    commandNotify: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandNotifyPref: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandWatch: (state: LocalState, asAgent?: string) => Promise<void>;
    commandBridge: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandPolicy: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    commandConfig: (args: string[], config: CliConfig) => Promise<void>;
    commandGuided: (state: LocalState) => Promise<void>;
    commandDoctor: (state: LocalState) => Promise<void>;
    commandDaemon: (args: string[], state: LocalState, asAgent?: string) => Promise<void>;
    printUsage: () => void;
}

export async function dispatchCommand(params: {
    command?: string;
    rest: string[];
    state: LocalState;
    config: CliConfig;
    asAgent?: string;
    handlers: DispatcherHandlers;
}): Promise<void> {
    const { command, rest, state, config, asAgent, handlers } = params;

    switch (command) {
        case 'owner-connect':
            await handlers.commandOwnerConnect(rest, state);
            break;
        case 'owner-register':
            await handlers.commandOwnerRegister(rest, state);
            break;
        case 'owner-login':
            await handlers.commandOwnerLogin(rest, state);
            break;
        case 'owner-rotate-token':
            await handlers.commandOwnerRotateToken(state);
            break;
        case 'owner-me':
            await handlers.commandOwnerWhoami(state);
            break;
        case 'owner-logout':
            await handlers.commandOwnerLogout(state);
            break;
        case 'owner-agents':
            await handlers.commandOwnerAgents(state);
            break;
        case 'owner-sessions':
            await handlers.commandOwnerSessions(state);
            break;
        case 'owner-revoke-session':
            await handlers.commandOwnerRevokeSession(rest, state);
            break;
        case 'owner-create-agent':
            await handlers.commandOwnerCreateAgent(rest, state);
            break;
        case 'owner-bind-agent':
            await handlers.commandOwnerBindAgent(rest, state);
            break;
        case 'onboard':
            await handlers.commandOnboard(rest, state);
            break;
        case 'login':
            await handlers.commandLogin(rest, state);
            break;
        case 'claim-status':
            await handlers.commandClaimStatus(state, asAgent);
            break;
        case 'claim-complete':
            await handlers.commandClaimComplete(rest, state, asAgent);
            break;
        case 'logout':
            await handlers.commandLogout(rest, state, asAgent);
            break;
        case 'use':
            await handlers.commandSwitch(rest, state);
            break;
        case 'whoami':
            await handlers.commandWhoami(state, asAgent);
            break;
        case 'profile':
            await handlers.commandProfile(rest, state, asAgent);
            break;
        case 'add-friend':
            await handlers.commandAddFriend(rest, state, asAgent);
            break;
        case 'unfriend':
        case 'remove-friend':
            await handlers.commandUnfriend(rest, state, asAgent);
            break;
        case 'list-friends':
        case 'friends':
            await handlers.commandListFriends(state, asAgent);
            break;
        case 'incoming':
            await handlers.commandIncoming(rest, state, asAgent);
            break;
        case 'outgoing':
            await handlers.commandOutgoing(rest, state, asAgent);
            break;
        case 'accept-friend':
            await handlers.commandAcceptFriend(rest, state, asAgent);
            break;
        case 'reject-friend':
            await handlers.commandRejectFriend(rest, state, asAgent);
            break;
        case 'cancel-friend-request':
        case 'cancel-request':
            await handlers.commandCancelFriendRequest(rest, state, asAgent);
            break;
        case 'send-dm':
            await handlers.commandSendDm(rest, state, asAgent);
            break;
        case 'message-status':
        case 'msg-status':
            await handlers.commandMessageStatus(rest, state, asAgent);
            break;
        case 'leave-message':
            await handlers.commandSendDm(['--mailbox', ...rest], state, asAgent);
            break;
        case 'send-attachment':
            await handlers.commandSendAttachment(rest, state, asAgent);
            break;
        case 'download-attachment':
            await handlers.commandDownloadAttachment(rest, state, asAgent);
            break;
        case 'agent-card':
        case 'card':
            await handlers.commandAgentCard(rest, state, asAgent);
            break;
        case 'inbox':
            await handlers.commandInbox(rest, state, asAgent);
            break;
        case 'friend-zone':
        case 'fz':
            await handlers.commandFriendZone(rest, state, asAgent);
            break;
        case 'local-logs':
            await handlers.commandLocalLogs(state, asAgent);
            break;
        case 'bind-openclaw':
            await handlers.commandBindOpenClaw(rest, state, asAgent);
            break;
        case 'bindings':
            await handlers.commandShowBindings(state);
            break;
        case 'notify':
            await handlers.commandNotify(rest, state, asAgent);
            break;
        case 'notify-pref':
            await handlers.commandNotifyPref(rest, state, asAgent);
            break;
        case 'watch':
            await handlers.commandWatch(state, asAgent);
            break;
        case 'bridge':
            await handlers.commandBridge(rest, state, asAgent);
            break;
        case 'policy':
            await handlers.commandPolicy(rest, state, asAgent);
            break;
        case 'config':
            await handlers.commandConfig(rest, config);
            break;
        case 'guided':
            await handlers.commandGuided(state);
            break;
        case 'doctor':
            await handlers.commandDoctor(state);
            break;
        case 'daemon':
            await handlers.commandDaemon(rest, state, asAgent);
            break;
        case 'help':
        case '--help':
        case '-h':
        case undefined:
            handlers.printUsage();
            break;
        default:
            throw new Error(`Unknown command: ${command}`);
    }
}
