# ub-mode 质量门接入（确定性分数）

本文说明如何把 [ub-mode](https://github.com/unclebob/ub-mode) 的确定性质量门接进本仓的
`quality.commands`，以及它对「自动策略演进」评分到底改变什么、不改变什么。

## 1. 为什么需要它

编排器原有的质量门只有**布尔**语义：命令 exit 0 即通过。演进评分
（`src/evolution/automation.ts` 的 `projectRunOutcome`）也只是把 `passed` 加权成
10000/1000/500 这样的档位，再减去返工与调用次数。

ub-mode 提供的是**连续、可复算**的量：

| 工具 | 产出 | 用途 |
| --- | --- | --- |
| `crapper` | 每函数圈复杂度 + 覆盖率 + CRAP = `CC²×(1-cov)³ + CC` | 复杂度/覆盖债的标量 |
| `dryer` | 结构重复度（Jaccard） | 重复代码候选 |
| `mutator` | 变异体存活数 | 测试是否真的在断言 |

同一个策略候选跑两次，分数必须一样——这是「确定性证据」的最低要求，也是
bounded evolution 只接受确定性证据的原因。

## 2. 工具链

上游仓库浅克隆 + 自带 venv，本机装在：

```text
~/.kimi-code/tools/ub/{ub,crapper,dryer,mutator}
```

语言覆盖 Clojure / Java / Go / TypeScript / Rust / Python，按后缀自动识别。
TypeScript 通过项目自身的 `vitest` 收集 lcov（本仓已固定
`@vitest/coverage-v8@3.2.7`，与 vitest 同版本，避免工具用 npm 往 pnpm 仓里装浮动版本）。

## 3. 用法

本仓提供一层薄封装 `scripts/ub-quality-gate.mjs`，原因只有一个：
`quality.commands` 不经 shell 启动（见 `AGENTS.md`），无法展开 `$UB` 或 `~`。

```bash
# 只看本次改动文件的 CRAP（演进候选的默认语义）
node scripts/ub-quality-gate.mjs

# 全仓扫描 / 换阈值 / 换工具
node scripts/ub-quality-gate.mjs --all --threshold 15
node scripts/ub-quality-gate.mjs --tool dryer --threshold 0.85
node scripts/ub-quality-gate.mjs --tool mutator -- src/experience

# 指定工具链位置
UB_BIN=/path/to/ub node scripts/ub-quality-gate.mjs
```

退出码直接透传工具自身语义：

| 码 | 含义 |
| --- | --- |
| 0 | 干净 |
| 2 | 最差分数超过阈值 → 该质量门判失败 |
| 1 | 参数或工具执行错误 |
| 3 | 找不到 ub-mode 工具链 |

接入配置（`agent-team.example.yaml` 已给出注释示例）：

```yaml
quality:
  commands:
    - command: node
      args: [scripts/ub-quality-gate.mjs, --threshold, "10"]
```

`--changed` 是默认值：只评估**候选自己改过的文件**。全仓阈值在存量债清理完之前必然红，
不能当演化评分用。

## 4. 对演进评分的影响（诚实版）

- **会影响的**：`quality.commands` 里多一条确定性命令。CRAP 超阈值 → exit 2 →
  `finalQuality.passed=false` → 候选 `passed=false` → `automaticCandidateImproved` 拒绝它。
  也就是说，**它把一个模糊的「候选更好」变成了可失败的门**。
- **不会影响的**：CRAP 的**数值差**目前不进 `score`。评分仍是档位加权
  （`passed`/`qualityPassed`/`decision`/`allTasksMerged`）加上命令通过数与调用次数的加减。
  要让「CRAP 从 31 降到 8」这种改进直接反映到分数，需要改动 `projectRunOutcome` 的评分
  口径（不在本次改动范围内，作为后续项）。

## 5. 本仓实测基线（2026-10-30，含清理后复测）

全仓（`--all`）：

```text
函数总数            1846
CRAP > 10            498
覆盖率 0% 的函数      406
按区域：src 397 个超阈值 / web 101 个超阈值
```

`web/` 的组件没有单元测试（走 Playwright e2e），所以 CRAP 全部偏高——这说明
**CRAP 不适合直接给 UI 组件打分**，全仓阈值在该区域无意义。这也正是门默认只查
`--changed` 的原因。

改动范围（`--changed`，107 个函数）：**0 个超过 10，门为绿色（exit 0）**。

清理前 → 清理后的对照：

| 函数 | 清理前 CC / 覆盖 / CRAP | 处理后 |
| --- | --- | --- |
| `RunSupervisor.startOwned` | 28 / 85% / 30.5 | 拆为 `launch` + `claimStart` + `emitQueued` + `startWorkflow` + `buildRunnerRequest` |
| `ExperienceService.extractFromRun` | 20 / 33% / 138.5 | 拆为 `activeSuiteDigest` / `persistCandidates` / `autoPromoteWithSuite` / `promoteSuccess` |
| `experience.extract.extractCandidatesFromRun` | 25 / 77% / 32.9 | 按分类拆为 evaluation / failure / success / rework / emptyPlan 构建器 + `buildContext` / `countTasks` / `touchedPaths` |
| `experience.extract.portableFailureLesson` | 16 / 59% / 33.5 | 改为 `PORTABLE_RULES` 表驱动 |
| `experience.extract.humanizeErrorBrief` | 14 / 38% / 59.7 | 改为 `ERROR_LABELS` 表驱动 |
| `ExperienceCatalog.recordRetrieval` | 6 / 5% / 37.3 | 补测试（命中/未命中/未知 id/未晋升） |
| `RunSupervisor.respondApproval` | 21 / 71% / 31.9 | 拆为 `pendingApproval` / `approvalReplay` / `expireLateApproval` / `applyPlanFromApproval` / `settleApproval` 等 |
| `RunSupervisor.resume` | 12 / 50% / 30.0 | 拆为 `recoverable` + `assertPlanCheckpointApproved` |
| `RunSupervisor.retry` | 13 / 56% / 27.8 | 拆为 `requireRetriable` + `retryRequest` + `copyRoleBindings` |
| `RunSupervisor.discardQuarantineLeftovers` | 5 / 33% / 12.4 | 补隔离目录回收测试 |

方法：先由门把清单和数字打出来，再按 CRAP 从高到低，一次一个函数——
**先补行为测试锁住现状，再拆，再复测**。拆出来的纯函数（`buildRunnerRequest`、
`retryRequest`、`pendingApproval`、`approvalReplay`、`assertPlanCheckpointApproved`）
直接单测，覆盖率与可读性一起上去。

全仓仍有 498 个函数超阈值（绝大多数是没有任何单测的 UI 组件），按本文件的立场，
它们属于「要不要给前端补测试」的产品决策，不是质量门能自动消掉的债。

## 6. 与技能层的关系

ub-mode 是本仓「Agent Skills」层里第一个带确定性工具链的真技能：`SKILL.md` + 三个可执行门。
它同时也验证了技能层验收标准——技能不是文档，而是**能被跑起来、能判失败**的东西。
2026-10-30 起它已从「只装给 Kimi Code」迁到共享目录 `~/.agents/skills/ub-mode`，
再软链回 Kimi / Claude / Codex / Grok / Qwen / OpenCode / dsh，所有 agent 都能加载。

## 7. 前端为什么必须「拆」而不能只「补测」

`web/` 是这套门里最大的存量缺口：96 个函数超阈值、绝大多数覆盖率 0。一个常见的误判是
「给组件补测试就好了」——**数学上不成立**：

```
CRAP = CC² × (1 - 覆盖)³ + CC
```

即使覆盖率补到 100%，`(1-覆盖)³ = 0`，CRAP 也只剩 `CC` 本身。也就是说
`SettingsWorkbench`（CC 128）即便 100% 覆盖，CRAP 仍是 128，永远过不了 10 这条线。
**覆盖率治不了高复杂度，只能治「简单但没测」；高 CC 必须靠拆。**

### 7.1 第一批：设置工作台（已做完）

`SettingsWorkbench` 原来是单个 587 行的组件函数（CC 128 / 覆盖 0 / CRAP 16512）。
现在按职责拆成 4 个文件：

| 文件 | 职责 |
| --- | --- |
| `components/settings/model.ts` | 纯函数：绑定校正（`syncRoleBindings`/`syncModel`/`syncReasoning`）、提示文案（`noticeFor`）、保存 payload、授权标签、缓存标签、角色名排序 |
| `components/settings/actions.ts` | 只负责调 API：`rescanInventory` / `loadDesktopSettings` / `saveProjectRoles` / `saveGlobalSettings` |
| `components/settings/useSettingsWorkbench.ts` | 状态与不变量（「安静刷新不得覆盖未保存的角色编辑」集中在这一处），拆出 `useAutoRefresh` / `useInventorySync` / `applyEnvelope` / `runRescan` / `runSave` |
| `components/settings/sections.tsx` | 纯展示：`SettingsHeader` / `HeaderActions` / `SaveButton` / `SettingsTabs` / `CliDetectSection` / `CliInventorySection` / `CliRow` / `RolesSectionHeader` |

拆完的结果（同一份测量）：

| | 前 | 后 |
| --- | --- | --- |
| `SettingsWorkbench` | CC 128 / 0% / CRAP 16512 | **CC 3 / 100% / CRAP 3.0** |
| 拆分出的 40+ 个函数 | — | 全部 ≤ CRAP 9.7 |
| 组件测试 | 0 | 4 个交互测试 + 11 个模型测试 + 3 个阶段条测试 |

新增测试覆盖：加载态、CLI 清单渲染（已安装/未安装/授权异常三种行）、手动重检、
全局保存（含 UI 开关落到 payload）、项目保存（按角色生成覆盖 payload）、
绑定校正的四种分支、提示文案的六个分支。

### 7.2 剩余批次（按 CRAP 从高到低，尚未动）

| 函数 | 命名空间 | CC | 覆盖 | CRAP |
| --- | --- | --- | --- | --- |
| `EvolutionWorkbench` | components.EvolutionWorkbench | 103 | 0% | 10712 |
| `RunLauncher` | components.RunLauncher | 86 | 0% | 7482 |
| `App` | App | 68 | 0% | 4692 |
| `RunDetail` | components.run.RunDetail | 59 | 0% | 3540 |
| `useRunEvents` | hooks.useRunEvents | 49 | 0% | 2450 |
| `EvolutionProposalDialog` | components.EvolutionProposalDialog | 46 | 0% | 2162 |
| `RunPage` | components.RunPage | 46 | 0% | 2162 |
| `ArchitectureDiagram` | components.architecture.ArchitectureDiagram | 45 | 0% | 2070 |
| `ExperienceWorkbench` | components.ExperienceWorkbench | 43 | 0% | 1892 |
| `useRunActions` | hooks.useRunActions | 40 | 0% | 1640 |

> 为什么不是 Playwright 覆盖率：e2e 覆盖率只能证明「路径被点到了」，不能降低 CC；
> 上面证明了 CRAP 的下界就是 CC。e2e 能替代的是「行为验证」，替代不了「结构复杂度」。
> 所以路线是：**组件拆到 CC ≤ 10 + jsdom 组件测试**，e2e 继续负责跨页流程。
