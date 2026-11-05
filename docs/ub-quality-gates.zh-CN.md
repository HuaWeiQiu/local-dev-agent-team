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

### CRAP 的覆盖率是**分支**覆盖，不是行覆盖（2026-11，查 crapper 源码确认）

crapper 的判分口径是这样的（源码注释原文）：

```python
"""LCOV scores a function by its BRDA branch records when it has any,
   and by line hits otherwise."""
```

也就是说：**函数只要有 `BRDA`（分支）记录，分数就按分支算；没有才回落到行命中。**

这带来两条必须记住的事：

1. **刷新时对比的 `LF/LH` 不是 CRAP 用的那个数。** `LF/LH` 是行覆盖，只用来确认"三次采集
   是同一份覆盖率"；真正驱动每个函数分数的，是分支覆盖。写刷新报告时别把两者混在一起比。
2. **"行全绿、CRAP 还高"是常态，不是异常。** `finishRollback` 的三行 `DA` 命中全是 1，
   两个 `if` 的成立分支却从未走过，于是报 33.3%（分支）——**行只是被扫过，路径没走全。**

判断一个函数"还差多少"时看 `BRH/BRF`（分支命中/分支总数），不要看 `LH/LF`。报告里写覆盖率
时标明口径：`33.3% (branches)`。

### `DA` 与 `BRDA` 回答的是两个不同的问题（2026-11）

同一个函数上，这两个计数器可以给出**相反**的结论，所以不能混用：

| 计数器 | 回答 | 什么时候看它 |
| --- | --- | --- |
| `DA` | **这行被执行了吗** | "这段代码有没有跑到" |
| `BRDA` | **这一支被走了吗** | "哪个分支"，但**归属可能挂在块终止处而不是 `throw` 上** |

实际踩到的例子：`restoreInterruptedPrompt` 的"树脏"分支，`BRDA` 那条记录是 0，看起来没走到；
加一句打印后发现 `isClean` 确实返回 `false`、`throw` 那行 `DA` 命中 3 次——**走到了，只是记录
不挂在它身上**。我拿 `BRDA` 的 0 推断"没走到"，是把第二个问题当成了第一个。

**延伸影响**：CRAP 是按 `BRDA` 计的（见上一节），所以**账本里的覆盖率可能低于"这段代码跑到没跑到"
的直觉**。看到 "`DA` 全 1、覆盖率 33%" 时先想到这条口径，别去怀疑采集。

### "不可达"要带原因，否则就是免责声明（2026-11）

判断一条分支不可达时，三种情况长得一样、被破坏的方式完全不同，所以用例守的东西也不同：

| 种类 | 判据 | 例子 | 将来会怎么被破坏 | 用例守什么 |
| --- | --- | --- | --- | --- |
| **放不进来** | 数据在更早的一层就被拒绝（schema、校验器） | journal 里 `pending.beforeTarget` 丢 digest → 解析期就拒 | 有人觉得 schema 太严，放宽它 | 防**简化**那一层 |
| **上游先拦** | 决策在更早的一步就做完了 | `situationFor` 判不出情况 → `requireRecovery()` | 有人把拦截拆开、或改成各处自判 | 防**拆掉**那一步 |
| **先读了别的东西** | 流程在到达前已经读过同一份状态 | 恢复流程先读 live target 才拒绝，`restoreInterruptedPrompt` 里的符号链接检查轮不到 | 有人把那次读取**挪到后面**，窗口就打开了 | 防**挪动**读取顺序 |

第三条最值得警惕：**"把读取挪到后面"看起来是无害的重构**（少读一次、顺序更自然），实际上把防护从一个"决策之前"变成"决策之后"。恢复流程先读 live target 再拒绝，**这个顺序本身就是防护**。

所以写"不可达"时附三个东西：**判据、一个例子、它会怎么被破坏**。缺了第三个，那句"不可达"就只是免责声明。

#### 现场必须**自洽**，否则你测的是 schema 不是被测函数（2026-11）

"放不进来"这一类有个陷阱：**造出来的坏现场如果只是局部改坏，它会在更早一层被拒，
而你会以为自己在测后面那一层。**

实测：想造"pending 指着一个 catalog 里没有的提案"，直接把 `pending.proposalId` 改成不存在的 id，
观察到的是

