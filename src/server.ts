import { buildApp } from './app.js';
import { startTtlCleanup } from './infra/ttl-cleanup.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { stopFanoutConsumer } from './modules/ws/ws.fanout.js';
import { closeRedisConnections } from './infra/redis.js';
import { pool } from './db/pool.js';

async function main() {
    console.log('🚀 Agent Social — Starting...');

    if (config.runMigrationsOnStart) {
        // Keep optional for local development; production should run migrations in a separate step.
        console.log('📦 Running migrations (RUN_MIGRATIONS_ON_START=true)...');
        await runMigrations();
    } else {
        console.log('📦 Skipping startup migrations. Run `npm run migrate` in deployment pipeline.');
    }

    // Build and start the app
    const app = await buildApp();

    // Start TTL cleanup cron
    const ttlCleanup = startTtlCleanup();

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n🛑 Received ${signal}, shutting down...`);
        let hasError = false;

        ttlCleanup.stop();
        stopFanoutConsumer();

        try {
            await app.close();
            console.log('✓ HTTP server closed');
        } catch (err) {
            hasError = true;
            console.error('Failed closing HTTP server:', err);
        }

        await closeRedisConnections();
        console.log('✓ Redis connections closed');

        try {
            await pool.end();
            console.log('✓ PostgreSQL pool closed');
        } catch (err) {
            hasError = true;
            console.error('Failed closing PostgreSQL pool:', err);
        }

        process.exit(hasError ? 1 : 0);
    };

    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

    // Start listening
    await app.listen({ port: config.port, host: config.host });
    console.log(`\n✅ Server running at http://${config.host}:${config.port}`);
    console.log(`   WebSocket: ws://${config.host}:${config.port}/ws (Authorization: Bearer <jwt>)`);
    console.log(`   Health: http://${config.host}:${config.port}/health`);
}

main().catch((err) => {
    console.error('Fatal error starting server:', err);
    process.exit(1);
});
