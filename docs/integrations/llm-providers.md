# 集成 — LLM 与 Embedding 供应商（llm-providers）

## 1. 目标

LLM 调用和向量嵌入是消息面分析与 NL→DSL 的核心依赖。必须做到：

- 多供应商可切换（deepseek / kimi / openai-compat），主路通过 env 配置
- 强制结构化输出（schema 校验）
- 失败重试 + 降级
- token 计量 + 成本归账
- 可在测试中用录制回放

## 2. 端口

```python
# ports/llm.py
class LLMPort(Protocol):
    name: str

    def chat(
        self,
        messages: list[Message],
        *,
        schema: type[BaseModel] | None = None,
        max_tokens: int = 2048,
        temperature: float = 0.0,
        tools: list[ToolDef] | None = None,
        trace_id: str,
    ) -> LLMResponse: ...

@dataclass(frozen=True, slots=True)
class LLMResponse:
    content: str | BaseModel        # schema 不空时为模型实例
    tool_calls: list[ToolCall]
    usage: TokenUsage
    raw: dict                       # 供调试，业务代码不应依赖
```

```python
# ports/embedding.py
class EmbeddingPort(Protocol):
    name: str
    dim: int
    def embed(self, texts: Sequence[str], *, trace_id: str) -> NDArray[np.float32]: ...
```

## 3. v1 适配器

| 适配器            | 文件                                    | 备注                                                          |
| ----------------- | --------------------------------------- | ------------------------------------------------------------- |
| `DeepSeekAdapter` | `quant_io/adapters/llm/deepseek.py`     | OpenAI 兼容协议；结构化输出走 `response_format = json_schema` |
| `KimiAdapter`     | `quant_io/adapters/llm/kimi.py`         | OpenAI 兼容协议；额外支持内置 `$web_search` 工具（见下）      |
| `BgeM3Adapter`    | `quant_io/adapters/embedding/bge_m3.py` | 本地或外部 endpoint 二选一                                    |

### 3.1 Kimi 内置 web_search

Kimi 对 OpenAI 工具调用协议做了扩展，支持 `tools=[{"type": "builtin_function", "function": {"name": "$web_search"}}]`。LLM 自主在多步 reasoning 中调用，平台自动执行联网搜索并把结果回填给模型。

- `KimiAdapter.chat` 在 `tools` 列表里允许传入这个 builtin function；`LLMChain` 检测到 `tool_calls` 后自动 echo 回模型，直到 `finish_reason="stop"`（与普通 function-call 流程一致）
- 计费：每次 `$web_search` 触发按 Kimi 价目表计入 `TokenUsage.cost_usd`（adapter 内部读 response 的 `usage.search_count` 字段）
- 仅 Kimi 提供；DeepSeek 当前没有等价工具 → 调用方必须容忍降级路径（见 `docs/modules/06-sentiment-analysis.md` §4.1.5）

**主路与兜底由 env 配置决定**（见 §10），不在 adapter 中写死。两家供应商上线 PK 一段时间后，根据成本/质量/限流再决定主路；底层抽象保证切换零代码改动。

## 4. 结构化输出

强制 schema：

```python
class DSLOutput(BaseModel):
    plan: ScreenPlan

response = llm.chat(messages, schema=DSLOutput, ...)
plan: ScreenPlan = response.content.plan   # 已是合法对象
```

实现策略（按供应商）：

- DeepSeek / Kimi（OpenAI 兼容）：用 `response_format = { type: "json_schema", json_schema: { name, schema, strict: true }}`
- 不支持 strict json_schema 的 provider：fallback 到 prompt-engineering（提示词中嵌 schema + few-shot），输出后用 pydantic 校验
- 校验失败 → 自动重试一次，prompt 中携带 schema 错误反馈
- 仍失败 → 抛 `LLMSchemaError`

## 5. 重试与降级

```python
class LLMChain:
    def __init__(self, providers: list[LLMPort], retry: RetryPolicy) -> None: ...
    def chat(self, ...) -> LLMResponse: ...
```

重试规则：

- `LLMTransientError`（429 / 5xx / timeout） → 退避重试
- `LLMSchemaError` → 重试一次，把错误反馈塞进 messages
- `LLMQuotaExhausted` → 立即降级到下一个 provider
- `LLMContentFiltered` → 不重试，转抛领域异常

## 6. 缓存

**Prompt + schema → 响应** 哈希缓存。

```python
class CachingLLM(LLMPort):
    def __init__(self, inner: LLMPort, cache: KeyValueStore, ttl_sec: int) -> None: ...
    def chat(self, messages, schema, ...):
        key = sha256(canonical_json(messages, schema, params))
        if hit := cache.get(key):
            return deserialize(hit)
        resp = self.inner.chat(...)
        cache.put(key, serialize(resp), ttl_sec=self.ttl_sec)
        return resp
```

