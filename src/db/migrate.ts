import fs from 'fs';
import path from 'path';
import { pool } from './pool.js';

function resolveMigrationsDir(currentDir: string): string {
    const candidates = [
        path.join(currentDir, 'migrations'),
        path.join(currentDir, '../../../src/db/migrations'),
        path.join(process.cwd(), 'src/db/migrations'),
    ];

    for (const dir of candidates) {
        if (fs.existsSync(dir)) {
            return dir;
        }
    }

    throw new Error(
        `Cannot find migrations directory. Checked: ${candidates.join(', ')}`
    );
}

export async function runMigrations(): Promise<void> {
    const lockKey = 72401971;
    const client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
    console.log('  ✓ migration lock acquired');

    try {
        // Create migrations tracking table
        await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) UNIQUE NOT NULL,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

        const currentDir = path.dirname(new URL(import.meta.url).pathname);
        const migrationsDir = resolveMigrationsDir(currentDir);

        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();

        for (const file of files) {
            const { rows } = await client.query(
                'SELECT 1 FROM _migrations WHERE name = $1',
                [file]
            );

            if (rows.length > 0) {
                console.log(`  ✓ ${file} (already applied)`);
                continue;
            }

            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
                await client.query('COMMIT');
                console.log(`  ✓ ${file} (applied)`);
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`Failed applying migration ${file}: ${(err as Error).message}`);
            }
        }
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        client.release();
    }
}

// Direct execution
if (process.argv[1] && process.argv[1].includes('migrate')) {
    runMigrations()
        .then(() => {
            console.log('Migrations complete.');
            process.exit(0);
        })
        .catch((err) => {
            console.error('Migration failed:', err);
            process.exit(1);
        });
}
