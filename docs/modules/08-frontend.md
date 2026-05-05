# Frontend — Next.js Web

## 功能

- 单页工作台：左中右多窗格（pane）布局，每个 pane 一个 Feat（功能单元）。
- Feat 支持 normal / minimized / fullscreen / overlay 状态切换并持久化。

## 实现

| 部分 | 位置 | 说明 |
| ---- | ---- | ---- |
| App router | `apps/web/app/(app)/page.tsx` → `<EqtyModule />` | 单一入口 |
| Shell | `apps/web/components/shell/` | 整体布局 + pane 容器 |
| Feat 注册表 | `apps/web/lib/eqty/feat.ts` | `Feat` enum：`SYS.STAT`、`EQ.CHART`、`SCR.NL` 等 |
| Feat 框架 | `apps/web/components/feat-view/` | `<FeatView>` pane chrome、状态持久化、唯一允许跨 Feat 共享的 pane 原语 |
| 各 Feat | `apps/web/components/feat-<module>-<feature>/` | kebab-case 目录，主组件同名 |
| 类型 | `apps/web/lib/types/` | 视图模型（核心资产，禁 IO） |
| 纯函数 | `apps/web/lib/fp/` | formatter / selector |
| API client | `apps/web/lib/api/`（或共享 SDK） | 调 NestJS（HTTP/JSON） |
| 状态 | Zustand（轻量）+ TanStack Query（服务端数据） | |
| 图表 | `lightweight-charts` | K 线 + 形态叠加 |
| 长列表 | `@tanstack/react-virtual` | **任何 N 行列表必须虚拟化**（CLAUDE.md 内存指引） |

## Feat 列表

| Feat | 目录 | 功能 |
| ---- | ---- | ---- |
| `SYS.STAT` | feat-sys-stat | 队列 / 缓存健康 |
| `SYS.CFG` | feat-sys-cfg | 配置面板 |
| `SYS.PUSH` | feat-sys-push | 通知设置 |
| `SEC.LIST` | feat-sec-list | 全市场股票搜索 |
| `EQ.LIST` | feat-eq-list | 当前选股清单 |
| `EQ.CHART` | feat-eq-chart | K 线图 |
| `SCR.NL` | feat-scr-nl | 自然语言筛选 |
| `SCR.PAT` | feat-scr-pat | 形态筛选 |
| `WATCH.LIVE` | feat-watch-live | 自选盯盘实时 |
| `AI.OUT` | feat-ai-out | 舆情 / 分析输出 |
| `AI.MD` | feat-ai-md | markdown 渲染容器 |
| `AI.HIST` | feat-ai-hist | 历史会话 |

## Feat 强制规约

- 所有 Feat 根节点 **必须** `<FeatView feat={Feat.X}>` 包裹；裸 DOM 拒收。
- Feat 之间不互相 import 私有子组件；要复用就抽到 `packages/ui/` 或 `apps/web/lib/`。
- 业务逻辑禁止写在组件里 → `lib/`。

## 缓存策略

- 服务端数据：TanStack Query（默认 30s stale，错误退避）。
- 本地偏好（pane 状态、上次输入）：`idb`（IndexedDB），key 按 Feat 命名空间隔离。
- 无 service worker / 无离线模式（v1）。
