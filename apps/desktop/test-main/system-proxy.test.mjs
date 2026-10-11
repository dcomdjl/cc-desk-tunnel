import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, createServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { httpProxy, openSocket } from '../electron/system-proxy.mjs';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
// A CONNECT proxy that records what it was asked for and refuses port 1.
async function proxyServer(requests) {
  return listen((client) => {
    client.once('data', (head) => {
      const line = head.toString('latin1').split('\r\n')[0];
      requests.push(line);
      const [, host, port] = /^CONNECT (.+):(\d+) HTTP\/1\.1$/.exec(line);
      if (port === '1') return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const target = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        client.pipe(target).pipe(client);
      });
      target.on('error', () => client.destroy());
      client.on('error', () => target.destroy());
    });
  });
}

test('only an HTTP proxy in first place is taken from the system answer', () => {
  assert.deepEqual(httpProxy('PROXY 127.0.0.1:7890; DIRECT'), { host: '127.0.0.1', port: 7890 });
  assert.deepEqual(httpProxy('proxy gateway.example:8080'), {
    host: 'gateway.example',
    port: 8080,
  });
  for (const answer of ['DIRECT', 'DIRECT; PROXY 127.0.0.1:7890', 'SOCKS5 127.0.0.1:1080', ''])
    assert.equal(httpProxy(answer), null);
  assert.equal(httpProxy(undefined), null);
});

test('a connection through the proxy reaches the target; without one it goes direct', async (t) => {
  const requests = [];
  const echo = await listen((socket) => socket.pipe(socket));
  const proxy = await proxyServer(requests);
  t.after(() => {
    echo.close();
    proxy.close();
  });
  for (const via of [{ host: '127.0.0.1', port: proxy.address().port }, null]) {
    const socket = await openSocket(via, '127.0.0.1', echo.address().port);
    socket.resume();
    socket.write('ping');
    assert.equal(String((await once(socket, 'data'))[0]), 'ping');
    socket.destroy();
  }
  assert.deepEqual(requests, [`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1`]);
});

test('a refusing or silent proxy fails the connection instead of leaving it open', async (t) => {
  const proxy = await proxyServer([]);
  const silent = await listen(() => {});
  t.after(() => {
    proxy.close();
    silent.close();
  });
  await assert.rejects(
    openSocket({ host: '127.0.0.1', port: proxy.address().port }, '127.0.0.1', 1),
    /403/,
  );
  await assert.rejects(
    openSocket({ host: '127.0.0.1', port: silent.address().port }, '127.0.0.1', 1, 200),
    /timed out/,
  );
});

// A throwaway certificate made in memory by PowerShell; nothing enters the Windows certificate store.
async function selfSigned() {
  const script = `$key = [Security.Cryptography.RSA]::Create(2048)
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, 'SHA256', [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
    @{ cert = $certificate.ExportCertificatePem(); key = $key.ExportPkcs8PrivateKeyPem() } | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)(
    'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  );
  return JSON.parse(stdout);
}

test(
  'the control connection goes through the system proxy and still checks the pinned certificate',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const { cert, key } = await selfSigned();
    const service = createHttpsServer({ cert, key });
    const messages = [];
    new WebSocketServer({ server: service }).on('connection', (socket) =>
      socket.on('message', (raw) => messages.push(String(raw))),
    );
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    const requests = [];
    const asked = [];
    const proxy = await proxyServer(requests);
    const target = `127.0.0.1:${service.address().port}`;
    const open = (fingerprint) =>
      openProxyBridge(
        { url: `wss://${target}/ws`, fingerprint },
        {
          resolveProxy: async (url) => {
            asked.push(url);
            return `PROXY 127.0.0.1:${proxy.address().port}; DIRECT`;
          },
        },
        () => {},
        [undefined],
      );
    const bridges = [];
    t.after(async () => {
      for (const bridge of bridges) await bridge.close();
      service.closeAllConnections();
      service.close();
      proxy.close();
    });
    const send = async (fingerprint) => {
      const bridge = await open(fingerprint);
      bridges.push(bridge);
      const local = new WebSocket(bridge.url);
      await once(local, 'open');
      local.send(JSON.stringify({ type: 'auth', token: 'secret' }));
      return local;
    };

    await send(new X509Certificate(cert).fingerprint256);
    while (!messages.length) await new Promise((resolve) => setTimeout(resolve, 20));
    const { device, ...auth } = JSON.parse(messages[0]);
    assert.deepEqual(auth, { type: 'auth', token: 'secret', tunnel: true });
    assert.equal(device.platform, 'win32');
    assert.equal(device.arch, process.arch);
    assert.equal(device.shell.kind, 'powershell');
    assert.deepEqual(asked, [`https://${target}`]);
    assert.deepEqual(requests, [`CONNECT ${target} HTTP/1.1`]);

    // Another certificate behind the same proxy is refused before the token leaves this machine.
    const refused = await send('AB'.repeat(32));
    assert.match(String((await once(refused, 'message'))[0]), /指纹不匹配/);
    assert.equal(messages.length, 1);
    assert.equal(requests.length, 2);
  },
);
test(
  'a service that goes silent is given up and the reason recorded; one that answers is kept',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const { cert, key } = await selfSigned();
    const fingerprint = new X509Certificate(cert).fingerprint256;
    const bridges = [];
    const services = [];
    t.after(async () => {
      for (const bridge of bridges) await bridge.close();
      for (const service of services) {
        service.closeAllConnections();
        service.close();
      }
    });
    // `answers` is whether the service returns the signs of life it is asked for.
    const connect = async (answers) => {
      const service = createHttpsServer({ cert, key });
      services.push(service);
      new WebSocketServer({ server: service, autoPong: answers });
      service.listen(0, '127.0.0.1');
      await once(service, 'listening');
      const lines = [];
      const bridge = await openProxyBridge(
        { url: `wss://127.0.0.1:${service.address().port}/ws`, fingerprint },
        { heartbeatMs: 100, log: (line) => lines.push(line) },
        () => {},
        [undefined],
      );
      bridges.push(bridge);
      const local = new WebSocket(bridge.url);
      await once(local, 'open');
      return { local, lines };
    };

    const silent = await connect(false);
    const [raw] = await once(silent.local, 'message');
    assert.equal(JSON.parse(String(raw)).code, 'tunnel_failed');
    assert.match(String(raw), /没有收到服务端的任何数据/);
    await once(silent.local, 'close');
    assert.ok(silent.lines.some((line) => line.startsWith('Reached 127.0.0.1')));
    assert.ok(silent.lines.some((line) => line.startsWith('Connection given up: 已有')));

    const answering = await connect(true);
    let ended = false;
    answering.local.once('close', () => (ended = true));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(ended, false);
    assert.equal(
      answering.lines.some((line) => line.startsWith('Connection given up')),
      false,
    );
  },
);
