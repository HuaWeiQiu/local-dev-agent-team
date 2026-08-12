# Kimi explore / plan / coder + Swarm → Agent Team 映射设计草案

- 文档状态：**已落地 Phase A–D（配置 + runner + UI）**；细节以代码与本文件 §7 为准
- 对照来源：Kimi Code CLI [Agents and Sub-Agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html)、[Built-in Tools / AgentSwarm](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/tools.html)
- 目标：吸收 Kimi 的「任务形态分离 + 批量并行」调度思想，**不替换** Agent Team 的 worktree、质量门禁、多 Profile、事件账本与人工审批

---

## 1. 为什么要映射

| 层 | Kimi Code CLI | Agent Team（现状） |
| --- | --- | --- |
| 产品定位 | 会话内编码助手，主 Agent 动态拆子任务 | 项目级交付流水线，固定角色 + 确定性控制面 |
| 并行 | `Agent` / `AgentSwarm` 动态开 sub-agent | 任务 DAG + `maxParallel` 调度 worktree |
| 角色形态 | explore（只读）/ plan（只规划）/ coder（落地） | 总控 / 架构 / 执行 / 审查 / 测试 |
| 隔离 | 会话上下文隔离，结论回流 | Git worktree + 分支 + 质量命令 + 证据 |
| 模型 | 主/副模型偏好 | 每角色多 Profile（Codex / Grok…）与 fallback |

**结论**：两套不是替换关系。Agent Team 应保留交付控制面，把 Kimi 的「按任务形态选执行面 + 同类任务批处理」映射成**可配置的阶段语义与调度策略**，而不是嵌入第二套 TUI 编排运行时。

---

## 2. 概念对照（一比一）

| Kimi 概念 | Agent Team 映射对象 | 说明 |
| --- | --- | --- |
| 主 Agent | **总控（orchestrator）** + 控制面 runner | 总控做目标分析/最终判定；runner 做确定性调度 |
| `explore` | **探索调用（explore invocation）** | 只读 profile：`permission: read-only`，禁止 worktree 写 |
| `plan` | **架构（architect）** + 可选 plan 审批门 | 产出任务 DAG / 计划摘要；不直接改业务代码 |
| `coder` | **执行（worker）** 在 task worktree 内实现 | 唯一默认可写业务代码的角色 |
| 自定义 reviewer agent | **审查（reviewer）** / **测试（tester）** | 独立只读（或受控）profile，不与执行共用 worktree 写权限 |
| `Agent` 派发 | `ProfiledAgentService.run*` + `artifactKey` | 每次调用有 role、profile、预算与事件 |
| `AgentSwarm`（模板 + items） | **Worker 波次（task wave）/ Swarm 波次策略** | 一批无依赖或同依赖层的任务并行，受 `maxParallel` 限制 |
| 上下文隔离 | worktree + 结构化产物 + 注入摘要 | 子任务不把大段探索日志塞回总控；只交结构化结论 |
| 后台 sub-agent | 已有 agent 子活动投影（Codex children） | UI 可继续展示；控制面仍以任务状态为准 |
| 自定义 agent 文件 | **角色提示词 + Profile 配置** | 不引入第二套 agent.md 运行时，沿用 `roles` / `profiles` / `promptFile` |

---

## 3. 目标架构（在现有拓扑上叠一层语义）

当前策略拓扑已有阶段图（agent / worker-pool / quality-gate / human-approval / publication）。草案在**不拆控制面**的前提下，给「任务形态」打标：

```text
目标
  → [explore 可选] 只读摸底（总控或专用 explore profile）
  → [plan] 架构拆 DAG（architect）
  → [human-approval? plan]
  → [swarm/coder 波次] worker 并行 worktree 实现
  → [quality-gate] 项目配置命令
  → [review / test] 独立审查与测试
  → [rework 有界]
  → [integration / publish]
  → [final approval]
```

### 3.1 Explore 阶段（可选，默认关）

**目的**：大仓库/陌生仓库先摸清边界，降低架构胡拆概率。

