# Quant 项目工程规约（多语言版）

> 本文件是 Claude Code 在本仓库中工作的最高指令。所有代码生成、修改、审查必须严格遵循此规约。
> 违反任一硬性规则视为任务未完成，必须立即修复。

项目同时存在 **TypeScript（前端 Next.js + 后端 NestJS）** 和 **Python（计算/LangGraph）** 两套技术栈，跨语言通过 **Apache Arrow Flight (gRPC)** 通信。详见 `docs/architecture.md` 与 `docs/integrations/ipc-py-ts.md`。

---

## 0. 工作流（强制）

每次执行编码任务按以下顺序：

1. **理解 → 设计**：先读相关文件与 `docs/` 中相关模块文档，明确边界与依赖；非平凡任务先列计划再动手。
2. **实现**：按本文档"代码风格"与"模块化"规则写代码。涉及跨进程时同步检查/更新 `docs/integrations/ipc-py-ts.md` 中的契约。
3. **测试**：对**新增/修改的业务逻辑**调用 `test-generator` 生成测试并跑 `run-tests`；失败必须修到全绿。脚手架/配置/纯文档变更可豁免。
4. **自审**：满足以下任一条件才调用 `code-reviewer`：① 用户显式要求 review；② milestone / feature 收尾且包含非平凡业务逻辑；③ 跨进程契约（`proto/` / Arrow schema）变更。**单纯脚手架、配置调整、格式化、文档改动不要触发 reviewer。** 其它情况依赖 `pnpm check` 作为常驻门禁即可。
5. **交付**：终末汇报包含变更文件清单、测试结果；如跑了 review 则附结论。

跳过步骤 3 / 4 时主动说明原因（例："本次仅改 README，无需测试与 reviewer"）。

---

## 1. 代码风格（硬性，不可妥协）

### 1.1 Python 通用

- **格式化**：`ruff format` 与 `ruff check --fix`，行宽 100。
- **类型注解**：所有函数签名、公有属性、模块级常量必须有完整类型注解；`mypy --strict` 必须通过。
- **命名**：
  - 模块/包：`snake_case`
  - 类：`PascalCase`
  - 函数/变量：`snake_case`
  - 常量：`UPPER_SNAKE_CASE`
  - 私有：单下划线 `_name`
- **禁止**：
  - `from x import *`
  - 裸 `except:`（必须捕获具体异常）
  - 可变默认参数
  - 在循环里反复构造同一不变对象
  - `print` 用于业务日志（用 `logging`）
  - 单字母变量名（除 `i/j/k` 在小循环作下标，或数学公式中 `x/y`）
- **必须**：
  - 函数 ≤ 50 行；超过即应拆分
  - 单文件 ≤ 400 行；超过即应拆模块
  - 圈复杂度 ≤ 10
  - 公共 API 必须有 Google 风格 docstring（Args / Returns / Raises）
  - I/O、网络、磁盘等副作用集中在边界层（adapters / io / repository）

### 1.2 TypeScript 通用（Next.js + NestJS 共用）

- **格式化**：`prettier`（行宽 100，单引号，trailing comma all），`eslint --fix`。
- **tsconfig 强约束**（违反一律拒收）：
  ```json
  {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true
  }
  ```
- **类型安全硬规则（零容忍）**：
  - 禁 `any`、`as any`、`as unknown as T`（双重断言）
  - 禁 `// @ts-ignore`，必要时用 `// @ts-expect-error <reason: 一句话原因>`，且必须能在 lint 中被周期性扫描清理
  - 禁裸 `as T` 类型断言；类型收窄必须用：① 类型守卫函数 `is T`（带 runtime 检查） ② `zod.parse` ③ 用户定义的 discriminated union 的 `switch` 收窄
  - 禁 `Function`、`Object`、`{}` 作类型；用具体的函数签名或 `Record<K, V>`
  - 禁不带约束的泛型：`<T>` 必须有 `extends ...` 或在签名中被多个位置使用以体现关联
  - 禁 `non-null assertion` `!`；用类型守卫或显式抛错
  - 跨进程/外部输入必须 `zod` 校验后才进入业务代码，禁止"信任"外部 JSON
  - 三方库类型缺失时写 `*.d.ts` 而不是 `as any`
