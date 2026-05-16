# LLM analyze 管线塌缩 + wire 极简化

提交：`perf(llm): collapse analyze pipeline + minify wire schemas`

## 背景

`/analyze <code>` 单次调用墙钟 25-40s 起步，长尾常破 60s。`analyzeMany` 在每只股票上并发跑同一管线，慢的那只拖死整批。`/screen`、`/ledger.analyze`、`/ta` 同样有 output 膨胀 + 失败重试拖尾的问题。

profile 拆解（典型 case）：

| 阶段                              | 耗时   | 主因                                                                       |
| --------------------------------- | ------ | -------------------------------------------------------------------------- |
| Step 1 web_search + 1000字研究纪要 | 8-16s  | Moonshot `$web_search` 工具循环 4 RTT，或 Qwen `enable_search` 单 shot 慢回|
| Step 2 flash JSON 抽取             | 10-20s | 11 字段 schema，typical output 2000-4000 tokens                            |
| Step 2 重试（失败时）              | +10-20s | JSON 校验失败 → echo error 进 prompt 再调一次                              |
| ledger flush per call              | 5-50ms | DuckDB parquet rewrite                                                     |

## 瓶颈定位

- 信息没省：Step 1 产出 1000 字散文专门给 Step 2 翻译成 JSON。同一份信息**两次解码**（散文 + JSON）双倍付费。
- output 主导：output tokens / decode_rate 占总延迟 60%+。schema 11 字段全是数组 + 嵌套对象，模型见到结构会**主动填满每个槽位**。
- public `Sentiment` 视图只用 score+theme+driver+result，大量结构化字段进了 JSON 又被 projection 丢掉 — 纯浪费。
- 重试路径让长尾翻倍，且 `response_format: json_object` 上线后 parse 失败率 < 1%，重试基本是无意义代码。

## 方案

### 1. wire 极简化（保维度 + 省 output）

LLM 输出从嵌套对象 → 每维度一个 `string[]`，每条用 `"|"` 分隔的紧凑串。例：

```jsonc
{
  "brief":   "渠道改善 + 估值修复，整体偏多。",
  "score":   0.78,
  "drivers": ["业绩超预期|+|0.8|0", "股权激励传闻|0|0.4|1"],
  "themes":  ["AI算力|0.9|GPU云需求爆发"],
  "products":["昇腾910B|35|国产替代"],
  "signals": ["GPU|up|short|+10%"],
  "research":["中信|买入|180.5|22|6|2026-05-10"],
  "competitive": {"pos":"leader","share":35,"summary":"...","competitors":["寒武纪|domestic_peer|high|国内对手"],"moats":["生态"],"risks":["产能"]}
  // ...
}
```

NestJS 侧 `apps/api/src/modules/sentiment/domain/pure/parsers.ts` 把每条还原成 typed `Insight` / `ThemeTag` / `ProductInfo` / …

每字段额外写死字数上限（drivers ≤30字、themes.label ≤8字、competitor.note ≤20字…）。模型见到上限会自动收敛。

### 2. 单次调用合并 web_search + JSON

新增 `LlmService.completeJsonWithWebSearch`：

- Qwen 路径 (`web-search/qwen-extra-body.ts`)：`extra_body.enable_search=true` + `response_format: json_object` 一并下发，单次流式回 JSON。
- Moonshot 路径 (`web-search/moonshot-tool-loop.ts`)：每轮 body 都带 `response_format: json_object`，工具循环结束直接产出 JSON。
- Plain 路径同样透传。

Sentiment service `runPerStock` 从 2 次 LLM 缩到 **1 次**，删掉 1000 字研究纪要中间产物。

### 3. brief 字段作为快读视图

LLM schema 顶层新增 `brief: string`（≤120字，"上涨核心动因分析"）。FE 在 stdout 多段视图上方独立渲染 brief；AI.MD 子面板把 brief 当 markdown 渲染。

### 4. 去重试

`response_format=json_object` + 极简 wire 让 parse 失败率 < 1%。删除：

- `nl-to-dsl.service.ts` 2-attempt 循环 + echo-error prompt
- `news-sentiment.service.ts` Step 2 重试
- 各处 markdown fence 容错（`stripFence` / `extractJsonObject`）

失败直接抛 `LLM_FAILED` / `NL_TRANSLATION_FAILED`，调用方决定要不要 `--fresh` 重试。

### 5. 所有 JSON 输出 minified

所有 JSON-mode prompt（sentiment / TA / ledger / nl-to-dsl）系统消息加："输出必须是单行 minified JSON，无空格无换行无 markdown 包裹"。示例同步改成 single-line。`response_format: json_object` 默认就生效，prompt 强化是兜底。

## 量化结果

| 指标                             | Before          | After           | Δ          |
| -------------------------------- | --------------- | --------------- | ---------- |
| 单股 LLM 调用数                  | 2               | **1**           | -50%       |
| Sentiment output tokens (typical)| 2000-4000       | **600-1000**    | **-60~70%**|
| TA output tokens                 | ~600-1000       | ~300-500        | -40~50%    |
| Ledger output tokens             | ~400-700        | ~200-350        | -30~50%    |
| 重试路径长尾                     | +10-50% calls   | **0**           | 消除       |
| 单股 analyze 墙钟 (p50, Qwen)    | 25-30s          | **10-15s**      | **-50%**   |
| 单股 analyze 墙钟 (Moonshot loop)| 30-45s (+ 1-2 retry → 60s+) | 18-25s | -40~60% |

（数字基于设计推导 + 与 provider TTFB 实测对齐；上线后需补真实 latency 直方图回填本表。）

## 回归风险与监控

- **维度精度**：极简 wire 把结构化数据降到字符串，parser 解码错误会**静默 drop 该条**而不是炸 schema。监控 `llm_call_ok` 后产出条目数是否突降（< 历史 P10 → 告警）。
- **brief 质量**：120 字上限可能让模型"凑字"。线下抽样人工评测。
- **Moonshot JSON 模式兼容**：Kimi `$web_search` builtin 与 `response_format` 同框是否稳定 — 失败时直接抛错暴露而非 fallback。
- **缓存兼容**：`SentimentSchema` 字段全换，旧缓存 zod parse 失败 → 视为 miss + warn 日志。30 天 TTL 内会自然清空，无需主动 purge。
- **agent web.search**：仍走 `completeWithWebSearch`（free-text，无 JSON）。未受影响。

## 后续待办

- 上线后补真实 p50/p95 + token 用量直方图回填本文表格。
- 评测 sentiment "维度完整度"（structured fields per stock 平均数）是否较旧版有显著回退。
- Moonshot 工具循环 `MAX_SEARCHES=4` 暂未收紧——下一轮再做。
