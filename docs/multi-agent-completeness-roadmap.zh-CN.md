# 多 Agent 团队能力对照与完善路线

- 文档状态：建议路线，尚未实现的内容不得视为当前能力
- 对照日期：2026-08-12
- 当前产品范围：本地优先的软件开发 Agent 团队

## 1. 结论

Local Dev Agent Team 不需要替换为另一个 Python 或 .NET Agent 框架。当前系统最有价值的
部分是软件交付控制面：角色与模型解耦、Git worktree 隔离、结构化任务 DAG、独立审查与
测试、真实质量命令、持久化证据、人工审批、有界重试，以及可审计和可回滚的策略演进。

与活跃的开源多 Agent 项目相比，当前主要缺口不在“Agent 数量”，而在以下六项平台能力：

1. 模型额度、限流、认证和网络故障的分类、熔断与降级。
2. 项目级长期记忆、经验验证、检索和淘汰。
3. 标准评测集、多次重复、成本/延迟指标和防止评测过拟合。
4. 统一工具注册、MCP 授权、秘密隔离和调用审计。
5. Docker/远程执行沙箱，以及受认证的远程 Agent 委派。
6. 面向普通用户的团队模板、创建向导和自动触发器。

因此最佳方向是保留现有 TypeScript 控制面，逐层吸收其他项目成熟的能力，而不是嵌入第二套
编排运行时。所有新增自主能力仍必须经过现有预算、权限、质量命令、证据和回滚边界。

## 2. 当前能力基线

| 领域 | 当前能力 | 边界 |
| --- | --- | --- |
| 角色与模型 | 总控、架构、执行、审查、测试角色可分别绑定 CLI、模型、推理强度和权限；支持显式 fallback | 不会自动选择未授权 profile |
| 软件交付 | 架构 Agent 生成任务 DAG，Worker 在独立 worktree 实现，审查和测试角色独立判断 | 仅面向 Git 软件仓库 |
| 编排 | 支持依赖感知的并行 DAG 和强制串行拓扑 | 尚无通用条件分支、handoff 和可嵌套子图 |
| 确定性门禁 | 真实命令退出码优先于模型自述；返工、调用、时间、输出和制品均有上限 | 质量依赖项目配置的命令覆盖面 |
| 恢复与审计 | SQLite 事件账本、SSE、Git 检查点、审批记录、幂等命令和关联重试 | 进程终止后不能重新连接原 Agent CLI |
| 产品界面 | React Web 工作台与 Tauri 桌面端，可查看 DAG、日志、证据、策略和演进状态 | 当前主要服务单机、本地操作者 |
| 策略演进 | 固定目标下比较 incumbent 与候选；隔离执行；确定性评分；有界循环；自动应用更优策略并保留回滚链 | 只自动演进策略蓝图，不自动改提示词、工具、代码发布或模型权重 |
| 多项目 | 一个工作台可管理多个项目，每个项目拥有独立 supervisor、租约、账本和运行目录 | 不是分布式调度集群 |

当前自动演进是“受控的策略搜索”，不是模型训练，也不是系统无条件改写自身。这个定义必须
在 UI、README 和发布说明中保持一致。

## 3. 开源项目对照

下表把框架型项目和成品型编码 Agent 分开看。它们适合提供设计参考，不代表应直接引入为
运行时依赖。

