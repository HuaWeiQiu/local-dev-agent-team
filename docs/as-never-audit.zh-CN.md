# `as never` 审计：315 处，在动第一处之前

这份表先于任何修复。`test/**` 现在有 **315 处 `as never`**、**267 条类型错误**；把 315 处断言全部删掉再跑，错误变成 **510 条**。**283/267 只是类型检查能看见的部分，310 条错误藏在断言后面。**

## 三个桶与判据

| 桶 | 判据 | 数量 |
|---|---|---|
| **A · 无谓** | 去掉断言后表达式仍能赋值 | **0** |
| **B · 绕过形状** | fixture 本身不是生产形状，断言在替它挡枪 | **247** |
| **C · 故意非法输入** | 传入生产里真会出现的坏数据，测边界校验 | **32** |
| **C? · 待判** | 用例名指向错误路径，但断言不在附近 | **36** |

### A = 0 是实验结论，不是估计

取"附近没有错误"的 30 个文件、52 处断言，全部删掉再跑：错误从 267 **涨到 314**。**没有一处是无谓的**——每一处都在替某个形状问题挡枪。这也是为什么"直接删掉所有 `as never`"不是一条可执行的路线：删完立刻多 47 条错误，而代码一行没变好。

### C 的判据是两条，缺一不可

1. 传入的值是**生产里真会出现的坏数据**（损坏的配置文件、缺字段的反序列化结果）；
2. 后面**断言了那条校验**（`rejects.toThrow(/具体消息/)`）。

两条都满足才是 C。只满足第 1 条的，很可能是"编了个非法值，然后测了兜底分支"——那正是 `status: "shared"` 和 `portability: "project-only"` 那两条事故的形状（见 #216）。

### C? 抽样：多数其实是 B

36 处里抽样 6 处：3 处是 fixture 形状（`catalog as never`、`mockResolvedValue(...) as never`），2 处是断言离得稍远的真非法输入（`{ when: { all: [] } }` 后面第 3 行才有 `expect(...).toContain`），1 处是 mock 参数强转。

**所以"故意非法输入"的真实规模在 32–38 之间，不是 78。** 逐条判定留在这里，因为再往下就需要读每一条的业务语义。

## C 桶（32 处，全部有断言）—— 保留

这些不该被 eslint 一刀切禁掉：类型系统不允许非法值，而测试要喂非法值。它们的合法性来自"后面那条断言"。

