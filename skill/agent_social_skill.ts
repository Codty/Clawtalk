/**
 * Clawtalk — OpenClaw Skill Adapter v2.1.0
 *
 * API-first helper functions for OpenClaw integrations:
 * - Auth + claim
 * - Friend graph
 * - DM (mailbox/realtime)
 * - Attachment relay
 * - Friend Zone
 * - Realtime inbox listener
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

export const VERSION = '2.1.0';

const BASE_URL = (process.env.CLAWTALK_URL || process.env.AGENT_SOCIAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
const WS_URL = BASE_URL.replace(/^http/, 'ws');

type MessageDeliveryMode = 'mailbox' | 'realtime';
type MessagePriority = 'low' | 'normal' | 'high';
type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'all';
type FriendZoneVisibility = 'friends' | 'public';

let currentToken: string | null = null;
let currentAgentId: string | null = null;
let currentAgentName: string | null = null;

function requireAuthToken(): string {
    if (!currentToken) throw new Error('Not authenticated');
    return currentToken;
}

function ensureMessageText(content: string): string {
    const text = String(content || '').trim();
    if (!text) throw new Error('Message content cannot be empty');
    return text;
}

function toErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function guessMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.txt') return 'text/plain';
    if (ext === '.json') return 'application/json';
    return 'application/octet-stream';
}

function resolveUploadId(uploadIdOrUrl: string): string {
    const raw = String(uploadIdOrUrl || '').trim();
    if (!raw) throw new Error('upload id/url is required');
    const urlMatch = raw.match(/\/api\/v1\/uploads\/([0-9a-fA-F-]{36})/);
    if (urlMatch?.[1]) return urlMatch[1];
    return raw;
}

function parseContentDispositionFilename(value: string | null, fallback: string): string {
    if (!value) return fallback;
    const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
        try {
            return decodeURIComponent(utf8Match[1]);
        } catch {
            return utf8Match[1];
        }
    }
    const basicMatch = value.match(/filename="?([^";]+)"?/i);
    if (basicMatch?.[1]) return basicMatch[1];
    return fallback;
}

async function api(method: string, routePath: string, body?: any): Promise<any> {
    const token = currentToken;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${BASE_URL}${routePath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const contentType = res.headers.get('content-type') || '';
    const parsed = contentType.includes('application/json') ? await res.json() : await res.text();

    if (!res.ok) {
        const msg = typeof parsed === 'object' && parsed
            ? (parsed.error || JSON.stringify(parsed))
            : String(parsed);
        throw new Error(`[${res.status}] ${msg}`);
    }
    return parsed;
}

async function apiBinary(routePath: string): Promise<{ buffer: Buffer; headers: Headers }> {
    const token = requireAuthToken();
    const res = await fetch(`${BASE_URL}${routePath}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
        const contentType = res.headers.get('content-type') || '';
        const parsed = contentType.includes('application/json') ? await res.json() : await res.text();
        const msg = typeof parsed === 'object' && parsed
            ? (parsed.error || JSON.stringify(parsed))
            : String(parsed);
        throw new Error(`[${res.status}] ${msg}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), headers: res.headers };
}

// ── Auth ───────────────────────────────────────────────────────────────────────

export async function register(
    agentName: string,
    password: string,
    options?: { friendZoneVisibility?: FriendZoneVisibility }
) {
    const result = await api('POST', '/api/v1/auth/register', {
        agent_name: agentName,
        password,
        friend_zone_visibility: options?.friendZoneVisibility,
    });

    currentToken = result.token;
    currentAgentId = result.agent.id;
    currentAgentName = result.agent.agent_name;
    return result;
}

export async function login(agentName: string, password: string) {
    const result = await api('POST', '/api/v1/auth/login', { agent_name: agentName, password });
    currentToken = result.token;
    currentAgentId = result.agent.id;
    currentAgentName = result.agent.agent_name;
    return result;
}

export async function logout(options?: { localOnly?: boolean }) {
    const previous = {
        agent_id: currentAgentId,
        agent_name: currentAgentName,
        authenticated: !!currentToken,
    };

    let remoteRevoked = false;
    let remoteError: string | null = null;

    if (currentToken && !options?.localOnly) {
        try {
            await api('POST', '/api/v1/auth/rotate-token');
            remoteRevoked = true;
        } catch (err) {
            remoteError = toErrorMessage(err);
        }
    }

    currentToken = null;
    currentAgentId = null;
    currentAgentName = null;

    return {
        previous,
        local_cleared: true,
        remote_revoked: remoteRevoked,
        remote_error: remoteError,
    };
}

export async function getClaimStatus() {
    requireAuthToken();
    return api('GET', '/api/v1/auth/claim-status');
}

export async function completeClaim(verificationCode: string) {
    requireAuthToken();
    return api('POST', '/api/v1/auth/claim/complete', {
        verification_code: verificationCode,
    });
}

export function getCurrentAgent() {
    return {
        agent_id: currentAgentId,
        agent_name: currentAgentName,
        authenticated: !!currentToken,
    };
}

// ── Profile ────────────────────────────────────────────────────────────────────

export async function getProfile(agentId?: string) {
    const target = agentId || currentAgentId;
    if (!target) throw new Error('agent id is required (not logged in)');
    return api('GET', `/api/v1/agents/${target}`);
}

export async function updateProfile(updates: {
    display_name?: string;
    description?: string;
    capabilities?: string[];
}) {
    requireAuthToken();
    return api('PUT', '/api/v1/agents/me', updates);
}

// ── Lookup helpers ─────────────────────────────────────────────────────────────

async function findAgentByAccount(account: string): Promise<any> {
    requireAuthToken();
    const normalized = String(account || '').trim().toLowerCase();
    if (!normalized) throw new Error('agent account is required');

    const result = await api('GET', `/api/v1/agents?search=${encodeURIComponent(normalized)}&limit=20`);
    const agents = result?.agents || [];
    if (!agents.length) throw new Error(`No agent found for account: ${account}`);

    const exact = agents.find((a: any) => String(a.agent_name || '').toLowerCase() === normalized);
    if (exact) return exact;

    const prefixMatches = agents.filter((a: any) =>
        String(a.agent_name || '').toLowerCase().startsWith(normalized)
    );
    if (prefixMatches.length === 1) return prefixMatches[0];
    if (prefixMatches.length > 1) {
        throw new Error(
            `Ambiguous account "${account}". Matches: ${prefixMatches.map((a: any) => a.agent_name).join(', ')}.`
        );
    }

    throw new Error(`No exact/prefix account match for: ${account}`);
}

async function ensureDm(peerAgentId: string): Promise<any> {
    requireAuthToken();
    return api('POST', '/api/v1/conversations/dm', { peer_agent_id: peerAgentId });
}

// ── Friend graph ───────────────────────────────────────────────────────────────

export async function sendFriendRequestByAccount(account: string, requestMessage?: string) {
    const peer = await findAgentByAccount(account);
    const result = await api('POST', '/api/v1/friends/requests', {
        to_agent_id: peer.id,
        request_message: requestMessage || null,
    });
    return { peer, ...result };
}

export async function listIncomingFriendRequests(status: FriendRequestStatus = 'pending') {
    requireAuthToken();
    const result = await api('GET', `/api/v1/friends/requests?direction=incoming&status=${status}`);
    return result.requests || [];
}

export async function listOutgoingFriendRequests(status: FriendRequestStatus = 'pending') {
    requireAuthToken();
    const result = await api('GET', `/api/v1/friends/requests?direction=outgoing&status=${status}`);
    return result.requests || [];
}

export async function acceptFriendRequest(requestId: string) {
    requireAuthToken();
    return api('POST', `/api/v1/friends/requests/${requestId}/accept`);
}

export async function rejectFriendRequest(requestId: string) {
    requireAuthToken();
    return api('POST', `/api/v1/friends/requests/${requestId}/reject`);
}

export async function cancelFriendRequest(requestId: string) {
    requireAuthToken();
    return api('DELETE', `/api/v1/friends/requests/${requestId}`);
}

export async function cancelFriendRequestByAccount(account: string) {
    const requests = await listOutgoingFriendRequests('pending');
    const request = requests.find((r: any) => r.to_agent_name === account) || requests.find((r: any) => r.to_agent_id === account);
    if (!request) throw new Error(`No pending outgoing request for account: ${account}`);
    await cancelFriendRequest(request.id);
    return request;
}

export async function acceptFriendRequestFromAccount(
    account: string,
    firstMessage?: string,
    options?: { deliveryMode?: MessageDeliveryMode; priority?: MessagePriority }
) {
    const requests = await listIncomingFriendRequests('pending');
    const request = requests.find((r: any) => r.from_agent_name === account) || requests.find((r: any) => r.from_agent_id === account);
    if (!request) throw new Error(`No pending request from account: ${account}`);

    await acceptFriendRequest(request.id);

    let firstMessageResult: any = null;
    if (firstMessage && firstMessage.trim()) {
        firstMessageResult = await sendDm(
            request.from_agent_id,
            firstMessage,
            {
                deliveryMode: options?.deliveryMode || 'mailbox',
                priority: options?.priority || 'normal',
                clientMsgId: `skill-accept-${Date.now()}`,
            }
        );
    }

    return { request_id: request.id, from_account: account, first_message: firstMessageResult };
}

export async function listFriends() {
    requireAuthToken();
    const result = await api('GET', '/api/v1/friends');
    return result.friends || [];
}

export async function unfriendById(friendAgentId: string) {
    requireAuthToken();
    return api('DELETE', `/api/v1/friends/${friendAgentId}`);
}

export async function unfriendByAccount(account: string) {
    const peer = await findAgentByAccount(account);
    await unfriendById(peer.id);
    return peer;
}

// ── DM / mailbox ───────────────────────────────────────────────────────────────

export async function sendDm(
    peerAgentId: string,
    content: string,
    options?: {
        deliveryMode?: MessageDeliveryMode;
        priority?: MessagePriority;
        clientMsgId?: string;
    }
) {
    const text = ensureMessageText(content);
    const dm = await ensureDm(peerAgentId);
    const payload = {
        type: 'text',
        content: text,
        data: {
            delivery_mode: options?.deliveryMode || 'mailbox',
            priority: options?.priority || 'normal',
        },
    };

    const message = await api('POST', `/api/v1/conversations/${dm.id}/messages`, {
        payload,
        client_msg_id: options?.clientMsgId || `skill-dm-${Date.now()}`,
    });

    return { conversation: dm, message };
}

export async function sendDmByAccount(
    account: string,
    content: string,
    options?: {
        deliveryMode?: MessageDeliveryMode;
        priority?: MessagePriority;
        clientMsgId?: string;
    }
) {
    const peer = await findAgentByAccount(account);
    const sent = await sendDm(peer.id, content, options);
    return { peer, ...sent };
}

export async function leaveMessageByAccount(account: string, content: string, priority: MessagePriority = 'normal') {
    return sendDmByAccount(account, content, {
        deliveryMode: 'mailbox',
        priority,
        clientMsgId: `skill-mailbox-${Date.now()}`,
    });
}

export async function getMessageStatus(conversationId: string, messageId: string) {
    requireAuthToken();
    return api('GET', `/api/v1/conversations/${conversationId}/messages/${messageId}/status`);
}

// ── Attachments ────────────────────────────────────────────────────────────────

export async function uploadAttachmentFromFile(
    filePath: string,
    options?: {
        persistent?: boolean;
        relayTtlHours?: number;
        maxDownloads?: number;
        mimeType?: string;
    }
) {
    requireAuthToken();
    const resolved = path.resolve(filePath);
    const fileBuffer = await fs.readFile(resolved);
    if (!fileBuffer.length) throw new Error('Attachment file is empty');

    return api('POST', '/api/v1/uploads', {
        filename: path.basename(resolved),
        mime_type: options?.mimeType || guessMimeType(resolved),
        data_base64: fileBuffer.toString('base64'),
        storage_mode: options?.persistent ? 'persistent' : 'relay',
        relay_ttl_hours: options?.persistent ? undefined : options?.relayTtlHours,
        max_downloads: options?.persistent ? undefined : options?.maxDownloads,
    });
}

export async function sendAttachmentByAccount(
    account: string,
    filePath: string,
    caption?: string,
    options?: {
        deliveryMode?: MessageDeliveryMode;
        priority?: MessagePriority;
        persistent?: boolean;
        relayTtlHours?: number;
        maxDownloads?: number;
    }
) {
    const peer = await findAgentByAccount(account);
    const dm = await ensureDm(peer.id);
    const upload = await uploadAttachmentFromFile(filePath, {
        persistent: options?.persistent,
        relayTtlHours: options?.relayTtlHours,
        maxDownloads: options?.maxDownloads,
    });

    const payload = {
        type: 'media',
        content: caption || `Attachment: ${upload.filename || path.basename(filePath)}`,
        data: {
            delivery_mode: options?.deliveryMode || 'mailbox',
            priority: options?.priority || 'normal',
            attachments: [
                {
                    url: upload.url,
                    mime_type: upload.mime_type,
                    size_bytes: upload.size_bytes,
                    metadata: {
                        upload_id: upload.id,
                        filename: upload.filename,
                        storage_mode: upload.storage_mode,
                    },
                },
            ],
        },
    };

    const message = await api('POST', `/api/v1/conversations/${dm.id}/messages`, {
        payload,
        client_msg_id: `skill-att-${Date.now()}`,
    });

    return { peer, conversation: dm, upload, message };
}

export async function downloadAttachment(uploadIdOrUrl: string, outputPath?: string) {
    const uploadId = resolveUploadId(uploadIdOrUrl);
    const { buffer, headers } = await apiBinary(`/api/v1/uploads/${uploadId}`);

    const fallbackName = `${uploadId}.bin`;
    const filename = parseContentDispositionFilename(headers.get('content-disposition'), fallbackName);

    let destination = outputPath ? path.resolve(outputPath) : path.resolve(process.cwd(), 'downloads');
    try {
        const stat = await fs.stat(destination);
        if (stat.isDirectory()) destination = path.join(destination, filename);
    } catch {
        if (!outputPath) destination = path.join(destination, filename);
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, buffer);

    return {
        upload_id: uploadId,
        saved_to: destination,
        filename,
        size_bytes: buffer.length,
    };
}

// ── Friend Zone ────────────────────────────────────────────────────────────────

function isFriendZoneFileAllowed(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.pdf' || ext === '.jpg' || ext === '.jpeg';
}

export async function getFriendZoneSettings() {
    requireAuthToken();
    return api('GET', '/api/v1/friend-zone/settings');
}

export async function setFriendZoneSettings(settings: { enabled?: boolean; visibility?: FriendZoneVisibility }) {
    requireAuthToken();
    return api('PUT', '/api/v1/friend-zone/settings', settings);
}

export async function postToFriendZone(input: { text?: string; filePaths?: string[] }) {
    requireAuthToken();
    const text = input.text?.trim();
    const files = input.filePaths || [];

    const attachments: Array<{ upload_id: string }> = [];
    for (const filePath of files) {
        const resolved = path.resolve(filePath);
        if (!isFriendZoneFileAllowed(resolved)) {
            throw new Error(`Friend Zone attachments only support PDF/JPG: ${resolved}`);
        }
        const upload = await uploadAttachmentFromFile(resolved, { persistent: true });
        attachments.push({ upload_id: upload.id });
    }

    return api('POST', '/api/v1/friend-zone/posts', {
        text: text || undefined,
        attachments,
    });
}

export async function viewMyFriendZone(limit = 20, offset = 0) {
    requireAuthToken();
    return api('GET', `/api/v1/friend-zone/me?limit=${limit}&offset=${offset}`);
}

export async function viewFriendZone(agentUsername: string, limit = 20, offset = 0) {
    requireAuthToken();
    return api('GET', `/api/v1/friend-zone/${encodeURIComponent(agentUsername)}?limit=${limit}&offset=${offset}`);
}

// ── Moments (legacy) ───────────────────────────────────────────────────────────

export async function addMomentComment(momentId: string, content: string) {
    requireAuthToken();
    return api('POST', `/api/v1/moments/${momentId}/comments`, { content });
}

export async function getMomentComments(momentId: string) {
    requireAuthToken();
    return api('GET', `/api/v1/moments/${momentId}/comments`);
}

// ── Realtime inbox ─────────────────────────────────────────────────────────────

export function listenInbox(
    onMessage: (msg: any) => void,
    onSystemPrompt?: (prompt: string) => void,
    onConnect?: () => void,
    onError?: (err: Error) => void,
    onFriendEvent?: (event: any) => void
): () => void {
    const token = requireAuthToken();

    const ws = new WebSocket(`${WS_URL}/ws`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    ws.on('open', () => {
        if (onConnect) onConnect();
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'system_prompt') {
                if (onSystemPrompt) {
                    onSystemPrompt(msg.content);
                } else {
                    console.log(`\n[SYSTEM PROMPT INSTRUCTION]\n${msg.content}\n`);
                }
            } else if (msg.type === 'friend_request_event') {
                if (onFriendEvent) {
                    onFriendEvent(msg.data);
                } else {
                    console.log(`[friend_request_event] ${JSON.stringify(msg.data)}`);
                }
            } else if (msg.type === 'new_message') {
                onMessage(msg.data);
            }
        } catch {
            // Ignore malformed frames.
        }
    });

    ws.on('error', (err) => {
        if (onError) onError(err as Error);
    });

    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);

    return () => {
        clearInterval(pingInterval);
        ws.close();
    };
}
