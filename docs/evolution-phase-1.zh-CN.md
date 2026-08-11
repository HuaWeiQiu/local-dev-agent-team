# 受限自演进 Phase 1-4

本文面向普通用户与维护者，说明当前仓库中**已实现**的受限自演进（bounded evolution）Phase 1-4：它受 OpenRSI 一类“可演进策略/提示”思路启发，但刻意收窄为**可审计的候选记录、受控应用与人工门禁**，不复制任何 OpenRSI 源码或协议文本。

实现入口：

| 模块 | 路径 | 职责摘要 |
| --- | --- | --- |
| Domain | `src/evolution/domain.ts` | schema、信任校验、摘要、证据绑定、生命周期、纯函数 guarded operations |
| Catalog | `src/evolution/catalog.ts` | 纯同步运行期索引、审计、active 指针、内部 promotion provenance、确定性快照、事务式提交 |
| Persistence（Phase 2） | `src/evolution/persistence.ts` | 异步 `DurableEvolutionCatalog`：受信任 open、失败可恢复的 promise 队列、原子磁盘提交、重开时 fail-closed 校验 |
| Application（Phase 3） | `src/evolution/application.ts` | 精确预览、对象存储、应用 journal、幂等确认、崩溃恢复与回滚链 |
| Control（Phase 4） | `src/server/evolution-service.ts`、`src/server/http.ts` | 本地会话、服务端固定预检、项目 mutation latch、窄 HTTP API 与关闭排空 |

相关决策记录见 [ADR 0013](./adr/0013-bounded-evolution-domain-catalog-boundary.md) 与 [ADR 0014](./adr/0014-durable-evolution-catalog.md)。架构与安全总览见 [architecture.md](./architecture.md) 与 [security.md](./security.md)。

## 1. 核心思想（受限，而非自治）

Phase 1 只回答一个问题：

> 在不改动真实 prompt/strategy 文件、不启动后台循环、不自动晋升的前提下，如何用可验证的数据结构记录“策略蓝图 / 角色提示”候选，并以**至少一条确定性证据 + 显式人工晋升/拒绝**作为 domain 强制门禁，同时把**独立审查**作为推荐的操作流程（而非 Phase 1 自动强制的检查）？

因此：

- **可以**：在受信任上下文中提出候选、绑定 SHA-256 摘要与证据、记录不可变生命周期、由人晋升/拒绝/回滚、在内存 catalog 中原子更新审计与 active 指针。
- **不可以（Phase 1 domain/catalog 明确不做）**：把候选应用为真实 prompt/strategy 文件、让 Agent 自动执行演进、网络发布、秘密存储、后台自运行或自动晋升。
- **Phase 2 补充（不改变 Phase 1 语义）**：`DurableEvolutionCatalog` 可在仓库拥有的 `stateDirectory/evolution` 下原子持久化同一套提案/审计/active/provenance，并在当前信任配置下 fail-closed 重开；仍不应用文件、不自动晋升。

演进策略能力标志在 domain 中被强制为字面量 `false`：

- `automaticExecution: false`
- `automaticPromotion: false`
- `networkPublication: false`
- `secretStorage: false`

## 2. Phase 1 已实现 vs 延期

### 2.1 已实现能力

| 能力 | 说明 |
| --- | --- |
| 受信任候选 | 仅 `strategy-blueprint` 与 `role-prompt` 两类；策略 `roleProfiles` 必须落在项目 `roles.*.allowedProfiles` 内 |
| 证据与摘要 | 候选经规范序列化后计算 **SHA-256**；评估证据必须绑定 `proposalId` + `candidateDigest` |
| 不可变生命周期 | `proposed → evaluating → evaluated → promoted \| rejected`，以及 `promoted → rolled-back` |
| 人工门禁 | 晋升、拒绝、回滚均需带 `actor` / `reason` / `decidedAt` 的显式人类决策 |
| 运行期私有内存 catalog | `EvolutionCatalog` 权威状态不暴露为可写公共字段；快照深拷贝并冻结 |
| 确定性快照 | `proposals`、`auditRecords`、`activeProposals` 使用稳定排序，适合相等比较 |
| 原子提交 | 多字段更新先在克隆工作副本上完成，成功后整体替换；校验失败不留下半状态 |
| 内部 promotion provenance | 晋升记录由 catalog 内部保留，调用方不能注入或替换回滚来源 |
| Phase 2 持久化包装 | `DurableEvolutionCatalog` 在 `stateDirectory/evolution/catalog.json` 保存版本化文档；单调 `revision`、payload SHA-256 完整性摘要（检测损坏，**不是**对抗可写文件系统攻击者的认证）、原子 `wx`/`0600`/fsync/rename 提交；重开时用当前 `LoadedConfig.roles` 派生信任并重新校验全部提案与审计 |
| Phase 3 受控应用 | prompt 对象只在提案入口接收一次；精确 before/after、人工 confirm、write-ahead journal、Git 单文件提交、崩溃恢复和回滚链 |
| Phase 4 本地控制面 | session + Origin 边界、服务端固定预检及来源标记、稳定错误码、项目 mutation latch、关闭排空和窄 HTTP API |

