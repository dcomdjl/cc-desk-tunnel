import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function generate(supervisor, path) {
  return new Promise((resolve, reject) => {
    const child = supervisor.spawn(
      '/usr/bin/ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', 'cc-desk-tunnel', '-f', path],
      {
        stdio: 'ignore',
      },
    );
    child.once('error', () => reject(new Error('无法启动系统 ssh-keygen。')));
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('无法生成本次连接的 SSH 密钥。')),
    );
  });
}

// ssh2 1.17's Ed25519 converter drops leading zero bytes from the public key.
// Use the system OpenSSH encoder, then remove its private temporary files before
// announcing credentials. mkdtemp uses mode 700; ssh-keygen writes private keys 600.
export async function connectionKeys(supervisor, signal) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-keys-'));
  try {
    if (signal.aborted) throw new Error('Tunnel cancelled');
    await generate(supervisor, join(directory, 'host'));
    if (signal.aborted) throw new Error('Tunnel cancelled');
    await generate(supervisor, join(directory, 'login'));
    if (signal.aborted) throw new Error('Tunnel cancelled');
    const [hostPrivate, hostPublic, loginPrivate, loginPublic] = await Promise.all([
      readFile(join(directory, 'host'), 'utf8'),
      readFile(join(directory, 'host.pub'), 'utf8'),
      readFile(join(directory, 'login'), 'utf8'),
      readFile(join(directory, 'login.pub'), 'utf8'),
    ]);
    return { hostPrivate, hostPublic, loginPrivate, loginPublic };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
