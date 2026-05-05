# 数据源 — akshare

## 用途

唯一外部行情 / 元信息来源（v1）。无 API key，HTTP 直连。

## 适配器

| 文件 | akshare 函数 | 用途 |
| ---- | ------------ | ---- |
| `quant_io/sources/akshare_kline.py` | `stock_zh_a_hist` | 日线 + 复权因子 |
| `quant_io/sources/akshare_watch.py` | `stock_us_hist_min_em`、`stock_zh_a_minute` | 盘中分钟（带 start/end 窗口） |
| `quant_io/sources/akshare_stock_meta.py` | `stock_info_a_code_name`、`stock_zh_a_spot` 等 | 全市场代码 / 名称 / 上市日期 |
| `quant_io/sources/akshare_financials.py` | `stock_financial_*` | 财务指标聚合 |
| `quant_io/sources/_common.py` | — | 重试 / 限流 / 列名归一 |

## 调用约束

- **限流**：全局 5 QPS（adapter 内 token bucket）；超限退避。
- **重试**：网络 / 5xx 退避 ≤ 3 次。
- **错误码**：超时 / 解析失败 → `DATA_SOURCE_TIMEOUT` / `DATA_SOURCE_BAD_RESPONSE`（见 `proto/errors.json`）。
- **时区**：akshare 返回北京时间字符串 → 入库统一转 UTC `datetime` aware。

## 故障处理

- akshare 上游偶发字段缺失 → adapter 校验后 raise，不"补默认值"。
- 上游 schema 漂移走代码修补，不在缓存层写兼容逻辑。
