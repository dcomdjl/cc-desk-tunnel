import { basename, isAbsolute, join } from 'node:path';
import { access, chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';

export const quotePosix = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function resolvePosixShell(options = {}) {
  if (options.signal?.aborted) throw new Error('Tunnel cancelled');
  let accountShell;
  try {
    accountShell = userInfo().shell;
  } catch {
    /* The platform fallback remains available. */
  }
  const path =
    options.shellPath ??
    options.shell?.path ??
    process.env.SHELL ??
    accountShell ??
    (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  if (!isAbsolute(path) || /[\0\r\n]/.test(path) || !/^(?:zsh|bash)$/.test(basename(path)))
    throw new Error('本机执行需要绝对路径的 zsh 或 bash，请检查登录 shell 设置。');
  const resolved = await realpath(path).catch(() => {
    throw new Error('找不到本机登录 shell，请检查 zsh 或 bash 的安装路径。');
  });
  await access(resolved, constants.X_OK).catch(() => {
    throw new Error('无法执行本机登录 shell，请检查 zsh 或 bash 的文件权限。');
  });
  if (options.signal?.aborted) throw new Error('Tunnel cancelled');
  // Shell invocation names select their startup and execution semantics. Keep
  // the validated bash/zsh path even when its target has a versioned basename.
  return path;
}

// A private Unix socket carries only environment JSON. Login shells and Electron
// can close inherited auxiliary descriptors; a socket opened by the helper after
// initialization works for both. Profile output stays on separate stdout/stderr.
export async function captureShellEnvironment(
  shell,
  supervisor,
  { signal, timeoutMs = 10000, maxBytes = 1024 * 1024, env = process.env, cwd } = {},
) {
  if (signal?.aborted) throw new Error('Tunnel cancelled');
  // macOS limits Unix socket paths to 104 bytes. User-configured TMPDIR can be
  // longer; a private directory under /tmp keeps the endpoint within that limit.
  const root =
    Buffer.byteLength(join(tmpdir(), 'cc-env-123456', 'env.sock')) < 100 ? tmpdir() : '/tmp';
  const directory = await mkdtemp(join(root, 'cc-env-'));
  const socketPath = join(directory, 'env.sock');
  const nonce = randomBytes(24).toString('hex');
  const sockets = new Set();
  let receive;
  const server = createServer((socket) => {
    if (sockets.size) return socket.destroy();
    sockets.add(socket);
    socket.on('error', () => {});
    receive?.(socket);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    if (signal?.aborted) throw new Error('Tunnel cancelled');
    return await new Promise((resolve, reject) => {
      const baseEnvironment = { ...env };
      delete baseEnvironment.ELECTRON_RUN_AS_NODE;
      const script = `const s=require('node:net').createConnection(${JSON.stringify(socketPath)});s.on('error',()=>process.exit(1));s.once('connect',()=>s.end(JSON.stringify({nonce:${JSON.stringify(nonce)},environment:process.env})));`;
      const command = `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quotePosix(process.execPath)} -e ${quotePosix(script)}`;
      const child = supervisor.spawn(shell, ['-lic', command], {
        env: baseEnvironment,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      let childClosed = false;
      let received = false;
      let bytes = 0;
      let noise = 0;
      const output = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) void child.stopGroup();
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(new Error('Tunnel cancelled'));
      const timer = setTimeout(
        () => finish(new Error('登录 shell 初始化超时，请检查 shell 启动脚本中的等待或交互命令。')),
        timeoutMs,
      );
      signal?.addEventListener('abort', cancel, { once: true });
      receive = (socket) => {
        socket.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(new Error('登录 shell 的环境变量超过大小限制。'));
          output.push(chunk);
        });
        socket.once('end', () => {
          received = true;
          complete();
        });
      };
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          noise += chunk.length;
          if (noise > maxBytes) finish(new Error('登录 shell 启动脚本的输出超过大小限制。'));
        });
      child.once('error', (error) =>
        finish(
          new Error(
            `无法启动本机登录 shell（${error.code ?? '未知错误'}），请检查路径和执行权限。`,
          ),
        ),
      );
      child.once('close', (code, signal) => {
        childClosed = true;
        if (code !== 0)
          return finish(
            new Error(
              `登录 shell 异常结束（${signal ? `信号 ${signal}` : `退出码 ${code}`}），没有返回有效环境，请检查 shell 文件和启动脚本。`,
            ),
          );
        complete();
      });
      function complete() {
        if (settled || !received || !childClosed) return;
        try {
          const captured = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (captured.nonce !== nonce) throw new Error();
          const environment = captured.environment;
          if (!environment || Array.isArray(environment) || typeof environment !== 'object')
            throw new Error();
          for (const [key, value] of Object.entries(environment))
            if (typeof value !== 'string' || /[\0=]/.test(key) || value.includes('\0'))
              throw new Error();
          delete environment.ELECTRON_RUN_AS_NODE;
          // Prevent per-command noninteractive startup hooks from repeating login profiles.
          delete environment.BASH_ENV;
          delete environment.ENV;
          finish(undefined, environment);
        } catch {
          finish(new Error('登录 shell 没有返回有效环境，请检查 zsh 或 bash 启动脚本。'));
        }
      }
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