### 2.2 延期能力（未实现）

下列能力**尚未实现**，路线图中可能出现，但当前代码与配置不得当作已具备：

| 延期项 | 说明 |
| --- | --- |
| Agent 执行演进 | 无“演进 Agent”工作流阶段，也不自动调用 worker 去实现候选 |
| 候选行为评估 | 当前自动预检只验证结构、信任、对象完整性和 Git 目标安全，不执行候选 |
| UI 集成 | Phase 4 已有窄 HTTP API，React/Tauri 演进工作区在 Phase 5 实现 |
| 网络发布 | 不把候选或晋升结果发布到远程 |
| 秘密存储 | 载荷禁止 token/secret/env 等键；不提供密钥保管 |
| 后台 / 自运行循环 | 无定时或事件驱动的自我演进循环 |
| 自动晋升 | `automaticPromotion` 恒为 false；无无人值守晋升路径 |

## 3. 端到端流程

```text
propose
  -> beginEvaluation / evaluating
  -> evaluate（唯一写入证据并转入 evaluated 的操作；确定性证据强制，advisory 可选）
  -> （推荐）对不可变的 evaluated 快照做 external independent review
  -> explicit human promote 或 reject（promote 复用评估时已记录的证据快照，不能追加新证据）
  -> （仅当前 active）human rollback
```

要点：

1. **至少一条确定性证据（强制）**。仅有 LLM/advisory “approve”、没有确定性条目时，评估不能通过。
2. **推荐的操作顺序是评估后独立审查**。操作员先调用 `evaluate` 生成不可变的 `evaluated` 快照，再让独立审查者检查该快照，最后由人决定 `promote` 或 `reject`。这一步审查在 Phase 1 中是 catalog 外部的人工门禁，不会追加到已冻结的证据中。
3. **若 advisory verdict 必须写入 catalog，则要在 `evaluate` 前收集**。`evaluate` / `evaluateProposal` 是**唯一**绑定证据并转入 `evaluated` 的操作；Phase 1 没有评估后追加证据的 API。`promote` 要求证据与评估快照完全一致，因此不能把评估后的外部审查再塞回该快照。
4. **独立审查是推荐工作流，不是 Phase 1 强制规则**。`computeEvaluationResult` 在**没有** advisory 条目时仍可因确定性全部通过而 `passed: true`；domain **不**校验审查者身份或“独立性”。若提交了 advisory 条目，则其中任一条非 `approve` 会否决通过；晋升守卫同样只拒绝“已存在且未全部 approve”的 advisory 结论。
5. **任一确定性失败否决全部咨询性批准**。确定性失败时 `advisoryPassed` 被置为 `false`，整体 `passed` 为 `false`，LLM/advisory 不能覆盖失败的确定性检查。
6. **晋升复算证据**。`promote` 要求提交的证据与评估时记录完全一致，并再次计算评估结果；不一致或未通过则拒绝。
7. **拒绝不改 active 指针**。只有成功的 `promote` 才会把某候选目标的 active 指到该提案。
8. **回滚只作用于当前 active 的晋升提案**，恢复目标只能来自 catalog 内部保留的 promotion record（`previousActiveProposalId`），不能由调用方伪造。

### 3.1 生命周期状态机

允许的转移（含 guarded）：

