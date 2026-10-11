# universal-mcp-sdk

跨 Agent 的 MCP Server 开发套件。一次实现，多端接入。

当前工作树的协议回归覆盖 stdio 与 JSON-only Streamable HTTP；历史客户端连通记录不代表新版协议已逐一验收。

SDK 提供通用协议能力。cocos-mcp Product 另行强制本机 loopback、每代服务认证及实例身份，不允许公网隧道、浏览器 Origin 豁免或免认证回退。

---

## 安装

```bash
npm install universal-mcp-sdk
# 或直接复制本目录到你的项目
```

---

## 快速开始

```js
const { createServer, tool, textContent } = require('universal-mcp-sdk');

const server = createServer({
    name: 'my-first-mcp',
    version: '1.0.0',
    tools: [
        tool('hello', '打招呼', { name: { type: 'string' } },
            async ({ name }) => textContent(`Hello, ${name}!`)),
        tool('add', '两数相加', { a: { type: 'number' }, b: { type: 'number' } },
            async ({ a, b }) => textContent(String(a + b))),
    ],
    resources: [
        {
            uri: 'hello://greeting',
            name: 'Default Greeting',
            description: '默认问候语',
            mimeType: 'text/plain',
            read: async () => 'Hello World',
        },
    ],
});

server.start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
```

直接 `node your-server.js` 启动时，SDK 会自动检测运行环境：
- **TTY 终端**（交互式启动）→ stdio 模式
- **非 TTY / 后台服务**（默认）→ HTTP 模式，监听 `http://127.0.0.1:8080/mcp`

HTTP 模式直接执行 bind；若端口已被占用，会从请求端口开始递增重试（最多 20 次），避免“先探测空闲、稍后监听”的并发竞态。需要记录实际 endpoint 时应等待返回值：

```js
const started = await server.start('http');
console.log(started.port, started.host, started.path);
```

需要强制指定模式时：

```bash
node your-server.js --stdio          # 强制 stdio（Claude Code / Cursor 子进程）
node your-server.js --http           # 强制 HTTP
node your-server.js --http --port 9000  # HTTP + 指定端口
```

---

## 完整示例

```js
const {
    createServer,
    tool,
    command,
    staticResource,
    dynamicResource,
    textContent,
    errorContent,
    imageContentFromFile,
} = require('universal-mcp-sdk');

const server = createServer({
    name: 'my-mcp-server',
    version: '2.0.0',
    tools: [
        tool('scene_query_node', '查询场景节点',
            { uuid: { type: 'string' } },
            async ({ uuid }) => {
                const data = await queryNode(uuid);
                return textContent(JSON.stringify(data, null, 2));
            }
        ),
        tool('preview_screenshot', '截图预览页面',
            { path: { type: 'string' } },
            async ({ path }) => {
                const absPath = await captureScreenshot(path);
                return textContent(absPath);
            }
        ),
        command('preview_refresh', '刷新预览', async () => {
            await doRefresh();
            return textContent('ok');
        }),
    ],
    resources: [
        staticResource('project://info', 'Project Info',
            JSON.stringify({ name: 'MyGame', version: '1.0.0' })
        ),
        dynamicResource('scene://tree', 'Current Scene Tree', '当前场景节点树',
            async () => await querySceneTree()
        ),
    ],
});

server.start();
```

---

## 启动模式

| 模式 | 命令 | 适用场景 |
|------|------|---------|
| stdio | `node your-server.js --stdio` | Claude Code / Cursor（子进程） |
| http | `node your-server.js --http --port 8080` | 支持认证、session 与协议协商的本机 HTTP 客户端 |
| auto | `node your-server.js` | 自动检测：TTY → stdio，否则 → HTTP |

---

## 接入协议（Wire Protocol）

任何客户端 / Agent 接入本 SDK 起的 server，都走 **MCP over JSON-RPC 2.0**，协商协议版本 `2025-03-26` 或 `2025-06-18`。stdio 与 streamable-http 两种通道的**消息体格式完全一致**，区别只在传输方式。

### 握手顺序

```
client                                  server
  │── initialize ───────────────────────▶│  必须最先调，换取 protocolVersion / capabilities / serverInfo
  │◀──────────────────────── result ─────│
  │── notifications/initialized ────────▶│  必须发送通知，无 id、无响应
  │── tools/list ───────────────────────▶│  枚举工具
  │◀──────────────────────── result ─────│
  │── tools/call {name, arguments} ─────▶│  调用工具
  │◀──────────────────────── result ─────│
```

### 方法表

| method | params | 响应 | 备注 |
|--------|--------|------|------|
| `initialize` | `{protocolVersion, capabilities, clientInfo:{name,version}}` | `{protocolVersion, capabilities, serverInfo}` | 握手，必须第一个调 |
| `notifications/initialized` | — | 无 | 通知，无 id 不回包 |
| `ping` | — | `{}` | 心跳 |
| `tools/list` | — | `{tools:[{name, description, inputSchema}]}` | 列工具 |
| `tools/call` | `{name, arguments}` | `{content:[…]}` | 调工具 |
| `resources/list` | — | `{resources:[{uri, name, description, mimeType}]}` | 列资源 |
| `resources/read` | `{uri}` | `{contents:[{uri, text, mimeType}]}` | 读资源 |
| 自定义 method | 任意 | 由 `customHandlers` 返回 | 见 `createServer` 的 `customHandlers` |

