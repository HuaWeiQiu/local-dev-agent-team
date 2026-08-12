# Local Dev Agent Team

一个面向软件开发的本地优先多 Agent 协作编排器。

它直接复用你电脑上已经安装并登录的 Agent CLI，让总控、架构、工作、
审查和测试角色分别选择自己的 CLI、模型、推理强度与权限配置。

```text
开发目标
  -> 总控 Agent 分析需求
  -> 架构 Agent 拆分任务 DAG
  -> 一个或多个工作 Agent 在独立 Git worktree 中实现
  -> 确定性命令 + 审查 Agent + 测试 Agent
  -> 有次数上限的返工
  -> 集成分支
  -> GitHub 草稿 PR
  -> 人工确认合并
```

项目最重要的设计原则是：

```text
角色 != Agent CLI != 模型
```

例如，架构师可以使用 Codex，审查员可以使用 Claude Code，不同工作任务也
可以选择不同模型。更换模型不需要修改角色和工作流代码。

## 主要能力

- 一个总控 Agent，负责目标分析、最终裁决和流程控制。
- 一个架构 Agent，负责生成带依赖关系的任务 DAG。
- 一个或多个工作 Agent，可以并行处理路径互不冲突的任务。
- 独立的审查 Agent 和测试 Agent，不允许工作 Agent 自己批准自己的修改。
- 每个工作任务使用独立 Git 分支和 worktree，不直接修改主工作区。
- 计划、审查结论、测试结论和最终决策都使用结构化数据协议。
- 项目测试命令是真实进程和硬性门禁，Agent 不能把失败的测试说成成功。
- 返工、并发数、进程时间和 CI 修复次数都有明确上限。
- 可以创建 GitHub 草稿 PR、等待 Actions 检查并执行一次受限修复。
- 不自动合并代码，最终合并必须由人确认。
- 提供 React/Tauri 演进工作台：人工候选保留结构预检与精确确认；可选的项目级自动策略循环会在固定目标上隔离评测、按确定性分数自动应用更优策略，并受轮数、连续无提升和手动停止硬限制。
- **经验库**：运行终态抽取候选 → 人工/评测晋升为已验证 → 可共享到本机公共目录；规划与返工会注入已验证经验（默认不注入候选）。
- **运行历史清理**：支持单条删除终态运行，以及按保留天数批量清理。
- **可选外挂质量门**：可把已安装的 CLI（例如阿里 `ocr review`）写进 `quality.commands`，不内嵌第二套评审引擎。

当前内置以下 CLI 适配器：