- **命名**：
  - 文件/目录：`kebab-case.ts`
  - 类/类型/接口：`PascalCase`（接口不加 `I` 前缀）
  - 变量/函数：`camelCase`
  - 常量：`UPPER_SNAKE_CASE`
  - React 组件文件：`PascalCase.tsx`
- **禁止**：
  - `console.log` 走业务日志（用 NestJS `Logger` / `pino`）
  - 默认导出（除非框架强制：Next.js page、layout 等）
  - `enum`（用 `as const` 对象 + 字面量联合类型）
  - `require()`（统一 ESM `import`）
  - 在组件函数体里 `new Date()` / `Math.random()`——通过 props/hook 注入
- **必须**：
  - 函数 ≤ 50 行；React 组件 ≤ 150 行（含 JSX）
  - 单文件 ≤ 400 行
  - 异步函数返回类型显式标注 `Promise<T>`
  - 跨进程边界的入参/出参用 `zod` schema 校验，schema 与类型同源（`z.infer`）
  - DTO 与领域类型分离：`*.dto.ts`（边界）/ `*.entity.ts` 或 `*.model.ts`（域）

### 1.2.1 Python 类型安全补强

- 禁 `Any`（确需用 `object` 或受约束的 `TypeVar`）
- 禁 `# type: ignore` 不带原因；必须 `# type: ignore[error-code]  # reason`
- 禁 `cast(T, x)` 当 `x` 来自外部输入；走 `pydantic` 校验
- 泛型必须用 `TypeVar(... bound=...)` 或 `Protocol`，禁裸 `TypeVar("T")`
- `mypy --strict` 必须零警告通过

### 1.3 错误处理（两语言共用）

- 内部纯函数互相调用：信任契约，不做防御性校验。
- 系统边界（用户输入、外部 API、文件、网络、跨进程）：必须显式校验并抛出领域异常。
- Python 异常基类 `QuantError`（`packages/py/quant_core/errors.py`）；TS 异常基类 `QuantError`（`packages/shared/errors.ts`）。两边异常**类型字符串**必须一致（`code: "DATA_SOURCE_TIMEOUT"` 等），跨进程序列化通过 RPC 错误码表（见 `docs/integrations/ipc-py-ts.md`）。
- 不允许 `except Exception` / `catch (e)` 后吞掉错误；至少要日志 + 重抛或转换为领域异常。

### 1.4 日志

- Python：`logging.getLogger(__name__)`；禁止 `print`。
- TS：NestJS `Logger`（后端）/ `pino`（前端 server-side）；禁止 `console.log`。
- 等级语义：`DEBUG` 开发期细节 / `INFO` 业务里程碑 / `WARN` 可恢复 / `ERROR` 业务失败 / `FATAL/CRITICAL` 进程级故障。
- **结构化字段优先**（Python：`logger.info("trade_filled", extra={...})`；TS：`logger.info({ symbol, qty }, "trade_filled")`），不要拼字符串。
- 跨进程调用必须带 `trace_id`，由入口生成、向下游透传。
- **LLM 调用日志强制结构化**：每次 NestJS `LlmService` 调用必须输出 `provider`、`model`、`scope`（agent/screen/analyze/...）、`usage`（input/output/total tokens）、`durationMs`、`traceId`、`userId` 字段。失败路径同样记录（usage 字段允许缺失）。配套写入 `UserLlmLedgerStore` 由 recorder 完成，不要在调用点手写双份。

### 1.5 注释

- 默认不写注释。只在"为什么"非显而易见时写一行：隐藏约束、特定 bug 的 workaround、与文档冲突的取舍。
- 禁止：复述代码做了什么；无负责人/日期的 TODO；引用当前任务/PR/issue。

---

## 2. 模块化与解耦（硬性）

### 2.1 进程拓扑

```
┌─────────────┐    HTTP/SSE     ┌──────────────┐  Arrow Flight (gRPC)  ┌──────────────┐
│  Next.js    │ ──────────────> │   NestJS     │ ────────────────────> │  Python svc  │
│  (frontend) │ <────────────── │  (backend)   │ <──────────────────── │  (compute +  │
└─────────────┘                 └──────────────┘                       │   LangGraph) │
                                                                       └──────────────┘
```

