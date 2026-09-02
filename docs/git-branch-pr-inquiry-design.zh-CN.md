# Git 分支选择、远端同步、标准 PR 发布与运行旁路咨询 — 详细设计

> 状态：已评审（用户确认）v1.1
> 范围：Local Dev Agent Team 的 Git/GitHub 交互闭环升级
> 前置需求来源：分支可选/可建、远端默认分支同步、精简阶段摘要、标准正式 PR、执行中旁路提问
> 后续：应用内连接 GitHub、Changes、Commit & Push 见 `docs/github-connect-and-changes.zh-CN.md`

---

## 1. 目标

把当前“固定 main → 内部 worktree 分支 → 草稿 PR”的流程升级为：

```text
选择/新建分支（可自动按目标命名）
  -> 可选先同步远端默认分支
  -> 以选定 commit 为基地创建 worktree
  -> 运行中按阶段产出精简摘要
  -> 执行中可发起不影响主运行的旁路提问
  -> 最终审批后预览并创建【正式】PR（标准标题/描述，不自动合并）
```

### 1.1 需求映射

| ID | 用户需求 | 设计落点 |
| --- | --- | --- |
| R1 | GitHub 分支可选，不再只展示 main | 新建运行 Git 区块可选择 base 分支并预览/创建工作分支 |
| R2 | 可在这里创建分支；新建运行时按目标生成分支名 | `POST /branches` + StartRun 增加 `headBranchName`，UI 实时预览生成名 |
| R3 | 初创项目/无分支/无 git/无 gh token 等边界 | `GET /git/status` 能力检测 + 分场景引导 + 可恢复失败分类 |
| R4 | 远端存在且 gh 有权限时可同步远端默认分支；新建分支前最好先同步并以它为基地 | `POST /branches/sync`（git 层 ff-only）+ StartRun `syncDefaultFirst` |
| R5 | 阶段详情精简，不要推理过程/无用信息 | 结构化 `stageSummaries`，默认只展示摘要，原始输出继续藏在日志“输出”页 |
| R6 | 按目标/阶段生成标准 PR 标题与描述，点击发布即创建 | `GET /publish-preview` + `PublishDialog` 可编辑 + `POST /actions/publish` 接受覆盖 |
| R7 | PR 必须是正式状态，不是草稿 | 配置默认 `draftPullRequest: false`；已存在草稿 PR 时自动 `gh pr ready` |
| R8 | 执行中可对当前阶段提问，不影响主运行，可删除会话 | 独立 InquiryStore + 只读快照调用，绝不写 `state.json`、绝不发状态迁移 |
| R9 | 每个阶段有一句总结，并在任务图/活动日志体现 | 任务图阶段条 + 活动日志新增“阶段”页签 + 任务节点摘要 |

---

## 2. 设计原则（不可破坏的边界）

1. **Git 可恢复**：只允许 `fetch` + fast-forward；禁止 force push、禁止自动合并、禁止删除未记录的他人分支。
2. **不信任 UI**：分支名、base commit、clean 状态、远端存在性全部在服务端复验。
3. **主运行状态机唯一**：只有 workflow runner 和既有 action 队列能写 `state.json`；旁路咨询是只读快照 + 独立存储。
4. **无 shell 拼接**：所有 git/gh 调用沿用 `spawn` 参数数组（AGENTS.md 规则）。
5. **不落盘 token**：只通过 `gh auth status` / `gh repo view` 探测状态，永不读取或保存 token。
6. **向后兼容**：旧 run 状态、旧配置文件可加载；旧配置显式 `draftPullRequest: true` 不静默改行为，只在新配置中默认 false。

---

## 3. 现状盘点（实现前基线）

| 能力 | 现状代码 | 缺口 |
| --- | --- | --- |
| base 分支 | `agent-team.yaml` 的 `project.defaultBranch`；UI 顶栏只展示（`web/src/App.tsx`） | 无选择/新建/同步 |
| run 起点 | `src/workflow/runner.ts` 固定 `resolveCommit(config.project.defaultBranch)` | `WorkflowRunOptions` 无 `baseBranch`/`headBranchName` |
| 工作分支名 | `integrationBranch = agent-team/<runId>/integration`（`src/workflow/id.ts` 的 `branchSegment` 可复用） | 不支持目标命名 |
| 同步 | `GitManager` 无 fetch/sync 方法 | 需新增 |
| 发布 | `src/github/publish.ts` 可 push + 建 PR；`github.draftPullRequest` 默认 true；PR body 为简单模板 | 无预览、模板弱、默认草稿 |
| gh 失败分类 | `src/github/errors.ts` 已有 6 类可读错误 | 需扩展空仓库/远端缺失/分支缺失 |
| 阶段消息 | `RunState.history[]` 已有简短 message | 无结构化 `stageSummaries` |
| 活动日志 | `EventConsole` 有角色/活动/输出三个页签 | 无“阶段”页签 |
| 旁路提问 | 不存在 | 全新增 |
| 清理 | `src/server/run-retention.ts` 只按 `agent-team/<runId>/*` 前缀删分支 | 自定义 head 分支需记录后精确删除 |