| 文件:行 | 所在用例 | 该处的样子 |
|---|---|---|
| `test/evolution-persistence.test.ts:1211` | rejects a missing config, root or state directory | `await expect(DurableEvolutionCatalog.open(null as never)).rejects.toThrow(/Loa` |
| `test/evolution-persistence.test.ts:1213` | rejects a missing config, root or state directory | `DurableEvolutionCatalog.open({ root: "", config: {} } as never),` |
| `test/evolution-persistence.test.ts:1216` | rejects a missing config, root or state directory | `DurableEvolutionCatalog.open({ root: "/tmp", config: undefined } as never),` |
| `test/evolution-persistence.test.ts:1224` | rejects a missing config, root or state directory | `} as never),` |
| `test/evolution-persistence.test.ts:1234` | rejects a root that does not resolve to a directory | `} as never),` |
| `test/strategies-catalog-open.test.ts:25` | refuses a missing loaded config | `StrategyBlueprintCatalog.open(undefined as never),` |
| `test/strategies-catalog-open.test.ts:31` | refuses a config without a root | `StrategyBlueprintCatalog.open({ config: {} } as never),` |
| `test/strategies-catalog-open.test.ts:37` | refuses a config without a project config | `StrategyBlueprintCatalog.open({ root: "/tmp", config: undefined } as never),` |
| `test/strategies-catalog-open.test.ts:58` | refuses a root that resolves to something other than | `io: { lstat: async () => ({ isDirectory: () => false }) as never },` |
| `test/adapter-conformance.test.ts:69` | rejects a bad name, contract and duplicate declarati | `assertAdapterContract(adapter({ contract: { ...adapter().contract, version: 2 ` |
| `test/adapter-conformance.test.ts:72` | rejects a bad name, contract and duplicate declarati | `assertAdapterContract(adapter({ supportedReasoning: ["low", "low"] as never })` |
| `test/adapter-conformance.test.ts:75` | rejects a bad name, contract and duplicate declarati | `assertAdapterContract(adapter({ supportedReasoning: [] as never })),` |
| `test/adapter-conformance.test.ts:78` | rejects a bad name, contract and duplicate declarati | `assertAdapterContract(adapter({ supportedReasoning: ["nope"] as never })),` |
| `test/adapter-conformance.test.ts:81` | rejects a bad name, contract and duplicate declarati | `assertAdapterContract(adapter({ contract: { ...adapter().contract, structuredO` |
| `test/experience-catalog.test.ts:440` | refuses to share anything unknown, unverified, sensi | `summary: "A candidate that was never promoted",` |
| `test/strategies-catalog-persist.test.ts:59` | keeps writing after a failed pre-rename attempt | `}) as never,` |
| `test/http-intake-route.test.ts:36` | refuses everything while intake is off | `route.handler(ctx, {} as never, response().res, new URL("http://x/intake/githu` |
| `test/flow.test.ts:88` | refuses review without test, unreachable nodes, cycl | `all: [{ fact: "madeUp" as never }],` |
| `test/web-run-action-dialog.test.ts:80` | blocks approval until an incomplete plan is acknowle | `const complete = { status: "complete", issues: [] } as never;` |
| `test/web-run-action-dialog.test.ts:81` | blocks approval until an incomplete plan is acknowle | `const incomplete = { status: "incomplete", issues: ["缺 T2"] } as never;` |
| `test/config.test.ts:215` | rejects advisor profiles that are undefined or write | `advisor: { enabled: true, profile } as never,` |
| `test/config.test.ts:227` | rejects duplicate advisor triggers and out-of-range  | `advisor: { enabled: true, triggers: ["pre-final", "pre-final"] } as never,` |
| `test/config.test.ts:235` | rejects duplicate advisor triggers and out-of-range  | `advisor: { enabled: true, maxConsultationsPerRun: 11 } as never,` |
| `test/evolution-catalog.test.ts:1200` | rejects malformed material and bad pointers | `expect(() => restoreEvolutionCatalog(defaultTrust, null as never)).toThrow(/mu` |
| `test/evolution-catalog.test.ts:1202` | rejects malformed material and bad pointers | `restoreEvolutionCatalog(defaultTrust, { ...material, extra: 1 } as never),` |
| `test/evolution-catalog.test.ts:1205` | rejects malformed material and bad pointers | `restoreEvolutionCatalog(defaultTrust, { ...material, proposals: "x" } as never` |
| `test/evolution-catalog.test.ts:1209` | rejects malformed material and bad pointers | `badPointer.activeProposals[0]!.target = { kind: "unknown" } as never;` |
| `test/evolution-catalog.test.ts:1213` | rejects malformed material and bad pointers | `missingName.activeProposals[0]!.target = { kind: "strategy-blueprint" } as nev` |
| `test/evolution-catalog.test.ts:1221` | rejects a trust context that is not a context | `expect(() => restoreEvolutionCatalog({} as never, material)).toThrow(/Evolutio` |
| `test/evolution-catalog.test.ts:1223` | rejects a trust context that is not a context | `restoreEvolutionCatalog({ ...defaultTrust, configuredRolePromptPaths: [1] } as` |
| `test/evolution-catalog.test.ts:1226` | rejects a trust context that is not a context | `restoreEvolutionCatalog({ ...defaultTrust, roleAllowedProfiles: { worker: [1] ` |
| `test/web/run-actions.test.tsx:102` | keeps the launcher open and reports a failed start | `started = await view.result.current.create({ goal: "do it" } as never);` |

