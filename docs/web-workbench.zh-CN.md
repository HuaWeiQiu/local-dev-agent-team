# Web 工作台开发指南

面向修改 `web/src` 的开发者。控制台是 React + Vite 单页应用，通过 HTTP 和 SSE 访问本地控制服务；它只展示服务端状态，不持有认证令牌，也不能绕过确定性检查。

## 目录

| 位置 | 内容 |
| --- | --- |
| `App.tsx` | 顶栏、工作台模式切换；演进、经验、设置、策略编排通过 `React.lazy` 按需加载 |
| `hooks/useRunEvents.ts` | 运行列表、详情、SSE 订阅；事件先进缓冲，约 120 ms 批量 flush |
| `hooks/useRunActions.ts` | 暂停、取消、重试、审批、清理等操作 |
| `components/RunDashboard.tsx` | 运行监控区装配：运行列表、状态条、审批卡片、四个视图面板、任务详情 |
| `components/RunLiveBar.tsx` | 活跃运行的一行状态：阶段、正在工作的角色、任务/调用/顾问预算、已运行时间 |
| `components/ApprovalCard.tsx` | 待处理人工门禁的内联提示；决定本身仍在 `RunActionDialog` 中完成并留痕 |
| `components/EventConsole.tsx` | 角色、活动、输出三个页签 |
| `components/EmptyState.tsx`、`PanelHeader.tsx` | 统一的空状态与设置面板头，新增面板优先复用 |
| `styles.css` + `styles/*.css` | 入口只含 `@import`，按功能拆分 |

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

- 颜色、阴影、圆角、字阶只用 `theme.css` 里的令牌，不写硬编码色值，也不写令牌回退值。
- `styles.css` 的导入顺序就是层叠顺序。`responsive.css` 的移动端覆盖要晚于它覆盖的组件样式；目前 `experience.css` 和 `run-status.css` 排在它之后，如果新样式需要被移动端规则覆盖，应放在 `responsive.css` 之前。
- 活跃运行区使用三行网格：头部、`.run-attention`（状态条和审批卡片，空时高度为 0）、面板。面板通过 `grid-row: 3` 固定位置。

## 测试

```bash
pnpm check        # 服务端和前端类型检查
pnpm lint         # ESLint，--max-warnings 0
pnpm test         # Vitest（含 jsdom 组件测试）
pnpm exec playwright test --config web/playwright.config.ts --project=desktop
```

- 纯逻辑测试放在 `test/*.test.ts`。
- 组件测试放在 `test/web/*.test.tsx`，文件首行写 `// @vitest-environment jsdom`，并导入 `./dom-setup.js`（注册 jest-dom 断言并在每个用例后清理）。共用夹具在 `test/support/web-fixtures.ts`。
- 端到端用例在 `web/e2e/`，用 Playwright 打开真实构建，覆盖启动、主题、取消/重试、导出、演进工作台。

## 尚未做的事

- 界面文案仍然硬编码为中文，没有消息目录；只有一种语言时拆出目录收益有限，需要第二种语言时再统一迁移。
- 没有截图回归。字体和系统渲染差异会让基线在不同机器上抖动，建议先固定到 CI 容器再引入。
