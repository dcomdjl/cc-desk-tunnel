import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectIdentity, removeEmptyWorkspace } from '../electron/project-paths.cjs';
import {
  lexicalPathKey,
  pathKey,
  folderName,
  isInside,
  registerPathIdentities,
  withProject,
} from '../src/paths.ts';
import { comboOf, keyFor, show, usable } from '../src/shortcuts.ts';

test('path syntax preserves POSIX case, Unicode and literal backslashes while reading old Windows keys', () => {
  assert.equal(lexicalPathKey('D:/项目/Repo/'), 'd:\\项目\\repo');
  assert.notEqual(pathKey('/work/Repo'), pathKey('/work/repo'));
  assert.notEqual(pathKey('/项目/é'), pathKey('/项目/e\u0301'));
  assert.equal(folderName('/work/back\\slash'), 'back\\slash');
  assert.equal(isInside('/work2/repo', ['/work']), false);
  assert.equal(isInside('/work/repo', ['/work']), true);
  assert.equal(isInside('/repo', ['/']), true);
  assert.equal(isInside('D:\\Work\\repo', ['d:/work/']), true);
});

test('actual filesystem identities merge symlinks and case aliases without merging distinct directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, '项目 Repo');
  const alias = join(root, 'alias');
  await mkdir(source);
  await symlink(source, alias, 'dir');
  const first = await projectIdentity(source);
  const second = await projectIdentity(alias);
  assert.equal(first.key, second.key);
  registerPathIdentities([first, second]);
  assert.deepEqual(withProject([source], alias), [source]);
  const other = join(root, '项目 repo');
  await mkdir(other).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const third = await projectIdentity(other);
  registerPathIdentities([third]);
  assert.equal(pathKey(source) === pathKey(other), first.key === third.key);
  await assert.rejects(projectIdentity('relative'), /绝对目录/);
});

test('managed workspace cleanup preserves content and refuses symlink escapes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccdt-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managed = join(root, 'managed');
  const outside = join(root, 'outside');
  await mkdir(managed);
  await mkdir(outside);
  await mkdir(join(outside, '120000'));
  await symlink(outside, join(managed, '2026-10-11'), 'dir');
  await removeEmptyWorkspace(join(managed, '2026-10-11/120000'), [managed]);
  assert.equal((await stat(join(outside, '120000'))).isDirectory(), true);
  const day = join(managed, '2026-10-12');
  const workspace = join(day, '120000');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'keep.txt'), 'user content');
  await removeEmptyWorkspace(workspace, [managed]);
  assert.equal((await stat(workspace)).isDirectory(), true);
  const empty = join(day, '120001');
  await mkdir(empty);
  await removeEmptyWorkspace(empty, [managed]);
  await assert.rejects(stat(empty), { code: 'ENOENT' });
});

test('macOS defaults use Meta while preserving custom Ctrl keys and migrating legacy Win keys', (t) => {
  const previous = globalThis.window;
  globalThis.window = { desktop: { platform: 'darwin' } };
  t.after(() => {
    globalThis.window = previous;
  });
  const prefs = { shortcuts: { keys: {} } };
  assert.equal(keyFor(prefs, 'find'), 'Meta+KeyF');
  assert.equal(keyFor({ shortcuts: { keys: { find: 'Ctrl+KeyG' } } }, 'find'), 'Ctrl+KeyG');
  assert.equal(keyFor({ shortcuts: { keys: { find: 'Win+KeyF' } } }, 'find'), 'Meta+KeyF');
  assert.equal(comboOf({ code: 'KeyF', metaKey: true }), 'Meta+KeyF');
  assert.equal(show('Meta+KeyF'), '⌘+F');
  assert.equal(usable('Meta+KeyF'), true);
});