| 项 | 约定 |
| --- | --- |
| 触发 | 策略 `explore.enabled: true`，或总控结构化输出 `needExplore: true` 且策略允许 |
| 执行者 | 角色可复用 `architect` 或新增逻辑角色 `explorer`（配置层可选；默认映射到只读 architect profile） |
| Profile | **强制** `permission: read-only`，`externalTools` 默认 deny |
| 产物 | `artifacts/explore/summary.json`：模块边界、风险路径、建议验收命令、禁止改动路径 |
| 注入 | 仅摘要进入 architect 上下文（条数/字节上限），原始 explore 日志不进总控长上下文 |
| 失败策略 | 探索失败不阻塞时：跳过并记事件；严格模式：阻塞 run |

**明确不做**：explore 不创建业务 worktree、不提交、不跑可写命令。

### 3.2 Plan 阶段（对齐 Kimi plan）

| 项 | 约定 |
| --- | --- |
| 执行者 | `architect` |
| 权限 | read-only |
| 产物 | 任务 DAG、`plan.summary`、ownedPaths、acceptanceCommands |
| 与 Kimi 差异 | 计划必须可被 schema 校验；非法 DAG 由控制面拒绝，不靠「再聊一轮」 |

可选：策略 `approvalGates: [plan, final]` 已存在，继续作为 plan 的 HITL。

### 3.3 Coder 波次（对齐 Kimi coder + Swarm）

| 项 | 约定 |
| --- | --- |
| 执行者 | `worker` |
| 隔离 | 每任务独立 worktree + `agent-team/<run>/<task>` 分支（**保留**） |
| 并行 | 依赖层内并行，受 `maxParallel` 与预算约束（对齐 Swarm 并发上限思想） |
| 批处理语义 | 同一层 ready 任务视为一个 **swarm wave**；wave 内任务共享「波次策略」但不共享 worktree |
| Profile | 波次内可统一默认 worker profile，也允许任务级 `profile` 覆盖（多规格执行者） |
| 完成条件 | 结构化结果 + 本地质量命令通过（**保留**确定性门禁） |

**Swarm 映射细则**：

```text
Kimi AgentSwarm:
  prompt_template + items[] → N 个 sub-agent

Agent Team task wave:
  同一依赖层 readyTasks[] → N 个 worker 调用
  每个 item = 一个 TaskRunState
  并发 = min(readyCount, maxParallel, 剩余 agent 预算)
```

不引入「128 路无界 swarm」；默认仍受策略 `maxAgentInvocations` / `maxParallel` / 超时约束。  
可选配置：`swarm.maxConcurrency` 作为波次内更严上限（≤ maxParallel）。

### 3.4 Review / Test（Kimi 自定义 agent 的交付强化）

Kimi 默认偏「主 agent + 通用 coder」；Agent Team **强制**独立审查/测试角色，这是优势，保持：

- reviewer / tester 默认只读 profile
- 结论结构化（approve / request_changes / escalate）
- 与 worker 隔离；不直接改业务代码（返工走 worker rework）

---

## 4. 配置草案（示意，非最终 schema）

在现有 `strategies.definitions.*` 上增量，避免新运行时：

```yaml
strategies:
  definitions:
    balanced:
      topology:
        mode: parallel-dag
      # 新增（草案字段名，实现前可再定稿）
      taskMorphology:
        explore:
          enabled: false
          profile: grok-architect          # 必须在只读 allowlist 内
          maxInjectedChars: 4000
          failOpen: true
        plan:
          role: architect
        implement:
          role: worker
          swarm:
            maxConcurrency: 3              # ≤ maxParallel
            # 同类任务批注：仅调度语义，不合并 worktree
        review:
          role: reviewer
        test:
          role: tester
      maxParallel: 3
      roleProfiles:
        orchestrator: codex-orchestrator
        architect: grok-architect
        worker: grok-worker
        reviewer: grok-reviewer
        tester: grok-tester
```

**多 Profile 关系**（已实现能力继续生效）：

- 每角色 `allowedProfiles` 多选（Codex / Grok / 轻量 / 重任务）
- 启动时 UI 覆盖、策略默认、fallback 链不变
- explore/plan **不得**选中 `workspace-write` profile（沿用现有 schema 约束）

