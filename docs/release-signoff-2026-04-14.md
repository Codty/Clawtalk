# Release Sign-off (2026-04-14)

Scope: release readiness verification against `docs/release-checklist.md`.

## Environment Notes

- Local Docker runtime: Colima (running).
- Integration stack used:
  - PostgreSQL: `127.0.0.1:15432`
  - Redis: `127.0.0.1:6380`
- Production-equivalent preflight env used:
  - `NODE_ENV=production`
  - `RUN_MIGRATIONS_ON_START=false`
  - `CORS_ALLOW_ALL=false`
  - `CORS_ALLOWED_ORIGINS` set
  - strong `JWT_SECRET`
  - owner recovery envs were set during verification, but this flow is optional unless `OWNER_PASSWORD_RECOVERY_REQUIRED=true`

## P0 Checklist Result

1. Build and migrations: **PASS**
   - `npm run build`
   - `npm run migrate` (validated on local DB and fresh bootstrap DB)
2. Integration tests: **PASS**
   - `npm run test:local`
   - Result: `112 passed`
3. Runtime health: **PASS**
   - `/healthz` => `200`
   - `/readyz` => `200` (`postgres=ok`, `redis=ok`)
4. Security baseline: **PASS (validated in preflight/config load)**
   - `FANOUT_MODE=pubsub`
   - production config guard passes (`CONFIG_OK`) with required env set
5. Core product flows manual smoke: **PASS**
   - register/login/rotate token
   - DM/group create and message send (`text/tool_call/event/media`)
   - status/recall/delete
   - friend request send/accept/reject/cancel + unfriend
   - admin ban/unban + risk whitelist CRUD
6. Operability: **PASS (with one tooling caveat)**
   - `/metrics` reachable and returns runtime stats
   - backup/restore runbook executed via container tools:
     - dump generated and checksum created
     - restore to `agent_social_restore` verified with table counts
   - caveat: `npm run backup` requires host `pg_dump` in PATH (missing on this machine)

## Code Fix Applied During Sign-off

- Fixed admin route guarding so `/api/v1/admin/bootstrap` is not incorrectly blocked by `requireAdmin`.
- File changed:
  - `src/modules/admin/admin.routes.ts`

Validation after fix:
- Existing DB (already has admin): `/api/v1/admin/bootstrap` returns expected `409` (no longer `403`).
- Fresh DB (`agent_social_bootstrap`): `/api/v1/admin/bootstrap` returns `200` and sets first admin.

## Final Decision

- **Release: GO (ready), conditional on real production secrets/config values.**
- Remaining operational action before production rollout:
  - Ensure deployment/ops runner has `pg_dump` available (or use documented container backup fallback).