健康基线（已实测）：`pnpm check` 通过；项目自身测试通过；`pnpm test` 目前会误扫未跟踪的 `.analysis/remote/**` 外部测试导致 29 个文件失败（P2 修复 `vitest.config.ts` exclude）。

---

## 4. 总体架构

```text
Web UI
 ├─ RunLauncher        : Git 区块（状态徽章/分支选择/新建/同步勾选）
 ├─ SettingsWorkbench  : 项目 Git 面板（状态/列表/同步/新建）
 ├─ PublishDialog      : PR 预览与编辑（标题/描述/base/head）
 ├─ InquiryDrawer      : 旁路提问会话
 ├─ DagCanvas          : 阶段摘要条 + 节点摘要
 └─ EventConsole       : 新增“阶段”页签

HTTP（项目路由，/api 或 /api/projects/:id 前缀）
 ├─ GET  /git/status
 ├─ GET  /branches
 ├─ POST /branches
 ├─ POST /branches/sync
 ├─ POST /runs                     (扩展 StartRunRequest)
 ├─ GET  /runs/:id/publish-preview
 ├─ POST /runs/:id/actions/publish (扩展 body)
 └─ POST|GET|DELETE /runs/:id/inquiries...

后端
 ├─ src/git/manager.ts        : +fetch/sync/listRemote/createBranch/validateBranchName
 ├─ src/git/sync.ts           : GitSyncService（ff-only 同步语义）
 ├─ src/git/branches.ts       : BranchService（状态检测/列表/创建）
 ├─ src/workflow/runner.ts    : 接受 baseBranch/headBranchName/syncDefaultFirst
 ├─ src/github/publish.ts     : 预览模板、正式 PR、gh pr ready、base 远端预检
 ├─ src/inquiry/*             : InquiryStore/Coordinator/Runner/Prompt
 ├─ src/state/{types,schema}.ts : stageSummaries/managedBranches/task.summary
 └─ src/server/run-retention.ts : 按 managedBranches 精确清理
```

---

## 5. Feature A：Git 分支选择、创建与同步

### 5.1 概念澄清（避免产品歧义）

- `defaultBranch`：远端默认分支（PR 默认 base），来自 `gh repo view` / `git ls-remote --symref origin HEAD` / 配置兜底。
- `baseBranch`：**本次 run 的基地、PR 目标分支**。可选已有分支；默认 `defaultBranch`。
- `headBranchName`：**本次 run 的工作分支、PR 来源分支**。用户可自定义或按目标自动生成；缺省时维持现状 `agent-team/<runId>/integration`。
- `taskBranch`：任务级内部分支，维持 `agent-team/<runId>/<taskId>` 不变，永不对用户暴露为 base。

### 5.2 分支命名

- 自动生成：`<prefix>/<goal-slug>[-N]`
  - prefix：`feature`（默认）/ `fix` / `chore` / `docs` / `refactor`，UI 可选。
  - slug：复用 `src/workflow/id.ts#branchSegment`（小写、保留 `[a-z0-9_-]`、去首尾分隔符、≤48 字符）。
  - 冲突：服务端返回 409 + 建议名 `-2`、`-3`；UI 一键采用。
- 硬校验（服务端，两条都过才允许）：
  1. `git check-ref-format --branch <name>` 成功。
  2. 分支不存在（本地或远端同名均算冲突）。
- 保留规则：`agent-team/` 前缀只允许 runner 内部使用；用户自定义分支不允许以 `agent-team/` 开头。

### 5.3 能力状态 `GitEnvironmentStatus`

新增 `GET /git/status`（读接口，可高频轮询）：