- **Next.js**：UI、用户交互、SSR 渲染、SSE/WS 接收长任务进度。**不直接调外部数据源/LLM**。
- **NestJS**：HTTP API 网关、参数校验、任务编排（短任务）、缓存读取、调度 Python 服务、**外部 LLM 客户端**（OpenAI 兼容协议；DeepSeek / Moonshot / Qwen / Doubao / OpenAI）。LLM provider 注册表与 token ledger 持久化都在 NestJS 侧；上层 service 通过 `LlmService` 统一调用。v1 不做鉴权（监听 127.0.0.1）。
- **Python service**：行情/新闻拉取与缓存写入、筛选/形态/舆情计算、LangGraph 工作流。**Python 不再持有外部 LLM 客户端**；如未来 LangGraph 节点需要 LLM 推理，反向 RPC 调 NestJS `LlmService`。

### 2.2 仓库结构（monorepo, pnpm workspaces + uv）

```
apps/
  web/                          # Next.js 前端
  api/                          # NestJS 后端
packages/
  shared/                       # TS 共享：类型、zod schema、错误码、API client SDK
  ui/                           # React 共享组件
services/
  py/                           # Python 服务根
    quant_core/                 # 域 + 业务（详见 §2.3）
    quant_compute/              # 计算密集模块（screening / pattern / sentiment）
    quant_io/                   # 数据源 adapters
    quant_cache/                # 缓存 adapters
    quant_workflow/             # LangGraph 编排（v2，反向 RPC 调 NestJS LlmService 取 LLM 推理）
    quant_rpc/                  # Arrow Flight server
proto/                          # Arrow schema (.fbs) + RPC 契约（共享）
docs/                           # 工程文档
tests/                          # 镜像 src 路径
```

### 2.3 Python 内部分层（强制）

```
domain/        # 纯领域模型与规则（K线/股票/筛选条件 AST/形态/舆情主题）；不依赖外部框架/IO
services/      # 业务编排；只依赖 domain 与 ports
ports/         # 抽象接口（Protocol / ABC）
adapters/      # ports 的具体实现：tushare/akshare、Parquet、Redis、LLM
io/            # 数据读写边界：parser/serializer/HTTP 客户端
config/        # 配置加载（pydantic-settings）
rpc/           # Arrow Flight server 入口
workflow/      # LangGraph 节点与图
```

**依赖方向**：`rpc/workflow → services → domain`，`services → ports ← adapters`。
`domain` 禁止 import `adapters/io` 或任何具体 SDK。

### 2.4 NestJS 内部分层（强制）

```
modules/
  <feature>/
    <feature>.controller.ts     # 路由，只做参数校验（zod-pipe）+ 转 service
    <feature>.service.ts        # 业务编排，调 ports
    <feature>.module.ts         # 依赖装配
    dto/                        # zod schema + 类型
    domain/                     # 纯领域类型 + 函数（无装饰器、无 nest 依赖）
ports/                          # 抽象接口（pure TS）
adapters/                       # ports 具体实现（含 Arrow Flight client）
common/                         # 守卫、拦截器、过滤器、logger
config/                         # @nestjs/config + zod 校验
```

**依赖方向**：`controller → service → ports ← adapters`。
`domain/` 子目录纯函数 + 不可变类型，不依赖 NestJS 装饰器，便于复用与测试。

### 2.5 Next.js 约束

- 路由用 App Router（`app/`）。
- **服务端组件优先**；仅交互必要的叶子组件用 `"use client"`。
- 数据获取：服务端组件直接 `fetch`（带缓存策略）调 NestJS；客户端用 `@tanstack/react-query`。
- 长任务进度：SSE（`EventSource`）或 WebSocket，在 NestJS 侧 fan-out。
- UI 状态用 Zustand（轻）；表单 `react-hook-form` + zod。
- 业务逻辑禁止写在组件里，抽到 `lib/` 纯函数。

#### Feat 组件强制规约

