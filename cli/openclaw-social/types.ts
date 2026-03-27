export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';
export type DeliveryMode = 'receive_only' | 'manual_review' | 'auto_execute';
export type DeliveryStrategy = 'primary' | 'fanout' | 'fallback';
export type MessageDeliveryMode = 'mailbox' | 'realtime';
export type MessagePriority = 'low' | 'normal' | 'high';
export type ClaimStatus = 'pending_claim' | 'claimed';

export interface ClaimInfo {
    claim_status: ClaimStatus;
    verification_code?: string;
    claim_expires_at?: string | null;
    claim_url?: string;
    claimed_at?: string | null;
}

export interface AgentSession {
    agent_name: string;
    claw_id?: string;
    agent_id: string;
    token: string;
    claim?: ClaimInfo;
}

export interface OwnerSession {
    owner_id: string;
    email: string;
    token: string;
    session_id?: string;
    expires_at?: string | null;
}

export interface MailboxItem {
    message_id: string;
    conversation_id: string;
    from_agent_name: string;
    content: string;
    envelope_type: string;
    created_at: string;
    priority: MessagePriority;
}

export interface RealtimeMessageEvent {
    id?: string;
    conversation_id?: string;
    sender_id?: string;
    sender_name?: string;
    created_at?: string;
    payload?: {
        type?: string;
        content?: string;
        data?: any;
    };
    content?: string;
}

export interface NotificationAck {
    key: string;
    type: 'new_message';
    acked_at: string;
    attempts: number;
}

export interface NotificationRetryItem {
    key: string;
    type: 'new_message';
    event: RealtimeMessageEvent;
    sender_name: string;
    prompt: string;
    attempts: number;
    next_retry_at: string;
    created_at: string;
    last_error?: string;
}

export interface SeenState {
    friend_request_ids: string[];
    message_ids: string[];
    outgoing_request_status: Record<string, FriendRequestStatus>;
    outgoing_request_order: string[];
    mailbox_pending: Record<string, MailboxItem>;
    mailbox_pending_order: string[];
    mailbox_first_pending_at?: string;
    mailbox_last_notified_at?: string;
    mailbox_last_threshold_bucket?: number;
    notification_acks: Record<string, NotificationAck>;
    notification_ack_order: string[];
    notification_retry_queue: NotificationRetryItem[];
}

export interface AgentPolicy {
    mode: DeliveryMode;
}

export interface OpenClawBinding {
    openclaw_agent_id?: string;
    channel: string;
    account_id?: string;
    target?: string;
    auto_route: boolean;
    dry_run?: boolean;
}

export interface NotifyDestination {
    id: string;
    channel: string;
    account_id?: string;
    target?: string;
    auto_route: boolean;
    openclaw_agent_id?: string;
    dry_run?: boolean;
    enabled: boolean;
    priority: number;
    is_primary: boolean;
}

export interface NotifyPreference {
    friend_request_enabled: boolean;
    friend_request_status_enabled: boolean;
    dm_realtime_enabled: boolean;
    mailbox_reminder_enabled: boolean;
    mailbox_reminder_interval_hours: number;
    mailbox_reminder_pending_step: number;
}

export interface LocalState {
    current_owner?: string;
    owner_sessions: Record<string, OwnerSession>;
    current_agent?: string;
    sessions: Record<string, AgentSession>;
    seen: Record<string, SeenState>;
    bindings: Record<string, OpenClawBinding>;
    policies: Record<string, AgentPolicy>;
    notify_profiles: Record<string, NotifyDestination[]>;
    notify_prefs: Record<string, NotifyPreference>;
}

export interface CliConfig {
    base_url?: string;
}

export interface FriendRequestRow {
    id: string;
    from_agent_id: string;
    from_agent_name?: string;
    to_agent_id: string;
    to_agent_name?: string;
    status: FriendRequestStatus;
    created_at: string;
}

export interface FriendRow {
    id: string;
    agent_name: string;
    display_name?: string | null;
    friends_since?: string;
}

export interface ConversationRow {
    id: string;
    type?: string;
    name?: string | null;
    created_at?: string;
}

export interface AgentLite {
    id: string;
    agent_name: string;
    display_name?: string | null;
}

export interface AttachmentLite {
    url?: string;
    filename?: string;
    upload_id?: string;
    mime_type?: string;
    size_bytes?: number;
    local_path?: string;
}

export interface LocalConversationRecord {
    schema_version: 1;
    record_type: 'message';
    direction: 'incoming' | 'outgoing';
    message_id: string;
    conversation_id: string;
    agent_username: string;
    peer_agent_username?: string;
    envelope_type: string;
    delivery_mode?: MessageDeliveryMode;
    priority?: MessagePriority;
    content: string;
    attachments?: AttachmentLite[];
    sent_at: string;
    recorded_at: string;
}

export interface FriendRequestRealtimeEvent {
    event?: 'received' | 'status_changed';
    request_id?: string;
    from_agent_id?: string;
    to_agent_id?: string;
    request_message?: string | null;
    status?: FriendRequestStatus;
    responded_by?: string;
    responded_at?: string;
    created_at?: string;
}

export interface OpenClawNotifyRoute {
    channel: string;
    account_id: string;
    target: string;
    dry_run: boolean;
}

export interface OpenClawConfigBindingMatch {
    channel?: string;
    accountId?: string;
}

export interface OpenClawConfigBinding {
    agentId?: string;
    match?: OpenClawConfigBindingMatch;
}

export interface OpenClawConfig {
    bindings?: OpenClawConfigBinding[];
}

export interface SessionRouteCandidate {
    agentId: string;
    channel: string;
    accountId: string;
    target: string;
    updatedAt: number;
}

export interface DeliveryTarget {
    id: string;
    is_primary: boolean;
    priority: number;
    refresh_each_send?: boolean;
    cached_route?: OpenClawNotifyRoute;
    resolve: () => Promise<OpenClawNotifyRoute>;
}

export interface DaemonEntry {
    pid: number;
    agent_name: string;
    mode: 'watch' | 'bridge';
    started_at: string;
    cwd: string;
    log_file: string;
}

export interface DaemonRegistry {
    entries: Record<string, DaemonEntry>;
}

export interface WatchHooks {
    onFriendRequest?: (ctx: { request: FriendRequestRow; fromName: string; prompt: string }) => Promise<void>;
    onFriendRequestStatusChange?: (ctx: { request: FriendRequestRow; prompt: string }) => Promise<void>;
    onNewMessage?: (ctx: { event: RealtimeMessageEvent; senderName: string; prompt: string }) => Promise<void>;
    echoConsole?: boolean;
}
