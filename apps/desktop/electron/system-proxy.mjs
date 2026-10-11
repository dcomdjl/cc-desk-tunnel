import { connect, isIP } from 'node:net';

// The first choice in a proxy answer of the PAC form ("PROXY host:port; DIRECT"), which is how Electron reports
// the Windows proxy settings for an address. Only plain HTTP proxies are used; any other answer connects directly.
export function httpProxy(answer) {
  const match = /^\s*PROXY\s+([^\s;]+):(\d+)/i.exec(typeof answer === 'string' ? answer : '');
  return match ? { host: match[1], port: Number(match[2]) } : null;
}
// A TCP connection to the target, tunnelled through the proxy's CONNECT method when there is one.
export function openSocket(proxy, host, port, timeoutMs = 15000, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const socket = connect(proxy ?? { host, port });
    const cancel = () => fail(signal.reason ?? new Error('Connection cancelled'));
    const cleanup = () => signal?.removeEventListener('abort', cancel);
    const fail = (error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const ready = () => {
      cleanup();
      socket.setTimeout(0);
      socket.off('error', fail);
      resolve(socket);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('Connection timed out')));
    socket.once('error', fail);
    socket.once('close', () => {
      cleanup();
      reject(new Error('Connection closed before it was ready'));
    });
    signal?.addEventListener('abort', cancel, { once: true });
    socket.once('connect', () => {
      if (!proxy) return ready();
      const target = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      // The target stays silent until this side starts TLS, so the answer is all that arrives here.
      let answer = '';
      const read = (chunk) => {
        answer += chunk.toString('latin1');
        if (!answer.includes('\r\n\r\n')) {
          if (answer.length > 8192) fail(new Error('Proxy answer too long'));
          return;
        }
        socket.off('data', read);
        socket.pause();
        if (/^HTTP\/1\.[01] 2\d\d/.test(answer)) ready();
        else fail(new Error(`Proxy refused the connection: ${answer.split('\r\n')[0]}`));
      };
      socket.on('data', read);
    });
  });
}
