import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { authorizedGet, openProxyBridge } from '../electron/proxy-bridge.mjs';
import { openSocket } from '../electron/system-proxy.mjs';

async function listener(t) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, port: server.address().port };
}

test('authorized downloads time out during TLS handshake, before any credential is sent', async (t) => {
  const service = await listener(t);
  const request = authorizedGet(
    new URL(`wss://127.0.0.1:${service.port}/ws`),
    { fingerprint: 'AB'.repeat(32) },
    '/client/installer',
    'test-credential',
    undefined,
    { timeoutMs: 50 },
  );
  const result = await Promise.race([
    request.then(
      () => 'resolved',
      () => 'rejected',
    ),
    delay(250, 'pending'),
  ]);
  assert.equal(result, 'rejected');
});

test('download cancellation can finish while system proxy resolution is still pending', async () => {
  const controller = new AbortController();
  const request = authorizedGet(
    new URL('wss://127.0.0.1:1/ws'),
    { fingerprint: 'AB'.repeat(32) },
    '/client/installer',
    'test-credential',
    () => new Promise(() => {}),
    { signal: controller.signal },
  );
  controller.abort(new Error('cancelled'));
  await assert.rejects(request, /cancelled/);
});

test('proxy setup cancellation closes the pending CONNECT socket', async (t) => {
  const proxy = await listener(t);
  const controller = new AbortController();
  const accepted = once(proxy.server, 'connection');
  const connection = openSocket(
    { host: '127.0.0.1', port: proxy.port },
    '127.0.0.1',
    1,
    5000,
    controller.signal,
  );
  const [socket] = await accepted;
  const closed = once(socket, 'close');
  socket.resume();
  controller.abort(new Error('Cancelled'));
  const result = await Promise.race([
    connection.then(
      () => 'resolved',
      () => 'rejected',
    ),
    delay(250, 'pending'),
  ]);
  assert.equal(result, 'rejected');
  await closed;
});

test('closing the bridge cancels an in-flight proxy connection', async (t) => {
  const proxy = await listener(t);
  const bridge = await openProxyBridge(
    { url: 'wss://127.0.0.1:1/ws', fingerprint: 'AB'.repeat(32) },
    { resolveProxy: async () => `PROXY 127.0.0.1:${proxy.port}` },
  );
  t.after(() => bridge.close());
  const accepted = once(proxy.server, 'connection');
  const renderer = new WebSocket(bridge.url);
  renderer.on('error', () => {});
  const [socket] = await accepted;
  socket.resume();
  const closed = once(socket, 'close').then(() => true);
  await bridge.close();
  assert.equal(await Promise.race([closed, delay(250, false)]), true);
});

test('closing the bridge reclaims incomplete local HTTP requests', async (t) => {
  const bridge = await openProxyBridge(
    { url: 'wss://127.0.0.1:1/ws', fingerprint: 'AB'.repeat(32) },
    {},
  );
  const socket = connect(Number(new URL(bridge.url).port), '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write('GET /');
  t.after(async () => {
    socket.destroy();
    await bridge.close();
  });
  const closed = bridge.close().then(() => true);
  assert.equal(await Promise.race([closed, delay(250, false)]), true);
});
