'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher } = require('../protocol/dispatcher.js');

test('dispatcher rejects missing required arguments before invoking a tool', async () => {
    let calls = 0;
    const dispatcher = createDispatcher({
        name: 'required-args',
        tools: [{
            name: 'scene_open_scene',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string' } },
                required: ['uuid'],
            },
            handler: async function () {
                calls++;
                return 'opened';
            },
        }],
    });

    const response = await dispatcher.dispatchAsync({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'scene_open_scene', arguments: { url: 'db://assets/example.scene' } },
    });

    assert.equal(calls, 0);
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /\[scene_open_scene\] Missing required argument: uuid/);
});
