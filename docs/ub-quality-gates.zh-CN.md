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

## 5. 本仓实测基线（2026-10-30）

```text
函数总数            1788
CRAP > 10           507
覆盖率 0% 的函数     406
按区域：src 404 个超阈值 / web 103 个超阈值
```

`web/` 的组件没有单元测试（走 Playwright e2e），所以 CRAP 全部偏高——这说明
**CRAP 不适合直接给 UI 组件打分**，全仓阈值在该区域无意义。

改动后新增代码（`experience.reasoning-bank`、`ExperienceCatalog.importCandidates`、
`ExperienceService.importReasoningBank`、`ub-quality-gate` 的解析函数）实测均 < 10。
仍然超阈值的 6 个是存量：

| 函数 | CC | 覆盖率 | CRAP |
| --- | --- | --- | --- |
| `ExperienceService.extractFromRun` | 20 | 33% | 138.5 |
| `experience.extract.humanizeErrorBrief` | 14 | 38% | 59.7 |
| `ExperienceCatalog.recordRetrieval` | 6 | 5% | 37.3 |
| `experience.extract.portableFailureLesson` | 16 | 59% | 33.5 |
| `experience.extract.extractCandidatesFromRun` | 25 | 77% | 32.9 |
| `RunSupervisor.startOwned` | 28 | 85% | 30.5 |

下一步按 CRAP 顺序拆分并补测，而不是先写新功能。

## 6. 与技能层的关系

ub-mode 是本仓「Agent Skills」层里第一个带确定性工具链的真技能：`SKILL.md` + 三个可执行门。
它同时也验证了技能层验收标准——技能不是文档，而是**能被跑起来、能判失败**的东西。
