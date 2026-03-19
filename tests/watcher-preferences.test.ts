import { describe, expect, it } from 'vitest';
import type { NotifyPreference, SeenState } from '../cli/openclaw-social/types.js';
import {
    getMailboxReminderWindow,
    nextMailboxReminderReason,
    shouldNotifyFriendRequest,
    shouldNotifyFriendRequestStatus,
    shouldNotifyMailboxReminder,
    shouldNotifyRealtimeDm,
} from '../cli/openclaw-social/watcher-preferences.js';

function makeSeen(): SeenState {
    return {
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

function makePref(patch?: Partial<NotifyPreference>): NotifyPreference {
    return {
        friend_request_enabled: true,
        friend_request_status_enabled: true,
        dm_realtime_enabled: true,
        mailbox_reminder_enabled: true,
        mailbox_reminder_interval_hours: 12,
        mailbox_reminder_pending_step: 50,
        ...patch,
    };
}

describe('watcher notify preferences', () => {
    it('should respect boolean toggles for friend/status/realtime/mailbox', () => {
        const enabled = makePref();
        expect(shouldNotifyFriendRequest(enabled)).toBe(true);
        expect(shouldNotifyFriendRequestStatus(enabled)).toBe(true);
        expect(shouldNotifyRealtimeDm(enabled)).toBe(true);
        expect(shouldNotifyMailboxReminder(enabled)).toBe(true);

        const disabled = makePref({
            friend_request_enabled: false,
            friend_request_status_enabled: false,
            dm_realtime_enabled: false,
            mailbox_reminder_enabled: false,
        });
        expect(shouldNotifyFriendRequest(disabled)).toBe(false);
        expect(shouldNotifyFriendRequestStatus(disabled)).toBe(false);
        expect(shouldNotifyRealtimeDm(disabled)).toBe(false);
        expect(shouldNotifyMailboxReminder(disabled)).toBe(false);
    });

    it('should compute reminder window from notify preference', () => {
        const window = getMailboxReminderWindow(
            makePref({ mailbox_reminder_interval_hours: 6, mailbox_reminder_pending_step: 20 })
        );
        expect(window.intervalHours).toBe(6);
        expect(window.thresholdStep).toBe(20);
        expect(window.intervalMs).toBe(6 * 60 * 60 * 1000);
    });

    it('should trigger threshold reminders by mailbox bucket growth', () => {
        const seen = makeSeen();
        const pref = makePref({ mailbox_reminder_pending_step: 50 });
        const now = Date.now();

        expect(nextMailboxReminderReason(seen, 49, now, pref)).toBe(null);
        expect(nextMailboxReminderReason(seen, 50, now, pref)).toBe('threshold');

        // Simulate "threshold notified" state persisted by watcher.
        seen.mailbox_last_threshold_bucket = 1;
        expect(nextMailboxReminderReason(seen, 99, now, pref)).toBe(null);
        expect(nextMailboxReminderReason(seen, 100, now, pref)).toBe('threshold');

        seen.mailbox_last_threshold_bucket = 2;
        expect(nextMailboxReminderReason(seen, 0, now, pref)).toBe(null);
        expect(seen.mailbox_last_threshold_bucket).toBe(0);
    });

    it('should trigger interval reminders based on first pending and last notified timestamps', () => {
        const pref = makePref({ mailbox_reminder_interval_hours: 12, mailbox_reminder_pending_step: 50 });
        const seen = makeSeen();
        const now = Date.now();

        seen.mailbox_first_pending_at = new Date(now - 13 * 60 * 60 * 1000).toISOString();
        expect(nextMailboxReminderReason(seen, 1, now, pref)).toBe('interval');

        seen.mailbox_first_pending_at = new Date(now - 2 * 60 * 60 * 1000).toISOString();
        seen.mailbox_last_notified_at = new Date(now - 13 * 60 * 60 * 1000).toISOString();
        expect(nextMailboxReminderReason(seen, 2, now, pref)).toBe('interval');

        seen.mailbox_last_notified_at = new Date(now - 30 * 60 * 1000).toISOString();
        expect(nextMailboxReminderReason(seen, 2, now, pref)).toBe(null);
    });

    it('should not trigger reminders when mailbox reminder is disabled', () => {
        const seen = makeSeen();
        const pref = makePref({
            mailbox_reminder_enabled: false,
            mailbox_reminder_interval_hours: 1,
            mailbox_reminder_pending_step: 1,
        });
        const now = Date.now();
        seen.mailbox_first_pending_at = new Date(now - 2 * 60 * 60 * 1000).toISOString();
        expect(nextMailboxReminderReason(seen, 100, now, pref)).toBe(null);
    });
});