- **Feat = pane 级别的功能单元**，命名空间为 `[MODULE].[FEATURE]`（见 `apps/web/lib/eqty/feat.ts`）。
- 每个 Feat 在 `apps/web/components/` 下有独立目录 `feat-<module>-<feature>/`（kebab-case，如 `feat-sys-stat/`、`feat-eq-chart/`）；目录主组件文件与目录同名（`feat-sys-stat.tsx`），导出函数命名为 `Feat<Module><Feature>`（如 `FeatSysStat`）。Feat 私有的子组件 / 对话框 / 表单放在同一目录下。
- **所有 Feat 组件的根节点必须使用 `<FeatView feat={Feat.X}>` 包裹**（来自 `components/feat-view/feat-view.tsx`）。`FeatView` 统一负责 pane chrome、`featViewMode`（normal / minimized / fullscreen）持久化、overlay / 默认最小化等行为。直接渲染裸 DOM 或自行实现 pane 外壳的 Feat 组件一律拒收。
- `feat-view/` 下的 `FeatView`、`FeatViewStatus`、`FeatViewAction`、`FeatViewHeaderRight` 是唯一被允许跨 Feat 共享的 pane 原语；其它 Feat 之间不得互相 import 私有子组件，需要复用就抽到 `packages/ui/` 或 `apps/web/lib/`。

### 2.5.1 类型与纯函数 = 核心资产（强制）

**类型定义和纯函数是项目的核心资产，必须独立维护、与框架解耦、随时可被其它模块/服务复用。**

每个进程内必须有专门目录承载这两类资产，且这些目录：

- 不依赖任何框架（NestJS 装饰器、Next.js 钩子、pydantic 之外的运行时基类等）
- 不做 IO（不 import adapters、io、http 客户端、数据库驱动）
- 不依赖配置（不读 env / 不用全局 settings）
- 可以被任何其它目录 import；它们 **不能** import 同进程的非核心目录

**Python 侧**（`services/py/quant_core/`）：

```
domain/
  types/        # 纯类型定义（@dataclass(frozen=True, slots=True) / TypedDict / Protocol）
  pure/         # 纯函数（无副作用、无 IO、参数确定 → 返回值确定）
  rules/        # 业务规则函数（同样纯，但聚焦业务语义，如"计算前复权"、"判断涨停"）
```

**TypeScript 侧**：

```
packages/shared/
  types/        # 跨 app 共享类型（zod schema + z.infer 类型）
  fp/           # 跨 app 共享纯函数（数学、日期、字符串、不可变容器）
apps/api/src/modules/<feature>/
  domain/
    types.ts    # 该 feature 的领域类型
    pure.ts     # 该 feature 的纯计算函数
apps/web/lib/
  types/        # 前端专用类型（UI state、视图模型）
  fp/           # 前端专用纯函数（formatters、selectors）
```

**强制约束**：

- `domain/`、`packages/shared/`、`lib/fp/`、`lib/types/` 中**禁止**出现：`fetch`、`axios`、`fs`、`db`、`Logger`、`@Injectable()`、`useEffect`、`useState`、任何 `*.adapter.ts` 的 import。
- 任何"看似纯但偷偷读了全局"的函数（如 `Date.now()`、`Math.random()`、`process.env`）必须把依赖作为参数传入。
- 这些目录的测试**只用** unit 测试，零 mock，零 fixture（除了输入数据）。如果要 mock 才能测，说明它不纯，应当移出。
- code-reviewer 在审查时必须显式检查"是否有不该出现在 core 目录的依赖"，违反 = MAJOR。

### 2.5.2 复用性（强制原则，但要避免过度抽象）

- **复用优先于复制**：同一逻辑在 ≥ 2 处出现且未来可能再出现 → 抽到核心目录。但**不要**为单一调用点造抽象。
- **Rule of three**：第三次重复出现时再抽象；第二次先标记 `// REUSE-CANDIDATE: <ref>`，第三次出现时一并抽走。
- **跨语言可复用的逻辑必须放 `proto/` 或脚本生成**：避免 TS 与 Py 各写一份对账逻辑——schema 由 `proto/` 生成、纯算法（如前复权计算）以 Python 为唯一实现，TS 通过 RPC 调用，禁止手写第二份。
- **抽象的代价高于重复**：当抽象本身需要 ≥ 3 个参数才能覆盖差异，或抽象的实现里出现 if-else 分支区分调用者，说明抽象错了——退回去保持重复。
- **禁止"先抽象再使用"**：不允许写一个工具函数但当前没有调用者；除非是被生成代码占位。