## C? 桶（36 处，需逐条判定）

| 文件:行 | 所在用例 | 该处的样子 |
|---|---|---|
| `test/flow-validate.test.ts:113` | refuses a conditional mandatory step | `node.id === "final-checks" ? { ...node, when: { all: [] } as never } : node,` |
| `test/web-demo-insights.test.ts:54` | reports a failed final gate and no gate at all | `runWith({ finalQuality: { passed: false, commands: [] } as never, tasks: [task` |
| `test/server-routes-trio.test.ts:224` | passes an HttpError through untouched | `context({ strategies: catalog as never }),` |
| `test/web-desktop-project.test.ts:83` | reports an error or busy status with its technical d | `invoke: vi.fn(async () => ({ state: "error", message: "坏了", technicalDetail: "` |
| `test/web-desktop-project.test.ts:86` | reports an error or busy status with its technical d | `await addDesktopProjectFlow(o as never, p);` |
| `test/web-desktop-project.test.ts:105` | passes other failures through the action copy | `}) as never,` |
| `test/web-desktop-project.test.ts:108` | passes other failures through the action copy | `await addDesktopProjectFlow(o as never, p);` |
| `test/planning-stage.test.ts:150` | fails open when the researcher throws | `state as never,` |
| `test/planning-stage.test.ts:171` | rethrows when failOpen is off | `state as never,` |
| `test/coverage-caliber-report.test.ts:145` | writes the report through main and reports measureme | `const code = main(["--repeats", "1", "--modes", "existing", "--format", "json"` |
| `test/coverage-caliber-report.test.ts:151` | writes the report through main and reports measureme | `const missing = main(["--repeats", "1", "--modes", "existing"], { ...io, exist` |
| `test/strategies-catalog-persist.test.ts:34` | removes its temporary file when the write fails befo | `}) as never,` |
| `test/oneshot-session.test.ts:76` | reports a provider failure with its text | `new AgentInvocationError("provider failed", result("部分输出") as never),` |
| `test/plan-completeness.test.ts:96` | rejects two recon tasks and recon with acceptance co | `task({ id, title: `只读侦察 ${id}`, acceptanceCommands: [{ command: "x", args: [] ` |
| `test/scheduler-phases.test.ts:55` | counts only blocked tasks | `expect([...blockedTaskIds(run as never)]).toEqual(["T1"]);` |
| `test/scheduler-phases.test.ts:115` | blocks every task that is neither done nor already b | `expect(markUnfinishedBlocked(run as never, new Set(["T1"]), blocked)).toEqual(` |
| `test/http-intake-route.test.ts:49` | refuses everything while intake is off | `} as never;` |
| `test/http-intake-route.test.ts:73` | rejects a body without an event | `{ statusCode: 0, setHeader: () => undefined, writeHead: () => undefined, end: ` |
| `test/web-presentation.test.ts:191` | describes a failed probe | `jevProbeSummary({ ok: false, latencyMs: 12, error: "timeout" } as never),` |
| `test/desktop-runtime-pipeline.test.ts:226` | refuses a foreign target when it is actually asked t | `fetch: undefined as never,` |
| `test/desktop-runtime-pipeline.test.ts:429` | treats an unreadable rustc as a failed measurement,  | `fetch: undefined as never,` |
| `test/desktop-runtime-pipeline.test.ts:446` | rejects rustc output that has no host line | `fetch: undefined as never,` |
| `test/supervisor.test.ts:72` | refuses to recover a plan checkpoint that was never  | `it("refuses to recover a plan checkpoint that was never approved", () => {` |
| `test/web-demo-seed.test.ts:94` | fails the quality check when the final quality did n | `finalQuality: { passed: false, commands: [] } as never,` |
| `test/web/evolution-action-panel.test.tsx:81` | decides reviewability, deletion and failure copy | `failureTitle(proposal({ evaluation: { source: "external" } as never })),` |
| `test/web/evolution-action-panel.test.tsx:86` | decides reviewability, deletion and failure copy | `proposal({ evaluation: { result: { summary: "缺证据" } } as never }),` |
| `test/web/evolution-action-panel.test.tsx:105` | offers promote and reject once the structural prefli | `evaluation: { source: "server-structural-preflight-v1", result: { passed: true` |
| `test/web/evolution-action-panel.test.tsx:126` | explains a failed preflight with its summary | `evaluation: { source: "external", result: { passed: false, summary: "结构缺失" } }` |
| `test/web/evolution-action-panel.test.tsx:145` | archives a finished candidate and only deletes after | `const { unmount } = panel(proposal({ status: "promoted", application: {} as ne` |
| `test/web/run-actions.test.tsx:219` | reads an evidence artifact and refuses without a run | `monitor: idleMonitor as never,` |
| `test/web/component-maps.test.tsx:145` | forwards the dialog error to both dialogs | `scope={{ mode: "single", projectId: "p1" } as never}` |
| `test/web/component-maps.test.tsx:146` | forwards the dialog error to both dialogs | `config={{ roles: {} } as never}` |
| `test/web/strategy-composer.test.tsx:205` | shows the empty-canvas hint and the error callout | `const emptyTopology = { mode: "parallel-dag", stages: [], edges: [] } as never` |
| `test/web/strategy-composer.test.tsx:208` | shows the empty-canvas hint and the error callout | `graph={{ nodes: [], edges: [] } as never}` |
| `test/web/run-task-detail.test.tsx:123` | hides the diff block when there were no attempts | `render(<TaskDetail task={task({ attempts: 0 })} onLoadDiff={async () => ({ fil` |
| `test/web/evolution-evidence.test.tsx:95` | renders a failing header and a failed item | `items={[{ kind: "deterministic", id: "score", summary: "分数", status: "fail" }]` |

