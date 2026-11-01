# ADR 0020: 从「一个 run」到 Router / Worker 两层

- Status: Accepted（R1–R5 已实现，见文末实施记录）
- Date: 2026-10-31
- 依据: 《Super-agent 设计探索：迈向更自主的 Agent System》（DeepSeek Harness 团队）与
  ADR 0019 的实施结果

## 背景

ADR 0019 补上了「授权」与「入口」两条脊柱：Trigger → 判定 → Ticket → Assignment → run。
它解决了「这条工作凭什么可以做、谁在等」，但没动执行体的形状。

读文章时看清了一件事：**我们现在的一条 run 同时是 Router 和 Worker。**

- 它做全局决策（起规划、选策略、仲裁返工、发 PR）；
- 又在一个 64 分支的函数里亲手执行任务（`executeOneTask` CC 64）。

文章把这层职责拆开了，并给出了实验数据支撑为什么必须拆：

| 结论 | 数据 |
| --- | --- |
| Router 不直接执行，吞吐才稳 | 单 Session + Subagent 的 p95 为 29.5 分钟；双层架构 p50/p95 为 12.4/15.7 分钟 |
| 提示词约束替代不了结构 | 中性提示下 5 次运行**一次都没**委派；改提示后 4 次委派，仍有 1 次「觉得太小自己做」形成长尾 |
| 直通省的是 Router 的推理钱 | 去掉直通，Router 决定数 +30%，读缓存 token 2323 万 → 3177 万（+37%） |
| 单 Router 靠批处理撑得住 | 1→40 条/分钟时 batch 1.0→2.8，单次请求 2.5s→3.9s，分摊 6.4s→1.6s |

结论：**让 Router 不干具体活，是结构问题，不是提示词问题。**

## 决策

把执行体分成两层，落成三个改动。

### 1. Router / Worker 分层

```text
        ┌───────────────────────────────┐
Trigger→│ Router：准入、分派、对外说话      │
        └───────────┬───────────────────┘
                    │ Assignment
        ┌───────────▼───────────────────┐
        │ Worker：上下文隔离、执行 DAG     │  ×N 并发
        └───────────┬───────────────────┘
                    │ Report
                    └──> Router（唯一对外）
```

- **Router**：现状里做「判定 + 规划 + 仲裁 + 发布」的那部分。**不再持有执行工具**，不再自己跑任务。
- **Worker**：一条 Assignment 的执行体。上下文隔离，不直接对外发消息，只回 Report。
- 我们已有的 `Ticket` / `Assignment` / `Report`（`assignmentOutcome`）正是这层的载体，不需要新概念。

**不做**：不新增「Router Session」这个持久会话概念。我们的 Router 现在是确定性代码 + 已有的 planner/advisor 调用，不是常驻 LLM 会话。文章用常驻 Session 是为了跨信道连续性，那件事我们先由 Ticket/Thread 承担。

### 2. 订阅直通（Subscription direct-pass）

- `Subscription`：Ticket 与 Thread 的多对多关系（ADR 0019 的域模型里已有概念，尚未实现）。
- 已订阅 Thread 的后续 Trigger **不经过判定**，直接投给持有该 Thread 的 Assignment。
- 判定只处理「新 Thread 的第一条 Trigger」。

**为什么现在就得做**：ADR 0019 的 `admitEvent` 现在对每条事件都过一遍 gate。文章的数据说明这条路在事件密集时会先烧掉 Router 的 token，而不是 Worker 的。

### 3. Inline & Spill + 引用图

语境当 Cache 管：

- 每个对象（Trigger / Thread / Ticket / Assignment）有稳定 ID；
- 注入时**内联紧密相关对象的 ID 与摘要**，不内联全文；
- 超出预算的部分 Spill 到窗口外，保留「按需读取」的入口；
- 由此得到链式召回：沿 ID 逐跳展开，而不是一次性塞满。

**最小落地**：先做「对象给 ID + 注入时附带下游 ID」。全文按需读取的工具已经在（会话工具），我们缺的是 id 与引用关系。

## 分期

每期独立 PR，判据同 ADR 0019：`pnpm test` 全绿、`check`/`lint` 干净、门禁 exit 0、现有流水线不停摆。

