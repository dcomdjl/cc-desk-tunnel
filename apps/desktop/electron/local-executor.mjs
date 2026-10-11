import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { resolvePosixShell } from './shell-environment.mjs';
import { startWindowsSsh } from './windows-ssh.mjs';
import { startPosixSsh } from './posix-ssh.mjs';
import { checkLocalProject } from './project-check.mjs';
import { missingComponent } from './connect-errors.mjs';

const execute = promisify(execFile);

export async function executionDescriptor(options = {}) {
  const { signal } = options;
  if (signal?.aborted) throw new Error('Tunnel cancelled');
  if (options.device) return options.device;
  const platform = options.platform ?? process.platform;
  let shell;
  if (platform === 'win32') {
    const { stdout } = await execute(
      options.powershell ?? 'pwsh.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::Write([Environment]::ProcessPath)',
      ],
      { windowsHide: true, timeout: 10000, encoding: 'utf8', signal },
    ).catch((error) => {
      if (signal?.aborted) throw new Error('Tunnel cancelled');
      throw new Error(
        error.code === 'ENOENT'
          ? missingComponent('PowerShell（pwsh.exe）')
          : '无法确定内置 PowerShell 的安装路径，请检查安全软件的拦截记录后重新连接。',
      );
    });
    const path = stdout.trim();
    if (!win32.isAbsolute(path) || /[\0\r\n"]/.test(path))
      throw new Error('无法确定内置 PowerShell 的完整安装路径。');
    shell = { kind: 'powershell', path };
  } else if (platform === 'darwin' || platform === 'linux') {
    shell = { kind: 'posix', path: await resolvePosixShell(options) };
  } else throw new Error('当前系统尚不支持本机执行。');
  if (signal?.aborted) throw new Error('Tunnel cancelled');
  return {
    deviceId: options.deviceId ?? randomUUID(),
    platform,
    arch: options.arch ?? process.arch,
    shell,
    schedulesPath: options.schedulesPath ?? join(homedir(), '.cc-desk-tunnel', 'schedules.json'),
    capabilities: { exec: true, sftp: true },
  };
}

export async function startLocalExecutor(
  connectionId,
  options = {},
  signal,
  onFailure = () => {},
  readyMs = 10000,
) {
  const device = await executionDescriptor({ ...options, signal });
  if (device.platform !== process.platform) throw new Error('执行设备与本机系统不匹配。');
  const executor =
    device.platform === 'win32'
      ? await startWindowsSsh(
          connectionId,
          {
            ...options,
            powershell: device.shell.path,
            environment: { ...options.environment, CC_DESK_TUNNEL_SCHEDULES: device.schedulesPath },
          },
          signal,
          onFailure,
          readyMs,
        )
      : await startPosixSsh(
          connectionId,
          {
            ...options,
            device,
            env: {
              ...(options.env ?? process.env),
              ...options.environment,
              CC_DESK_TUNNEL_SCHEDULES: device.schedulesPath,
            },
          },
          signal,
          onFailure,
          readyMs,
        );
  const { powershellPath: _powershellPath, ...credentials } = executor.credentials;
  executor.credentials = { ...credentials, device };
  executor.checkProject = (path, checkOptions) =>
    checkLocalProject(executor.port, executor.credentials, path, checkOptions);
  return executor;
}
