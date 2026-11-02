# ub-mode 质量门接入（确定性分数）

本文说明如何把 [ub-mode](https://github.com/unclebob/ub-mode) 的确定性质量门接进本仓的
`quality.commands`，以及它对「自动策略演进」评分到底改变什么、不改变什么。


## 让 CRAP 数字说谎的两种机制

CRAP 是 `CC²×(1-cov)³ + CC`。覆盖率在分母里，**分母一错，分数就没有意义**。目前见过两种：

### 1. 分母污染：把不该算的东西算成源码，或把崩溃读成 0%

- `coverage.all` 默认为 true，覆盖率会把项目里所有文件当待测源码，而默认 exclude 只有
  `coverage/dist/node_modules`，没有 `target/`。于是 `target/coverage/**` 里上一轮的 HTML
  报告资源被当源码插桩；两个覆盖率进程交错时，删目录的那个让另一个报
  `ENOENT .../lcov-report/sorter.js`（`V8ToIstanbul.load`），整轮 exit 1，门禁把它读成
  **0% 覆盖率**——不是红灯，是静默污染，所有人的 CRAP 都被压低。修法见 `#143`：
  `coverage.exclude` 加 `target/**`、`coverage/reportsDirectory` 显式指到被排除的目录。
- 同一类还有一次：测试进程 `exit 1` 时 `lcov` 文件仍在（只是缺文件），守卫只看「文件非空」
  就打分，一次这样的运行报出 **1545 条 new**，全是假债。修法：`steps.coverage.outcome`
  必须 `success` 才允许评分，否则写 `kind: infrastructure`。

### 2. 测试不 hermetic：覆盖率随「跑测试的机器」变

`desktop.cli-inventory` 的 probe 直接执行 `which` / `<cli> --version`，于是覆盖率取决于
这台机器装了什么 CLI。同一段判定逻辑在 CI runner 上走不到「已安装」那一半分支。

实测（同代码、同工具 `6fd92c4`、同 `self` 覆盖率来源）：

| 环境 | new / worse / fixed |
| --- | --- |
| Linux + Node 24 | 5 / 6 / 4 |
| macOS-14 + Node 26（runner） | 5 / 7 / 3 |
| macOS arm64 + Node 26（开发机，装了一堆 CLI） | 0 / 2 / 3 |

注意第二行：**把 runner 换到 macOS、Node 换成 26 也没救**——差异不是 OS 也不是 Node 大版本，
而是「runner 上一个 CLI 都没有」。修法不是换 baseline，而是给探测层加注入缝
（`CliInventoryExecution.run`），测试用脚本回答「装了什么」，判定逻辑照旧真实执行。
修完之后两边 `new` 都是 0。

**判断口诀**：`new` 里出现成批同模块的函数、且幅度与机器相关 → 先怀疑 hermetic；
`new` 是满屏且数量级异常（上千条）→ 先怀疑分母（崩溃/缺覆盖率）。

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

### 7.2 其余组件（已全部完成）

同一套方法（纯规则 → API → hook → 展示）陆续套用到 web 层其余 10 个超阈值组件：

| 组件 | 处理前 | 处理后 |
| --- | --- | --- |
| `EvolutionWorkbench` | CC 103 / 0% / 10712 | CC 4 / 80% / 4.13 |
| `RunLauncher` | CC 86 / 0% / 7482 | CC 6 / 89% / 6.05 |
| `App` | CC 68 / 0% / 4692 | CC 6 / 100% / 6.0 |
| `RunPage` | CC 46 / 0% / 2162 | CC 3 / 100% / 3.0 |
| `RunDetail` | CC 59 / 0% / 3540 | CC 1 / 100% / 1.0 |
| `useRunEvents` | CC 49 / 0% / 2450 | CC 1 / 100% / 1.0 |
| `useRunActions` | CC 40 / 0% / 1640 | CC 7 / 95% / 7.0 |
| `EvolutionProposalDialog` | CC 46 / 0% / 2162 | CC 7 / 83% / 7.23 |
| `ArchitectureDiagram` | CC 45 / 0% / 2070 | CC 8 / 91% / 8.05 |
| `ExperienceWorkbench` | CC 43 / 0% / 1892 | CC 9 / 78% / 9.89 |

做法上的几条固定套路：

- **决策变数据**：审批/决议五种 mode 用 `DECISION_HANDLERS` 表分发，`describeDecision` 负责参数与过期校验；
- **不变量集中**：mutation latch（`runMutation`）、弹窗关闭守卫（`useDialogClosers`）、
  「安静刷新不得覆盖未保存编辑」（settings 的 `rolesDirty`）各只有一处实现；
- **effect 拆成 hook**：SSE 订阅（`useRunStream`/`useProjectStream`）、初始加载、证据/用量拉取各自独立，
  每个都带自己的 active 标记与清理；
- **props 用 `T | undefined`**：调用方不再写条件展开，每个 `...(x ? {x} : {})` 都是一个 CC 分支。

> 为什么不是 Playwright 覆盖率：e2e 覆盖率只能证明「路径被点到了」，不能降低 CC；
> 上面证明了 CRAP 的下界就是 CC。e2e 能替代的是「行为验证」，替代不了「结构复杂度」。
> 所以路线是：**组件拆到 CC ≤ 10 + jsdom 组件测试**，e2e 继续负责跨页流程。

## 8. 2026-10 收口：CRAP > 100 归零

起点（本轮清理开始时的 `main`）：**2683 个函数里 462 个 CRAP > 10，其中 58 个 > 100**，
最差的是 `deriveAgentActivity`（CC 81）、`ResearchPanel`（CC 81）、`SettingsWorkbench`
（CC 128 / 覆盖 0 / CRAP 16512）。

终点（`52b3e9f`）：**CRAP > 100 归零**，> 10 剩 280 个，全部冻结进 `.ub-crap-baseline.json`。

| 指标 | 起点 | 终点 |
| --- | --- | --- |
| CRAP > 1000 | 5 | 0 |
| CRAP > 500 | 10 | 0 |
| CRAP > 100 | 58 | **0** |
| CRAP > 10 | 462 | 280（已冻结） |
| 测试数 | 1188 | 1312 |

### 剩余 280 个为什么停在这里

它们的 CRAP 集中在 10–99 区间，前十名是 `refineProposalInvariants`(98.6)、
`RunActionDialog`(96.1)、`maybeRecordFromExperience`(96.0)、`useDesktopProject`(90.0)、
`useOnboarding`(90.0)。这些函数**不是靠拆就能降**的：它们的 CC 已经不高
（`useDesktopProject` 只有 9），CRAP 高是因为**覆盖率低**——`useDesktopProject` 和
`useOnboarding` 都是 0%。继续降要么补集成测试，要么把 hook 的 effect 抽成可测单元，
这是另一条独立的工程线，不适合塞进「CRAP > 100 清零」这个目标。

### baseline 冻结方式

```bash
node scripts/ub-quality-gate.mjs --update-baseline   # 记录当前 > 10 的函数
node scripts/ub-quality-gate.mjs                     # 之后任何回退按 regression 报错
```

**注意**：baseline 必须用**和校验时相同的模式**生成。用 `--all` 生成、用默认模式校验
会报假的 regression——两种模式分析的函数集合不同，vitest 覆盖率的分母也就不同，
同一个函数的 CRAP 会差出 15% 以上（实测 `desktop.settings#getInventory` 23.9 vs 20.2）。

### 这轮用到的四个套路

| 套路 | 例子 |
| --- | --- |
| 决策变数据 | `EVOLUTION_ERROR_STATUS`（错误类→状态码）、`SERVER_REPLIES`、`NOTIFICATIONS`、`BINDING_FIELDS` |
| 不变量集中一处 | `evolution/audit-trail.ts`（哪些审计记录能在提案消失后保留）原来有两份拷贝 |
| 查表代替分支链 | `pickSituation` 把崩溃恢复的 2×2 矩阵变成四行 |
| 先钉行为再改结构 | `planning.ts` 拆 `architectPlan` 时，「重试条件」和「放弃条件」曾被合并——5 个测试立刻挂掉 |

## 9. 同 cc 下 CRAP 漂移：先怀疑覆盖率分母，再怀疑代码

CRAP 里的覆盖率来自一次 `vitest --coverage`，而它曾经会**漂**：同一份代码、同一个
`--all` 模式，`src/process/alive.ts#processLiveness`（CC 恒为 9）连续测出 16.1 / 19.1 / 22.9。

**根因不是采样噪声，是分母被污染。** `coverage.all` 会把 `target/coverage/**` 里上一轮
残留的 `sorter.js`、`block-navigation.js` 这些 HTML 报告资源也当成「待测源文件」：
残留文件有多少，分母就有多大，覆盖率被稀释的程度就不同。反解上面三个 CRAP 得到的覆盖率
是 44% / 56% / 50%——同一份代码差 12 个点，随机采样做不到，分母变化可以。

**已修复**：#143 把 `target/**` 从覆盖率源集合里排掉。修复后实测：

- 重构后的 `processLiveness`（CC 3）三次独立测量（每次先清 `target/coverage`）全部是
  `3.0 / CC 3 / 100%`，零漂移；
- 连续两次全仓 `--all --update-baseline` 得到**完全相同的 184 个键**，逐键分数漂移 0
  （对比脚本容差 0.05）。

因此判据调整如下。

### 施工单元是文件，不是函数

门禁的阈值是**绝对**的，基线不构成豁免。`scripts/ub-quality-gate.mjs` 里这一行决定了顺序：

```js
return failed === 0 ? baselineStep(prepared.options) : failed;
```

层没过就根本走不到基线那一步；而 crapper 是被喂「本次改动的文件」整个扫的。也就是说：
**你碰了一个文件，该文件里所有 >10 的函数一起进入绝对阈值判定**，哪怕它们在基线里躺着、
哪怕你只改了其中一个。改一条函数而门禁全红，是预期行为，不是 bug。

所以排批次时按**文件**切，不按函数切：一个文件要么整清（该文件所有 >10 归零），
要么不碰。文件里条数多（`claude-session.ts` 9 条、`automatic-controller.ts` 8 条）时，
把它当成一个「整文件批」，一次做完一次合。

### 判据

1. **先看 CC**。这条不变：CC 决定 CRAP 的地板值，CC 没变说明结构没恶化。
2. **先查分母，再谈结论**。测量前 `rm -rf target/coverage` 并确认没有第二个 crapper
   （`ps -eo command | grep -c '[c]rapper'` 为 0）。同一 sha 连跑两次 `--all`，键集合与
   分数应当完全一致；不一致就不是代码问题，先查分母与并发。
3. **再谈回归**。分母确认干净后，若 CC 未变而 CRAP 仍上升，说明是**真实覆盖缺口**
   （某个测试被跳过/超时），按回归处理并补测；若 CC 也上升，才是结构恶化，按 CRAP 拆。
4. **兜底手段（降级）**：分母已确认干净、两次 `--all` 仍给出不同数字时，才用「重测两次取
   中位数」，并在 PR 正文里写明哪几次不一致。不再把它当作常规判据。

### 操作要求

- 覆盖率相关验证必须在**独立 worktree** 里跑（`git worktree add /tmp/wt-x -b debt/x`），
  每个 worktree 有独立的 `target/coverage`，跑前先删。
- 不要和别人的门禁并行跑：并发会踩同一个报告目录，轻则覆盖率归零，重则一方直接
  `No source files to analyze`。
- 刷新 baseline 时逐键对比旧基线，而不是只看条数：条数下降不代表没有单点上升，
  单点上升也不代表回归——按上面四步判。

## 10. 基线的两种保证：碰巧一致 vs 可复算

刷新基线的方式决定这份文件值不值得信。

**第一代（弱保证）：双扫 + 逐键比对。** 两次各自重新生成覆盖率的全量扫描，分数一致才写。
它确实检验了「覆盖率稳不稳」，但结论是**运气型**的——两次碰巧一致，不代表第三次也一致。
2026-11 之前就吃过这个：`getInventory` 冻结在 20.24，而在它自己的刷新提交上只能测出
23.90，谁也复现不了那份数。

**第二代（强保证）：一份可哈希的覆盖率 + 记录出处。** 外部显式跑一次

```bash
npx vitest run --coverage --coverage.reporter=lcov
node scripts/ub-quality-gate.mjs --all --update-baseline -- --use-existing-coverage
```

gate 读这份 lcov 打分，并在 `generation` 里记下 `lcov.sha256`、`headSha`、`toolCommit`、
`coverageSource`、`platform`、`nodeVersion`、`scans: 2`。双扫仍然保留，但职责变成两件事：

1. **lcov 未被篡改**：每轮开扫前记一次摘要，两轮之间不一致就拒写（比数值抖动检查更硬）；
2. **crapper 输出确定性**：同一份输入两次解析必须逐键一致。

为什么不全改成读现成 lcov：self 模式的两轮**各自重新生成覆盖率**，那是唯一能发现
「覆盖率本身不稳」的视野——`#168` 那批抖动、`StallWatchdog#check`、`invokeLive` 都是
它抓出来的。所以 self 模式继续用于**摸排**，existing 模式用于**定版**：
摸排要宽视野，定版要可复算。

判断口诀：**同一份输入、同一次运行能复算出同一个数 → 强保证；两次跑恰好一样 → 弱保证。**

## 10. 已知且刻意的例外

### `web/src/main.tsx#bootstrap`（当前 CRAP 20.0）

这是 Vite 的入口模块：`applyTheme()`、`createRoot(...).render(...)` 都在**模块顶层**
执行，`import` 它就会真的挂载 React 树。要覆盖 `bootstrap` 只有两条路，两条都不诚实：

- 在测试里 `import` 入口 → 需要 jsdom + 假的 Tauri/`import.meta.env` + DOM 根节点，
  测到的主要是「React 能挂载」，不是本仓的行为；
- 为可测性把 `createRoot` 抽成注入参数 → 为了让测试能调用，往生产入口加一层只为测试
  存在的接缝，违反「不为测试改生产接口」。

同时，同文件的 `desktopPreviewState`、`isControlServiceOrigin` 是纯函数，可以抽出去测，
但抽完 `bootstrap` 仍留在账上（20.0），所以单独为这两条动入口文件不划算。**结论：冻结，
不拆也不补测。**

**重新考虑的条件**（满足任意一条就重新评估）：

1. 要做入口冒烟测试（例如 Playwright 已在跑 `web/` 的首屏），届时 `bootstrap` 由 e2e 覆盖，
   可以把它从 CRAP 记账里剔除或按 e2e 结果记账；
2. 入口开始承载需要单测的决策（例如按 URL 决定加载哪套 App、feature flag 分支），
   那就把决策抽成纯函数，`bootstrap` 只留装配；
3. 项目的 App 挂载方式换成可注入的 root（例如 SSR/测试共享的 `mount()`），接缝本来就存在，
   不需要为测试额外加。

在此之前，任何人碰到 `web/src/main.tsx` 只需保证 `bootstrap` **不变得更差**（CC 不变、
覆盖率不下降），不要求清到 10 以下。

### `scripts/laya-jev-server.py#do_POST`（当前 CRAP 72.0）

事实：

- 88 行的 Python 文件，是 **本地 JEV 宿主**：`127.0.0.1` 上单线程的 loopback 服务，
  对应 `jev.protocol: laya` 的本地调试宿主（`src/config/schema.ts` 直接指向这个文件）；
- 仓里**没有 Python 测试框架**（vitest 跑 `.ts/.tsx/.mjs`，crapper 的覆盖率也来自 vitest），
  所以它与 `src-tauri` 的「结构性 0% 覆盖」同性质——不是没人写测试，是这条工具链够不到；
- 记进计分域是为了让它在账上可见，而不是为了让谁去写一个跑不起来的测试。

**为什么不直接删掉这条账**：删了之后半年内一定有人重新扫一遍、把它当成「新发现的遗漏」
再报一次；留在账上 + 在这里写明原因，才是唯一的稳定答案。

**重新考虑的条件**（任一成立就重新评估）：

1. laya / JEV 进入产品路径（不再只是本地调试宿主），那就该有独立于仓内 vitest 的测试线；
2. 这个文件第二次被改（第一次是它被写出来），改动本身就是加测试的时机；
3. 仓里引入 Python 测试（pytest）并把覆盖率并入门禁，那时这条自动消失。
