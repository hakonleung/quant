# Watch — 自选盯盘

## 功能

- 用户维护若干盯盘任务（A 股 / 港股 / 美股按 market 分组），每个任务挂在一个具名 **Group** 之下，由 Group 持有共享的 `WatchCondition[]` / `intervalSec` / `pushIntervalSec`。
- 盘中分钟级刷新行情，触发条件 → 经 `pushIntervalSec` 时间门 + ±2 % 价格漂移门双重节流后通过 [`ChannelService`](./11-channel.md) 投递（slack / feishu / …）。
- 条件支持涨跌幅（pct，多基线）与绝对价（abs）两类，叠加由"任意条件命中即报"语义合并。

## Group 模型（2026-05）

- `WatchGroup{ name, conditions, intervalSec, pushIntervalSec, createdAt }` 是一等存储对象，保存在 `data/watch/groups.json`。
- `WatchTask` 通过 `groupName` 外键引用一个 group。`POST /api/watch` 必须传 `groupName`，且 group 必须先于 task 存在；服务端总是用 group 自己的 conds / intervals 覆盖 task 创建请求里的对应字段——避免同 group 下 task 之间漂移。
- 删除 group（`DELETE /api/watch/groups/:name`）级联：先删除 group 下所有 task（调度器立即停掉），再删除 group 配置；顺序保证调度器永远不会看到 dangling task。
- 旧 `tasks.json`（无 `groupName`）由 `migrateLegacyTasks` 按 `legacy-<sha1(conds)[0..6]>` 自动补一个组名，相同条件签名的旧 task 收敛到同一组；启动时 `WatchService.seedLegacyGroups()` 把这些组写回 `groups.json`，幂等。

## 实现

| 层      | 位置                                                                                          | 说明                                                                                  |
| ------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Types   | `quant_core/domain/types/watch.py`                                                            | `SpotQuote`（含 `amount` / `volume`）、`StockBasic`                                   |
| Source  | `quant_io/sources/akshare_watch.py`                                                           | A: `stock_bid_ask_em`；HK/US: `stock_{hk,us}_hist_min_em`（BJT 墙钟窗口）             |
| Service | `quant_core/services/watch_quote_service.py`                                                  | 拉行情 + 评估 hit                                                                     |
| RPC     | `quant_rpc/ops/watch.py`                                                                      | ops `watch.quote_one` / `watch.universe_refresh`（schema 含 amount/volume）           |
| API     | `apps/api/src/modules/watch/`                                                                 | `GET /api/watch`、`POST /api/watch`、`GET/POST /api/watch/groups`、`DELETE /api/watch/groups/:name`；实时流通过 Socket.IO `watch.snapshot` topic（[12-socket.md](./12-socket.md)） |
| Notify  | `apps/api/src/modules/watch/domain/{evaluate,format}.ts` + `ChannelService.broadcast`         | 条件求值 + 文本渲染 + 多 IM 投递（[11-channel.md](./11-channel.md)）                  |
| Web     | `feat-watch-live`、`feat-watch-live/watch-add-form`                                           | 实时表格 + 多选 + 状态徽标；trend baseline 含 window 字段                             |

## 条件语义（`WatchCondition`）

```ts
type WatchBaseline = 'prev_close' | 'day_high' | 'day_low' | 'vwap' | 'trend';

type WatchCondition =
  | { kind: 'pct'; op: 'gte' | 'lte';
      baseline: WatchBaseline;
      thresholdPct: string;        // 带符号 Decimal-as-string
      window?: number;             // 仅 baseline === 'trend' 必填，单位**秒**，1..14400 (4h)
    }
  | { kind: 'abs'; op: 'gte' | 'lte'; thresholdPrice: string };
```

求值用 `Decimal`，禁用 `number`（`apps/api/.../evaluate.ts`）。基线含义：

| baseline    | 取值                                                                       | 备注 |
| ----------- | -------------------------------------------------------------------------- | ---- |
| `prev_close` | 上一交易日收盘                                                           | 来自报价 |
| `day_high`  | 当日最高                                                                   | 来自报价 |
| `day_low`   | 当日最低                                                                   | 来自报价 |
| `vwap`      | `amount / volume`（累计成交额 / 成交量）                                   | `volume <= 0` 时不触发 |
| `trend`     | 当日已缓存样本中，时间戳 ≤ `latestTs - window 秒` 的最新一条               | `window` 单位为**秒**；调度器维护 `{ts, price}` 内存样本，按 `latestTs - maxWindow` 滚动裁剪；跨日重置；找不到符合 cutoff 的样本时不触发 |

> 历史 `prev`（上一次盘中采样）基线已在 2026-05 移除；旧任务由 `migrateLegacyTasks` 自动改写为 `prev_close`。

## Hit 节流（2026-05）

`matched` 不空时，hit 触发当且仅当 **价格门 + 时间门** 同时通过：

- **价格门**：`lastHitPrice == null`（新任务 / 跨交易日重置）或 `|last - lastHitPrice| / lastHitPrice >= 2 %`。触发后写入 `lastHitPrice = last`。
- **时间门**：`lastPushAt == null` 或 `now >= lastPushAt + pushIntervalSec * 1000`。

原先的 not-match → match 边沿门已移除；`lastMatchAt` / `lastSamplePrice` 字段从 schema 删除（旧 `tasks.json` 由 `migrateLegacyTasks` 自动剥离 + 注入 `lastHitPrice: null`）。`pushIntervalSec` 仍然保留并参与节流。

## 缓存策略

- **任务**：`data/watch/tasks.json`（带 `groupName` 外键），由 `feat-watch-live` 通过 `POST /api/watch` 维护。
- **Group 配置**：`data/watch/groups.json`，由 `WatchGroupStore` 管理；写入与 task 一样走 atomic `tmp+rename` + 1s 节流。
- **报价快照**：`FileKeyValueStore`，每 key 一文件 + envelope。
- **trend 样本**：`WatchScheduler` 内存 Map，键 `market:code`，存 `{ts, price}` 对；按 `latestTs - max(window) - intervalSec` 滚动裁剪（上限墙钟跨度 ≈ `WATCH_TREND_WINDOW_MAX_SEC` = 4 h）；跨交易日清空；进程重启即丢失（acceptable warm-up window）。
- **黑名单交叉**：A 股若进入 `data/blacklist.json`，watch 仍可手动盯（`POST /api/watch` 不查黑名单），但同步路径会跳过其 meta / kline 更新（详见 `12-blacklist.md`）。
