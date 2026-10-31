# ADR 0019: 引入「授权工作脊柱」——借鉴 dsh-superagent 的准入与工单模型

- Status: Accepted（P0–P6 已实现，见文末实施记录）
- Date: 2026-10-31
- 参考: `deepseek-ai/dsh-superagent-prototype`（源码与 `docs/000`–`008`）

## 背景

我们把 `dsh-superagent` 的八篇设计文档读了一遍，和我们自己的
`docs/architecture.md`（run 中心的批处理编排）逐条对照。结论是：**我们缺的不是
能力，是「授权」与「事件」这两条脊柱。**

具体缺什么，逐条写清楚：

| 差距 | 我们现在的做法 | 后果 |
| --- | --- | --- |
| 没有不可变的授权对象 | 审批是 `ApprovalRequest` + 状态机，批准后只改状态 | 事后无法回答「这次动手凭什么、按哪版策略、范围多大」；策略变了也无法投递给在飞的工作 |
| 没有入口抽象 | 只有「人写一个 goal 起一个 run」 | GitHub 事件、CI 结果、PR review 评论都无法起或续工作 |
| 没有续作语义 | `resume` 是机器级检查点恢复 | 人后来的补充消息无法在**同一授权**下续接同一份工作 |
| 面板是状态优先 | 列出全部 run 与状态 | 人得自己找「谁在等我」 |
| 幂等是命令级 | 命令 id 去重 | 同一条外部事件被投递两次可能起两份工作 |

我们比他们强的地方必须保住，不能在对齐中丢掉：

- **规划与质量**：DAG 规划、worktree 隔离、质量门、CRAP/变异门禁、演进账本。
  dsh-superagent 完全没有对应的东西，它是「一个仓库上的一个主动 agent」，不是编排器。
- **多 CLI 适配器**：codex/claude/grok/kimi + 一致性契约。
- **事件账本 + SSE 投影**。

所以本 ADR 不移除我们的执行引擎，而是**在它外面加两层、在里面换一个单位**。

> 说明一件事实：那篇微信公众号文章在当前环境被验证页挡住，读不到正文。本文的
> 依据是仓库里的 `docs/000`–`008`。README 明确写了发布版「已做改编，与内部版本
> 及文章中描述的实现并不一致」，因此若文章还有额外设计，本文没有覆盖到。

## 概念映射

用他们的词汇描述我们的系统，能看清哪些是同一个东西、哪些是真空白：

| dsh-superagent | 我们 | 关系 |
| --- | --- | --- |
| Source | 无（只有人工 goal） | **缺** |
| Trigger | 无（`intake` 是人写的目标摘要） | **缺** |
| Thread | `run.root` + 分支；PR 评论散落在 GitHub | **部分**，未建模 |
| Eval（gate + assessment） | `planCompleteness` + architect/advisor 评审 | gate 是**缺**，assessment 已有 |
| Decision | `RunStatus` 的转移 | 语义不同：我们记状态，不记决定 |
| Mandate | `ApprovalRequest`（临时、可丢） | **缺**（不可变授权） |
| Ticket | `Run` + `Task` | 粒度不同：run ≈ 一次交付，task ≈ 一个工作项 |
| Assignment | `TaskAttempt` | **同构**，但未绑定到授权 |
| Executor | `AgentSession` + `LocalWorkflowRunner` | 我们更强（会话 + 流水线） |
| Channel | `github/publish.ts` + 通知 | **部分**，无回执 |
| Outbox | 无（发布直接调 GitHub） | **缺** |
| Policy | `agent-team.yaml` + `strategy` | **部分**，无版本化、无 Source 分片 |
| Attention | `awaiting-human` 状态 | **有词无表**：没有统一的「等谁、等什么」 |
| Report | `TaskAttempt` 结果 | **同构** |

一句话：**我们的执行很强，授权和入口是空的。**

## 决策

新增一条「授权工作脊柱」，分四层，与既有执行引擎正交。

```text
Source ──Trigger──> Thread ──batch──> Eval ──Decision──> Mandate
                                            │
                                            ▼
                                        Ticket ──Assignment──> Run（既有引擎）
                                            ▲                        │
                                            └────── Report ──────────┘
                                            │
                                        Channel / Outbox ──> 外部世界
```

### 1. Intake（新模块 `src/intake/`）

- `Source`：可复用种类 + 一份实例配置；自己保存读取位点；丢弃自己的消息与监听
  范围外的事件；把每条外部事件翻译成 `Trigger` + 它属于的 `Thread`。
