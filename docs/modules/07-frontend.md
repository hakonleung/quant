# 模块 07 — 前端（frontend）

## 1. 职责

Next.js App Router 前端，单用户本地工具（v1 不鉴权，匿名）。提供：

- 传统股票列表（排序、搜索、虚拟滚动）
- 个股详情（K 线、资料、按需触发消息面）
- 板块（用户板块 / 动态板块 / 多选合并的临时板块）
- 黑名单
- 全部用户配置浏览器本地持久化

## 2. 技术栈

| 用途       | 选型                                                       |
| ---------- | ---------------------------------------------------------- |
| UI 组件库  | **Chakra UI v3**（全局 theme + tokens）                    |
| 状态管理   | **Zustand**（UI / 用户配置 / 板块 / 黑名单）               |
| 服务端缓存 | **@tanstack/react-query**（行情、详情、筛选结果、消息面） |
| 表单       | **react-hook-form + @hookform/resolvers/zod**              |
| 校验       | **zod**（与 `packages/shared/types/` 同源）                |
| 持久化     | **IndexedDB**（`idb` 包）+ Zustand `persist` 适配器        |
| K 线图     | `lightweight-charts`（dynamic import，ssr:false）          |
| 虚拟滚动   | `@tanstack/react-virtual`                                  |
| 终端渲染   | 自研 `<TerminalText>`（等宽字体 + 光标 + 渐显逐字符）     |

> 不使用 Tailwind / shadcn。所有原子组件统一从 Chakra 取，禁止再引入第二套组件库。

## 3. 页面结构

```
app/
├── (app)/
│   ├── layout.tsx                # Chakra Provider + 主导航（股票 / 板块 / 黑名单 / 设置）
│   ├── page.tsx                  # 工作台：最近板块、最近消息面任务
│   ├── stocks/
│   │   ├── page.tsx              # 全市场股票列表（虚拟滚动 + 搜索 + 排序）
│   │   └── [code]/page.tsx       # 个股详情
│   ├── sectors/
│   │   ├── page.tsx              # 板块列表（用户板块 + 动态板块）
│   │   └── [id]/page.tsx         # 单板块视图；?ids=a,b,c 表示多选合并的临时板块
│   ├── blacklist/page.tsx        # 黑名单管理
│   └── settings/page.tsx         # 主题、Slack 推送目标、数据导入导出
└── api/                          # 仅前端 BFF；业务 API 在 NestJS
```

## 4. 功能详述

### 4.1 传统股票列表 `stocks/`（E-1）

- 数据：一次性从 NestJS 拉全市场轻量 meta（code/name/industry/market），用 react-query `staleTime: 1h`。派生指标列触发时按 sector/可见 codes 调 `useStockSnapshots`，与 meta 同 cache key。
- 表格：`@tanstack/react-virtual` 虚拟滚动（≥ 5000 行无卡顿）。
- 表头排序：列点击切 `asc/desc/none`，状态写 URL `?sort=...`。
- 搜索：输入框（debounce 200ms）匹配 `code` 前缀 + `name` 模糊；命中走前端筛选，不打后端。
- 行操作：右键菜单 `加入板块 / 加入黑名单 / 复制代码`。
- 黑名单股票默认隐藏（设置可开启"显示但置灰"）。

#### 4.1.1 动态列管理（M3）

E-1 list 的列**不再硬编码**，而由"列目录 + 用户偏好"组合渲染。Header 增加 `⚙` 按钮打开 `<ColumnManagerDialog>`。

**列目录**（`apps/web/lib/eqty/columns.catalog.ts`，纯类型）：

```ts
export type ColumnKey =
  | 'name' | 'price' | 'chgPct' | 'turnoverRate' | 'turnover' | 'consecUp'
  | 'mktCap' | 'floatMktCap' | 'peTtm' | 'peDynamic' | 'pb' | 'peg' | 'grossMargin';

export interface ColumnSpec {
  readonly key: ColumnKey;
  readonly label: string;
  readonly group: 'core' | 'derived';
  readonly defaultApplied: boolean;
  readonly source: 'meta' | 'kline' | 'snapshot';   // 决定从哪个 hook 取值
}
```