### 2.6 函数与类（共用）

- **单一职责**：函数只做一件事；类只有一个变化原因。
- **纯函数优先**：能写成纯函数就不要写成方法；能不持有状态就不持有状态。
- **依赖注入**：外部依赖（client、session、clock、随机源）必须通过参数/构造函数传入；禁止函数体内直接 import 全局单例。
- **禁止上帝对象**：超过 7 个公共方法或 200 行的类必须拆。
- **禁止隐式时间/随机**：用 `Clock` / `Rng` 端口注入；测试必须可复现。

### 2.7 数据流与类型

- Python 边界用 `pydantic.BaseModel`，域内部用 `@dataclass(frozen=True, slots=True)`。
- TS 边界用 `zod` schema + `z.infer<typeof S>`；域内部 `readonly` 类型 + `Object.freeze`（或用 `immer`）。
- 优先不可变；更新返回新对象（Python `model_copy(update=...)` / `dataclasses.replace`；TS 展开运算符或 `immer`）。
- 不在多个层之间传裸 `dict` / `Record<string, unknown>`；传强类型对象。

### 2.8 量化领域专项

- 价格、数量、金额：Python 用 `Decimal`；TS 用 `decimal.js` 或 `bignumber.js`，**禁止用 `number` 表示金额**。
- 时间统一 `datetime` 带 tz（UTC），存储 ISO8601；禁止 naive datetime。前端展示再转 `Asia/Shanghai`。
- 回测 / 实盘共享同一 `Strategy` 接口，区别只在 adapter（`BacktestBroker` vs `LiveBroker`）。
- 所有随机性必须接受 `seed` 参数；默认无种子的随机调用视为 bug。
- **日线数据入库时**必须预计算并落库：前复权价（`open_qfq/high_qfq/low_qfq/close_qfq`）、基于前复权 close 的 `ma5/ma10/ma20/ma60`。详见 `docs/modules/02-stock-kline.md`。

### 2.9 多用户与鉴权（强制）

- **用户态文件存储统一走 `apps/api/src/common/user-scoped-store.ts` 的 `UserScopedJsonStore<T>`**——按 `data/users/{userId}/...` 分区。新增"用户态"模块（个人账本、自选、个人偏好等）必须复用该工具，不得另写一套 mutex / atomic-write / throttle。
- **shared market data 留在 `data/<module>/...` 共享目录**：kline / sectors / blacklist / sentiment / ta / meta / watch universe 不按用户分区。
- **NestJS 控制器获取用户**：始终通过 `@CurrentUser()`（`modules/auth/current-user.decorator.ts`）取 `AuthenticatedUser.id`，**不要**让客户端在 body / query 里传 userId。
- **Service 方法签名**：所有用户态 service 方法第一参数为 `userId: string`；DTO 不含 userId。
- **`AUTH_MODE` 开关**：`disabled`（默认）注入 `admin` 用户，`oauth` 走 Feishu。两端共用同一份代码，差异只在 env。
- **userId 派生**：单一函数 `deriveUserId(provider, externalId, tenantKey)`（在 `modules/auth/ports/oauth-provider.port.ts`）。Web 登录与 IM 入口必须经此派生，保证同一人 → 同一 userId。
- **IM 命令入口不走 `AuthGuard`**：`AuthService.resolveFromIm` 直接产出 `AuthenticatedUser`，dispatcher 调 service 时第一参数即为 `userId`。详见 `docs/integrations/auth.md`。
- **Python 服务用户无关**：`services/py/quant_rpc/*` 永远不应出现 `userId` 字段。所有用户分区在 NestJS 帧内完成。

### 2.10 配置项 / env（强制）

- **凡新增任何运行时读取的 env 变量（NestJS / Next.js / Python 任一进程）必须同步加进仓库根的 `.env.example`**——这是 onboarding 唯一可信来源。漏写视为本提交未完成。
- 模板条目结构：① 上方一行注释指明用途 + 关联文档（`see docs/...`），② 默认值 / 是否必填，③ 可选枚举或取值范围。**不要**把真实 key / token 写进示例。
- 同主题的变量分组放在同一个 `# ---- <module> ---- ` 区段下，保持表头一致；新区段紧贴最相关的老区段后。
- 删除 / 改名一个 env 变量时一并更新 `.env.example` 与所有引用它的文档（`docs/architecture.md` / `docs/integrations/*` / `README.md`）。CI 不会自动 catch 漏改。
- 共享给前端的变量必须以 `NEXT_PUBLIC_` 开头并双写 NestJS + Next.js（参考 `AUTH_MODE` / `NEXT_PUBLIC_AUTH_MODE` 模式）。
- 仅供生成密钥 / 长 token 的项写明生成方式（如 `openssl rand -hex 32`）；不要让用户去搜命令。