- `Trigger`：不可变；幂等键 = `(sourceKind, sourceInstanceId, externalId)`。
  同一 Trigger 被接受两次只产生一张 Ticket。
- `Thread`：同一外部对话（PR、Issue、本地会话）的事件序列；同时只有一个 Eval。

### 2. Authority（新模块 `src/authority/`）

- `Eval` = **gate**（确定性：谁可以、以什么强度、范围多大；读 versioned Policy）
  \+ **assessment**（模型：要不要接、怎么做）。
- `Decision`：`accept | stop | ignore | unavailable`，带 reasons（我们已有
  `failure-signature` 的词表可复用）。
- `Mandate`：**不可变**，记录 policy 版本、范围、强度、触发者在该 Source 的身份、
  以及它是怎么进来的。Ticket 结束后 Mandate 仍然存在，只有人明确停止或策略不再
  成立才撤销。**续作前必须按当前策略重新校验。**

### 3. Work（既有引擎，换单位）

- `Ticket`：授权的工作单位。它引用 Mandate，持有 Channels 与 Inputs，状态
  `open → ended`；人的消息可在一张 subscribed Thread 上把它**在同一个 Mandate 下**
  恢复为 open。
- `Assignment`：Ticket 与一次执行实例的绑定。落到我们这里 = 一次 `Run`。
  一个 Ticket 可以有多次 Assignment（重试、续作）。
- `Run`/`Task`/`TaskAttempt` 保留，成为 Assignment 的内部实现细节。

### 4. Output 与 Attention

- `Outbox`：唯一的写出口，事务内落回执、事务外投递；每条消息有回执，
  投递失败可见、可重试。
- 面板按 `stage(ticket)` 排序而不是 `status(run)`：
  `待人工（投递失败 / 待回答 / 待评审 / 受阻）→ 执行中（排队 / 空闲 / 运行）`。
  健康状态不占版面。

## 分阶段实施（每阶段独立可发布）

每一阶段都必须：`pnpm test` 全绿、`pnpm check`/`lint` 干净、`node scripts/ub-quality-gate.mjs`
exit 0、走正式 PR。**任何阶段都不允许让现存的 run 流水线停摆。**

| 阶段 | 内容 | 退出标准 |
| --- | --- | --- |
| **P0 词表与类型** | `src/authority/types.ts`、`src/intake/types.ts`：Trigger/Mandate/Ticket/Assignment/Eval 的类型与不变量，纯函数 + 单元测试，不改任何调用点 | 类型与纯函数 100% 覆盖；无行为变化 |
| **P1 授权对象** | 审批产生不可变 `Mandate`（policy 版本 + 范围 + 强度 + 触发者）；`resume`/`retry` 前重新校验 | 旧 run 全部可续；新增「策略变更后旧 Mandate 被拒」的测试 |
| **P2 第一个 Source** | GitHub PR/Issue + CI 作为 Source，产出 Trigger/Thread | 同一外部事件投递两次只产生一条 Trigger；PR 评论进入 Thread |
| **P3 Eval gate** | 确定性准入（谁可以、范围、强度）先于规划；gate 拒绝时不进入规划 | gate 的每个拒绝码有测试；面板能看到拒绝原因 |
| **P4 Ticket 成为持久单位** | `Run` 挂到 `Ticket` 与 `Assignment` 下；Ticket 生命周期独立于 Run 状态 | 一次 Ticket 经历 ≥2 个 Assignment（失败重试、批量续作）后状态正确 |
| **P5 Attention 面板** | 面板首屏 = 待人工队列 | 首屏只出现需要人的条目；健康 run 不占位 |
| **P6 Outbox 回执** | 发布与通知走 Outbox，带回执与重试 | 发布失败可见、可重试；重复发布被回执挡住 |

## 不做什么（明确排除）

- **不改执行引擎的核心**：DAG 规划、worktree、质量门、CRAP、演进账本保持原样。
- **不做跨 Source 身份映射**：一个人在不同 Source 的账号是提示词事实，不是实体。
- **不为每个业务需要新增概念**：新需要优先变成既有概念的一个属性，或一段提示词。
- **不做「一个 Thread 只能有一张 Ticket」**：同一 Thread 可以有多份独立工作。
- **不引入他们的 Eval 超时语义**：我们的 run 有自己的超时与重试，先保持两套并存，
  P4 之后再统一。

## 风险

