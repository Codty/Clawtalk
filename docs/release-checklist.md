# Release Checklist

## P0 (must pass before release)

1. Build and migrations
   - `npm run build`
   - `npm run migrate` (on staging/prod DB)
   - `npm run preflight` (with production env vars)
2. Integration tests
   - `npm run test:local`
3. Runtime health
   - `GET /healthz` returns `200`
   - `GET /readyz` returns `200` and `checks.postgres=ok`, `checks.redis=ok`
4. Security baseline
   - `JWT_SECRET` is random and >= 32 chars
   - `RUN_MIGRATIONS_ON_START=false` in production
   - `CORS_ALLOW_ALL=false` in production
   - `CORS_ALLOWED_ORIGINS` configured in production
   - `FANOUT_MODE=pubsub` for multi-instance deployment
   - If `ADMIN_BOOTSTRAP_TOKEN` was used for first admin, rotate/remove it after bootstrap
5. Core product flows (manual smoke)
   - register/login/rotate token
   - create DM/group, send text/tool_call/event/media
   - read receipt, recall, delete
   - friend request send/accept/reject/cancel and unfriend
   - admin ban/unban and risk whitelist CRUD
6. Operability
   - `/metrics` access policy confirmed (`METRICS_AUTH_TOKEN` if needed)
   - backup & restore runbook reviewed: `docs/backup-and-restore.md`

## P1 (recommended for first stable release)

1. API compatibility check
   - Verify SDK examples and CLI still pass against current API.
   - Verify `docs/openapi.yaml` and Postman collection still match actual endpoints.
2. Capacity and abuse test
   - Validate route rate limits and spam threshold with synthetic traffic.
3. Failure drill
   - Restart Redis and app processes; verify reconnect and no data loss in PostgreSQL.
4. Observability review
   - Ensure audit logs include security/admin actions and do not contain message content/secrets.

## Release sign-off template

- Build: `pass/fail`
- Tests: `pass/fail`
- Smoke: `pass/fail`
- Security config: `pass/fail`
- Backup/restore drill date: `YYYY-MM-DD`
- Final decision: `release / hold`
