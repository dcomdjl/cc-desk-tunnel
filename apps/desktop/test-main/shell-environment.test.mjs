import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSupervisor } from '../electron/process-supervisor.mjs';
import { captureShellEnvironment, resolvePosixShell } from '../electron/shell-environment.mjs';

const posix = { skip: process.platform === 'win32', timeout: 10000 };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-desk-shell-env-'));
  const supervisor = new ProcessSupervisor({ graceMs: 100 });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, supervisor, env: { ...process.env, HOME: directory, ZDOTDIR: directory } };
}

test(
  'login shell noise cannot corrupt the isolated environment JSON',
  { ...posix, skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.directory, '.zprofile'), 'export CC_DESK_LOGIN="登录值"\n');
    await writeFile(
      join(f.directory, '.zshrc'),
      'printf "{profile noise}\\n"; printf "stderr noise\\n" >&2; export CC_DESK_INTERACTIVE="交互值"; echo yes >> "$HOME/initialized"\n',
    );
    const env = await captureShellEnvironment('/bin/zsh', f.supervisor, {
      env: f.env,
      cwd: f.directory,
    });
    assert.equal(env.CC_DESK_LOGIN, '登录值');
    assert.equal(env.CC_DESK_INTERACTIVE, '交互值');
    assert.equal((await readFile(join(f.directory, 'initialized'), 'utf8')).trim(), 'yes');
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  },
);

test(
  'bash login and interactive initialization are captured from the helper descriptor',
  posix,
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.directory, '.bash_profile'),
      'export CC_DESK_BASH="captured"; printf "profile noise\\n"\n',
    );
    const env = await captureShellEnvironment('/bin/bash', f.supervisor, {
      env: f.env,
      cwd: f.directory,
    });
    assert.equal(env.CC_DESK_BASH, 'captured');
  },
);

test(
  'shell initialization has bounded timeout, output and cancellation',
  { ...posix, skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.directory, '.zshrc'), '/bin/sleep 120\n');
    await assert.rejects(
      captureShellEnvironment('/bin/zsh', f.supervisor, { env: f.env, timeoutMs: 50 }),
      /超时/,
    );
    const controller = new AbortController();
    const capturing = captureShellEnvironment('/bin/zsh', f.supervisor, {
      env: f.env,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(capturing, /cancelled/);
    await writeFile(join(f.directory, '.zshrc'), 'printf "%01000d" 1\n');
    await assert.rejects(
      captureShellEnvironment('/bin/zsh', f.supervisor, { env: f.env, maxBytes: 128 }),
      /超过大小限制/,
    );
  },
);

test('shell selection rejects relative paths and unsupported shell kinds', posix, async () => {
  await assert.rejects(resolvePosixShell({ shellPath: 'zsh' }), /绝对路径/);
  await assert.rejects(resolvePosixShell({ shellPath: '/bin/sh' }), /zsh 或 bash/);
  await assert.rejects(resolvePosixShell({ shellPath: '/bin/zsh\n' }), /绝对路径/);
});
