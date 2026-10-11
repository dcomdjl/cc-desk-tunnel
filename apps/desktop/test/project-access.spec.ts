import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { EventPayload, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ProjectAccess } from '../src/platform.ts';
import { expandActivity } from './helpers.ts';

type Calls = {
  checks: { path: string; options?: { targetPath?: string; targetOperation?: string } }[];
  result: ProjectAccess;
  settings: number;
  settingsFail: boolean;
  hold: boolean;
  checkFail: boolean;
  release: () => void;
};
type TestWindow = Window & { accessCalls: Calls };

async function fixture(
  page: Page,
  options: { foreign?: boolean; code?: string; stage?: string; path?: string; tool?: string } = {},
) {
  const path = options.path ?? '/Users/test/Documents/project';
  const targetPath = `${path}/existing.txt`;
  const device = { deviceId: randomUUID(), platform: 'darwin' as const, arch: 'arm64' as const };
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '权限恢复测试',
    autoTitle: false,
    projectPath: path,
    platform: 'darwin',
    device: { id: options.foreign ? randomUUID() : device.deviceId, name: '设备' },
    permissionMode: 'auto',
    model: null,
    effort: null,
    activeRun: null,
    createdAt: now,
    updatedAt: now,
  };
  const other: Session = {
    ...session,
    id: randomUUID(),
    title: '其他本机会话',
    device: { id: device.deviceId, name: '本机' },
  };
  const runId = randomUUID();
  const connectionId = randomUUID();
  const code = options.code ?? 'permission_denied';
  const payloads: EventPayload[] = [
    { type: 'message.user', messageId: randomUUID(), text: '修改文件', scenario: 'tool' },
    {
      type: 'tool.requested',
      toolId: 'edit-file',
      name: options.tool ?? 'Edit',
      input: JSON.stringify({ file_path: targetPath }),
      target: 'Linux',
    },
    {
      type: 'tool.result',
      toolId: 'edit-file',
      status: 'failed',
      output: code === 'read_only' ? 'EROFS: read-only file system' : 'EACCES: permission denied',
      exitCode: null,
    },
    { type: 'text.delta', messageId: randomUUID(), text: '修改失败，请检查文件访问。' },
    { type: 'run.status', status: 'completed', connectionId },
  ];
  const events: SessionEvent[] = payloads.map((payload, index) => ({
    sessionId: session.id,
    runId,
    sequence: index + 1,
    createdAt: now,
    payload,
  }));
  const commands: { type: string; sessionId?: string }[] = [];
  const url = 'ws://127.0.0.1:18891/project-access';
  await page.routeWebSocket(url, (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(serverMessageSchema.parse(value)));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'device') return;
      commands.push(command);
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session, other],
        });
        return;
      }
      if (command.type === 'session.subscribe') {
        const current = command.sessionId === session.id ? session : other;
        const history = current.id === session.id ? events : [];
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session: current,
          mode: 'replace',
          firstSequence: history.length ? 1 : 0,
          lastSequence: history.length,
          hasEarlier: false,
          events: history,
        });
      }
      if (command.type === 'account.status')
        send({ type: 'account.state', loggedIn: true, login: null });
      send({
        type: 'response',
        requestId: command.requestId,
        ok: true,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      });
    });
  });
  await page.addInitScript(
    ({ device, path, targetPath, code, stage, url }) => {
      const identity = (value: string) => ({
        path: value,
        canonical: value,
        key: `fs:test:${value}`,
      });
      const calls: Calls = {
        checks: [],
        settings: 0,
        settingsFail: false,
        hold: false,
        checkFail: false,
        release: () => {},
        result: {
          ok: false,
          code,
          stage,
          message: code === 'read_only' ? '文件系统为只读。' : '访问被拒绝。',
          systemCode: code === 'read_only' ? 'EROFS' : 'EACCES',
          source: 'filesystem',
          path: targetPath,
          projectOk: stage === 'target',
        },
      };
      (window as unknown as TestWindow).accessCalls = calls;
      const unsubscribe = () => () => {};
      window.desktop = {
        dev: false,
        platform: 'darwin',
        deviceInfo: async () => device,
        projectIdentities: async (paths) => paths.map(identity),
        checkProject: async (checkedPath, options) => {
          calls.checks.push({ path: checkedPath, options });
          if (calls.checkFail) throw new Error('IPC channel unavailable');
          if (calls.hold)
            await new Promise<void>((resolve) => {
              calls.release = resolve;
            });
          return calls.result;
        },
        openPrivacySettings: async () => {
          calls.settings++;
          if (calls.settingsFail) throw new Error('Settings unavailable');
        },
        gitBranch: async () => null,
        workspaceRoots: async () => ['/tmp/access-workspace'],
        loadLogin: async () => ({
          url: 'wss://fixture.invalid/ws',
          token: 'permission-fixture-token-long-enough',
          fingerprint: '',
          mode: 'remote',
          remember: false,
          autoLogin: true,
        }),
        connectProxy: async () => ({ url }),
        disconnectProxy: async () => {},
        loadDrafts: async () => ({}),
        saveDrafts: async () => {},
        loadSchedules: async () => ({ path: '/tmp/access-schedules.json', text: '{"tasks":[]}' }),
        saveSchedules: async () => {},
        onSchedulesChanged: unsubscribe,
        onNotifyClicked: unsubscribe,
        onProxyClosed: unsubscribe,
        onMenuAction: unsubscribe,
        notify: async () => {},
        windowSettings: async () => ({ closeToTray: true }),
        setWindowSettings: async () => {},
        version: async () => '0.0.1',
        saveLogin: async () => {},
        device: async () => ({ id: device.deviceId, name: '设备' }),
        openLogs: async () => {},
        saveImage: async () => '',
        onUpdateProgress: unsubscribe,
        chooseProject: async () => path,
        chooseFiles: async () => [],
        copyText: async () => {},
        openExternal: async () => {},
        removeWorkspace: async () => {},
        pathForFile: () => '',
        saveFile: async () => false,
        openFolder: async () => {},
        chooseWorkspace: async () => [],
        createWorkspace: async () => '/tmp/access-workspace/new',
        zoom: () => {},
        quit: async () => {},
        installUpdate: async () => {},
      } as NonNullable<Window['desktop']>;
      localStorage.setItem('proxy-projects', JSON.stringify([path]));
      localStorage.setItem('proxy-prefs', JSON.stringify({ elsewhereOpen: true }));
    },
    { device, path, targetPath, code, stage: options.stage ?? 'target', url },
  );
  await page.goto('/');
  await expect(page.locator('.connection-status')).toContainText('已连接');
  const side = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await side.isVisible()) await side.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.transcript')).toContainText('修改失败');
  await expandActivity(page);
  return { path, targetPath, session, other, commands };
}

