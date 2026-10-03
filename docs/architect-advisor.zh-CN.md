# Architect 按需介入（Advisor）

- 文档状态：已实现（`taskMorphology.advisor`，默认关闭）
- 灵感来源：Codex Agent Tree 的"Astra 按需出场"模式——强模型持续写代码，架构师只在关键时刻被召唤，只读、不写代码。

## 1. 要解决的问题

此前 architect 只在规划阶段出场一次。Worker 反复犯同一个错时，控制面只会带着反馈
盲目重试；交付前也没有独立的"漏了什么"检查。

## 2. 触发点

| 触发点 | 条件 | 顾问输入 | 结果去向 |
| --- | --- | --- | --- |
| 规划前 | 已有 architecture 阶段 | 目标、探索摘要 | 任务 DAG（不变） |
| `repeated-failure` | 同一任务连续两次尝试的失败签名相同 | 任务、失败反馈、staged diff | 注入下一轮 worker 的 `architectAdvice`；`stop` 直接让该任务 blocked |
| `pre-final` | 集成质量门禁通过后、终裁之前 | 目标、任务摘要、diff 统计、最终质量结果 | 注入终裁的 `preFinalAdvice` |

## 3. 确定性分叉：失败签名

`src/workflow/failure-signature.ts` 把一次失败归一化成稳定指纹：

- 失败命令（命令行、退出码或超时、stderr/stdout 末尾）；
- reviewer 的必改发现、tester 的缺失测试；
- 没有门禁输出时退回错误信息。

归一化会抹掉时间戳、UUID、临时目录、worktree 路径、行号和数字，因此"同一原因"
在不同尝试里得到同一签名。这是视频里"分叉层"在代码里的确定性对应：该重试还是该升级，
由代码决定，不消耗模型调用。它不是概率模型，不输出置信度。

## 4. 边界

- 只读：复用 architect 角色及其 profile 链，不新增角色，权限校验不变。
- 不能放行失败：确定性命令失败时，顾问意见不改变结论；终裁提示词也要求以真实命令结果为准。
- 有界：`maxConsultationsPerRun`（默认 3，上限 10）按 run 计数并持久化，resume 不重置；
  顾问调用同样占用 `maxAgentInvocations`。
- fail-open：顾问调用失败只记录 `run.advisor.failed`；预算耗尽和中止不会被吞掉。
- `pre-final` 仅在集成质量门禁通过时才会调用，失败时不浪费预算。
- `repeated-failure` 需要 `maxReworkAttempts >= 2`（第一次失败后重试一次，第二次仍同样失败才有"重复"）。

## 5. 事件

`run.advisor.consulted`（trigger、taskId、profile、recommendation、summary、used、limit）、
`run.advisor.skipped`（达到次数上限）、`run.advisor.failed`;启用 Jev 后另有 `run.jev.decided`。

## 6. Jev 本地分流模型(可选)

对应视频里的 fork 层:一个本地小模型做"重试还是升级"这类廉价决策。通过顶层 `jev` 配置接入,默认关闭。

```yaml
jev:
  enabled: true
  baseUrl: http://127.0.0.1:9931/v1   # 必须是回环地址(localhost / 127.x / ::1),失败日志和 diff 不出本机
  model: jev                          # 对编排器不透明,由本地服务校验
  timeoutMs: 3000                     # 超时即回退
  minConfidence: 0.8                  # 低于此自报置信度即回退
```

- 协议:OpenAI 兼容 `POST {baseUrl}/chat/completions`,`temperature: 0`,`response_format: json_object`,
  期望输出 `{"decision":"retry"|"consult","confidence":0..1,"reason":"..."}`。不保存任何密钥。
- 触发时机:每次任务失败、准备下一次尝试之前,且顾问已启用 `repeated-failure` 触发、次数未用完时才询问 Jev。
- 作用(仅建议,只能提前不能跳过):置信度达标时,`consult` 让顾问提前于"同一错误重复"出场;
  `retry` 只表示"没有提前的理由",不会跳过确定性规则已经要求的咨询(同一错误重复时顾问照常出场)。
  无响应、超时、格式不合法、置信度不足一律按原确定性规则处理。Jev 不能阻塞任务,也不能放行任何失败检查。
  这样设计是因为实测零点样本的 Laya 对重复的设计级失败也会高置信度选 `retry`。
- 置信度是模型自报,不是 logprobs;因此只用于分流,不用于验收。
- 设置页:项目设置底部有"Jev 本地分流模型"面板,显示状态(未配置 / 已配置未启用 / 已启用)与当前配置,
  「测试连接」调用 `POST /api/projects/:id/jev/probe`,用一条模拟失败请求模型并报告耗时、决策,或失败原因
  (HTTP 状态、超时、输出不是合法 JSON)。配置本身仍在 `agent-team.yaml` 里改,界面不写 yaml。
- 事件 `run.jev.decided`(decision、confidence、source=`jev`|`deterministic`、consult、changedOutcome、latencyMs),
  UI 在"架构顾问"记录里显示为"Jev 分流"。

## 7. 没有照搬的部分

- Jev 目前只接管"重试还是升级"一个分叉;选文件、选工具、选 worker profile 暂未交给它。
- 模型分层（explorer 与 researcher 用便宜模型，worker 用强模型）继续通过 profile 与角色绑定配置，
  编排器不写死模型名。
