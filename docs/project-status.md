# AgentSocial 项目接力状态（2026-03-12）

## 1) 这个项目是做什么的

AgentSocial 是一个 **Agent-only 即时通讯后端平台**（Fastify + PostgreSQL + Redis），面向 AI Agent 的社交与协作场景。

核心能力：
- 认证与登录：注册、登录、JWT、WS 短期 token。
- 会话与消息：1v1 DM、群聊、文本/工具调用/事件/media 消息、已读、撤回、删除。
- 社交关系：发现、好友申请、接受/拒绝/取消、删除好友。
- 实时推送：WebSocket + Redis fanout。
- 管理能力：封禁/解封、审计日志、风险白名单。
- 运维能力：健康检查、metrics、备份脚本、发布前检查清单。

## 2) 当前进度（已完成）

当前代码状态已经到达 **可候选发布（release candidate）**，但还差测试闭环与最终 smoke 验证。

已完成的关键项：
- P0 工程稳定性
  - 优雅停机与资源释放（HTTP/Redis/PG/TTL/Fanout）。
  - 递归审计脱敏（避免敏感字段进入审计日志）。
  - 好友删除接口：`DELETE /api/v1/friends/:friendId`。
- 管理员可用性
  - 首个管理员引导接口：`POST /api/v1/admin/bootstrap`（基于 `ADMIN_BOOTSTRAP_TOKEN` 一次性初始化）。
- 多实例 fanout 闭环
  - 支持 `FANOUT_MODE=pubsub`（默认，适合多实例）与 `FANOUT_MODE=single_stream`（单实例）。
  - 发布链路已接入 pubsub 频道，并附带 `event_id` 做 WS 去重。
  - 环境变量与 docker-compose 已补齐 fanout 相关配置。
- 文档与交付资产
  - OpenAPI：`docs/openapi.yaml`（已扩展）。
  - Postman：`docs/postman/`（含 setup flow）。
  - 发布清单：`docs/release-checklist.md`。
  - 运维脚本：`scripts/preflight.sh`、`scripts/backup.sh`、`scripts/run-local-tests.sh`。
- 编译状态
  - `npm run build` 已通过（本轮最新代码已验证）。

## 3) 还差什么才能“完整完成”

## P0（发布前必须完成）

1. 本机跑通集成测试闭环
   - 命令：`npm run test:local`
   - 备注：之前在受限沙箱里无法访问本机 PG/Redis（`EPERM 127.0.0.1:15432`），所以这一步需要你本机环境执行。
2. 完成一次手工 smoke（按真实业务链路）
   - 注册/登录/发现/加好友/DM/群聊/消息生命周期/管理员操作。
3. 生产配置确认
   - `FANOUT_MODE=pubsub`
   - `RUN_MIGRATIONS_ON_START=false`
   - 强 `JWT_SECRET`
   - 生产关闭 `CORS_ALLOW_ALL`
4. 如已使用首管引导
   - 清空或轮转 `ADMIN_BOOTSTRAP_TOKEN`。

## P1（建议首个稳定版补齐）

1. 增加关键集成用例
   - 首管 bootstrap 成功/失败路径。
   - 多实例 fanout 行为（至少覆盖 pubsub 路径）。
2. 做一次故障演练
   - 重启 Redis 与应用实例，验证 WS 恢复和消息一致性（DB 仍为最终真相）。
3. 压测与限流验证
   - 针对发送消息、登录、WS 建连进行阈值验证。

## 4) 下次接着做（建议顺序）

1. `docker compose up -d postgres redis`
2. `npm run build`
3. `npm run test:local`
4. 按 `docs/release-checklist.md` 完整走一遍 P0
5. 若全部通过，再决定 release

## 5) 当前发布判断

- 结论：**暂不建议直接发布**。
- 原因：代码层 P0 已基本闭环，但测试与最终环境 smoke 尚未完成签收。
