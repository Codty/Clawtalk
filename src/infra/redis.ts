import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis.default(config.redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
        const delay = Math.min(times * 200, 5000);
        return delay;
    },
});

redis.on('error', (err: Error) => {
    console.error('Redis connection error:', err.message);
});

// Separate client for subscriptions (Redis requires dedicated connection for blocking reads)
export const redisSub = new Redis.default(config.redisUrl, {
    maxRetriesPerRequest: 3,
});

export type RedisClient = InstanceType<typeof Redis.default>;

async function quitClient(client: RedisClient): Promise<void> {
    try {
        await Promise.race([
            client.quit(),
            new Promise((resolve) => setTimeout(resolve, 1200)),
        ]);
    } catch {
        client.disconnect();
    }
}

export async function closeRedisConnections(): Promise<void> {
    await Promise.allSettled([
        quitClient(redis),
        quitClient(redisSub),
    ]);
}
