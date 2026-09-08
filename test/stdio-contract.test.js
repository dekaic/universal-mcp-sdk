'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../protocol/dispatcher');
const { createMessageHandler } = require('../transport/stdio');

test('stdio enforces initialization and negotiated batch semantics without dropping errors', async () => {
    for (const version of ['2025-03-26', '2025-06-18']) {
        let calls = 0;
        const handle = createMessageHandler(createDispatcher({ tools: [{ name: 'write', handler: () => ++calls }] }));
        const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write' } };
        assert.equal((await handle(call)).error.code, -32600);
        const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
        const first = handle(init);
        const duplicate = handle(init);
        assert.equal((await first).result.protocolVersion, version);
        assert.ok((await duplicate).error);
        await handle({ jsonrpc: 'invalid', method: 'notifications/initialized' });
        assert.equal((await handle(call)).error.code, -32600);
        await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
        assert.equal((await handle([init])).error.code, -32600, 'initialize must never be batched');
        const batch = await handle([call]);
        assert.equal(Array.isArray(batch), version === '2025-03-26');
        assert.equal(calls, version === '2025-03-26' ? 1 : 0);
        const noId = await handle({ ...call, id: undefined });
        assert.equal(noId.error.code, -32600);
        assert.equal((await handle(null)).error.code, -32600);
    }
});

test('protocol boundary: stdio nested batch items do not execute or create nested responses', async () => {
    let calls = 0;
    const handle = createMessageHandler(createDispatcher({ tools: [{ name: 'write', handler: () => ++calls }] }));
    await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write' } };
    for (const nested of [[call], [[call]], []]) {
        const before = calls;
        const response = await handle([nested, { jsonrpc: '2.0', id: 3, method: 'ping' }]);
        assert.equal(calls, before);
        assert.equal(response.length, 2);
        assert.ok(response.every(item => !Array.isArray(item)));
        assert.equal(response[0].id, null);
        assert.equal(response[0].error.code, -32600);
        assert.deepEqual(response[1], { jsonrpc: '2.0', id: 3, result: {} });
    }
});

test('protocol boundary: stdio notification batches emit no unknown-method or handler error responses', async () => {
    const handle = createMessageHandler(createDispatcher({ customHandlers: {
        'notifications/progress': () => { throw new Error('notification handler failed'); },
    } }));
    await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const notifications = [{ jsonrpc: '2.0', method: 'notifications/unknown' }, { jsonrpc: '2.0', method: 'notifications/progress' }];
    for (const message of notifications) assert.equal(await handle(message), null);
    assert.equal(await handle(notifications), null);
    assert.deepEqual(await handle([...notifications, { jsonrpc: '2.0', id: 4, method: 'ping' }]), [{ jsonrpc: '2.0', id: 4, result: {} }]);
    assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'unknown' })).error.code, -32601);
});

test('protocol boundary: invalid capability arrays cannot complete stdio initialization', async () => {
    const handle = createMessageHandler(createDispatcher({}));
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: [], clientInfo: { name: 'test', version: '0' } } };
    assert.equal((await handle(init)).error?.code, -32602);
    assert.equal((await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).error.code, -32600);
    assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).error.code, -32600);
    init.params.capabilities = {};
    assert.equal((await handle(init)).result.protocolVersion, '2025-06-18');
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.ok((await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result);
});

test('normalization: stdio retains business fields beside structured results on both protocols', async () => {
    const structuredContent = { summary: 'ok' };
    const business = { changed: true, written: null };
    const outputSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
    for (const version of ['2025-03-26', '2025-06-18']) {
        const handle = createMessageHandler(createDispatcher({ tools: [
            { name: 'result', outputSchema, handler: () => ({ structuredContent, ...business }) },
        ] }));
        await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
        await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const listed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        assert.deepEqual(listed.result.tools[0].outputSchema, outputSchema);
        const response = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'result' } });
        assert.equal(response.error, undefined);
        assert.deepEqual(response.result, { structuredContent,
            content: [structuredContent, business].map(value => ({ type: 'text', text: JSON.stringify(value, null, 2) })),
        });
    }
});