test('failed writes diagnose their target, open conditional authorization guidance, and never replay after recovery', async ({
  page,
}) => {
  const { path, targetPath, commands } = await fixture(page);
  await page.locator('.tool').getByRole('button', { name: '检测项目访问', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('项目基础通道可用，但目标文件或其父目录仍不可访问');
  await expect(dialog).toContainText('EACCES');
  await expect(dialog).toContainText(targetPath);
  await expect(dialog).toContainText('无法确认是否缺少授权');
  expect(await page.evaluate(() => (window as unknown as TestWindow).accessCalls.checks)).toEqual([
    { path, options: { targetPath, targetOperation: 'write' } },
  ]);
  await page.evaluate(() => {
    (window as unknown as TestWindow).accessCalls.settingsFail = true;
  });
  await dialog.getByRole('button', { name: '打开文件与文件夹设置' }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: '无法打开系统设置' })).toBeVisible();
  await page.evaluate((path) => {
    const calls = (window as unknown as TestWindow).accessCalls;
    calls.hold = true;
    calls.result = {
      ok: true,
      path,
      identity: { path, canonical: path, key: 'fs:test:project' },
      targetPath: `${path}/existing.txt`,
    };
  }, path);
  await dialog.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '检测中…' })).toBeDisabled();
  await expect(
    dialog.locator('.dialog-actions').getByRole('button', { name: '关闭', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as unknown as TestWindow).accessCalls.release());
  await expect(dialog).toContainText('项目基础读取、创建、写入和文件传输检测通过');
  await expect(dialog).toContainText('检测不会重放文件修改');
  await expect(dialog).toContainText('无法保证实际修改成功');
  expect(
    commands.filter((command) =>
      ['message.send', 'approval.reply', 'session.create', 'session.move'].includes(command.type),
    ),
  ).toEqual([]);
  await dialog
    .locator('.dialog-actions')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
});

