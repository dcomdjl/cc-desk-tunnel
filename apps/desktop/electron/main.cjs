const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  powerSaveBlocker,
  powerMonitor,
  autoUpdater,
  safeStorage,
  session,
  ipcMain,
  dialog,
  shell,
  clipboard,
  net,
} = require('electron');
const path = require('node:path');
const {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} = require('node:fs');
const { stat, writeFile } = require('node:fs/promises');
const { gitBranch } = require('./git-branch.cjs');
const { openLog } = require('./client-log.cjs');
const { hostname, tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { readdir, rmdir, unlink } = require('node:fs/promises');
const { projectIdentity, projectIdentities, removeEmptyWorkspace } = require('./project-paths.cjs');
const { randomUUID } = require('node:crypto');
const { mkdir } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
let bridge;
// The last connection, kept for its installer download after a service refused this client's version.
let lastBridge;
let connectionGeneration = 0;
let connecting;
let updateAttempt;
const cancelUpdate = () =>
  updateAttempt?.abort(new Error('连接已改变或客户端正在退出，更新已停止。'));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
function showWindow() {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
app.on('second-instance', showWindow);
app.on('activate', showWindow);

// Window preferences and the optional saved sign-in live in the user's profile, outside the install directory.
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(values) {
  const settings = { ...readSettings(), ...values };
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  return settings;
}
function deviceId() {
  const saved = readSettings().deviceId;
  if (typeof saved === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved))
    return saved;
  const created = randomUUID();
  writeSettings({ deviceId: created });
  return created;
}
handle('device:info', () => ({
  deviceId: deviceId(),
  platform: process.platform,
  arch: process.arch,
  name: hostname(),
}));
handle('project:identities', (_event, directories) => projectIdentities(directories));
handle('project:check', async (_event, directory, options) => {
  const { accessFailure, accessStatus } = await import(
    pathToFileURL(path.join(__dirname, 'project-access.mjs')).href
  );
  if (!bridge) return accessStatus('offline', 'connect', directory);
  const current = bridge;
  let stage = 'connect';
  let source = 'ssh';
  let result;
  try {
    result = await current.checkProject(directory, {
      targetPath: options?.targetPath,
      targetOperation: options?.targetOperation,
    });
    if (result.ok) {
      stage = 'path';
      source = 'filesystem';
      result = { ...result, identity: await projectIdentity(result.path) };
    }
  } catch (error) {
    result = accessFailure(error, stage, { source, path: directory });
  }
  if (current !== bridge) return accessStatus('cancelled', 'connect', directory);
  return result;
});
handle('privacy:open', async () => {
  if (process.platform !== 'darwin') throw new Error('当前系统不支持 macOS 隐私设置。');
  // A dedicated fixed destination avoids exposing arbitrary system URL schemes.
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  );
});

// See client-log.cjs. Opened on first use, once the profile directory is known.
let record;
function log(text) {
  record ??= openLog(path.join(app.getPath('userData'), 'logs'));
  record.write(text);
  return record.directory;
}

// A remote connection carries long unattended runs; the computer must not go to sleep underneath it.
// The display may still turn off.
let awake;
function keepAwake(on) {
  if (on && awake === undefined) awake = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && awake !== undefined) {
    powerSaveBlocker.stop(awake);
    awake = undefined;
  }
}

// These channels answer only the application's own page.
function handle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame.url.startsWith('file://')) throw new Error('Untrusted renderer');
    return listener(event, ...args);
  });
}