```
Invalid application state at …: pending: pending request digest mismatch
```

而不是恢复校验的 `does not match the catalog (proposal, expectedAfterTarget)`。原因：`requestDigest`
覆盖了 `proposalId`，schema 是第一道闸。

所以这个世界必须做成**自洽**的——改完 `proposalId` 同步重算 `requestDigest`，让文档像一个
**另一个版本真的写过**（或一个知道算法的人手工改过）的记录。两条判据：

- **不自洽的现场测到的永远是 schema。** 它有用，但它证明的是"schema 会拒"，不是你那条分支会拒；
- **自洽的现场才是被测层真正要处理的世界。** 篡改者不会留一个自相矛盾的 digest。

配套做法：期望的错误消息**先从结构推出来再跑**。上面那句
`(proposal, expectedAfterTarget)` 是推出来的，一次对上——推得出来，说明你真的知道哪些字段会失败；
推不出来还跑绿了，多半是跑到了别的一条路上。

### 报"它没做到 X"之前，先确认"我确实调用了 X"（2026-11，三次假债）

这两天出过"疑似产品缺陷"，形状完全一样，**都是测量侧的错误被当成了被测对象的错误**：

| 假债 | 真相 |
| --- | --- |
| "`reject()` / `archive()` 静默无效：调用返回了、状态没变、也不报错" | 这两个方法都是 `async`，**没 `await` 就读了状态**。补上之后干净目录与崩溃目录都正常生效 |
| "还剩 13 个 `#` 私有方法" | `grep '^  #name('` **漏了 `async #name(`**，真实数量是 53 |

**为什么这类错误比漏测更贵**：漏测只是少覆盖；这个会**制造一条假债**，而且方向是"指控产品"——
发出去之后，别人会去改本来没坏的代码。

检查顺序：先确认调用真的发生了（`await`、返回值、副作用），再确认被测对象真的没做到。
**这一步不比写夹具省事，但比发出一条错判便宜。**

#### 第三次：覆盖率比代码旧，一个好函数会显示成 210.0（2026-11，已加机器闸）

**crapper 只从固定路径读报告：`target/coverage/typescript/lcov.info`。** 它不理会 vitest 的
`--coverage.reportsDirectory`。把 vitest 指到 `/tmp` 之后，闸读到的还是上一次留在
`target/` 下的旧 lcov，于是**今天的函数配昨天的行号**：

```
catalogOutcomeMatchesPending   cc14   0.0%   210.0     ← 真值 7.0
verifyPromptGitOutcome         cc 8   0.0%    72.0     ← 真值 11.4
```

这不是产品缺陷，是**测量输入过期**。而它的可怕之处在于方向：任何人看到 210.0 都会去改代码。

这类错误今天是第三次（漏 `await`、`grep` 漏 `async #`、旧 lcov 配新行号），**共同点是"不报错、
也没有别的症状"**，所以不能靠记性。仓里已加闸：

> `scripts/ub-quality-gate.mjs` 在打分前比较**将被打分的那份报告**的 mtime 与 `src`/`web`/`scripts`
> 下最新源文件的 mtime；报告不更新 → 拒绝打分（exit 1），打印两个时间和重跑命令。
>
> 刷新时报告会被 `--coverage-a/b/c` 覆盖，所以那时比的是**声明的输入**，不是 canonical 路径。
> nightly 的漂移报告把它记成 `kind: "infrastructure"`，绝不记成空账本。

本地测量请用 `--coverage.reportsDirectory=target/coverage/typescript`，让报告落在闸读的地方——
这样既不用拷文件，也不会忘。

### 度量看不见 `#` 私有方法（2026-11 实测）

crapper 的 TypeScript 解析器**不认 ECMAScript 私有方法**。同一份 lcov、同一个文件：

```ts
class Sample {
  run() { return this.hashPrivate() + this.hashTsPrivate(); }
  #hashPrivate() { … }            // ← 完全不出现在报告里
  private hashTsPrivate() { … }   // ← 出现，cc 与覆盖率都正常
}
```

