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

- Node.js 20 或更高版本。
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
pnpm dev -- <命令>
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

## 分别选择 CLI 和模型

`agent-team.yaml` 中的 profile 决定使用哪个 CLI 和模型：

```yaml
profiles:
  codex-planner:
    adapter: codex
    model: inherit
    reasoning: high
    permission: read-only
    timeoutSeconds: 900

  codex-worker:
    adapter: codex
    model: your-codex-model
    reasoning: medium
    permission: workspace-write
    timeoutSeconds: 1800

  claude-reviewer:
    adapter: claude
    model: your-claude-model
    reasoning: high
    permission: read-only
    timeoutSeconds: 900
```

模型字段有两种写法：

- `model: inherit`：使用该 CLI 当前配置的默认模型。
- `model: 模型名称`：把名称明确传给该 CLI。

模型必须已经能在对应 CLI 中使用。本项目不会绕过 CLI 自己的账号、权限和
模型可用性限制。

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

本地运行通过后，状态会停在 `awaiting-human`，不会自动发布或合并。

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

运行状态会持久保存，可以在中断后检查，但当前版本还不支持自动恢复并继续
被中断的运行。其他 Agent CLI 需要通过适配器接口接入。

## 更多文档

- [配置说明](docs/configuration.md)
- [工作流说明](docs/workflow.md)
- [安全模型](docs/security.md)
- [系统架构](docs/architecture.md)
- [完整示例配置](agent-team.example.yaml)

## 开发与测试

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。本项目使用 MIT License。
