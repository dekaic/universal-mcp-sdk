'use strict';

/**
 * transport/streamable-http.js
 * Streamable HTTP 传输层
 *
 * MCP 规范定义的 HTTP 传输协议：
 *   - POST /mcp  — 发送 JSON-RPC 请求，接收 JSON-RPC 响应
 *   - GET /mcp  — 初始化握手（发送 initialize 请求）
 *   - GET /  — 健康检查 / 服务器信息
 *
 * 参考：https://modelcontextprotocol.io/specification/basic/transports
 */

const http = require('http');
const url = require('url');
const crypto = require('crypto');

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18']);

function createHttpTransport(dispatcher, options) {
    options = options || {};
    const port = options.port !== undefined ? options.port : 8080;
    const host = options.host || '127.0.0.1';
    const path = options.path || '/mcp';
    const protocolVersion = options.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    const allowedOrigins = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [];
    const authToken = options.authToken || '';
    const maxBodyBytes = options.maxBodyBytes || 1024 * 1024;

    let server = null;

    function setCommonHeaders(req, res) {
        const origin = req && req.headers && req.headers.origin;
        if (origin && allowedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', [
            'Authorization',
            'Content-Type',
            'Accept',
            'MCP-Protocol-Version',
            'Mcp-Session-Id',
            'Last-Event-ID',
        ].join(', '));
        res.setHeader('MCP-Protocol-Version', protocolVersion);
    }

    // ── 发送 JSON-RPC 响应的辅助函数 ─────────────────────────────
    function sendJson(req, res, statusCode, body) {
        const data = JSON.stringify(body);
        setCommonHeaders(req, res);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
        });
        res.end(data);
    }

    function sendError(req, res, statusCode, code, message) {
        sendJson(req, res, statusCode, {
            jsonrpc: '2.0',
            error: { code, message },
            id: null,
        });
    }

    function sendAccepted(req, res) {
        setCommonHeaders(req, res);
        res.writeHead(202);
        res.end();
    }

    function isAllowedOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return true;
        return allowedOrigins.includes(origin);
    }

    function isAuthorized(req) {
        if (!authToken) return true;
        const actual = String(req.headers.authorization || '');
        const expected = 'Bearer ' + authToken;
        const actualBuffer = Buffer.from(actual);
        const expectedBuffer = Buffer.from(expected);
        return actualBuffer.length === expectedBuffer.length &&
            crypto.timingSafeEqual(actualBuffer, expectedBuffer);
    }

    function hasCompatibleProtocolHeader(req) {
        const requested = req.headers['mcp-protocol-version'];
        if (!requested) return true;
        return SUPPORTED_PROTOCOL_VERSIONS.has(String(requested));
    }

    function isJsonRpcNotificationOrResponse(message) {
        if (Array.isArray(message)) {
            return message.length > 0 && message.every(isJsonRpcNotificationOrResponse);
        }
        if (!message || message.jsonrpc !== '2.0') return false;
        if (typeof message.method === 'string' && message.id === undefined) return true;
        return typeof message.method !== 'string' && (message.result !== undefined || message.error !== undefined);
    }

    async function dispatchMessage(message) {
        if (Array.isArray(message)) {
            const responses = [];
            for (const item of message) {
                const response = await dispatcher.dispatchAsync(item);
                if (response) responses.push(response);
            }
            return responses.length > 0 ? responses : null;
        }
        return dispatcher.dispatchAsync(message);
    }

    // ── 处理 POST /mcp ───────────────────────────────────────────
    async function handleMcpPost(req, res) {
        if (!isAllowedOrigin(req)) {
            sendError(req, res, 403, -32600, 'Forbidden origin');
            return;
        }

        if (!isAuthorized(req)) {
            sendError(req, res, 401, -32001, 'Unauthorized');
            return;
        }

        if (!hasCompatibleProtocolHeader(req)) {
            sendError(req, res, 400, -32600, 'Unsupported MCP-Protocol-Version');
            return;
        }

        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
            sendError(req, res, 415, -32600, 'Content-Type must be application/json');
            return;
        }

        // 读取 body
        const chunks = [];
        let bodyBytes = 0;
        let bodyTooLarge = false;
        req.on('data', chunk => {
            bodyBytes += chunk.length;
            if (bodyBytes > maxBodyBytes) {
                if (!bodyTooLarge) {
                    bodyTooLarge = true;
                    sendError(req, res, 413, -32600, `Request body exceeds ${maxBodyBytes} bytes`);
                }
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', async () => {
            if (bodyTooLarge) return;
            const body = Buffer.concat(chunks).toString('utf8');
            let reqJson;
            try {
                reqJson = JSON.parse(body);
            } catch (e) {
                sendError(req, res, 400, -32700, 'Parse error');
                return;
            }

            try {
                if (isJsonRpcNotificationOrResponse(reqJson)) {
                    sendAccepted(req, res);
                    return;
                }

                const resJson = await dispatchMessage(reqJson);
                if (resJson) {
                    sendJson(req, res, 200, resJson);
                } else {
                    sendAccepted(req, res);
                }
            } catch (err) {
                sendJson(req, res, 200, {
                    jsonrpc: '2.0',
                    id: reqJson.id === undefined ? null : reqJson.id,
                    error: { code: -32603, message: `Internal error: ${err.message}` },
                });
            }
        });
    }

    // ── 处理 GET /mcp（初始化握手）────────────────────────────────
    function handleMcpGet(req, res) {
        if (!isAllowedOrigin(req)) {
            sendError(req, res, 403, -32600, 'Forbidden origin');
            return;
        }
        if (!isAuthorized(req)) {
            sendError(req, res, 401, -32001, 'Unauthorized');
            return;
        }

        // 返回服务器信息和可用端点说明
        sendJson(req, res, 200, {
            name: 'mcp-sdk-http-transport',
            version: '1.0.0',
            protocolVersion,
            endpoints: {
                'POST /mcp': 'Send JSON-RPC 2.0 request, receive JSON-RPC 2.0 response',
                'GET /mcp': 'Server info and endpoint documentation',
                'GET /': 'Health check',
            },
        });
    }

    // ── 启动 HTTP 服务器 ─────────────────────────────────────────
    function handleOptions(req, res) {
        if (!isAllowedOrigin(req)) {
            sendError(req, res, 403, -32600, 'Forbidden origin');
            return;
        }
        setCommonHeaders(req, res);
        res.writeHead(204);
        res.end();
    }

    function start() {
        if (server) return Promise.reject(new Error('HTTP transport already started'));
        server = http.createServer((req, res) => {
            const parsedUrl = url.parse(req.url, true);

            // 路由分发
            if (parsedUrl.pathname === path && req.method === 'OPTIONS') {
                handleOptions(req, res);
            } else if (parsedUrl.pathname === path && req.method === 'POST') {
                handleMcpPost(req, res);
            } else if (parsedUrl.pathname === path && req.method === 'GET') {
                handleMcpGet(req, res);
            } else if (parsedUrl.pathname === '/' && req.method === 'GET') {
                if (!isAuthorized(req)) sendError(req, res, 401, -32001, 'Unauthorized');
                else sendJson(req, res, 200, { status: 'ok', timestamp: Date.now() });
            } else {
                sendError(req, res, 404, -32600, `Not found: ${req.url}`);
            }
        });

        return new Promise((resolve, reject) => {
            const candidate = server;
            function onStartupError(err) {
                if (server === candidate) server = null;
                reject(err);
            }
            candidate.once('error', onStartupError);
            candidate.listen(port, host, () => {
                candidate.removeListener('error', onStartupError);
                candidate.on('error', (err) => {
                    console.error(`[mcp-sdk] HTTP server error: ${err.message}`);
                });
                const address = candidate.address();
                const boundPort = address && address.port;
                console.log(`[mcp-sdk] HTTP transport listening on http://${host}:${boundPort}${path}`);
                resolve({ host, port: boundPort, path });
            });
        });
    }

    function stop() {
        if (!server) return Promise.resolve();
        const activeServer = server;
        server = null;
        return new Promise((resolve, reject) => {
            activeServer.close((err) => err ? reject(err) : resolve());
        });
    }

    return { start, stop, port, host, path };
}

module.exports = { createHttpTransport };