| 从 | 到 | 如何进入 |
| --- | --- | --- |
| `proposed` | `evaluating` | `transitionProposal` / `beginEvaluation` |
| `evaluating` | `evaluated` | `evaluateProposal` / `evaluate`（必须有证据） |
| `evaluated` | `promoted` | `promoteProposal` / `promote`（人类决策 + 通过评估） |
| `evaluated` | `rejected` | `rejectProposal` / `reject`（人类决策） |
| `promoted` | `rolled-back` | `rollbackProposal` / `rollback`（人类决策 + 内部 provenance） |

不能用通用 `transitionProposal` 直接跳到 `promoted` / `rejected` / `rolled-back`；这些必须走 guarded API。

## 4. Domain 与 Catalog 边界

### 4.1 Domain 拥有

- 版本化 policy / candidate / evidence / evaluation / human decision / audit record 的 **schema**
- 从项目角色配置构建的 **`EvolutionTrustContext`**
  - `configuredRolePromptPaths`：各角色已配置的 `promptFile`
  - `roleAllowedProfiles`：各角色允许的 profile 名
- **信任校验**：policy 的 `allowedPromptPaths` 必须是已配置 `promptFile` 的子集；role-prompt 候选路径须同时命中 policy allowlist 与信任集合；strategy 的 `roleProfiles` 须角色存在且 profile 被允许
- **摘要**：`computeCandidateDigest`、promotion record digest
- **证据绑定**与评估结果一致性
- **生命周期合法性**与纯函数式 guarded operations（`evaluate` / `promote` / `reject` / `rollback`）
- 路径安全：拒绝绝对路径、遍历、`src/` 等源码前缀、非 Markdown 提示路径等

Domain **不**持有全局索引、不持久化、不碰文件系统、不执行 Agent。

### 4.2 Catalog 拥有

- 提案索引（全局唯一 `proposalId`）
- 审计记录序列（promotion / rejection / rollback）
- 按候选目标划分的 **active 指针**
  - `strategy-blueprint`：按策略名
  - `role-prompt`：按路径
- **内部** `#promotionRecords`：回滚 provenance，调用方不可替换
- **确定性快照** `snapshot()`
- **事务式 `#commit`**：失败原子性；并发/重入突变被拒绝

Catalog 把生命周期与校验**委托**给 domain；自己不做第二套规则。

### 4.3 信任边界一句话

> 信任上下文来自已加载的项目角色配置，而不是候选或 policy 文档的自我声明。

重新解析已保存的提案时仍必须提供 trust context，防止仅靠自声明 allowlist 伪造路径或 profile。

## 5. 候选类型与“只记录、不应用”

### 5.1 `strategy-blueprint`

- 字段：`kind`、`name`、与命名策略行为对齐的 `definition`
- `definition` 可包含：`topology.mode`（`parallel-dag` | `sequential`）、`maxParallel`、`maxReworkAttempts`、`executionTimeoutSeconds`、`maxAgentInvocations`、`maxProcessOutputBytes`、`maxArtifactBytes`、`roleProfiles`、`approvalGates`、`approvalTimeoutSeconds`
- Phase 1：**只把定义记入提案**；不会写入 `agent-team.yaml` 或策略蓝图文件，也不会让 runner 自动选用该候选

### 5.2 `role-prompt`

- 字段：`kind`、`path`（仓库相对 Markdown）、`contentDigest`（小写 64 位十六进制 SHA-256）
- **不存储**提示词正文
- Phase 1：**不读取、不写入、不替换**磁盘上的 `promptFile`

### 5.3 配置中的策略与角色（以本仓库 `agent-team.yaml` 为准）

```yaml
strategies:
  default: balanced
  definitions:
    balanced:
      topology: { mode: parallel-dag }
      maxParallel: 2
      maxReworkAttempts: 1
      executionTimeoutSeconds: 21600
      maxAgentInvocations: 48
      maxProcessOutputBytes: 1048576
      maxArtifactBytes: 2147483648
      approvalGates: [final]
      approvalTimeoutSeconds: 172800
      roleProfiles:
        orchestrator: codex-orchestrator
        architect: codex-architect
        worker: grok-worker
        reviewer: codex-reviewer
        tester: codex-tester
    strict:
      topology: { mode: sequential }
      maxParallel: 1
      maxReworkAttempts: 2
      executionTimeoutSeconds: 43200
      maxAgentInvocations: 72
      maxProcessOutputBytes: 1048576
      maxArtifactBytes: 4294967296
      approvalGates: [plan, final]
      approvalTimeoutSeconds: 172800
      roleProfiles:
        orchestrator: codex-orchestrator
        architect: codex-architect
        worker: grok-worker
        reviewer: codex-reviewer
        tester: codex-tester
```

