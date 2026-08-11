'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { createServer } = require('../index.js');

function reserveThenReleasePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function getHealth(port) {
    return new Promise((resolve, reject) => {
        const request = http.get('http://127.0.0.1:' + port + '/', (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                statusCode: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }));
        });
        request.on('error', reject);
    });
}

test('concurrent HTTP servers bind distinct ports and report the actual endpoint', async () => {
    const startPort = await reserveThenReleasePort();
    const first = createServer({ name: 'first', port: startPort });
    const second = createServer({ name: 'second', port: startPort });

    try {
        const started = await Promise.all([first.start('http'), second.start('http')]);
        assert.equal(started[0].mode, 'http');
        assert.equal(started[1].mode, 'http');
        assert.notEqual(started[0].port, started[1].port);
        assert.ok(started[0].port >= startPort);
        assert.ok(started[1].port >= startPort);

        const health = await Promise.all(started.map((entry) => getHealth(entry.port)));
        assert.deepEqual(health.map((entry) => entry.statusCode), [200, 200]);
        assert.deepEqual(health.map((entry) => entry.body.status), ['ok', 'ok']);
    } finally {
        await Promise.all([first.stop(), second.stop()]);
    }
});