| 期 | 内容 | 退出标准 |
| --- | --- | --- |
| **R1 词表** | `src/runtime/roles.ts`：`RouterSurface` / `WorkerSurface` 的职责表与守卫（哪些能力属于哪层），纯函数 | 一张表 + 测试：Router 不得持有执行能力的断言 |
| **R2 Subscription** | `Subscription` 类型 + `TicketService.subscribe/unsubscribe` + `admitEvent` 先查订阅再判定 | 同一 Thread 的第二条事件**不经过 gate**；取消订阅后重新经过 |
| **R3 分层执行** | 把 `executeOneTask` 从 runner 移到 Worker 面；Router 只保留调度与仲裁 | Runner 里不再出现工具执行；`executeOneTask` 的 CC 拆分成为自然结果（**R3 重新界定为 R3a + R3b，见下**） |
| **R4 对象 ID** | Trigger/Thread/Ticket 的 ID 注入到提示词上下文 | 提示词里能看到下一跳 ID；有测试钉住注入格式 |
| **R5 Spill** | 超预算内容截断 + 续读入口 | 长内容不再整段进提示词；有截断与续读的用例 |

## 不做什么

- **不引入常驻 Router LLM 会话**：我们的 Router 是代码 + 既有 planner，跨信道连续性由 Ticket/Thread 承担。
- **不做 Router 分片**：文章明确说团队规模下不需要，我们的规模更小。
- **不做存算分离 / 端侧 daemon**：我们是本地优先工具，这一点和文章的场景不同。
- **不做 Watchdog**（见下）。

## Watchdog：记下来，暂不做

文章的 Watchdog 是**主系统之外的独立 Agent Session**，由定时消息驱动，用模型判断 Worker 有没有实质进展（不是进程存活探测）。

我们现在的对应物是 `interventions` 与运行超时——能发现「卡住」，不能发现「在动但方向错了」。

在 R3 之后做才有意义：现在 Worker 和 Router 还没分，监控谁都不清楚。

## 风险

| 风险 | 判断 | 缓解 |
| --- | --- | --- |
| 分层后 Router 仍然越权执行 | 真实 | R1 的守卫表写成测试，先钉住再改执行体 |
| 直通绕过判定导致未授权工作 | 最高 | 直通只对**已持有 Ticket 的 Assignment** 生效；新 Thread 一律过 gate；R2 的第一条测试就是「直通不改授权」 |
| Inline 注入反而稀释注意力 | 中 | R4 只注入 ID 与摘要，不注入正文；用一次真实 run 对比提示词长度 |
| 与 ADR 0019 的 Ticket 语义冲突 | 低 | 两者共用 Ticket/Assignment/Report，不新增概念 |

## 与 ADR 0019 的关系

0019 回答「谁可以做、做到哪一步」；0020 回答「谁来做、怎么把话传回去」。

0019 的 `Assignment` 现在就是 Worker 的边界，`Report` 就是 Worker→Router 的回话通道——**0020 不需要改 0019 的域模型**，只是把执行体从中拆出去。

## R3 的范围勘定（2026-10-31）

R3 是本 ADR 里最大的一期，动手前先量了一次。结论：**它不能在一轮里完成，硬塞会把一个红色门禁的分支留给人。**

### 量出来的事实

`src/workflow/task-attempt.ts`：

| 项 | 值 |
| --- | --- |
| `executeOneTask` | 280 行，CC 64，覆盖率 86% |
| 同文件其余超阈值 | `tryFinishAlreadyPassedTask` CC 18、`reviewTaskAttempt` CC 10 |
| 测试形态 | 集成级（真 git、真流程），跑一轮几十秒 |

三件事叠在一起，决定了做法：

1. **文件级门禁**：碰这个文件就要把三个函数一起清到 ≤10。部分拆分 = 门禁红 = 什么都合不进去。
2. **CC 64 在 86% 覆盖率下**，每块碎片要 CC ≤ 8 才达标——意味着至少六次抽取，每次都要精确搬运七个可变状态（`identicalFailures`、`feedback`、`lastReworkExperienceIds`、`failureInput`、`previousSignature`、`architectAdvice`、`attempt`）。
3. **测试是集成级的**，抽取错误不会以单测红灯出现，而是以「某个分支偶尔多跑一轮」出现。

### 一次失败的尝试，记录下来

我先试了最小的一步：把「失败信号 → 顾问 → 停止判定」那 65 行抽成 `decideBeforeRetry`，并把六个可变局部收进一个 `memory` 对象。

在改到一半时停下——原因不是难，而是**这类改动必须一次改完**：`feedback` 这类名字既被读又被写，散落在 200 行里，半改状态下 TypeScript 只是报「未定义」，而真正的风险是那些**没报错但语义变了**的地方（例如 `errorMessage: feedback` 引用了改名前的变量）。整支回滚，工作区干净。

