import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertStableClientAssets,
  collectClientAssets,
  fileDigest,
  stageClientAssets,
} from '../../../scripts/release-assets.mjs';

const commit = 'a'.repeat(40);

test('release assembly accepts verified Windows and per-architecture Mac assets', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-release-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const version = '1.2.3';
  writeFileSync(join(directory, `CC-Desk-Tunnel-Setup-${version}-x64.exe`), 'windows');
  writeFileSync(
    join(directory, 'windows-x64.json'),
    JSON.stringify({
      version,
      platform: 'win32',
      arch: 'x64',
      smokeTested: true,
      sourceCommit: commit,
      sourceClean: true,
      files: [
        {
          name: `CC-Desk-Tunnel-Setup-${version}-x64.exe`,
          ...(await fileDigest(join(directory, `CC-Desk-Tunnel-Setup-${version}-x64.exe`))),
        },
      ],
    }),
  );
  const windows = await collectClientAssets([directory], version, commit);
  assert.equal(windows[0].platform, 'win32');
  const files = [];
  for (const format of ['zip', 'dmg']) {
    const name = `CC-Desk-Tunnel-${version}-darwin-arm64.${format}`;
    writeFileSync(join(directory, name), format);
    files.push({ name, ...(await fileDigest(join(directory, name))) });
  }
  const receipt = {
    version,
    platform: 'darwin',
    arch: 'arm64',
    signed: true,
    notarized: true,
    smokeTested: true,
    sourceCommit: commit,
    sourceClean: true,
    files,
  };
  const save = () => writeFileSync(join(directory, 'macos-arm64.json'), JSON.stringify(receipt));
  save();
  const assets = await collectClientAssets([directory], version, commit);
  assert.equal(assets.length, 3);
  assert.equal(assets.find((asset) => asset.format === 'zip').arch, 'arm64');
  receipt.signed = false;
  save();
  await assert.rejects(collectClientAssets([directory], version, commit), /仅供内测/);
  receipt.signed = true;
  save();
  writeFileSync(join(directory, files[0].name), 'changed zip');
  await assert.rejects(collectClientAssets([directory], version, commit), /验证记录/);
});

test('release assembly revalidates the copied package before writing a manifest', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-release-copy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = 'CC-Desk-Tunnel-Setup-1.2.3-x64.exe';
  const path = join(directory, name);
  writeFileSync(path, 'original package');
  const asset = { name, path, ...(await fileDigest(path)) };
  writeFileSync(path, 'changed package');
  const target = join(directory, 'release');
  mkdirSync(target);
  await assert.rejects(stageClientAssets([asset], target), /复制期间/);
});

test('stable releases require Windows x64 and both Mac architectures', () => {
  const windows = { platform: 'win32', arch: 'x64' };
  const arm = { platform: 'darwin', arch: 'arm64' };
  const intel = { platform: 'darwin', arch: 'x64' };
  assert.throws(() => assertStableClientAssets([windows]), /darwin\/arm64/);
  assert.throws(() => assertStableClientAssets([windows, arm]), /darwin\/x64/);
  assert.throws(() => assertStableClientAssets([arm, intel]), /win32\/x64/);
  assert.doesNotThrow(() => assertStableClientAssets([windows, arm, intel]));
});

test('a release requires both Mac manual installer and ZIP update archive', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-release-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = 'CC-Desk-Tunnel-1.2.3-darwin-x64.zip';
  writeFileSync(join(directory, name), 'zip');
  writeFileSync(
    join(directory, 'macos-x64.json'),
    JSON.stringify({
      version: '1.2.3',
      platform: 'darwin',
      arch: 'x64',
      signed: true,
      notarized: true,
      smokeTested: true,
      sourceCommit: commit,
      sourceClean: true,
      files: [{ name, ...(await fileDigest(join(directory, name))) }],
    }),
  );
  await assert.rejects(collectClientAssets([directory], '1.2.3', commit), /同时包含/);
});

test('release assembly refuses same-version packages built from different or uncommitted sources', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-release-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const version = '1.2.3';
  const name = `CC-Desk-Tunnel-Setup-${version}-x64.exe`;
  const path = join(directory, name);
  writeFileSync(path, 'windows');
  const receipt = {
    version,
    platform: 'win32',
    arch: 'x64',
    smokeTested: true,
    sourceCommit: 'b'.repeat(40),
    sourceClean: true,
    files: [{ name, ...(await fileDigest(path)) }],
  };
  const save = () => writeFileSync(join(directory, 'windows-x64.json'), JSON.stringify(receipt));
  save();
  await assert.rejects(collectClientAssets([directory], version, commit), /源码/);
  receipt.sourceCommit = commit;
  receipt.sourceClean = false;
  save();
  await assert.rejects(collectClientAssets([directory], version, commit), /源码/);
  receipt.sourceClean = true;
  save();
  assert.equal((await collectClientAssets([directory], version, commit)).length, 1);
});
