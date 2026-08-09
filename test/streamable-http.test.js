'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { createHttpTransport } = require('../transport/streamable-http.js');

function request(port, options) {
    options = options || {};
    const body = options.body || '';
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: options.path || '/mcp',
            method: options.method || 'POST',
            headers: Object.assign({
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            }, options.headers || {}),
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve(server.address());
        });
    });
}

function close(server) {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('HTTP transport binds atomically, authenticates, and closes before resolving', async (t) => {
    const dispatcher = {
        dispatchAsync: async (message) => ({ jsonrpc: '2.0', id: message.id, result: { ok: true } }),
    };
    const transport = createHttpTransport(dispatcher, {
        host: '127.0.0.1',
        port: 0,
        authToken: 'test-secret',
        allowedOrigins: [],
        maxBodyBytes: 256,
    });
    const address = await transport.start();
    t.after(async () => { await transport.stop(); });
    assert.ok(address.port > 0);

    const payload = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' });
    assert.equal((await request(address.port, { body: payload })).statusCode, 401);

    const authorized = await request(address.port, {
        body: payload,
        headers: { Authorization: 'Bearer test-secret' },
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(JSON.parse(authorized.body).id, 0);

    const forbiddenOrigin = await request(address.port, {
        body: payload,
        headers: { Authorization: 'Bearer test-secret', Origin: 'https://evil.example' },
    });
    assert.equal(forbiddenOrigin.statusCode, 403);
    assert.equal(forbiddenOrigin.headers['access-control-allow-origin'], undefined);

    const textPlain = await request(address.port, {
        body: payload,
        headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'text/plain' },
    });
    assert.equal(textPlain.statusCode, 415);

    const jsonPrefixOnly = await request(address.port, {
        body: payload,
        headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/jsonp' },
    });
    assert.equal(jsonPrefixOnly.statusCode, 415);

    const tooLarge = await request(address.port, {
        body: JSON.stringify({ value: 'x'.repeat(300) }),
        headers: { Authorization: 'Bearer test-secret' },
    });
    assert.equal(tooLarge.statusCode, 413);

    await transport.stop();
    const replacement = net.createServer();
    await listen(replacement, address.port);
    await close(replacement);
});

test('HTTP transport start rejects when the requested port is occupied', async () => {
    const occupied = net.createServer();
    const address = await listen(occupied, 0);
    const transport = createHttpTransport({ dispatchAsync: async () => null }, {
        host: '127.0.0.1',
        port: address.port,
    });
    try {
        await assert.rejects(transport.start(), (error) => error && error.code === 'EADDRINUSE');
    } finally {
        await close(occupied);
        await transport.stop();
    }
});
