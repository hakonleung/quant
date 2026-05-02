# 待增强清单（todo-enhancement）

> 本文件记录"已经想清楚、但当前实现里还不需要"的扩展项。每个模块文档不再各自维护 §TODO 段，避免"待办"长期占据正文 —— 只在模块文档里留一条指向本表的引用。
>
> 写入规则：
> - 每条增强必须包含 **触发条件**（什么时候动手）、**改动范围**、**风险 / 迁移说明**
> - 触发条件没满足前不要动手实现 —— 等条件成熟时连同测试一起补
> - 落地后这一条移到对应模块文档的"风险与备注"或正文，并从此处删除

---

## stock-meta（`docs/modules/01-stock-meta.md`）

### 1. 基于 `stock_individual_basic_info_xq` 扩展 StockMeta 字段

**触发条件**：UI 上线"省份分布因子" / "国资民营标签筛选" / 给 LLM 喂"公司简介上下文"中的任一项时。

**候选字段**（XQ 已返回）：

| 候选字段 | XQ 字段 | 用途 |
|---|---|---|
| `province: str` | `provincial_name` | 省份分布因子；UI 地图视图 |
| `controller: str` | `actual_controller` | 国资 / 民营特征因子；筛选条件 |
| `intro: str` | `org_cn_introduction` | LLM 上下文：行业 / 主营 / 关键产品语义补强 |
| `english_name: str` | `org_name_en` | 国际投资者视角搜索；多语 UI |
| `chairman: str` | `chairman` | 治理结构因子（v2） |

**改动范围**：

1. `quant_core/domain/types/stock.py` — 加字段 + 默认值（兼容旧 parquet）
2. `quant_cache/stock_meta_schema.py` — 加列；旧文件 `read_table` 需通过 schema fill 补默认列
3. `quant_io/sources/akshare_stock_meta.py:_xq_fields_to_meta` — 加映射
4. `packages/shared/src/types/stock-meta.ts` — DTO 同步加字段
5. 全部 fixture 与 contract test 更新

**风险**：

- XQ 部分字段返回 `"nan"` / `None` / 空对象；新增字段默认值要明确（不能让 None 流到 DTO）
- Parquet schema 演进：现有 `data/meta/stocks.parquet` 需要一次性迁移（用 `pyarrow.compute.cast` + 加默认列再 rename）
- `nan` 值在 `_xq_industry_name` 等地方已经处理，新字段需要套用同样的 `_str()` 净化器

### 2. 接入第二个 StockMetaSource

**触发条件**：AKShare 连续 ≥ 3 天 healthcheck 失败 / `stock_info_a_code_name` 限流明显 / `industries` 字段口径不满足下游需求。

**候选 source**（优先级靠前的先评估）：

- AKShare 的备用端点（如 `stock_zh_a_spot_em` 提供市值与流通市值，可派生 `float_pct`）
- 新华财经 / 同花顺 / 东方财富爬虫（覆盖更多字段，但 schema 不稳定）
- Baostock（v2 备用）

> Tushare 在项目内已确认**不再支持**（不接入、不维护），故不在候选名单。

**改动范围**：在 `quant_io/sources/` 加 adapter；在 `SourceChain[StockMetaSource]` 默认配置里加 `priority=2` 项；补 vcr fixture。

**风险**：行业分类口径冲突 — 主源切换时是否强制全量重新增强？默认策略是"不强制，缺失自然补"，但跨源 industries 文本不一致时下游模糊匹配会受影响。

### 3. 行业搜索二级索引

**触发条件**：`list_by_industry` 调用 P95 > 100ms / 行数突破 1 万。

**改动范围**：DuckDB view `view_stock_meta_by_industry`，`industries LIKE` 命中走索引；`ParquetStockMetaRepo.list_by_industry` 内部切到 DuckDB 路径。

**风险**：DuckDB 索引与 parquet 主文件的同步 — 全量 sync 后必须 `REFRESH` 一次。

### 4. 名称 / 拼音模糊搜索

**触发条件**：前端搜索框上线（v1 客户端 filter 已能覆盖 5500 行；> 1 万 时考虑）。

**改动范围**：`StockMetaService.search(query, limit=20)` + 对应 Flight op + HTTP 路由 `GET /api/stocks/search`；DuckDB 索引或预构建 trigram。

**风险**：拼音多音字（pypinyin 默认取常见读法）；中英混合 query；`*ST` 等特殊前缀的处理。

---

## 其它模块

（其它模块的待增强项以同样格式追加）