---

## 3. 测试（硬性）

### 3.1 覆盖率与结构

- **新增/修改的代码行覆盖率 ≥ 90%**，分支覆盖率 ≥ 80%。
- 测试目录镜像源码目录：
  - Python：`services/py/quant_core/foo.py` ↔ `services/py/tests/quant_core/test_foo.py`
  - NestJS：`apps/api/src/modules/foo/foo.service.ts` ↔ `apps/api/test/modules/foo/foo.service.spec.ts`
  - Next.js：`apps/web/lib/foo.ts` ↔ `apps/web/__tests__/lib/foo.test.ts`
- 命名：`test_<函数>_<场景>_<期望>` / `it("<scenario> should <expected>")`。

### 3.2 测试分类

| 类型        | Python 标记                | TS 标记                        | 范围                   | 速度   |
| ----------- | -------------------------- | ------------------------------ | ---------------------- | ------ |
| unit        | `@pytest.mark.unit`        | `*.test.ts`                    | 单函数/类，纯逻辑      | < 50ms |
| integration | `@pytest.mark.integration` | `*.spec.ts`                    | 跨模块，含真实 adapter | < 1s   |
| e2e         | `@pytest.mark.e2e`         | `*.e2e-spec.ts` / `playwright` | 完整入口               | 不限   |
| property    | `@pytest.mark.property`    | `fast-check`                   | 性质测试               | < 1s   |

CI 默认跑 unit + integration；e2e 单独触发。

### 3.3 必备测试场景

对每个新增/修改的公共函数，必须覆盖：

1. **golden path**：典型输入 → 预期输出
2. **边界**：空、零、最大、最小、单元素、负数（如适用）
3. **异常路径**：每个 `raises` / `throws` 都要触发
4. **不变量**：对偶/可逆/幂等（如适用）
5. **回归**：每修一个 bug 必须先写复现该 bug 的失败测试

### 3.4 测试质量规则

- 一个测试只断言一件事；用参数化 / `it.each` 覆盖多组数据，不要 if/else 分支。
- **禁止 mock 数据库**——用真实 sqlite / 内存 / testcontainer；mock 仅用于外部网络与不可控时间/随机。
- **跨进程契约测试**：Python 与 TS 共享 `proto/` 下的 schema；契约变更必须同时更新两侧测试。
- **时间与随机必须可控**：注入 `FrozenClock` / `SeededRng`，避免全局 patch。
- 每个测试 ≤ 30 行；超过即拆 fixture / helper。
- 共用 fixture 放就近的 `conftest.py` / `test-utils/`。
- 禁止测试间共享可变状态。

### 3.5 命令

- Python 全部：`pytest -q`
- Python 覆盖率：`pytest --cov=services/py --cov-branch --cov-report=term-missing --cov-fail-under=90`
- NestJS：`pnpm --filter api test` / `... test:cov`
- Next.js：`pnpm --filter web test`
- 全量门禁：`pnpm check` （脚本聚合：prettier check + eslint + tsc + jest + vitest + ruff format check + ruff check + mypy strict + pytest cov）

---

## 4. 自动 Review 机制（硬性）

### 4.1 触发时机

按 §0 步骤 4 的策略触发，不要无差别介入。摘要：

- **必须触发**：用户显式要求（`/review` / "审一下"）；milestone / feature 收尾且含非平凡业务逻辑；跨进程契约（`proto/` / Arrow schema）变更。
- **不要触发**：脚手架、配置调整、格式化、文档/注释改动、单文件且 `pnpm check` 已绿的小重构。
- 常驻门禁是 `pnpm check`，reviewer 是抽样而非每次。

### 4.2 Review 维度

reviewer 必须按以下维度逐项检查并打分（pass / minor / major / blocker）：