后果不是"少报一两条"，而是**拆分 `#` 方法会把复杂度搬进度量盲区**：账本会显示
`reconcilePromoted 54 → 5`，而实际代码一行没少。这正是"把温度计砸了"的另一种形态，只不过
砸得无声——所以这条只靠代码审查看不出来。

**2026-11：`src/**` 禁止 `#` 方法（eslint `no-restricted-syntax` + `MethodDefinition[key.type='PrivateIdentifier']`）。**
理由不是风格，是"计分域内的东西必须被看见"——`#` 合法，但在这个仓里有让它从账本里消失的副作用。
规则带注释说明，免得下一个人当成洁癖。私有**字段**不受影响（不参与打分）。

**把剩下 53 个 `#` 方法转成 `private` 之后，账本第一次看见它们，立刻冒出 16 条 >10：**

| CRAP | 函数 |
| --- | --- |
| 171.49 | `application-journal#validateRestoredState` |
| 120.69 | `application-target#applyPromptTarget` |
| 85.18 | `catalog#restoreFromValidatedMaterial` |
| 67.87 | `application-journal#restoreInterruptedPrompt` |
| 55.97 | `application-journal#completePendingFromLive` |
| 50.90 | `application#executeCommand` |
| 46.20 | `application-target#applyStrategyTarget` |
| 32.09 | `application-journal#cleanPendingPromptTemps` |
| 26.96 | `application-journal#verifyPromptGitOutcome` |
| 23.49 | `persistence#persist` |
| 15.55 / 14.38 / 13.26 / 12.00 / 10.21 / 10.21 | `finishPromotion` / `catalogOutcomeMatchesPending` / `verifyPromptAbortOutcome` / `resolveLegacyPredecessor` / `finishRollback` / `settleApplyFailure` |

这 16 条**从来没有进过任何一版基线**。也就是说在此之前，"这个文件已经清了"这句话，
在这些函数上是假的——而账本、CI、代码审查都不会说。

做法：**被度量的方法用 TS `private`，不用 `#`**。仓库里本来就是 `private` 占多数
（136 处 vs 25 处），语义上两种都禁止外部访问，`private` 还能被工具看见、被编译器检查调用点。

代价要说清楚：`#` 在运行时也真的不可访问，`private` 只在类型层。把这个文件里 12 个 `#` 方法
改成 `private` 之后，账本第一次看见它们——其中 4 条立刻被证明**从未被测试执行过**
（`assertReconcilable` 的覆盖率是 25%）。**盲区消失的那一刻，通常是账本数字变难看的那一刻**，
这才是它该有的样子。

### CRAP 地板：低覆盖时 cc 有一条硬上限

`CRAP = cc² × (1−cov)³ + cc`。覆盖率不动时，**cc 本身就决定了地板值**，所以“靠拆”也有一个
下限：拆出来的块如果还不够小，分数会原地不动、甚至比原来更高。

把 `CRAP ≤ 10` 对 cc 解一遍，得到这张硬上限表：

| 覆盖率 | cc 最多 |
| --- | --- |
| 0% | **2** |
| 20% | 3 |
| 50% | 5 |
| 80% | 9 |
| 100% | 10 |

读法：`cc = 3` 且覆盖率接近 0 时，地板就是 `9 + 3 = 12`，**必然越线**，这时唯一出路是把 cc
压到 2 以内（或者把这条路径测起来）。实测样本：

- `runProposer` 第一版 cc 3 / 覆盖率 2.8% → **11.2**；拆出 `failureStatus` 把两者降到 cc 2 后 → 5.6；
- `proposerRunState` 第一版 cc 3 / 覆盖率 2.9% → **11.2**；同理降到 cc 2 → 1.9；
- `projectScore` 第一版 cc 12 / 覆盖率 28.6% → **64.5**，比它要替换的原函数还高。

所以对**只有集成路径才走得到**的函数（proposer、错误兜底、跨进程收尾），落地顺序是：
先把每块 cc 压到 2，再谈覆盖；不要先拆到 cc 3 然后指望“补个测试就好了”。

#### 新函数 cc ≤ 4：闸、它的洗白路径，和三个必须显式决定的事（2026-11）

上一条判据（新块 cc ≤ 4）原来是靠人记的。记不住的东西要变成闸，而这道闸有一个很容易做错的方向：

