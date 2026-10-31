# ADR 0018: 会话化 Agent 与数据化流程引擎（v2 核心）

- Status: Accepted
- Date: 2026-10-03

## 背景

v1 的每次 Agent 调用都是一次性的：`invokeAgent` 拉起 CLI、写入提示词、等待
`ProcessResult`。`LocalWorkflowRunner`（约 2000 行）围绕这个模型把规划、波次调度、
返工、门禁、审批和恢复写成一条固定流水线。由此产生的使用问题：

- 无法中途介入：没有可以转向、打断或回答提问的活动会话。
- 流程固定：无论任务大小都走同一条流水线。
- 过程不透明：只有 stdout 片段和最终文本，没有结构化的回合、工具调用与用量流。
- 失败处理是后加的：失败签名、Jev、架构顾问各自挂在流水线外围。
- 上手重：必须先写 yaml 并绑定 profile。

## 决策

1. **会话层。** 新增 `AgentSession`：`start / send / steer / interrupt / resume / close`，
   输出带类型的事件流（消息、工具调用、用量、提问），并声明能力集合
   `steer / interrupt / askUser / resume`。Codex 通过 `codex app-server`（JSON-RPC over
   stdio）、Claude 通过 Claude Agent SDK 获得真实会话；Grok、Kimi 保留一次性适配器，
   包装成能力全为 false 的退化会话。
2. **流程引擎。** 工作流改为数据：带类型的节点与边，条件由确定性代码求值，路由与分支
   中不含 LLM。内置 `quick`、`standard`、`full` 三个模板，由确定性路由器按目标规模与仓库
   信号选择，用户可覆盖。Jev/Laya 只能给建议，不能单独决定。
3. **账本为准。** 事件账本是唯一权威来源；`state.json` 快照降级为由账本推导的投影。
   崩溃、暂停和重启后的恢复走同一条代码路径。
4. **介入是一等 API。** 转向、打断、编辑计划、回答提问、带修改的审批都作为账本事件
   记录，并经 REST 暴露。
5. **新旧引擎并存。** v2 引擎放在特性开关后，先与 v1 并行，用同一批特征测试对照后再切
   默认并删除 `runner.ts`。

### 不变量（任何阶段都不能放松）

- 不经 shell 启动任何进程：`spawn` 直传参数数组。
- 认证令牌不进入配置、运行状态、账本或转写。
- 确定性检查可以否决 LLM 结论，LLM 不能推翻失败的命令；Jev 只能增加咨询，不能跳过
  必需的咨询。
- Git 操作可恢复：不强推，删除 worktree 前校验记录的路径与分支。
- 模型名对编排器不透明，由适配器校验。
- 浏览器不启动 Agent 进程，也不直接修改运行状态；进程所有权只属于监督器。
- 恢复仍以 Git 校验过的集成分支 HEAD 为准；会话恢复只是保留上下文的优化。

### 不采用的方案

Temporal、Inngest、LangGraph 等耐久执行框架：账本已经提供事件溯源式恢复，引入
Temporal 需要独立服务，LangGraph 以 Python 为主。借鉴其中断/恢复思想，不引入依赖。

## 后果

- 演进子系统（约 1.1 万行）与监督器、租约、HTTP 耦合较深，本 ADR 不改动其行为，只通过窄接口
  对接新引擎。
- Codex app-server 的部分方法仍属实验性：按 CLI 版本门控，并保留一次性适配器兜底；一致性
  测试在协议漂移时直接失败。
- 现有 `test/workflow.test.ts`（40 余个用例）与 `test/supervisor.test.ts` 是 v1 的特征测试，
  v2 引擎必须在同样的场景下给出同样的终态。

## 实施顺序

1. 基线（本 ADR 与不变量测试）。
2. 会话层。
3. 流程引擎与模板。
4. 介入。
5. 可靠性。
6. 可见性与成本。
7. 零配置上手。
8. 清理 v1 并全量验证。

## 补充：实际落地与偏离（Phase 8）

- **渐进替换而非重写。** 没有另起一套运行器：流程引擎、会话层、介入、可靠性、可见性逐层
  接入现有 `LocalWorkflowRunner`，并用既有特征测试对照。`engine: v1|v2` 开关仅用于并存
  对照期，已在清理阶段删除；`RunState.flow` 缺失（引擎出现之前持久化的运行）时按默认
  流水线恢复，由 `workflow-flow.test.ts` 覆盖。
- **权威划分。** Git 恢复仍以 `RunState` 与经 Git 校验的集成分支 HEAD 为准；流程进度与
  介入（`flow.*`、`agent.stalled`、`quality.flaky`、操作者消息）以事件账本为准。可见性层
  只读折叠账本，不写状态。
- **Jev「重试或咨询」节点。** 以 `flow.triage` 决策事件加模板的 `triage` 策略
  （`quick` 在同一失败重复两次后停止）实现，没有新增任务图节点类型；原有 advisor/Jev 咨询
  路径不变。
- **每任务预算为可选。** `workflow.taskBudget` 缺省不启用，超限只阻塞该任务。
- **零配置。** 无 `agent-team.yaml` 时由 `src/onboarding` 在内存中生成配置，只有用户在向导
  中保存或执行 `agent-team init` 才写文件；已有文件始终优先，并以保留注释的方式就地编辑。
- **验证范围。** Claude 会话适配器只对照假 CLI 验证；本机 Codex 凭据无效，未做经由新服务
  路径的真实 Codex 冒烟。
