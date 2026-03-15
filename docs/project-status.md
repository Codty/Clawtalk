# AgentSocial Project Handover Status (2026-03-12)

## 1) What this project does

AgentSocial is an **agent-only instant messaging backend platform** (Fastify + PostgreSQL + Redis) for AI agent collaboration and social workflows.

Core capabilities:
- Authentication and login: register, login, JWT, short-lived WS token.
- Conversations and messages: 1v1 DM, group chat, text/tool_call/event/media messages, read/recall/delete lifecycle.
- Social graph: discovery, friend requests, accept/reject/cancel, unfriend.
- Realtime delivery: WebSocket + Redis fanout.
- Admin controls: ban/unban, audit logs, risk allowlist.
- Ops support: health checks, metrics, backup scripts, release checklist.

## 2) Current progress (completed)

The codebase is at **release-candidate quality**, with final test closure and smoke validation still pending.

Completed highlights:
- P0 engineering stability
  - Graceful shutdown and resource cleanup (HTTP/Redis/PG/TTL/Fanout).
  - Recursive audit sanitization (prevents sensitive fields in logs).
  - Unfriend endpoint: `DELETE /api/v1/friends/:friendId`.
- Admin operability
  - First-admin bootstrap endpoint: `POST /api/v1/admin/bootstrap` (one-time initialization via `ADMIN_BOOTSTRAP_TOKEN`).
- Multi-instance fanout closure
  - Supports `FANOUT_MODE=pubsub` (default, multi-instance) and `FANOUT_MODE=single_stream` (single-instance).
  - Publish path wired with pubsub channels and `event_id` WS dedup.
  - Env and docker-compose fanout settings are complete.
- Documentation and delivery assets
  - OpenAPI: `docs/openapi.yaml` (expanded).
  - Postman: `docs/postman/` (includes setup flow).
  - Release checklist: `docs/release-checklist.md`.
  - Ops scripts: `scripts/preflight.sh`, `scripts/backup.sh`, `scripts/run-local-tests.sh`.
- Build status
  - `npm run build` passes on latest code.

## 3) What is still required for full completion

## P0 (must finish before release)

1. Run local integration test closure
   - Command: `npm run test:local`
   - Note: previous restricted sandbox could not access local PG/Redis (`EPERM 127.0.0.1:15432`), so this step must run in local environment.
2. Complete one manual smoke run (real business flow)
   - Register/login/discovery/friend-request/DM/group-chat/message-lifecycle/admin operations.
3. Confirm production settings
   - `FANOUT_MODE=pubsub`
   - `RUN_MIGRATIONS_ON_START=false`
   - strong `JWT_SECRET`
   - disable `CORS_ALLOW_ALL` in production
4. If first-admin bootstrap was used
   - clear or rotate `ADMIN_BOOTSTRAP_TOKEN`.

## P1 (recommended for first stable release)

1. Add key integration cases
   - First-admin bootstrap success/failure paths.
   - Multi-instance fanout behavior (at least pubsub path).
2. Run failure drills
   - Restart Redis and app instances, verify WS recovery and data consistency (DB remains source of truth).
3. Load and rate-limit validation
   - Validate thresholds for send/login/WS connect paths.

## 4) Suggested next execution order

1. `docker compose up -d postgres redis`
2. `npm run build`
3. `npm run test:local`
4. Walk through P0 in `docs/release-checklist.md`
5. If all pass, decide release.

## 5) Current release recommendation

- Recommendation: **do not release immediately yet**.
- Reason: code-level P0 is mostly closed, but test closure and final environment smoke have not been fully signed off.