> 调用任何业务方法前必须完成 `initialize` 和 `notifications/initialized`。未知请求 method 返回 `-32601`；合法通知不回包，包括未知通知和通知 handler 失败。

初始化的 `capabilities` 必须是对象，数组不能建立会话。`2025-03-26` batch 仅处理一层消息：嵌套数组项返回 `-32600`，不执行其内容；合法兄弟请求仍独立处理，响应数组不嵌套。纯通知 batch 不回包（HTTP 为 202 空 body）。`2025-06-18` 继续拒绝 batch，工具 arguments 内正常的数组不受影响。

### 消息格式

```jsonc
// 请求（带 id，要响应）
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{"name":"world"}}}
// 通知（无 id，不响应）
{"jsonrpc":"2.0","method":"notifications/initialized"}
// 成功响应
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Hello, world!"}]}}
```

### 错误处理（分两层，接入方必须分清）

**① 协议级错误** —— 返回标准 JSON-RPC `error` 字段：

| code | 触发条件 |
|------|---------|
| `-32700` | body 不是合法 JSON（Parse error） |
| `-32600` | 不是合法 JSON-RPC 2.0（缺 `jsonrpc:"2.0"` / `method` 非字符串 / HTTP 用了非 POST 方法） |
| `-32601` | method 不存在 |
| `-32603` | 服务器内部异常 |

**② 工具执行错误** —— 工具 handler 抛异常时返回 `isError:true` 和可见错误内容，不与 JSON-RPC 格式错误混淆。缺失工具名、未知工具及无效 arguments 返回 `-32602`；找不到资源为 `-32002`，资源读取异常为 `-32603`。

参数验证覆盖本产品使用的 type、required、additionalProperties、enum、数值/长度边界和组合分支，不宣称实现完整 JSON Schema。`_meta` 等合法 MCP envelope 字段不作为未知业务参数拒绝。带 `_meta` 的业务对象仍保留业务 payload；同时提供 `structuredContent` 和额外业务字段时，即使未提供 `content`，额外字段也保留在独立的文本 content 项中，不合并进结构化结果或改变其 schema。声明 outputSchema 的工具由应用层确保成功和错误结果符合声明。

### content block 类型

handler 返回值会被包成 content block 数组，可用类型：

| type | 结构 | 辅助函数 |
|------|------|---------|
| text | `{type:'text', text, mimeType?}` | `textContent(text, mimeType?)` |
| image | `{type:'image', data(base64), mimeType, width?, height?}` | `imageContent()` / `imageContentFromFile(path)` |
| audio | `{type:'audio', data(base64), mimeType}` | `audioContent()` |

handler 直接返回 string / object 时，SDK 自动包成 text（见下方 API 参考）。

### 两种传输通道

**stdio** —— 被 Agent 当子进程拉起（Claude Code / Cursor）：
- 每行一条 JSON-RPC 消息，`\n` 分隔 → 消息体必须是**单行 compact JSON**，中间不能有换行
- client 写 `stdin`，server 响应写 `stdout`（每条以 `\n` 结尾）；通知无响应
- `stderr` 仅用于日志，**不混 JSON-RPC**

**streamable-http** —— 常驻服务（Mavis / 任何 HTTP Agent）：

| 端点 | 方法 | 作用 |
|------|------|------|
| `/mcp` | `POST` | JSON-RPC；请求结果 `200 application/json`，通知/响应接受后 `202` |
| `/mcp` | `GET` / `OPTIONS` | `405`，不提供 SSE 或 CORS 预检开放路径 |
| `/health` | `GET` | 同样认证的健康检查 `{status:"ok"}` |

- 默认拒绝任何 Origin。通用 SDK 可传入明确 allowedOrigins；cocos-mcp Product 固定为空，不能开放浏览器豁免。
- HTTP 使用服务生成的 `Mcp-Session-Id`。initialize 后发送 initialized，后续带协商后的 `MCP-Protocol-Version`。会话失效不表示执行取消，也不能成为重放修改的依据。
- POST 必须带 JSON Content-Type 和允许 `application/json, text/event-stream` 的 Accept；默认实际 body 上限 8 MiB。
- `2025-03-26` 支持非空 batch；`2025-06-18` 拒绝 batch。HTTP 不声明 tools/list_changed 推送能力。

---

## 注册到不同 Agent