test('read-only disks get disk recovery guidance without a macOS authorization button', async ({
  page,
}) => {
  await fixture(page, { code: 'read_only', path: '/Volumes/disk/project' });
  await page.locator('.tool').getByRole('button', { name: '检测项目访问' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('只读方式挂载');
  await expect(dialog.getByRole('button', { name: '打开文件与文件夹设置' })).toHaveCount(0);
  await expect(dialog).not.toContainText('完整磁盘访问');
});

test('command failures without a structured target explain the limits of a successful root check', async ({
  page,
}) => {
  const { path, commands } = await fixture(page, { tool: 'Bash', path: '/Users/test/Dev/project' });
  await page.evaluate((path) => {
    (window as unknown as TestWindow).accessCalls.result = {
      ok: true,
      path,
      identity: { path, canonical: path, key: 'fs:test:project' },
    };
  }, path);
  await page.locator('.tool').getByRole('button', { name: '检测项目访问' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('项目基础读取、创建、写入和文件传输检测通过');
  await expect(dialog).toContainText('未能确定出错文件，当前仅检查项目根目录');
  await expect(dialog.getByRole('button', { name: '打开文件与文件夹设置' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as TestWindow).accessCalls.checks)).toEqual([
    { path, options: { targetOperation: 'write' } },
  ]);
  expect(commands.some((command) => command.type === 'message.send')).toBe(false);
});

test('IPC failures are connection diagnostics and never request filesystem authorization', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as unknown as TestWindow).accessCalls.checkFail = true;
  });
  await page.locator('.tool').getByRole('button', { name: '检测项目访问' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('检测阶段：连接');
  await expect(dialog).toContainText('恢复连接后重新检测');
  await expect(dialog.getByRole('button', { name: '打开文件与文件夹设置' })).toHaveCount(0);
});

test('project setup uses the same write/cleanup authorization guidance', async ({ page }) => {
  await fixture(page, { stage: 'cleanup' });
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('检测阶段：清理');
  await expect(dialog.getByRole('button', { name: '打开文件与文件夹设置' })).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('switching sessions discards a late diagnostic result', async ({ page }) => {
  const { other } = await fixture(page);
  await page.evaluate(() => {
    (window as unknown as TestWindow).accessCalls.hold = true;
  });
  await page.locator('.tool').getByRole('button', { name: '检测项目访问' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).accessCalls.checks.length))
    .toBe(1);
  await page
    .locator('.session-row')
    .filter({ hasText: other.title })
    .locator('.session-select')
    .click();
  await page.evaluate(() => (window as unknown as TestWindow).accessCalls.release());
  await expect(page.locator('.session-row.selected')).toContainText(other.title);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('foreign-device failures cannot diagnose local paths', async ({ page }) => {
  await fixture(page, { foreign: true });
  await expect(page.locator('.tool').getByRole('button', { name: '检测项目访问' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as TestWindow).accessCalls.checks)).toEqual(
    [],
  );
});

test('narrow screens keep diagnostic actions reachable by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const check = page.locator('.tool').getByRole('button', { name: '检测项目访问' });
  await check.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog
    .locator('.dialog-actions')
    .getByRole('button', { name: '关闭', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(check).toBeFocused();
});