```ts
interface GitEnvironmentStatus {
  gitInstalled: boolean;
  gitVersion?: string;
  isRepository: boolean;
  repoRootMatches: boolean;      // 配置 root 是否等于 git 顶层目录
  worktreeClean: boolean;
  hasCommits: boolean;           // 无提交（unborn HEAD）为 false
  currentBranch?: string;
  remote?: string;               // 实际生效 remote（origin 或配置值）
  remoteConfigured: boolean;
  remoteAccessible: boolean;
  localDefaultBranch?: string;
  remoteDefaultBranch?: string;  // ls-remote --symref origin HEAD
  defaultBranchSource: "gh" | "git" | "config";
  ghInstalled: boolean;
  ghAuthenticated: boolean;      // gh auth status 成功
  ghRepoAccess: boolean;         // gh repo view 成功（证明可读权限）
  canSync: boolean;
  canPublish: boolean;
  blockers: GitBlocker[];        // 面向 UI 的引导文案 id
}

type GitBlocker =
  | "git-missing" | "not-a-repository" | "root-mismatch" | "dirty-worktree"
  | "no-commits" | "no-remote" | "remote-unreachable"
  | "gh-missing" | "gh-not-authenticated" | "gh-no-repo-access";
```

检测实现要点：
- git 能力：`git --version` + `git rev-parse --show-toplevel`；顶层路径与配置 root 做 `realpath` 比较（沿用 `GitManager.assertReady`）。
- 默认分支优先级：`gh repo view --json nameWithOwner,url,defaultBranchRef`（gh 可用时）→ `git ls-remote --symref origin HEAD` → `project.defaultBranch` 配置兜底。`source` 字段明确告诉用户兜底来自哪里。
- gh 能力：`gh --version`、`gh auth status`（只看退出码，不解析 token）、`gh repo view`（验证实际访问权限）。三者任一失败只影响 `canPublish`，不影响本地运行。

### 5.4 边界场景矩阵（R3）

| 场景 | UI 展示 | 允许的操作 | 发布 PR |
| --- | --- | --- | --- |
| git 未安装 | 红色徽章 + 安装指引 | 禁止新建 run（保持现状终态阻断，但错误改为引导文案） | 禁用 |
| 目录不是 git 仓库 | 提示“初始化 Git” | 可执行 `git init -b <默认分支>`（需人工确认） | 禁用 |
| 空仓库 / unborn HEAD / 无提交 | 提示“创建初始提交” | 可人工确认创建空初始提交（要求 git identity 已配置） | 禁用 |
| 有仓库、无本地分支但有远端 | 显示远端默认分支 | 同步时用 `git branch <default> <commit>` 补建本地分支，不 checkout 主工作区 | 可用 |
| 工作区不干净 | 提示先提交/暂存 | 禁止同步、新建分支、新建 run | 禁用 |
| 无远端 | 提示添加 remote | 本地 run 照常 | 禁用 |
| gh 未安装 | 黄色徽章 | 本地 run 照常 | 禁用并引导安装 |
| gh 未登录 | 黄色徽章 + 应用内「连接 GitHub」（见连接/Changes 设计） | 本地 run 照常 | 禁用 |
| gh 无仓库权限 | 错误分类 `token-permissions` | 本地 run 照常 | 禁用并提示授予 repo/PR 权限 |
| 远端默认分支与配置 defaultBranch 不一致 | 顶部提示差异 | 以远端实际值为准 | 以远端值为准 |

**不自动做的事**（保持可恢复原则）：不自动 `git init`、不自动创建初始提交、不自动添加 remote、不自动登录 gh。全部是“检测 → 一个按钮 → 人工确认”。

### 5.5 远端同步（R4）

新增 `POST /branches/sync`：

```ts
request:  { branch?: string }        // 缺省 = remote defaultBranch
response: {
  branch: string;
  previousCommit?: string;           // 本地原来没有则缺省
  newCommit: string;
  changed: boolean;
}
```

服务端 `GitSyncService` 语义（ff-only）：

```text
1. assertReady（git、repo、clean）
2. remote 存在且可访问
3. git fetch <remote> <branch>            # 不 prune、不带 force
4. newCommit = rev-parse FETCH_HEAD
5. local 不存在
     -> git branch <branch> <newCommit>   # 只建分支，不 checkout
6. local 存在且相同 -> changed=false
7. local 存在且 newCommit 是其 ff 后代
     -> 主工作区正 checkout 该分支:  git merge --ff-only FETCH_HEAD
     -> 否则:                        git update-ref refs/heads/<branch> <new> <old>
8. 非 fast-forward
     -> 拒绝，返回 ahead/behind 与人工解决建议；绝不 rebase/reset
```

新增 `GitManager` 方法：`fetch(remote, ref)`、`resolveFetchedCommit`、`isAncestor(old, new)`、`updateRefFastForward`、`mergeFastForwardOnly`、`createBranch(name, commit)`、`validateBranchName(name)`、`remoteDefaultBranch()`、`remoteHeads()`。

