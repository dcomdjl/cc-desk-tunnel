import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installClientUpdate } from '../electron/client-update.cjs';

function fixture() {
  let directory;
  let availableVersion = '1.2.3';
  const release = { version: '1.2.3', format: 'zip' };
  const app = { isPackaged: true, quit() {} };
  const connection = {
    hasActiveRuns: () => false,
    get release() {
      return { ...release, version: availableVersion };
    },
    async downloadInstaller(root) {
      directory = root;
      const path = join(root, 'installer.zip');
      await writeFile(path, 'validated archive');
      availableVersion = '9.9.9';
      return { path, release };
    },
  };
  return {
    app,
    connection,
    directory: () => directory,
    options: {
      app,
      connection,
      platform: 'darwin',
      signal: new AbortController().signal,
      assertCurrent() {},
      async beforeInstall() {},
    },
  };
}

test('installation uses the downloaded release snapshot and removes its private archive after native consumption', async () => {
  const f = fixture();
  await installClientUpdate({
    ...f.options,
    installMac: async ({ archive, version, beforeInstall }) => {
      assert.equal(version, '1.2.3');
      await access(archive);
      await beforeInstall();
      await assert.rejects(access(archive), { code: 'ENOENT' });
    },
  });
  await assert.rejects(access(f.directory()), { code: 'ENOENT' });
});

test('a connection switch during download prevents installation and reclaims the archive', async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    installClientUpdate({
      ...f.options,
      assertCurrent() {
        if (++calls === 3) throw new Error('connection changed');
      },
      installMac: () => assert.fail('stale attempt must not install'),
    }),
    /connection changed/,
  );
  await assert.rejects(access(f.directory()), { code: 'ENOENT' });
});

test('failed downloads receive the attempt cancellation signal and reclaim partial files', async () => {
  const f = fixture();
  const controller = new AbortController();
  const original = f.connection.downloadInstaller;
  f.connection.downloadInstaller = async (directory, { signal }) => {
    await original(directory);
    assert.equal(signal, controller.signal);
    controller.abort(new Error('cancelled'));
    signal.throwIfAborted();
  };
  await assert.rejects(
    installClientUpdate({ ...f.options, signal: controller.signal }),
    /cancelled/,
  );
  await assert.rejects(access(f.directory()), { code: 'ENOENT' });
});

test('new running tasks block native installation after download', async () => {
  const f = fixture();
  let calls = 0;
  f.connection.hasActiveRuns = () => ++calls === 3;
  await assert.rejects(
    installClientUpdate({ ...f.options, installMac: () => assert.fail('active task') }),
    /运行/,
  );
  await assert.rejects(access(f.directory()), { code: 'ENOENT' });
});

test('Windows spawn failures preserve the running application and clean downloaded files', async () => {
  const f = fixture();
  f.app.quit = () => assert.fail('must not quit when installer failed to start');
  await assert.rejects(
    installClientUpdate({
      ...f.options,
      platform: 'win32',
      launch() {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('error', new Error('installer blocked')));
        return child;
      },
    }),
    /installer blocked/,
  );
  await assert.rejects(access(f.directory()), { code: 'ENOENT' });
});

test('Windows installation waits for execution shutdown before starting the installer', async () => {
  const f = fixture();
  const order = [];
  f.app.quit = () => order.push('quit');
  await installClientUpdate({
    ...f.options,
    platform: 'win32',
    beforeInstall: async () => order.push('closed'),
    launch() {
      order.push('spawn');
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(order, ['closed', 'spawn', 'quit']);
  const { rm } = await import('node:fs/promises');
  await rm(f.directory(), { recursive: true, force: true });
});
