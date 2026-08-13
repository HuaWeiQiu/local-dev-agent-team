# 多 Profile 灵活性：后续优化（未实现）

- 文档状态：**后续优化 backlog**，当前**未实现**
- 记录日期：2026-08-12
- 背景：桌面端可接入多个项目；每个项目读自己的 `agent-team.yaml`。例如 `local-dev-agent-team` 已配置多角色多 Profile（Codex / Grok 等），而 `AgentDeck` 若只声明少量 `allowedProfiles`，新建运行里每个角色就只有一个选项——这是**项目配置**，不是公共全局漏配。

## 1. 当前边界（保持）

| 层 | 现状 | 原因 |
| --- | --- | --- |
| 项目 `agent-team.yaml` | 权威：profiles / roles / allowedProfiles / fallback | 可进 git、可复现、可审计；不同仓库权限与模型策略不同 |
| 运行时覆盖 | 新建运行「角色对象」覆盖策略默认 | 单次 run 微调，不改仓库配置 |
| 跨项目 | 经验库可有 shared 目录 | 共享的是经验，不是强制同一套模型绑定 |

**明确不做（默认行为）**：扫描本机已安装的 Codex / Claude Code / Kimi / Grok CLI 后**静默改写**各项目 `agent-team.yaml`。  
原因：易越权、难在 CI/他人机器复现、本机 PATH 与项目策略耦合。

## 2. 问题

- 每接一个新项目都要手写一长段 profiles，成本高。
- 用户直觉是「我机器上有哪些 Agent CLI，就应该能选」，与「每项目一份策略」有落差。
- UI 已展示多 Profile 选择器，但选项完全取决于**当前项目**配置；未配置则看起来像「系统只支持一个」。

## 3. 目标分层（建议实现顺序）

```text
① 本机探测（只读建议）
   doctor / 桌面启动器：PATH 上是否有 codex / grok / claude / kimi 等，版本探测
        ↓
② 用户级默认模板（可选，机器私有，不进项目 git）
   例如 ~/.agent-team/user-profiles.yaml 或桌面「偏好」
   「本机默认：总控 Codex，执行 Grok…」
        ↓
③ 项目 agent-team.yaml（权威）
   - 完整自包含 profiles + roles（现状）
   - 或可选：从用户模板 / 官方 multi-provider 模板套用后写入项目
   - 项目仍可收紧 allowedProfiles
        ↓
④ 运行时覆盖（已有）
   新建运行角色对象覆盖
```

### 3.1 本机探测

- 范围：只读展示「本机可用 CLI」。
- 输出：启动器或 doctor 报告，**不自动改项目文件**。
- 用户动作：点「按本机可用 CLI 生成建议配置」→ 预览 diff → 确认后写入**当前项目**或**用户模板**。

### 3.2 用户级默认模板

- 存储：用户目录（如 `~/.agent-team/`），不默认提交到业务仓库。
- 内容：常用 profiles 片段 + 默认角色映射。
- 接入项目时：向导提供「套用用户模板」「使用 multi-provider 模板」「保持项目现有配置」。

### 3.3 项目模板 / init

- `agent-team init --template multi-provider`（或桌面「初始化」选项）：一次生成 Codex/Grok/… 多 Profile 与多 `allowedProfiles`。
- 单 Provider 项目仍可用精简模板（仅 Codex 等）。

### 3.4 与 explore / Swarm 的关系

- `taskMorphology`（探索、Swarm 并发）同样是**策略级、项目配置**，不是全局公共开关。
- 用户模板可附带默认 `taskMorphology`，套用到项目后仍由项目 yaml 生效。

## 4. 验收标准（实现时）

1. 新项目可一键得到多 Profile 选项，无需手抄 yaml。
2. 本机未装某 CLI 时，模板仍可声明 profile，但 doctor 提示「运行前需安装/登录」。
3. 项目可显式收紧 `allowedProfiles`，UI 不会展示未允许项。
4. 无「静默按本机 CLI 改写所有已接入项目」行为。
5. CI / 他人 clone 后行为仍由项目配置决定，不依赖作者本机 PATH。

## 5. 明确不做

- 强制所有项目共用同一套模型策略。
- 把用户本机 secret / API key 写入项目仓库。
- 仅因 UI 显示了「探索 / Swarm」文案就认为项目已启用多模型（展示可有默认摘要，配置仍以 yaml 为准）。

## 6. 优先级建议

- 归入路线图偏产品体验的一档（可与「编排与模板 / 向导」同阶段或紧随其后）。
- **推荐演进方向**（2026-08-13）：全局 CLI 检索 + 全局默认设置 + 新建运行按角色选 CLI/模型/思考深度。  
  详见 **[global-cli-inventory-and-role-picker.zh-CN.md](global-cli-inventory-and-role-picker.zh-CN.md)**。  
  该方案把「本机能力」与「项目策略」拆开，避免每个项目每次手选。
- 在上述方案落地前：项目 `agent-team.yaml` 的 `defaultProfile` 仍是「一次配置、多次使用」的正确做法。