**新建分支前自动同步**：`POST /branches` 与 StartRun 都接受 `syncFirst` / `syncDefaultFirst`；语义是先执行 5.5 的 ff-only 同步，再以同步后的 commit 建分支。同步失败则整次操作失败，不会拿旧基地继续（用户可取消勾选绕过硬同步）。

### 5.6 创建分支

`POST /branches`：

```ts
request: {
  name: string;                    // 已通过命名校验
  baseBranch?: string;             // 缺省 defaultBranch
  syncFirst?: boolean;             // 缺省 true（UI 默认勾选）
}
response: BranchInfo
```

`BranchInfo`：

```ts
interface BranchInfo {
  name: string;
  kind: "local" | "remote";
  commit: string;
  isDefault: boolean;
  isCurrent: boolean;
}
```

实现：解析 base commit（本地优先，其次 `origin/<base>`）→ `git branch <name> <baseCommit>`（不 checkout）→ 返回分支信息。创建后立即出现在 `GET /branches`。

### 5.7 Run 启动扩展

`startRunRequestSchema`（`src/server/contracts.ts`）新增：

```ts
baseBranch?: z.string().trim().min(1).max(200).optional();
headBranchName?: z.string().trim().min(1).max(240).optional();
syncDefaultFirst?: z.boolean().optional();
```

`WorkflowRunOptions` 同步新增同名字段。`LocalWorkflowRunner.run` 调整：

```text
1. baseBranch = options.baseBranch ?? config.project.defaultBranch
2. 若 syncDefaultFirst：GitSyncService.sync(defaultBranch)（失败按现状持久化终态）
3. headBranchName = options.headBranchName ?? `agent-team/${branchSegment(runId)}/integration`
4. validateBranchName(headBranchName)；自定义名不得占用已有分支
5. baseCommit = resolveCommit(baseBranch)（本地 -> origin/<base> 兜底，都没有则给出可读错误）
6. createWorktree(headBranchName, baseCommit, integrationWorktree)
7. state.managedBranches = [headBranchName]；任务分支创建时追加
```

发布时 `base = state.baseBranch`、`head = state.integrationBranch`。`resume` 不重新同步、不重建分支（可恢复性优先）。

### 5.8 CLI 扩展

```bash
agent-team branch list [--remote]
agent-team branch create <name> [--base <branch>] [--no-sync]
agent-team branch sync [--branch <branch>]
agent-team run --goal "..." [--base-branch B] [--branch HEAD] [--sync-default]
```

---

## 6. Feature B：阶段摘要（R5/R8）

### 6.1 数据模型

`src/state/types.ts`：

```ts
interface StageSummary {
  id: string;
  stage: RunStatus;
  at: string;                 // ISO
  title: string;              // 例如“执行波次”“最终检查”
  summary: string;            // 一句话结论，<= 200 字符
  highlights?: string[];      // 关键产物/关键失败，每条 <= 80，最多 4 条
  error?: string;
}

// RunState 新增
stageSummaries?: StageSummary[];

// TaskRunState 新增
summary?: string;             // 该任务通过/失败时写入的一句话结论
```

`runStateSchema` 增加可选字段并升级文档版本为 `2`；旧 v1 文档照常 `parseRunState` 加载，缺失字段按 `undefined`。

### 6.2 生成机制（确定性优先）

最小侵入方案：扩展 `RunStateStore.transition` 签名：

```ts
transition(
  state: RunState,
  status: RunStatus,
  message: string,
  extra?: { highlights?: string[] },
): Promise<void>
```

- 状态发生变化的 transition 自动追加一条 `StageSummary`，`summary = message`。
- 现有约 20 处 `transition` 调用**无需改动即可全覆盖**，因为现有 message 已经是一句话级。
- 关键节点再补充 `extra.highlights`，例如：

| 阶段 | 默认 message 示例 | highlights |
| --- | --- | --- |
| `architecting/planned` | 架构产出 N 个任务 | 任务标题（≤4） |
| `implementing` | 合并本波次通过的任务 | 已合并任务数/总数、新 commit 前 8 位 |
| `reviewing-testing` | 审查与测试完成 | 审查结论、测试结论 |
| `reworking` | 返工原因 | 重试次数 |
| `integrating` | 合并 N 个任务 | 集成 commit |
| `final-checks` | 本地门禁结果 | 通过命令 x/y |
| `awaiting-human` | 等待交付审批 | 最终判定摘要 |
| `publishing/waiting-ci/ready-to-merge` | PR 创建/CI 状态/待人工合并 | PR 链接 |
| `completed/blocked/cancelled/interrupted` | 终态原因 | 错误一句话 |