| 项目 | 值得借鉴 | 我们已有 | 需要补齐 | 采用方式 |
| --- | --- | --- | --- | --- |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | sequential、concurrent、handoff、group collaboration、checkpoint、time-travel、HITL、MCP/A2A 和中间件 | 确定性 DAG、审批、检查点、OTLP 投影 | 条件路由、handoff、子图和统一中间件 | 借鉴抽象，不嵌入第二运行时 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | durable execution、interrupt、短期/长期记忆、状态回放和调试 | 持久账本、保守恢复、人工审批 | 独立记忆服务、精确状态回放和上下文压缩 | 在 TypeScript 控制面实现等价边界 |
| [Google ADK](https://github.com/google/adk-python) | Sequential/Parallel/Loop Agent、工具确认、Session/Artifact/Memory Service、评测集、插件和 A2A | 角色编排、制品、审批和本地事件 | 工具中心、评测实验室、记忆服务、插件生命周期 | 参考服务分层和评测接口 |
| [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) | 本机或 Docker/Kubernetes 临时工作区、Agent Server、委派、Skills | 本机 CLI、worktree、子 Agent 活动可视化 | 容器沙箱、远程执行节点、能力声明 | 优先参考执行后端抽象 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | Crew/Flow 分层、memory、knowledge source、上下文管理、缓存和速率限制 | 自主角色与确定性流程分离 | 长期记忆、知识源、请求速率与缓存治理 | 借鉴配置和运行治理 |
| [Mastra](https://github.com/mastra-ai/mastra) | TypeScript Agent、workflow、memory、RAG、eval 和 observability 的统一注册 | 同为 TypeScript，已有 workflow 和 observability | 统一资源注册、记忆和评测 API | 重点参考 TS API 设计，不整体迁移 |
| [Agno](https://github.com/agno-agi/agno) | Agent/team/workflow、共享记忆、guardrail、定时工作流和大量工具 | 团队、工作流、权限和质量门禁 | 调度器、知识服务和模板生态 | 参考 AgentOS 的普通应用分层 |
| [ChatDev 2.0](https://github.com/OpenBMB/ChatDev) | 零代码画布、YAML 工作流、模板库、实时执行和 evolving orchestration 研究 | 策略工作台、DAG、自动策略循环 | 一键模板、通用节点、经验复用和更丰富的候选搜索 | 参考产品体验与候选生成，不复制运行时 |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT) | `Code = SOP(Team)`、产品/架构/项目/工程角色及标准化阶段产物 | 架构、执行、审查、测试角色和结构化协议 | 需求、设计、API、迁移等可复用交付物模板 | 将 SOP 做成可验证团队模板 |
| [CAMEL](https://github.com/camel-ai/camel) | 大规模 Agent、动态通信、记忆和 benchmark | 小规模有界并发 | 大规模仿真和标准 benchmark | 只借鉴评测方法，当前不追求 Agent 数量 |
| [AutoGen](https://github.com/microsoft/autogen) | 事件驱动 runtime、group chat、Studio 和 benchmark | 控制面/UI 分离 | 无需追随其旧 runtime | 项目已进入维护模式，仅保留历史参考 |

已有更细的设计来源记录见[开源多 Agent 框架对照与补缺](ecosystem-review.md)。

与 **Kimi Code CLI** 的 explore / plan / coder 分离及 AgentSwarm 批任务对照，见：
[Kimi explore/plan/coder + Swarm → Agent Team 映射](kimi-explore-plan-coder-swarm-mapping.zh-CN.md)
（配置 / runner / UI 已落地；保留 worktree、质量门禁、多 Profile 与控制面权威）。

## 4. 能力差距与优先级

### P0：模型故障治理

当前 profile 调用失败后会按配置尝试 fallback，全部失败则阻塞任务或运行。供应商额度耗尽、
429、认证失败、网络错误和模型不存在尚未形成稳定错误分类，因此自动演进可能把基础设施故障
当作普通失败或“无提升”。

需要增加：

- 稳定错误码：`MODEL_QUOTA_EXHAUSTED`、`MODEL_RATE_LIMITED`、
  `MODEL_AUTH_FAILED`、`MODEL_UNAVAILABLE`、`MODEL_NETWORK_ERROR`。
- profile/provider 健康状态、退避时间和熔断状态；只能按策略恢复探测，不能永久静默禁用。
- fallback 必须继续遵守角色 allowlist、权限和 external-tools 边界。
- 配额耗尽时自动演进进入 `paused` 或明确的 `failed`，不得记为策略质量下降，也不得继续消耗
  无提升轮次。
- UI 展示失败分类、当前 fallback、下一次重试时间和用户可执行动作。

### P0：评测实验室

一个固定 `evaluationGoal` 容易偶然通过，也容易对单任务过拟合。要证明策略真的变好，需要
项目拥有版本化评测套件：

- 多个代表性任务，区分公开任务、隐藏回归任务和安全负向任务。
- 每个任务绑定允许修改路径、确定性质量命令、超时和资源预算。
- 支持 1 至有限次数的重复执行，聚合最差值、中位数和方差。
- 指标至少包含通过率、任务完成率、返工次数、调用次数、耗时、额度/成本和回滚率。
- incumbent 与 candidate 使用相同代码基线、任务集、环境和评测版本。
- 结果绑定 suite digest、代码 commit、策略 digest、profile identity 和运行证据。
- proposer、candidate 和普通浏览器不能读取隐藏答案或修改评测定义。

### P1：验证后经验记忆

长期记忆不能直接收录模型总结。建议建立三层存储：

```text
运行事实层：不可变 run / task / command / review 证据
  -> 候选经验层：从成功和失败轨迹提炼，但默认不参与执行
  -> 已验证知识层：在独立评测中证明有效后，才能被检索使用
```

每条经验至少记录项目范围、适用条件、来源 run、验证 suite、有效版本、敏感级别、命中次数、
成功率和失效原因。代码和依赖发生重大变化后应衰减或重新验证。删除、合并和晋升必须可审计。

### P1：工具中心与 MCP Host

当前 MCP 主要由具体 CLI 管理。完善后的控制面应使用官方 SDK 建立工具注册表，但不能让 MCP
成为另一个编排控制器：

- 记录 server 身份、版本、能力和信任状态。
- 按角色/profile 设置工具 allowlist，而不是全局开放。
- 对写文件、执行命令、网络发布、读秘密等敏感工具提供参数预览和逐次/会话授权。
- 凭据只交给被授权工具，不能写入 prompt、run JSON 或前端状态。
- 工具调用进入统一预算、超时、取消、输出限制和事件账本。
- 支持确定性 mock/replay，供评测和回归测试使用。

### P1：执行后端与沙箱

把当前本机进程抽象为 `ExecutionBackend`，逐步支持：

1. `local-process`：保持当前默认，适合可信本地仓库。
2. `docker`：临时容器、只挂载必要目录、默认断网、资源硬限制。
3. `remote-agent`：经过认证的远程节点，使用能力清单和短期委派凭证。

Git worktree 仍是代码合并与证据单位；容器只是运行隔离层，不能取代 Git 身份和质量门禁。

### P2：编排语言和团队模板

先扩展后端编译模型，再扩展画布。建议增加：

- 条件节点：仅能读取版本化结构化输出和确定性结果。
- 有界循环节点：必须声明最大轮数、预算和停止条件。
- handoff：显式传递任务、上下文摘要和责任角色。
- 子团队/子图：拥有独立预算，结果以结构化协议返回父图。
- role pool：在同一权限范围内按健康、额度、延迟和成本选择 profile。

面向用户提供“修复 Bug、开发功能、依赖升级、安全审查、性能优化、文档维护”等模板。模板
必须同时包含角色、拓扑、权限、质量门禁和预算，不能只是一组提示词。

### P2：触发器与远程协作

- 本地定时任务、GitHub Issue/PR、Webhook 和手动运行统一转成持久 command。
- 每个触发器配置并发上限、预算、允许目标和审批策略。
- 完成 HTTPS、身份认证、租户隔离、秘密服务和授权委派后，才开放 A2A 与远程 Worker。
- 默认仍不自动合并 PR；自动发布和自动合并必须是独立策略能力。

## 5. 自我进化目标架构

完整的自我进化不能只生成一个候选并在一个任务上重跑。建议采用 Champion/Challenger：

```text
版本化评测套件 + 当前 Champion
  -> 只读 proposer 从已验证经验生成多个受约束 Challenger
  -> 静态预检：schema、权限、预算、拓扑和目标范围
  -> 隔离重复执行公开、隐藏和安全评测
  -> 确定性评分 + 稳定性/成本惩罚
  -> 独立 critic 分析失败，但不能修改分数
  -> 达标 Challenger 晋升，保留 application proof 与回滚链
  -> 观察窗口内出现回归则自动回滚
  -> 只有跨任务验证有效的规律进入已验证经验库
```

演进对象按风险分级：

| 等级 | 演进对象 | 建议自动化程度 |
| --- | --- | --- |
| L1 | 并发、返工、角色 profile、审批等待等策略蓝图 | 当前已有，可自动但有硬上限 |
| L2 | 角色提示词片段、上下文选择和经验检索规则 | 先候选评测，默认人工确认 |
| L3 | 团队拓扑、条件路由、工具 allowlist | 需要隐藏评测与安全回归，默认人工确认 |
| L4 | 新工具实现、控制面代码和发布逻辑 | 只能生成普通代码 PR，必须走完整交付和人工合并 |
| L5 | 模型权重训练或在线强化学习 | 当前项目不负责，应由独立训练系统处理 |

任何级别都不能修改自己的评测答案、证据账本、权限上限、预算上限或回滚机制。模型理由只能
解释结果，不能替代确定性分数。

## 6. 建议版本路线

版本仅表示推荐拆分，最终发布号应在实施时确定。

| 建议阶段 | 目标 | 最小验收标准 |
| --- | --- | --- |
| `0.1.x` | 模型故障治理 | 额度/限流/认证/网络分类；跨 provider fallback；自动演进遇到额度问题停止消耗轮次；UI 可操作提示 |
| `0.2` | 评测实验室 | 多任务 suite、隐藏任务、重复评测、版本化证据、成本与稳定性指标、Champion/Challenger |
| `0.3` | 经验记忆 | 事实/候选/已验证三层存储；检索、衰减、重验证、删除和审计；无未经验证的自动注入 |
| `0.4` | 工具和沙箱 | MCP 工具注册与授权、统一审计；Docker 后端；网络和秘密默认隔离 |
| `0.5` | 编排与模板 | 条件、有界循环、handoff、子团队、role pool；团队模板与向导；**全局 CLI 检索 + 设置默认 + 新建运行角色选型**（见 [global-cli-inventory-and-role-picker.zh-CN.md](global-cli-inventory-and-role-picker.zh-CN.md)，当前未实现；背景 [multi-profile-flexibility.zh-CN.md](multi-profile-flexibility.zh-CN.md)） |
| `1.0` | 远程团队平台 | HTTPS、身份与租户隔离、远程执行节点、A2A、触发器、升级与恢复手册 |

每个阶段都应继续使用“实现 -> 自动测试 -> 独立复审 -> 最小修复 -> 重测 -> 文档与提交”的
交付循环，不能为了扩充功能绕过现有安全边界。

### 已确认的延后加固项（2026-08-13 全量审查结论）

以下三项属于新能力而非缺陷修复，需各自设计评审后单独排期，细节见
[security.md](security.md) 的「Known Limitations And Planned Hardening」：

1. **审批第二因素**：per-approval nonce 或 Tauri 原生审批通道，根治「agent 持会话
   token 自批门禁」这一类问题（当前缓解：子进程 env 剔除 + token 文件 + repair 人工确认）。
2. **Windows 子进程组查杀**：POSIX process group 的 SIGTERM/SIGKILL 升级在 Windows 只杀
   直接子进程，孙进程可能泄漏；macOS/Linux 不受影响。
3. **同 uid 本机边界**：0600 token 文件只隔离其他 OS 用户；彻底的同 uid 隔离依赖独立
   OS 账户或容器沙箱（对应 `0.4` 工具和沙箱阶段）。

## 7. 明确不做

- 不用更多 Agent 数量代替任务拆分质量、上下文质量和确定性验证。
- 不因画布方便而让浏览器直接启动子进程、修改证据或提交应用内容。
- 不默认开放全部 MCP 工具、网络或本机秘密。
- 不让 Agent 修改自己的评分函数、隐藏评测或预算上限。
- 不把单次评测胜出宣传成长期能力提升。
- 不为获得某个项目的 UI 或 memory 功能而同时运行两套编排状态机。
- 不默认根据本机已安装的 Codex / Claude / Kimi / Grok **静默改写**各项目 `agent-team.yaml`（多 Profile 应以项目配置为权威；用户模板与探测仅为可选增强，见 [multi-profile-flexibility.zh-CN.md](multi-profile-flexibility.zh-CN.md)）。

## 8. 第一批实施任务

建议下一阶段先完成以下三个垂直切片：

1. `ProviderFailureClassifier`：错误分类、健康状态、熔断、fallback 事件和 UI 状态完整贯通。
2. `EvaluationSuite v1`：先支持 YAML 定义的 3 至 10 个项目任务、版本 digest、重复执行和聚合报告。
3. `ExperienceCatalog v1`：只接收已完成 run 的候选经验，先实现人工晋升和检索审计，不立即自动写入 prompt。

> 实施进度（2026-08-12）：`ExperienceCatalog` 已落地项目库 + `~/.agent-team/experience/shared` 公共库；终态 run 规则化抽取 candidate；仅 **verified** 可注入总控/架构规划上下文；`promote` / `reject` / `share` HTTP API 可用。仍不自动把 candidate 写入 prompt，跨项目共享需人工 `share`。

这三个切片完成后，系统才具备从“自动循环”进入“用可信历史持续改善”的基础。
