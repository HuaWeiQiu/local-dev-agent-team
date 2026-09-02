# 连接 GitHub 与 Changes 面板 — 详细设计

> 状态：已评审并进入实现（2026-08-17）
> 范围：应用内连接 / 授权 GitHub、主工作区 Changes（勾选、统计、Commit、Push）
> 前置：`docs/git-branch-pr-inquiry-design.zh-CN.md`、`docs/product-plan.zh-CN.md`、`docs/security.md`
> 对标：Cursor 的 Repositories / Changes / 分支 / Commit & Push，以及截图里没圈出来的勾选、+/-、对话投影

---

## 1. 目标

把「本机已登录 `gh`」从终端提示升级成工作台里的第一公民，并把脏工作区从「挡住开跑的红灯」升级成日常 SCM：

```text
连接 GitHub（应用内向导，授权源仍是本机 gh）
  → 看见当前账号、当前仓、能否推送 / 建 PR
  → Changes：文件列表 + 勾选 + +/- 行数
  → 写 message → Commit
  → 已连接则可 Push 当前分支（禁止 force-push）
  → 主工作区干净后，再走既有「开跑 / 同步 / 正式 PR」
```

承诺只有这一句：

> 你在自己的可信仓库里改代码。我帮你连上本机 GitHub 身份，让未提交改动看得见、勾得选、推得出。合不合并、开不开跑，仍由你决定。

### 1.1 需求映射

| ID | 用户需求 | 设计落点 |
| --- | --- | --- |
| G1 | 可以设置连接 / 授权 GitHub | 项目 Git 面板「连接 GitHub」；底层 `gh auth login --web` |
| G2 | 不要跳去终端猜命令 | 按钮 + 轮询 + 人话失败态；不读、不存 token |
| G3 | Cursor 那样的 Changes | 文件勾选、状态徽章、仓级 +/-、单文件 diff |
| G4 | Commit & Push 是主按钮 | `POST /git/commit`、`POST /git/push`；Push 从不带 `--force` |
| G5 | 顶栏随时知道在哪条线、有多少未提交 | 顶栏分支按钮旁显示 `+N -M` 与当前分支 |
| G6 | 项目坞更像仓库列表 | 顶栏 / Git 面板展示 `owner/repo`，不只本地路径 |
| G7 | 和正式 PR 分工清楚 | Changes 是日常提交；`PublishDialog` 仍是 run 结束后的正式 PR |

### 1.2 明确不做（本期与原则）

- 自建 GitHub OAuth / GitHub App / 粘贴 PAT 输入框
- 把 token 写入 `agent-team.yaml`、桌面设置、SQLite、run 状态
- 从 GitHub 浏览远程仓并一键 clone 陌生仓库
- 完整 IDE SCM：blame、mergetool、interactive rebase、amend、force-push
- 允许脏工作区直接开跑 / 同步 / 建基地分支（只允许先 commit 或 stash）
- 自动合并、自动 `git init`、自动登录 `gh`
- Agent worktree 里的改动混进主工作区 Changes（Changes 只看主工作区）

---

## 2. 设计原则（不可破坏）

1. **授权源是本机 `gh`，不是本产品。** 我们只拉起浏览器登录并探测结果。token 继续只活在 `gh` 的凭据库（keyring）里。
2. **不落盘 token。** `gh auth status` 禁止 `--show-token`。解析 JSON 时显式丢弃任何 `token` 字段。日志与错误信息走现有 `redactEnvSecrets`。
3. **不信任 UI。** 路径、分支、clean 状态、远端存在性、白名单全部在服务端复验。勾选列表不能让客户端指定仓库外路径。
4. **Git 可恢复。** Push 只用 `git push --set-upstream <remote> <current-branch>`。禁止 `--force`、`--force-with-lease`、`--delete`、改历史。
5. **无 shell 拼接。** 所有 `git` / `gh` 调用沿用 `spawn` 参数数组。
6. **主工作区干净仍是开跑硬约束。** Changes 的存在是为了让用户自己把工作区变干净，不是绕过约束。
7. **人工点一次才登录 / 提交 / 推送。** 不在启动时偷偷弹浏览器，不在探测失败时自动 refresh。
8. **向后兼容。** 未连接时本地 run、stash、看 diff 仍可用；只是不能 Push / 发 PR。

