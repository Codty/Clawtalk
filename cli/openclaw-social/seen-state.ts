import { MAX_SEEN_IDS, WATCH_NOTIFY_RETRY_BASE_MS } from './constants.js';
import type {
    FriendRequestStatus,
    LocalState,
    MailboxItem,
    NotificationRetryItem,
    RealtimeMessageEvent,
    SeenState,
} from './types.js';

export function ensureSeenState(state: LocalState, agentName: string): SeenState {
    if (!state.seen[agentName]) {
        state.seen[agentName] = {
            friend_request_ids: [],
            message_ids: [],
            outgoing_request_status: {},
            outgoing_request_order: [],
            mailbox_pending: {},
            mailbox_pending_order: [],
            mailbox_first_pending_at: undefined,
            mailbox_last_notified_at: undefined,
            mailbox_last_threshold_bucket: 0,
            notification_acks: {},
            notification_ack_order: [],
            notification_retry_queue: [],
        };
    }

    if (!state.seen[agentName].outgoing_request_status) {
        state.seen[agentName].outgoing_request_status = {};
    }
    if (!state.seen[agentName].outgoing_request_order) {
        state.seen[agentName].outgoing_request_order = [];
    }
    if (!state.seen[agentName].mailbox_pending) {
        state.seen[agentName].mailbox_pending = {};
    }
    if (!state.seen[agentName].mailbox_pending_order) {
        state.seen[agentName].mailbox_pending_order = [];
    }
    if (typeof state.seen[agentName].mailbox_last_threshold_bucket !== 'number') {
        state.seen[agentName].mailbox_last_threshold_bucket = 0;
    }
    if (!state.seen[agentName].notification_acks) {
        state.seen[agentName].notification_acks = {};
    }
    if (!state.seen[agentName].notification_ack_order) {
        state.seen[agentName].notification_ack_order = [];
    }
    if (!state.seen[agentName].notification_retry_queue) {
        state.seen[agentName].notification_retry_queue = [];
    }

    return state.seen[agentName];
}

export function addSeenId(ids: string[], id: string): void {
    if (!id) return;
    if (ids.includes(id)) return;
    ids.push(id);
    while (ids.length > MAX_SEEN_IDS) {
        ids.shift();
    }
}

export function rememberOutgoingStatus(seen: SeenState, requestId: string, status: FriendRequestStatus): void {
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

export function rememberMailboxPending(seen: SeenState, item: MailboxItem): void {
    const hadPending = seen.mailbox_pending_order.length > 0;
    if (!seen.mailbox_pending[item.message_id]) {
        seen.mailbox_pending_order.push(item.message_id);
    }
    seen.mailbox_pending[item.message_id] = item;
    if (!hadPending) {
        seen.mailbox_first_pending_at = item.created_at || new Date().toISOString();
    }

    while (seen.mailbox_pending_order.length > MAX_SEEN_IDS) {
        const oldest = seen.mailbox_pending_order.shift();
        if (oldest) {
            delete seen.mailbox_pending[oldest];
        }
    }

    if (!seen.mailbox_first_pending_at && seen.mailbox_pending_order.length > 0) {
        const oldest = seen.mailbox_pending[seen.mailbox_pending_order[0]];
        seen.mailbox_first_pending_at = oldest?.created_at || new Date().toISOString();
    }
}

export function removeMailboxPending(seen: SeenState, ids: string[]): number {
    let removed = 0;
    for (const id of ids) {
        if (seen.mailbox_pending[id]) {
            delete seen.mailbox_pending[id];
            removed += 1;
        }
    }
    if (removed > 0) {
        const idSet = new Set(ids);
        seen.mailbox_pending_order = seen.mailbox_pending_order.filter((id) => !idSet.has(id));
        if (seen.mailbox_pending_order.length === 0) {
            // Queue drained: reset reminder cadence.
            seen.mailbox_first_pending_at = undefined;
            seen.mailbox_last_notified_at = undefined;
            seen.mailbox_last_threshold_bucket = 0;
        }
    }
    return removed;
}

export function listMailboxPending(seen: SeenState): MailboxItem[] {
    return seen.mailbox_pending_order
        .map((id) => seen.mailbox_pending[id])
        .filter((item): item is MailboxItem => !!item);
}

export function isNotificationAcked(seen: SeenState, key: string): boolean {
    return !!seen.notification_acks[key];
}

export function markNotificationAck(
    seen: SeenState,
    key: string,
    type: 'new_message',
    attempts: number
): void {
    if (!seen.notification_acks[key]) {
        seen.notification_ack_order.push(key);
    }
    seen.notification_acks[key] = {
        key,
        type,
        attempts,
        acked_at: new Date().toISOString(),
    };

    while (seen.notification_ack_order.length > MAX_SEEN_IDS) {
        const oldest = seen.notification_ack_order.shift();
        if (oldest) {
            delete seen.notification_acks[oldest];
        }
    }
}

export function removeNotificationRetry(seen: SeenState, key: string): void {
    const index = seen.notification_retry_queue.findIndex((item) => item.key === key);
    if (index >= 0) {
        seen.notification_retry_queue.splice(index, 1);
    }
}

export function getNotificationRetry(seen: SeenState, key: string): NotificationRetryItem | undefined {
    return seen.notification_retry_queue.find((item) => item.key === key);
}

export function computeRetryDelayMs(attempts: number): number {
    // Exponential backoff with a 2-minute cap.
    const raw = WATCH_NOTIFY_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempts - 1));
    return Math.min(raw, 120000);
}

export function upsertNotificationRetry(
    seen: SeenState,
    next: Omit<NotificationRetryItem, 'next_retry_at'> & { next_retry_at?: string }
): NotificationRetryItem {
    const item: NotificationRetryItem = {
        ...next,
        next_retry_at: next.next_retry_at || new Date(Date.now() + computeRetryDelayMs(next.attempts)).toISOString(),
    };

    const index = seen.notification_retry_queue.findIndex((existing) => existing.key === item.key);
    if (index >= 0) {
        seen.notification_retry_queue[index] = item;
    } else {
        seen.notification_retry_queue.push(item);
    }
    return item;
}

export function buildMessageDeliveryKey(event: RealtimeMessageEvent): string {
    if (event.id) return `msg:${event.id}`;
    const fallback = [
        event.conversation_id || 'unknown-conversation',
        event.sender_id || 'unknown-sender',
        event.created_at || '',
        event.payload?.type || 'text',
        event.payload?.content || event.content || '',
    ].join('|');
    return `msg-fallback:${Buffer.from(fallback).toString('base64url').slice(0, 64)}`;
}