**`.ub-crap-baseline.json` 不能当"历史上存在过的函数"清单。** 它只装**越线**的条目。证据就在账本里：
`validateAuditOwnership` 的 CRAP 是 **9.0**，它压根不在那 114 条里——拿账本判断新函数，它一进门就被
当成新的，第一次跑全是误报。

所以要一份**全量 cc 快照**：`.ub-cc-baseline.json`，形状照 `.test-casts-baseline.json`
（`total` + `counts`，全量而非仅违规），`counts` 的 key 是 `<namespace>#<function>`，value 是 cc。
当前是 **3790 个函数，其中 837 个 cc > 4**——**收进去不是豁免，是记账**：它们的 CRAP 已经在老闸的
逻辑里了。

**为什么 key 不是 `file::function`**：crapper 的报告里没有文件路径，只有 `:name` 和 `:namespace`
（namespace 就是模块路径的点分形式）。硬造一个 namespace → 路径的映射，只要映射错一次，**那个文件里
所有函数都会变成"新的"**——正是这道闸最不能有的误报。所以用工具自己发的 key，也是账本已经在用的
那一个。

**判据：出现在本次测量、不在快照里的 key，cc 必须 ≤ 4。不带覆盖率条款。**

不带覆盖率条款，是因为覆盖率救不了 cc。两个实测都在这个仓里：

| 函数 | cc | 覆盖 | CRAP |
| --- | --- | --- | --- |
| `assertApplicationIsActive` | 10 | **100%** | **10.0** |
| `validateAuditOwnership` | 9 | **100%** | **9.0** |

**覆盖满的时候，余量正好是 0。** 反过来 cc 4 在 40% 覆盖下只有 7.5。所以余量来自 cc，不来自覆盖率。

##### 洗白路径必须堵死——这是闸成不成立的唯一关键

三步就能绕过任何"只查新函数"的闸：

```
拆出一个 cc 9 的块  →  --update-baseline  →  它变成"既有"
```

所以判据装在 `--update-baseline` 里：**刷新时新 key 同样必须 cc ≤ 4，否则拒写。** 位置和
`#207`（HEAD 必须等于 `origin/main`）、覆盖率过期闸同一处，理由也同一个：**刷新不能成为洗白通道。
`--update-baseline` 只允许销账、不允许入账。**

##### 三个显式决定

| 决定 | 内容 |
| --- | --- |
| **首次落闸** | 快照必须先用一次全量测量在"将成为 main 的树"上生成（`--update-cc-baseline`，同样要求 HEAD == `origin/main`）。快照缺失时**拒绝打分**并打印建快照的命令——不静默通过，因为"没有快照"读起来就是"所有函数都是新的"，那种闸会被关掉 |
| **重命名** | 当成新函数，**这是想要的**：改名不能成为绕开限额的路。留下的通道是**在快照里删掉旧 key 并在 commit 里写理由**——一个 reviewer 看得到的 diff，而不是一个悄悄放宽闸的开关 |
| **`src-tauri`** | **不在范围内**。crapper 每次运行都重写同一份 `.metrics/crap.edn`，最后一个跑的是 TypeScript 层，所以读到的快照里只有 TS 层。要覆盖 Rust 得单独采集一次，不属于这道闸的事 |

##### 顺带：刷新不必再冻窗口

实测三轮采集每轮 **2 分 45 秒**、加刷新全程**不到 12 分钟**。撞了重跑比找人协调便宜——
直接跑，`#207` 会拒写。

#### 拆出来的块有"默认覆盖率"：大约 40%（2026-11，实测修正）

上面那张表容易被读成"估算新块的 cc 落点，落在 9–12 再切"。那是错的，因为它假设
**拆完就带着覆盖率**。实际上**新块一开始只覆盖顺利路径**，40% 是常态。

实测反例：`validatePendingEntry`（cc21 / 81.2%）拆出的 `pendingExpectationFrom` 估 cc **5**，
拆完实测就是 cc 5——**但覆盖率 40%，CRAP 10.4，过线了**。

按 40% 起跳重算：

| 新块 cc | 40% 覆盖率下的 CRAP | 结论 |
| --- | --- | --- |
| 3 | 4.9 | 安全 |
| 4 | 7.5 | 安全 |
| 5 | 10.4 | **已过线** |
| 6 | 13.8 | 明确过线 |

