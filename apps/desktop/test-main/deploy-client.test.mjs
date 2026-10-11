import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test(
  'manual deployment publishes Mac and Windows assets atomically only after release hash validation',
  { skip: process.platform === 'win32' },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-deploy-client-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const data = join(directory, 'data');
    mkdirSync(data);
    writeFileSync(join(data, '.cc-desk-tunnel-data'), '');
    const config = join(directory, 'deploy.env');
    writeFileSync(config, `DATA_DIR='${data}'\n`);
    const script = fileURLToPath(new URL('../../../deploy/manage.sh', import.meta.url));
    const run = (...args) =>
      execFileSync('bash', [script, 'client', ...args], {
        env: { ...process.env, PROXY_DEPLOY_CONFIG: config },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    const names = [
      'CC-Desk-Tunnel-0.3.0-darwin-arm64.zip',
      'CC-Desk-Tunnel-0.3.0-darwin-x64.dmg',
      'CC-Desk-Tunnel-Setup-0.3.0-x64.exe',
    ];
    for (const name of names) {
      const asset = join(directory, name);
      const content = Buffer.from(name);
      writeFileSync(asset, content);
      const checksum = createHash('sha256').update(content).digest('hex');
      writeFileSync(join(directory, 'SHA256SUMS'), `${checksum}  ${name}\n`);
      assert.match(run(asset), /Verified installer/);
      assert.deepEqual(readFileSync(join(data, 'state/client', name)), content);
      writeFileSync(asset, 'corrupt replacement');
      assert.throws(() => run(asset), /SHA256 verification failed/);
      assert.deepEqual(readFileSync(join(data, 'state/client', name)), content);
    }
    assert.deepEqual(readdirSync(join(data, 'state/client')).sort(), names.sort());
    rmSync(join(directory, 'SHA256SUMS'));
    assert.throws(() => run(join(directory, names[0])), /Missing release SHA256SUMS/);
  },
);

test(
  'deployment validates the copied bytes when the source changes during copy',
  { skip: process.platform === 'win32' },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-deploy-client-race-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const data = join(directory, 'data');
    mkdirSync(join(data, 'state/client'), { recursive: true });
    writeFileSync(join(data, '.cc-desk-tunnel-data'), '');
    const config = join(directory, 'deploy.env');
    writeFileSync(config, `DATA_DIR='${data}'\n`);
    const name = 'CC-Desk-Tunnel-0.3.0-darwin-arm64.zip';
    const source = join(directory, name);
    writeFileSync(source, 'verified source');
    writeFileSync(join(data, 'state/client', name), 'previous published version');
    const checksum = createHash('sha256').update('verified source').digest('hex');
    writeFileSync(join(directory, 'SHA256SUMS'), `${checksum}  ${name}\n`);
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const installer = join(bin, 'install');
    writeFileSync(
      installer,
      '#!/bin/bash\nprintf changed-source > "$3"\nexec /usr/bin/install "$@"\n',
    );
    chmodSync(installer, 0o755);
    const script = fileURLToPath(new URL('../../../deploy/manage.sh', import.meta.url));
    assert.throws(
      () =>
        execFileSync('bash', [script, 'client', source], {
          env: { ...process.env, PROXY_DEPLOY_CONFIG: config, PATH: `${bin}:${process.env.PATH}` },
          stdio: 'pipe',
        }),
      /SHA256 verification failed/,
    );
    assert.equal(
      readFileSync(join(data, 'state/client', name), 'utf8'),
      'previous published version',
    );
    assert.deepEqual(readdirSync(join(data, 'state/client')), [name]);
  },
);