---

## 3. 现状盘点

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| gh 探测 | `GitProjectService` 调 `gh --version` / `gh auth status` / `gh repo view` | 无账号、host、scopes、进行中登录 |
| 登录 | 文案叫用户去终端跑 `gh auth login` | 无应用内向导 |
| 脏文件 | `dirtyFiles`：path / 中文 status / origin | 无 staged 区分、无 +/-、无 checkbox |
| diff | `GET /git/diff` 整仓截断文本 | 无单文件 diff、无 numstat |
| 提交 | `GitManager.commit` 给 worktree 用；主工作区只有空初始提交 | 无按路径提交 |
| 推送 | `GitManager.push` 给发布器用 | 无主工作区当前分支 Push API |
| UI | `DirtyWorktreePanel` 列表 + stash | 不像 Changes；Commit & Push 不存在 |
| 顶栏 | 分支按钮只显示默认/当前 run 分支对 | 无 +/-、无 `owner/repo` |
| 项目坞 | 本地文件夹 | 不显示 GitHub 仓名 |

---

## 4. 总体架构

```text
Web UI
  ├─ ProjectGitPanel     : 连接 GitHub + Changes + 原有分支/同步
  ├─ ChangesPanel        : 勾选 / 统计 / message / Commit / Push / 单文件 diff
  ├─ DirtyWorktreePanel  : 瘦身为 Changes 的只读提醒（开跑器仍复用）
  ├─ GitBranchPicker     : 未连接时给「连接 GitHub」入口
  └─ App 顶栏            : 当前分支 + +/- + owner/repo

HTTP（项目路由）
  ├─ GET  /git/status              扩展账号 / 统计 / 可提交可推送
  ├─ GET  /git/changes             Changes 快照（文件 + numstat + 可操作位）
  ├─ GET  /git/diff?path=          可选单文件 diff（无 path 保持整仓）
  ├─ POST /git/connect             拉起 gh auth login --web（或 refresh）
  ├─ GET  /git/connect             查询进行中的连接会话
  ├─ POST /git/commit              按勾选路径提交
  └─ POST /git/push                推送当前分支（ff 语义，禁止 force）

后端
  ├─ src/github/auth.ts            连接会话、账号探测、永不返回 token
  ├─ src/github/client.ts          +authSnapshot / startLogin / refreshScopes
  ├─ src/git/manager.ts            +changes / stageExactPaths / commitPaths / aheadBehind
  ├─ src/git/project.ts            Changes / commit / push / 路径校验
  └─ src/server/http-routes-git.ts 上述路由
```

连接会话按**项目根**驻留在控制服务进程内存，不写磁盘、不进 run 状态。服务重启即消失，UI 再点一次即可。

---

## 5. Feature A：连接 / 授权 GitHub

### 5.1 产品语义

「已连接」= 本机 `gh` 对当前仓库的 host 有可用账号，且 `gh repo view` 证明对该仓可读。

「可发布 / 可推送」另外要求：

- origin 已配置且在 `github.allowedOwners` 白名单内（未配置白名单则只警告）
- 账号 scopes 含 `repo`（建 PR / 推私有仓）；缺 `workflow` 时若改动触及 `.github/workflows/**` 则黄条，不阻断普通 push

产品文案用「连接 GitHub」，实现文案不说「OAuth 应用」「我们的 GitHub App」。设置里的说明是：

> 使用本机已安装的 GitHub CLI（`gh`）登录。授权发生在 GitHub 官网，令牌保存在系统钥匙串，不会写入本项目。

### 5.2 账号快照（只读，可高频）