所以判据是：**新块 cc ≤ 4；最多 5，且必须有把握当场补到 60% 以上。** 估算落点没用——
拆完的 cc 几乎总等于估的值，**变的只有覆盖率**。

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

**第二代的漏洞（2026-11 补）：可哈希 ≠ 可复现。** existing 模式下两轮读同一份文件，
`unstableKeys` 必然相同——它只能抓「扫描期间文件被改」，抓不到「这份覆盖率本身是一次
运气不好的采样」。`getInventory 20.24` 就是这种形态的高概率版本。

**顺序依赖只有换顺序才会暴露。** 覆盖率签名在两次相同顺序的运行里可能一致，而
真正的问题是「谁先跑」。手动入口：`pnpm test:shuffle`（固定 seed `20261102`）。
它不是 PR 门禁——顺序检查跑一轮全量，成本与收益都更像 nightly；但没有这个入口时，
我们只能靠撞。

**默认行为不能因为少写一个 flag 就静默改变语义。** `--coverage-a/--coverage-b` 只在
`--use-existing-coverage` 下生效；漏了后者，门禁会按 self 模式自己再造两份覆盖率去比，
配对好的报告被忽略——两次自采若恰好一致，就会写出一份 `coverageSource: self` 的基线，
而每个人都以为它按新口径刷的。现在这种组合直接报错退出，并把正确命令原样打出来。

**刷新只在「将成为 main 的那棵树上」进行（2026-11）。** 基线的含义是「main 会是什么样」，
在别的树上测就换了个意思：`#198` 测在 `#197` 之前，多冻了 7 条已经清掉的债；`#206` 测在
`#205` 之前，又多冻了 3 条。四次事故同一形态，**不是谁不小心，是流程里没有一道闸**——
靠人记的规则会忘，代码不会。

`stableBaseline()` 的第一步就是比对：`git rev-parse HEAD` 对 `origin/main`（或
`--expect-base <ref|sha>`）。不一致直接拒绝写，打印两个 sha 和一句
"measure the tree that will become main"。**默认开启，不是可选 flag**——可选的东西没人用。

**拿不到 `origin/main` 时不静默通过。** 离线、分离头、非仓库一律拒绝，并提示用
`--expect-base` 显式声明这棵树将成为哪个提交。「猜一个基准」和「不检查」是同一个错误的两
种说法，所以工具不接受二者中的任何一个。

**试过但无效：`--coverage.processingConcurrency=1`。** 当时怀疑覆盖率合并丢数据是并发处理
导致的；K=5 实测仍是 4/5（首轮与其余四轮不一致），所以它不是解。最终采用「三份按行多数合并」。

**刷新从「两份必须一致」改成「三份按行多数合并」（2026-11）。** 整份报告投票会把局部噪声
放大成全局结论：一次 run 在文件 A 少五行、在文件 B 多一行时，多数派若恰好是「少行」那版，
更高的 CRAP 就会被冻进基线。改成**按行**：

- 采集 3 次独立 run；
- 每一行在 **≥2 次**里被执行过 → 记已覆盖；否则未覆盖；
- 合成结果交给 crapper 打分；
- `generation.merge = { runs: 3, rule: "line-majority", divergentLines, digests }`——
  `divergentLines` 是持续可看的健康指标：它变大，说明测试又开始不稳。

#### 合并比的是"覆盖状态"，不是"命中次数"——这条边界会毁掉整个判断（2026-11 实测）

合并器对每一行只问一个问题：**这次 run 里 `DA` 的 hits 是否 > 0**。命中次数不参与比较。

同一次刷新的三份报告，逐行比对：

| 比较的东西 | 三份之间不同的行数 |
| --- | --- |
| **覆盖状态**（`hits > 0`？） | **1** |
| 命中次数（原始数字） | **784** |

那 784 行是 `registry.ts:163-167`（103 vs 60）、`budget.ts:294-311`（308 vs 311）、
`live-children.ts:227-236`（31238 vs 31480）这类——**两边都 >0，只是跑了几次不同**。缓存命中、
测试顺序、调度都会改这个数字，它本身没有意义。