约束说明：

- `strategies.definitions.*.roleProfiles` 中的每个映射必须被 `roles.<role>.allowedProfiles` 允许。
- `roles.<role>.promptFile` 是**项目拥有**的角色提示入口（本仓库 worker 为 `prompts/grok-worker.md`）。
- 演进 policy 的 `allowedPromptPaths` 还必须是上述已配置 `promptFile` 集合的子集。
- `EvolutionTrustContext` 和 human decision 的 `actor` 由调用方提供。Phase 1 库只校验结构、允许范围与非空标签，不会自动读取 `agent-team.yaml`，也不会认证 `actor` 确实对应某个人；未来集成必须从已加载配置构造 trust，并在边界外完成身份认证与审计绑定。
- 运行时 profile 解析完整链（与现有工作流一致；演进 catalog **不改变**该链）：
  1. 本次运行的 CLI `--profile role=name` 覆盖（写入 `profileOverrides`，覆盖策略映射）；
  2. 策略 `roleProfiles`（进入有效 `profileOverrides` 的基底）；
  3. 架构师在计划任务上选定的 `task.profile`（仅当该角色在有效 overrides 中无映射时回退使用，见 `requestedProfileForRole`）；
  4. 角色 `defaultProfile`。
  因此，若某策略未给 `worker` 配置 `roleProfiles`，且运行未传 CLI 覆盖，则使用任务上的 `task.profile`（若有），否则才是角色默认 profile。所有层级仍须落在 `roles.<role>.allowedProfiles` 内。

## 6. Grok Worker 边界（与演进文档相关）

本仓库默认 worker 使用 `grok-worker` profile 与 `prompts/grok-worker.md`。下列数字来自当前 `agent-team.yaml` 与适配器实现，供维护者对照，**不是**演进 catalog 的运行时配置。

### 6.1 Profile（`agent-team.yaml`）

| 项 | 值 |
| --- | --- |
| adapter | `grok` |
| model | `grok` |
| reasoning | `high` |
| permission | `workspace-write`（仅隔离 Git worktree 内写） |
| externalTools | `deny` |
| maxTurns | **16** |
| timeoutSeconds | **3600**（单次调用） |

### 6.2 适配器强制的管控开关

Grok 适配器在托管调用中会：

- `--no-memory`、`--no-subagents`、`--disable-web-search`
- `externalTools: deny` 时禁用 MCP 发现/调用相关工具，并隔离用户 home 以免加载兼容 MCP
- 工作权限映射为 Grok `workspace` sandbox；工作流仍提供**隔离 worktree**
- 允许的内置工具集合由适配器显式给出（读/搜/改文件/运行终端），而非开放任意插件

### 6.3 Strict 策略预算（控制器，不是 worker 自声明）

| 项 | `strict` 值 |
| --- | --- |
| topology | `sequential` |
| maxParallel | 1 |
| maxReworkAttempts | **2**（首次尝试 + 最多两次返工 = **最多 3 次**任务尝试） |
| executionTimeoutSeconds | 43200 |
| maxAgentInvocations | 72 |
| maxProcessOutputBytes | 1048576（托管 agent / quality / repair 捕获的 stdout、stderr 各自上限；Git 与 doctor 等进程不受该策略字段约束） |
| maxArtifactBytes | 4294967296 |
| approvalGates | `[plan, final]` |
| approvalTimeoutSeconds | 172800 |

### 6.4 Worker 提示词 vs 控制器返工预算

`prompts/grok-worker.md` 要求 worker：

1. 只完成**一个**已分配任务；
2. 只修改任务声明的 `ownedPaths`；
3. 先读实现与测试，再做最小改动；
4. 只跑相关确定性检查；
5. 检查通过后立即停止，不做投机性清理；
6. 若一次纠正后检查仍失败，**停止并把失败证据交给控制器**。

控制器的 `maxReworkAttempts` 是**独立**预算：worker 的“单次纠正后停止”不会消耗或扩展该预算；是否再次派工由确定性门禁、独立 reviewer/tester 与编排策略决定。LLM 不能把失败的 `pnpm test` 说成通过。

## 7. 常用命令示例（经 `src/cli.ts` 核验的语法）

在仓库根目录：

