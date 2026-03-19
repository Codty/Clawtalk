import type { NotifyPreference, SeenState } from './types.js';

export interface MailboxReminderWindow {
    thresholdStep: number;
    intervalHours: number;
    intervalMs: number;
}

function asValidTimestamp(value?: string): number | null {
    if (!value) return null;
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
}

export function shouldNotifyFriendRequest(pref: NotifyPreference): boolean {
    return pref.friend_request_enabled === true;
}

export function shouldNotifyFriendRequestStatus(pref: NotifyPreference): boolean {
    return pref.friend_request_status_enabled === true;
}

export function shouldNotifyRealtimeDm(pref: NotifyPreference): boolean {
    return pref.dm_realtime_enabled === true;
}

export function shouldNotifyMailboxReminder(pref: NotifyPreference): boolean {
    return pref.mailbox_reminder_enabled === true;
}

export function getMailboxReminderWindow(pref: NotifyPreference): MailboxReminderWindow {
    const thresholdStep = Math.max(1, Math.floor(pref.mailbox_reminder_pending_step));
    const intervalHours = Math.max(1, Math.floor(pref.mailbox_reminder_interval_hours));
    return {
        thresholdStep,
        intervalHours,
        intervalMs: intervalHours * 60 * 60 * 1000,
    };
}

export function nextMailboxReminderReason(
    seen: SeenState,
    pendingCount: number,
    nowTs: number,
    pref: NotifyPreference
): 'interval' | 'threshold' | null {
    if (!shouldNotifyMailboxReminder(pref)) return null;
    if (pendingCount <= 0) {
        seen.mailbox_last_threshold_bucket = 0;
        return null;
    }

    const window = getMailboxReminderWindow(pref);
    const currentBucket = Math.floor(pendingCount / window.thresholdStep);
    const lastBucket = Math.max(0, seen.mailbox_last_threshold_bucket || 0);
    if (currentBucket < lastBucket) {
        seen.mailbox_last_threshold_bucket = currentBucket;
    }

    if (pendingCount >= window.thresholdStep) {
        const refreshedLastBucket = Math.max(0, seen.mailbox_last_threshold_bucket || 0);
        if (currentBucket > refreshedLastBucket) {
            return 'threshold';
        }
    }

    const lastNotifiedTs = asValidTimestamp(seen.mailbox_last_notified_at);
    if (lastNotifiedTs !== null) {
        if (nowTs - lastNotifiedTs >= window.intervalMs) {
            return 'interval';
        }
        return null;
    }

    const firstPendingTs = asValidTimestamp(seen.mailbox_first_pending_at);
    if (firstPendingTs !== null && nowTs - firstPendingTs >= window.intervalMs) {
        return 'interval';
    }
    return null;
}

