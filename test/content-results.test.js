'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../protocol/dispatcher');

async function call(value) {
    const dispatcher = createDispatcher({ tools: [{ name: 'result', handler: () => value }] });
    const response = await dispatcher.dispatchAsync({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'result', arguments: {} } });
    assert.equal(response.error, undefined);
    return response.result;
}

test('bare business, mixed and incomplete content arrays remain JSON data', async () => {
    for (const value of [
        [{ type: 'gold', amount: 10 }],
        [{ type: 'text', text: 'ok' }, { type: 'gold', amount: 10 }],
        [{ type: 'text' }], [{ type: 'text', text: 7 }],
        [{ type: 'image', data: 'AA==' }], [{ type: 'audio', mimeType: 'audio/wav' }],
        [{ type: 'resource_link', uri: 'file:///test' }],
        [{ type: 'resource', resource: { uri: 'file:///test' } }],
        [{ type: 'text', text: 'ok' }, null], [],
        { type: 'gold', text: 'business text' }, { type: 'text', text: 7 },
        { items: [{ type: 'gold', amount: 10 }] },
    ]) {
        const result = await call(value);
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, 'text');
        assert.deepEqual(JSON.parse(result.content[0].text), value);
    }
});

test('all supported content blocks and explicit result metadata remain intact', async () => {
    const content = [
        { type: 'text', text: '正常内容' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
        { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
        { type: 'resource_link', uri: 'file:///test', name: 'test' },
        { type: 'resource', resource: { uri: 'file:///test', text: 'hello' } },
        { type: 'resource', resource: { uri: 'file:///test', blob: 'AA==' } },
    ];
    assert.deepEqual((await call(content)).content, content);
    assert.deepEqual((await call(content[0])).content, [content[0]]);
    const envelope = { content, structuredContent: { items: [{ type: 'gold', amount: 10 }] },
        _meta: { example: 'retained' }, isError: false };
    assert.deepEqual(await call(envelope), envelope);
});