```bash
# 依赖与确定性门禁
pnpm install
pnpm check
pnpm test
pnpm build

# 环境与 CLI 健康检查（默认不调用模型）
agent-team doctor
agent-team doctor --profile grok-worker
agent-team doctor --profile grok-worker --probe-models

# 使用 strict 策略启动一次运行
agent-team run --goal "为分页接口补充边界测试" --strategy strict

# 列出最近运行 / 查看单次运行
agent-team status
agent-team status <run-id>

# 审批（plan 或 final 门）：必须同时给出 request、decision、actor、reason
agent-team approval <run-id> \
  --request <approval-request-id> \
  --decision approved \
  --actor "alice" \
  --reason "计划范围可接受"

agent-team approval <run-id> \
  --request <approval-request-id> \
  --decision rejected \
  --actor "alice" \
  --reason "任务拆分超出声明范围"

# 从已验证检查点恢复中断运行
agent-team resume <run-id> \
  --actor "alice" \
  --reason "控制服务重启后继续"
```

说明：

- `run` 的 `--goal` 为必填；`--strategy` 选择命名策略（如 `strict`）。
- `approval` 的 `--decision` 只能是 `approved` 或 `rejected`。
- `resume` 需要 `--actor` 与 `--reason`。
- `run`、`approval`、`resume` 驱动软件开发工作流。升级恢复另提供离线
  `evolution-reconcile <proposal-id> --mode adopt|apply --actor ... --reason ... --command-id ... --expected-revision ...`；
  必须先停止控制服务。浏览器恢复只允许 exact-match `adopt`，离线 `apply` 才可在旧对象
  缺失时用 `--prompt-file` 提供与候选摘要完全一致的字节。

## 8. 失败原子性与回滚语义

- **校验失败**：domain 抛错，catalog 不提交工作副本 → 提案、审计、active 指针保持原样。
- **多字段更新**：`promote` 同时写提案状态、审计记录、内部 promotion record、active 指针；任一步在提交前失败则全部不生效。
- **非 active 回滚**：若目标上的 active 已指向更新的晋升提案，旧的 `promoted` 提案不能被回滚（避免破坏恢复链）。
- **回滚结果**：active 恢复为 promotion record 中的 `previousActiveProposalId`；若为 `null` 则删除该目标的 active 指针。Phase 1/2 只更新 catalog；Phase 3 必须通过 `EvolutionApplicationCoordinator` 才会同时还原已经应用的 prompt/strategy 目标。Phase 2 下，catalog 自身的磁盘文档会随 mutation 原子更新；rename 前失败时内存与主文件均停留在上一已提交 revision。若 rename 已完成但目录 fsync 失败，则结果属于不确定状态：内存不交换、当前实例拒绝继续写，必须重开并接受完整旧版或新版，绝不猜测覆盖。

## 9. 分阶段路线图

1. **Phase 1 — Domain 与内存 Catalog（已实现）**

   纯 domain 语义 + 同步 `EvolutionCatalog`：生命周期、证据绑定、人工晋升/拒绝/回滚、审计与 active 指针。详见上文与 [ADR 0013](./adr/0013-bounded-evolution-domain-catalog-boundary.md)。

2. **Phase 2 — 持久化与重开（已实现）**

   异步 `DurableEvolutionCatalog` 包装层：仅从 `LoadedConfig.roles` 派生 `EvolutionTrustContext`；要求仓库拥有的相对 `stateDirectory`，逐级拒绝 symlink 并在提交前复核真实路径；在 `stateDirectory/evolution/catalog.json` 写入严格版本化 JSON；保留全部提案、有序审计、promotion provenance 与 active 恢复信息；revision 必须精确等于可重建的 mutation 数 + 确定性 payload SHA-256（检测损坏，非认证）；每次变更经 promise 队列、工作副本 staging、唯一 `wx` 临时文件、mode `0600`、文件 fsync、rename、目录 fsync，成功后才交换内存。rename 前失败不污染已提交状态；rename 后目录 fsync 失败会封闭实例并要求重开。重开对畸形 JSON、不支持版本、摘要不匹配、伪造 allowlist/profile、不可能的生命周期/晋升链、无效 active、重复 ID、陈旧 revision **fail closed**。孤儿临时文件可忽略或安全清理，但**绝不能**把损坏的主文件当作空 catalog。详见 [ADR 0014](./adr/0014-durable-evolution-catalog.md)。

   Phase 2 **不改变** Phase 1 domain 语义，也不应用文件、不提供 HTTP/UI、不执行 Agent、不自动评估或自动晋升。

