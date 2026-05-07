# Pattern — 形态匹配

## 功能

- 给定一只股票一段历史 K 线段（"参考形态"），在全市场最近行情中找形态相似的股票。
- 输出按相似度（z-score 归一化后 DTW 距离的反序）排序的 top-N 列表，配合 SCR.PAT 内嵌 50D K 线行展示。

## 实现

| 层      | 位置                                     | 说明                                                         |
| ------- | ---------------------------------------- | ------------------------------------------------------------ |
| Types   | `quant_core/domain/types/pattern.py`     | `PatternQuery`、`PatternHit`、`Distance`                     |
| Engine  | `quant_core/adapters/pattern/`           | DTW 实现（pure Python + numpy）                              |
| Service | `quant_core/services/pattern_service.py` | 归一化 → 距离 → similarity rank                              |
| RPC     | `quant_rpc/ops/pattern.py`               | op = `find_similar_patterns`                                 |
| API     | `apps/api/src/modules/pattern/`          | `POST /api/pattern/find-similar`                             |
| Web     | `feat-scr-pat`                           | 选锚点股 + 区间 → 命中列表（含每行内嵌 50D K 线 + 期间收益） |

## 行为约束

- **全宇宙扫描**：`find_similar_patterns` 始终在全宇宙上跑（commit 6714700：避免用户错传 universe 漏掉真实相似股）。
- **窗口**：`window_days` 由参考段长度推导，**不再**按 `start..end` 日期差计算（commit fcf5680）。
- **历史严格在前**：扫描候选股的窗口严格在参考起始日之前，杜绝前视偏差（commit 5632012：`PATTERN_REFERENCE_LOOKAHEAD` 错误）。
- **Recent-tail 扫描 + similarity rank**：候选只取每只股票最近 `window_days` 的尾段，按 z-score 归一化后比 DTW 距离，再以 `similarity = 1 / (1 + distance)` 排序输出（commit 9f08d95）。
- **归一化**：z-score；输入 / 候选段共享同一管线。

## 缓存策略

- **K 线**：复用 `data/kline/*.parquet`。
- **结果**：不缓存——锚点窗口随交易日滚动，且 top-N 由调用方决定。