### Claude Code / Cursor

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "my-mcp": {
      "command": "node",
      "args": ["/path/to/your-server.js", "--stdio"]
    }
  }
}
```

### 本机 HTTP 客户端

客户端从应用的私有凭据渠道取得 endpoint 和 bearer，不把它们放入命令行参数、URL 或日志。下面仅展示 Node 客户端握手；不是浏览器示例，也不自动重试修改：

```js
async function connectLocalMcp({ endpoint, bearerToken }) {
    let protocolVersion = '2025-06-18';
    let sessionId;
    async function request(message) {
        const response = await fetch(endpoint, { method: 'POST',
            headers: { 'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: 'Bearer ' + bearerToken,
                'MCP-Protocol-Version': protocolVersion,
                ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
            body: JSON.stringify(message) });
        if (!response.ok) throw new Error('MCP HTTP ' + response.status);
        if (response.headers.has('mcp-session-id')) sessionId = response.headers.get('mcp-session-id');
        return response.status === 202 ? null : response.json();
    }
    const initialized = await request({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion, capabilities: {}, clientInfo: { name: 'local-client', version: '1' } } });
    if (initialized.error) throw new Error(initialized.error.message);
    protocolVersion = initialized.result.protocolVersion;
    await request({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return request;
}
```

cocos-mcp 调用方还必须迁移目标绑定、operationId 和未知结果处理，见 Product 的执行契约；不能照搬独立 SDK 的无目标 hello 示例来修改 Creator。

---

## API 参考

### createServer(options)

| 选项 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 服务器名称 |
| `version` | string | 是 | 服务器版本 |
| `tools` | Array | 否 | tool 定义列表 |
| `resources` | Array | 否 | resource 定义列表 |
| `customHandlers` | object | 否 | 自定义 JSON-RPC 方法 |
| `port` | number | 否 | HTTP 模式起始端口，默认 8080；占用时递增 bind |
| `bearerToken` | string | 否 | HTTP 认证凭据；Product 必须设置且不公开输出 |
| `allowedOrigins` | string[] | 否 | 默认 `[]`；Product 不允许覆盖 |
| `maxBodyBytes` | number | 否 | 默认 8 MiB，按实际接收字节计量 |
| `entryPoint` | string | 否 | 用于生成配置文件的入口路径 |

### tool(name, description, inputSchema, handler)

- `name`: 工具唯一标识，snake_case
- `description`: AI 靠这个理解工具用途
- `inputSchema`: JSON Schema（定义参数结构）
- `handler`: `async (args) => result`

handler 返回值会自动包装为 MCP content block：

| 返回类型 | 包装方式 |
|---------|---------|
| `string` | `textContent(text)` |
| `object` | `textContent(JSON.stringify(result))` |
| 非空 `Array`（每项均为已知内容类型，且必需字段类型正确） | 直接使用 |
| 其他 `Array`（业务数据、混合项或缺少必需字段） | 整体序列化为 JSON 文本，保留全部数据 |
| `undefined` / `null` | `textContent('(ok)')` |

裸数组的识别覆盖 [MCP 2025-06-18 内容类型](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result)：text、image、audio、resource_link 和 resource；仅有 `type` 字段不足以判定为内容块。显式 `{ content, structuredContent, _meta, isError }` 结果仍由 handler 保证符合协议，SDK 保留这些字段。

`server.start(mode)` 返回 Promise。HTTP 模式 resolve 为 `{mode:'http', port, host, path}`，且只在真实监听成功后完成；`server.stop()` 也返回 Promise，并等待 HTTP listener 关闭。声明的受支持参数约束在 handler 前检查。

### command(name, description, handler)

无参数工具的简写，内部调用 `tool()` 并传入空 `inputSchema`。

### staticResource(uri, name, text, mimeType)

静态文本 resource，每次 read 返回相同内容。

### dynamicResource(uri, name, description, readFn, mimeType)

动态 resource，每次 read 调用 `readFn()` 获取最新内容。

---

## 动态注册

```js
server.addTool({
    name: 'dynamic_tool',
    description: '运行时动态添加的工具',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => textContent('dynamic!'),
});

server.addResource({
    uri: 'dynamic://resource',
    name: 'Dynamic Resource',
    description: '运行时添加',
    mimeType: 'text/plain',
    read: async () => 'fresh data',
});
```

---

## 配置生成

```js
server.printConfig();
```

输出通用配置模板；HTTP 模板不包含私有认证信息，不能单独作为可调用配置。Product 使用自己的受控 Router 接入流程。

---

## 文件结构

```
mcp-sdk/
├── index.js                    # 入口，createServer()
├── tool.js                     # tool 定义辅助
├── resource.js                 # resource 定义辅助
├── test-server.js              # 可运行的测试示例服务器
├── test/                       # node:test 回归（端口并发与 required 参数）
├── protocol/
│   ├── dispatcher.js           # JSON-RPC 2.0 核心分发
│   └── content.js              # content block 封装
├── transport/
│   ├── stdio.js                # Claude Code / Cursor 传输
│   └── streamable-http.js      # Mavis / HTTP Agent 传输
└── README.md
```

---

## License

Apache-2.0 — Copyright 2026 dekaic. See [LICENSE](./LICENSE) for details.
