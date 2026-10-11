import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { Task } from '../src/schedules.ts';

type Calls = {
  branches: string[];
  removed: string[];
  identities: string[][];
  notifications: { title: string; body: string }[];
  releaseDevice: () => void;
};
type TestWindow = Window & { isolationCalls: Calls };

async function fixture(
  page: Page,
  options: {
    schedules?: boolean;
    delayedDevice?: boolean;
    sharedIdDifferentPlatform?: boolean;
  } = {},
) {
  const device = { deviceId: randomUUID(), platform: 'darwin' as const, arch: 'arm64' as const };
  const root = '/Users/test/Documents/CC Desk Tunnel';
  const projectPath = `${root}/2026-10-11/120000`;
  const now = new Date().toISOString();
  const local: Session = {
    id: randomUUID(),
    title: '本机普通会话',
    autoTitle: false,
    projectPath,
    device: { id: device.deviceId, name: '本机' },
    platform: 'darwin',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  // The same path on two computers must not make their filesystem operations interchangeable.
  const foreign: Session = {
    ...local,
    id: randomUUID(),
    title: '其他 Mac 历史',
    device: {
      id: options.sharedIdDifferentPlatform ? device.deviceId : randomUUID(),
      name: '其他设备',
    },
    platform: options.sharedIdDifferentPlatform ? 'linux' : 'darwin',
  };
  const tasks: Task[] = options.schedules
    ? [
        {
          id: 'foreign-scheduled-task',
          name: '远端旧任务',
          enabled: false,
          prompt: '查看项目',
          schedule: { type: 'interval', minutes: 60 },
          target: { type: 'session', sessionId: foreign.id },
          model: 'different-model',
          effort: 'max',
        },
      ]
    : [];
  const url = 'ws://127.0.0.1:18891/device-isolation';
  const commands: { type: string; sessionId?: string }[] = [];
  const sessions = [foreign, local];
  await page.routeWebSocket(url, (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'device') return;
      commands.push(command);
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions,
        });
        return;
      }
      if (command.type === 'session.subscribe') {
        const session = sessions.find((item) => item.id === command.sessionId)!;
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session,
          mode: 'replace',
          firstSequence: 0,
          lastSequence: 0,
          hasEarlier: false,
          events: [],
        });
      }
      if (command.type === 'account.status')
        send({ type: 'account.state', loggedIn: true, login: null });
      if (command.type === 'session.move') {
        const session = sessions.find((item) => item.id === command.sessionId)!;
        Object.assign(session, {
          device: local.device,
          platform: 'darwin',
          projectPath: command.projectPath,
        });
        send({ type: 'session.updated', session });
      }
      if (command.type === 'session.delete') {
        sessions.splice(
          sessions.findIndex((item) => item.id === command.sessionId),
          1,
        );
        send({ type: 'session.deleted', sessionId: command.sessionId });
      }
      send({
        type: 'response',
        requestId: command.requestId,
        ok: true,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      });
    });
  });
  await page.addInitScript(
    ({ device, root, projectPath, url, foreignId, tasks, delayedDevice }) => {
      const calls: Calls = {
        branches: [],
        removed: [],
        identities: [],
        notifications: [],
        releaseDevice: () => {},
      };
      (window as unknown as TestWindow).isolationCalls = calls;
      const identity = (path: string) => ({ path, canonical: path, key: `fs:test:${path}` });
      const unsubscribe = () => () => {};
      window.desktop = {
        dev: false,
        platform: 'darwin',
        deviceInfo: () =>
          delayedDevice
            ? new Promise((resolve) => {
                calls.releaseDevice = () => resolve(device);
              })
            : Promise.resolve(device),
        projectIdentities: async (paths) => {
          calls.identities.push(paths);
          return paths.map(identity);
        },
        checkProject: async (path) => ({ ok: true, path, identity: identity(path) }),
        gitBranch: async (path) => {
          calls.branches.push(path);
          return 'local-main';
        },
        workspaceRoots: async () => [root],
        removeWorkspace: async (path) => {
          calls.removed.push(path);
        },
        loadLogin: async () => ({
          url: 'wss://fixture.invalid/ws',
          token: 'device-isolation-test-token-long-enough',
          fingerprint: '',
          mode: 'remote',
          remember: false,
          autoLogin: true,
        }),
        connectProxy: async () => ({ url }),
        disconnectProxy: async () => {},
        loadDrafts: async () => ({ [foreignId]: '这条草稿不能发给本机执行' }),
        saveDrafts: async () => {},
        loadSchedules: async () => ({
          path: '/Users/test/Library/Application Support/CC Desk Tunnel/schedules.json',
          text: JSON.stringify({ tasks }),
        }),
        saveSchedules: async () => {},
        onSchedulesChanged: unsubscribe,
        notify: async (notice) => {
          calls.notifications.push(notice);
        },
        onNotifyClicked: unsubscribe,
        onProxyClosed: unsubscribe,
        onMenuAction: unsubscribe,
        windowSettings: async () => ({ closeToTray: true }),
        setWindowSettings: async () => {},
        version: async () => '0.0.1',
        saveLogin: async () => {},
        device: async () => ({ id: device.deviceId, name: '设备' }),
        openLogs: async () => {},
        saveImage: async () => '',
        onUpdateProgress: unsubscribe,
        chooseProject: async () => projectPath,
        chooseFiles: async () => [],
        pathForFile: () => '',
        saveFile: async () => false,
        openFolder: async () => {},
        copyText: async () => {},
        openExternal: async () => {},
        chooseWorkspace: async () => [root],
        createWorkspace: async () => `${root}/unused`,
        zoom: () => {},
        quit: async () => {},
        installUpdate: async () => {},
      };
    },
    {
      device,
      root,
      projectPath,
      url,
      foreignId: foreign.id,
      tasks,
      delayedDevice: options.delayedDevice ?? false,
    },
  );
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ elsewhereOpen: true })),
  );
  await page.goto('/');
  if (!options.delayedDevice)
    await expect(page.locator('.connection-status')).toContainText('已连接');
  return { foreign, local, projectPath, commands };
}

