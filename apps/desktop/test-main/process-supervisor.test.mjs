import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ProcessSupervisor } from '../electron/process-supervisor.mjs';

function fixture(t, signal) {
  const child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: 0, signalCode: null });
  t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.mock.method(process, 'kill', signal);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const supervisor = new ProcessSupervisor({ graceMs: 20 });
  return { child: supervisor.spawn('/test/command', []), supervisor };
}

test('EPERM on a group existence probe retains cleanup ownership without crashing the executor', async (t) => {
  const signals = [];
  const { child, supervisor } = fixture(t, (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 0) throw Object.assign(new Error('probe denied'), { code: 'EPERM' });
    if (signal === 'SIGKILL') throw Object.assign(new Error('already gone'), { code: 'ESRCH' });
    return true;
  });
  child.emit('exit', 0);
  assert.doesNotThrow(() => child.emit('close', 0));
  let reclaimed = false;
  const closing = supervisor.close().then(() => {
    reclaimed = true;
  });
  await Promise.resolve();
  assert.equal(reclaimed, false);
  t.mock.timers.tick(20);
  await closing;
  assert.equal(reclaimed, true);
  assert.deepEqual(signals, [
    [-123456, 'SIGTERM'],
    [-123456, 0],
    [-123456, 'SIGKILL'],
  ]);
  await Promise.all([supervisor.close(), child.stopGroup()]);
  assert.equal(signals.length, 3);
});

test('a real termination denial is not treated as an absent or reclaimed group', async (t) => {
  const { child } = fixture(t, () => {
    throw Object.assign(new Error('termination denied'), { code: 'EPERM' });
  });
  await assert.rejects(child.stopGroup(), { code: 'EPERM' });
});
