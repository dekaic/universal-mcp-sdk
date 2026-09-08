'use strict';

/**
 * transport/stdio.js
 * 标准输入/输出 传输层
 *
 * 用于 Claude Code / Cursor / 任何通过 stdin/stdout 通信的 MCP 客户端
 * 协议：每行一个 JSON-RPC 消息（换行符分隔）
 */

const EventEmitter = require('events');

function createMessageHandler(dispatcher) {
    let protocolVersion = '2025-06-18';
    let initializing = false;
    let handshake = false;
    let ready = false;
    function error(id, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: -32600, message } }; }
    return async function handle(req) {
        if (Array.isArray(req)) {
            if (protocolVersion !== '2025-03-26' || !req.length || req.some(item => item && item.method === 'initialize')) return error(null, 'Invalid batch for negotiated protocol');
            const responses = (await Promise.all(req.map(item => Array.isArray(item)
                ? error(null, 'Batch entries must be single messages') : handle(item)))).filter(Boolean);
            return responses.length ? responses : null;
        }
        if (req && req.method === 'initialize') {
            if (handshake || initializing) return error(req.id, 'Initialization is already in progress or complete');
            initializing = true;
            try {
                const response = await dispatcher.dispatchAsync(req);
                if (response && response.result) { protocolVersion = response.result.protocolVersion; handshake = true; }
                return response;
            } finally { initializing = false; }
        }
        if (req && req.method === 'notifications/initialized') {
            if (req.id !== undefined || !handshake) return error(req.id, 'Initialize before the initialized notification');
            const response = await dispatcher.dispatchAsync(req);
            if (!response) ready = true;
            return response;
        }
        if (!ready && req && req.method !== 'ping') return error(req.id, 'Initialization must complete before use');
        return dispatcher.dispatchAsync(req, { protocolVersion });
    };
}

function createStdioTransport(dispatcher) {
    const emitter = new EventEmitter();
    const handle = createMessageHandler(dispatcher);
    let buffer = '';

    function start() {
        // 设置 stdin 为 utf-8
        process.stdin.setEncoding('utf-8');

        process.stdin.on('data', (chunk) => {
            buffer += chunk;

            // 按换行分割，JSON-RPC 消息以换行分隔
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 未完整的一条留作 buffer

            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;

                try {
                    const req = JSON.parse(line);
                    handle(req).then((res) => {
                        if (res) {
                            process.stdout.write(JSON.stringify(res) + '\n');
                        }
                    }).catch((err) => {
                        process.stdout.write(JSON.stringify({
                            jsonrpc: '2.0',
                            id: req && req.id !== undefined ? req.id : null,
                            error: { code: -32603, message: `Internal error: ${err.message}` },
                        }) + '\n');
                    });

                } catch (e) {
                    // JSON 解析失败，发送错误响应
                    process.stdout.write(JSON.stringify({
                        jsonrpc: '2.0',
                        error: { code: -32700, message: 'Parse error' },
                        id: null,
                    }) + '\n');
                }
            }
        });

        process.stdin.on('end', () => {
            emitter.emit('end');
        });

        // 确保 unhandled rejection 不会静默吞掉
        process.on('uncaughtException', (err) => {
            process.stderr.write(`[stdio-transport] Uncaught exception: ${err.message}\n`);
            process.exit(1);
        });

        process.on('unhandledRejection', (reason) => {
            process.stderr.write(`[stdio-transport] Unhandled rejection: ${reason}\n`);
        });
    }

    return { start, emitter };
}

module.exports = { createStdioTransport, createMessageHandler };
