import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClientReleases, clientAsset } from '../src/client-release.ts';

test('only the newest three installers are kept; other files are left alone', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const version of ['0.2.0', '0.9.9', '0.10.0', '0.2.10', '1.0.0'])
    writeFileSync(join(directory, `CC-Desk-Tunnel-Setup-${version}-x64.exe`), version);
  writeFileSync(join(directory, 'notes.txt'), 'kept');
  const releases = new ClientReleases(directory);
  await releases.refresh();
  assert.equal(releases.current?.version, '1.0.0');
  assert.deepEqual(readdirSync(directory).sort(), [
    'CC-Desk-Tunnel-Setup-0.10.0-x64.exe',
    'CC-Desk-Tunnel-Setup-0.9.9-x64.exe',
    'CC-Desk-Tunnel-Setup-1.0.0-x64.exe',
    'notes.txt',
  ]);
});

test('platform and architecture select independent histories, with ZIP preferred for the same macOS version', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
    writeFileSync(join(directory, `CC-Desk-Tunnel-Setup-${version}-x64.exe`), version);
    for (const arch of ['arm64', 'x64'])
      for (const format of ['zip', 'dmg'])
        writeFileSync(
          join(directory, `CC-Desk-Tunnel-${version}-darwin-${arch}.${format}`),
          `${arch}-${format}`,
        );
  }
  writeFileSync(join(directory, 'CC-Desk-Tunnel-1.0.4-darwin-arm64.dmg'), 'new manual installer');
  const releases = new ClientReleases(directory);
  await releases.refresh();
  assert.equal(releases.select('darwin', 'arm64')?.version, '1.0.4');
  assert.equal(releases.select('darwin', 'arm64')?.format, 'dmg');
  assert.equal(releases.select('darwin', 'x64')?.format, 'zip');
  assert.equal(releases.current?.platform, 'win32');
  assert.equal(releases.select('win32', 'arm64'), null);
  assert.equal(releases.select('linux', 'x64'), null);
  assert.equal(readdirSync(directory).filter((name) => name.endsWith('.exe')).length, 3);
  assert.equal(
    readdirSync(directory).filter((name) => name.includes('darwin-arm64') && name.endsWith('.zip'))
      .length,
    3,
  );
  assert.equal(
    readdirSync(directory).filter((name) => name.includes('darwin-x64') && name.endsWith('.dmg'))
      .length,
    3,
  );
  const prior = releases.select('darwin', 'x64');
  await releases.refresh();
  assert.equal(releases.select('darwin', 'x64'), prior);
  rmSync(prior!.path);
  await releases.refresh();
  assert.equal(releases.select('darwin', 'x64')?.format, 'dmg');
});

test('asset parser refuses traversal, unsupported formats and ambiguous architectures', () => {
  assert.equal(clientAsset('../CC-Desk-Tunnel-1.0.0-darwin-arm64.zip'), undefined);
  assert.equal(clientAsset('CC-Desk-Tunnel-1.0.0-darwin-universal.zip'), undefined);
  assert.equal(clientAsset('CC-Desk-Tunnel-1.0.0-linux-arm64.dmg'), undefined);
  assert.equal(clientAsset('CC-Desk-Tunnel-1.0.0-darwin-arm64.AppImage'), undefined);
  assert.deepEqual(clientAsset('CC-Desk-Tunnel-1.0.0-linux-x64.AppImage'), {
    version: '1.0.0',
    platform: 'linux',
    arch: 'x64',
    format: 'AppImage',
  });
});

test('invalid directory, symlink and empty assets neither hide nor evict valid releases', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = (version: string) => join(directory, `CC-Desk-Tunnel-${version}-darwin-arm64.zip`);
  for (const version of ['1.0.0', '1.0.1', '1.0.2']) writeFileSync(name(version), version);
  mkdirSync(name('0.9.0'));
  mkdirSync(name('1.0.3'));
  writeFileSync(name('1.0.4'), '');
  if (process.platform !== 'win32') symlinkSync(name('1.0.2'), name('1.0.5'));
  const releases = new ClientReleases(directory);
  await releases.refresh();
  assert.equal(releases.select('darwin', 'arm64')?.version, '1.0.2');
  assert.ok(readdirSync(directory).includes('CC-Desk-Tunnel-1.0.0-darwin-arm64.zip'));
});

test('atomic replacement with the same size and mtime invalidates the cached installer hash', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'CC-Desk-Tunnel-1.0.0-darwin-arm64.zip');
  writeFileSync(path, 'same-size-old');
  utimesSync(path, 1000, 1000);
  const releases = new ClientReleases(directory);
  await releases.refresh();
  const prior = releases.select('darwin', 'arm64');
  writeFileSync(`${path}.part`, 'same-size-new');
  utimesSync(`${path}.part`, 1000, 1000);
  renameSync(`${path}.part`, path);
  await releases.refresh();
  assert.notEqual(releases.select('darwin', 'arm64'), prior);
  assert.equal(
    releases.select('darwin', 'arm64')?.sha256,
    createHash('sha256').update('same-size-new').digest('hex'),
  );
});
