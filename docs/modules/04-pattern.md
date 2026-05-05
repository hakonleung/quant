# Pattern — 形态匹配

## 功能

- 给定一只股票最近 N 天走势，在全市场找形态相似的股票（DTW 距离 + 归一化）。
- 给定多支预设模板（V 反转、双底、平台突破等），扫描全市场匹配。

## 实现

| 层 | 位置 | 说明 |
| -- | ---- | ---- |
| Types | `quant_core/domain/types/pattern.py` | `PatternQuery`、`PatternHit`、`Distance` |
| Engine | `quant_core/adapters/pattern/` | DTW 实现（pure Python + numpy / numba 可选） |
| Service | `quant_core/services/pattern_service.py` | 归一化 → 距离 → top-k 排序 |
| RPC | `quant_rpc/ops/pattern.py` | Arrow Flight |
| API | `apps/api/src/modules/pattern/` | `POST /pattern/find-similar` |
| Web | `feat-scr-pat` | 选模板 / 选锚点股 → 命中列表 |

## 行为约束

- `find_similar` 始终在**全宇宙**上跑（避免用户传错 universe 漏掉真实相似股，参见 commit 6714700）。
- 输入 / 模板归一化用 z-score（pattern.py 中固定）。
- 默认窗口 30 天，可配；最多扫 250 天。

## 缓存策略

- **K 线**：复用 `data/kline/*.parquet`。
- **模板**：硬编码在 `domain/types/pattern.py` 中（数组常量），无缓存。
- **结果**：不缓存——锚点窗口随交易日滚动，且距离阈值由调用方决定。