- **禁止**进入摘要的内容：stdout/stderr 原始块、Agent 推理链、超过 200 字符的 plan/review 原文。原始证据仍可从“输出/证据”视图查看。
- 任务级 `summary`：任务通过时由 review/test 的 `summary` + 质量门禁结果拼装；失败时写入失败原因。
- 未来可选增强（不在本期）：用 LLM 压缩 plan/verdict 长文本；本期全部用已结构化的 verdict summary。

### 6.3 UI 落点

| 位置 | 变更 |
| --- | --- |
| 活动日志 `EventConsole` | 页签变为 **阶段 / 活动 / 角色 / 输出**；“阶段”优先展示 `stageSummaries` 卡片（时间倒序），无摘要时回退到“活动” |
| 任务图 `DagCanvas` | 画布顶部加**阶段摘要条**：当前阶段的 title + summary + highlights |
| `TaskInspector` | 顶部显示 `task.summary`；阶段相关摘要显示在右侧检查器 |
| 移动端 | “日志”视图顶部阶段摘要条，其余不变 |

---

## 7. Feature C：标准 PR 发布（R6/R7）

### 7.1 配置

- `src/config/defaults.ts`：`github.draftPullRequest` 由 `true` 改为 `false`（新项目默认正式 PR）。
- 既有项目若 yaml 里显式 `draftPullRequest: true`，**保持草稿**，在发布预览中黄条提示，并提供“本次创建为正式 PR”勾选（仅本次发布，不改配置）。
- `github.autoMerge` 维持 `z.literal(false)`，绝不放开。

### 7.2 发布预览

`GET /runs/:runId/publish-preview`：

```ts
interface PublishPreview {
  eligible: boolean;
  reason?: string;              // 不可发布时的状态/审批说明
  repository?: string;          // nameWithOwner
  baseBranch: string;
  headBranch: string;
  draft: boolean;               // 本次将创建的形态
  title: string;
  body: string;
  warnings: string[];           // 例如 base 仅在本地、gh 未登录、非默认 base
  checks: {
    ghAuthenticated: boolean;
    repoAccess: boolean;
    baseOnRemote: boolean;
    headAheadOfBase: boolean;
  };
}
```

**标题规则**（≤120 字符）：

```text
type 前缀取自 headBranch 第一段映射：
  feature -> feat    fix -> fix      refactor -> refactor
  chore -> chore     docs -> docs    agent-team/其他 -> feat
标题 = `${type}: ${intake.goalSummary ?? goal 压缩}`
```

**Body 模板**（v1，服务端 `renderPullRequestBody` 升级）：

```markdown
## 目标
<goal>

## 方案
<plan.summary 截断 600 字>
| 任务 | 内容 | 结果 |
|---|---|---|
| T1 | ... | merged/passed |

## 执行
<stageSummaries 中 implementing/integrating/reviewing-testing 的 title+summary 列表>

## 实现
<git diffSummary(baseCommit..HEAD) 的文件清单，≤200 行>
<关键 commit 标题，≤10 条>

## 验证
<项目质量命令逐条结果>
<review/test 最终结论摘要>

## 合并策略
- 由人工检查后合并；本工具不自动合并。
- 发布来源：Local Dev Agent Team，Run ID: `<id>`
```

明确**不放入** body 的内容：Agent stdout/stderr、完整推理过程、attempts/profile 调试信息。

### 7.3 发布 mutation

`POST /runs/:id/actions/publish` 扩展：

```ts
{ title?: string; body?: string }   // 用户在预览框的编辑结果；缺省用模板
```

服务端校验：`title ≤ 120`、`body ≤ 20_000`，发布前重跑 eligibility（最终审批、状态、gh 权限），并把最终使用的 title/body 写回 state（新增 `pullRequestTitle/pullRequestBodyFile` 或保存到 github artifact，供审计）。

流程：

```text
1. authStatus + repository()
2. 预检 base 在远端存在：
     - 存在 -> 继续
     - 不存在 -> 若预览曾告知且请求带 pushBaseBranch=true 则先 push base；否则报可读错误
3. git push(head)
4. findPullRequest(head)
     - 不存在 -> createPullRequest(draft = config.github.draftPullRequest)
     - 存在且 isDraft && !draft -> gh pr ready <target>（新增 GithubClient.markPullRequestReady）
     - 存在且正式 -> 复用，幂等成功
5. 状态迁移与现有逻辑一致：ready-to-merge -> publishing -> waiting-ci；失败回退 ready-to-merge
```