test('foreign history cannot read a local branch, execute, open a terminal or remove a same-name workspace', async ({
  page,
}) => {
  const { foreign, local, projectPath, commands } = await fixture(page);
  const row = page.locator('.session-row').filter({ hasText: foreign.title });
  await row.locator('.session-select').click();
  await expect(
    page.getByRole('status').filter({ hasText: '此会话属于另一台执行设备' }),
  ).toBeVisible();
  const message = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(message).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).isolationCalls.branches),
  ).toEqual([]);
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '原生终端', exact: true })).toBeDisabled();
  expect(
    commands.filter((command) => ['message.send', 'terminal.open'].includes(command.type)),
  ).toEqual([]);
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: '删除会话', exact: true }) })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  await expect(row).toHaveCount(0);
  expect(
    commands.some(
      (command) => command.type === 'session.delete' && command.sessionId === foreign.id,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).isolationCalls.removed),
  ).toEqual([]);
  await page
    .locator('.session-row')
    .filter({ hasText: local.title })
    .locator('.session-select')
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (path) => (window as unknown as TestWindow).isolationCalls.branches.includes(path),
        projectPath,
      ),
    )
    .toBe(true);
});

test('explicit takeover restores the preserved draft without automatically sending it', async ({
  page,
}) => {
  const { foreign, commands } = await fixture(page);
  await page
    .locator('.session-row')
    .filter({ hasText: foreign.title })
    .locator('.session-select')
    .click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '在本机继续…', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '这条草稿不能发给本机执行',
  );
  expect(commands.filter((command) => command.type === 'message.send')).toEqual([]);
});

test('sharing a device ID across platforms cannot expose another platform as local', async ({
  page,
}) => {
  const { foreign } = await fixture(page, { sharedIdDifferentPlatform: true });
  await page
    .locator('.session-row')
    .filter({ hasText: foreign.title })
    .locator('.session-select')
    .click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveCount(0);
  const row = page.locator('.session-row').filter({ hasText: foreign.title });
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '移到其他项目…', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).isolationCalls.branches),
  ).toEqual([]);
});

test('foreign scheduled targets cannot configure or send and new tasks only offer local sessions', async ({
  page,
}) => {
  const { foreign, local, commands } = await fixture(page, { schedules: true });
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  const task = page.locator('.schedule-row').filter({ hasText: '远端旧任务' });
  await task.getByRole('button', { name: '立即运行 远端旧任务', exact: true }).click();
  await expect(task).toContainText('目标会话属于另一台设备');
  expect(
    commands.filter(
      (command) =>
        ['session.configure', 'message.send'].includes(command.type) &&
        command.sessionId === foreign.id,
    ),
  ).toEqual([]);
  await page
    .getByRole('complementary')
    .getByRole('button', { name: '新建任务', exact: true })
    .click();
  const choices = page.getByRole('combobox', { name: '目标会话', exact: true });
  await expect(choices).toHaveValue(local.id);
  await expect(choices.locator('option')).toHaveCount(1);
  await expect(choices.locator('option')).toContainText(local.title);
  await expect(choices.locator(`option[value="${foreign.id}"]`)).toHaveCount(0);
});

test('device identity must resolve before a native session can invoke local path operations', async ({
  page,
}) => {
  const { local, projectPath } = await fixture(page, { delayedDevice: true });
  await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).isolationCalls.branches),
  ).toEqual([]);
  expect(
    await page.evaluate(
      (path) => (window as unknown as TestWindow).isolationCalls.identities.flat().includes(path),
      projectPath,
    ),
  ).toBe(false);
  await page.evaluate(() => (window as unknown as TestWindow).isolationCalls.releaseDevice());
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await page
    .locator('.session-row')
    .filter({ hasText: local.title })
    .locator('.session-select')
    .click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        (path) => (window as unknown as TestWindow).isolationCalls.branches.includes(path),
        projectPath,
      ),
    )
    .toBe(true);
});
