# 全局 CLI 检索 + 设置默认 + 新建运行角色选型

- 文档状态：**已实现 Phase 1–3**（检索 / 全局设置 / 新建运行 roleBindings → ephemeral profile；Kimi 仅展示不可调用）
- 日期：2026-08-13
- 动机：用户不想每个项目、每次新建运行都手改 `agent-team.yaml`；希望从本机已安装的 Codex / Grok / Kimi / Claude Code **检索配置与授权状态**，在**全局设置**里选默认，在**新建运行**时按角色选 CLI、模型、思考深度。

关联：
- 现状与边界：[multi-profile-flexibility.zh-CN.md](multi-profile-flexibility.zh-CN.md)
- 当前项目配置仍是 `agent-team.yaml` 的 profiles / roles

---

## 1. 目标体验（你要的）

```text
① 检索（全局、只读扫描本机）
   找到 codex / grok / kimi / claude 的 CLI 与配置文件
   → 汇总：是否安装、是否已授权、有哪些模型、思考深度/推理档位
        ↓
② 全局设置（机器私有）
   选默认：默认 CLI、默认模型、默认思考深度、默认权限倾向
   可自由改，不写进业务仓库 git
        ↓
③ 新建运行（按角色选型）
   每个角色：Agent CLI × 模型 × 思考深度（+ 可选权限）
   未选手动时，用全局默认；项目 yaml 可再收紧「允许列表」
```

**一句话**：本机能力全局可见、全局可设默认；项目只决定「能不能用 / 要不要更严」；单次 run 决定「这次用谁」。

---

## 2. 三层权威（必须分清）

| 层 | 存哪 | 权威范围 | 是否进项目 git |
| --- | --- | --- | --- |
| **L0 本机 CLI 事实** | 各 CLI 自己的目录（见 §3） | 只读镜像：装了啥、登录了没、模型列表 | 否 |
| **L1 全局 Agent Team 设置** | `~/.agent-team/desktop-settings.json`（或同目录 yaml） | 默认角色映射、默认模型/思考深度、上次检索结果缓存 | 否 |
| **L2 项目策略** | 项目 `agent-team.yaml` | 允许哪些 adapter、权限上限、质量门禁、策略拓扑 | **是**（可复现） |
| **L3 单次 run 覆盖** | 启动 API `profileOverrides` / 扩展字段 | 本次 run 的角色选型 | 否（进 run 快照审计） |

优先级（高 → 低）：

```text
L3 单次覆盖  >  L1 全局默认  >  L2 项目 roleProfiles/defaultProfile
```

项目层仍可 **禁止** 某 adapter（例如禁止 workspace-write 的 profile 给总控）——禁止优先于全局默认。

---

## 3. 本机检索：扫什么（基于本机实测路径）

实现时做 **适配器插件**，每个 CLI 一个 probe，不要写死一家。

| CLI | 可执行文件 | 配置 / 授权线索（本机常见） | 可抽出的非密钥字段 |
| --- | --- | --- | --- |
| **Codex** | `codex`（PATH / Homebrew） | `~/.codex/config.toml`、`~/.codex/auth.json`（存在即「可能已登录」） | `model`、`model_reasoning_effort`、`model_providers.*`（name/base_url/wire_api）、features |
| **Grok** | `~/.grok/bin/grok` 或 PATH | `~/.grok/config.toml` | `[models]` / `[model.*]` 的 model 名、context_window、default；**api_key 只报 hasKey，不回传** |
| **Kimi Code** | `~/.kimi-code/bin/kimi` | `~/.kimi-code/config.toml` | `default_model`、`[models.*]`、`[thinking].effort`、providers 类型与 base_url |
| **Claude Code** | `claude` | `~/.claude/settings.json` | `model`、`availableModels`、permissions 摘要 |

### 3.1 检索输出模型（API 返回，永不含明文密钥）

```ts
type CliInventory = {
  scannedAt: string;
  clis: Array<{
    id: "codex" | "grok" | "kimi" | "claude";
    binary?: string;           // 解析到的绝对路径
    installed: boolean;
    version?: string;          // `codex --version` 等，超时则省略
    auth: {
      status: "unknown" | "present" | "missing" | "invalid";
      // present = 配置/auth 文件存在；invalid 仅在主动 probe 登录接口失败时
      detail?: string;         // 中文短句，如「auth.json 存在」「未找到 API key 配置」
    };
    configPaths: string[];     // 实际读到的路径，便于用户排查
    models: Array<{
      id: string;              // 配置内 id 或模型名
      label: string;           // UI 展示
      provider?: string;
      reasoningOptions?: string[]; // 如 ["low","medium","high","xhigh","max"]
    }>;
    defaultModel?: string;
    defaultReasoning?: string;
    providers?: Array<{ id: string; baseUrl?: string; wireApi?: string }>;
  }>;
};
```