`GET /git/status` 增加（全部可选，旧客户端忽略未知字段）：

```ts
interface GithubAccountSnapshot {
  host: string;                 // 默认 github.com；企业仓用 origin host
  login?: string;               // 当前 active 账号
  state: "missing-cli" | "logged-out" | "logged-in" | "insufficient" | "error";
  scopes: string[];             // 来自 gh auth status --json hosts，无 token
  tokenSource?: "keyring" | "env" | "plaintext" | "unknown";
  gitProtocol?: "https" | "ssh";
  repoNameWithOwner?: string;   // gh repo view 成功时
  canLogin: boolean;            // gh 已安装
  canPush: boolean;             // 已登录 + 远端可达 + 白名单通过
  canPublish: boolean;          // 沿用现有 canPublish
  detail?: string;              // 人话，供徽章 title
}

interface GitEnvironmentStatus {
  // …既有字段
  githubAccount?: GithubAccountSnapshot;
  changeSummary?: {
    files: number;
    insertions: number;
    deletions: number;
  };
  canCommit?: boolean;
  canPushBranch?: boolean;
  aheadBehind?: { ahead: number; behind: number };
}
```

探测实现：

```text
1. gh --version                         → 失败 = missing-cli
2. gh auth status --hostname <host> --json hosts
     - 禁止附加 --show-token
     - 解析 hosts[host] 中 active=true 的项
     - 丢弃 token / 任何看起来像 ghp_/gho_/github_pat_ 的字段
     - 无账号或 state != success → logged-out
3. gh repo view --json nameWithOwner,url,defaultBranchRef
     - 成功 → logged-in，填 repoNameWithOwner
     - 失败且已登录 → insufficient 或沿用现有 gh-no-repo-access
4. 不把 stdout 全文写入事件账本；只留 login / host / scopes / state
```

`host` 解析：`origin` URL 的 hostname；解析失败则 `github.com`。企业 GitHub（`github.example.com`）登录时把该 host 传给 `--hostname`。

### 5.3 连接会话

`POST /git/connect`：

```ts
request:  { action?: "login" | "refresh" }   // 默认 login
response: GithubConnectSession
```

```ts
interface GithubConnectSession {
  id: string;
  action: "login" | "refresh";
  host: string;
  status: "starting" | "waiting-browser" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  login?: string;
  error?: string;
}
```

服务端行为：

```text
1. 已有进行中会话 → 直接返回该会话（幂等，不并发生成两个浏览器）
2. gh 未安装 → 400 gh-missing，文案含安装指引 https://cli.github.com/
3. 已登录且 action=login → 仍允许重跑（换账号 / 补 scopes）；先返回当前快照并启动
4. spawn（禁止 shell）：
     login:
       gh auth login --web --git-protocol https --hostname <host>
     refresh（已登录但权限不足）：
       gh auth refresh --hostname <host> --scopes repo,read:org,workflow
5. 会话 status=waiting-browser；GET /git/connect 可查询
6. 进程退出码 0 → 立刻重跑 authSnapshot；成功则 succeeded
7. 非 0 / 超时（默认 10 分钟）→ failed，错误走 github/errors.ts 分类
8. 服务关闭或新的明确取消：杀掉该子进程（现有 process group 机制）
```

`GET /git/connect`：无会话时返回 `{ status: "idle" }`。UI 在 `waiting-browser` 时每 2s 轮询，成功后刷新 `/git/status`。

超时与交互：

- `gh auth login --web` 会自己打开系统浏览器；桌面壳无需再 `open`。
- 控制服务把该 spawn 的 timeout 设为 600_000ms。HTTP 请求**立即返回会话**，不阻塞到用户点完授权。
- 用户关掉浏览器或在 `gh` 里取消：进程退出，会话 failed，文案「未完成授权，可再点一次连接 GitHub」。

### 5.4 UI

