# Web 工作台开发指南

面向修改 `web/src` 的开发者。控制台是 React + Vite 单页应用，通过 HTTP 和 SSE 访问本地控制服务；它只展示服务端状态，不持有认证令牌，也不能绕过确定性检查。

## 目录

| 位置 | 内容 |
| --- | --- |
| `App.tsx` | 外壳装配：侧栏、顶栏、工作区切换、命令面板；演进、经验、设置、策略编排通过 `React.lazy` 按需加载 |
| `shell/` | `Sidebar`（窄屏为抽屉）、`TopBar`、`CommandPalette`（⌘K）、`RunActions` |
| `ui/` | 组件工具包：`Button`、`Badge`、`Modal`、`Tabs`、`Tooltip`、`Toggle`、`Input/Select/Textarea/Field/Callout`、`StatusDot`、`cn` |
| `components/BoardPage.tsx` | 首页看板：由事实推导的泳道（需要你 / 执行中 / 已结束），推导逻辑在 `board.ts` |
| `components/RunPage.tsx` | 运行页：头部、阶段进度条（`stages.ts`）、概览 / 任务图 / 详情 / 活动日志 / 交付证据 / 用量 |
| `components/run/`、`strategy/`、`evolution/`、`experience/` | 各工作区拆出的子组件 |
| `hooks/useRunEvents.ts` | 运行列表、详情、SSE 订阅；事件先进缓冲，约 120 ms 批量 flush |
| `hooks/useRunActions.ts` | 暂停、取消、重试、审批、清理等操作 |
| `demo/` | `?demo=1` 演示模式：在 React 渲染前替换 `fetch` 和 `EventSource`，用种子数据覆盖执行中、待审批、失败、完成等状态，无需控制服务 |
| `styles.css` + `styles/*.css` | 只剩浏览器基线（`base.css`，在 `base` 层）、xyflow 皮肤、少量策略画布窄屏微调和减弱动效 |

## 状态派生都是纯函数

组件不直接解析事件载荷。`web/src` 下这些模块输入事件或运行状态，输出展示数据，都在 `test/` 里有普通 Vitest 测试：

- `agent-activity.ts`：角色调用分组、顾问日志。
- `timeline.ts`：把 `run.history` 与带类型的事件合并为带「角色 / 顾问 / 流程 / 审批 / 异常」分类的时间线，最新在前。
- `live-status.ts`：状态条数据；`formatElapsed`。
- `output-log.ts`：输出日志只保留最新 200 000 字符，并记录被省略的事件数。
- `event-merge.ts`：SSE 事件按 `sequence` 去重、排序。重连重放与实时尾部可能重叠，所以必须经过它。
- `presentation.ts`：状态和角色的中文标签、错误文案的集中位置。

新增事件类型时，先在 `timeline.ts` 的 `fromEvent` 里加映射并补测试，再决定是否在 UI 里单独展示。事件载荷字段以服务端发出处为准（例如 `approval.responded` 的 `decision` 是 `approved` 或 `rejected`）。

## 样式

- 新代码一律用 Tailwind v4 工具类加 `ui/` 工具包。语义颜色（`bg-surface`、`text-ink`、`text-muted`、`bg-accent` 等）在 `ui/tailwind.css` 里映射到 `theme.css` 的令牌，深色主题自动生效；不要写硬编码色值。
- 没有启用 Tailwind 的 preflight：边框用 `bd`、`bd-t`、`bd-b` 等自定义工具类，不要用 `border`。焦点环用 `focus-ring`，细滚动条用 `scroll-thin`。
- 层叠规则：未分层的 CSS 永远压过分层的 Tailwind 工具类。所以全局基线放在 `@layer base` 里；保留作 e2e 钩子的类名（如 `.strategy-stage-node`）不能再有会覆盖工具类的旧规则。
- 绝对定位的 `sr-only` 元素放在 `overflow-x-auto` 容器里时，容器需要 `relative`，否则它会撑开整页，窄屏出现横向滚动。
- 弹窗统一用 `ui/dialog.tsx` 的 `Modal`：给初始焦点字段加 `data-autofocus`，提交中传 `locked`，提交按钮放进 `footer` 并用 `form="..."` 关联表单。
- 清理未使用的旧样式：对照 `web/src` 与 `web/e2e` 中的类名出现情况删除，每次删除后跑 e2e。

## 演示模式

`pnpm dev:web` 后打开 `http://127.0.0.1:5173/?demo=1`，不需要启动控制服务就能看到完整界面。演示数据在 `demo/seed.ts`，接口模拟在 `demo/server.ts`；新增 API 时同步在模拟层补一条，`web/e2e/demo-pages.e2e.ts` 会遍历所有工作区并检查控制台错误和横向溢出。

## 测试

```bash
pnpm check        # 服务端和前端类型检查
pnpm lint         # ESLint，--max-warnings 0
pnpm test         # Vitest（含 jsdom 组件测试）
pnpm exec playwright test --config web/playwright.config.ts --project=desktop
```

- 纯逻辑测试放在 `test/*.test.ts`。
- 组件测试放在 `test/web/*.test.tsx`，文件首行写 `// @vitest-environment jsdom`，并导入 `./dom-setup.js`（注册 jest-dom 断言并在每个用例后清理）。共用夹具在 `test/support/web-fixtures.ts`。
- 端到端用例在 `web/e2e/`，用 Playwright 打开真实构建，覆盖启动、主题、取消/重试、导出、演进工作台和演示模式的全页面冒烟。运行前先 `pnpm build`：夹具服务器提供的是 `web/dist`。视口为桌面 1440×960 与手机 390×844。

## 尚未做的事

- 界面文案仍然硬编码为中文，没有消息目录；只有一种语言时拆出目录收益有限，需要第二种语言时再统一迁移。
- 没有截图回归。字体和系统渲染差异会让基线在不同机器上抖动，建议先固定到 CI 容器再引入。
- Tauri 桌面端在 Linux 上的中日韩字体渲染，以及 Tailwind v4 在较旧 WebKitGTK 上的兼容性，尚未验证。
