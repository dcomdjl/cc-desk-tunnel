import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { serverMessageSchema, MAX_FRAME_BYTES } from '@cc-desk-tunnel/protocol';
import { executionDescriptor, startLocalExecutor } from './local-executor.mjs';
import { openChannels } from './tunnel-channels.mjs';
import { httpProxy, openSocket } from './system-proxy.mjs';
import { channelFailure, controlFailure } from './connect-errors.mjs';

export function certificateMatches(observed, trusted) {
  if (typeof trusted !== 'string' || typeof observed !== 'string') return false;
  const pin = trusted.replaceAll(':', '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(pin) && observed.replaceAll(':', '').toLowerCase() === pin;
}
export function controlTlsOptions(config) {
  if (!config.fingerprint) return { rejectUnauthorized: true };
  if (!certificateMatches(config.fingerprint, config.fingerprint))
    throw new Error('请输入可信安装信息中的 SHA256 证书指纹，或留空使用 CA 验证。');
  return { rejectUnauthorized: false };
}
// The waits of connecting, in milliseconds. Whatever is not a sensible number of seconds takes the default, and
// the whole is never shorter than the local SSH service is given plus the rest of the way.
export function connectionWaits(values) {
  const wait = (seconds, fallback) =>
    (Number.isInteger(seconds) && seconds >= 5 && seconds <= 600 ? seconds : fallback) * 1000;
  const ssh = wait(values?.ssh, 10);
  return {
    connect: wait(values?.connect, 15),
    ssh,
    ready: Math.max(wait(values?.ready, 45), ssh + 35000),
  };
}
// Starts TLS with the service, through the system's HTTP proxy when the Windows settings name one for it. The proxy
// only relays bytes: the certificate is still the service's own and is judged as on a direct connection.
// `route`, when given, is told the proxy that was used, for the words of a failure.
async function connectService(address, config, resolveProxy, route, signal) {
  signal?.throwIfAborted();
  const port = Number(address.port || 443);
  const answer = resolveProxy
    ? await new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        Promise.resolve()
          .then(() => resolveProxy(`https://${address.hostname}:${port}`))
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', cancel));
      })
    : undefined;
  const proxy = httpProxy(answer);
  signal?.throwIfAborted();
  if (route) route.proxy = proxy;
  const host = address.hostname.replace(/^\[|\]$/g, '');
  const tcp = await openSocket(proxy, host, port, connectionWaits(config.waits).connect, signal);
  try {
    signal?.throwIfAborted();
    const socket = connect({
      socket: tcp,
      servername: isIP(host) ? undefined : host,
      ...controlTlsOptions(config),
    });
    const cancel = () => socket.destroy(signal.reason ?? new Error('Connection cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    socket.once('close', () => signal?.removeEventListener('abort', cancel));
    return socket;
  } catch (error) {
    tcp.destroy();
    throw error;
  }
}
// An HTTPS GET carrying the service token. A pinned certificate is checked once the connection stands and before
// the request, and with it the token, is written to it.
export async function authorizedGet(address, config, path, token, resolveProxy, options = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason ?? new Error('Download cancelled'));
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  };
  const timer = setTimeout(
    () => controller.abort(new Error('安装包连接或响应超时，请重试。')),
    options.timeoutMs ?? connectionWaits(config.waits).connect,
  );
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let socket;
  try {
    socket = await connectService(address, config, resolveProxy, undefined, controller.signal);
    await new Promise((resolve, reject) => {
      const failed = (error) => {
        socket.off('secureConnect', secured);
        reject(error);
      };
      const secured = () => {
        socket.off('error', failed);
        if (
          config.fingerprint &&
          !certificateMatches(socket.getPeerCertificate().fingerprint256, config.fingerprint)
        ) {
          socket.destroy();
          reject(new Error('服务证书指纹不匹配；未发送服务凭据。'));
        } else resolve();
      };
      socket.once('secureConnect', secured);
      socket.once('error', failed);
    });
    return await new Promise((resolve, reject) => {
      const download = request(
        {
          host: address.hostname,
          path,
          createConnection: () => socket,
          signal: controller.signal,
          headers: { Host: address.host, Authorization: `Bearer ${token}` },
        },
        (response) => {
          clearTimeout(timer);
          response.on('error', () => {});
          response.once('close', cleanup);
          resolve(response);
        },
      );
      download.on('error', reject);
      download.end();
    });
  } catch (error) {
    cleanup();
    socket?.destroy();
    throw error;
  }
}