### 3.2 安全规则（硬约束）

1. **禁止**把 `api_key` / `auth.json` 内容写入项目目录、日志、SSE、PR artifact。  
2. API 只返回 `auth.status` + 模型元数据。  
3. 检索默认 **只读文件 + 可选 `--version`**；不主动拿用户 key 去打付费 API（除非用户点「验证登录」）。  
4. 路径白名单：仅扫已知 home 子目录与 PATH 解析结果，不做全盘扫描。

---

## 4. 全局设置（桌面「设置」页）

### 4.1 存储

`~/.agent-team/desktop-settings.json`（桌面壳读写；控制服务只读投影）：

```jsonc
{
  "version": 1,
  "inventoryCache": { /* 最近一次 CliInventory，可过期 */ },
  "defaults": {
    "roles": {
      "orchestrator": { "cli": "codex", "model": "gpt-5.6-sol", "reasoning": "max" },
      "architect":    { "cli": "grok",  "model": "grok",        "reasoning": "high" },
      "worker":       { "cli": "grok",  "model": "grok",        "reasoning": "high" },
      "reviewer":     { "cli": "grok",  "model": "grok",        "reasoning": "high" },
      "tester":       { "cli": "grok",  "model": "grok",        "reasoning": "high" }
    }
  },
  "ui": {
    "showCliPickerInRunLauncher": true
  }
}
```

### 4.2 UI

- **设置 → Agent CLI**  
  - 按钮「重新检索」  
  - 表格：CLI | 已安装 | 授权 | 默认模型 | 思考深度 | 操作  
  - 下方「角色默认」：五角色各自下拉 CLI / 模型 / 思考深度  
- 未安装的 CLI 灰显，不可设为默认。  
- 授权 `missing` / `invalid` 显示中文提示与跳转（打开对应 CLI 登录文档，不代填密钥）。

---

## 5. 新建运行：角色选型 UI

替换（或升级）当前「角色 Profile 覆盖」：

```text
角色        Agent CLI     模型              思考深度
总控        [Grok    ▾]  [grok         ▾]  [high ▾]
架构        [Grok    ▾]  [grok         ▾]  [high ▾]
执行        [Grok    ▾]  [grok-worker  ▾]  [high ▾]
审查        [Codex   ▾]  [gpt-5.6-sol  ▾]  [xhigh▾]
测试        [Grok    ▾]  [grok         ▾]  [medium▾]
```

- 初始值 = L1 全局默认，再套项目允许列表过滤。  
- 切换 CLI 时模型列表随 inventory 刷新。  
- 高级区仍可显示「映射到的内部 profile 名」供排障（可折叠）。

### 5.1 启动 API 扩展（建议）

现状：`profileOverrides: Record<role, profileName>`。

扩展为（兼容旧字段）：

```ts
type StartRunInput = {
  goal: string;
  strategy?: string;
  /** 旧：直接指定项目内 profile 名 */
  profileOverrides?: Record<string, string>;
  /** 新：按角色选 CLI 能力 */
  roleBindings?: Record<string, {
    cli: "codex" | "grok" | "kimi" | "claude";
    model?: string;
    reasoning?: string;
  }>;
};
```

服务端将 `roleBindings` **解析成一次 run 的 ephemeral profile**（见 §6），写入 run 快照，不写回 `agent-team.yaml`。

---

## 6. 运行时：如何接到现有 Profile 体系

不要推翻现有 `profiles` / adapter 管道，做 **解析层**：

```text
roleBindings / 全局默认 / 项目 default
        ↓
resolveRuntimeProfile(role) →
  {
    adapter, model, reasoning, permission, externalTools,
    codexProvider?, /* 仅结构，密钥仍由 CLI 自己读 */
    source: "run-binding" | "global-default" | "project-profile"
  }
        ↓
现有 ProfiledAgentService / adapter.invoke
```

### 6.1 与项目 yaml 的关系

| 模式 | 行为 |
| --- | --- |
| **A. 纯项目 profile（现状）** | 无全局设置时完全兼容 |
| **B. 全局默认 + 项目允许** | 项目可声明 `adapters.allow: [codex, grok]`；不允许的 CLI 在 UI 禁用 |
| **C. 项目显式 profile** | `allowedProfiles` 非空时：绑定结果必须能映射到允许的 adapter 权限包络 |