**所以：任何一个工具，只要哪天把比较从"状态"改成"次数"，这 784 行会在同一秒钟变成 784 条假发散**，
而 `divergentLines` 的解释是"测试不稳"——那会让人去查根本不存在的不稳定。写在这里，是因为这个
改法看起来像是在"提高严格度"。

#### 已知单行发散：`web/src/components/evolution/automation/sections.tsx:190`（2026-11，连续三代）

这一行在三次同提交采集里是 **`0 / 2 / 0`**：位置固定、结果翻转。

| 对 | 覆盖状态不一致 |
| --- | --- |
| r1 vs r2 | 1 行（`0` vs `2`） |
| r1 vs r3 | **0** |
| r2 vs r3 | 1 行（同一行，`2` vs `0`） |

2/3 多数把它判为**未覆盖**。它比"噪声里的 1"更值得记：**任何一个把这条行算进去的函数，它的
分支覆盖率会在这条行读到的 0 与 2 之间翻转**，于是 CRAP 也跟着翻。

**它是什么**：`sections.tsx` 里那族"异步渲染没落定就断言"的残留——某个测试对它的贡献取决于
时序，而不是取决于代码。

**升级条件（定量，取代原来那条 `divergentLines ≥ 5`）：**

| 触发 | 处置 |
| --- | --- |
| 同一个文件里出现 **≥2 行**发散 | **单独立项**，不再当作已知项 |
| 发散点挪到 **`src/`** 下 | **单独立项**——`src/` 是计分主域，那里的翻转会直接改账本数字 |
| 同一行连续 **≥3 代**，但翻转方向一致（例如一直只有 r1 是 0） | 记一条：说明是确定性顺序问题，可定位 |

原来那条 `divergentLines ≥ 5` 对**单文件内漂移**太松：五条分散在五个文件里是背景噪声，两条挤在
同一个文件里则是那条用例自己的问题。**位置比条数重要。**

`--coverage-a/-b` 仍保留「两份必须覆盖同样行」的严格模式；加 `--coverage-c` 才走合并。
合并器是纯函数（`scripts/coverage-merge.mjs`），有单测覆盖 3 份一致 / 2-of-3 / 1-of-3 /
文件只出现在部分报告里 / LF·LH 重算。

**测量口径：并行与单 worker 各修好了一半，别把它当成「换 worker 数就稳」（2026-11 三组实测）。**

同一提交、每次清空覆盖率，三组各跑两次，比覆盖行集合签名：

| 组 | 两次签名 | 一致 | 差在哪 |
| --- | --- | --- | --- |
| 默认（vitest 3 的默认 pool 就是 `forks`） | `caccb270…` / `6e5377bd…` | 否 | `EvolutionWorkbench.tsx` 8 行 |
| `--pool=threads` | `caccb270…` / `33abb9ce…` | 否 | — |
| `--maxWorkers=1` | `6e5377bd…` / `d42cb499…` | 否 | `evolution/automation/sections.tsx` 6 行 |

早期一组「单 worker 两次逐位相同（`bd97fec5…`）」曾经成立，但**不可复现**——那是 2/2 的运气。
所以：**换 worker 数不是解**。真正剩下的不稳定来自**测试在异步渲染落定前就结束**：
`EvolutionWorkbench` / `automation/sections` 是同一类（与 `JevPanel` 同病）——覆盖率取决于
某个状态更新有没有在断言前发生，与 pool 无关。

当前可用的结论只有两条：
1. **CI 要快、测量要准**，两者口径允许不同；刷新用单 worker 采集仍是对的（更少并发干扰），
   但它**不能**保证签名一致，所以**双份采集 + 覆盖行集合判等**（见上一节）仍然是必需的口径检查；
2. 要让签名真正稳定，得把那两个组件（以及 `JevPanel` 这类）的测试改成**等状态落定再断言**，
   而不是靠 pool 调参。

**判等用「覆盖行集合」，不是文件字节（2026-11 实测）。** `lcov` 里 `DA:` 的命中次数
在并行跑测试时天生会抖——同一个文件 `241` 次 vs `1` 次都见过；但**覆盖行集合是稳定的**
（4 次全量跑签名一致、覆盖 50,255 行）。所以：