`GithubClient` 变更：
- `createPullRequest` 保持 `--draft` 只在 `draft=true` 时追加（已是现状）。
- `findPullRequest` 的 JSON 增加 `isDraft`。
- 新增 `markPullRequestReady`（`gh pr ready`）。

### 7.4 UI

新增 `web/src/components/PublishDialog.tsx`：

- 顶部：`base ← head` 分支关系 + 正式/草稿徽章。
- 中部：可编辑标题、可编辑 body（Markdown 预览）。
- 底部：预检结果（gh 登录/权限/base 在远端）+ “创建正式 PR”。
- 替换 `App.tsx` 当前“发布”按钮的直接 `actions.publish()`，改为先拉 preview 打开对话框；提交时把编辑结果一并 POST。

---

## 8. Feature D：旁路提问（软分支会话，R8）

### 8.1 隔离保证（最重要）

1. 提问处理**不加载、不修改 `RunState` 写队列**：只从磁盘 `readFile` 当前 `state.json` 生成快照。
2. 不调用 `store.transition`、不 emit 进 run 事件流、不占用 `serializeAction` 队列。
3. Agent 调用使用**只读权限**：复用 `orchestrator` 角色解析；`assertRoleProfilePermission` 已保证非 worker 角色不能使用 `workspace-write` profile。
4. 会话独立存储在 `.agent-team/inquiries/<runId>/<inquiryId>.json`；删除单条会话只删该文件；删除 run 时级联清理。
5. 运行被取消/删除/中断不影响已有回答的读取；提问进程在服务关闭时被 abort 并标记 `cancelled`。

### 8.2 数据模型

```ts
type InquiryStatus = "running" | "completed" | "failed" | "cancelled";

interface InquiryRecord {
  id: string;
  runId: string;
  stage: RunStatus;              // 针对哪个阶段提问，缺省 = 请求时的 status
  runStatusAtAsk: RunStatus;
  question: string;              // <= 2000 字符
  answer?: string;               // <= 800 字符
  keyPoints?: string[];          // <= 6 条，每条 <= 80
  status: InquiryStatus;
  error?: string;
  usage?: { invocations: number; durationMs: number };
  createdAt: string;
  updatedAt: string;
}
```

### 8.3 API

```text
POST   /runs/:id/inquiries                 -> 202 { inquiry }
GET    /runs/:id/inquiries                 -> { inquiries: InquiryRecord[] }
GET    /runs/:id/inquiries/:inquiryId      -> { inquiry }
DELETE /runs/:id/inquiries/:inquiryId      -> 204
```

POST 即返回 `status:"running"`；UI 用 2s 轮询 GET 直到终态（避免长时间挂 HTTP 请求，服务关闭语义更简单）。同一 run 最多 1 个 running 提问；超过 409。每 run 上限 20 条，超过 409 并提示先删除旧会话。

### 8.4 回答生成

`src/inquiry/runner.ts`：

1. `InquiryStore.loadSnapshot(runId)`：只读加载 `state.json`，提取：
   - goal、`intake.goalSummary`
   - plan.summary、任务表（id/title/status/attempts）
   - `stageSummaries`、最近 10 条 history（非 stdout）
   - 当前 status 与目标 `stage`
2. 渲染 `prompts/inquiry.md`：

   ```text
   你是运行进度解说员。基于下面的【运行快照】回答用户关于当前阶段的问题。
   - 只回答快照里有依据的内容；不知道就明说。
   - 用简体中文，3-6 句话以内；给 1-3 个关键点。
   - 不要复述推理过程、不要建议执行动作、不要调用任何写工具。
   ```

3. 用 `resolveProfile(config, "orchestrator", undefined)` 解析 profile，`assertRoleProfilePermission` 校验；`invokeAgent` 带 `inquiryAnswerSchema`（zod + JSON Schema），`cwd` 设为仓库根但只读。
4. 外层 `AbortController` 超时 180s；超时写 `failed("咨询超时")`。
5. 写入 InquiryStore：tmp 文件 + rename（同 state store 的落盘纪律）。

### 8.5 UI

新增 `web/src/components/InquiryDrawer.tsx`，挂载在运行工作台顶部“问进度”按钮（active run 与终态 run 均可用，终态 run 只回答结果回顾）：

```text
┌ 问进度 ────────────────┐
│ 阶段：[当前(执行波次) ▾]  │
│ 输入框：现在做到哪一步了？ │
│ [提问]                 │
│ ── 历史会话 ──          │
│ Q: ...  A: ...   [删除] │
└────────────────────────┘
```

咨询会话**不进入** EventConsole 活动时间线；最多在任务图当前阶段节点显示“N 次提问”计数。