## B 桶（247 处，按文件）—— 与那 267 条错误一起清

同一个文件不能开两次：改 fixture 到生产形状时，这些断言自然消失。所以按文件推进，一批里同时报两个数：`错误 N → M`、`as never 315 → K`。

| 文件 | 处数 |
|---|---|
| `test/planning-stage.test.ts` | 26 |
| `test/web/run-page.test.tsx` | 11 |
| `test/web-desktop-project.test.ts` | 10 |
| `test/http-intake-route.test.ts` | 9 |
| `test/flow-validate.test.ts` | 8 |
| `test/plan-completeness.test.ts` | 7 |
| `test/web/app-chrome.test.tsx` | 7 |
| `test/web-run-actions.test.tsx` | 6 |
| `test/scheduler-phases.test.ts` | 6 |
| `test/authority-mandate.test.ts` | 6 |
| `test/web/evolution-action-panel.test.tsx` | 6 |
| `test/web/run-actions.test.tsx` | 6 |
| `test/web-demo-insights.test.ts` | 5 |
| `test/web-api-wrappers.test.tsx` | 5 |
| `test/web-run-overview.test.tsx` | 5 |
| `test/web/architecture-diagram.test.tsx` | 5 |
| `test/web/automation-bar.test.tsx` | 5 |
| `test/server-routes-trio.test.ts` | 4 |
| `test/strategies-catalog-open.test.ts` | 4 |
| `test/authority-resume.test.ts` | 4 |
| `test/task-attempt-resume.test.ts` | 4 |
| `test/web-presentation.test.ts` | 4 |
| `test/budget-helpers.test.ts` | 4 |
| `test/github-publish.test.ts` | 4 |
| `test/web-demo-seed.test.ts` | 4 |
| `test/web/strategy-inspector.test.tsx` | 4 |
| `test/adapter-conformance.test.ts` | 3 |
| `test/evolution-audit-trail.test.ts` | 3 |
| `test/web/component-maps.test.tsx` | 3 |
| `test/supervisor-watchdog.test.ts` | 2 |
| `test/coverage-caliber-report.test.ts` | 2 |
| `test/oneshot-session.test.ts` | 2 |
| `test/adapters-doctor.test.ts` | 2 |
| `test/web-board.test.tsx` | 2 |
| `test/codex-session-protocol.test.ts` | 2 |
| `test/web-role-binding.test.tsx` | 2 |
| `test/web-attention-mount.test.tsx` | 2 |
| `test/web-task-node.test.ts` | 2 |
| `test/claude-session-result.test.ts` | 2 |
| `test/cli-inventory-toml.test.ts` | 2 |
| `test/reliability.test.ts` | 2 |
| `test/visibility-transcript.test.ts` | 2 |
| `test/web/evolution-overview.test.tsx` | 2 |
| `test/web/architecture-stage.test.ts` | 2 |
| `test/web/workspace-view.test.tsx` | 2 |
| `test/web/strategy-composer.test.tsx` | 2 |
| `test/web/strategy-stage-node.test.tsx` | 2 |
| `test/web/evolution-decision-dialog.test.tsx` | 2 |
| `test/claude-session-start.test.ts` | 1 |
| `test/supervisor-local-ticket.test.ts` | 1 |
| `test/assignment-outcome.test.ts` | 1 |
| `test/agent-fallback.test.ts` | 1 |
| `test/web-desktop-launcher.test.tsx` | 1 |
| `test/claude-session-lines.test.ts` | 1 |
| `test/server-sse-stream.test.ts` | 1 |
| `test/flow.test.ts` | 1 |
| `test/web-module-detail.test.tsx` | 1 |
| `test/supervisor-admit-event.test.ts` | 1 |
| `test/ticket-service.test.ts` | 1 |
| `test/desktop-runtime-pipeline.test.ts` | 1 |
| `test/doctor.test.ts` | 1 |
| `test/authority-gate.test.ts` | 1 |
| `test/web-attention-panel.test.tsx` | 1 |
| `test/config.test.ts` | 1 |
| `test/web-demo-server.test.ts` | 1 |
| `test/presentation-maps.test.ts` | 1 |
| `test/subscription-direct-pass.test.ts` | 1 |
| `test/claude-session-turn.test.ts` | 1 |
| `test/web-task-node-render.test.tsx` | 1 |
| `test/web/agents-panel.test.tsx` | 1 |
| `test/web/evolution-workbench.test.tsx` | 1 |
| `test/web/strategy-draft.test.ts` | 1 |
| `test/web/evolution-workbench-model.test.ts` | 1 |
| `test/web/agents-panel-card.test.tsx` | 1 |
| `test/web/evolution-workbench-hook.test.tsx` | 1 |
| `test/web/evolution-workbench-branches.test.tsx` | 1 |
| `test/web/action-dialog-submit.test.tsx` | 1 |
| `test/web/run-events-hook.test.tsx` | 1 |
| `test/web/experience-workbench.test.tsx` | 1 |

## 对最终那道 eslint 锁的含义

"禁止 `test/**` 的 `as never`"太粗——它会把 C 桶 32 处正当用法一起判死。可执行的规则是**按位置**：

- **禁止**：`const x = {...} as never`、`mockResolvedValue(... as never)`、`(x as never as T)`——fixture 位置；
- **允许**：直接作为被测函数实参、且同一用例里有对应断言——边界位置。

判据能写成一条 lint 规则的话，那才是"编译器真的会拦住你"；写不成的话，退回到"C 桶要有一条人工复核清单"。

## 怎么用这份表

1. 按文件推进，B 桶与类型错误同时清；
2. 每批两个数字一起报，只有一个下降说明在把洞藏起来；
3. C? 那 36 处逐条判完再决定去留；
4. 全部清零后再加 eslint 锁——**否则锁的是空壳**。