| 风险 | 判断 | 缓解 |
| --- | --- | --- |
| 概念叠加，系统更难懂 | 真实风险 | P0 只加类型；每个新概念必须有「没有它会怎样」的失败案例测试 |
| Ticket 与 Run 双生命周期不一致 | 最大风险 | P4 之前 Ticket 只是 Run 的外壳；P4 用「一次 Ticket ≥2 Assignment」的用例钉死 |
| GitHub Source 的幂等键选错 | 会重复起工作 | 键取 `(repo, kind, number, eventId)`；写测试覆盖重复投递 |
| 面板改版打断现有工作流 | 可接受 | P5 单独一个 PR，保留旧视图一个版本周期 |
| 文章里还有未覆盖的设计 | 未知 | 拿到文章正文后回填本文第 1 节与映射表 |

## 结论

我们不是要变成 dsh-superagent。我们要的是它的**两条脊柱**：事件驱动的入口，和
不可变、可重新校验的授权。执行引擎已经比它强，保留；把授权和入口补上之后，
「这条工作凭什么可以做、做到哪一步、谁在等」才第一次有答案。

## 实施记录（2026-10-31）

13 个 PR，测试 1320 → 1586。每一阶段独立合并，每次都跑过 `pnpm test` / `check` / `lint` 与门禁。

| 阶段 | 落地 | PR | 接到真实路径了吗 |
| --- | --- | --- | --- |
| P0 词表 | `intake/types.ts`、`authority/types.ts` | #70 | — |
| P1 Mandate | `authority/policy.ts`、`authority/mandate.ts` | #71 | 是：审批产出、`resume` 前重校验 |
| P2 Source | `intake/github-source.ts` | #72 | 是：见 P4 入口 |
| P3 gate | `authority/gate.ts` | #73 | 是：`TicketService.admit` |
| P4 Ticket | `authority/ticket.ts`、`ticket-store.ts`、`ticket-service.ts` | #74–#76 | 是 |
| P4 run 接线 | `RunState.ticketId`、`withTicketAssignment` | #77 | 是 |
| P4 入口 | `intake/admission.ts`、`Supervisor.admitEvent`、`POST /api/intake/github` | #78、#80、#81 | 是，默认关闭 |
| P5 attention | `authority/attention.ts`、`GET /api/tickets`、`web/src/components/AttentionPanel.tsx` | #82、#83 | 数据源是；**面板未挂页面** |
| P6 Outbox | `authority/outbox.ts`、`outbox-store.ts`、接 `github/publish.ts` | #84、#86、#87 | 是：发布前写回执 |

### 没有做的，以及为什么

**1. 手起的 run 还不是 Ticket。**
现在只有带 `ticketId` 的请求、或从 webhook 进来的工作会成为 Ticket。要让每条 run 都自动开一张 Ticket，`start()` 必须等 gate 与 Ticket 落盘才能返回——那意味着 `start()` 变成异步，波及所有调用点。试过一版：异步化后 `active.size` 立刻可见性变了，多个既有的并发/幂等测试直接红。**这是真正的双生命周期问题，ADR 里标的第一风险兑现了。** 它需要单独一轮设计，不该混在收口里。

**2. attention 面板没有挂到页面上。**
组件、数据源、测试都在（`test/web-attention-panel.test.tsx`），但放在首屏、侧栏还是某个标签页下是一个**产品决定**，不是技术债。没有替使用者做这个决定。

**3. Outbox 只服务发布。**
`publish` 会把「要说什么」写成回执再动手；其余对外动作（评论、通知）还没有走 outbox。它们的通道语义（尤其「会话已消失」）需要各自定义。

### 值得记住的三个坑

- **`/停止\b/` 永远不匹配**：word boundary 不能跟在 CJK 字符后面。中文停止词要单独分支。
- **回执键不能依赖流程自己会改的字段**：第一版用 `state.repository`，而 publish 自己会设置它，于是写回执和读回执用了不同的 id——幂等**静默失效**，不报错，只是每次新建 PR。
- **文件级门禁会放大改动代价**：碰 `http.ts` 就要清三个冻结函数（#79），碰 `publish.ts` 就要先让它可测（#86）。这不是阻力，是提醒：**改动范围要在动手前算进预算**。

### 一条被证明有效的纪律

凡是「债来自覆盖率而不是来自分支」的函数，拆解是负收益：`useDesktopProject` 和 `useOnboarding` 的 CC 只有 9，CRAP 90 完全来自 0% 覆盖，**没拆一行代码，只让行为可达就掉到 10 以下**。反之 `automatic-controller` 只拆不测，拆一次涨一次，只能整支回滚。

