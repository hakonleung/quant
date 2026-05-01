# 模块 04 — 形态拟合（pattern-matching）

## 1. 职责

给定一段参考 K 线形态，在指定股票池 + 时间窗口内找出最相似的 Top-N。

## 2. 输入与输出

```python
# domain/types/pattern.py
@dataclass(frozen=True, slots=True)
class PatternQuery:
    reference: PatternSeries        # 参考形态
    universe: Sequence[str]         # 候选股票池
    window_days: int                # 在每只股票上扫描的窗口长度 = len(reference)
    asof_end: date                  # 扫描截止日期
    lookback_days: int              # 在每只股票上向前扫描多少天的滑动窗口
    top_n: int = 50

@dataclass(frozen=True, slots=True)
class PatternSeries:
    # 用前复权 close 序列。其它列（OHLC）v2 引入。
    closes: Sequence[Decimal]
    source: PatternSource           # discriminated union: from_stock | hand_drawn | uploaded

@dataclass(frozen=True, slots=True)
class PatternMatch:
    code: str
    start_date: date
    end_date: date
    distance: float                 # 越小越像
    aligned_path: list[tuple[int, int]] | None   # DTW 对齐路径（v1 可选）
```

## 3. 算法（v1）

1. **归一化**：参考序列与候选窗口都做 `z-score`（`(x - mean) / std`）。这样消除绝对价差异，只比较"形状"。
2. **距离**：DTW（Dynamic Time Warping），允许时间轴小幅拉伸；用 `dtaidistance` 库的快速实现。
3. **扫描**：对每只股票，在 `[asof_end - lookback_days, asof_end]` 范围内，以日为步长滑动 `window_days` 长度的窗口，对每个窗口计算与参考的 DTW 距离。
4. **排序**：所有 (code, window) 按距离升序，取 Top-N。

```python
# domain/pure/pattern.py
def z_score(series: Sequence[Decimal]) -> list[float]: ...
def dtw_distance(a: Sequence[float], b: Sequence[float], *, window: int | None = None) -> float: ...
```

## 4. 性能策略

| 优化 | 估算 |
|---|---|
| 候选池来自筛选结果（典型几十~几百只） | 已大幅缩小 |
| 每只股票滑窗数：lookback / 1 = 50~250 个 | |
| 单次 DTW O(n²)，n=30 时 ~900 次比较 | |
| 总比较数：~5000 万次（v1 全市场场景） | DTW 单次 ~50μs → 总 ~25min（**不可接受**） |

**v1 优化**：
- 对候选池外预过滤：先用快速指标（如序列首尾比值、最大涨幅）剪枝，把候选窗口缩小到 ~100 万
- DTW 加 Sakoe-Chiba 带宽限制（band = 5），单次降到 ~10μs
- 总耗时目标：< 30s（候选池 ≤ 500 只时）

**v2 升级**（不在 v1 范围）：
- 离线预计算每只股票每个窗口的 shapelet embedding
- HNSW 索引（faiss-cpu）做 ANN 召回，再精排 DTW
- 全市场扫描 < 5s

## 5. 端口

```python
# ports/pattern_engine.py
class PatternEngine(Protocol):
    def find_similar(self, query: PatternQuery) -> list[PatternMatch]: ...
```

v1 实现：`DTWPatternEngine`（`quant_compute/pattern/dtw_engine.py`）

## 6. NestJS HTTP API

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/pattern/find` | `PatternQueryDto` | 长任务 → `{ task_id }`；进度 SSE |
| GET | `/api/pattern/reference/from-stock` | `?code=...&start=...&end=...` | `PatternSeries` |

## 7. 前端交互

- 参考形态选择：① 输入股票+起止日 ② 上传 CSV ③ 画板（v2）
- 候选池：默认 = 当前筛选结果；可手选股票池
- 结果列表：股票名 + 起止日 + 距离 + 缩略 K 线（叠加参考形态半透明对比）

## 8. 测试要求

### 8.1 unit（pure 函数）
- `z_score`：常数序列（std=0 应特判）、单点、负值、Decimal 精度
- `dtw_distance`：相同序列 = 0；常数序列对常数序列 = 0；已知小例（论文样例）

### 8.2 integration
- 端到端：人工构造 5 只股票 30 日数据，参考形态 = 其中一只 → 命中第一名应是该股票
- 性能基准（不进 CI 默认）：500 只 × 250 窗口 < 30s

### 8.3 property
- 平移不变性：参考序列 + 常数 → 距离不变（z-score 后等价）
- 缩放不变性：参考序列 × k → 距离不变

## 9. 风险与备注

- DTW 对短序列（< 10）效果差，UI 上限制 `window_days >= 10`
- 滑窗起点对齐到交易日，跳过停牌日
- 距离非概率，无法直接给"相似度百分比"——展示用相对排名 + 距离原值，不要硬转百分比骗用户
- 参考形态来自"未来"会泄漏：若 `reference.end_date > asof_end - window_days`，必须拒绝（防止用户拿明天的形态找今天的相似）