位置：`ProjectGitPanel` 顶部能力行右侧；`GitBranchPicker` 在 `gh` 徽章为坏时给同样按钮。

| 状态 | 展示 | 主按钮 |
| --- | --- | --- |
| `missing-cli` | 红徽章「未安装 gh」 | 打开安装说明（外链） |
| `logged-out` | 黄徽章「未连接 GitHub」 | **连接 GitHub** |
| `waiting-browser` | 旋转「正在打开 GitHub 登录…」 | 禁用；可「我已取消」→ 刷会话 |
| `logged-in` | 绿徽章 `login@host` + `owner/repo` | 「重新连接」次要按钮 |
| `insufficient` | 黄徽章「已登录但没有仓库权限」 | **补授权**（refresh） |
| 白名单失败 | 红条，不提供 Push | 无 |

设置页说明不超过三行。不要做 PAT 粘贴框，即使高级选项也不做。

未登录文案从「请在本机终端运行 gh auth login」改为：

> 还没连接 GitHub。点「连接 GitHub」，在打开的浏览器里授权本机 `gh`。

### 5.5 和正式 PR 的关系

- 连接成功只解决身份。发布仍走 `PublishDialog` + 最终审批。
- `canPublish` 继续要求工作区干净；Changes 提交之后才会变绿。
- 不在连接成功后自动 push、自动建 PR。

---

## 6. Feature B：Changes 面板

### 6.1 概念

Changes = **主工作区**相对 `HEAD` 的未提交改动（staged + unstaged + untracked）。

不是：

- Agent worktree 里的进行中任务
- 已提交但未 push 的 commits（那是顶栏 `ahead`，单独显示「↑N」）
- `git stash` 列表（本期不做 stash pop UI；现有「先帮我收好」保留）

### 6.2 快照 `GET /git/changes`

```ts
interface GitChangeFile {
  path: string;                 // 仓库相对 POSIX 路径
  originalPath?: string;        // rename/copy 的旧路径
  xy: string;                   // porcelain v1，两位
  status: string;               // 现有中文标签
  origin: "user" | "agent";
  staged: boolean;              // index 侧有变更
  unstaged: boolean;            // worktree 侧有变更
  untracked: boolean;
  insertions: number;           // numstat；二进制为 0
  deletions: number;
  binary: boolean;
}

interface GitChangesSnapshot {
  branch?: string;
  files: GitChangeFile[];
  insertions: number;
  deletions: number;
  canCommit: boolean;           // 有文件 + 有提交者身份 + 是仓库
  canPush: boolean;             // 已连接 + 有远端 + 白名单 + 当前分支存在
  ahead: number;
  behind: number;
  identityConfigured: boolean;
  identityReason?: string;
}
```

统计：

```text
git diff --numstat HEAD                 # 已跟踪的 worktree+index vs HEAD
git diff --numstat --cached HEAD        # 仅 staged（用于 staged 行数，可与上式合并去重）
未跟踪文件：insertions = 行数（读文件，单文件上限 200_000 字节，超限当 binary）
二进制 / 超限：binary=true，insertions=deletions=0，UI 显示 “binary”
仓级 +/- = 各文件之和
```

`ahead/behind`：`git rev-list --left-right --count @{upstream}...HEAD`；无 upstream 则 `ahead=0, behind=0`，Push 时走 `--set-upstream`。

### 6.3 单文件 diff

`GET /git/diff?path=<repo-relative>`：

- 无 `path`：保持现有整仓 diff（含未跟踪文件名列表）
- 有 `path`：服务端 `normalizeRepositoryRelativePath`，拒绝绝对路径、`..`、反斜杠、NUL
- 已跟踪：`git diff --no-ext-diff --unified=40 HEAD -- <path>`
- 未跟踪：返回文件内容预览（同样截断 20_000 字符），前缀标注 `未跟踪`
- 二进制：`{ content: "二进制文件，不显示 diff", truncated: false, binary: true }`

### 6.4 提交 `POST /git/commit`

