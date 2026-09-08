'use strict';

// JSON-only Streamable HTTP. No SSE channel and no server-push capability.
const http = require('http');
const crypto = require('crypto');
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18']);

function createHttpTransport(dispatcher, options = {}) {
    const port = options.port === undefined ? 8080 : options.port;
    const host = options.host || '127.0.0.1';
    const path = options.path || '/mcp';
    const maxBodyBytes = options.maxBodyBytes || 8 * 1024 * 1024;
    const allowedOrigins = options.allowedOrigins || [];
    if (options.bearerToken !== undefined && (typeof options.bearerToken !== 'string' || !options.bearerToken)) {
        throw new Error('bearerToken must be a nonempty string');
    }
    const credential = options.bearerToken ? Buffer.from('Bearer ' + options.bearerToken) : null;
    let server = null;
    const sessions = new Map();

    function send(res, status, body) {
        if (res.destroyed || res.writableEnded) return;
        const data = body === undefined ? '' : JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
        res.end(data);
    }
    function error(res, status, code, message) {
        send(res, status, { jsonrpc: '2.0', id: null, error: { code, message } });
    }
    async function dispatch(message, context, session) {
        if (Array.isArray(message)) {
            const responses = [];
            for (const item of message) {
                const result = Array.isArray(item)
                    ? { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch entries must be single messages' } }
                    : await dispatch(item, context, session);
                if (result) responses.push(result);
            }
            return responses.length ? responses : null;
        }
        const result = await dispatcher.dispatchAsync(message, context);
        // Only a successfully validated notification can complete initialization.
        // Invalid envelopes and rejected batches must not mutate session state.
        if (session && !result && message && message.method === 'notifications/initialized') session.initialized = true;
        return result;
    }

    function handle(req, res) {
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedOrigins.includes(origin)) return error(res, 403, -32600, 'Forbidden origin');
        if (origin !== undefined) res.setHeader('Access-Control-Allow-Origin', origin);
        if (credential) {
            const received = Buffer.from(req.headers.authorization || '');
            if (received.length !== credential.length || !crypto.timingSafeEqual(received, credential)) {
                return error(res, 401, -32600, 'Authentication required');
            }
        }
        const address = req.socket.address();
        const hosts = [host, '127.0.0.1', 'localhost', '[::1]'].map(value => value + ':' + address.port);
        if (!hosts.includes(req.headers.host)) return error(res, 403, -32600, 'Invalid Host');
        if (req.url === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok' });
        if (req.url !== path) return error(res, 404, -32600, 'Not found');
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return error(res, 405, -32600, 'This endpoint supports POST; SSE is not available');
        }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
            return error(res, 415, -32600, 'Content-Type must be application/json');
        }
        const accept = (req.headers.accept || '').split(',').flatMap(value => {
            const [type, ...parameters] = value.toLowerCase().split(';').map(part => part.trim());
            const quality = parameters.find(parameter => /^q\s*=/.test(parameter));
            const q = quality === undefined ? 1 : Number(quality.split('=')[1]);
            return Number.isFinite(q) && q > 0 && q <= 1 ? [type] : [];
        });
        if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
            return error(res, 406, -32600, 'Accept must include application/json and text/event-stream');
        }
        let protocolVersion = req.headers['mcp-protocol-version'] || '2025-03-26';
        if (!SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) return error(res, 400, -32600, 'Unsupported MCP-Protocol-Version');
        res.setHeader('MCP-Protocol-Version', protocolVersion);
        if (Number(req.headers['content-length']) > maxBodyBytes) return error(res, 413, -32600, 'Request body too large');
        const chunks = [];
        let size = 0;
        let rejected = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBodyBytes) {
                rejected = true;
                chunks.length = 0;
                error(res, 413, -32600, 'Request body too large');
            } else if (!rejected) chunks.push(chunk);
        });
        req.on('error', () => { rejected = true; });
        req.on('end', async () => {
            if (rejected) return;
            let message;
            try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch (_) { return error(res, 400, -32700, 'Parse error'); }
            const initializing = message && !Array.isArray(message) && message.method === 'initialize';
            const sessionId = req.headers['mcp-session-id'];
            let session;
            if (!initializing) {
                if (!sessionId) return error(res, 400, -32600, 'Initialize first; Mcp-Session-Id is required');
                session = sessions.get(sessionId);
                if (!session) return error(res, 404, -32600, 'Session no longer exists; initialize a new session');
                if (req.headers['mcp-protocol-version'] && protocolVersion !== session.protocolVersion) return error(res, 400, -32600, 'Protocol header differs from negotiated version');
                protocolVersion = session.protocolVersion;
                session.lastSeen = Date.now();
                const messages = Array.isArray(message) ? message : [message];
                if (!session.initialized && messages.some(item => !item || !['notifications/initialized', 'ping'].includes(item.method))) return error(res, 400, -32600, 'notifications/initialized is required');
                if (messages.some(item => item && item.method === 'notifications/initialized' && item.id !== undefined)) return error(res, 400, -32600, 'initialized must be a notification');
            }
            res.setHeader('MCP-Protocol-Version', protocolVersion);
            if (Array.isArray(message) && (protocolVersion !== '2025-03-26' || !message.length || message.some(item => item && item.method === 'initialize'))) {
                return error(res, 400, -32600, 'Batch is not valid for this protocol/request');
            }
            if (Array.isArray(message) && message.some(item => item && item.method) && message.some(item => item && !item.method && (item.result !== undefined || item.error))) return error(res, 400, -32600, 'Batch cannot mix responses with requests');
            try {
                const result = await dispatch(message, { protocolVersion }, session);
                if (initializing && result && result.result) {
                    // Inactive transport sessions may expire; this never cancels execution or releases project protection.
                    for (const [id, item] of sessions) if (Date.now() - item.lastSeen > 30 * 60 * 1000) sessions.delete(id);
                    const id = crypto.randomUUID();
                    sessions.set(id, { protocolVersion: result.result.protocolVersion, initialized: false, lastSeen: Date.now() });
                    res.setHeader('Mcp-Session-Id', id);
                    res.setHeader('MCP-Protocol-Version', result.result.protocolVersion);
                }
                send(res, result ? 200 : 202, result || undefined);
            } catch (_) {
                error(res, 500, -32603, 'Internal error');
            }
        });
    }

    function start() {
        server = http.createServer(handle);
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.removeListener('error', reject);
                server.on('error', err => console.error('[mcp-sdk] HTTP server error: ' + err.message));
                resolve({ port: server.address().port, host, path });
            });
        });
    }
    function stop() {
        if (!server) return Promise.resolve();
        const closing = server;
        server = null;
        return new Promise((resolve, reject) => {
            closing.close(err => err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve());
        });
    }
    return { start, stop, port, host, path };
}

module.exports = { createHttpTransport };