**渲染顺序**：`appliedColumns(顺序敏感) → evidenceColumns(动态评估列, 始终在末尾)`。
evidence 列**不**进列管理 dialog —— 它跟 sector 绑死，由数据源决定。dialog 顶部用一行 hint 说明这一规则。

**dialog 行为**：

- 左半：已应用列（顺序敏感），每行 `× 删除` + `↑ ↓` 改顺序（v1 不引拖拽库；reorder 用上下按钮，每次相邻互换）
- 右半：未应用列（catalog ∖ applied），点 `+` 加到末尾
- 底部 `取消 / 保存`；保存才 commit 到 store

**持久化**：扩展 `settings.store.ts`，新增 `appliedColumns: readonly ColumnKey[]`，沿用 IndexedDB `settings` object store，`version` 由 1 升 2。迁移：旧版本的用户拿到 catalog 中 `defaultApplied=true` 的子集（顺序按 catalog 出现顺序）。

**与 sector 切换的关系**：列偏好是**全局**的，不随 sector 变化；evidence 列则跟 sector 走。这与 §6 的 "用户配置走 Zustand persist + IndexedDB" 边界一致。

**性能**：派生列依赖 `useStockSnapshots(codes)`；当 applied 中无任何 `source: 'snapshot'` 列时**不发请求**，避免对 ALL sector（5500 codes）触发不必要的批量调用。

### 4.2 个股详情 `stocks/[code]`

布局：左主区 K 线 + 操作栏，右侧栏个股资料 + 消息面。

- **K 线蜡烛图**
  - 默认 90 个交易日；可切 30 / 90 / 250 / 全部。
  - 叠加 `ma5/ma10/ma20/ma60`（来自后端预计算，不在前端算）。
  - 顶部 label 默认显示当前 hover 的 OHLCV。
  - 数据通过 react-query 缓存；同一 code 不同窗口共享底层数据。
- **个股资料卡**
  - 静态信息（名称、行业、上市日、流通市值）+ 最新一日基础指标。
- **消息面**
  - 默认显示缓存（无则提示 "尚无消息面"），不自动触发。
  - 按钮"刷新消息面" → POST `/sentiment/analyze_one`；返回 `task_id` 后用 SSE 推进度，完成后渲染七项关键字段 + evidence。
  - 内容渲染采用 `<TerminalText>` 终端风格。

### 4.3 板块 `sectors/`

#### 4.3.1 共通

- 板块为"客户端优先"实体：CRUD 直接走 IndexedDB，匿名用户无后端账户。导出 / 导入 JSON 走设置页。
- **股票列表**：复用 §4.1 的虚拟滚动表格，增加"消息面归类"列（仅用户板块在已有归类时显示）。
- **多选合并**：板块列表项左侧 checkbox；选中 ≥ 2 个 → 出现 "查看合并" 按钮，跳转 `sectors/_temp?ids=a,b,c`。临时板块只读，不可保存（再保存即转为新用户板块）。
- **Slack 推送**（透传 NestJS `/notifications/slack`）：
  - 单股：右键 → "推送到 Slack"
  - 任意 markdown / 终端文本：选中后浮出"推送"按钮
  - 已生成的消息面：详情面板顶部 "推送本结论"
  - 推送内容、目标 channel、用户备注通过 react-hook-form + zod 校验后提交。

#### 4.3.2 用户板块

- 创建：弹窗输入名称 / 描述。
- 添加成员：板块视图内"添加股票" → 调起带搜索的股票选择器（复用 §4.1 列表）。
- 删除成员、删除板块、重命名。
- 消息面归类：选中板块内股票 → "归类" → 触发 `/sentiment/analyze_many`；产出按 `ThemeCluster` 写回当前板块（保存在 IndexedDB）。

#### 4.3.3 动态板块

- 创建时录入一条自然语言筛选语句；保存后展示当前命中股票列表（命中 = 调 `/screen/run` 同步小结果）。
- 表格在基础列之外**动态追加**筛选证据列（来自 screen 输出的 `evidence`），列定义随 DSL 变化自动重建。
- "刷新结果"按钮重新跑筛选；可在编辑模式下修改语句。
- 动态板块只持久化语句；命中结果靠 react-query 缓存，过期重算。

### 4.4 黑名单 `blacklist/`

