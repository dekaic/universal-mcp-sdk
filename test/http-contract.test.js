'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../index');
const sessions = new Map();
async function initialize(port, version = '2025-06-18') {
    const response = await request(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await request(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'MCP-Protocol-Version': version } });
    return response;
}

function request(port, body, options = {}) {
    return new Promise((resolve, reject) => {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request({ hostname: '127.0.0.1', port,
            path: options.path || '/mcp', method: options.method || 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                Authorization: 'Bearer test-secret', 'MCP-Protocol-Version': '2025-06-18',
                ...(sessions.has(port) ? { 'Mcp-Session-Id': sessions.get(port) } : {}), ...options.headers },
        }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => {
                if (res.headers['mcp-session-id']) sessions.set(port, res.headers['mcp-session-id']);
                resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

const call = { jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'write', arguments: {} } };

test('authenticated local HTTP rejects unsafe combinations before handler dispatch', async t => {
    let calls = 0;
    const server = createServer({ port: 0, bearerToken: 'test-secret', allowedOrigins: [],
        maxBodyBytes: 1024, tools: [{ name: 'write', handler: () => { calls++; return { ok: true }; } }] });
    await server.start('http');
    t.after(() => server.stop());
    for (const [headers, status] of [
        [{ Authorization: '' }, 401], [{ Authorization: 'Bearer wrong' }, 401],
        [{ Origin: 'https://untrusted.example' }, 403], [{ Origin: 'null' }, 403],
        [{ 'Content-Type': 'text/plain' }, 415], [{ Accept: 'application/json' }, 406],
        [{ Host: 'untrusted.example' }, 403], [{ 'MCP-Protocol-Version': 'invalid' }, 400],
        [{ Accept: 'application/json;q=0, text/event-stream' }, 406],
        [{ Accept: 'application/json, text/event-stream;q=0' }, 406],
    ]) {
        const response = await request(server.port, call, { headers });
        assert.equal(response.status, status, JSON.stringify(headers));
        assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await request(server.port, ' '.repeat(1025))).status, 413);
    assert.equal(calls, 0);
    assert.equal((await request(server.port, call)).status, 400);
    await initialize(server.port);
    const response = await request(server.port, call);
    assert.equal(response.status, 200);
    assert.equal(response.json.id, 0);
    assert.equal(calls, 1);
});

test('HTTP methods, initialize, initialized and batches follow the selected protocol', async t => {
    const server = createServer({ port: 0, bearerToken: 'test-secret', allowedOrigins: [], tools: [] });
    await server.start('http');
    t.after(() => server.stop());
    assert.equal((await request(server.port, '', { method: 'GET' })).status, 405);
    assert.equal((await request(server.port, '', { method: 'OPTIONS' })).status, 405);
    assert.equal((await request(server.port, '', { method: 'GET', path: '/health' })).status, 200);
    assert.equal((await request(server.port, '', { method: 'GET', path: '/health', headers: { Authorization: '' } })).status, 401);
    for (const version of ['2025-03-26', '2025-06-18']) {
        const initialized = await request(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
        assert.equal(initialized.json.result.protocolVersion, version);
        assert.notEqual(initialized.json.result.capabilities.tools?.listChanged, true);
        const headers = { 'MCP-Protocol-Version': version };
        assert.equal((await request(server.port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { headers })).status, 400);
        assert.equal((await request(server.port, { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers })).status, 202);
        assert.equal((await request(server.port, [{ jsonrpc: '2.0', id: 9, method: 'initialize', params: {
            protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' },
        } }], { headers })).status, 400, 'initialize must never be batched');
        const batch = await request(server.port, [{ jsonrpc: '2.0', id: 2, method: 'ping' }], { headers });
        assert.equal(batch.status, version === '2025-03-26' ? 200 : 400);
        assert.equal((await request(server.port, { jsonrpc: '2.0', id: 88, result: {} }, { headers })).status, 202);
        assert.equal((await request(server.port, { jsonrpc: '2.0', id: 89, method: 'ping' }, { headers: { 'MCP-Protocol-Version': version === '2025-03-26' ? '2025-06-18' : '2025-03-26' } })).status, 400);
    }
    assert.equal((await request(server.port, [], { headers: { 'MCP-Protocol-Version': '2025-03-26' } })).status, 400);
    for (const body of [null, true, { jsonrpc: '2.0', method: 3 }]) {
        const result = await request(server.port, body);
        assert.equal(result.json.error.code, -32600);
    }
});

test('normalization preserves business data when metadata is present and validates declared arguments', async () => {
    const { createDispatcher } = require('../protocol/dispatcher');
    let calls = 0;
    const dispatcher = createDispatcher({ tools: [{ name: 'edit',
        inputSchema: { type: 'object', additionalProperties: false, properties: { dryRun: { type: 'boolean' } } },
        handler: () => { calls++; return { changed: true, _meta: { example: 'context' } }; },
    }] });
    for (const args of [{ dryRun: 'false' }, { ignored: true }, []]) {
        const result = await dispatcher.dispatchAsync({ ...call, params: { name: 'edit', arguments: args, _meta: { trace: 1 } } });
        assert.ok(result.error || result.result.isError);
    }
    assert.equal(calls, 0);
    const result = await dispatcher.dispatchAsync({ ...call, params: { name: 'edit', arguments: { dryRun: true } } });
    assert.deepEqual(JSON.parse(result.result.content[0].text), { changed: true });
    assert.deepEqual(result.result._meta, { example: 'context' });
});

test('normalization: structured results retain extra business fields without changing schema or duplicating content', async () => {
    const { createDispatcher, validateArguments } = require('../protocol/dispatcher');
    const structuredContent = Object.freeze({ summary: 'ok' });
    const outputSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
    const business = { changed: false, count: 0, written: null };
    const content = Object.freeze([Object.freeze({ type: 'text', text: 'original' })]);
    const _meta = Object.freeze({ trace: 'fixture' });
    const json = value => JSON.stringify(value, null, 2);
    for (const [payload, expected] of [
        [{ structuredContent }, [json(structuredContent)]],
        [{ structuredContent, ...business }, [json(structuredContent), json(business)]],
        [{ structuredContent, ...business, _meta, isError: false }, [json(structuredContent), json(business)]],
        [{ structuredContent, ...business, _meta, isError: true }, [json(structuredContent), json(business)]],
        [{ content, structuredContent, ...business, _meta }, ['original', json(business)]],
        [{ content, ...business }, ['original', json(business)]],
        [{ ...business, _meta }, [json(business)]],
        [{ _meta }, ['(ok)']],
    ]) {
        Object.freeze(payload);
        const before = JSON.stringify(payload);
        const dispatcher = createDispatcher({ tools: [{ name: 'result',
            ...(payload.structuredContent ? { outputSchema } : {}), handler: () => payload,
        }] });
        const response = await dispatcher.dispatchAsync({ ...call, params: { name: 'result', arguments: {} } });
        assert.equal(response.error, undefined);
        const result = response.result;
        assert.deepEqual(result.content.map(item => item.text), expected, before);
        assert.equal(result.structuredContent, payload.structuredContent);
        assert.equal(result._meta, payload._meta);
        assert.equal(result.isError, payload.isError);
        assert.equal(JSON.stringify(payload), before, 'handler-owned data must not be mutated');
        if (payload.structuredContent) {
            const listed = dispatcher.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
            assert.deepEqual(listed.result.tools[0].outputSchema, outputSchema);
            assert.equal(validateArguments(outputSchema, result.structuredContent), null);
        }
    }
});

test('normalization: HTTP keeps structured and additional business results on both protocols', async t => {
    const structuredContent = { summary: 'ok' };
    const business = { changed: true, written: null };
    const outputSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
    const _meta = { trace: 'fixture' };
    const server = createServer({ port: 0, bearerToken: 'test-secret', tools: [
        { name: 'result', outputSchema, handler: () => ({ structuredContent, ...business, _meta, isError: false }) },
    ] });
    await server.start('http');
    t.after(() => server.stop());
    for (const version of ['2025-03-26', '2025-06-18']) {
        await initialize(server.port, version);
        const headers = { 'MCP-Protocol-Version': version };
        const listed = await request(server.port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { headers });
        assert.deepEqual(listed.json.result.tools[0].outputSchema, outputSchema);
        const response = await request(server.port, { ...call, params: { name: 'result' } }, { headers });
        assert.equal(response.status, 200);
        assert.equal(response.json.error, undefined);
        assert.deepEqual(response.json.result, { structuredContent, _meta, isError: false,
            content: [structuredContent, business].map(value => ({ type: 'text', text: JSON.stringify(value, null, 2) })),
        });
    }
});

test('invalid initialized notifications cannot authorize a session', async t => {
    const server = createServer({ port: 0, bearerToken: 'test-secret', tools: [] });
    await server.start('http');
    t.after(() => server.stop());
    for (const invalid of [
        { jsonrpc: 'invalid', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/initialized', params: [] },
        [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
    ]) {
        await request(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
        await request(server.port, invalid);
        const response = await request(server.port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        assert.equal(response.status, 400, JSON.stringify(invalid));
        await request(server.port, { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: { trace: 'valid' } } });
        assert.equal((await request(server.port, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 200);
    }
});

test('resource results identify their URI and missing resources are protocol errors', async () => {
    const { createDispatcher } = require('../protocol/dispatcher');
    const uri = 'fixture://status';
    const dispatcher = createDispatcher({ resources: [{ uri, mimeType: 'application/json', read: () => ({ ready: true }) }] });
    const result = await dispatcher.dispatchAsync({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } });
    assert.deepEqual(result.result.contents, [{ uri, mimeType: 'application/json', text: JSON.stringify({ ready: true }, null, 2) }]);
    const missing = await dispatcher.dispatchAsync({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'fixture://missing' } });
    assert.equal(missing.error.code, -32002);
});

test('protocol boundary: HTTP rejects nested batch items without executing them and keeps valid siblings', async t => {
    let calls = 0;
    const server = createServer({ port: 0, bearerToken: 'test-secret', tools: [
        { name: 'write', handler: () => { calls++; return { ok: true }; } },
    ] });
    await server.start('http');
    t.after(() => server.stop());
    await initialize(server.port, '2025-03-26');
    const headers = { 'MCP-Protocol-Version': '2025-03-26' };
    for (const nested of [[call], [[call]], []]) {
        const before = calls;
        const response = await request(server.port, [nested, { ...call, id: 3, params: { name: 'write', arguments: { values: [[1]] } } }], { headers });
        assert.equal(calls, before + 1, 'only the valid top-level sibling can execute');
        assert.equal(response.status, 200);
        assert.equal(response.json.length, 2);
        assert.ok(response.json.every(item => !Array.isArray(item)));
        assert.equal(response.json[0].id, null);
        assert.equal(response.json[0].error.code, -32600);
        assert.equal(response.json[1].id, 3);
        assert.ok(response.json[1].result);
    }
    await initialize(server.port, '2025-06-18');
    const before = calls;
    assert.equal((await request(server.port, [call])).status, 400);
    assert.equal((await request(server.port, [[call]])).status, 400);
    assert.equal(calls, before);
});

test('protocol boundary: HTTP notifications have no response, including unknown methods and handler failures', async t => {
    const server = createServer({ port: 0, bearerToken: 'test-secret', customHandlers: {
        'notifications/progress': () => { throw new Error('notification handler failed'); },
    } });
    await server.start('http');
    t.after(() => server.stop());
    for (const version of ['2025-03-26', '2025-06-18']) {
        await initialize(server.port, version);
        const headers = { 'MCP-Protocol-Version': version };
        const notifications = [
            { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'probe', progress: 1 } },
            { jsonrpc: '2.0', method: 'notifications/unknown', params: { _meta: { trace: 'legal' } } },
        ];
        for (const message of notifications) {
            const response = await request(server.port, message, { headers });
            assert.equal(response.status, 202);
            assert.equal(response.text, '');
        }
        if (version === '2025-03-26') {
            const response = await request(server.port, notifications, { headers });
            assert.equal(response.status, 202);
            assert.equal(response.text, '');
            const mixed = await request(server.port, [...notifications, { jsonrpc: '2.0', id: 7, method: 'ping' }], { headers });
            assert.deepEqual(mixed.json, [{ jsonrpc: '2.0', id: 7, result: {} }]);
        }
        const unknownRequest = await request(server.port, { jsonrpc: '2.0', id: 8, method: 'unknown' }, { headers });
        assert.equal(unknownRequest.json.error.code, -32601, 'requests still receive protocol errors');
    }
});

test('protocol boundary: invalid capability arrays cannot establish an HTTP session', async t => {
    const server = createServer({ port: 0, bearerToken: 'test-secret' });
    await server.start('http');
    t.after(() => server.stop());
    sessions.delete(server.port);
    const response = await request(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: [], clientInfo: { name: 'test', version: '0' } } });
    assert.equal(response.json.error?.code, -32602);
    assert.equal(response.headers['mcp-session-id'], undefined);
    assert.equal((await request(server.port, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 400);
    await initialize(server.port);
    assert.equal((await request(server.port, { jsonrpc: '2.0', id: 2, method: 'ping', params: { _meta: { trace: 'legal' } } })).status, 200);
});
