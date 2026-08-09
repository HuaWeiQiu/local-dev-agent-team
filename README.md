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

当前内置以下 CLI 适配器：

- [Codex CLI](https://developers.openai.com/codex/cli)
- Claude Code

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
agent-team doctor --profile codex-worker --probe-models
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
DAG、交付证据、审查结果、质量命令和实时 Agent 输出；阻塞、取消或中断的运行可以作为新的
关联运行重试。界面保存的策略位于项目状态目录，不会改写 `agent-team.yaml`，并且
可以通过工作台或 `agent-team run --strategy <name>` 执行。

同一个服务还提供 REST 命令和带游标的 SSE 事件流。运行元数据和幂等命令保存在
`.agent-team/control.sqlite`，大型日志、上下文、diff 和测试制品继续保存在
`.agent-team/runs/`。同一项目同时只允许一个控制服务持有运行租约，浏览器不会
直接创建本地进程或修改运行状态。

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
| 左侧运行列表 | 搜索、按状态筛选、切换历史运行，查看状态、策略和任务进度 |
| 任务图 | 查看任务依赖、并行分支、当前状态和尝试次数 |
| 活动日志 | 查看状态时间线以及 Agent 的实时 stdout、stderr |
| 交付证据 | 汇总任务集成、质量门禁、最终判定、审批、集成 diff 和本地产物 |
| 右侧检查器 | 查看运行策略、资源用量、审批记录，或所选任务的分支、提交、质量命令和审查结论 |

点击任务节点会打开该任务的证据详情。任务图中的连线表示真实依赖关系；没有依赖且
负责路径不冲突的任务，才可能并行执行。

页面右上角会根据运行状态显示可用操作：

- “取消”：终止仍在执行的运行。
- “处理审批”：批准或拒绝计划、交付审批，必须填写操作者和理由。
- “恢复”：服务中断后，从最近一个经过 Git 校验的检查点继续。
- “重试”：为阻塞、取消或中断的运行创建新的关联运行，不改写原运行证据。

移动端底部提供“运行、编排、任务图、详情、日志、证据”六个视图。移动端 DAG 会按依赖
层级重新排列，但不会把并行任务错误显示成串行任务。

### 4. 配置执行策略

点击左侧主导航“编排”进入策略工作室：

1. 从顶部策略选择器切换已有策略。
2. 点击“策略库”查看项目策略和可用阶段。
3. 点击“策略设置”编辑蓝图名称、拓扑、并行上限、返工上限、Agent 调用上限、
   计划审批和角色 profile。
4. 点击“预检”，让服务端编译并校验当前草稿。
5. 点击“保存”，将蓝图保存为项目本地的自定义策略。
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
  codex-planner:
    adapter: codex
    model: inherit
    reasoning: high
    permission: read-only
    externalTools: deny
    timeoutSeconds: 900

  codex-worker:
    adapter: codex
    model: your-codex-model
    reasoning: medium
    permission: workspace-write
    externalTools: deny
    timeoutSeconds: 1800

  claude-reviewer:
    adapter: claude
    model: your-claude-model
    reasoning: high
    permission: read-only
    externalTools: deny
    timeoutSeconds: 900
```

模型字段有两种写法：

- `model: inherit`：使用该 CLI 当前配置的默认模型。
- `model: 模型名称`：把名称明确传给该 CLI。

模型必须已经能在对应 CLI 中使用。本项目不会绕过 CLI 自己的账号、权限和
模型可用性限制。

`externalTools` 默认是 `deny`：Codex 忽略用户配置并将本次运行的项目配置标记为
不受信任（登录状态仍保留），
Claude Code 使用严格空 MCP 配置。只有显式设置为 `inherit` 时，Agent 才会继承
对应 CLI 自己的 MCP 配置。凭据、server 生命周期和工具授权仍由 CLI 管理，本项目
不保存 MCP 凭据，也不把 MCP 工具变成控制面命令。由于外部工具不保证服从 CLI
的文件沙箱，只有 `workspace-write` Worker profile 可以设置 `inherit`；只读
profile 必须保持 `deny`。Codex 的 deny 模式也不读取用户模型/provider 配置，
`model: inherit` 会使用 CLI 内置默认值；需要固定模型时请显式填写 `model`。
`nativeProfile` 依赖用户配置，因此只能和 `externalTools: inherit` 一起使用。

角色再引用允许使用的 profile：

```yaml
roles:
  orchestrator:
    defaultProfile: codex-planner
    allowedProfiles: [codex-planner]

  architect:
    defaultProfile: codex-planner
    allowedProfiles: [codex-planner, claude-reviewer]

  worker:
    defaultProfile: codex-worker
    allowedProfiles: [codex-worker]

  reviewer:
    defaultProfile: claude-reviewer
    allowedProfiles: [claude-reviewer, codex-planner]
    fallbackProfiles: [codex-planner]

  tester:
    defaultProfile: codex-planner
    allowedProfiles: [codex-planner]
```

必需角色包括：

- `orchestrator`：总控
- `architect`：架构
- `worker`：工作
- `reviewer`：审查
- `tester`：测试

也可以只对本次运行临时覆盖角色 profile：

```bash
agent-team run \
  --goal "为用户列表接口增加游标分页" \
  --profile architect=claude-architect \
  --profile worker=codex-worker
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
        reviewer: claude-reviewer
        tester: codex-planner
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
`agent-team.yaml`。修复仍然必须重新通过项目命令、审查和测试门禁。

## 安全默认值

- 总控、架构和审查角色默认只读。
- Codex 只读角色使用只读 sandbox。
- Claude 只读角色使用 plan 模式，并只开放读取、文件匹配和搜索工具。
- 工作 Agent 只能在隔离 worktree 中获得写权限。
- Agent CLI 参数使用参数数组直接启动，不通过 shell 拼接。
- 模型、权限、工作目录和结构化输出参数不能被 profile 的额外参数覆盖。
- 运行状态和 Agent 上下文保存在 `.agent-team/`，并默认被 Git 忽略。
- 不执行自动合并或强制推送。

## 当前范围与限制

当前 `0.1` 版本专注于：

- 本地软件开发仓库。
- Codex CLI 和 Claude Code。
- Git worktree 隔离。
- GitHub PR 与 Actions 质量门禁。

运行状态会持久保存。当前版本不会重新连接已经终止的 Agent CLI 进程，但可以从
经过 Git 验证的任务检查点人工恢复；未完成波次会使用新的分支重新执行。其他
Agent CLI 需要通过适配器接口接入。

## 更多文档

- [配置说明](docs/configuration.md)
- [工作流说明](docs/workflow.md)
- [安全模型](docs/security.md)
- [系统架构](docs/architecture.md)
- [开源多 Agent 框架对照与补缺](docs/ecosystem-review.md)
- [可视化策略蓝图](docs/strategy-blueprints.md)
- [桌面 App 与 Android/Termux 集成方案](docs/app-runtime-plan.zh-CN.md)
- [完整示例配置](agent-team.example.yaml)

## 开发与测试

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm test:e2e
```

贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。本项目使用 MIT License。
