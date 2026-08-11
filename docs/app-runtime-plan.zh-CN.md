# 一体化 App 与 Android 运行时方案

## 目标

最终产品只暴露一个 Agent Team App。用户不需要手工打开终端、启动 Node 服务或记忆
端口。React 工作台、策略控制面、Git 隔离、Agent CLI 调用和本地证据仍保持清晰边界，
以便桌面端、Android 端和自动化客户端复用。

## 总体结构

```text
React 工作台
   │ 统一控制 API 与事件流
Agent Team 控制面
   ├─ 策略编译、DAG 调度、审批、恢复、证据
   ├─ Git / worktree / 状态与事件账本
   └─ ExecutionBackend
       ├─ DesktopSidecar
       ├─ AndroidTermuxIntent
       └─ AndroidEmbeddedRuntime
```

前端不能直接拼接或执行 shell 命令。所有 Agent 启动、停止、权限、超时、日志和制品
都经过控制面，再由平台运行后端执行。这样平台差异不会进入策略和 DAG 核心。

## 桌面端

桌面端采用 React + Tauri/Rust 壳。安装包内包含静态工作台和 `agent-team` sidecar：

1. App 启动时选择空闲本地端口，拉起 sidecar 并等待健康检查。
2. WebView 只连接本 App 启动的控制服务；随机会话凭据通过启动参数注入。
3. App 统一显示 CLI 安装、登录和模型能力检查，不要求用户查看后台终端。
4. App 退出时先阻止新运行，再按现有 supervisor 规则终止或标记中断，最后关闭 sidecar。
5. Codex、Claude 等 CLI 初期仍作为独立工具安装和登录，后续再评估受许可约束的捆绑。

客户侧的首次启动流程固定为：选择代码项目，App 自动识别配置并打开工作台。如果项目
还没有 `agent-team.yaml`，页面只提供“初始化并打开”这一条主要修复动作。端口、Node、
sidecar、配置路径和进程日志不进入正常操作流程，仅在“技术详情”中按需显示。成功打开过
的项目会被记住，下次启动自动恢复。

保留 HTTP/SSE 控制协议而不改成前端直调 Rust，是为了让桌面壳、浏览器和测试夹具共用
同一契约。生产打包可用 loopback + 随机会话令牌，或由 Tauri 转发到私有 IPC。

## Android 端

Android 分两步实现，共用同一个 `ExecutionBackend` 接口：

### Termux Intent 适配

首个可用版本通过 Termux 官方 `RUN_COMMAND` Intent 启动命令并接收结果。优点是可以
快速验证 Git、Node、Agent CLI、长任务和文件权限；缺点是用户需要单独安装并初始化
Termux。控制面仍在 Agent Team App 中，Termux 只充当进程执行环境。

### 内嵌运行时

验证完成后，再评估把 Termux bootstrap、终端引擎和必要包放入同一个 APK。此阶段要
处理 ABI、包更新、可执行文件位置、Android 后台进程限制、存储迁移、签名和崩溃恢复。
终端页面只是可选诊断工具，不是编排入口。

Termux 主仓库采用 GPLv3-only。若分发包含其派生代码的 App，需要按 GPLv3 提供对应
源码、许可证和版权信息。`terminal-view`、`terminal-emulator` 及部分通用工具存在
Apache-2.0 或 MIT 例外，实际集成时必须按采用的具体文件逐项保留许可声明。

## 阶段

1. 完成本地控制面：策略、审批、恢复、交付证据、历史保留和审计测试。
2. 建立 Tauri 桌面壳，自动管理 sidecar 生命周期和会话认证。
3. 增加 `AndroidTermuxIntent`，在真实设备验证完整 Agent 工作流。
4. 根据体积、稳定性和维护成本决定是否实现 `AndroidEmbeddedRuntime`。

当前仓库已完成第 1 阶段和第 2 阶段，包括 macOS arm64 实机基线、Windows x64 与
macOS arm64/x64 的 PR 自动打包、sidecar 生命周期和会话认证。每个同仓库 PR commit
创建唯一的 unsigned GitHub Pre-release；fork PR 只生成无写权限的 Actions artifacts。
当前不配置 Windows/macOS 签名和公证，系统可能显示未知开发者提示。后续阶段不能绕过
现有权限、质量门禁、Git 检查点和证据契约。桌面壳的具体边界见
[ADR 0011](adr/0011-desktop-shell-and-runtime-lifecycle.md)。