handle('project:choose', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(window, {
    title: '添加项目',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
// Files the user wants to mention in a message: only their paths go to the page.
handle('files:choose', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '添加文件',
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});
// A picture that is only on the clipboard has no file Claude could be pointed at. It is written into the
// profile, from where Claude reads it like any other attached file; a week later it is removed at start.
const pastedDirectory = () => path.join(app.getPath('userData'), 'pasted');
const pictureTypes = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
handle('image:save', async (_event, type, bytes) => {
  const extension = pictureTypes[String(type)];
  if (!extension || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 20 << 20)
    throw new Error('只能粘贴不超过 20 MB 的图片。');
  await mkdir(pastedDirectory(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = path.join(pastedDirectory(), `${stamp}-${randomUUID().slice(0, 6)}.${extension}`);
  await writeFile(target, bytes);
  return target;
});
async function clearPastedPictures() {
  for (const name of await readdir(pastedDirectory()).catch(() => [])) {
    const file = path.join(pastedDirectory(), name);
    const age = Date.now() - (await stat(file).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
    if (age > 7 * 24 * 3600 * 1000) await unlink(file).catch(() => {});
  }
}
// Writes text the page produced (an exported session) where the user chooses.
handle('file:save', async (event, name, text) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '导出',
    defaultPath: path.join(app.getPath('downloads'), path.basename(String(name))),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, String(text), 'utf8');
  return true;
});
handle('folder:open', async (_event, directory) => {
  const target = path.resolve(String(directory));
  if (!(await stat(target)).isDirectory()) throw new Error('不是文件夹。');
  const failure = await shell.openPath(target);
  if (failure) throw new Error(failure);
});
handle('log:open', async () => {
  const failure = await shell.openPath(log('The log folder was opened.'));
  if (failure) throw new Error(failure);
});
handle('git:branch', (_event, directory) => gitBranch(directory));
handle('clipboard:write', (_event, text) => {
  if (typeof text !== 'string') throw new Error('Expected clipboard text');
  clipboard.writeText(text);
});
// The official sign-in page and this project's own page open in the user's browser; nothing else is handed to the
// system.
handle('external:open', async (event, target) => {
  const url = new URL(String(target));
  if (
    url.protocol !== 'https:' ||
    !/(^|\.)(claude\.com|claude\.ai|anthropic\.com)$|^github\.com$/.test(url.hostname)
  )
    throw new Error('Unexpected link');
  await shell.openExternal(url.toString());
});
// Sessions without a project still need a Windows working directory; they get one under Documents, grouped by
// day, unless the user chose another folder. Folders used before are remembered: their sessions are still
// sessions without a project.
const defaultRoot = () => path.join(app.getPath('documents'), 'CC Desk Tunnel');
function workspaceRoots() {
  const saved = readSettings().workspaceRoots;
  const roots = [...(Array.isArray(saved) ? saved : []), defaultRoot()].filter(
    (root) => typeof root === 'string' && root,
  );
  const key = (root) =>
    process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  return roots.filter(
    (root, index) => roots.findIndex((item) => key(item) === key(root)) === index,
  );
}
handle('workspace:roots', () => workspaceRoots());
handle('workspace:choose', async (event, reset) => {
  let chosen = defaultRoot();
  if (reset !== true) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '普通会话的文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return workspaceRoots();
    chosen = result.filePaths[0];
  }
  writeSettings({ workspaceRoots: [chosen, ...workspaceRoots()] });
  return workspaceRoots();
});
handle('workspace:create', async (event) => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const day = path.join(
    workspaceRoots()[0],
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  );
  await mkdir(day, { recursive: true });
  const name = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let attempt = 0; ; attempt++) {
    const directory = path.join(day, attempt ? `${name}-${attempt}` : name);
    try {
      await mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
});
handle('workspace:remove', async (event, directory) => {
  await removeEmptyWorkspace(directory, workspaceRoots());
});
handle('proxy:connect', async (event, config) => {
  if (!config || typeof config.url !== 'string' || typeof config.fingerprint !== 'string')
    throw new Error('Invalid proxy configuration');
  cancelUpdate();
  connecting?.abort(new Error('Connection cancelled'));
  const controller = new AbortController();
  connecting = controller;
  const generation = ++connectionGeneration;
  const previous = bridge;
  bridge = null;
  await previous?.close();
  if (generation !== connectionGeneration) throw new Error('Connection cancelled');
  const { openProxyBridge } = await import(
    pathToFileURL(path.join(__dirname, 'proxy-bridge.mjs')).href
  );
  const vendor =
    process.env.PROXY_VENDOR_DIR ??
    (app.isPackaged
      ? path.join(process.resourcesPath, 'vendor')
      : path.join(__dirname, '../vendor'));
  const openssh = process.env.PROXY_OPENSSH_DIR ?? path.join(vendor, 'openssh');
  const powershell = app.isPackaged ? path.join(vendor, 'pwsh/pwsh.exe') : 'pwsh.exe';
  const connection = await openProxyBridge(
    config,
    {
      openssh,
      powershell,
      deviceId: deviceId(),
      schedulesPath: schedulesPath(),
      signal: controller.signal,
      scriptDirectory: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked/electron')
        : undefined,
      // Where Claude finds the scheduled tasks to edit; the service names the variable, not the path.
      environment: { CC_DESK_TUNNEL_SCHEDULES: schedulesPath() },
      log,
      // The Windows proxy settings (manual, script or automatic detection) as Chromium reads them.
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    },
    () => {
      if (bridge !== connection) return;
      bridge = null;
      keepAwake(false);
      if (!event.sender.isDestroyed()) event.sender.send('proxy:closed');
    },
  );
  if (generation !== connectionGeneration) {
    await connection.close();
    throw new Error('Connection cancelled');
  }
  if (connecting === controller) connecting = undefined;
  bridge = lastBridge = connection;
  keepAwake(true);
  return { url: bridge.url };
});
// The service token is saved only through the OS credential store.
handle('login:load', () => {
  const { login } = readSettings();
  if (!login) return null;
  let token = '';
  let notice;
  try {
    if (login.token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Credential store unavailable');
      token = safeStorage.decryptString(Buffer.from(login.token, 'base64'));
    }
  } catch {
    notice = '无法读取已保存的服务凭据。请检查系统凭据存储或钥匙串权限，或重新输入凭据。';
  }
  return {
    url: String(login.url ?? ''),
    fingerprint: String(login.fingerprint ?? ''),
    mode: login.mode === 'local' ? 'local' : 'remote',
    token,
    remember: !!token,
    autoLogin: !!token && login.autoLogin === true,
    notice,
  };
});
handle('login:save', (_event, login) => {
  const remember = login?.remember === true;
  if (remember && !safeStorage.isEncryptionAvailable())
    throw new Error('系统凭据存储不可用，无法保存服务凭据。请检查钥匙串访问权限后重试。');
  writeSettings({
    login: remember
      ? {
          url: String(login.url),
          fingerprint: String(login.fingerprint),
          mode: login.mode === 'local' ? 'local' : 'remote',
          token: safeStorage.encryptString(String(login.token)).toString('base64'),
          autoLogin: login.autoLogin === true,
        }
      : undefined,
  });
});
// Replaces a file whole through a flushed temporary file, so a crash or power loss in the middle of a write
// leaves the previous content in place.
function replaceFile(target, text) {
  const temporary = `${target}.tmp`;
  const file = openSync(temporary, 'w');
  try {
    writeSync(file, text);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, target);
}
// Unsent message text, per session.
const draftsPath = () => path.join(app.getPath('userData'), 'drafts.json');
handle('drafts:load', () => {
  try {
    return JSON.parse(readFileSync(draftsPath(), 'utf8'));
  } catch {
    return {};
  }
});
handle('drafts:save', (_event, drafts) => replaceFile(draftsPath(), JSON.stringify(drafts)));
// Scheduled tasks are one JSON file that the window, the user and Claude over SSH may all edit. The window
// decides what the text means; here it is only read, written and watched. An editor's byte-order mark is
// dropped.
const schedulesPath = () => path.join(app.getPath('userData'), 'schedules.json');
const readSchedules = () => readFileSync(schedulesPath(), 'utf8').replace(/^\uFEFF/, '');
let schedules;
handle('schedules:load', (_event, initial) => {
  if (!existsSync(schedulesPath())) replaceFile(schedulesPath(), String(initial));
  // An edit made outside the window is noticed by looking at the file every two seconds.
  if (schedules === undefined) {
    let stamp = 0;
    setInterval(() => {
      let text;
      try {
        const modified = statSync(schedulesPath()).mtimeMs;
        if (modified === stamp) return;
        stamp = modified;
        text = readSchedules();
      } catch {
        return;
      }
      if (text === schedules) return;
      schedules = text;
      BrowserWindow.getAllWindows()[0]?.webContents.send('schedules:changed', text);
    }, 2000);
  }
  schedules = readSchedules();
  return { path: schedulesPath(), text: schedules };
});
handle('schedules:save', (_event, text) => {
  schedules = String(text);
  replaceFile(schedulesPath(), schedules);
});
handle('app:version', () => app.getVersion());
// Which of the user's computers this is to the service: an ID made once and kept, under the computer's name.
handle('device:get', () => ({
  id: deviceId(),
  name: hostname(),
}));
handle('app:quit', () => app.quit());
let refreshTray = () => {};
handle('window:settings', () => ({ closeToTray: readSettings().closeToTray !== false }));
handle('window:settings:set', (_event, values) => {
  writeSettings({ closeToTray: values?.closeToTray !== false });
  refreshTray();
});
// What the user should know while the window is not in front goes through the system's own notifications.
// A notification is kept until it closes, or it could be collected before it is clicked.
const toasts = new Set();
handle('notify:show', (event, notice) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !Notification.isSupported()) return;
  const inFront = window.isVisible() && window.isFocused() && !window.isMinimized();
  if (inFront && notice?.always !== true) return;
  const toast = new Notification({
    title: String(notice?.title ?? '').slice(0, 80),
    body: String(notice?.body ?? '').slice(0, 300),
    silent: notice?.silent === true,
    icon: path.join(__dirname, 'icon.png'),
  });
  toasts.add(toast);
  toast.on('close', () => toasts.delete(toast));
  toast.on('click', () => {
    toasts.delete(toast);
    showWindow();
    if (!event.sender.isDestroyed())
      event.sender.send('notify:clicked', notice?.sessionId ? String(notice.sessionId) : null);
  });
  toast.show();
  // A window left open behind others also asks for attention in the taskbar.
  if (window.isVisible() && !inFront) {
    window.flashFrame(true);
    window.once('focus', () => window.flashFrame(false));
  }
});
// Upgrades in place: the installer comes from the connected service, runs silently over the current install
// and starts the new version.
handle('update:install', async (event, version) => {
  if (updateAttempt) throw new Error('客户端更新正在进行。');
  if (!lastBridge) throw new Error('请先连接服务。');
  const connection = lastBridge;
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(version)))
    throw new Error('版本号不正确。');
  const generation = connectionGeneration;
  const controller = new AbortController();
  updateAttempt = controller;
  const assertCurrent = () => {
    if (lastBridge !== connection || connectionGeneration !== generation || quitting)
      throw new Error('连接已改变或客户端正在退出，更新已停止。');
  };
  const { installClientUpdate } = require('./client-update.cjs');
  let prepared = false;
  try {
    const downloadConnection =
      version === undefined
        ? connection
        : {
            hasActiveRuns: () => connection.hasActiveRuns(),
            downloadInstaller: async (directory, { signal }) => {
              const { downloadRelease } = await import(
                pathToFileURL(path.join(__dirname, 'release-download.mjs')).href
              );
              let release;
              let told = 0;
              const announced =
                connection.release?.platform === process.platform ||
                (!connection.release?.platform && process.platform === 'win32')
                  ? connection.release
                  : undefined;
              const target = await downloadRelease(
                (url, init) => net.fetch(url, init),
                version,
                directory,
                {
                  platform: process.platform,
                  arch: process.arch,
                  announced,
                  signal,
                  metadata: (value) => {
                    release = value;
                  },
                  progress: (received, size) => {
                    if (Date.now() - told < 500 && received < size) return;
                    told = Date.now();
                    if (!event.sender.isDestroyed())
                      event.sender.send('update:progress', { received, size });
                  },
                },
              );
              return { path: target, release };
            },
          };
    await installClientUpdate({
      app,
      autoUpdater,
      shell,
      connection: downloadConnection,
      platform: process.platform,
      unsigned: app.isPackaged && require('../package.json').macUnsigned,
      signal: controller.signal,
      assertCurrent,
      beforeInstall: async () => {
        assertCurrent();
        const previous = bridge;
        await previous?.close();
        assertCurrent();
        if (bridge === previous) bridge = null;
        keepAwake(false);
        prepared = true;
        quitting = true;
      },
    });
  } catch (error) {
    if (prepared && !exiting) {
      nativeInstalling = false;
      quitting = false;
      if (!event.sender.isDestroyed()) event.sender.send('proxy:closed');
      if (BrowserWindow.getAllWindows().length) showWindow();
      else {
        dialog.showErrorBox(
          '客户端更新没有完成',
          `${error.message}\n请重新启动客户端后检查版本，必要时使用正式安装包重新安装。`,
        );
        app.quit();
      }
    }
    throw error;
  } finally {
    if (updateAttempt === controller) updateAttempt = undefined;
  }
});
handle('proxy:disconnect', async () => {
  cancelUpdate();
  connecting?.abort(new Error('Connection cancelled'));
  keepAwake(false);
  connectionGeneration++;
  const previous = bridge;
  bridge = null;
  await previous?.close();
});