---

## 9. 服务端路由与类型汇总

| 方法/路径 | 用途 | 幂等/安全 |
| --- | --- | --- |
| GET `/git/status` | 能力检测 | 读 |
| GET `/branches?scope=` | 本地/远端分支列表 | 读 |
| POST `/branches` | 建分支（可先同步） | 命令幂等 key |
| POST `/branches/sync` | ff-only 同步远端默认分支 | 命令幂等 key |
| POST `/runs` | 扩展 `baseBranch/headBranchName/syncDefaultFirst` | 既有 Idempotency-Key |
| GET `/runs/:id/publish-preview` | PR 预览 | 读 |
| POST `/runs/:id/actions/publish` | 接受 `title/body/pushBaseBranch` | 既有动作队列 |
| POST `/runs/:id/inquiries` | 发起旁路提问 | 并发控制 |
| GET `/runs/:id/inquiries` | 会话列表 | 读 |
| GET `/runs/:id/inquiries/:inquiryId` | 单条结果（轮询） | 读 |
| DELETE `/runs/:id/inquiries/:inquiryId` | 删除会话 | 写独立存储 |

前端类型统一同步到 `web/src/types.ts`；类型对拍由现有 `test/web-types-parity.test.ts` 扩展覆盖。

---

## 10. 状态与清理迁移

- `RunState` 新增：
  - `stageSummaries?: StageSummary[]`
  - `managedBranches?: string[]`（runner 创建过的 head + task 分支）
  - `pullRequestTitle?`、`pullRequestBodyPath?`（发布审计）
- `RunStateStore`：`transition` 扩展 extra 参数并自动 append 摘要；`runStateSchemaVersion` 升到 2。
- `RunRetention.removeRunGitArtifacts`：优先按 `managedBranches` 精确删除；兼容旧 run 仍按 `agent-team/<runId>/*` 前缀兜底；**自定义 head 分支删除前必须在删除确认弹窗列出**。
- 删除 run 时同步 `rm -rf .agent-team/inquiries/<runId>`；单独删除 inquiry 只删单文件。
- 启动清扫 `sweepUnknownRunArtifacts` 保持只清扫 `agent-team/<runId>/*` 前缀，不碰用户自定义分支（防止误删）。

---

## 11. 测试计划

| 文件 | 覆盖 |
| --- | --- |
| `test/git-sync.test.ts` | fetch/ff-only 成功、无本地分支补建、非 ff 拒绝、checkout 分支用 merge --ff-only、非 checkout 用 update-ref、无 remote/脏工作区失败 |
| `test/branch-service.test.ts` | 命名校验（check-ref-format）、冲突 409 与建议名、无 git/空仓库/无提交矩阵、remote default 检测优先级 |
| `test/workflow.test.ts`（扩展） | `baseBranch`/`headBranchName`/`syncDefaultFirst` 进入 run；custom head 写入 `managedBranches`；base 不存在时终态且错误可读 |
| `test/github-publish.test.ts`（扩展） | 默认正式 PR 无 `--draft`；draft=true 仍加 `--draft`；已存在草稿时调 `gh pr ready`；title/body 覆盖与长度校验；base 不在远端时拒绝/显式 pushBase |
| `test/stage-summaries.test.ts` | transition 自动追加、状态不变不重复、highlights 截断、旧 v1 state 兼容 |
| `test/inquiry.test.ts` | 不写 state/不发 transition/不 emit run 事件；并发上限；删除；超时/失败/取消；run 删除级联清理 |
| `test/web-types-parity.test.ts` | 新增 API 类型对拍 |
| `web/e2e`（扩展） | 启动器选分支/生成分支名/同步勾选；发布预览编辑并创建；问进度抽屉删除会话 |
| `vitest.config.ts` | exclude 增加 `.analysis/**`（修复当前 `pnpm test` 误扫） |

---

## 12. 实施顺序（P0 → P1 → P2）

### P0 分支与发布闭环
1. `GitManager` 新增方法 + `GitSyncService` + `BranchService` + 失败分类扩展。
2. HTTP：`/git/status`、`/branches`、`/branches/sync`、`/branches`、StartRun 扩展。
3. `LocalWorkflowRunner` 接受并落盘新字段；`managedBranches` 清理迁移。
4. 发布预览 + 正式 PR + `gh pr ready` + 默认 `draftPullRequest:false`。
5. UI：RunLauncher Git 区块、项目设置 Git 面板、顶栏真实分支、PublishDialog。
6. 测试 + README/配置文档更新。

