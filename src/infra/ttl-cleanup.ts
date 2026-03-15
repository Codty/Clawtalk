import cron from 'node-cron';
import { pool } from '../db/pool.js';
import { redis } from './redis.js';
import { config } from '../config.js';
import { purgeExpiredRelayUploads } from '../modules/upload/upload.service.js';

export interface TtlCleanupHandle {
    stop: () => void;
}

export function startTtlCleanup(): TtlCleanupHandle {
    // Run every hour
    const task = cron.schedule('0 * * * *', async () => {
        console.log('[TTL] Running message cleanup...');
        try {
            // 1. Delete messages from conversations with custom retention_days
            const { rows: convPolicies } = await pool.query(
                `SELECT id, policy_json->>'retention_days' AS retention_days
         FROM conversations
         WHERE policy_json->>'retention_days' IS NOT NULL
           AND (policy_json->>'retention_days')::int != $1`,
                [config.messageTtlDays]
            );

            let customDeleted = 0;
            for (const conv of convPolicies) {
                const days = parseInt(conv.retention_days, 10);
                if (isNaN(days) || days < 1) continue;
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - days);
                const result = await pool.query(
                    'DELETE FROM messages WHERE conversation_id = $1 AND created_at < $2',
                    [conv.id, cutoff.toISOString()]
                );
                customDeleted += result.rowCount || 0;
            }

            if (customDeleted > 0) {
                console.log(`[TTL] Deleted ${customDeleted} messages via custom retention policies`);
            }

            // 2. Delete remaining messages using global TTL
            //    (only those from conversations without a custom retention_days)
            const globalCutoff = new Date();
            globalCutoff.setDate(globalCutoff.getDate() - config.messageTtlDays);

            const result = await pool.query(
                `DELETE FROM messages m
         WHERE m.created_at < $1
           AND NOT EXISTS (
             SELECT 1 FROM conversations c
             WHERE c.id = m.conversation_id
               AND c.policy_json->>'retention_days' IS NOT NULL
           )`,
                [globalCutoff.toISOString()]
            );

            console.log(`[TTL] Deleted ${result.rowCount} messages via global retention (${config.messageTtlDays}d)`);

            // 3. Trim Redis Streams with SCAN to avoid blocking Redis.
            let streamCount = 0;
            let cursor = '0';
            do {
                const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'stream:conv:*', 'COUNT', 200);
                cursor = nextCursor;
                for (const key of keys) {
                    try {
                        await redis.xtrim(key, 'MINID', `${globalCutoff.getTime()}-0`);
                        streamCount += 1;
                    } catch {
                        // Stream may disappear between SCAN and XTRIM.
                    }
                }
            } while (cursor !== '0');

            console.log(`[TTL] Trimmed ${streamCount} Redis streams`);

            // 4. Purge expired relay uploads (local-first attachment temp relay).
            const relayPurged = await purgeExpiredRelayUploads(1000);
            if (relayPurged > 0) {
                console.log(`[TTL] Purged ${relayPurged} expired relay uploads`);
            }
        } catch (err) {
            console.error('[TTL] Cleanup error:', err);
        }
    });

    console.log('[TTL] Cleanup cron scheduled (hourly)');
    return {
        stop: () => {
            try {
                task.stop();
            } catch {
                // no-op
            }
        },
    };
}
