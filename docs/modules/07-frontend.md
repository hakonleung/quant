# 模块 07 — 前端（frontend）

## 1. 职责

Next.js App Router 前端，提供筛选、形态、分析、详情四大主流程的用户交互。

## 2. 页面结构

```
app/
├── (app)/
│   ├── layout.tsx                # 主布局（导航）—— v1 不做用户菜单
│   ├── page.tsx                  # 工作台首页（最近筛选/任务）
│   ├── screen/
│   │   └── page.tsx              # 筛选页
│   ├── pattern/
│   │   └── page.tsx              # 形态拟合页
│   ├── sentiment/
│   │   └── [taskId]/
│   │       └── page.tsx          # 分析页（按任务查看）
│   ├── stocks/
│   │   └── [code]/
│   │       └── page.tsx          # 股票详情
│   └── admin/
│       └── data/                 # 数据更新状态、死信、配置
└── api/                          # 仅前端 BFF；业务 API 在 NestJS
```

## 3. 关键组件

| 组件                  | 文件                                 | 说明                             |
| --------------------- | ------------------------------------ | -------------------------------- |
| `<NLDslEditor>`       | `components/nl-dsl-editor.tsx`       | 自然语言 ↔ DSL JSON 双向编辑     |
| `<ScreenResultTable>` | `components/screen-result-table.tsx` | 命中股票表 + 命中证据展开        |
| `<KlineChart>`        | `components/kline-chart.tsx`         | 基于 lightweight-charts，叠加 MA |
| `<PatternMatchList>`  | `components/pattern-match-list.tsx`  | 形态匹配结果，缩略图 + 距离      |
| `<MarketViewPanel>`   | `components/market-view-panel.tsx`   | 三层洞察展示                     |
| `<ProgressStream>`    | `components/progress-stream.tsx`     | SSE 进度条，复用所有长任务       |
| `<EvidenceLink>`      | `components/evidence-link.tsx`       | 显示原文引用 + 跳转              |

所有组件：

- 业务逻辑下沉到 `lib/fp/` 纯函数
- 数据契约用 `packages/shared/types/` 的 zod schema
- 不直接 fetch；通过 `api-client/` 的 typed client

## 4. 数据获取

### 4.1 服务端组件（默认）

- 用 `fetch(..., { next: { revalidate: 60 }})` 调 NestJS
- 适合：股票详情、首页静态内容

### 4.2 客户端组件

- `@tanstack/react-query`：列表、表格、筛选
- 长任务：`useEventSource` + react-query 的 `setQueryData` 推送增量

### 4.3 typed client 生成

- 由 `proto/codegen` 从 OpenAPI（NestJS 自动生成）→ 生成 TS client + zod schema
- 禁止手写 fetch；所有 API 调用走生成的 client

## 5. 状态管理

| 状态种类                           | 工具                           |
| ---------------------------------- | ------------------------------ |
| 服务端数据缓存                     | react-query                    |
| 表单状态                           | react-hook-form + zod resolver |
| UI 局部状态（modal、tab）          | 组件内 `useState`              |
| 跨组件 UI 状态（侧边栏开关、主题） | Zustand                        |
| URL 状态（筛选参数、排序）         | `useSearchParams`              |

**禁止**：把服务端数据放进 Zustand。服务端数据的"单一事实"是 react-query 的 cache。

## 6. 风格与可访问性

- Tailwind CSS + shadcn/ui 基础组件
- 设计 token 集中：`packages/ui/tokens.ts`
- 所有交互元素必须可键盘操作；表格用语义化 `<table>`
- 暗色模式：CSS 变量 + Tailwind `dark:` 前缀
- 文案默认中文，预留 i18n 接口（`packages/shared/i18n/`），v1 不做翻译

## 7. 性能要求

| 指标               | 目标              |
| ------------------ | ----------------- |
| LCP（首页/详情页） | < 2.5s            |
| TTI                | < 3.5s            |
| 首屏 JS bundle     | < 200KB gzip      |
| 客户端组件占比     | < 40%（其余 RSC） |

策略：

- K 线图按需 dynamic import（lightweight-charts ~ 50KB）
- 表格虚拟化（≥ 100 行用 `@tanstack/react-virtual`）
- 图片优化：`next/image`

## 8. 错误处理与降级

- 顶层 `error.tsx`：未捕获错误显示友好页 + trace_id（便于报错查日志）
- 长任务超时：UI 提示并提供"重试"
- 数据 stale（meta_stale / kline_stale）：显示醒目 banner，但不阻塞使用
- LLM 失败：显示 N1/N2 节点的部分结果 + warning

## 9. 测试要求

### 9.1 unit（lib/fp、selector、formatter）

- vitest，每个纯函数都覆盖

### 9.2 component

- React Testing Library + vitest
- 关键组件：表格、表单、SSE 进度条
- 不引入 MSW；用 `@tanstack/react-query` 的 `QueryClientProvider` + 手写 promise

### 9.3 e2e

- Playwright
- 用例：筛选 → 查看结果 → 触发分析 → 看进度 → 看结论（v1 无登录步骤）
- CI 只跑 smoke 子集（5 个用例）；完整集人工触发

## 10. 风险与备注

- 长任务 SSE 在弱网下断流——必须有"重连 + 续传"：服务端用 task_id 持久化进度，重连时从最后 cursor 推
- K 线图组件 SSR 不友好，统一 `dynamic(... { ssr: false })`
- v1 不做鉴权；NestJS 监听 127.0.0.1。任何外网部署计划必须先引入鉴权（NextAuth + OIDC）后再开放，由产品决策触发
- 禁止把全部 K 线塞 Zustand：内存爆炸，让 react-query 管缓存与 GC