// Windows files notifications under this identity; the installer gives the shortcut the same one.
if (process.platform === 'win32')
  app.setAppUserModelId(app.isPackaged ? 'io.github.ccdesktunnel.desktop' : process.execPath);
app.whenReady().then(() => {
  log(`Client ${app.getVersion()} started.`);
  void clearPastedPictures();
  if (!ownsInstance) return;
  // Shortcuts are the page's, where the user can change them or turn them off; Electron's default menu would
  // add its own on top (zoom, reload, close). A run from source keeps reload and the developer tools.
  const action = (name) => () =>
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', name);
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([
          {
            label: 'CC Desk Tunnel',
            submenu: [
              { role: 'about' },
              { label: '设置…', click: action('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          {
            label: '文件',
            submenu: [
              { label: '新建会话', click: action('newSession') },
              { label: '添加项目…', click: action('addProject') },
              { type: 'separator' },
              { role: 'close' },
            ],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
              { type: 'separator' },
              { label: '查找对话内容', click: action('find') },
            ],
          },
          {
            label: '视图',
            submenu: [
              { label: '收起或展开侧栏', click: action('toggleSide') },
              { label: '放大界面', click: action('zoomIn') },
              { label: '缩小界面', click: action('zoomOut') },
              { label: '恢复界面大小', click: action('zoomReset') },
              { type: 'separator' },
              { role: 'togglefullscreen' },
            ],
          },
          { role: 'windowMenu', label: '窗口' },
          ...(!app.isPackaged
            ? [{ label: '开发', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] }]
            : []),
        ])
      : app.isPackaged
        ? null
        : Menu.buildFromTemplate([
            { label: '开发', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] },
          ]),
  );
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  const window = new BrowserWindow({
    width: 1240,
    height: 850,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#edf0f6',
    title: 'CC Desk Tunnel',
    // Match the page's --bar height so native controls and navigation icons share a vertical center.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#edf0f6', symbolColor: '#22262e', height: 40 },
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: !process.argv.includes('--smoke-test'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A hidden window keeps its connection timers at full rate.
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // Only a build run from the source tree offers the login page's simulation mode.
      additionalArguments: [
        `--cc-desk-tunnel-platform=${process.platform}`,
        ...(app.isPackaged ? [] : ['--cc-desk-tunnel-dev']),
      ],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Electron does not provide an editing menu by default. Native roles keep text selection, undo and paste
  // in the focused input, without exposing clipboard reads to the renderer.
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
      { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
      { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
      { role: 'selectAll', label: '全选' },
    ]).popup({ window });
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, '../dist/index.html'));

  // Long tasks keep running with the window closed: closing hides it, and the tray icon brings it back or quits.
  const closeToTray = () => readSettings().closeToTray !== false;
  const tray = new Tray(
    process.platform === 'darwin'
      ? require('./tray-icon.cjs').terminalTemplate(nativeImage)
      : nativeImage
          .createFromPath(path.join(__dirname, 'icon.png'))
          .resize({ width: 32, height: 32 }),
  );
  const buildMenu = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示窗口', click: showWindow },
        {
          label: '关闭窗口时留在后台',
          type: 'checkbox',
          checked: closeToTray(),
          click: (item) => {
            writeSettings({ closeToTray: item.checked });
            buildMenu();
          },
        },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    );
  tray.setToolTip('CC Desk Tunnel');
  tray.on('click', showWindow);
  buildMenu();
  refreshTray = buildMenu;
  window.on('close', (event) => {
    if (quitting || !closeToTray()) return;
    event.preventDefault();
    window.hide();
    if (!readSettings().trayHintShown) {
      writeSettings({ trayHintShown: true });
      if (process.platform === 'win32')
        tray.displayBalloon({
          title: 'CC Desk Tunnel 仍在后台运行',
          content: '点击托盘图标恢复窗口；右键图标选择“退出”才会结束连接。',
        });
    }
  });
  powerMonitor.on('resume', () => {
    cancelUpdate();
    connecting?.abort(new Error('Connection cancelled'));
    // A sleeping TCP connection cannot establish whether a command completed. End it without replay.
    const previous = bridge;
    bridge = null;
    keepAwake(false);
    connectionGeneration++;
    if (previous)
      void previous.close().finally(() => {
        if (!window.webContents.isDestroyed()) window.webContents.send('proxy:closed');
      });
  });
});
let quitting = false;
let nativeInstalling = false;
autoUpdater.on('before-quit-for-update', () => {
  nativeInstalling = true;
  quitting = true;
});
let exiting = false;
app.on('before-quit', (event) => {
  quitting = true;
  cancelUpdate();
  connecting?.abort(new Error('Connection cancelled'));
  if (exiting || !bridge) return;
  event.preventDefault();
  exiting = true;
  bridge.close().finally(() => app.quit());
});
app.on('window-all-closed', () => {
  if (!nativeInstalling) app.quit();
});