1. 是否违反第 1 章代码风格（含语言专属）
2. 是否违反第 2 章模块化分层（含进程拓扑、跨语言契约）
3. 测试是否齐全（第 3 章）
4. 是否引入安全问题（注入、未校验输入、密钥/凭据硬编码、时间/随机不可控、CORS/CSRF/SSRF）
5. 是否引入性能陷阱（O(n²) on 主路径、循环内 IO、未释放资源、N+1、跨进程多次小调用）
6. 是否破坏既有契约（HTTP API、Arrow schema、Python public API）
7. 文档与日志是否同步更新（特别是 `docs/integrations/*` 和 `docs/modules/*`）

### 4.3 Verdict 格式

```
Review of <files>:
- Style: PASS | MINOR(...) | MAJOR(...) | BLOCKER(...)
- Modularity: ...
- Tests: ...
- Security: ...
- Performance: ...
- Contracts: ...
- Docs/Logs: ...

Verdict: APPROVE | REQUEST_CHANGES
Required fixes (if any):
1. ...
```

`MAJOR` 与 `BLOCKER` 必须修复后再次 review，直到 `APPROVE` 才视为完成。

---

## 5. 工具与命令

### Python

| 任务     | 命令                                                        |
| -------- | ----------------------------------------------------------- |
| 格式化   | `ruff format . && ruff check --fix .`                       |
| 类型检查 | `mypy --strict services/py`                                 |
| 单测     | `pytest -q -m "unit or integration"`                        |
| 覆盖率   | `pytest --cov=services/py --cov-branch --cov-fail-under=90` |

### TypeScript

| 任务        | 命令                                             |
| ----------- | ------------------------------------------------ |
| 格式化      | `pnpm prettier --write . && pnpm eslint --fix .` |
| 类型检查    | `pnpm -r tsc --noEmit`                           |
| 单测（API） | `pnpm --filter api test`                         |
| 单测（Web） | `pnpm --filter web test`                         |
| E2E         | `pnpm --filter web test:e2e`（playwright）       |

### 全量门禁

