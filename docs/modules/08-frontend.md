# Frontend — Next.js Web

## 功能

- 单页工作台：左中右多窗格（pane）布局，每个 pane 一个 Feat（功能单元）。
- Feat 支持 normal / minimized / fullscreen / overlay 状态切换并持久化。
- `TERM.MAIN` 提供 CRT 风键盘命令终端，作为读写工作台的主输入入口。

## 实现

| 部分        | 位置                                                                      | 说明                                                                   |
| ----------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| App router  | `apps/web/app/(app)/page.tsx` → `<EqtyModule />`                          | 单一入口                                                               |
| Shell       | `apps/web/components/shell/`                                              | 整体布局 + pane 容器                                                   |
| Feat 注册表 | `apps/web/lib/eqty/feat.ts`                                               | `Feat` 常量：`MODULE.FEATURE` 字面量联合                               |
| Feat 框架   | `apps/web/components/feat-view/`                                          | `<FeatView>` pane chrome、状态持久化、唯一允许跨 Feat 共享的 pane 原语 |
| 各 Feat     | `apps/web/components/feat-<module>-<feature>/`                            | kebab-case 目录，主组件同名                                            |
| 类型        | `apps/web/lib/types/`                                                     | 视图模型（核心资产，禁 IO）                                            |
| 纯函数      | `apps/web/lib/fp/`                                                        | formatter / selector                                                   |
| 终端宿主    | `apps/web/components/feat-term-main/`                                     | xterm.js 桥接 `@quant/terminal` 引擎                                   |
| Live runner | `apps/web/lib/term/{live-runner,revalidate,projectors,install-runner}.ts` | 终端动作 → `/api/*` + 跨缓存失效                                       |
| API client  | `apps/web/lib/endpoints.ts`                                               | 调 NestJS（HTTP/JSON）                                                 |
| 状态        | Zustand（轻量）+ TanStack Query（服务端数据）                             |                                                                        |
| 图表        | `lightweight-charts`（可复用 `<ChartCanvas>`，commit 11c6994）            | K 线图 + 形态叠加                                                      |
| 长列表      | `@tanstack/react-virtual`                                                 | **任何 N 行列表必须虚拟化**（CLAUDE.md 内存指引）                      |

## Feat 列表

| Feat         | 目录            | 功能                                               |
| ------------ | --------------- | -------------------------------------------------- |
| `SYS.STAT`   | feat-sys-stat   | 队列 / 缓存健康                                    |
| `SYS.CFG`    | feat-sys-cfg    | 设置面板（dark mode / Slack webhook / 板块持久化） |
| `SEC.LIST`   | feat-sec-list   | 板块（sector）管理；新增 / 删除 / 刷新动态板块     |
| `EQ.LIST`    | feat-eq-list    | 当前候选股清单（动态列、可排序）；dynamic sector 头部带 last-screened 时间 + 刷新按钮（`POST /api/sectors/:id/refresh`）|
| `EQ.CHART`   | feat-eq-chart   | K 线图                                             |
| `SCR.NL`     | feat-scr-nl     | 自然语言筛选（NL → DSL）                           |
| `SCR.DSL`    | feat-scr-dsl    | DSL 编辑器 + 直接执行                              |
| `SCR.PAT`    | feat-scr-pat    | 形态筛选（带内嵌 50D 相似形态行）                  |
| `WATCH.LIVE` | feat-watch-live | 自选盯盘实时（多选；条件含 vwap / trend baseline）  |
| `AI.OUT`     | feat-ai-out     | 单股 LLM 输出（cache + paid 双路）                 |
| `AI.HIST`    | feat-ai-hist    | 板块层市场快照                                     |
| `AI.MD`      | feat-ai-md      | markdown 渲染容器（supplies AI.OUT / AI.HIST）     |
| `TERM.MAIN`  | feat-term-main  | CRT 风命令终端（详见 `10-terminal.md`）            |

> 历史 `SYS.PUSH` 已并入 `SYS.CFG`（commit 8273327），不再单独存在。`SYS.CFG` 的"blacklist"分区已在 2026-05 移除——A 股噪音黑名单改由后端 cron 维护，详见 `12-blacklist.md`。

## Feat 强制规约

- 所有 Feat 根节点 **必须** `<FeatView feat={Feat.X}>` 包裹；裸 DOM 拒收。
- Feat 之间不互相 import 私有子组件；要复用就抽到 `packages/ui/`、`apps/web/lib/`，或（图表类）抽到 `apps/web/components/chart-canvas/` 这类共用组件。
- 业务逻辑禁止写在组件里 → `lib/`。
- 导航与表头按钮统一走 `MonoButton` + 图标注册表（commit e8542dc），禁止重复造 chrome。

## 缓存策略

- 服务端数据：TanStack Query（默认 30s stale，错误退避）。
- 本地偏好（pane 状态、上次输入）：`idb`（IndexedDB），key 按 Feat 命名空间隔离。
- 终端 LiveActionRunner 的写动作触发 `REVALIDATE_AFTER` 表 → react-query queryKey 失效 + zustand 拉取。
- 无 service worker / 无离线模式（v1）。
