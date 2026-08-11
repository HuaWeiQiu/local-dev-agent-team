# ADR 0016: 本地演进控制面

- Status: Accepted
- Date: 2026-08-11

## 背景

Phase 1-3 已有可信候选、持久化 catalog 和受控应用事务，但没有可以安全交给
React/Tauri 使用的服务边界。直接暴露库 API 会允许客户端伪造 policy、证据、操作者、
目标路径或应用内容，也无法阻止 Agent run 与目标修改并发。

## 决策

项目 runtime 在同一个跨进程 control lease 内创建 `DurableEvolutionCatalog`、
`EvolutionApplicationCoordinator`、`RunSupervisor` 和 `EvolutionProjectService`。
启动恢复失败即 fail closed；关闭时先封闭并排空所有演进操作和已接收的 run action queue，
再关闭 supervisor/event store 并释放 lease。

HTTP 控制面采用以下边界：

- 所有演进读接口要求本地 session cookie；所有 mutation 额外要求与实际监听 URL 精确
  相等的 `Origin`。
- operator 由 session token 摘要派生。浏览器不能提交持久化 proposal ID、policy、目标
  路径、candidate digest、evidence、actor、时间戳或 confirm 阶段的 apply bytes；客户端
  只提供受格式限制的 `Idempotency-Key`，服务端据此派生 proposal ID 或绑定命令重放。
- proposal ID 由 `Idempotency-Key` 确定性派生；同 key 同内容安全重放，不同内容冲突。
- prompt 入口只接受规范 base64 UTF-8，解码后不超过 256 KiB；角色映射到配置内
  `promptFile`，摘要由服务端计算。
- `evaluate` 只接受严格空对象。coordinator 在自身队列中读取 immutable proposal，自动
  从 `proposed` 进入 `evaluating`，运行固定版本的当前信任、策略 schema/topology/profile，
  或提示词对象/目标/Git 跟踪检查，再把证据直接绑定到 proposal 与 candidate digest。
- evaluation 持久化版本化来源 `server-structural-preflight-v1`；缺少来源的旧文档迁移为
  `external`。HTTP evaluate 不会把旧 external pass 原样当成当前服务端预检，晋升入口也
  拒绝非当前来源。
- 该证据的 scope 是 `server-structural-preflight-not-candidate-execution`。它不证明候选已
  在 Agent run 中执行，也不证明行为质量。客户端不能选择历史绿色 run 作为证据。
- promote/rollback 分为 preview 与 confirm。preview 返回 token 绑定的精确 before/after；
  prompt 内容只在已认证、`no-store` 的预览响应中出现。confirm 必须带同一 revision、token、
  非空理由和幂等 key。
- 升级前已 promoted、但缺少 application proof 的 proposal 可通过受保护 HTTP 仅执行
  `adopt`：实时目标必须精确匹配候选，且浏览器不能提供 material。需要实际改写目标的
  `apply` 只由控制服务停止后的独占离线 `evolution-reconcile` 命令提供。
  离线命令要求显式 `expectedRevision`，并把它纳入持久化幂等绑定，重试不会隐式跟随新 revision。

## 并发与错误

项目级 mutation latch 在同一事件循环步检查 active run/action，并阻止新的 run、继续、
审批、重试或策略直改进入。目标修改还经过服务内队列；并发相同 confirm 会等待首个命令，
随后读取持久化幂等结果。冲突稳定映射为 `409 ACTIVE_RUN_CONFLICT`。

catalog 同进程多实例共享按规范文件路径的提交队列，再执行磁盘 revision CAS；跨进程由
runtime control lease 保证单 writer。提示词对象缺失/损坏和恢复不确定映射为 `503`，不会
伪装成客户端校验失败或确定性 pass。

由 application coordinator 提交的 promotion/rollback audit 带可选的
`applicationCommandId`，并与 application completion 双向校验：成功命令必须拥有对应
catalog audit，aborted 命令不得拥有，带命令 ID 的 audit 也不得成为孤立记录。该字段可选
是为了读取 Phase 1-3 已有 catalog；所有 Phase 4 新受控 mutation 都必须写入它。command
result 中的 proposal 只允许是当前 catalog proposal 的不可变字段相同、transition 精确前缀
的历史快照。

control lease 先写入并 fsync 完整所有者记录，再通过同目录 hard link 原子发布。损坏、
不完整或所有者 PID 已失效的 `control.lock` 均 fail closed，不会自动删除或抢占；运维者必须
先确认该项目没有控制服务运行，再手动移除残留锁。

## 后果

- Phase 5 前端只调用窄 API，不持有文件路径、证据或写权限；preview token 与命令 ID 仅保留在短生命周期内存中。
- 本 ADR 定义的普通 HTTP 候选路径仍以人工晋升与回滚为最终边界；Phase 4 本身不提供自动
  晋升、后台自循环、网络发布或秘密存储。
- 当前预检只覆盖结构与安全。真正的候选行为质量验证必须等待服务端创建、持久绑定并在
  隔离环境执行 candidate-specific evaluation run，不能复用普通历史 run。
- 原有策略工作室的直接保存/删除仍是兼容入口，并受同一 mutation latch 保护，但不会生成
  evolution proposal、评估或审计链；需要演进门禁时必须走 evolution API。

> 后续说明：ADR 0017 在独立的项目级 automation owner 下增加了显式启动、硬上限的策略
> 自动评测与应用路径。本文的人工 HTTP 候选边界保持不变；浏览器仍不能伪造自动评测证据，
> 人工 promote/rollback 仍要求 preview/confirm。

## 参考

- `src/server/evolution-service.ts`
- `src/server/http.ts`
- `src/server/project-runtime.ts`
- `src/evolution/application.ts`
- `test/evolution-server.test.ts`
- [ADR 0015](./0015-controlled-evolution-application.md)
- [ADR 0017](./0017-bounded-automatic-strategy-evolution.md)