缓存策略：

- `temperature=0` 时启用（默认 on）
- `temperature>0` 不缓存
- 默认 TTL 24h；用户可在 UI 强制 bypass

## 7. 计量与成本

```python
@dataclass(frozen=True, slots=True)
class TokenUsage:
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int   # provider 级 prompt cache 命中
    cost_usd: Decimal          # 由 provider 价目表计算
```

每次调用追加到：

```
data/_audit/llm/<date>.jsonl
{ "trace_id": "...", "provider": "deepseek", "model": "...", "node": "per_stock_drivers", "usage": {...}, "duration_ms": ... }
```

UI `/admin/llm` 展示按天/按节点的成本。

## 8. 限流

每个 provider 单独配置：

```python
class RateLimit:
    requests_per_min: int
    input_tokens_per_min: int
    output_tokens_per_min: int
```

实现：令牌桶（`pyrate-limiter` 或自实现），超限时排队（短）或直接抛 `RateLimited`（长）。

并发控制：每 provider semaphore，默认 4。

## 9. 录制 / 回放（测试用）

```python
class ReplayLLM(LLMPort):
    def __init__(self, fixture_path: Path) -> None: ...
    def chat(self, messages, ...) -> LLMResponse:
        key = sha256(canonical(messages, ...))
        return self._fixtures[key]   # 缺失 → 抛 RecordedFixtureMissing
```

CI 默认用 `ReplayLLM`，fixture 由开发者用 `RecordingLLM` 包装真 LLM 跑一次后落地。

`RecordingLLM`：透传 + 落 fixture。开关：`QUANT_LLM_RECORD=1`。

## 10. 配置

主路 / 兜底通过 `.env` 决定，`config/llm.yaml` 给每个 provider 配静态参数：

`.env`：

```bash
LLM_PRIMARY_PROVIDER=deepseek      # 主路
LLM_FALLBACK_PROVIDER=kimi         # 兜底
DEEPSEEK_API_KEY=sk-...
KIMI_API_KEY=sk-...
```

`config/llm.yaml`：

```yaml
chat:
  cache:
    backend: file
    ttl_sec: 86400
  providers:
    - name: deepseek
      base_url: https://api.deepseek.com/v1
      model: deepseek-chat
      api_key_env: DEEPSEEK_API_KEY
      rate_limit:
        requests_per_min: 60
        input_tokens_per_min: 200000
    - name: kimi
      base_url: https://api.moonshot.cn/v1
      model: moonshot-v1-32k
      api_key_env: KIMI_API_KEY
      rate_limit:
        requests_per_min: 60
        input_tokens_per_min: 200000

embedding:
  provider: bge-m3
  endpoint: http://localhost:8000/embed
  batch_size: 32
```

启动时 pydantic 校验：

- `LLM_PRIMARY_PROVIDER` 必须在 `providers` 列表中
- 主路与兜底对应的 `api_key_env` 必须有值（否则启动失败）
- 未启用的 provider（`enabled: false`）不校验 key

## 11. 安全

- API key 走 `.env`，pydantic-settings `SecretStr` 加载
- 日志中 mask；审计 jsonl 不写 key 值
- prompt 中**不**含用户敏感信息（v1 单用户场景下风险可控；v2 多用户时按用户隔离 + 审计日志）

## 12. 测试要求

### 12.1 unit

- `LLMChain`：失败切换、schema 校验失败重试、quota 立即降级
- `CachingLLM`：相同 prompt 命中缓存、不同 schema 不命中
- token 计费：边界（缓存命中、长输出）

### 12.2 integration

- `ReplayLLM` + 真实 graph：完整 sentiment 流程不调外网

### 12.3 contract

- `provider.chat(schema=X)` 必须返回符合 X 的对象，违反 = MAJOR
- 录制 fixture 升级时（model 升级），主动重录 + diff 验证

## 13. 风险与备注

- DeepSeek 与 Kimi 都走 OpenAI 兼容协议，可共用同一个 `OpenAICompatAdapter` 基类，差异仅在 base_url + 默认 model；新增供应商成本低
- 不同 provider 的结构化输出能力不一致（DeepSeek 支持 strict json_schema，Kimi v1 部分模型仅支持 json_object）→ adapter 内做能力探测 + fallback
- `cached_input_tokens` 只有部分 provider 提供；缺失时记 0
- 同一 prompt 不同 provider 输出会有差异；schema 校验是底线，UX 保持不变
- bge-m3 模型大（~600MB），v1 默认用外部 endpoint；本地推理留 v2 备选
- 国产模型 API 在国内访问稳定，但海外部署时延会显著增加——v2 上云时考虑 multi-region key 或在国内部署 LLM 调用代理
