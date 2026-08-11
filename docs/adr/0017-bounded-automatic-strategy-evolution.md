# ADR 0017: 有硬上限的自动策略演进

- Status: Accepted
- Date: 2026-08-11

## 背景

Phase 1-5 已能安全记录候选、持久化证据、精确应用和回滚，并通过 React/Tauri
工作台提供人工 preview/confirm。它仍不能回答“哪个编排策略在同一个真实任务上更好”，
也不能在一次明确授权后自动完成多轮候选比较。

无边界后台循环会放大模型误判、成本和并发写入风险。因此自动能力只扩展到项目级
`strategy-blueprint`，不扩展到角色提示词、代码发布、PR 合并或秘密访问。

## 决策

项目配置可显式启用 `evolution.automatic`。操作者在工作台选择 1 至项目配置上限的轮数并
点击一次“开始”；服务不会随进程启动自动运行，也不会在重启后自动续跑。

每个会话按以下固定流程执行：

1. 获取项目级 automation owner，要求没有活动 run、run action 或目标修改。
2. 用当前有效策略在固定 `evaluationGoal` 上运行一次 incumbent 基线。
3. 由配置的只读 proposer role/profile 生成一个严格 `NamedStrategy` 候选；proposer 不能写工作区。
4. 将候选保存为临时 shadow strategy，并在新的隔离 Git worktree 中运行相同目标。每个策略可
   重复 1 至 2 次，聚合时取最差分数。评测 run 不请求策略中的 plan/final 人工门禁，但仍执行
   架构、工作、独立审查、测试、最终决定和全部确定性质量命令。
5. 只从持久化 `RunState` 投影确定性结果：最终质量、最终决定、合并任务数、命令退出码、
   尝试次数和 Agent 调用次数。stdout、stderr、目标文本、模型理由和审批理由不进入证据。
6. 候选必须自身通过全部门禁，且分数至少超过 incumbent 的 `minimumScoreDelta`。满足时由
   控制器通过既有 application coordinator 自动应用；否则记录拒绝。
7. 胜者成为下一轮 incumbent。达到请求轮数，或连续无提升次数达到配置值时停止。

proposer role 的主 profile 与全部 fallback 均必须只读。候选只能保持或降低 incumbent 的并发、
重试、Agent 调用、执行超时、进程输出、产物和审批等待预算。通过结果必须来自状态为
`completed`、purpose 为 `evolution-evaluation`、目标与策略均精确匹配服务端请求且至少执行一条
成功确定性质量命令的 run。

这里的一次“开始”点击是对该有界会话的明确授权；候选自身的
`automaticPromotion` capability 仍固定为 `false`，不能自授权或绕过控制器门禁。

当前分数为：完整通过 `+10000`、最终质量通过 `+1000`、最终决定 ready `+500`、全部任务
合并 `+500`、每条通过命令 `+20`、每次额外 task attempt `-50`、每次 Agent invocation `-5`。
该公式是版本化实现的一部分，不能由候选或浏览器提交。

## 并发与失败

- `RunSupervisor` 的 automation owner 在整个循环期间拒绝普通运行、审批、继续、重试、清理和
  人工目标修改；只有 owner 能启动 `purpose: evolution-evaluation` 的评测运行和短暂目标写入。
- 评测运行通过本地质量与最终决定后直接进入 `completed`，不请求发布审批，也不创建或合并 PR。
- 自动评估来源固定为 `server-automatic-run-evaluation-v1`，绑定 proposal、candidate digest 和
  当前运行结果。普通浏览器晋升入口仍只接受人工结构预检来源，不能伪造自动证据。
- 服务关闭或操作者停止会取消活动评测，删除可安全删除的 shadow strategy，并在所有活动工作
  结束后释放 owner。错误一律 fail closed；未完成的 proposal 可以保留用于审计，但不会应用。
- proposer 自身也写入带 `evolution-proposer` purpose 的 RunState，并受调用次数、1800 秒总时限、
  每流 1 MiB 输出和 16 MiB 产物上限约束；成功、失败、取消或崩溃恢复后的状态均可进入清理流程。
- `auto-eval-<command-digest>-<cycle>` 是创建时保留的 shadow 格式。启动恢复仅在 proposal 带
  server-owned automatic origin、名称可反推同一 proposal 且实时定义逐字段匹配时删除；旧版人工
  同前缀策略或漂移内容一律保留，不按名称猜测所有权。
- durable catalog、run state、application journal 和目标策略继续持久化；循环进度本身仅属于当前
  进程。重启恢复已应用的自动策略为运行时默认值，但不会自动重新启动循环。
- Start 的幂等键、请求轮数和已认证本地 session operator 持久绑定。当前进程内的同一请求重放
  当前 snapshot；重启后旧键 fail closed，不会重复启动。promotion/rejection 审计使用该可信
  operator，浏览器不能提交 actor。

## 硬限制

- `maxCycles`: 1-10，默认 3；一次请求不能超过配置值。
- `maxConsecutiveNoImprovement`: 1-10，且不能超过 `maxCycles`，默认 2。
- `evaluationRepeats`: 1-2，默认 1；取最差结果。
- `minimumScoreDelta`: 0-1000，默认 1。
- proposer 必须是角色 allowlist 内的只读 profile。
- proposer role 的所有 fallback profile 也必须只读。
- 启用时至少配置一条 `quality.commands` 确定性命令。
- 候选的资源、重试、并发和时间预算不得高于 incumbent。
- `baselineStrategy` 必须是静态配置策略；`targetStrategy` 不能覆盖静态配置策略。
- 若同名自定义目标已存在，只有活动自动 proposal、application proof 和实时定义完全一致时
  才能继续演进；手工创建或漂移的同名目标会使循环在基线前失败封闭。
- `evaluationGoal` 在启用时必填且固定；候选和浏览器都不能在循环中替换它。

## 后果

- 用户获得“一次点击、自动有限循环、可随时停止”的策略演进体验。
- 提升后的自定义策略成为后续普通运行的运行时默认值；既有应用回滚链仍可恢复前一目标。
- 自动演进评估会真实调用配置的 Agent CLI 并消耗时间/额度。默认配置关闭；本仓库项目配置
  开启但仍要求每次显式点击。
- 角色提示词自动演进、跨目标综合 benchmark、网络发布和自动合并继续不在范围内。

## 参考

- `src/evolution/automation.ts`
- `src/server/evolution-automation.ts`
- `src/server/supervisor.ts`
- `web/src/components/EvolutionWorkbench.tsx`
- `test/evolution-automation.test.ts`
- [ADR 0016](./0016-evolution-control-plane.md)