- `pnpm check`：根 `package.json` 中聚合脚本，依次跑 TS 栈（prettier check + eslint + tsc + jest + vitest）和 Py 栈（`uv run` 包装的 ruff format check + ruff check + mypy --strict + pytest --cov`），任一失败即非 0 退出。

---

## 6. Git 与提交

- 一次提交只做一件事；标题 ≤ 72 字符，祈使句。约定式 prefix：`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`。
- 不允许 `git commit --no-verify`（除非用户显式要求）。
- 不允许 `git push --force` 到 `main` / `master`。
- 提交信息正文写"为什么"，不写"做了什么"——后者看 diff。
- 跨进程契约变更（`proto/`、Arrow schema、HTTP API）必须独立提交，标题前缀 `contract:`。

---

## 7. 当本规约与请求冲突时

- 用户的具体指令 > 本规约通用条款；但**安全/正确性条款不可让步**（密钥硬编码、测试为空、跳过类型检查等永远要拒绝并说明）。
- 不确定时先问，不要默默偏离。

---

## 8. 跨进程契约（强制）

### 8.1 Schema 单一源

- 所有 Python ↔ NestJS 数据结构定义在 `proto/` 目录下：
  - Arrow schema（`.fbs` 或 `pyarrow.Schema` 生成的 JSON）用于批量列存（K线、新闻列表等大对象）
  - 控制平面消息（请求、参数、错误）用 protobuf `.proto`
- 由代码生成器同时产出 Python（pydantic 类）和 TS（zod schema + 类型）。两侧手写 schema 一律拒收。

### 8.2 错误码表

- 所有跨进程错误码集中在 `proto/errors.proto`（或同等 JSON），双侧通过生成器引入。
- 错误必须带 `code`（机读，UPPER_SNAKE_CASE）、`message`（人读）、`details`（结构化字段，可选）、`trace_id`。

### 8.3 版本与兼容

- Schema 变更遵守语义版本：新增字段（向后兼容）走 minor；删除/重命名字段走 major，必须配迁移说明 + 双写期。
- 每次 schema 变更必须新增契约测试：用旧 client 调新 server / 反向，断言行为符合兼容性声明。

### 8.4 调用规范

- 长任务（>2s）必须返回 `task_id`，用 SSE / 轮询查进度，不要长 hold HTTP 连接。
- 大数据集（>1MB）必须走 Arrow Flight 列存通道，不要塞进 JSON。
- 频繁小调用必须批量化（一次传一组 symbol，不要 N 次循环调）。

---

## 9. 通用工程原则（强制）

### 9.1 数据归一化

- 同一概念在系统内只允许一种规范表示，进入业务层前完成归一化：
  - 金额 / 价格 / 数量：`Decimal` / `decimal.js`，统一精度与四舍五入策略。
  - 枚举：定义在 `proto/` 或核心 types 目录中，禁止散落字面量。
- 归一化函数放在核心目录（`domain/pure/` 或 `packages/shared/fp/`），并被边界层（adapters / dto）唯一调用；业务层假设数据已归一化，不做二次清洗。
- 外部输入（HTTP / RPC / 文件）必须在边界一次完成校验 + 归一化，再进入域，禁止"边用边修"。

### 9.2 模块可插拔与测试替身

- 业务模块对外部依赖（数据源、缓存、LLM、broker、clock、rng 等）必须通过 **ports（Protocol / 抽象接口）** 而非具体 SDK 编程；adapter 注册在装配层（NestJS `Module` / Python `services` 工厂 / Next.js DI 容器）。
- 切换实现的成本必须 = 0：替换一个 adapter 不需要改动 service / domain / 调用方。
- 每个 port 必须同时存在生产 adapter 与至少一个测试替身（`FakeXxx` / `InMemoryXxx`）；测试替身放在 `tests/fakes/` 或 `test-utils/`，对外行为与真实 adapter 一致。
- 禁止在 service / domain 中 `import` 具体 adapter 模块或具体 SDK；违反 = MAJOR。
- 配置驱动切换：`adapter` 选择由 env / config 决定，代码路径不要写 `if env === 'test'` 这类分支。

### 9.3 性能是第一优先级

- 写代码前先估算主路径的复杂度与数据规模，挑选合适的数据结构与算法；不要先写再优化。
- 主路径禁止：循环内 IO、N+1 查询、未必要的 JSON 反复 parse、跨进程多次小调用（参考 §8.4 批量化）、列表 / 表格 UI 不走虚拟化。
- **Parquet 不要按业务主键分到 ≥ 1000 文件**：DuckDB `read_parquet(list-of-N-paths)` 在 N > 几百时调度开销显著；A 股 5500 个 per-code parquet 是反例。改为按 prefix 分到 ≤ 50 个 `<prefix>.parquet` 扁平文件 + 整 partition rewrite 写。基准：`docs/perf/kline-write.md`。
- **每天跑一次的 batch 任务不要为"写延迟"加 LSM/delta**：实测 50 ms 整文件 rewrite 已经够快，delta+compaction 多出的运维（delta 失控告警、compaction cron、文件夹层级）不划算。除非写 QPS 高到单次 rewrite 撑不住，否则始终 rewrite。同上基准。
- 大对象走列存（Arrow）；热点查询走索引 / 预计算（如日线前复权与 `ma*` 入库时即算好，详见 §2.8）；幂等结果走缓存。
- 任何"看起来无所谓"的循环、map、filter 在 N ≥ 1e4 时都要重新评估；优先 streaming / 分块处理而非整表加载。
- 性能相关代码必须有可复现的基准（micro-benchmark / load test），改动需对比前后数据，禁止凭感觉判断"更快了"。

### 9.4 性能优化记录

- 任何性能优化改动必须在 `docs/perf/<topic>.md` 留档，内容含：
  1. 背景与瓶颈定位（profile 截图 / 日志 / 指标）
  2. 方案与权衡（为何选 A 不选 B）
  3. 量化结果（前后对比：p50 / p95 / 吞吐 / 内存，越具体越好）
  4. 回归风险与监控点
- 文档落地后，把可复用的经验、踩坑与"下次别再这么干"以一行规则形式回写到本 `CLAUDE.md` 的相应章节（通常是 §9.3 或 §2 模块化章节），保持本文件是真理之源。
- 没有量化结果的优化视为未完成；不允许仅凭"我觉得更快了"合入主干。