- 添加：股票详情页或股票列表行操作；也可在本页粘贴 `code` 列表批量加入。
- 管理：表格视图，支持移除、备注、导出。
- 全局生效：所有股票列表 / 板块视图默认过滤黑名单成员；筛选结果若命中黑名单股票，渲染时角标"已屏蔽"。

### 4.5 终端风格渲染 `<TerminalText>`

- 输入框：`<TerminalInput>`，等宽字体 + 闪烁光标 + 命令行提示符 `>`，用于 NL 筛选语句、消息面提问、Slack 备注。
- AI 输出：`<TerminalText>`，按字符渐显（可配置速率），支持 ANSI-like 颜色 token（`{red}…{/red}`）；流式来源用 SSE chunk。
- 可选 "复制为 markdown" / "切换原始视图"。

### 4.6 特色：K 线交互

1. **单击 K 线**：上方 label 显示"自该日至今涨跌幅"（基于前复权 close）。
2. **Pattern Match 模式**
   - 第一次单击设为起点；第二次单击设为终点（顺序自动归一）；区间高亮。
   - 出现 `Match` 按钮 → POST `/pattern/match` 带 `code, start, end, top_k`。
   - 结果以右侧抽屉展示：相似股票区间走势缩略图 + 距离分数 + 跳转该股票详情。
   - 退出按 ESC 或 "取消"。

## 5. 关键组件

| 组件                  | 文件                                  | 说明                                        |
| --------------------- | ------------------------------------- | ------------------------------------------- |
| `<StockTable>`        | `components/stock-table.tsx`          | 通用虚拟滚动表，承载列表/板块/筛选结果      |
| `<StockSearchPicker>` | `components/stock-search-picker.tsx`  | 弹窗搜索选择器，加入板块/黑名单时复用       |
| `<KlineChart>`        | `components/kline-chart.tsx`          | 蜡烛图 + MA + 单击 / 双击交互               |
| `<PatternMatchPanel>` | `components/pattern-match-panel.tsx`  | Pattern match 抽屉                          |
| `<SectorList>`        | `components/sector-list.tsx`          | 多选板块列表 + 合并按钮                     |
| `<NLDslEditor>`       | `components/nl-dsl-editor.tsx`        | 动态板块语句编辑（终端风格）                |
| `<ColumnManagerDialog>` | `components/eqty/column-manager-dialog.tsx` | E-1 列管理（已应用 / 未应用，排序）  |
| `<SentimentReport>`   | `components/sentiment-report.tsx`     | 七字段渲染 + evidence                       |
| `<SlackPushDialog>`   | `components/slack-push-dialog.tsx`    | RHF + zod 表单                              |
| `<TerminalInput>`     | `components/terminal/input.tsx`       | 终端输入                                    |
| `<TerminalText>`      | `components/terminal/text.tsx`        | 终端流式输出                                |
| `<ProgressStream>`    | `components/progress-stream.tsx`      | SSE 进度复用                                |

约束：

- 业务逻辑下沉到 `lib/fp/` 纯函数（可单测，零 mock）
- 数据契约用 `packages/shared/types/` 的 zod schema
- 禁止手写 fetch；走 `lib/api-client/`（OpenAPI 生成）
- 所有组件 ≤ 150 行（含 JSX）

## 6. 状态管理

| 状态种类                                    | 工具                              |
| ------------------------------------------- | --------------------------------- |
| 服务端数据缓存（行情、消息面、筛选结果）   | react-query                       |
| 表单状态（板块创建、Slack 推送、设置）     | react-hook-form + zod resolver    |
| UI 局部（modal、tab、hover）                | 组件内 `useState`                 |
| 跨组件 UI（侧栏、主题、pattern match 模式）| Zustand（非持久 slice）           |
| **用户配置**（板块、黑名单、主题、Slack 配置、动态板块语句） | Zustand persist + IndexedDB       |
| URL 状态（排序、搜索、临时板块 ids）        | `useSearchParams`                 |

**禁止**：把服务端数据放进 Zustand。服务端数据的"单一事实"是 react-query cache。

### 6.1 Zustand store 划分

