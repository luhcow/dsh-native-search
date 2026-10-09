# DSH Native Search

**Native hosted web search for DeepSeek Harness — one request, verified search evidence, no fallback.**

[![Tests](https://github.com/luhcow/dsh-native-search/actions/workflows/test.yml/badge.svg)](https://github.com/luhcow/dsh-native-search/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](<LICENSE>)

这个实验性 Host 插件把**已连接模型提供商的原生托管网页搜索**接入 DSH 的 `web.search` 服务，供原有的 `web_search` 工具使用。项目名称为 **DSH Native Search**；为保持已有配置兼容，插件包名仍为 `@creait/dsh-provider-web-search`。

搜索是一次**独立的模型请求**，走配置路由的端点与凭据引用。只发送当前搜索词，不发送对话历史，不修改 DSH 核心，也不把搜索工具注入主聊天请求。

**严格单请求、无重试、无降级、无续接。** 每次插件搜索至多发出一次 HTTP POST；服务端可在这次请求内部多次搜索。不把模型自由回答或仅有引用链接的回答伪装成搜索结果。

## 支持的接口

协议选择优先级：**插件显式 `protocol` > 模型 `api` > 路由 `api` > 未声明 `api` 时的已知提供商默认值**。

已声明但不支持的 `api` 会在解析凭据和发送请求前失败，不会因为提供商叫 `openai`、`xai` 或 `github-copilot` 就自动改打 Responses。显式设置 `protocol` 表示用户确认这个端点另外实现了该原生搜索协议；插件不会探测或回退到其他端点。

| 协议 / 路由 | 原生请求与搜索证据 |
| --- | --- |
| `openai-responses`（路由 `azure-openai-responses` 同样映射此协议） | `POST /responses`，`tools: [{ type: "web_search", ... }]`；必须有已完成的 `web_search_call` |
| `anthropic-messages` | `POST /v1/messages`，`web_search_20250305`；必须有 ID 配对的 `server_tool_use` 与成功的 `web_search_tool_result` |
| `google-generative-ai` | `models/{model}:generateContent`，`google_search`；必须有有效的 `webSearchQueries` 或 web `groundingChunks` |
| `xai-responses` | xAI Responses `web_search`；同样必须有已完成的 `web_search_call`，`citations` 仅补充来源 |
| `copilot-responses` | Copilot Responses `web_search`；凭据必须已经是可用 token，不实现 OAuth 刷新，端点须满足严格 Responses 校验 |

没有 `api` 时，`openai`、`anthropic`、`google`、`xai`、`github-copilot` 分别使用上表的默认协议。xAI/Copilot 专用适配仍属实验性，并不保证任意账号、模型或网关可用。

**已移除 Moonshot `$web_search` 的 Chat Completions 多轮往返实现、`moonshot-chat` 协议及其默认路由。** 不支持普通 Chat Completions、Bedrock、Vertex、ChatGPT 订阅 OAuth 或 `openai-codex-responses` 路由。不再把 Codex/OAuth 路由暗中映射到公共 OpenAI API。这是本插件的支持范围，不代表所有 Chat Completions 接口在技术上都不可能提供原生搜索。

## 安装与配置

此仓库提供可打包的 DSH 插件 bundle，要求 Node.js **20.3.0+**，当前 DSH peer 版本为 **0.2.0-rc.2**。GitHub 公开源码不等于已经发布到 npm；目前可从源码打包：

```bash
git clone https://github.com/luhcow/dsh-native-search.git
cd dsh-native-search
npm test
npm pack --ignore-scripts
```

单元测试不需要安装 DSH 运行时依赖，也不会读取凭据或发出真实搜索请求。将生成的 `.tgz` 交给目标 DSH profile 的插件管理器安装；由管理器解析运行时依赖并检查版本兼容性。

安装后补丁会创建 `provider-web-search` 条目，但不会自动切换搜索提供方。若管理器报告需要重启，请重启 DSH 后使用。修改本地源码不会自动替换已经安装的旧版本。未来若发布到 npm，才可使用对应的 npm 包名安装。

在插件配置或 profile 补丁的 `provider-web-search` 条目设置：

```yaml
- insert:
    - id: provider-web-search
      name: '@creait/dsh-provider-web-search'
      config:
        provider: anthropic
        model: claude-sonnet-4-5
        searchContextSize: medium
        timeoutMs: 30000
```

`provider` 是 DSH 模型路由 ID，`model` 是该路由上支持托管搜索的模型 ID。内置 `openai`、`anthropic`、`google`、`xai` 可以沿用默认端点和凭据名（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`XAI_API_KEY`）。先在 DSH 模型设置中配置凭据；插件每次搜索重新解析引用，不缓存密钥。`github-copilot` 没有默认凭据名，必须配置 `apiKeyEnv`。

自定义路由在 `llm-pi-ai` 中提供 `baseURL`、`apiKeyEnv`，以及可识别的 `api`（或在插件中显式设置 `protocol`）。例如 xAI 的聊天路由若声明 `api: openai-completions`，需在插件中显式配置 `protocol: xai-responses` 才会使用其独立 Responses 搜索接口。

`baseURL` 应为 API 根（例如 `https://api.example.com/v1` 或 `https://api.anthropic.com`），不要填写操作端点。默认 `authMode: auto`：Anthropic 用 `x-api-key`，Gemini 用 `x-goog-api-key`，其余用 Bearer。Azure 风格端点可设 `authMode: api-key` 与 `apiVersion: v1`。远程端点要求 HTTPS，仅回环地址允许 HTTP；配置 URL 不得包含用户密码、查询参数或片段。

**最后，手动在 DSH Web 搜索配置中将 `searchProvider` 选为 `provider-responses`。** 不会自动切换搜索提供方；DSH 自带搜索与本插件同时可用且未指定提供方时会报 `WEB_PROVIDER_AMBIGUOUS`。保留原来的 `fetchProvider`：本插件只搜索，正文仍由现有抓取后端处理。撤销选择或卸载即可恢复原方案。未填写模型与路由时插件注册但报告不可用。

## 请求与验收契约

- **纯 query**：OpenAI/xAI/Copilot 使用 `input: query`，Anthropic 使用单条 user message，Gemini 使用 user text part。逐字保留合法 query，不添加 `Search the web for...`、system 提示词或历史。
- OpenAI 使用原生 `tool_choice: "required"` 和 `include: ["web_search_call.action.sources"]`。其余适配不假定所有模型都支持强制工具选择；模型可以正常选择不搜索，但这样的回答无法通过本插件的搜索验收。
- **完成状态优先**：Responses 必须 `status: completed` 且搜索调用已完成；Anthropic 必须 `stop_reason: end_turn` 且调用/结果配对；Gemini 必须 `finishReason: STOP`。HTTP 200 不等于业务成功。Anthropic `pause_turn`、输出上限等未完成状态直接失败，不追加请求。
- **有搜索证据但没有来源允许成功**：例如 Anthropic 成功结果 `content: []`，或 Gemini 有已使用查询但没有 grounding chunks，返回 `sources: []`。没有 URL 不等于没有执行搜索；URL 被安全过滤后也可能为空，不应据此断言零命中。不会补造来源或把无来源文字称为有来源证实的答案。
- **证据不混用**：Responses 的纯 `url_citation`/xAI `citations` 不能代替调用；Anthropic 的孤立结果或只有 `server_tool_use` 不能证明完成；Gemini 空 `groundingMetadata`、只有 `groundingSupports` 或普通文本中的链接不能证明搜索。
- 只返回公开域名形态的 http(s) 来源 URL，不补造标题或 snippet。摘要仍是模型生成的综合回答，不是原始搜索引擎片段。来源属于不可信数据；正文抓取后端必须自行做 DNS、重定向及内网地址检查。

### 失败分类

搜索验收错误带稳定的 `error.code`，消息中也包含该代码；不回显提供商错误响应体或内嵌错误详情。

| 错误码 | 含义 |
| --- | --- |
| `HOSTED_SEARCH_UNSUPPORTED` | 本地已知该协议/路由不在支持范围；不发送请求 |
| `HOSTED_SEARCH_HTTP_ERROR` | HTTP 非成功状态，保留 `error.status`；不重试 |
| `HOSTED_SEARCH_NOT_EXECUTED` | 完整 Responses/Anthropic 响应没有搜索调用证据 |
| `HOSTED_SEARCH_NO_EVIDENCE` | Gemini 没有可验证的搜索证据，不能据此断言端点不兼容 |
| `HOSTED_SEARCH_FAILED` | 提供商/工具内嵌错误、调用失败、拒绝或安全拦截 |
| `HOSTED_SEARCH_INCOMPLETE` | 请求或搜索未完成、原生暂停或输出被截断；不续接 |
| `HOSTED_SEARCH_INVALID_RESPONSE` | JSON 或所需响应结构、状态、调用关联不合法 |

调用方取消和超时仍保留原有异常语义。配置错误、查询/响应大小限制等也会直接失败，不触发协议兼容回退。

## 限制与展示边界

- 默认至多 8 条 URL；DSH 的 `maxResults` 可调整，上限 20。输出最多 2048 tokens，query 上限 4096 字符，响应上限 2 MiB；默认总超时 30 秒，可配置、最多 5 分钟。`searchContextSize` 仅用于 OpenAI Responses。
- 始终使用所配置的固定搜索模型，不随当前会话模型切换。一次插件 POST 不代表整个 Agent 回合只有一次或两次模型请求：主模型通常还要在工具返回后继续生成回答。
- 可用性取决于确切端点、模型、区域、账号权限和工具支持。真实执行证据是按提供商协议字段校验，并非对网关诚实性的独立证明。
- 这里输出的是 DSH 的 `content` / `sources` / `truncated` 服务契约，不是提供商完整原始响应或完整 grounding 展示层。OpenAI/Anthropic 的引用展示及 Gemini 的 Search Suggestions 有各自官方要求；当前契约不携带 Gemini `searchEntryPoint` 的完整展示数据，不能声称仅抽取文字和 URL 就已满足全部终端展示要求。需要面向最终用户直接展示原生 grounding 的产品，应先补齐展示集成。
- Gemini 适配固定为 **generateContent**，不是 Interactions API；两者的搜索调用与引用结构不能混用。

官方参考：[OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)、[Anthropic Web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)、[Gemini generateContent Google Search](https://ai.google.dev/gemini-api/docs/generate-content/google-search?hl=en)、[xAI Web Search](https://docs.x.ai/developers/tools/web-search)。

## 开发验证

```bash
node --test test/*.test.js
```

测试使用伪造的提供商响应和 transport，不执行真实搜索，不读取真实凭据。覆盖纯 query、协议选择、不发请求的失败路由、单请求失败、搜索证据、状态/结构校验、零结果、取消及超时。发布和启用前应在明确接受对应费用与数据边界后，使用目标账号进行端到端验收。
