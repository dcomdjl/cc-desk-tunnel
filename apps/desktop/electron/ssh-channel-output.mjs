import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('ssh2/package.json');
if (version !== '1.17.0')
  throw new Error('SSH channel output adapter requires review for ssh2 upgrades.');

// ssh2 1.17.0 shares one send window between stdout and stderr, but keeps stale
// pending-write fields after completion and resumes only one stream per window
// adjustment. An old stdout callback can therefore starve stderr indefinitely.
// Keep this version-specific integration here; callers still use public streams.
// Source: https://github.com/mscdex/ssh2/blob/v1.17.0/lib/Channel.js
export function repairChannelOutput(channel) {
  const pending = new Set();
  const wrapped = new WeakSet();
  let closed = false;
  const outputs = [
    { stream: channel, chunk: '_chunk', callback: '_chunkcb' },
    { stream: channel.stderr, chunk: '_chunkErr', callback: '_chunkcbErr' },
  ];

  for (const [index, output] of outputs.entries()) {
    const write = output.stream._write;
    const other = outputs[1 - index];
    output.stream._write = function (data, encoding, callback) {
      // Window adjustments invoke _write again with the same completion callback.
      // Do not wrap that continuation a second time.
      if (wrapped.has(callback)) return write.call(this, data, encoding, callback);
      let completed = false;
      const done = (error) => {
        if (completed) return;
        completed = true;
        pending.delete(done);
        channel[output.chunk] = undefined;
        channel[output.callback] = undefined;
        callback(error);
        if (closed || channel.outgoing.state !== 'open' || !channel[other.chunk]) return;
        // A resumed write may leave window space without another window-adjust
        // packet. Give the other blocked stream that remaining space immediately.
        if (channel.outgoing.window > 0)
          other.stream._write(channel[other.chunk], null, channel[other.callback]);
        else channel._waitWindow = true;
      };
      wrapped.add(done);
      pending.add(done);
      if (closed) return done(new Error('SSH output channel closed'));
      return write.call(this, data, encoding, done);
    };
  }

  channel.once('close', () => {
    closed = true;
    // The library abandons blocked write callbacks when a channel closes. Settle
    // them once so pipes can release their buffers and error handlers can stop work.
    for (const done of pending) done(new Error('SSH output channel closed'));
    channel._waitWindow = false;
  });
}