### 重新界定

| 期 | 内容 | 完成判据 |
| --- | --- | --- |
| **R3a** | 一次提交内完成 `task-attempt.ts` 的三函数拆分：`memory` 对象 + `decideBeforeRetry` + `verifyAndCommit` + `runWorkerOnce` | 门禁绿、`executeOneTask` ≤ 10、测试全绿 |
| **R3b** | 在拆分完成之后加 Worker 面守卫（`assertCapability("worker","execute")`），并把执行体移到 `src/runtime/worker.ts` | `Rule`：Router 侧不再 import 执行体 |

先 a 后 b：**拆分是机械的、可验证的；分层是语义的、依赖拆分之后的形状。** 顺序反过来会让人在一个 280 行的函数里同时改结构和语义。

### 这一期不做的事

不改 `tryFinishAlreadyPassedTask` 与 `reviewTaskAttempt` 的行为——它们只是被同一文件的规则带进来，拆到 ≤10 即可。

## 实施记录（2026-10-31）

7 个 PR（#98–#104），测试 1609 → 1677。每期独立合并，每次都跑过 `pnpm test` / `check` / `lint` 与门禁。

| 期 | 落地 | PR | 接到真实路径了吗 |
| --- | --- | --- | --- |
| R1 词表与守卫 | `runtime/roles.ts`：七个能力、各归一层、`assertCapability` | #98 | 是：`admitEvent` 断言 router 面 |
| R2 订阅直通 | `Ticket.subscriptions` + `subscribe`/`unsubscribe` + `admit` 先查订阅 | #99 | 是：`TicketService.admit` 的入口 |
| R3a 拆分 | `task-attempt.ts`：`executeOneTask` 280 行 / CC 64 → 五个具名步骤 | #101 | 是（行为不变） |
| R3b 分层 | `scheduler.ts`：`executeTasks` CC 49 → 6，执行入口断言 worker 面 | #102 | 是：`assertCapability("worker","execute")` |
| R4 对象 ID | `runtime/references.ts` + worker context 的 `references` | #103 | 是：`runWorkerTurn` |
| R5 Inline & Spill | `runtime/spill.ts` + 反馈上限 4000 字符 | #104 | 是：`inlineFeedback` |

顺带：ADR 0019 的 attention 面板挂到了看板页顶部（#97），issue #95 关闭。

### 一件在实施中修正的事

R3 原计划一期做完，动手前量了一次：`executeOneTask` 280 行、CC 64，同文件另两个函数也超阈值，而文件级门禁要求三个一起清。**部分拆分合不进去**——半成品只能留在本地。

于是 R3 重新界定为 a（机械拆分）与 b（分层与守卫）。顺序不能反：拆分是可验证的，分层依赖拆分后的形状。这个判断写进了 [PR #100](https://github.com/HuaWeiQiu/local-dev-agent-team/pull/100)，也救回了此前三次在同一处的回滚。

### 数字

| 函数 | 前 | 后 |
| --- | --- | --- |
| `executeOneTask` | CC 64 / CRAP 75.9 | CC 10 / CRAP 10.0 |
| `executeTasks` | CC 49 / CRAP 61.2 | CC 6 / CRAP 7.9 |
| `tryFinishAlreadyPassedTask` | CC 18 / CRAP 58.5 | CC 9 / CRAP 9.1 |
| 全仓 CRAP > 100 | 0 | 0 |
| 全仓 CRAP > 10 | 234 | 229 |

### 三个值得记住的判断

1. **测试抓到过一次「编译得过但语义变了」**：把「检查上一次评审」放在 `reviewTaskAttempt` 之后——它会覆盖 `taskState.review`，于是「已通过」被当成「要求返工」。
2. **`lastIndexOf` 返回 -1 时，「没有换行」被当成了「换行在第 -1 个字符」**：`slice(0, -1)` 静默吃掉每条单行文本的最后一个字符。
3. **测试逼我改掉想当然**：两个任务 `ownedPaths` 重叠时不同波；计划耗尽要「都完成」且「都不再可启动」。

### 没有做的

- **常驻 Router LLM 会话**、**Router 分片**、**存算分离**：见「不做什么」，我们的场景与文章的部署形态不同。
- **Watchdog**：文章第六节的独立监督 Session。现在分层有了，它才有意义——留作后续。