export async function openProxyBridge(
  config,
  binaries,
  onClosed = () => {},
  allowedOrigins = ['null', 'file://', undefined],
) {
  const address = new URL(config.url);
  if (
    address.protocol !== 'wss:' ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('原生模式需要不含凭据的 WSS 地址。');
  // A malformed pin is refused here, before anything listens or connects.
  controlTlsOptions(config);
  binaries.signal?.throwIfAborted();
  const device = await executionDescriptor(binaries);
  binaries.signal?.throwIfAborted();
  const waits = connectionWaits(config.waits);
  const log = binaries.log ?? (() => {});
  const heartbeatMs = binaries.heartbeatMs ?? 15000;
  const nonce = randomBytes(32).toString('hex');
  const server = createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let pair;
  // Kept for the installer download, which uses the same secret and certificate check as the connection.
  let token = '';
  let release;
  const activeRuns = new Set();
  let closed = false;
  let closing;
  server.on('upgrade', (request, socket, head) => {
    if (
      closed ||
      pair ||
      request.url !== `/bridge/${nonce}` ||
      !allowedOrigins.includes(request.headers.origin)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (local) => {
    // CA verification completes at TLS handshake; explicit pins are checked before sending credentials.
    const route = { proxy: null };
    const controller = new AbortController();
    const remote = new WebSocket(address, {
      handshakeTimeout: waits.connect,
      // Node's HTTP client also takes the connection through this callback once it is ready.
      createConnection: (_options, created) => {
        connectService(address, config, binaries.resolveProxy, route, controller.signal).then(
          (socket) => created(null, socket),
          created,
        );
      },
    });
    pair = {
      local,
      remote,
      controller,
      ssh: null,
      channels: null,
      preparing: null,
    };
    const current = pair;
    const queue = [];
    let verified = false;
    let nativeReady;
    let offerReceived = false;
    const target = `${address.hostname}:${address.port || 443}`;
    const began = Date.now();
    log(`Connecting to ${target}.`);
    // The service asks for a sign of life every 15 seconds and gives up after two without an answer. A path
    // that stops delivering without closing would leave this side waiting for good: the page shows a run that
    // the service has long ended. So this side asks as well, and counts whatever arrives from the service.
    let heard = Date.now();
    let heartbeat;
    const alive = () => (heard = Date.now());
    remote.on('ping', alive);
    remote.on('pong', alive);
    const timer = setTimeout(
      () =>
        fail(
          offerReceived
            ? channelFailure(waits.ready / 1000, current.channels?.lastError, target, route.proxy)
            : `服务端在 ${waits.ready / 1000} 秒内没有完成应答。\n请检查网络是否稳定，或稍后重试；反复出现时查看服务端日志。`,
        ),
      waits.ready,
    );
    // One more connection to the service, for one SSH connection. It is checked like the control connection
    // before anything is sent on it.
    function dialChannel() {
      return new Promise((resolve, reject) => {
        const channel = new WebSocket(address, {
          handshakeTimeout: waits.connect,
          // SSH traffic is already encrypted and does not compress.
          perMessageDeflate: false,
          createConnection: (_options, created) => {
            connectService(
              address,
              config,
              binaries.resolveProxy,
              undefined,
              controller.signal,
            ).then((socket) => created(null, socket), created);
          },
        });
        channel.once('error', (error) => {
          channel.terminate();
          reject(error);
        });
        channel.once('open', () => {
          if (
            config.fingerprint &&
            !certificateMatches(
              channel._socket.getPeerCertificate().fingerprint256,
              config.fingerprint,
            )
          ) {
            channel.terminate();
            reject(
              Object.assign(
                new Error(
                  '执行通道连到的服务证书指纹不匹配；未发送任何凭据。\n控制连接校验通过之后，同一地址应答了另一张证书：请确认服务地址没有被劫持或指向多台服务器。',
                ),
                { fatal: true },
              ),
            );
          } else resolve(channel);
        });
      });
    }
    function fail(message) {
      if (closed) return;
      if (local.readyState === WebSocket.OPEN)
        local.send(JSON.stringify({ type: 'connection.error', code: 'tunnel_failed', message }));
      clearTimeout(timer);
      void close(true);
    }
    remote.on('open', () => {
      if (
        config.fingerprint &&
        !certificateMatches(remote._socket.getPeerCertificate().fingerprint256, config.fingerprint)
      ) {
        fail(
          '服务证书指纹不匹配；未发送服务凭据。\n请核对“服务证书指纹”是否与安装时给出的一致；服务端更换过证书后需要填新的指纹。若两者都没变，说明连到的不是你的服务器。',
        );
        return;
      }
      verified = true;
      log(`Reached ${target}${route.proxy ? ' through the system proxy' : ''}.`);
      for (const message of queue) remote.send(message);
      queue.length = 0;
      alive();
      heartbeat = setInterval(() => {
        const silent = Date.now() - heard;
        // Its own question is answered within moments, so the third one unanswered falls just short of three
        // periods of silence.
        if (silent > heartbeatMs * 2.5)
          fail(
            `已有 ${Math.round(silent / 1000)} 秒没有收到服务端的任何数据，连接已经断开。\n途中的网络、代理或反向代理中断了这条连接而没有通知本机。请重新连接；正在进行的任务可能已被服务端结束，重新连接后可以在会话里看到它停在哪里。`,
          );
        else if (remote.readyState === WebSocket.OPEN) remote.ping();
      }, heartbeatMs);
      current.controller.signal.addEventListener('abort', () => clearInterval(heartbeat));
    });
    local.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString('utf8'));
        if (message.type?.startsWith('tunnel.')) throw new Error('Renderer tunnel message');
        if (message.type === 'auth') {
          message.tunnel = true;
          token = String(message.token);
        }
        if (message.type === 'device') {
          if (message.id !== device.deviceId) throw new Error('Renderer device identity mismatch');
          message.platform = device.platform;
          message.arch = device.arch;
        }
        if (verified && remote.readyState === WebSocket.OPEN) remote.send(JSON.stringify(message));
        else queue.push(JSON.stringify(message));
      } catch {
        fail('客户端消息格式错误。');
      }
    });
    remote.on('message', (raw) => {
      alive();
      let message;
      try {
        message = serverMessageSchema.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        fail('服务端的消息无法识别。\n客户端与服务端的版本可能不一致，请把两者升级到同一版本。');
        return;
      }
      if (message.type === 'client.release') {
        release = message.client ?? undefined;
        if (nativeReady) nativeReady = { ...nativeReady, client: release };
      }
      if (message.type === 'ready') {
        activeRuns.clear();
        for (const session of message.sessions) if (session.activeRun) activeRuns.add(session.id);
      } else if (message.type === 'session.updated') {
        if (message.session.activeRun) activeRuns.add(message.session.id);
        else activeRuns.delete(message.session.id);
      } else if (message.type === 'session.deleted') activeRuns.delete(message.sessionId);
      // A service of another version refuses the connection but may still offer the installer for its own.
      if (message.type === 'connection.error' && message.client) release = message.client;
      if (message.type === 'connection.error')
        log(`The service refused or ended the connection: ${message.code}.`);
      if (message.type === 'tunnel.offer') {
        if (offerReceived || !nativeReady || nativeReady.connectionId !== message.connectionId) {
          fail('隧道连接标识不匹配。');
          return;
        }
        offerReceived = true;
        current.preparing = startLocalExecutor(
          message.connectionId,
          { ...binaries, device },
          current.controller.signal,
          fail,
          waits.ssh,
        )
          .then((ssh) => {
            current.ssh = ssh;
            if (closed || remote.readyState !== WebSocket.OPEN) return;
            current.channels = openChannels(message, ssh.port, dialChannel, fail);
            remote.send(JSON.stringify(ssh.credentials));
          })
          .catch((error) => fail(error.message));
      } else if (message.type === 'tunnel.open') {
        // Only ever follows the credentials, which are sent once the channels can be opened.
        if (message.connectionId === nativeReady?.connectionId)
          current.channels?.open(message.channelId);
      } else if (message.type === 'ready' && message.adapter === 'claude-code') {
        nativeReady = message;
        release = message.client;
      } else if (message.type === 'tunnel.ready') {
        if (!offerReceived || message.connectionId !== nativeReady?.connectionId) {
          fail('隧道就绪标识不匹配。');
          return;
        }
        clearTimeout(timer);
        log(
          `Connected as ${message.connectionId.slice(0, 8)} to service ${nativeReady.version ?? 'of unknown version'}; commands can run.`,
        );
        if (local.readyState === WebSocket.OPEN) local.send(JSON.stringify(nativeReady));
      } else if (local.readyState === WebSocket.OPEN) {
        if (message.type === 'ready') clearTimeout(timer);
        local.send(raw.toString('utf8'));
      }
    });
    for (const socket of [local, remote]) {
      socket.on('close', (code) => {
        clearTimeout(timer);
        // Who ended it first is what tells a fault on the way from a decision of this program or the service.
        if (!closed)
          log(
            `${socket === remote ? 'The service side' : 'The window'} closed the connection first, code ${code}, after ${Math.round((Date.now() - began) / 1000)} s.`,
          );
        void close(true);
      });
      socket.on('error', (error) =>
        fail(
          controlFailure(
            error,
            `${address.hostname}:${address.port || 443}`,
            socket === remote ? route.proxy : null,
          ),
        ),
      );
    }
  });
  async function close(notify = false) {
    if (closing) return closing;
    if (pair && !notify) log('Connection closed from this client.');
    closed = true;
    closing = (async () => {
      pair?.controller.abort();
      pair?.local.close();
      pair?.remote.terminate();
      await pair?.preparing;
      pair?.channels?.close();
      await pair?.ssh?.close();
      for (const socket of wss.clients) socket.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      if (notify) onClosed();
    })();
    return closing;
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // Fetches the installer the service announced and accepts it only if its hash matches. Works after the
  // connection closed, as it does when the service refused this client's version.
  async function downloadInstaller(directory, options) {
    if (!release || !token) throw new Error('服务端没有提供客户端安装包。');
    const expected = release;
    const platform = expected.platform ?? 'win32';
    const arch = expected.arch ?? 'x64';
    if (platform !== device.platform || arch !== device.arch)
      throw new Error('服务端提供的安装包与本机平台或架构不符。');
    const format = expected.format ?? 'exe';
    const target = join(
      directory,
      `CC-Desk-Tunnel-${expected.version}-${platform}-${arch}.${format}`,
    );
    const response = await authorizedGet(
      address,
      config,
      expected.platform
        ? `/client/installer?platform=${platform}&arch=${arch}`
        : '/client/installer',
      token,
      binaries.resolveProxy,
      options,
    );
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`安装包下载失败（${response.statusCode}）。`);
    }
    const hash = createHash('sha256');
    let size = 0;
    response.setTimeout(30000, () => response.destroy(new Error('安装包下载没有进展，请重试。')));
    response.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
      if (size > expected.size) response.destroy(new Error('安装包大小与发布清单不符。'));
    });
    try {
      await pipeline(response, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      if (size !== expected.size || hash.digest('hex') !== expected.sha256)
        throw new Error('安装包校验失败，已放弃升级。');
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    return { path: target, release: expected };
  }
  return {
    url: `ws://127.0.0.1:${server.address().port}/bridge/${nonce}`,
    close,
    downloadInstaller,
    get release() {
      return release;
    },
    hasActiveRuns: () => activeRuns.size > 0,
    checkProject: (directory, options) => {
      if (!pair?.ssh?.checkProject) throw new Error('本机执行端尚未就绪。');
      return pair.ssh.checkProject(directory, options);
    },
  };
}