**推荐默认 B**：项目只写权限与质量策略；模型选择尽量全局 + 单次 run。

### 6.2 Ephemeral profile 命名

Run 内生成虚拟名如 `runtime/grok/high`，只存在于 run 状态，避免污染项目配置。

### 6.3 密钥与 provider

- Codex：继续让 `codex` CLI 读 `~/.codex`；Agent Team 只传 model / reasoning / 可选 provider **id**（如 `sub2api`），不复制 key。  
- Grok / Kimi：同理，CLI 读自己的 config。  
- 若项目 yaml 里写了 `codexProvider.baseUrl`（如 sub2api），与全局 inventory 的 provider 列表对齐时，**项目指定优先**（避免桌面默认打到错误的 api.openai.com）。

---

## 7. 控制面 API 草案

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/desktop/cli-inventory/scan` | 触发检索；桌面会话鉴权 |
| `GET` | `/api/desktop/cli-inventory` | 读缓存 + 是否过期 |
| `GET` | `/api/desktop/settings` | 读全局设置 |
| `PUT` | `/api/desktop/settings` | 写全局默认（校验 CLI 已安装） |
| `POST` | `/api/projects/:id/runs` | 扩展 `roleBindings` |

桌面 Tauri 命令可薄封装上述 HTTP，或直接扫盘后 `PUT settings`（二选一，建议 **扫盘在 Node 控制面**，权限与日志统一）。

---

## 8. 实现分期

### Phase 1 — 检索只读（1 个垂直切片）

- `CliInventory` probe：codex / grok / kimi / claude  
- doctor 或设置页展示  
- 不改启动路径  

**验收**：设置页能看到本机四家安装与授权状态、模型列表；密钥不出现在响应里。

### Phase 2 — 全局默认

- `desktop-settings.json`  
- 五角色默认 CLI/模型/思考深度  
- 新建运行表单预填全局默认（仍落到现有 profile 名若项目仅有静态 profile）

**验收**：改一次全局默认，三个项目新建运行默认一致（在项目未禁止时）。

### Phase 3 — 新建运行角色选型 → ephemeral profile

- `roleBindings` API  
- RunLauncher 三联下拉  
- run 快照记录 source  

**验收**：AgentDeck 无需手写多 profile yaml，也能总控 Grok、审查 Codex 跑通；失败时错误信息含 cli/model。

### Phase 4 — 项目允许列表与模板

- 项目 `adapters.allow` / 可选 `inheritGlobalDefaults: true`  
- init / 接入向导：「使用全局默认」  

---

## 9. 明确不做

1. 静默把全局选择写进所有项目的 `agent-team.yaml`。  
2. 在 Agent Team 内存储或转发各 CLI 的 API Key。  
3. 全盘文件系统搜索。  
4. 用「检索到的模型列表」绕过项目 `permission` / 质量门禁 / 预算。  
5. 第一期就上 Claude/Kimi adapter 若现网 invoke 管道未接好——检索可先展示「已安装，运行适配未接通」。

---

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| CLI 配置格式变更 | probe 版本化；失败则 `installed=true, models=[]` |
| 扫描拖慢启动 | 异步扫 + 缓存 TTL（如 1h）；设置页手动刷新 |
| 用户以为全局默认 = 所有项目强制 | UI 文案写清「可被项目禁止 / 单次覆盖」 |
| Codex 有 provider 但 key 无效 | `auth.status=invalid` 仅在用户点「验证」后设置；默认只 `present` |

---

## 11. 与你当前痛点的对应

| 痛点 | 本方案 |
| --- | --- |
| 每个项目 yaml 手写 profile | L1 全局默认 + L3 选型，项目可极简 |
| 每次新建都要改角色对象 | 全局默认后不用每次改 |
| 误走 Codex 401 | 检索显示授权；默认可选 Grok；项目可禁未授权 CLI |
| 想按角色选不同 CLI | 新建运行三联选择 → roleBindings |

---

## 12. 建议下一步（实现时）

1. 落地 Phase 1：`src/desktop/cli-inventory/` + `GET/POST` inventory API + 设置页只读表。  
2. 再 Phase 2/3，避免一上来改 runner 选型却没有可靠模型列表。  
3. 测试：假 fixture 配置目录（不读真实 `auth.json` 内容进断言）。

**当前不实现代码**；确认方案后再开 Phase 1 任务。