---

## 5. 调度状态机（相对现状的最小增量）

```text
created
  → orchestrating            # 总控
  → exploring?               # 可选，新增状态或并入 orchestrating 子阶段事件
  → architecting             # plan
  → planned / awaiting-human(plan)
  → implementing             # swarm waves of coder
       wave-k: schedule ready tasks
       each task: worktree → worker → quality → review/test → merge/rework
  → integrating / final-checks / publishing / ...
```

事件（建议）：

- `run.explore.started` / `run.explore.completed`
- `run.wave.started` / `run.wave.completed`（payload: taskIds, concurrency）
- 现有 `agent.invocation.*` 继续承载单次调用

UI：

- 活动日志：探索 / 规划 / 执行波次 用中文阶段名
- 任务图：波次高亮（可选）
- 策略编排：展示 explore 开关与 swarm 并发

---

## 6. 与 Kimi 差异：必须坚持的 Agent Team 边界

1. **Git worktree 隔离** — 并行 coder 不得共享可写目录  
2. **质量命令真退出码** — 模型自述不能覆盖  
3. **预算与熔断** — 调用次数、时长、产物、profile fallback  
4. **可审计** — SQLite 事件、检查点、审批、关联重试  
5. **人工门禁** — plan/final 可选，默认至少 final  
6. **不嵌入 Kimi 运行时** — 不把 `Agent`/`AgentSwarm` 工具链接到控制面内部循环  

---

## 7. 分阶段落地（建议）

### Phase A — 语义与观测（低风险）

- 文档与 UI 文案：将「worker 波次」标为 Swarm 波次；阶段中文对齐 explore/plan/coder  
- 事件：`run.wave.*` 投影到活动日志  
- **不改**调度算法  

**验收**：同一 run 能看出波次边界；行为与现网一致。

### Phase B — 可选 Explore 阶段

- 策略开关 + 只读 profile 校验  
- 摘要注入 architect  
- failOpen / 严格模式  

**验收**：开启后 architect 上下文含 explore 摘要；explore 无法写仓。

### Phase C — Swarm 并发旋钮与任务级 profile

- `swarm.maxConcurrency`  
- 任务级 profile 覆盖在波次内生效  
- 波次完成汇总事件  

**验收**：层内并行度可配置且不超过预算；多 Profile 切换有事件。

### Phase D —（可选）模板化「同类任务批」

- 架构输出可标记 `batchKey`；同 batchKey 且无互依赖的任务优先同波次调度  
- 对齐 Kimi「一个模板 + items」的体验，但仍是多个 worktree  

**验收**：批量无关重构任务同波次执行；有依赖则不硬并波次。

---

## 8. 明确不做（本草案范围外）

- 在 Agent Team 内嵌 Kimi TUI / 会话 resume 协议  
- 用纯对话 group-chat 替代 DAG 与质量门禁  
- 无界 128 并发或取消 maxParallel  
- explore/plan 使用 workspace-write  
- 自动把 GitHub 远端分支选择并进本草案（另案：启动时 baseBranch）  

---

## 9. 成功标准（实现后）

1. 大目标 run：可选 explore → plan → coder 波次路径可观测  
2. 并行 coder 仍每任务独立 worktree，质量门禁仍挡合并  
3. 每角色仍可切换多 Profile；explore/plan 无法越权写仓  
4. 波次并发可配置，且故障/熔断语义与现网一致  
5. 文档与 UI 不把「Swarm」宣传成第二套 Agent 框架  

---

## 10. 下一步实现入口（供开发拆任务）

| 优先级 | 改动点 | 说明 |
| --- | --- | --- |
| P0 | `docs` + UI 文案 / `run.wave` 事件 | Phase A |
| P1 | `config/schema` 增量 + runner explore 钩子 | Phase B |
| P1 | scheduler 读取 `swarm.maxConcurrency` | Phase C |
| P2 | architect schema `batchKey` + 调度亲和 | Phase D |

实现时保持：**控制面确定性优先**；Kimi 只提供「形态分离 + 批处理」的产品语义，不提供执行权威。