- 判等：每文件「已覆盖行号排序后的 sha256」→ 全仓签名相等才算同一次测量；
- 原始 `lcov.sha256` **只做溯源**，不做判等——它会误报，每次跑都不同；
- CRAP 只关心 `0 / 非 0`，不关心命中了几次。

**刷新现在要求两份独立生产的报告**：`vitest --coverage` 跑两次，`--coverage-a/--coverage-b`
传入，sha256 相同才写。不同则拒写，并把两份样本留在
`target/coverage/unstable/{a,b}/lcov.info`——digest 只能说明「不一样」，
落盘才能回答「哪几行没跑到」。第一次实跑就用上了：两次全仓覆盖率只有一行不同
（`web/src/ui/dialog.tsx:38`，233 vs 0）。

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

## 11. nightly 归因：只在有新债时回答「为什么」

守卫回答「账本涨了没有」，归因回答「涨的这几个为什么涨」。成本模型完全不同，所以触发条件也必须不同：

- **守卫天天看**，所以必须便宜：一次全量扫描 + 一次打分；
- **归因只在有事时看**，一次要跑 K 次全量，所以**只在 `new > 0` 时才跑**。
  `fixed` 多说明在还债，`worse` 常常还在噪声带里——都不值得为它付三次全量。

参数是刻意的，改动前先读理由：

- **K=3、单模式 `existing`。** `existing` 是账本数字的来源，拿它去比才是同一把尺；`self`
  并行采集会把这条正要观测的噪声再造一遍。K=3 是因为**它是归因，不是判定**：K=2 的
  「两次一致」正是把巧合当保证的那个形状（我们因此误改过一次口径），K=5 是下判决的价码，
  这里不下判决。
- **`--keys` 只传 `new` 里的键——但它不降成本。** 每个 cell 仍然完整跑一遍全量；`--keys`
  只是让报告只谈这次动过的函数。真正控制成本的是 `new > 0` 那道门槛。写在这里，免得下一个
  人以为加个 `--keys` 就便宜了，然后把它接进每次 PR。
- **归因失败不能让 nightly 变红。** 退出码只表达「归因有没有写出来」，不表达「差多少」；
  测量崩了写成 `status: "failed"` + 一行原因进 issue，job 照常绿。守卫失败是要人看的，
  解释失败只是这次没有解释——两者的红不该长得一样。
- **结果附在同一个 issue 里**（`### 归因（caliber）`），不新开单：两张单会让人以为有两件事。
  同一份模型也落在 artifact `caliber-attribution.json` 里，供事后对账。

nightly 里裁决只能是三种（单提交、单模式，所以不会有 `code-changed` / `source-sensitive`）：

- `stable`：三次复现同一个分数，**且等于账本那个数**——真变化，去读那个函数；
- `run-sensitive`：几次分数不一致，里面混着测量噪声，先别当债去补测试；
- `not-reproduced`：三次彼此一致，但都不等于账本那个数——**账本这条是采样噪声**，
  别去补测试，也别拿它写基线。这一条是整件事的重点：`EvolutionWorkbench` 的
  `8 vs 0` 就是这种形态，账本记的是那一次运气不好的采样。

## 10. 负结论：`plan-gate` 抓不住「任务被波次丢掉」

`applies the plan gate to controller-produced DAGs and resumes after approval` 断言了
`["merged","merged","merged"]`，看起来覆盖了「任务会不会丢」——**实际抓不住**。

实测：把 `markTaskLost` 的修复 revert 掉再跑，
`builds a deterministic DAG …` 绿、`plan-gate` 绿，只有
`leaves no task in a non-terminal state when its wave fails` **红**。

原因：`plan-gate` 只走顺利路径，没有任何任务被丢弃，所以它永远看不到这个形态。
**新增的那条终态用例是这类缺陷的唯一探测器。** 半年后看到 `plan-gate` 覆盖了 all-merged
就以为"有人管这件事"，是错的。

**一般原则：顺利路径的断言不能证明异常路径有人管。** 「三个任务都 merged」这种断言
只在没有任务被丢时成立，它天然看不见「任务被丢」——异常路径必须有一条**走异常路径**的
用例来守。看到某条测试覆盖了汇总结果，先问：它有没有可能走到那条异常分支？

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

