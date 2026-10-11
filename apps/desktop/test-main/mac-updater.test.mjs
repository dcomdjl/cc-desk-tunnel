import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { test } from 'node:test';
import { createMacUpdateFeed, installMacUpdate } from '../electron/mac-updater.cjs';

function archive(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-mac-update-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archive = join(directory, 'app.zip');
  writeFileSync(archive, 'verified archive');
  return archive;
}

test('Mac feed only exposes the validated archive through a nonce on loopback', async (t) => {
  const feed = await createMacUpdateFeed({ archive: archive(t), version: '1.2.3' });
  t.after(() => feed.close());
  assert.equal(new URL(feed.url).hostname, '127.0.0.1');
  const response = await fetch(feed.url);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const manifest = await response.json();
  assert.equal(manifest.version, '1.2.3');
  assert.equal(await (await fetch(manifest.url)).text(), 'verified archive');
  assert.equal((await fetch(new URL('/feed', feed.url))).status, 404);
  assert.equal((await fetch(feed.url, { method: 'POST' })).status, 404);
  assert.equal(
    await new Promise((resolve, reject) => {
      request(feed.url, { headers: { Host: 'untrusted.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on('error', reject)
        .end();
    }),
    404,
  );
  assert.equal((await fetch(`${feed.url}?token=remote-service-secret`)).status, 404);
});

test('Mac install waits for native verification before quitting, closes the feed and rejects duplicate checks', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  let feedUrl;
  let checked;
  const checking = new Promise((resolve) => (checked = resolve));
  let installed = 0;
  updater.setFeedURL = ({ url, serverType }) => {
    assert.equal(serverType, 'default');
    feedUrl = url;
  };
  updater.checkForUpdates = () => checked();
  updater.quitAndInstall = () => {
    installed++;
    app.emit('will-quit');
  };
  const options = { app, autoUpdater: updater, archive: archive(t), version: '1.2.3' };
  const pending = installMacUpdate(options);
  await checking;
  await assert.rejects(installMacUpdate(options), /正在进行/);
  assert.equal(installed, 0);
  updater.emit('update-downloaded');
  await pending;
  assert.equal(installed, 1);
  assert.equal(updater.listenerCount('error'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
  await assert.rejects(fetch(feedUrl));
});

test('native signing failure preserves the app and clears updater listeners', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  updater.setFeedURL = () => {};
  updater.checkForUpdates = () => updater.emit('error', new Error('Code signature invalid'));
  updater.quitAndInstall = () => assert.fail('must not quit on signature failure');
  await assert.rejects(
    installMacUpdate({ app, autoUpdater: updater, archive: archive(t), version: '1.2.3' }),
    /signature invalid/,
  );
  assert.equal(updater.listenerCount('update-downloaded'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
  await assert.rejects(
    installMacUpdate({ app: { isPackaged: false }, autoUpdater: updater }),
    /源码运行/,
  );
});

test('Mac updater awaits application shutdown preparation before quitAndInstall', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  const order = [];
  let prepared;
  let release;
  const preparing = new Promise((resolve) => (prepared = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  updater.setFeedURL = () => {};
  updater.checkForUpdates = () => {
    order.push('verified');
    updater.emit('update-downloaded');
  };
  updater.quitAndInstall = () => {
    order.push('install');
    app.emit('will-quit');
  };
  const pending = installMacUpdate({
    app,
    autoUpdater: updater,
    archive: archive(t),
    version: '1.2.3',
    beforeInstall: async () => {
      order.push('prepare');
      prepared();
      await gate;
      order.push('closed');
    },
  });
  await preparing;
  assert.deepEqual(order, ['verified', 'prepare']);
  release();
  await pending;
  assert.deepEqual(order, ['verified', 'prepare', 'closed', 'install']);
});

test('application preparation failure cancels immediate installation and cleans up the feed', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  let url;
  updater.setFeedURL = (feed) => (url = feed.url);
  updater.checkForUpdates = () => updater.emit('update-downloaded');
  updater.quitAndInstall = () => assert.fail('must not quit after shutdown preparation failed');
  await assert.rejects(
    installMacUpdate({
      app,
      autoUpdater: updater,
      archive: archive(t),
      version: '1.2.3',
      beforeInstall: async () => {
        throw new Error('active task');
      },
    }),
    /active task.*下次启动/,
  );
  await assert.rejects(fetch(url));
  assert.equal(updater.listenerCount('error'), 0);
  assert.equal(updater.listenerCount('update-downloaded'), 0);
});

test('quitting during shutdown preparation never dispatches a second native quit', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  let ready;
  let finish;
  const preparing = new Promise((resolve) => (ready = resolve));
  const gate = new Promise((resolve) => (finish = resolve));
  updater.setFeedURL = () => {};
  updater.checkForUpdates = () => updater.emit('update-downloaded');
  updater.quitAndInstall = () => assert.fail('already quitting');
  const pending = installMacUpdate({
    app,
    autoUpdater: updater,
    archive: archive(t),
    version: '1.2.3',
    beforeInstall: async () => {
      ready();
      await gate;
    },
  });
  await preparing;
  app.emit('before-quit');
  finish();
  await assert.rejects(pending, /退出.*下次启动/);
});

test('timeout retains ownership of the native check until its terminal event', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  let checked;
  const checking = new Promise((resolve) => (checked = resolve));
  updater.setFeedURL = () => {};
  updater.checkForUpdates = () => checked();
  updater.quitAndInstall = () => assert.fail('must not install a timed-out native result');
  const options = { app, autoUpdater: updater, archive: archive(t), version: '1.2.3' };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = installMacUpdate(options);
  await checking;
  t.mock.timers.tick(900_000);
  await assert.rejects(pending, /超时.*下次启动/);
  await assert.rejects(installMacUpdate(options), /正在进行/);
  assert.doesNotThrow(() => updater.emit('error', new Error('late native download failure')));
  assert.equal(updater.listenerCount('error'), 0);
  updater.checkForUpdates = () => updater.emit('update-not-available');
  await assert.rejects(installMacUpdate(options), /没有提供/);
});

test('native install failure after quitAndInstall is reported without an unhandled error', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  updater.setFeedURL = () => {};
  updater.checkForUpdates = () => updater.emit('update-downloaded');
  updater.quitAndInstall = () =>
    queueMicrotask(() => updater.emit('error', new Error('ShipIt failed')));
  await assert.rejects(
    installMacUpdate({ app, autoUpdater: updater, archive: archive(t), version: '1.2.3' }),
    /ShipIt failed/,
  );
  assert.equal(updater.listenerCount('error'), 0);
  assert.equal(app.listenerCount('will-quit'), 0);
});

test('canceling a native check drains its late result and never installs it', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  const controller = new AbortController();
  let checked;
  const checking = new Promise((resolve) => (checked = resolve));
  updater.setFeedURL = () => {};
  updater.checkForUpdates = () => checked();
  updater.quitAndInstall = () => assert.fail('must not install canceled update');
  const options = { app, autoUpdater: updater, archive: archive(t), version: '1.2.3' };
  const pending = installMacUpdate({ ...options, signal: controller.signal });
  await checking;
  controller.abort(new Error('连接已更换'));
  await assert.rejects(pending, /连接已更换.*下次启动/);
  await assert.rejects(installMacUpdate(options), /正在进行/);
  updater.emit('update-downloaded');
  assert.equal(updater.listenerCount('error'), 0);
  updater.checkForUpdates = () => updater.emit('update-not-available');
  await assert.rejects(installMacUpdate(options), /没有提供/);
});

test('quitting while the feed is being created does not start a native update check', async (t) => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const updater = new EventEmitter();
  updater.setFeedURL = () => assert.fail('must not initialize after quit');
  const pending = installMacUpdate({
    app,
    autoUpdater: updater,
    archive: archive(t),
    version: '1.2.3',
  });
  app.emit('before-quit');
  await assert.rejects(pending, /退出/);
  assert.equal(app.listenerCount('before-quit'), 0);
});
