import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import ssh2 from 'ssh2';
import { quotePosix } from './shell-environment.mjs';
import { accessFailure, accessStatus, execAccessFailure } from './project-access.mjs';

const { Client, utils } = ssh2;

function projectCommand(device, path) {
  if (device.shell.kind === 'powershell') {
    const literal = `'${path.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);try{$p=Get-Item -LiteralPath ${literal};if(-not $p.PSIsContainer){exit 45};[Console]::Write($p.FullName)}catch [System.Management.Automation.ItemNotFoundException]{exit 44}catch{exit 46}`;
    return `"${device.shell.path}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  }
  const literal = quotePosix(path);
  // Only this probe uses the C locale so shell diagnostics can be classified
  // consistently without changing the environment of user commands.
  return `export LC_ALL=C; cd -- ${literal} || exit 46; pwd -P`;
}

// This checks the same authenticated SSH execution and SFTP paths used by remote
// commands. A private temporary directory reserves this check's file ownership
// before SFTP sends operations whose replies may be lost during cancellation.
export async function checkLocalProject(
  port,
  credentials,
  path,
  { signal, timeoutMs = 10000, targetPath, targetOperation = 'write' } = {},
) {
  const { device } = credentials;
  if (
    typeof path !== 'string' ||
    !path ||
    /[\0\r\n]/.test(path) ||
    !(device.platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path))
  )
    return accessStatus('invalid_path', 'path');
  if (
    targetPath !== undefined &&
    (typeof targetPath !== 'string' ||
      !targetPath ||
      /[\0\r\n]/.test(targetPath) ||
      !['read', 'write'].includes(targetOperation))
  )
    return accessStatus('invalid_path', 'target');
  if (signal?.aborted) return accessStatus('cancelled', 'path');
  const client = new Client();
  let stage = 'connect';
  let failed;
  let sftp;
  let testDirectory;
  let testFile;
  let testHandle;
  let source = 'ssh';
  let checkedPath = path;
  let projectOk = false;
  let outcome;
  const failure = (code, phase) => (outcome = accessStatus(code, phase, checkedPath));
  const pending = new Set();
  const stop = (code) => {
    failed ??= code;
    for (const reject of pending) reject(new Error(code));
    pending.clear();
    client.destroy();
  };
  const cancel = () => stop('cancelled');
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  const wait = (start) =>
    new Promise((resolve, reject) => {
      if (failed) return reject(new Error(failed));
      pending.add(reject);
      const done = (error, value) => {
        pending.delete(reject);
        error ? reject(error) : resolve(value);
      };
      try {
        start(done);
      } catch (error) {
        done(error);
      }
    });
  const call = (method, ...args) => {
    source = 'sftp';
    return wait((done) => sftp[method](...args, done));
  };
  // Cancellation during the handshake can emit more than one SSH error. Keep
  // connection observers for the entire lifetime, including pre-ready teardown.
  client.on('error', () => stop('exec_failed'));
  client.once('close', () => {
    if (pending.size) stop('exec_failed');
  });
  try {
    const host = utils.parseKey(credentials.hostPublicKey).getPublicSSH();
    await wait((done) => {
      client.once('ready', () => done());
      client.connect({
        host: '127.0.0.1',
        port,
        username: credentials.username,
        privateKey: credentials.privateKey,
        readyTimeout: timeoutMs,
        hostVerifier: (key) => key.length === host.length && timingSafeEqual(key, host),
      });
    });
    // stat preserves EACCES/EPERM from inaccessible ancestors. Shell -e loses
    // that distinction by returning false for both denied and missing paths.
    stage = 'path';
    source = 'filesystem';
    const initial = await stat(path);
    if (!initial.isDirectory()) return failure('not_directory', stage);
    stage = 'exec';
    await access(path, constants.R_OK | constants.X_OK);
    source = 'ssh';
    const result = await wait((done) =>
      client.exec(projectCommand(device, path), (error, stream) => {
        if (error) return done(error);
        const output = [];
        const errors = [];
        let bytes = 0;
        const collect = (destination, chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) {
            stream.destroy();
            return done(new Error('exec_failed'));
          }
          destination.push(chunk);
        };
        stream.on('data', (chunk) => collect(output, chunk));
        stream.stderr.on('data', (chunk) => collect(errors, chunk));
        stream.once('error', done);
        stream.once('close', (code) =>
          done(undefined, {
            code,
            error: Buffer.concat(errors).toString('utf8'),
            path: Buffer.concat(output)
              .toString('utf8')
              .replace(/[\r\n]+$/, ''),
          }),
        );
        stream.end();
      }),
    );
    if (result.code !== 0) {
      if (device.platform === 'win32' && result.code === 46)
        return (outcome = {
          ...failure('permission_denied', stage),
          source: 'ssh',
          exitCode: result.code,
        });
      return (outcome = execAccessFailure(result.error, result.code, checkedPath));
    }
    if (!result.path || /[\0\r\n]/.test(result.path)) return failure('exec_failed', stage);
    checkedPath = result.path;
    stage = 'sftp';
    sftp = await wait((done) => client.sftp(done));
    const directoryHandle = await call('opendir', result.path);
    await call('readdir', directoryHandle);
    await call('close', directoryHandle);
    stage = 'write';
    source = 'filesystem';
    testDirectory = await mkdtemp(join(result.path, '.cc-desk-tunnel-check-'));
    const remotePath = (
      device.platform === 'win32' ? testDirectory.replaceAll('\\', '/') : testDirectory
    ).replace(/\/$/, '');
    testFile = `${remotePath}/write-check`;
    testHandle = await call('open', testFile, 'wx', 0o600);
    const content = randomBytes(32);
    await call('write', testHandle, content, 0, content.length, 0);
    await call('close', testHandle);
    testHandle = undefined;
    stage = 'cleanup';
    await call('unlink', testFile);
    source = 'filesystem';
    const details = await stat(result.path);
    projectOk = true;
    if (targetPath !== undefined) {
      const paths = device.platform === 'win32' ? win32 : { resolve, dirname };
      checkedPath = paths.resolve(result.path, targetPath);
      stage = 'target';
      // This checks existing metadata and access only. Never open/truncate an
      // existing file as a diagnostic: the failed write may already be partial.
      await call('stat', checkedPath);
      source = 'filesystem';
      await access(checkedPath, targetOperation === 'read' ? constants.R_OK : constants.W_OK);
      if (targetOperation === 'write') {
        checkedPath = paths.dirname(checkedPath);
        await access(checkedPath, constants.W_OK | constants.X_OK);
      }
      checkedPath = paths.resolve(result.path, targetPath);
    }
    if (failed) return failure(failed, stage);
    return (outcome = {
      ok: true,
      path: result.path,
      identity: {
        deviceId: device.deviceId,
        platform: device.platform,
        path: result.path,
        key: `fs:${details.dev}:${details.ino}`,
      },
      ...(targetPath !== undefined ? { targetPath: checkedPath } : {}),
    });
  } catch (error) {
    outcome = failed
      ? accessStatus(failed, stage, checkedPath)
      : accessFailure(error, stage, { source, path: checkedPath });
    if (projectOk) outcome.projectOk = true;
    return outcome;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    sftp?.end();
    client.end();
    client.destroy();
    // The SFTP server may have opened a file even when its handle never reached
    // us. Removing our reserved directory also prevents a late open from creating
    // it after cleanup; no preexisting project path is included in this removal.
    if (testDirectory) {
      try {
        await rm(testDirectory, { recursive: true, force: true });
      } catch (error) {
        const cleanup = accessFailure(error, 'cleanup', { path: testDirectory });
        return outcome?.ok === false ? { ...outcome, cleanup } : cleanup;
      }
    }
  }
}
