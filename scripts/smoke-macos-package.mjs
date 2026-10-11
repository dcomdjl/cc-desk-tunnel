import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron } from '@playwright/test';

if (process.platform !== 'darwin' || !process.argv[2]?.endsWith('.app'))
  throw new Error('Usage: node scripts/smoke-macos-package.mjs /path/to/CC Desk Tunnel.app');
const appBundle = resolve(process.argv[2]);
const root = resolve('.local/macos-package-smoke');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('PROXY_'),
  ),
);
env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const application = await _electron.launch({
  executablePath: join(appBundle, 'Contents/MacOS/CC Desk Tunnel'),
  args: ['--smoke-test', `--user-data-dir=${join(directory, 'profile')}`],
  cwd: directory,
  env,
  timeout: 30_000,
});
try {
  const errors = [];
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: '连接代理服务', exact: true }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await application.evaluate(() => process.platform), 'darwin');
  // Run transport checks in the packaged Electron binary's Node mode, with only packaged modules.
  execFileSync(
    join(appBundle, 'Contents/MacOS/CC Desk Tunnel'),
    [
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { randomUUID, timingSafeEqual } from 'node:crypto';
    import { mkdir, readdir } from 'node:fs/promises';
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.env.CC_PACKAGE_ROOT;
    const directory = process.cwd();
    const bridge = await import(pathToFileURL(join(root, 'electron/proxy-bridge.mjs')));
    assert.equal(typeof bridge.openProxyBridge, 'function');
    const { startLocalExecutor } = await import(pathToFileURL(join(root, 'electron/local-executor.mjs')));
    const service = await startLocalExecutor(randomUUID(), {
      deviceId: randomUUID(),
      shellPath: '/bin/bash',
      schedulesPath: join(directory, 'schedules.json'),
      env: { HOME: directory, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      cwd: directory,
    }, new AbortController().signal, () => {});
    try {
      assert.equal(service.credentials.device.shell.kind, 'posix');
      const { Client, utils } = createRequire(join(root, 'package.json'))('ssh2');
      const hostKey = utils.parseKey(service.credentials.hostPublicKey).getPublicSSH();
      const client = new Client();
      try {
        await new Promise((resolve, reject) => {
          client.once('error', reject).once('ready', resolve).connect({
            host: '127.0.0.1', port: service.port, username: service.credentials.username,
            privateKey: service.credentials.privateKey,
            hostVerifier: (key) => key.length === hostKey.length && timingSafeEqual(key, hostKey),
          });
        });
        const output = await new Promise((resolve, reject) => client.exec('printf packaged-ssh', (error, stream) => {
          if (error) return reject(error);
          let output = '';
          stream.on('data', (chunk) => output += chunk);
          stream.once('error', reject);
          stream.stderr.resume();
          stream.once('close', (code) => code === 0 ? resolve(output) : reject(new Error('Packaged SSH command failed.')));
          stream.end();
        }));
        assert.equal(output, 'packaged-ssh');
        const project = join(directory, "项目 smoke's fixture");
        await mkdir(project);
        const checked = await service.checkProject(project);
        assert.equal(checked.ok, true, checked.message);
        assert.equal(checked.identity.deviceId, service.credentials.device.deviceId);
        assert.equal(checked.identity.platform, 'darwin');
        assert.deepEqual(await readdir(project), []);
      } finally { client.end(); }
    } finally { await service.close(); }
  `,
    ],
    {
      cwd: directory,
      timeout: 30_000,
      stdio: 'inherit',
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        CC_PACKAGE_ROOT: join(appBundle, 'Contents/Resources/app.asar'),
      },
    },
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: packaged macOS main, preload, UI and forked SSH worker run offline with an isolated profile.',
  );
} finally {
  await application.close();
  rmSync(directory, { recursive: true, force: true });
}
