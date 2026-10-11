import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Running the listener in an IPC-owned process also makes abrupt Electron exits
// observable. The worker stops all process groups before it disconnects and exits.
export function startPosixSsh(connectionId, options, signal, onFailure, readyMs = 10000) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Tunnel cancelled'));
    const worker = fork(fileURLToPath(new URL('posix-ssh-worker.mjs', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let closed = false;
    let ready = false;
    let closePromise;
    const exited = new Promise((done) => worker.once('close', done));
    const close = () => {
      if (closePromise) return closePromise;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      closePromise = (async () => {
        if (worker.connected) worker.send({ type: 'close' }, () => {});
        else if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
        await exited;
      })();
      return closePromise;
    };
    const fail = (message) => {
      if (closed) return;
      const stopped = close();
      if (ready) onFailure(message);
      else void stopped.then(() => reject(new Error(message)));
    };
    const cancel = () => {
      const stopped = close();
      if (!ready) void stopped.then(() => reject(new Error('Tunnel cancelled')));
    };
    const timer = setTimeout(
      () => fail('本机执行服务初始化超时，请检查登录 shell 启动脚本。'),
      readyMs,
    );
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('error', () => fail('无法启动本机 SSH 执行服务。'));
    worker.once('exit', (code, signal) =>
      fail(
        `本机 SSH 执行服务已停止（${signal ? `信号 ${signal}` : `退出码 ${code}`}），请重新连接。`,
      ),
    );
    worker.on('message', (message) => {
      if (closed) return;
      if (message.type === 'failed') return fail(message.message);
      if (message.type !== 'ready' || ready) return;
      ready = true;
      clearTimeout(timer);
      resolve({ port: message.port, credentials: message.credentials, close });
    });
    worker.send(
      {
        type: 'start',
        connectionId,
        device: options.device,
        timeoutMs: readyMs,
        sftpPath: options.sftpPath ?? '/usr/libexec/sftp-server',
        env: options.env,
        cwd: options.cwd,
        keepaliveInterval: options.keepaliveInterval,
      },
      (error) => {
        if (error) fail('无法初始化本机 SSH 执行服务。');
      },
    );
  });
}
