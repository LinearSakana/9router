# Repository Guidelines

## 1. 项目定位与系统边界
9Router 是基于 Next.js 的本地 AI 路由网关与管理面板。对外统一提供 OpenAI 兼容接口 ` /v1/* `，对内负责多上游 Provider 的协议翻译、流式处理、账号回退、模型组合回退、用量记录与可选云同步。

### In Scope
- 本地网关运行时与 Dashboard 管理 API
- Provider OAuth/API Key 接入与 token 刷新
- OpenAI/Claude/Gemini/Responses 等格式互转
- 本地状态持久化（providers、keys、aliases、combos、settings、pricing）
- usage/log 统计与查询
- 可选 Cloud Sync 编排

### Out of Scope
- `NEXT_PUBLIC_CLOUD_URL` 背后的云服务实现
- 上游 Provider 的 SLA/控制面
- 外部 CLI 二进制（Claude/Codex/Gemini CLI 等）

## 2. 目录与模块职责
- `src/app/api/v1/*`、`src/app/api/v1beta/*`：兼容层 API（核心对外入口）。
- `src/app/api/*`：管理与配置 API。
  - auth/settings: `src/app/api/auth/*`, `src/app/api/settings/*`
  - providers/nodes: `src/app/api/providers*`, `src/app/api/provider-nodes*`
  - oauth: `src/app/api/oauth/*`
  - aliases/combos/keys/pricing: `src/app/api/models/alias`, `src/app/api/combos*`, `src/app/api/keys*`, `src/app/api/pricing`
  - usage: `src/app/api/usage/*`
  - sync/cloud: `src/app/api/sync/*`, `src/app/api/cloud/*`
  - cli-tools: `src/app/api/cli-tools/*`
- `src/sse/*` + `open-sse/*`：SSE/routing 核心。
  - 入口：`src/sse/handlers/chat.js`
  - 核心编排：`open-sse/handlers/chatCore.js`
  - 执行器：`open-sse/executors/*`
  - 翻译注册：`open-sse/translator/index.js`
  - 回退策略：`open-sse/services/accountFallback.js`
  - 流处理：`open-sse/utils/stream.js`, `open-sse/utils/streamHandler.js`
  - 用量抽取：`open-sse/utils/usageTracking.js`
- `src/lib/localDb.js`：主状态库，默认 `${DATA_DIR}/db.json`（未设则 `~/.9router/db.json`）。
- `src/lib/usageDb.js`：`~/.9router/usage.json` 与 `~/.9router/log.txt`。
- `cloud/`：Cloudflare Worker（`cloud/src`、`cloud/migrations`、`wrangler.toml`）。
- `docs/ARCHITECTURE.md`：架构真相源（修改核心链路前必须先读）。

## 3. 关键运行链路（必须保持稳定）
兼容 API 的主路径：
1. Client 调用 `POST /v1/chat/completions`
2. 路由到 `src/app/api/v1/chat/completions/route.js`
3. 进入 `src/sse/handlers/chat.js` 做模型/combo 解析
4. 调用 `open-sse/handlers/chatCore.js` 做格式识别与请求转换
5. 选择 executor 调上游，必要时触发 token 刷新重试
6. 流或 JSON 响应标准化后回传
7. usage/log 通过 `src/lib/usageDb.js` 落盘

不要破坏以下约束：
- `/v1/*` 与 `/api/v1/*` 的 rewrite 语义一致
- 翻译层与执行层解耦（不要把 provider 专用逻辑塞进 route handler）
- 非流式调用的 SSE->JSON 兼容行为保持可用

## 4. Fallback 策略与可靠性要求
- 账号 Fallback：同 provider 下账号轮转/降级（`accountFallback`）。
- combo Fallback：当前模型不可用时按 combo 顺序尝试下一模型。
- 鉴权恢复：401/403 触发 refresh 后重试。
- 失败原则：仅在可判定的 fallback-eligible 错误上回退，避免无限重试。

涉及回退逻辑改动时，至少验证：
- 单 provider 多账号失效切换
- combo 多模型顺序回退
- token refresh 后恢复请求
- 最终不可用时错误语义清晰

## 5. OAuth、认证与安全面
- Dashboard 登录与 Cookie 认证：`src/proxy.js`、`src/app/api/auth/login/route.js`。
- API Key 生命周期：`src/shared/utils/apiKey.js` + `/api/keys*`。
- OAuth 流：`/api/oauth/[provider]/[action]`，接入成功后写入 provider connection，再通过 `/api/providers/[id]/test` 验证。
- 安全硬要求：
  - 公网部署启用 `REQUIRE_API_KEY=true`
  - 覆盖默认 `INITIAL_PASSWORD`
  - 避免在日志/PR 中泄露 provider token 或 key

## 6. Cloud Sync 约定
- 入口：`/api/sync/cloud` 与相关 `/api/cloud/*`。
- 调度：`src/lib/initCloudSync.js` + `src/shared/services/cloudSyncScheduler.js`。
- 配置优先级：生产优先 `BASE_URL`、`CLOUD_URL`；`NEXT_PUBLIC_BASE_URL`、`NEXT_PUBLIC_CLOUD_URL` 仅兼容/UI。
- 网络异常处理：保持 timeout + fail-fast，避免 UI 长时间挂起。

## 7. 数据与状态约束
- 主状态实体：providerConnections、providerNodes、modelAliases、combos、apiKeys、settings、pricing。
- 用量数据：usage history 与 request logs。
- 已知约束：`usageDb` 当前不跟随 `DATA_DIR`，排障必须同时检查 `db.json` 与 `~/.9router/usage.*`。

## 8. 开发、构建、验证命令
- `npm run dev`：本地开发（README 示例端口 `20128`）。
- `npm run build`：生产构建。
- `npm run start`：生产启动。
- `npx eslint .`：代码质量基线。
- `node tester/translator/testFromFile.js <json-file>`：翻译结果回放测试。
- `cd cloud && npm run dev`：Worker 本地调试。
- `cd cloud && npm run deploy`：Worker 发布。

## 9. 代码风格与命名
- JavaScript ESM；保持 `import/export` 一致。
- 2 空格缩进、双引号、分号（与现有代码一致）。
- React 组件 PascalCase；工具/服务模块 camelCase；路由文件统一 `route.js`。
- 优先使用 `@/*` 与 `open-sse/*` 路径别名，减少深层相对路径。

## 10. Agent 协作规则（本仓库专用）
- 改动前先定位所属层：兼容 API、管理 API、SSE 核心、执行器、翻译器、持久化、云同步。
- 优先小步改动，禁止跨层“大一统”重构。
- 任何改动若触及 `/v1/*` 语义，必须做端到端冒烟：
  - `GET /v1/models`
  - `POST /v1/chat/completions`（`stream=true/false`）
- 发现与本文档不一致的实现时，以 `docs/ARCHITECTURE.md` 为优先依据，并在 PR 中注明偏差与修复策略。