```ts
request: {
  message: string;              // trim 后 1–2000 字符
  paths: string[];              // 1–200 条，仓库相对路径
}
response: {
  commit: string;
  branch?: string;
  files: string[];
}
```

服务端：

```text
1. status()：必须是仓库且 root 匹配
2. 校验 message、paths 长度；逐条 normalizeRepositoryRelativePath
3. 当前 porcelain 集合必须包含每一条 path（或 rename 的 new path）
   多出来的、已干净的、逃逸仓库的 → 400
4. 若存在冲突（xy 含 U / DD / AA）→ 400，文案要求先在外部解决
5. git add -- -- <paths…>          # 只 add 勾选路径
6. 再读 porcelain：index 中不得出现未授权路径
7. git commit -m <message>         # 不 --amend、不 --no-verify 以外的花样
8. 返回新 HEAD
```

提交者身份：若 `git config user.name` / `user.email` 在该仓无效，返回现有 `no-git-identity` 人话，不替用户写全局 config。

`agent-team/` 路径可以勾选提交，但 UI 默认不预勾，并标「Agent 残留」。

### 6.5 推送 `POST /git/push`

```ts
request:  { }                     // 无 body；只推当前 checkout 分支
response: {
  remote: string;
  branch: string;
  commit: string;
  setUpstream: boolean;
}
```

```text
1. 必须 gh 已登录、远端配置、白名单通过、remote 可达
2. 必须有当前分支（拒绝 detached HEAD）
3. 工作区可以仍脏：Push 推的是已提交历史，不把未提交改动送走
4. 若 behind>0 → 409，文案「远端有未拉取提交，请先同步（ff-only）或人工处理」，绝不 pull --rebase
5. git push --set-upstream <remote> <branch>
6. 失败分类：not-logged-in / token-permissions / network / other
```

禁止的 argv：`--force`、`--force-with-lease`、`--delete`、`+branch`、`:branch`。

### 6.6 UI：`ChangesPanel`

放在 `ProjectGitPanel` 里、分支表上方。开跑器里的 `DirtyWorktreePanel` 继续承担「先看/先收好」，并加一行链到项目 Git（「去 Changes 里提交」）。

布局（对照 Cursor Changes，收敛到我们的设置面板密度）：

```text
Changes                    feature/foo    +137 -90    ↑1
[✓] 全选
[✓] M  src/foo.ts                         +12 -3
[ ] New web/bar.tsx                       +40 -0
[ ] M  agent-team/tmp.md                  Agent
message  ________________________________  [Commit]
                              [Commit & Push]   [先帮我收好]
```

交互：

- 默认预勾 `origin=user` 的文件；`origin=agent` 不预勾
- 点文件名展开该文件 diff（调用 `?path=`）
- Commit 只提交勾选；未勾选留在工作区
- Commit & Push = 先 commit 勾选（若有），再 push；仅 push 已提交历史时，若无勾选且 `ahead>0`，按钮文案变为 **Push ↑N**
- 未连接：Push 禁用，旁边就是「连接 GitHub」
- `behind>0`：Push 禁用，提示去同步
- 冲突文件：整行红、不可勾选

### 6.7 顶栏

`App.tsx` 分支按钮：

```text
<GitBranch /> feature/foo   +17 -5
```

干净时只显示分支名。`gitStatus.remoteOwner` 或 `githubAccount.repoNameWithOwner` 作为 title。项目切换下拉可在名称后附 `owner/repo`（有则显示）。

本期不做对话里的 `Edited +17 -5` 投影（G5 的弱形式先走顶栏；对话投影单独立项）。

---

## 7. 边界矩阵