3. **Phase 3 — 受控应用（已实现，库内 API）**

   `EvolutionApplicationCoordinator` 是 catalog mutation 的唯一 facade。它提供不可变、限时的预览 token；命令使用 `commandId + expectedRevision + token + operator + reason`，并持久化幂等响应。role-prompt 内容只在提案入口以字节形式接收一次，严格校验 UTF-8、256 KiB 上限和 SHA-256 后保存为本地不可变对象；apply/rollback 不接收内容或路径。提示词只能修改已经配置、存在且由 Git 跟踪的 Markdown `promptFile`，写入后生成只包含该文件的前向提交并保留原权限；策略只能条件式修改自定义蓝图，不能改配置内置策略。

   `application-state.json` 使用严格 version/revision/payload digest、pending write-ahead journal、completed 审计和 command binding。启动恢复同时验证 target、catalog audit/active pointer 和 prompt Git 提交；不能证明的组合一律 `RECOVERY_REQUIRED`。提示词对象仅用于本地恢复，**提示词文件不得包含秘密**。详见 [ADR 0015](./adr/0015-controlled-evolution-application.md)。

4. **Phase 4 — 本地控制面与服务端预检（已实现）**

   项目 runtime 在跨进程 control lease 内统一持有 catalog、application coordinator、
   supervisor 和 `EvolutionProjectService`。HTTP 读写均要求本地会话，mutation 还校验实际
   loopback Origin。浏览器只能提交策略名称/定义或角色/提示词内容；ID、policy、路径、摘要、
   证据、操作者和时间均由服务端生成。`evaluate` 使用固定版本的服务端结构/安全预检，
   严格绑定 proposal/candidate，并持久化 `server-structural-preflight-v1` 来源；旧 external
   evidence 不能冒充，且不能选择历史 run。通过不代表候选已执行。晋升/回滚必须
   preview + confirm，并与 Agent run/审批/策略直改互斥；关闭前会排空在途操作。详见
   [ADR 0016](./adr/0016-evolution-control-plane.md)。

5. **Phase 5 — React/Tauri 可视化演进工作台（未实现）**

   在现有工作台增加“演进”工作区，提供候选列表、状态筛选、结构预检、精确 before/after
   对比、理由确认与回滚操作。更强隔离下的候选行为评估、半自动建议、网络发布和秘密存储
   继续延期；自动晋升仍禁止。

## 10. 维护者快速核对清单

- [ ] 是否只修改了文档声明路径，而没有“顺手”改 `src/` 冒充已应用候选？
- [ ] 文档中的 Grok / strict 数字是否仍与 `agent-team.yaml` 一致？
- [ ] 是否只有 Phase 3 coordinator 在改 prompt/strategy，而没有绕过 journal 直接调用 catalog promote？
- [ ] 是否声称 LLM 批准可以覆盖失败的确定性命令？（不可以）
- [ ] ADR 0013 与本文对 domain/catalog 边界的描述是否一致？
- [ ] ADR 0014 对持久化合同（信任边界、revision、digest 威胁模型、原子提交、fail-closed 重开）的描述是否与实现一致？
- [ ] 是否把 Phase 2 的“可重开持久化”和 Phase 3 的“受控应用证明”混为一谈？

## 11. 相关文档

- [系统架构](./architecture.md) — 控制面 / 执行面与演进模块挂载点
- [安全模型](./security.md) — 不信任 Agent 输出、确定性否决、Grok 托管限制
- [配置说明](./configuration.md) — profile、角色、`promptFile`、命名策略
- [策略蓝图](./strategy-blueprints.md) — 工作台自定义策略（与演进候选不同源）
- [ADR 0012 Grok Worker](./adr/0012-grok-headless-worker-adapter.md)
- [ADR 0013 Domain/Catalog 边界](./adr/0013-bounded-evolution-domain-catalog-boundary.md)
- [ADR 0014 持久化演进 Catalog](./adr/0014-durable-evolution-catalog.md)
- [ADR 0015 受控演进应用](./adr/0015-controlled-evolution-application.md)
- [ADR 0016 本地演进控制面](./adr/0016-evolution-control-plane.md)