### P1 摘要与旁路咨询
7. `StageSummary` 数据模型 + transition 自动摘要 + 关键节点 highlights。
8. UI：EventConsole“阶段”页签、DagCanvas 阶段条、TaskInspector 摘要。
9. `src/inquiry/*`（store/coordinator/runner/prompt）+ HTTP + UI 抽屉。
10. 测试。

### P2 边界健壮性
11. 空仓库初始化引导（git init/初始提交/补建本地默认分支）在 UI 落地。
12. `vitest.config.ts` exclude `.analysis/**`；清理/文档收尾。
13. 全量 `pnpm check` + `pnpm test` + 手工验收矩阵（对照 5.4）。

---

## 13. 验收标准（对照用户原话）

- [ ] 界面上分支是可选的，不是只展示 main。
- [ ] 可以在界面创建分支；新建运行时能按目标生成分支名，重名有自动建议。
- [ ] 无 git / 空仓库 / 无 gh / 无权限等场景都有明确提示和可执行引导，不出现裸错误。
- [ ] 远端可访问且 gh 有权限时，有同步远端默认分支按钮；新建分支默认先同步并以同步结果为基地。
- [ ] 每个阶段有精简总结；默认界面不出现推理过程和原始输出。
- [ ] 发布前能预览标准 PR 标题/描述；点击发布创建的是**正式 PR**，等待审阅/合并，不自动合并。
- [ ] 执行中可向当前阶段提问；删除会话或删除 run 不污染主运行状态。

---

## 14. 已确认的默认值（用户已拍板）

1. 自动分支名默认 `feature/<goal-slug>`；PR 标题默认 `feat: <goal-summary>`；目标含 fix 等语义时 UI 提供前缀切换。
2. 旁路提问上限：每 run 20 条、回答 ≤800 字、关键点 ≤6 条。
3. 空仓库初始化：检测到 unborn HEAD / 无提交时，由用户点击“创建空初始提交”（`git commit --allow-empty -m "chore: initial empty commit"`），工具不自动初始化。
4. 既有项目配置显式 `draftPullRequest: true` 保持不变；仅新项目默认 `false`。发布预览中对草稿配置显示黄条提示，并提供“本次创建为正式 PR”勾选。

---

## 15. 体验打磨（在 Git/PR 闭环之后）

> 状态：1–3 已落地并通过测试；4、5 与「新增项」排在之后。
> 原则：Git 干净是硬约束，但清理和解释是产品职责。三套产物（壳 / 控制服务 / 前端）必须可对账。

### 15.1 现在做（1–3）

1. **桌面更新路径**
   - 启动器和工作台显示壳版本、控制服务版本、前端构建号。
   - 三套不一致时明确提示「这是旧前端 / 旧控制面」，不要让用户猜“是不是没改到”。
   - 文档写死：改 UI 日常用 `pnpm desktop:dev`；给自己用必须重装 App。只刷新窗口看不到更新。
2. **脏工作区翻译成操作**
   - `dirty-worktree` 列出具体文件，并区分人手改动和 Agent 残留（`agent-team/` 路径）。
   - 提供：查看 diff、stash 主工作区、刷新状态。
   - 同步 / 开跑 / 建分支禁用时写清原因，而不是只亮红点。
3. **主路径收敛**
   - 日常屏：运行 + 项目 Git。编排保留。演进 / 经验收到「实验室」，不抢主路径。
   - 阶段条上能直接处理「等人」的那一步：审批、发布。
   - 文案原则：崩溃可解释、可续跑；不假装同一个 Agent 进程还活着。

### 15.2 1–3 完成后再做（新增项，不是 4/5）

- 三件套版本对账的自动升级通道（先显示，再谈自动更新）。
- Git 面板过滤 / 一键只清 `agent-team/` 临时分支，不动用户 `feature/*`。
- 开跑前用量区间提示；旁路提问单独标明会耗额度。
- 休眠 / 杀进程后续跑的人话（从已合并波次继续，未完成任务换新分支）。
- 新 API 对旧客户端降级为「请更新 App」，而不是泛化的发布失败。
- 第一次对某仓库运行时的信任确认（本机 worktree 不是沙箱）。

### 15.3 明确暂缓

- 4. 用 3–5 个真实仓库连续跑打磨现场。
- 5. 评测实验室、MCP host、Docker/远程执行、触发器等平台能力。

### 15.4 连接 GitHub 与 Changes

应用内授权、主工作区 Changes、Commit & Push 不在本文展开，见 `docs/github-connect-and-changes.zh-CN.md`。本文的「不落盘 token / 不自动登录 gh / 脏工作区不能开跑」仍然有效。
