import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { authorizedGet, openProxyBridge } from '../electron/proxy-bridge.mjs';

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-review-download-'));
  await promisify(execFile)('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(directory, 'key.pem'),
    '-out',
    join(directory, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
  ]);
  const cert = await readFile(join(directory, 'cert.pem'));
  const server = createServer({ cert, key: await readFile(join(directory, 'key.pem')) }, handler);
  const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    wss,
    address: new URL(`wss://127.0.0.1:${server.address().port}/ws`),
    config: { fingerprint: new X509Certificate(cert).fingerprint256 },
  };
}

test(
  'authorized GET bounds a server that finishes TLS but never responds with HTTP headers',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    let authenticated = false;
    const f = await fixture(t, (request) => {
      authenticated = request.headers.authorization === 'Bearer test-credential';
    });
    await assert.rejects(
      authorizedGet(f.address, f.config, '/client/installer', 'test-credential', undefined, {
        timeoutMs: 100,
      }),
      /超时|abort/i,
    );
    assert.equal(authenticated, true);
  },
);

test(
  'a certificate mismatch prevents an authorized HTTP request',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    let requests = 0;
    const f = await fixture(t, (_request, response) => {
      requests++;
      response.end('unexpected');
    });
    await assert.rejects(
      authorizedGet(
        f.address,
        { fingerprint: 'AB'.repeat(32) },
        '/client/installer',
        'test-credential',
      ),
      /指纹不匹配/,
    );
    assert.equal(requests, 0);
  },
);

test(
  'installer hash and length failures remove partial archives instead of handing them to installation',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const expected = Buffer.from('expected archive');
    let content = Buffer.from('corrupted bytes!');
    const f = await fixture(t, (_request, response) => response.end(content));
    const release = {
      version: '0.3.1',
      platform: 'darwin',
      arch: process.arch,
      format: 'zip',
      size: expected.length,
      sha256: createHash('sha256').update(expected).digest('hex'),
    };
    f.wss.on('connection', (socket) =>
      socket.once('message', () =>
        socket.send(
          JSON.stringify({
            type: 'connection.error',
            code: 'version_mismatch',
            message: 'Version mismatch',
            client: release,
          }),
        ),
      ),
    );
    const bridge = await openProxyBridge({ ...f.config, url: f.address.href }, {});
    t.after(() => bridge.close());
    const renderer = new WebSocket(bridge.url);
    renderer.on('error', () => {});
    await once(renderer, 'open');
    const offer = once(renderer, 'message');
    renderer.send(JSON.stringify({ type: 'auth', token: 'test-credential' }));
    await offer;
    for (const payload of [content, Buffer.alloc(expected.length + 1)]) {
      content = payload;
      await assert.rejects(bridge.downloadInstaller(f.directory), /校验|大小/);
      assert.equal(
        (await readdir(f.directory)).some((name) => name.endsWith('.zip')),
        false,
      );
    }
    content = expected;
    const downloaded = await bridge.downloadInstaller(f.directory);
    assert.deepEqual(await readFile(downloaded.path), expected);
    assert.deepEqual(downloaded.release, release);
  },
);
