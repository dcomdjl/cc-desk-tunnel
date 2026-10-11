const { randomBytes } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { stat } = require('node:fs/promises');
const { createServer } = require('node:http');

// The archive has already crossed the authorized, certificate-pinned service connection and passed its
// manifest hash check. Squirrel only sees this temporary loopback feed, never the service credential.
async function createMacUpdateFeed({ archive, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !archive.endsWith('.zip'))
    throw new Error('macOS 自动更新需要 ZIP 安装包和有效版本号。');
  const info = await stat(archive);
  if (!info.isFile() || !info.size) throw new Error('更新安装包为空或不存在。');
  const nonce = randomBytes(32).toString('hex');
  let base;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.headers.host !== new URL(base).host) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === `/${nonce}/feed`) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ url: `${base}/${nonce}/app.zip`, name: version, version }));
    } else if (request.url === `/${nonce}/app.zip`) {
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': info.size });
      const stream = createReadStream(archive);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } else response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/${nonce}/feed`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

const active = new WeakSet();
async function installMacUpdate({ app, autoUpdater, archive, version, beforeInstall, signal }) {
  if (!app.isPackaged) throw new Error('源码运行不支持自升级；请重新打包安装。');
  if (active.has(autoUpdater)) throw new Error('客户端更新正在进行。');
  active.add(autoUpdater);
  let feed;
  let nativePending = false;
  let nativeStarted = false;
  let nativeDownloaded = false;
  let canceled;
  let cancelWaiting;
  const cacheNotice = '原生缓存的更新可能在下次启动时应用。';
  const withCacheNotice = (error) =>
    error.message?.includes(cacheNotice)
      ? error
      : new Error(`${error.message || error} ${cacheNotice}`, { cause: error });
  const cancel = (error) => {
    canceled = nativeStarted ? withCacheNotice(error) : error;
    cancelWaiting?.(canceled);
  };
  const onQuit = () => cancel(new Error('客户端已退出，更新已取消。'));
  const onAbort = () =>
    cancel(signal.reason instanceof Error ? signal.reason : new Error('更新已取消。'));
  const assertRunning = () => {
    if (canceled) throw canceled;
  };
  app.once('before-quit', onQuit);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    assertRunning();
    feed = await createMacUpdateFeed({ archive, version });
    assertRunning();
    await new Promise((resolve, reject) => {
      let waiting = true;
      const finish = (error, terminal = true) => {
        clearTimeout(timer);
        if (terminal) {
          nativePending = false;
          autoUpdater.removeListener('error', failed);
          autoUpdater.removeListener('update-not-available', unavailable);
          autoUpdater.removeListener('update-downloaded', downloaded);
          // A timeout or quit cannot cancel Squirrel's native check. Drain its terminal event before
          // allowing another check, so a late result cannot be consumed by a different attempt.
          if (!waiting) active.delete(autoUpdater);
        }
        if (waiting) {
          waiting = false;
          cancelWaiting = undefined;
          error ? reject(error) : resolve();
        }
      };
      const failed = (error) => finish(new Error(`macOS 更新没有完成：${error.message || error}`));
      const unavailable = () => finish(new Error('macOS 更新服务没有提供可安装版本。'));
      const downloaded = () => {
        nativeDownloaded = true;
        finish();
      };
      cancelWaiting = (error) => finish(error, false);
      const timer = setTimeout(
        () =>
          finish(withCacheNotice(new Error('macOS 更新超时；原生检查结束前不能再次更新。')), false),
        900_000,
      );
      timer.unref();
      autoUpdater.once('error', failed);
      autoUpdater.once('update-not-available', unavailable);
      autoUpdater.once('update-downloaded', downloaded);
      try {
        // Default Squirrel feed schema. Squirrel verifies the signed application before it stages it.
        autoUpdater.setFeedURL({ url: feed.url, serverType: 'default' });
        if (waiting) {
          nativePending = true;
          nativeStarted = true;
          autoUpdater.checkForUpdates();
        }
      } catch (error) {
        failed(error);
      }
    });
    assertRunning();
    feed.close();
    await beforeInstall?.();
    assertRunning();
    app.removeListener('before-quit', onQuit);
    signal?.removeEventListener('abort', onAbort);
    // quitAndInstall returns before Squirrel launches ShipIt. Its asynchronous error must still be
    // observed; only application exit confirms successful dispatch.
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        autoUpdater.removeListener('error', failed);
        app.removeListener('will-quit', exited);
        error ? reject(error) : resolve();
      };
      const failed = (error) => finish(new Error(`macOS 安装没有完成：${error.message || error}`));
      const exited = () => finish();
      autoUpdater.once('error', failed);
      app.once('will-quit', exited);
      try {
        autoUpdater.quitAndInstall();
      } catch (error) {
        failed(error);
      }
    });
  } catch (error) {
    throw nativeDownloaded ? withCacheNotice(error) : error;
  } finally {
    feed?.close();
    app.removeListener('before-quit', onQuit);
    signal?.removeEventListener('abort', onAbort);
    if (!nativePending) active.delete(autoUpdater);
  }
}

module.exports = { createMacUpdateFeed, installMacUpdate };
