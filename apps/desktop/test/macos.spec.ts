import { test, expect, _electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { login } from './helpers.ts';

test('macOS Electron uses Command, native menus, isolated IPC and Dock restoration', async () => {
  test.skip(process.platform !== 'darwin', 'macOS desktop integration');
  test.setTimeout(60000);
  const root = resolve('.local/ui-test');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'macos-'));
  const profile = join(directory, 'profile');
  const workspace = join(directory, 'workspace');
  mkdirSync(profile);
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ workspaceRoots: [workspace] }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
    ),
  ) as Record<string, string>;
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.desktop!.platform)).toBe('darwin');
    const identity = await page.evaluate(() => window.desktop!.deviceInfo());
    expect(identity.platform).toBe('darwin');
    expect(identity.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    const preferences = await application.evaluate(({ BrowserWindow }) =>
      (
        BrowserWindow.getAllWindows()[0].webContents as unknown as {
          getLastWebPreferences: () => {
            nodeIntegration: boolean;
            contextIsolation: boolean;
            sandbox: boolean;
          };
        }
      ).getLastWebPreferences(),
    );
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.sandbox).toBe(true);
    const offline = await page.evaluate(() =>
      window.desktop!.checkProject('/tmp/permission-check', { targetPath: 'file.txt' }),
    );
    expect(offline.ok).toBe(false);
    if (!offline.ok) {
      expect(offline.code).toBe('offline');
      expect(offline.stage).toBe('connect');
    }
    await application.evaluate(({ shell }) => {
      const state = { urls: [] as string[], original: shell.openExternal };
      (globalThis as unknown as { privacyTest: typeof state }).privacyTest = state;
      shell.openExternal = async (url) => {
        state.urls.push(url);
      };
    });
    try {
      await page.evaluate(() => window.desktop!.openPrivacySettings!());
      const urls = await application.evaluate(
        () => (globalThis as unknown as { privacyTest: { urls: string[] } }).privacyTest.urls,
      );
      expect(urls).toEqual([
        'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
      ]);
      await expect(
        page.evaluate(() =>
          window.desktop!.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
          ),
        ),
      ).rejects.toThrow('Unexpected link');
    } finally {
      await application.evaluate(({ shell }) => {
        const state = (
          globalThis as unknown as { privacyTest: { original: typeof shell.openExternal } }
        ).privacyTest;
        shell.openExternal = state.original;
      });
    }
    await login(page);
    const count = await page.locator('.session-row').count();
    await page.keyboard.press('Meta+n');
    await expect(page.locator('.session-row')).toHaveCount(count + 1);
    await expect(page.locator('.titlebar')).toHaveCSS('padding-left', '86px');
    // The native overlay and the rendered toolbar must use the same height and center.
    const titlebar = await page.locator('.titlebar').evaluate((bar) => {
      const overlay = (
        navigator as Navigator & {
          windowControlsOverlay: { getTitlebarAreaRect: () => DOMRect };
        }
      ).windowControlsOverlay.getTitlebarAreaRect();
      const bounds = bar.getBoundingClientRect();
      return {
        height: bounds.height,
        center: bounds.y + bounds.height / 2,
        overlayHeight: overlay.height,
        overlayCenter: overlay.y + overlay.height / 2,
        overlayLeft: overlay.x,
        buttons: [...bar.querySelectorAll('.icon-button')].map((button) => {
          const box = button.getBoundingClientRect();
          const icon = button.querySelector('svg')!.getBoundingClientRect();
          return {
            left: box.left,
            width: box.width,
            height: box.height,
            center: box.y + box.height / 2,
            iconCenter: icon.y + icon.height / 2,
          };
        }),
      };
    });
    expect(titlebar.height).toBe(40);
    expect(titlebar.overlayHeight).toBe(titlebar.height);
    expect(titlebar.overlayCenter).toBe(titlebar.center);
    for (const button of titlebar.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(titlebar.overlayLeft);
      expect(button.width).toBe(30);
      expect(button.height).toBe(button.width);
      expect(button.center).toBe(titlebar.center);
      expect(button.iconCenter).toBe(titlebar.center);
    }
    await application.evaluate(({ Menu }) => {
      const edit = Menu.getApplicationMenu()!.items.find((item) => item.label === '编辑')!;
      const find = edit.submenu!.items.find((item) => item.label === '查找对话内容')!;
      find.click();
    });
    await expect(page.getByRole('textbox', { name: '查找对话内容', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    ).toBe(false);
    await application.evaluate(({ app }) => {
      app.emit('activate');
    });
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    ).toBe(true);
    const paths = await page.evaluate(
      (directory) => window.desktop!.projectIdentities([directory]),
      directory,
    );
    expect(paths[0].key).toMatch(/^fs:/);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});
