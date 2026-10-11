const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { installMacUpdate } = require('./mac-updater.cjs');

// One attempt owns its connection, announced asset and private download directory through installation.
async function installClientUpdate({
  app,
  autoUpdater,
  shell,
  connection,
  platform,
  unsigned,
  signal,
  assertCurrent,
  beforeInstall,
  installMac = installMacUpdate,
  launch = spawn,
}) {
  const check = () => {
    signal?.throwIfAborted();
    assertCurrent();
    if (connection.hasActiveRuns()) throw new Error('请先结束运行中的任务，再升级客户端。');
  };
  if (!app.isPackaged) throw new Error('源码运行不支持自升级；请重新打包安装。');
  if (platform === 'darwin' && unsigned)
    throw new Error('未签名内测版不支持自动更新，请从正式发布页手动安装新版本。');
  if (!['darwin', 'win32'].includes(platform)) throw new Error('当前平台不支持应用内安装。');
  check();
  const directory = await mkdtemp(path.join(tmpdir(), 'cc-desk-tunnel-update-'));
  let handedOff = false;
  try {
    check();
    const installer = await connection.downloadInstaller(directory, { signal });
    check();
    if (platform === 'darwin') {
      if (installer.release.format === 'dmg') {
        const failure = await shell.openPath(installer.path);
        if (failure) throw new Error(failure);
        handedOff = true;
        return;
      }
      await installMac({
        app,
        autoUpdater,
        archive: installer.path,
        version: installer.release.version,
        signal,
        beforeInstall: async () => {
          check();
          // Squirrel has staged its own verified copy by update-downloaded. Clean ours before app exit.
          await rm(directory, { recursive: true, force: true });
          check();
          await beforeInstall();
        },
      });
    } else {
      await beforeInstall();
      signal?.throwIfAborted();
      const child = launch(installer.path, ['/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
      });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      child.on('error', () => {});
      child.unref();
      handedOff = true;
      app.quit();
    }
  } finally {
    // A DMG or Windows installer may still be read by the OS after this application returns/exits.
    if (!handedOff) await rm(directory, { recursive: true, force: true });
  }
}

module.exports = { installClientUpdate };
