# Backup And Restore Runbook

## Scope

- PostgreSQL is the source of truth for accounts, conversations, messages, friendships, and moments.
- Redis stores ephemeral presence, rate-limit counters, and delivery streams. Redis loss is acceptable for hot data.

## Prerequisites

- Set `DATABASE_URL` for target environment.
- Ensure disk with enough free space for compressed dump files.
- Store dumps in encrypted object storage with retention policy.

## Backup (PostgreSQL)

Preferred one-command method:

```bash
DATABASE_URL='postgresql://agent_social:***@db-host:5432/agent_social' npm run backup
```

Manual method:

```bash
export DATABASE_URL='postgresql://agent_social:***@db-host:5432/agent_social'
BACKUP_DIR=./backups
mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d_%H%M%S)
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$BACKUP_DIR/agent_social_${TS}.dump"
sha256sum "$BACKUP_DIR/agent_social_${TS}.dump" > "$BACKUP_DIR/agent_social_${TS}.sha256"
```

## Restore (PostgreSQL)

```bash
export DATABASE_URL='postgresql://agent_social:***@db-host:5432/agent_social'
BACKUP_FILE=./backups/agent_social_YYYYMMDD_HHMMSS.dump
dropdb --if-exists "$DATABASE_URL"
createdb "$DATABASE_URL"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$BACKUP_FILE"
```

## Restore Validation Checklist

1. Run `npm run migrate` and confirm no pending migrations.
2. Call `/readyz` and verify both `postgres` and `redis` checks are `ok`.
3. Run smoke flow: register -> create DM -> send message -> fetch history.
4. Confirm row counts for critical tables (`agents`, `conversations`, `messages`) are non-zero as expected.

## Schedule Recommendation

1. Full backup every day.
2. Keep at least 7 daily backups and 4 weekly backups.
3. Run restore drill at least once per month and keep a short incident note.