- [Codex CLI](https://developers.openai.com/codex/cli)
- Claude Code
- Grok CLI

适配器边界是开放的，后续可以增加其他支持非交互调用的 Agent CLI。

## 运行条件

- Node.js 24 或更高版本。
- pnpm 和 Git。
- 至少安装并登录一个受支持的 Agent CLI。
- 使用 GitHub 发布功能时，需要安装并登录 GitHub CLI `gh`。

本项目不会读取、复制或保存模型供应商的 API Key。子进程直接复用各个
Agent CLI 自己的本地登录状态和配置。

## 安装

```bash
git clone https://github.com/HuaWeiQiu/local-dev-agent-team.git
cd local-dev-agent-team
pnpm install
pnpm build
npm link
```

安装后验证：

```bash
agent-team --version
```

如果不希望创建全局命令，也可以在本仓库中使用：

```bash
pnpm dev <命令>
```

## 快速开始

进入你希望 Agent 团队修改的软件项目：

```bash
cd /path/to/your-project
agent-team init
```

这会生成 `agent-team.yaml`。编辑其中的 Agent profile、角色映射和项目测试
命令，然后执行：

```bash
agent-team validate
agent-team profiles
agent-team interop
agent-team doctor
```

`doctor` 默认只检查 CLI、登录状态和能力，不会调用模型。如果还要确认某个
配置的模型确实可用，可以主动探测：

```bash
agent-team doctor --profile grok-worker --probe-models
agent-team doctor --profile codex-orchestrator --probe-models
```

主动探测会发起一次很小的真实模型请求，因此可能消耗少量额度。

开始一次开发任务：

```bash
agent-team run --goal "为用户列表接口增加游标分页"
```

查看运行状态：

```bash
agent-team status
agent-team status <run-id>
```

启动本地控制服务：

```bash
agent-team serve
```

服务默认只监听 `http://127.0.0.1:4317`。在浏览器打开这个地址即可使用 React
工作台：可视化预检和保存执行策略、选择角色 profile、启动或取消运行、查看任务
DAG、交付证据、审查结果、质量命令和实时角色状态/输出；活动日志中的「角色」
页会直接列出总控、架构、执行、审查、测试等受控调用及其完成状态。新建运行或
规划阶段默认打开活动日志，便于观察过程。阻塞、取消或中断的运行可以删除、从
检查点继续，或作为新的关联运行重试。侧栏「经验」可晋升/拒绝/共享经验条目。
界面保存的策略位于项目状态目录，不会改写 `agent-team.yaml`，并且
可以通过工作台或 `agent-team run --strategy <name>` 执行。

同一个服务还提供 REST 命令和带游标的 SSE 事件流。运行元数据和幂等命令保存在
`.agent-team/control.sqlite`，大型日志、上下文、diff 和测试制品继续保存在
`.agent-team/runs/`。同一项目同时只允许一个控制服务持有运行租约，浏览器不会
直接创建本地进程或修改运行状态。

控制锁的完整所有者记录会先落盘，再原子发布为 `.agent-team/control.lock`。若进程异常
退出后留下有效但已失效的锁，先确认对应 PID 和该项目的控制服务均未运行，再手动删除该
文件；内容损坏或不完整的锁同样会 fail closed，不会被新服务自动抢占。

一个工作台也可以安全管理多个项目。创建 `agent-team.workspace.yaml`：

```yaml
version: 1
projects:
  - id: frontend
    config: ./frontend/agent-team.yaml
  - id: backend
    config: ./backend/agent-team.yaml
```

路径相对工作区清单解析。验证并启动：

```bash
agent-team validate --workspace ./agent-team.workspace.yaml
agent-team serve --workspace ./agent-team.workspace.yaml
```

页面顶部可以切换项目。每个项目仍拥有独立的 supervisor、进程租约、SQLite
事件账本、运行目录、worktree 和制品；所有命令与 SSE 都带项目作用域，不会把
一个仓库的运行发送到另一个仓库。工作区是声明式配置，修改项目列表后需要重启服务。

## Web 工作台使用

### 1. 启动前检查

在需要被 Agent 修改的项目目录中确认存在 `agent-team.yaml`，然后执行：

```bash
agent-team validate
agent-team profiles
agent-team doctor
```

- `validate` 检查配置、角色、策略和质量命令是否合法。
- `profiles` 显示每个角色实际使用的 CLI、模型和权限。
- `doctor` 检查 CLI 是否安装、是否已经登录，以及当前适配器能力。

确认无误后启动控制服务：

```bash
agent-team serve
```

终端出现下面的信息后，在浏览器打开对应地址：

```text
Agent Team control service: http://127.0.0.1:4317
```

控制服务运行期间不要关闭这个终端。它是 Agent 进程、运行状态、审批和事件流的
唯一控制者；浏览器只是操作界面。

### 2. 创建一次运行

1. 点击右上角“新建运行”。
2. 在“目标”中写清需要修改的功能、范围和验收要求。
3. 选择执行策略，例如 `balanced` 或 `strict`。
4. 如有需要，展开“角色 Profile 覆盖”，只为本次运行调整角色使用的 profile。
5. 点击“启动运行”。

一个适合直接使用的目标示例：

```text
为订单退款接口增加幂等控制；不得修改数据库公共迁移框架；补齐单元测试和接口测试；
pnpm check、pnpm test、pnpm build 必须全部通过。
```

目标应该描述业务结果和约束，不需要手工指定 Agent 之间如何分工。架构 Agent 会先
生成任务 DAG，控制面再按策略、依赖和路径所有权调度 Worker。

### 3. 查看运行过程

运行工作台由五个区域组成：

| 区域 | 用途 |
| --- | --- |
| 左侧运行列表 | 搜索、筛选、切换历史；终态运行可单条删除；顶部可批量清理 |
| 任务图 | 查看任务依赖、并行分支、当前状态和尝试次数；失败时显示人话原因 |
| 活动日志 | 角色调用、活动时间线、stdout/stderr；规划/早失败时默认打开 |
| 交付证据 | 汇总任务集成、质量门禁、最终判定、审批、集成 diff 和本地产物 |
| 右侧检查器 | 运行策略、用量、审批，或所选任务的分支、提交、质量命令和审查结论 |
| 经验（侧栏） | 候选/已验证/公共经验：晋升（可一键填入最近评测 suiteDigest）、拒绝、共享到本机公共库、退役已验证经验；支持按目标文本检索预览将注入的经验 |

点击任务节点会打开该任务的证据详情。任务图中的连线表示真实依赖关系；没有依赖且
负责路径不冲突的任务，才可能并行执行。

页面右上角会根据运行状态显示可用操作：

- “取消”：终止仍在执行的运行；停在“等待人工”（待审批）或被服务恢复为
  “已中断”的运行也可直接取消为终态。
- “处理审批”：批准或拒绝计划、交付审批，必须填写操作者和理由。
- “从检查点继续”：服务中断后，从最近一个经过 Git 校验的检查点继续。
- “重试为新运行”：为阻塞、取消或中断的运行创建新的关联运行，不改写原运行证据。

移动端底部提供“运行、编排、任务图、详情、日志、证据”等视图，另可进入演进与经验。
移动端 DAG 会按依赖层级重新排列，但不会把并行任务错误显示成串行任务。

### 4. 配置执行策略

点击左侧主导航“编排”进入策略工作室：

1. 从顶部策略选择器切换已有策略。
2. 点击“策略库”查看项目策略和可用阶段。
3. 点击“策略设置”编辑蓝图名称、拓扑、并行上限、返工上限、Agent 调用上限、
   计划审批和角色 profile。
4. 点击“预检”，让服务端编译并校验当前草稿。
5. 点击“保存”，将蓝图保存为项目本地的自定义策略。

这里是兼容原有工作流的手工策略编辑入口，不会创建演进 proposal 或评估证据；需要审计、
预览、晋升与回滚链时，应使用下文的受控演进流程。
6. 保存成功后点击“运行”，用该策略创建新运行。

`parallel-dag` 允许满足依赖和路径隔离条件的 Worker 并行执行；`sequential` 强制
Worker 串行执行。启用“计划审批”后，架构 Agent 生成计划时会暂停，只有人工批准
后才会启动 Worker。

策略画布显示的是服务端编译后的真实生命周期，不是可以绕过后端约束的任意流程图。
当前固定阶段包括目标分析、任务规划、任务执行、集成质量门禁、交付决策、交付审批
和发布边界；计划审批是可选阶段。

配置文件中的策略是只读来源。在界面修改并保存时，会创建或更新项目状态目录中的
自定义蓝图，不会改写 `agent-team.yaml`。自定义策略也可以在 CLI 中使用：

```bash
agent-team run --goal "重构支付回调" --strategy <自定义策略名称>
```

### 5. 审批、恢复和发布

使用 `strict` 或启用了计划审批的策略时，先在“处理审批”中核对任务拆分，再批准
Worker 开始执行。所有任务、质量命令和审查通过后，还需要处理最终交付审批。

如果控制服务或主机在运行中断开，重新启动 `agent-team serve`，选择状态为“已中断”
的运行并点击“恢复”。系统只会从经过验证的 Git 检查点继续；未完成 Agent 进程不会
被伪装成仍在运行。

最终审批通过后，可以在终端创建并检查 GitHub 草稿 PR：

```bash
agent-team publish <run-id> --wait
agent-team checks <run-id> --watch
```

本项目不会自动合并 PR。确认远端检查和交付内容后，由人完成合并，再记录运行完成：

```bash
agent-team complete <run-id>
```

### 6. 清理本地运行历史

运行列表标题右侧的清理按钮只管理项目状态目录中的旧运行证据。先选择保留天数并
生成候选预览，再确认删除。系统只会列出超过保留期限的 `completed`、`cancelled`
和 `blocked` 运行；中断、待审批、待发布、CI 失败和修复中的运行不会进入候选列表。
已经被关联重试引用、或正在创建关联重试的父运行也会保留，避免新运行失去来源证据。

确认后会删除候选运行的状态、Agent 输出、质量日志、上下文、diff 等本地制品，以及
SQLite 中对应的事件。仓库、Git 分支、worktree、配置和自定义策略不会被清理。删除
不可撤销，因此应先在“交付证据”视图核对仍需保留的记录。

### 7. 停止工作台

没有活动运行时，在启动控制服务的终端按 `Ctrl+C` 即可安全关闭。关闭浏览器页面不会
停止控制服务。若在 Agent 执行期间关闭控制服务，运行会被标记为中断，之后需要按
上面的检查点恢复流程处理。

## 分别选择 CLI 和模型

`agent-team.yaml` 中的 profile 决定使用哪个 CLI 和模型：

```yaml
profiles:
  codex-orchestrator:
    adapter: codex
    model: gpt-5.6-sol
    reasoning: max
    permission: read-only
    externalTools: deny
    timeoutSeconds: 1800

  codex-architect:
    adapter: codex
    model: gpt-5.6-sol
    reasoning: xhigh
    permission: read-only
    externalTools: deny
    timeoutSeconds: 1800

  grok-worker:
    adapter: grok
    model: grok
    reasoning: high
    permission: workspace-write
    externalTools: deny
    maxTurns: 16
    timeoutSeconds: 3600

  codex-reviewer:
    adapter: codex
    model: gpt-5.6-sol
    reasoning: xhigh
    permission: read-only
    externalTools: deny
    timeoutSeconds: 1800

  codex-tester:
    adapter: codex
    model: gpt-5.6-sol
    reasoning: high
    permission: read-only
    externalTools: deny
    timeoutSeconds: 1200
```

模型字段有两种写法：

- `model: inherit`：使用该 CLI 当前配置的默认模型。
- `model: 模型名称`：把名称明确传给该 CLI。

模型必须已经能在对应 CLI 中使用。本项目不会绕过 CLI 自己的账号、权限和
模型可用性限制。

模型名属于各自的 CLI，不能混用：Codex 角色使用 `gpt-5.6-sol`，Grok 执行者使用
`grok`。上面的配置不需要 Claude Code API Key，也不会调用 Kimi CLI。

`externalTools` 默认是 `deny`：Codex 忽略用户配置并将本次运行的项目配置标记为
不受信任（登录状态仍保留），Claude Code 使用严格空 MCP 配置；Grok 保留已认证的
`GROK_HOME`，但把普通用户目录切到本次调用的临时目录，因此不会发现用户目录中的
兼容 MCP，同时禁用记忆、子 Agent 和 Web 工具。只有显式设置为
`inherit` 时，Agent 才会继承
对应 CLI 自己的 MCP 配置。凭据、server 生命周期和工具授权仍由 CLI 管理，本项目
不保存 MCP 凭据，也不把 MCP 工具变成控制面命令。由于外部工具不保证服从 CLI
的文件沙箱，只有 `workspace-write` Worker profile 可以设置 `inherit`；只读
profile 必须保持 `deny`。Codex 的 deny 模式也不读取用户模型/provider 配置，
`model: inherit` 会使用 CLI 内置默认值；需要固定模型时请显式填写 `model`。
`nativeProfile` 依赖用户配置，因此只能和 `externalTools: inherit` 一起使用。

Grok Worker 的 `maxTurns` 可配置，本仓库设为 16。行为约束不写死在适配器中，
而由 `roles.worker.promptFile` 指向的提示词文件控制；当前文件要求它只完成一个任务、
只修改声明路径、先读测试、检查通过后立即停止。`balanced` 策略最多返工 1 次，
`strict` 最多返工 2 次；Grok 自己声称“完成”不会跳过 Codex 审查或确定性质量命令。

角色再引用允许使用的 profile：

```yaml
roles:
  orchestrator:
    defaultProfile: codex-orchestrator
    allowedProfiles: [codex-orchestrator]

  architect:
    defaultProfile: codex-architect
    allowedProfiles: [codex-architect]

  researcher:
    defaultProfile: codex-researcher
    allowedProfiles: [codex-researcher]
    promptFile: prompts/researcher.md

  worker:
    defaultProfile: grok-worker
    allowedProfiles: [grok-worker]
    promptFile: prompts/grok-worker.md

  reviewer:
    defaultProfile: codex-reviewer
    allowedProfiles: [codex-reviewer]

  tester:
    defaultProfile: codex-tester
    allowedProfiles: [codex-tester]
```

必需角色包括：

- `orchestrator`：总控
- `architect`：架构
- `worker`：工作
- `reviewer`：审查
- `tester`：测试

可选一等角色：

- `researcher`：技术研究员（只读调研；开启 explore 时优先使用；缺省时回退到架构）

也可以只对本次运行临时覆盖角色 profile：

```bash
agent-team run \
  --goal "为用户列表接口增加游标分页" \
  --profile architect=codex-architect \
  --profile worker=grok-worker
```

所有覆盖都必须符合该角色的 `allowedProfiles`，不会静默使用未授权的 profile。
只有 `worker` 角色可以允许 `workspace-write` profile；总控、架构、审查、测试和
自定义非 Worker 角色都必须只允许只读 profile。用于适配器诊断的 `agent-team
invoke` 也始终拒绝写权限 profile，避免直接修改主工作树。

查看可机器校验的适配器和协议边界：

```bash
agent-team interop --json
curl http://127.0.0.1:4317/api/interop
```

工作区模式使用 `/api/projects/<project-id>/interop`。MCP `2026-07-28` 当前是
profile 控制、CLI 执行；A2A `1.0` 在具备 HTTPS、认证和授权网关前明确禁用。

## 命名执行策略

策略把一组 Agent 路由和运行限制保存为可复用配置：

```yaml
strategies:
  default: balanced
  definitions:
    balanced:
      maxParallel: 2
      maxReworkAttempts: 2
      executionTimeoutSeconds: 14400
      maxAgentInvocations: 64
      maxProcessOutputBytes: 1048576
      maxArtifactBytes: 1073741824
      approvalGates: [final]
      approvalTimeoutSeconds: 86400
      roleProfiles: {}

    strict:
      maxParallel: 1
      maxReworkAttempts: 3
      executionTimeoutSeconds: 21600
      maxAgentInvocations: 96
      maxProcessOutputBytes: 1048576
      maxArtifactBytes: 2147483648
      approvalGates: [plan, final]
      approvalTimeoutSeconds: 172800
      roleProfiles:
        orchestrator: codex-orchestrator
        architect: codex-architect
        worker: grok-worker
        reviewer: codex-reviewer
        tester: codex-tester
```

为单次运行选择策略：

```bash
agent-team run --goal "重构支付回调" --strategy strict
```

解析优先级是本次运行的 `--profile` 覆盖、策略中的 `roleProfiles`、角色默认
profile。策略不能选择角色 `allowedProfiles` 之外的 profile。未配置策略的旧
项目仍然使用 `project.maxParallel` 和 `quality.maxReworkAttempts`。`final` 审批
门不可移除；`plan` 审批门可让工作 Agent 在人工确认任务拆分后才开始执行。

`executionTimeoutSeconds` 限制一次活动执行段，等待人工审批不计时；恢复后重新开始
执行段，但 `maxAgentInvocations` 调用总数和 `maxArtifactBytes` 制品用量继续累计。
`maxProcessOutputBytes` 分别限制每个子进程的 stdout、stderr 捕获量，超出部分会被
截断但子进程仍会被完整排空。执行时限、调用次数或制品超限会阻断运行；界面会
显示调用数、耗时、输出、制品和截断次数。

只有 Agent CLI 明确返回时才记录 token 和美元成本，不按模型名称推算价格。跨
供应商的硬成本边界使用调用次数，而不是可能失真的估算金额。

事件保留量是项目级配置：

```yaml
observability:
  maxEventsPerRun: 50000
```

每个事件都带稳定 trace/span ID；`GET /api/runs/<run-id>/telemetry`（工作区模式
使用对应的项目作用域路径）可导出 OTLP/HTTP JSON。导出只读且不会主动发送到
外部服务。

工作台的 `Agent` 活动视图由 `agent.invocation.*` 和有界的
`agent.children.updated` 事件重建。直属行表示 Agent Team 自己启动的 profile 调用；若
Codex CLI 返回原生子代理生命周期，子代理会缩进显示在线程所属调用下。子代理摘要只保留
线程 ID、可用的代理路径、状态和模型元数据，不复制 prompt、消息正文或加密内容。

这个监控边界刻意限制在当前控制服务拥有的运行内：它不会扫描 `~/.codex`，也不会把另一个
终端中的交互式 Codex 会话冒充成当前项目的子代理。Codex 适配器仍使用隔离的 ephemeral
调用；Agent Team 的多角色并行由控制器直接启动、计入调用预算并显示为直属行。未来 Codex
CLI 在该隔离模式下提供原生子代理事件时，现有解析器会显示它们，但不会把它们当成第二套
Agent Team。

## 项目测试门禁

在配置文件中声明项目必须通过的真实命令：

```yaml
quality:
  commands:
    - command: pnpm
      args: [check]
    - command: pnpm
      args: [test]
    - command: pnpm
      args: [build]
  maxReworkAttempts: 2
  commandTimeoutSeconds: 900
```

命令不会经过 shell 拼接，每个参数都必须单独写入 `args`。管道、重定向和
`&&` 等 shell 语法不会被解释。

只要任意确定性命令返回非零退出码，该任务就不能通过，即使审查 Agent 或
测试 Agent 声称修改没有问题。

## GitHub 工作流

本地运行通过后，状态会停在 `awaiting-human`，不会自动发布或合并。React 工作台
可以直接处理审批；CLI 可先查看请求 ID，再提交带操作者和理由的决定：

```bash
agent-team status <run-id>
agent-team approval <run-id> \
  --request <approval-id> \
  --decision approved \
  --actor "release-owner" \
  --reason "已核对集成 diff 和本地门禁"
```

拒绝时使用 `--decision rejected`，运行会进入 `blocked`。批准计划审批后，同一个
run 会从计划检查点继续；批准最终审批后状态变为 `ready-to-merge`，才允许发布。

控制服务意外中断时，只能从已验证的任务边界恢复：

```bash
agent-team resume <run-id> \
  --actor "operator" \
  --reason "主机重启，恢复最近已合并波次"
```

恢复前会核对 integration worktree 的 Git HEAD。未完成波次的旧分支和 worktree
会保留为审计证据，任务改用新的 `resume-N` 分支重跑；不会伪装成续接已终止的
Agent CLI 进程。

创建草稿 PR 并等待 GitHub Actions：

```bash
agent-team publish <run-id> --wait
```

刷新或持续等待检查结果：

```bash
agent-team checks <run-id> --watch
```

只有 GitHub 检查失败后才能运行受限修复：

```bash
agent-team repair <run-id>
```

人工合并 PR 后记录完成状态：

```bash
agent-team complete <run-id>
```

`repair` 有次数上限，并且默认禁止修改 GitHub Actions 工作流和
`agent-team.yaml`。修复仍然必须重新通过项目命令、审查和测试门禁。推送修复提交前
会打印远端、分支、提交说明和变更文件清单并要求人工确认；非交互会话拒绝推送，
需显式传 `--yes`（`agent-team repair <run-id> --yes`）。

## 安全默认值

- 总控、架构和审查角色默认只读。
- Codex 只读角色使用只读 sandbox。
- Claude 只读角色使用 plan 模式，并只开放读取、文件匹配和搜索工具。
- 工作 Agent 只能在隔离 worktree 中获得写权限。
- Agent CLI 参数使用参数数组直接启动，不通过 shell 拼接。
- 模型、权限、工作目录和结构化输出参数不能被 profile 的额外参数覆盖。
- 运行状态和 Agent 上下文保存在 `.agent-team/`，并默认被 Git 忽略。
- 不执行自动合并或强制推送。

## 受控演进工作台（Phase 1-6）

`agent-team serve` 会生成本地会话 token，并输出可直接打开的 bootstrap URL。演进接口
只监听 loopback；读接口要求该本地会话，写接口还要求浏览器发送与实际监听地址完全
一致的 `Origin`。浏览器不能提交 proposal ID、policy、目标路径、摘要、操作者、证据或
应用内容。

人工流程是：创建策略/提示词候选 → 服务端结构与安全预检 → 查看精确 before/after →
填写理由并人工确认晋升 → 必要时预览并人工回滚。预检证据固定绑定当前 proposal 与
candidate digest；它只证明 schema、当前信任、提示词对象完整性和 Git 目标安全，**不代表
候选已在 Agent 运行中执行，也不代表行为质量通过**。任意历史 run 不能作为晋升证据。
评估来源以 `server-structural-preflight-v1` 持久化；升级前的外部评估会标记为 `external`，
不能通过 Phase 4 的晋升入口冒充当前预检。

启动服务并使用输出的 `Open in browser` 地址建立本地会话后，在左侧主导航进入“演进”：

1. 点击“新建”，选择执行策略或角色提示词；路径、摘要、policy 和 proposal ID 均由服务端生成。
2. 在候选详情中运行“结构预检”。界面会明确显示该结果**不代表候选已经执行**。
3. 预检通过后点击“查看并应用”，核对服务端返回的完整当前值和应用后值，填写决定理由再确认。
4. 已应用且具备恢复证明的候选可继续“预览回滚”；旧版本已晋升候选只提供精确匹配后的“采纳当前目标”。

桌面端提供候选、详情和下一步三栏视图；手机端使用候选列表/详情单页切换。项目切换、
目标修订变化或预览过期会销毁旧预览，所有 mutation 完成后均重新读取服务端状态，不做
目标状态的乐观伪更新。

晋升和回滚使用项目级 mutation latch，与运行启动、继续、审批和策略直改互斥；相同命令
可安全重放。服务关闭时先封闭并排空所有演进操作，再释放项目控制锁。React/Tauri
工作台只调用该窄控制面。

### 自动策略循环

在 `agent-team.yaml` 显式启用 `evolution.automatic` 后，工作台顶部会显示“自动演进”控制带。
选择 1 至项目配置上限的循环次数并点击“开始”，系统会自动完成：

```text
配置基线（或上轮已验证胜者）执行固定目标
  -> 只读总控生成保守策略候选
  -> 候选在独立 Git worktree 执行同一目标与全部质量门禁
  -> 从持久化运行状态计算确定性分数
  -> 达到最低提升则自动应用，否则拒绝
  -> 胜者进入下一轮
  -> 到达轮数上限，或连续无提升达到上限后停止
```

本仓库默认一次最多 3 轮、连续 2 轮无提升提前停止、每个策略评测 1 次；服务端总上限为
10 轮，前端不能绕过。循环运行时会独占项目，普通运行、审批、继续、重试和人工目标修改
暂时不可用。可随时点击“停止”；关闭 App 也会取消活动评测并等待安全收尾。

启用自动演进时，`quality.commands` 至少要有一条确定性命令。proposer 的主 profile 和全部
fallback 都必须是只读；候选不能提高当前策略的并发、重试、Agent 调用、执行超时、输出、
产物或审批等待上限。只有状态为 `completed`、用途为自动隔离评测、且固定目标和策略身份都
与服务端请求完全一致的 run 才能成为通过证据。

候选生成器本身也会记录为可清理的本地 run，并使用更严格的 1800 秒、每流 1 MiB 输出和
16 MiB 产物上限。若进程硬退出，启动恢复只会删除同时具备系统 automatic origin、可反推
proposal ID 且定义完全一致的 shadow strategy；不会仅凭 `auto-eval-` 名称删除旧人工策略。

自动证据来源为 `server-automatic-run-evaluation-v1`。评分只使用最终质量、最终决定、命令
退出码、任务合并、尝试次数和 Agent 调用次数，不读取 stdout/stderr 或模型自述。评测运行
不会请求 plan/final 人工门禁，不会创建/合并 PR，也不会网络发布；架构、工作、独立审查、
测试、最终决定和全部质量命令仍会执行。自动能力当前仅限策略蓝图；角色提示词仍走人工流程。
完成的 proposal、run、application 和回滚链会持久化，已应用胜者在重启后恢复为运行时默认
策略，但循环本身不会随进程启动或重启自动运行。

“开始”请求使用稳定幂等键并绑定当前本地控制会话身份。响应丢失时前端会读取服务端状态并
以同一意图安全重试；进程重启后，已接受的旧启动键不会再次开启一轮，操作者需要查看持久化
记录后发起新的明确请求。自动应用审计记录实际授权该次循环的本地会话，而不是浏览器输入的
actor。

配置示例：

```yaml
evolution:
  automatic:
    enabled: true
    autoStart: false
    maxCycles: 3
    maxConsecutiveNoImprovement: 2
    evaluationRepeats: 1
    minimumScoreDelta: 1
    proposerRole: orchestrator
    proposerProfile: codex-orchestrator
    baselineStrategy: balanced
    targetStrategy: auto-evolved
    evaluationGoal: >-
      Improve one small, well-tested reliability issue without changing public
      behavior or release configuration. Run every configured quality command.
```

升级前已经 promoted、但没有 application proof 的目标，可在 Web API 中仅以 `adopt` 模式
登记：实时目标必须逐字节匹配候选，浏览器不能上传 apply 内容。若必须重新应用旧候选，先
停止控制服务，再使用独占的离线命令：

```bash
agent-team evolution-reconcile <proposal-id> \
  --mode apply \
  --actor "alice" \
  --reason "恢复升级前的已晋升候选" \
  --command-id "legacy-reconcile-20260811" \
  --expected-revision 4
```

仅当旧提示词对象缺失时，`--mode apply` 可额外指定 `--prompt-file <path>`；内容仍必须与
proposal 中的 SHA-256 完全一致。`adopt` 不接受该选项。
`--expected-revision` 使用操作员检查过的 catalog revision，并被纳入命令幂等绑定；重试时
必须继续使用同一个值，不能偷偷跟随新的 catalog 状态。

详细边界见 [受限自演进 Phase 1-6](docs/evolution-phase-1.zh-CN.md)、
[ADR 0016](docs/adr/0016-evolution-control-plane.md) 与
[ADR 0017](docs/adr/0017-bounded-automatic-strategy-evolution.md)。

## 经验库

经验用于提高后续运行成功率，**不是**聊天记录全文入库。

```text
运行终态 → 规则抽取候选（默认不进 prompt）
  → 人工晋升 / 评测 digest 晋升 → 已验证
  → 可选共享到 ~/.agent-team/experience/shared
  → 新项目规划、任务返工时注入已验证经验
```

要点：

- 项目库：`<repo>/.agent-team/experience/`
- 公共库：`~/.agent-team/experience/shared/`（可用 `AGENT_TEAM_HOME` 覆盖根目录）
- 返工时写入 attempt 卡，并通过后回写 `successCount`
- 可选 `requireSuiteForPromote`：晋升须带 EvaluationSuite 的 suiteDigest
- 可选 `autoPromoteWithSuite`：完成运行且能解析评测套件时，自动晋升低敏成功/评测候选
- 工作台侧栏「经验」：筛选、晋升、拒绝、共享

配置示例见 `agent-team.example.yaml` 的 `experience` 段；边界与 OCR 外挂说明见
[可选外部集成](docs/integrations-optional.zh-CN.md)。

## 可选质量门：Open Code Review

本项目**不内嵌**阿里 [open-code-review](https://github.com/alibaba/open-code-review) 规则引擎。
若本机已安装 `ocr` CLI，可将其作为普通质量命令：

```bash
npm i -g @alibaba-group/open-code-review
ocr config provider
```

```yaml
quality:
  commands:
    - command: pnpm
      args: [check]
    - command: ocr
      args: [review]
```

`agent-team doctor` 会检查配置中的 quality 命令是否在 PATH 上。未安装时不要写入
commands，否则质量门会失败。详细说明见 [可选外部集成](docs/integrations-optional.zh-CN.md)。

## 当前范围与限制

当前 `0.1` 版本专注于：

- 本地软件开发仓库。
- Codex CLI、Claude Code 和 Grok CLI。
- Git worktree 隔离。
- GitHub PR 与 Actions 质量门禁。
- 受限自演进 Phase 1-6：候选/证据/人工门禁、仓库本地持久化、受控 target apply/rollback、本地 HTTP 控制面、React/Tauri 工作台和有硬上限的自动策略循环。
- 经验库 v1：候选/已验证/公共、规划与返工注入、attempt 卡、可选评测门禁与策略提示；不内嵌 OpenRSI 搜索种群或 OCR 行级评审 UI。

运行状态会持久保存。当前版本不会重新连接已经终止的 Agent CLI 进程，但可以从
经过 Git 验证的任务检查点人工恢复；未完成波次会使用新的分支重新执行。其他
Agent CLI 需要通过适配器接口接入。

## 更多文档

- [配置说明](docs/configuration.md)
- [工作流说明](docs/workflow.md)
- [安全模型](docs/security.md)（含受限自演进信任、持久化、应用、控制面与前端边界）
- [系统架构](docs/architecture.md)（含 domain / catalog / persistence / application 分层）
- [可选外部集成](docs/integrations-optional.zh-CN.md)（经验闭环、外挂 OCR、不内嵌边界）
- [受限自演进 Phase 1-6](docs/evolution-phase-1.zh-CN.md)（人工候选、受控应用/回滚、可视化工作台与自动策略循环）
- [ADR 0013：演进 domain 与 catalog 边界](docs/adr/0013-bounded-evolution-domain-catalog-boundary.md)
- [ADR 0014：演进 catalog 持久化边界](docs/adr/0014-durable-evolution-catalog.md)
- [ADR 0015：受控演进应用事务](docs/adr/0015-controlled-evolution-application.md)
- [ADR 0016：本地演进控制面](docs/adr/0016-evolution-control-plane.md)
- [ADR 0017：有硬上限的自动策略演进](docs/adr/0017-bounded-automatic-strategy-evolution.md)
- [开源多 Agent 框架对照与补缺](docs/ecosystem-review.md)
- [多 Agent 团队能力对照与完善路线](docs/multi-agent-completeness-roadmap.zh-CN.md)（现状、开源参考、缺口优先级与建议版本路线）
- [可视化策略蓝图](docs/strategy-blueprints.md)
- [桌面 App 与 Android/Termux 集成方案](docs/app-runtime-plan.zh-CN.md)
- [完整示例配置](agent-team.example.yaml)

## 开发与测试

### 桌面 App

桌面端使用 Tauri 2 包装现有 React 工作台，并自动管理本地控制服务。普通操作不需要
手工启动 Node、填写端口或打开终端：首次启动选择代码项目；如果缺少配置，点击
“初始化并打开”；之后会自动恢复上次成功打开的项目。

不同项目分别使用独立控制进程，可以同时运行；同一项目只允许一个控制进程。若项目已在
终端、浏览器或另一个桌面窗口中运行，桌面启动器会显示占用状态，可「释放占用」或选择
其他项目，不会误杀无关进程。GUI 启动时会注入常见 Homebrew PATH，便于找到 `codex` /
`grok` 等 CLI。

本地开发：

```bash
pnpm install
pnpm desktop:dev
```

生成当前平台安装包（macOS 示例只打 `.app`）：

```bash
pnpm desktop:build
# 或
pnpm exec tauri build --bundles app
# 可选：安装到本机
# ditto "src-tauri/target/release/bundle/macos/Agent Team.app" "/Applications/Agent Team.app"
```

首次准备桌面端时会从 Node.js 官方发布站下载固定版本的 Node 24 运行时并校验
SHA-256，同时按锁文件安装生产依赖并用内嵌 CLI 执行启动冒烟检查；安装包不依赖客户
另行安装 Node 或 npm 包。Codex、Claude Code、Grok 等 Agent CLI 仍需按项目配置安装并完成
登录。临时测试目录不会写入“上次打开的项目”。

当前已实机验证 macOS arm64。运行时准备脚本支持 macOS arm64/x64、Windows x64 和
Linux arm64/x64。

**每次 PR（含后续每个 commit）都必须走桌面客户端 CI 产物**，不能只靠本机
`pnpm build` / 热更新 `web/dist` 验收：

1. **CI**（`ci.yml`）：`pnpm check` / test / build  
2. **Desktop PR Build**（`desktop-pr-build.yml`）：构建未签名安装包  
   - Windows x64  
   - macOS Apple Silicon  
   - macOS Intel  
3. **Desktop PR Release**（`desktop-pr-release.yml`）：构建成功后，同仓库 PR 按  
   `pr-<编号>-<commit SHA>` 创建/更新 GitHub Pre-release 并上传 `.dmg` / Windows 安装包  

合并前请确认上述检查对**当前 HEAD commit**为绿，并用对应 Pre-release 安装验证。
外部 fork PR 只保留 Actions artifacts，不向不受信任代码授予 Release 写权限。
也可在 Actions 里对 `Desktop PR Build` 使用 `workflow_dispatch` 手动重跑。

这些自动产物不签名、不公证，也不需要仓库配置证书 secret。Windows SmartScreen 与
macOS Gatekeeper 可能显示未知开发者提示，适合当前开源自用和测试分发范围。

### 全量检查

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm test:e2e
pnpm desktop:test
```

贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。本项目使用 MIT License。
