# Flaky 归因记录：三条「全量并发偶发、单跑必过」

- 文档状态：已结案（2026-11）
- 结论一句话：三条里只有一条是真的会在负载下变红——而且红的是**断言口径**，不是配额逻辑；另两条从未复现，历史 CI 红灯其实是第四条（`lease.test.ts` 的并发接管缺陷）。
- 关联 PR：[#125](https://github.com/HuaWeiQiu/local-dev-agent-team/pull/125)（诊断）、[#130](https://github.com/HuaWeiQiu/local-dev-agent-team/pull/130)（波次失败观测）、[#137](https://github.com/HuaWeiQiu/local-dev-agent-team/pull/137)（断言改不变量）、[#133](https://github.com/HuaWeiQiu/local-dev-agent-team/pull/133)（lease 修复）、[#143](https://github.com/HuaWeiQiu/local-dev-agent-team/pull/143)（覆盖率污染）

## 1. 总表

| 用例 | 定性 | 证据 |
| --- | --- | --- |
| `architect-advisor > respects the per-run consultation limit across parallel tasks` | **复现并归因**：高负载下兄弟任务在 setup 阶段死掉，配额被另一任务独吞，`run.advisor.skipped` 不会产生；旧断言要求「恰好一次 skip」是顺序假设，不是不变量 | 见 §2 |
| `acceptance-gate > does not force plan approval just because tasks define acceptanceCommands` | **未复现**：隔离 30 轮、三文件并行 6 轮、CPU 饱和 30 轮、端到端 soak 10 轮全部通过 | 见 §3 |
| `workflow > builds a deterministic DAG from named paths without calling the architect` | **未复现**：同上。历史上被当作 flaky 的两次 CI 红灯，实际是 `lease.test.ts` | 见 §3、§4 |
| （第四条，附带发现）`lease.test.ts > settles concurrent stale-lock reclaim with exactly one owner` | **真并发缺陷**：stale 回收的 read→unlink 之间没有互斥，能把别人刚发布的锁删掉 | 见 §4 |

## 2. `architect-advisor` 咨询配额：红的是断言

### 2.1 现象

全量并发偶发失败，单跑必过。PR #125 加的诊断行给出（`test/architect-advisor.test.ts`）：

```text
AssertionError: status=blocked consultations=1 calls=[repeated-failure]
tasks=[alpha=working, beta=blocked] advisorEvents=[run.advisor.consulted@beta]:
expected [] to have a length of 1 but got +0
```

关键读法：**配额没有被冲破**（`consultations=1`，advisor 只被调用一次），失败的是「另一个任务必须产生 skip 事件」这一条。

### 2.2 根因

失败 run 落盘的 `state.json`（夹具目录 `.agent-team/runs/<id>/state.json`）：

```text
alpha: status=working  attempts=0
beta : status=blocked  attempts=3
history: beta attempt 1 → rework → attempt 2 → rework → attempt 3 → rework
         → integrating → blocked: Task 'beta' blocked: Exceeded 3 attempt(s)
```

- `beta` 独自跑满重试预算，并在它**第三次**尝试（第一次满足 `repeated`）花掉唯一配额；
- `alpha` 的 `attempts=0`：它在 `worktree` 创建阶段就抛了，一次尝试都没进（`status` 被 `scheduler` 提前置为 `working`）；
- 那个抛出被 `reportWaveOutcome` 静默丢弃——原逻辑只在「本波没有任何 blocked 任务」时才重抛 rejection：

  ```ts
  if (rejection && passedStates.length === 0 && blocked.length === 0) throw rejection.reason;
  ```

  这一波 `beta` 已 blocked，于是 `alpha` 的死因彻底消失，`state.error` 只留 beta 的 `Exceeded 3 attempt(s)`。

- `run.advisor.skipped` 只在「另一个任务也走到 escalate」时才会发。`alpha` 没走到，于是 skip 计数为 0，旧断言必然红。

一句话：**测试把「两个任务大致同步推进」当成不变量**；慢机上任务在 setup 阶段掉队时，skip 那一侧根本不存在。

### 2.3 复现步骤

```bash
# 独立 worktree，symlink node_modules，避免污染主工作树
git worktree add /tmp/wt-flaky -b exp/flaky-repro origin/main
ln -s "$PWD/node_modules" /tmp/wt-flaky/node_modules
cd /tmp/wt-flaky

# 12~18 个 CPU burner 压满，同时反复跑该用例
for i in $(seq 1 18); do
  node -e 'const t=Date.now();for(;;){if(Date.now()-t>1800000)break;}' &
done
for i in $(seq 1 20); do
  npx vitest run test/architect-advisor.test.ts \
    -t "respects the per-run consultation limit" --reporter=basic
done
kill %1 2>/dev/null
```

观察到的失败率与条件（同一台 18 核机器）：

| 条件 | 轮数 | 失败 |
| --- | --- | --- |
| 隔离单跑 | 30 | 0 |
| 与 `workflow`/`sessions` 同一进程并行 | 6 | 0 |
| 12 个 CPU burner | 10 | 1 |
| 18 个 CPU burner（饱和） | 20 | 1 |

单轮耗时从 874ms 涨到 3215ms（3.7×），说明负载确实把时序拉开了。

失败后可以读夹具留下的 `state.json` 复核形状（`alpha=working/0`、`beta=blocked/3`）。

### 2.4 处置

1. **#130（观测）**：波次任务抛错时保留 `taskId`、阶段（`worktree`/`dependencies`/`task`）、`status`、`attempts`、`durationMs`、错误前 500 字，写进 `run.wave.completed.rejected[]`，并采样 `environment`（loadavg + 并发 `vitest|crapper` 进程数）。行为不变。
2. **#137（口径）**：把断言改成不变量，详见 §5。

## 3. `acceptance-gate` 与 `workflow DAG`：从未复现

同一套压测（隔离 30 轮 / 三文件并行 6 轮 / CPU 饱和 30 轮 / 端到端 soak 10 轮 × 1869 用例）对这两条**一次都没红**，也没有任何真实失败样本。因此这里不给根因，只留诊断与复现入口：

- 两条用例失败时的消息都带 `describeRun` 快照（`status/tasks/approvals/last`），下次真红会直接说明 run 停在哪、最后一次做了什么。
- 若要继续追：把 `§2.3` 的 burner 换上这两个用例名循环跑；命中后先看 `state.status`、任务 `error` 与 `history` 末尾，再谈改测试还是改 `src/`。

需要记录的是：**历史两次 CI 红灯不是这两条**（`41269126022`、`41265925952`），两次都是 `lease.test.ts`。

## 4. 附带发现：`lease.test.ts` 的并发接管缺陷（真 bug）

### 4.1 证据

两次 CI 红灯的失败信息完全一致：

```text
FAIL test/lease.test.ts > project control lease > settles concurrent stale-lock reclaim with exactly one owner
AssertionError: expected [ { status: 'fulfilled', …(1) }, …(1) ] to have a length of 1 but got 2
```

### 4.2 机制

`acquireControlLease` 回收 stale 锁是 `read → 再读确认 → unlink(按名删)`，三步之间没有互斥。回收者确认完还没删时，别的 claimant 可以 `link` 出新的锁；回收者的 `unlink` 按名字删文件，于是把刚生效的锁删掉：

- 被删的 winner 继续以为自己持锁 → **两个 owner**（`got 2`）；
- 或 winner 在下一次 `assertLockOwner` 时发现锁没了 → `Control lease was replaced by a concurrent claimant during acquisition`。

### 4.3 修法与不靠运气的证明

`#133` 在回收前抢 take-over 标记 `control.lock.reclaim`（`open(..., "wx")`，`O_CREAT|O_EXCL`）：该原语在 APFS/ext4/overlayfs 上原子，只有一个 claimant 拿到；拿到者在 `read → unlink` 期间独占回收权，而锁名此刻仍被死主的文件占着、`link` 是 create-only，所以没人能把名字换成新锁——窗口消失。

证明方式（**先红后修**）：

- `src/server/lease-fs.ts` 把 `mkdir/openExclusive/link/read/unlink/modifiedAt` 抽成注入接口；
- 内存实现把「第一个回收者的 `unlink`」停在原地，等另一个 claimant 成功 `link` 或尝试抢标记再放行；
- 旧算法冻结在 `test/fixtures/legacy-control-lease.ts`，同一交错下断言 `replaced === 0` 报 `expected 1 to be +0`；
- 新实现同一交错：恰好一个 owner、0 个 winner 被夺锁、标记与 `.tmp` 不残留。

本地 CPU 饱和压 40 轮**没**复现这条（CI 的 Linux 文件系统更慢、窗口更宽），所以这条不能靠压测证明，只能靠注入交错。

## 5. #137 的口径教训：别把顺序当成不变量

旧断言写的是三个**具体计数**：`advisorCalls === 1`、`advisorConsultations === 1`、`skipped 事件 === 1`。前两条是产品约束，第三条顺手把「两个任务都走到 escalate」这个调度结果也写成了约束——而这件事在高负载下不成立。

改后的三条规则：

1. **配额是上限，不是定值**：`advisorCalls`、`state.advisorConsultations`、`consulted` 事件数都 `<= maxConsultationsPerRun`。谁花掉最后一次是竞态，能花几次不是。
2. **配额耗尽后不许有任务「无人交代」**：非咨询任务必须满足其一——`blocked`、有 `run.advisor.skipped`、或被记进 `run.wave.completed.rejected`。「`working` 且哪儿都没记录」正是当初让这条用例无法解释的状态。
3. **只有这一波没丢任务时**，才要求恰好一次 `skipped`。

并且不能只靠放宽变绿，所以另加一条**确定性用例**把曾经红掉的形状按需造出来：让第二个任务的 agent 起不来，它死在 `worktree` 阶段并被记进 `rejected`、`skip` 计数为 0——旧断言在这条上必红，新不变量通过，配额上限断言在该用例里照样生效。**改了断言口径，就要能造出旧红**，否则分不清「消除假红」和「把检查删掉」。

## 6. 覆盖率污染不是这三条的成因，但会污染门禁（#143）

`coverage.all` 默认 `true`，覆盖率会把项目里所有文件当源码；默认 exclude 没有 `target/`，于是 `target/coverage/**` 里上一轮的 HTML 资源（`sorter.js` 等）被当源码插桩。两个覆盖率进程交错时，删目录的那个会让另一个在 `getUntestedFiles → V8ToIstanbul.load` 报

```text
Error: ENOENT: no such file or directory, open '.../target/coverage/typescript/lcov-report/sorter.js'
```

整轮 exit 1，门禁读成 **0% 覆盖率**——静默污染所有人的 CRAP 分数。

- 与三条 flaky 的关系：**无因果**。CI 的 `quality` 跑的是 `pnpm test`（无 `--coverage`），仓库里也没有测试读 `target/`；带 coverage 的 vitest 与目标用例并发 20 轮，目标用例 20/20 通过。
- 修法（#143）：`coverage.exclude` 追加 `target/**`、`coverage/**`，`coverage.reportsDirectory` 显式指向 `target/coverage/typescript`（该目录本身在 exclude 内），并加 `test/vitest-coverage-config.test.ts` 守住配置。
- 验收：把 8000 个假报告资源铺进 `target/coverage` 放大窗口，50ms 时删目录——旧配置 `EXIT=1` 且栈正是 `readFile ← V8ToIstanbul.load ← getUntestedFiles`；新配置同一交错 `EXIT=0`、`lcov` 388 个 `SF:`、`SF:target/` 为 0；两个覆盖率进程并发（各自独立 reportsDirectory，其中一个还在删目录）两边都 `EXIT=0` 且 lcov 都含 `SF:src/cli.ts`。

## 7. 收尾数据

- 端点 soak（`--maxWorkers=9`，独立 worktree、唯一 `reportsDirectory`，每轮记 loadavg 与并发进程）：**10/10 绿，1869 用例/轮**，耗时 32.9s–49.5s；loadavg 1m 从 5.1 升到 21.1、并发 `vitest|crapper` 最多 20 个进程的轮次同样全绿。
- 实验纪律：一律独立 worktree，脚本与日志放 `/tmp`（`/tmp/flaky-logs/...`），不进代码树；跑完删除 worktree。
- 剩余风险：`workflow DAG` 与 `acceptance-gate` 仍无真实失败样本；`acceptance-gate` 的历史红点已被证明是 lease，但这两条若在未来复红，按 §3 的入口先取状态快照再定性。