| 场景 | 连接 | Changes | 开跑 / 同步 | 发布 PR |
| --- | --- | --- | --- | --- |
| 无 gh | 安装说明 | 可 commit，不可 push | 本地可 | 禁用 |
| gh 未登录 | 连接按钮 | 可 commit，Push 禁用 | 本地可 | 禁用 |
| 已登录无仓权限 | 补授权 | 可 commit | 本地可 | 禁用 |
| 无远端 | — | 可 commit，不可 push | 本地可 | 禁用 |
| 脏工作区 | — | 主场地 | 禁用，直到 commit/stash | 禁用 |
| 冲突 | — | 列出，不可 commit 冲突文件 | 禁用 | 禁用 |
| detached HEAD | — | 可 commit | 视干净与否 | Push 禁用 |
| 白名单外远端 | 显示账号 | 可 commit，Push 禁用 | 同步禁用 | 禁用 |
| 进行中的 Agent run | 不影响 | 仍只看主工作区 | 既有占用/租约逻辑 | 既有 |

---

## 8. 安全

1. 连接会话只在内存；不含 token。
2. `gh auth status --json hosts` 的响应在进入日志前剥离 `token`。
3. 提交路径必须是当前 dirty set 的子集，且通过 `normalizeRepositoryRelativePath`。
4. Push 固定 argv，不接受客户端传来的 remote/branch/refspec（remote 来自配置，branch 来自 `symbolic-ref HEAD`）。
5. 不把 diff 全文写入事件账本；Changes 是读接口，按需截断。
6. 既有 `github.allowedOwners`、loopback、CSP、session token 文件模式全部保持。
7. `gh auth login --web` 是用户手势触发的子进程，不是 Agent 工具。

---

## 9. 配置与版本

- **不新增 yaml 项。** 不把「已连接」写成配置。连接状态永远是本机 `gh` 的投影。
- 新 API 纳入 `clientBuildTooOld` 门控：`git/changes`、`git/connect`、`git/commit`、`git/push`。
- 构建号从 `2026.08.15-lifecycle` 升为 `2026.08.17-github-changes`（`CONTROL_PLANE_BUILD`、Vite、Vitest、Tauri `expected_desktop_build`、桌面测试、`web/src/api.ts` 回退值）。`desktop-latest.json` 是已发布包清单，**不在源码改动里冒充已发布**。

---

## 10. 测试

| 文件 | 覆盖 |
| --- | --- |
| `test/github-auth.test.ts`（新） | JSON 剥离 token；login/refresh argv 无 shell；已有会话不重复 spawn；未安装 gh |
| `test/github-client.test.ts` | `authSnapshot` 调 `--json hosts` 且无 `--show-token` |
| `test/git-project.test.ts` | changes 统计；按路径提交只带勾选文件；拒绝逃逸路径；push 在 behind 时 409；push argv 无 force |
| `test/git-manager.test.ts` | `commitPaths` 只 stage 指定路径 |
| `test/github-errors.test.ts` | 连接失败文案指向按钮而非纯终端 |
| `test/version.test.ts` | 旧客户端打新 git API 被拒 |

手工：本机点「连接 GitHub」应打开浏览器；取消后可重试；提交后顶栏 +/- 清零。

---

## 11. 实现顺序

1. 本文 + 产品方案回写
2. `GithubClient` 账号快照 + `github/auth.ts` 连接会话
3. `GitManager` / `GitProjectService` 的 changes / commitPaths / pushCurrent
4. HTTP 路由与 contracts
5. `ChangesPanel` + `ProjectGitPanel` 连接条 + 顶栏
6. 测试与 `pnpm check`

---

## 12. 以后再做

- 对话气泡里的 `Edited 1 file +17 -5`
- 从 GitHub 列表远程仓并 clone 到用户指定目录（三步确认）
- stash 列表 / pop
- 多仓底栏同时显示每仓分支
- GitHub Enterprise 以外的 GitLab

---

## 13. 已拍板

1. 授权源 = 本机 `gh` + 浏览器，不做自建 OAuth。
2. Changes 只作用于主工作区。
3. Push 禁止任何 force。
4. 脏工作区仍不能开跑，只能先 commit 或 stash。
5. 不落盘 token，不新增「已连接」配置项。
