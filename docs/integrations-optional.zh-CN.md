# 可选外部集成（不内嵌第二套运行时）

本文说明「更合理做法」：用**外挂 CLI / 现有质量命令**补能力，而不是把 OpenRSI 搜索图或 OCR 规则引擎搬进本仓库。

## 1. 经验闭环（本仓库已实现）

| 能力 | 作用 |
| --- | --- |
| 候选 → 已验证 → 公共库 | 跨项目可复用，默认不注入 candidate |
| 规划注入 | 总控/架构带 `verifiedExperiences` + `strategyHints` |
| 返工注入 | worker 第 2 次起带失败经验 + `recentAttempts` |
| Attempt 卡 | `.agent-team/experience/attempts.jsonl` |
| 成功回写 | 返工后任务通过时增加经验 `successCount` |
| 评测自动晋升 | `autoPromoteWithSuite` 对低敏成功/评测候选挂 suite digest 并晋升 |

配置见 `agent-team.example.yaml` 的 `experience` 段。

## 2. 阿里 Open Code Review（推荐外挂，不内嵌）

[alibaba/open-code-review](https://github.com/alibaba/open-code-review) 是**代码评审专用**工具：确定性文件筛选 + 规则匹配 + 行级评论。  
本产品已有 reviewer 角色与质量命令 veto；**不要**在控制面重写 OCR 规则引擎或行级 UI。

### 推荐用法：当一条 quality 命令

```bash
npm i -g @alibaba-group/open-code-review
ocr config provider   # 配置模型
```

在 `agent-team.yaml`：

```yaml
quality:
  commands:
    - command: pnpm
      args: [check]
    - command: ocr
      args: [review]
```

行为：

- 与 `pnpm test` 一样：非 0 退出码 → 任务/终检失败，可触发返工  
- 日志与退出码进入 run 证据目录  
- `agent-team doctor` 会检查 `ocr` 是否在 PATH；缺失时给出安装提示  

未安装时**不要**把 `ocr` 写进 commands，否则质量门会红。

### 不推荐

- 在本仓库实现 OCR 规则库 / 行级评论面板  
- 与 reviewer LLM 双轨并行且无优先级（用户分不清谁说了算）  

若同时使用 LLM reviewer 与 OCR：把 OCR 当**确定性门**，LLM 当**补充意见**（现有架构已支持：命令失败可 veto 模型通过）。

## 3. OpenRSI 完整搜索记忆

不内嵌 island/crossover 种群搜索。本仓库只保留：

- attempt 签名与同类失败检索  
- 已验证经验 + 策略提示  

完整 OpenRSI 适合 MLE 长程刷分，不是 Git 交付控制面的主路径。

## 4. 检查清单

```bash
agent-team doctor          # 含 quality 命令 PATH 检查
agent-team validate
# 可选
which ocr && ocr review    # 工作区有变更时
```