```
stores/
  ui.store.ts              # 临时 UI（pattern-match mode、selected-rows）
  sectors.store.ts         # persist：用户/动态板块定义
  blacklist.store.ts       # persist：黑名单 + 备注
  settings.store.ts        # persist：主题、Slack 配置、列偏好
  notifications.store.ts   # transient：推送队列状态
```

### 6.2 IndexedDB 持久化

- 用 `idb` 封装单 DB `quant-app`，每个 persist store 一个 object store。
- 写入用 Zustand `persist` middleware + 自定义 storage adapter（`get/set/remove → idb`）。
- 关键事务（板块批量导入）走显式 `idb` API，不经 zustand。
- 提供 `settings/data` 页：导出全部 store 为 JSON，导入时 zod 校验后覆盖。
- 版本迁移：每个 store 带 `version` + `migrate(persistedState, version)`。

## 7. 设计语言

- **现代优雅**：Chakra theme override；中性灰 + 单一品牌色（蓝绿）；圆角 8 / 12；阴影克制。
- **突出重点操作**：主按钮 solid + 品牌色；次要 ghost；危险操作（删板块、清空黑名单）红色 + 二次确认弹窗。
- **节奏**：所有交互动效 ≤ 200ms；加载态用骨架屏，不用全屏 spinner。
- **暗色模式**：Chakra `useColorMode`；终端组件在亮 / 暗模式下分别有配色。
- **可达性**：键盘可达；表格语义化；对比度 ≥ WCAG AA。
- 文案默认中文；预留 `packages/shared/i18n/`，v1 不做翻译。

## 8. 性能要求

| 指标               | 目标                  |
| ------------------ | --------------------- |
| LCP（首页/详情页） | < 2.5s                |
| TTI                | < 3.5s                |
| 首屏 JS bundle     | < 250KB gzip          |
| 股票列表渲染       | 5000 行滚动 60fps     |
| 客户端组件占比     | < 50%（其余 RSC）     |

策略：

- K 线图、Pattern Match 抽屉、终端组件均按需 dynamic import
- 全市场 meta 走 RSC + ISR（revalidate: 1h）
- IndexedDB 读写在 idle callback 内分批提交

## 9. 错误处理与降级

- 顶层 `error.tsx`：未捕获错误显示友好页 + trace_id
- 长任务超时：UI 提示并提供"重试"
- 数据 stale（meta_stale / kline_stale）：banner 提示，不阻塞
- LLM 失败：显示 N1/N2 节点的部分结果 + warning
- IndexedDB 不可用（隐私模式）：降级到 `localStorage`，并 banner 警告"配置不会持久"

## 10. 测试要求

### 10.1 unit（lib/fp、selector、formatter、zustand reducer）

- vitest，零 mock。Zustand store 直接 `createStore` 测纯逻辑。

### 10.2 component

- React Testing Library + vitest
- 关键组件：`<StockTable>` 排序/搜索/虚拟滚动、`<KlineChart>` 单击/双击交互、`<TerminalText>` 流式渲染、`<SlackPushDialog>` 表单校验
- 不用 MSW；用 `QueryClientProvider` + 手写 promise

### 10.3 e2e（Playwright）

- 用例：列表搜索 → 加入用户板块 → 创建动态板块 → 选两个板块合并 → 在合并视图触发归类 → 推送至 Slack（mock 后端）
- K 线 pattern match：进入详情 → 点两根 K 线 → match → 看抽屉
- CI 跑 smoke 子集（5 个）；完整集人工触发

## 11. 风险与备注

- **IndexedDB 体积**：黑名单 / 板块大量增长时需要分页 + 索引；目前单板块 ≤ 200 股，板块 ≤ 50 个的假设下无压力
- **匿名持久化**：清浏览器数据 = 配置丢失。设置页必须默认提供"导出 JSON"提醒
- **多选临时板块**：只在 URL 上承载 ids，不写 IndexedDB；刷新即重建
- **Pattern Match 体验**：移动端不支持精确点击 K 线 → v1 仅桌面
- 长任务 SSE 弱网断流 → 后端用 task_id 持久化进度，重连从最后 cursor 推
- v1 不做鉴权；NestJS 监听 127.0.0.1。外网部署须先引入鉴权
- 禁止把全部 K 线塞 Zustand：内存爆炸，让 react-query 管缓存与 GC