## 12. 测试只能证明它运行的那个世界

三条原则，同一件事的三个面：**一条测试的可信范围，止于它实际执行的那个环境**；超出范围，绿只是绿，不是证据。

1. **顺利路径的断言不能证明异常路径有人管。** 「三个任务都 merged」只在没有任务被丢时成立，它天然看不见「任务被丢」（见 §10）。
2. **宽松的夹具不能证明严格环境。** 闸如果跑在一个不是 git 仓库的裸临时目录里，它依赖的 git 前置条件就永远不成立——被验证的其实是「闸在不会触发的方式下不误报」。
3. **在一个平台上跑通的断言不能证明另一个平台的行为。**

### 第三个样本：`pathToFileURL` 与 Windows

`scripts/prepare-desktop-runtime.mjs` 的入口守卫第一版把 `C:\...` 补成 `/C:/...` 交给 `pathToFileURL`。macOS 上它对 `/D:/a/x.mjs` 返回 `file:///D:/a/x.mjs`——**11 条用例全绿**。CI 的 `desktop-windows-x64` 报：

```
resource path `binaries\agent-team-node-x86_64-pc-windows-msvc.exe` doesn't exist
```

因为 Windows 上 `path.win32.resolve("/D:/a/x.mjs")` 等于 `\D:\a\x.mjs`（按**当前盘符**解析），URL 里带 `%5C`，守卫恒假，脚本 **exit 0，什么都不做**。

那些用例证明的是「macOS 怎么解析一个 Windows 路径」，不是「Windows 会怎样」。**判据：要证明一条平台无关的规则，被测代码本身不能调用平台相关的辅助函数。** 现在 drive 分支走 `new URL("file:///")` + `pathname` 赋值，两种系统上是同一段代码；真正的证据是 `desktop-windows-x64` 由 fail 变 pass。

### 失效的断言看起来和有效的断言一模一样

一个解析不到的类型名出现在 `as` 位置时，TypeScript 不会停下来。它把那个名字当成 `any`，于是 `as AdapterDoctorSpec` 退化成 `as any`：**编译通过、断言失效、什么都不校验**。

这个形态比"没写断言"更难发现，因为它长得和有效断言一模一样。`test/adapters-doctor.test.ts` 就是这样：`AdapterDoctorSpec` 从 `adapters/types.js` 引入，而它实际声明在 `adapters/shared.ts`；那条 `as` 站了很久。测试一直在调真函数，行为是对的——但输入形状一次都没被校验过，接口哪天改了字段，测试不会响。

**判据：一条类型断言的有效性，依赖它的类型名能被解析。** 而当类型检查覆盖不到那个文件时（`test/**` 曾长期不在 `tsc` 的 include 里），两条独立失效就叠成一条看起来有防护的测试。

验证方式不是"改完 0 错误"，是**反证**：把被测字段改个名字，看编译器会不会指名道姓——

```
TS2561: Object literal may only specify known properties, but 'authArgsTypo'
does not exist in type 'AdapterDoctorSpec'. Did you mean to write 'authArgs'?
```

这条和上一条同源：**你无法用"跑通了"证明检查在起作用，只能用"故意弄错会不会红"证明。**

### 三个样本的共同形状

| 样本 | 断言证明了什么 | 部署的世界 |
|---|---|---|
| `lastLstat` 被 `load()` 内部的 lstat 污染（#203） | 一次 lstat 的先后 | 那个顺序属于 `load`，不属于被测函数 |
| 基线夹具是裸临时目录、不是 git 仓库 | 闸在不触发 git 前置条件时不误报 | 真实仓库里那个前置条件永远成立 |
| `pathToFileURL` 在 macOS 上解析 `/D:/…` | macOS 的路径解析 | Windows runner 按当前盘符解析 |

三者失败的形状不同，根因相同：**测试证明了它实际运行的那个世界，而那个世界不是被部署的世界。**

最该警惕的是第三个样本的失败形态：**exit 0、什么都不做、错误在下游很远的地方才暴露**。抛异常的 bug 会把人带到现场；静默 no-op 会把人带到离根因最远的地方。看到「这一步跑过了但什么都没产出」，先怀疑守卫或前置条件本身，再怀疑下游。
