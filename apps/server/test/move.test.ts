import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.ts';
import type { DeviceDescriptor } from '@cc-desk-tunnel/protocol';
import { remotePrompt } from '../src/claude.ts';
import { NativeInput } from '../src/native-input.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const deviceId = randomUUID();
function windows(path = 'C:\\pwsh.exe'): DeviceDescriptor {
  return {
    deviceId,
    platform: 'win32',
    arch: 'x64',
    shell: { kind: 'powershell', path },
    schedulesPath: 'C:\\Users\\test\\schedules.json',
    capabilities: { exec: true, sftp: true },
  };
}
function mac(): DeviceDescriptor {
  return {
    deviceId: randomUUID(),
    platform: 'darwin',
    arch: 'arm64',
    shell: { kind: 'posix', path: '/bin/zsh' },
    schedulesPath: '/Users/test/Library/Application Support/CC Desk Tunnel/schedules.json',
    capabilities: { exec: true, sftp: true },
  };
}
function acceptedNotice(store: SessionStore, sessionId: string, device?: DeviceDescriptor) {
  const notice = store.notice(sessionId, device);
  store.acknowledgeNotice(sessionId, notice);
  return notice.text;
}

const device = { id: deviceId, name: '台式机' };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-move-'));
  const store = new SessionStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, session: store.create(randomUUID(), '会话', 'D:\\项目 甲', device) };
}
// What a first native run leaves behind: the prompt it was given and a native session to resume.
function ran(store: SessionStore, sessionId: string, powershellPath = 'C:\\pwsh.exe') {
  const said = store.promptValues(sessionId, windows(powershellPath));
  store.acknowledgePrompt(sessionId, said);
  store.append(sessionId, randomUUID(), {
    type: 'native.session',
    nativeSessionId: sessionId,
    model: 'test',
    version: 'test',
  });
  return said.projectPath;
}

test('a session that never ran simply changes its project', (t) => {
  const { store, session } = fixture(t);
  assert.equal(store.move(session.id, 'D:\\项目 乙').projectPath, 'D:\\项目 乙');
  assert.equal(acceptedNotice(store, session.id, windows()), '');
  assert.equal(store.promptValues(session.id, windows()).projectPath, 'D:\\项目 乙');
});

test('prompt and environment reminders remain pending until the SDK confirms receipt', (t) => {
  const { store, session } = fixture(t);
  const first = store.promptValues(session.id, windows());
  assert.equal(store.get(session.id).session.prompt, undefined);
  store.acknowledgePrompt(session.id, first);
  ran(store, session.id);
  store.move(session.id, 'D:\\项目 乙');
  const changed = windows('D:\\new\\pwsh.exe');
  const pending = store.notice(session.id, changed);
  assert.match(pending.text, /项目 乙/);
  assert.match(pending.text, /new/);
  assert.deepEqual(store.notice(session.id, changed), pending);
  assert.equal(store.get(session.id).session.movedFrom, 'D:\\项目 甲');
  assert.equal(store.get(session.id).session.prompt?.toldDevice, undefined);
  store.acknowledgeNotice(session.id, pending);
  assert.equal(store.notice(session.id, changed).text, '');
  assert.equal(store.get(session.id).session.prompt?.toldDevice?.shell.path, changed.shell.path);
});

test('native slash commands retain their syntax and cannot consume unsent migration reminders', async (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  const device = mac();
  store.move(session.id, '/Users/test/project', device);
  const pending = store.notice(session.id, device);
  for (const command of ['/compact', '/compact preserve architecture', '/cost']) {
    const id = randomUUID();
    const notice = store.notice(session.id, device, command);
    const input = new NativeInput(session.id, (event) => {
      if (event.type === 'message.delivery' && event.status === 'received')
        store.acknowledgeNotice(session.id, notice);
    });
    input.submit(id, notice.text + command);
    const stream = input.stream();
    const submitted = (await stream.next()).value!;
    assert.equal(submitted.message.content, command);
    input.observe({ type: 'result', user_message_uuid: id } as SDKMessage);
    input.close();
    await stream.next();
    assert.deepEqual(store.notice(session.id, device), pending);
  }
  const message = '查看项目';
  const notice = store.notice(session.id, device, message);
  assert.equal(notice.text, pending.text);
  store.acknowledgeNotice(session.id, notice);
  assert.equal(store.notice(session.id, device).text, '');
});

test('a compact boundary before the input receipt cannot acknowledge the old run prompt as current', async (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  const device = mac();
  store.move(session.id, '/Users/test/project', device);
  const activePrompt = store.promptValues(session.id, device);
  const messageId = randomUUID();
  const input = new NativeInput(session.id, (event) => {
    if (event.type === 'message.delivery' && event.status === 'received')
      store.acknowledgePrompt(session.id, activePrompt);
  });
  input.submit(messageId, '/compact');
  const stream = input.stream();
  await stream.next();
  store.compacted(session.id);
  input.observe({ type: 'result', user_message_uuid: messageId } as SDKMessage);
  assert.equal(store.get(session.id).session.prompt?.compacted, true);
  const nextPrompt = store.promptValues(session.id, device);
  assert.equal(nextPrompt.projectPath, '/Users/test/project');
  assert.equal(nextPrompt.device.platform, 'darwin');
  store.acknowledgePrompt(session.id, nextPrompt);
  assert.equal(store.get(session.id).session.prompt?.compacted, undefined);
  input.close();
  await stream.next();
});

test('messages appended after compaction still correct the environment of the active native process', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  const device = mac();
  store.move(session.id, '/Users/test/project', device);
  const activePrompt = store.promptValues(session.id, device);
  store.compacted(session.id);
  // The next run can replace its append-system-prompt, but this process still has the original Windows prompt.
  const followup = store.notice(session.id, device, '检查项目', activePrompt);
  assert.match(followup.text, /POSIX shell/);
  assert.ok(followup.text.includes(JSON.stringify(device.schedulesPath)));
  store.acknowledgeNotice(session.id, followup);
  assert.equal(store.notice(session.id, device, '继续', activePrompt).text, '');
  assert.equal(store.get(session.id).session.prompt?.compacted, true);
});

test('legacy Windows binding and explicit device moves prevent accidental cross-device execution', (t) => {
  const { store } = fixture(t);
  const session = store.create(randomUUID(), '历史', 'D:\\项目 甲');
  const current = mac();
  assert.equal(session.platform, 'win32');
  assert.equal(session.device?.id, undefined);
  assert.throws(() => store.assertDevice(session.id, current), { code: 'device_mismatch' });
  store.assertDevice(session.id, windows());
  assert.equal(store.get(session.id).session.device?.id, deviceId);
  assert.throws(() => store.assertDevice(session.id, { ...windows(), deviceId: randomUUID() }), {
    code: 'device_mismatch',
  });
  ran(store, session.id);
  const moved = store.move(session.id, '/Users/test/project', current);
  assert.equal(moved.platform, 'darwin');
  assert.equal(moved.device?.id, current.deviceId);
  store.assertDevice(session.id, current);
  assert.throws(() => store.assertDevice(session.id, windows()), { code: 'device_mismatch' });
  const oldPrompt = store.promptValues(session.id, current);
  assert.equal(oldPrompt.device.platform, 'win32');
  const notice = store.notice(session.id, current);
  assert.match(notice.text, /macOS/);
  assert.match(notice.text, /POSIX shell/);
  assert.ok(notice.text.includes(JSON.stringify(current.schedulesPath)));
  store.acknowledgeNotice(session.id, notice);
  assert.equal(store.notice(session.id, current).text, '');
  assert.deepEqual(store.promptValues(session.id, current), oldPrompt);
  store.compacted(session.id);
  assert.deepEqual(store.promptValues(session.id, current).device, current);
});

test('a device move binds even when its project path matches and creation IDs cannot change devices', (t) => {
  const { store } = fixture(t);
  const first = mac();
  const second = { ...first, deviceId: randomUUID() };
  const requestId = randomUUID();
  const session = store.create(requestId, '项目', '/Users/test/project', first);
  assert.throws(() => store.create(requestId, '项目', '/Users/test/project', second), {
    code: 'request_conflict',
  });
  assert.throws(() => store.assertDevice(session.id, second), { code: 'device_mismatch' });
  store.move(session.id, session.projectPath, second);
  store.assertDevice(session.id, second);
  assert.equal(store.get(session.id).session.device?.id, second.deviceId);
  const linux: DeviceDescriptor = {
    ...second,
    platform: 'linux',
    shell: { kind: 'posix', path: '/bin/zsh' },
  };
  store.move(session.id, session.projectPath, linux);
  store.assertDevice(session.id, linux);
  assert.equal(store.get(session.id).session.platform, 'linux');
});

test('device binding validates native absolute paths and preserves invalid historical records for explicit repair', (t) => {
  const { store } = fixture(t);
  for (const projectPath of ['/Users/test/project', 'relative', 'C:\\bad\nproject'])
    assert.throws(() => store.create(randomUUID(), '项目', projectPath, windows()), {
      code: 'invalid_project_path',
    });
  for (const projectPath of ['C:\\project', 'relative', '/Users/test/\0project'])
    assert.throws(() => store.create(randomUUID(), '项目', projectPath, mac()), {
      code: 'invalid_project_path',
    });
  for (const projectPath of ['C:\\Project', '\\\\server\\share\\项目', '//server/share/项目']) {
    const session = store.create(randomUUID(), '项目', projectPath, windows());
    store.assertDevice(session.id, windows());
  }
  const historical = store.create(randomUUID(), '无效旧路径', '/Users/test/project');
  assert.throws(() => store.assertDevice(historical.id, windows()), {
    code: 'invalid_project_path',
  });
  assert.equal(store.get(historical.id).session.device?.id, undefined);
  store.move(historical.id, 'D:\\fixed', windows());
  store.assertDevice(historical.id, windows());
});

test('historical Windows prompt bytes survive device migration until compaction', (t) => {
  const { store, session } = fixture(t);
  const historical = {
    ...session,
    prompt: { projectPath: session.projectPath, powershellPath: 'C:\\old\\pwsh.exe' },
  };
  store.database
    .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(historical), session.id);
  ran(store, session.id);
  const before = store.promptValues(session.id, windows());
  const prompt = remotePrompt(
    before.projectPath,
    { configPath: '/stable.conf', device: before.device },
    session.id,
    before.legacyPowershellPath,
  );
  assert.ok(before.legacyPowershellPath);
  assert.match(prompt, /ssh -F "\/stable.conf" windows/);
  assert.match(prompt, /%APPDATA%/);
  const current = mac();
  store.move(session.id, '/Users/test/project', current);
  const after = store.promptValues(session.id, current);
  assert.equal(
    remotePrompt(
      after.projectPath,
      { configPath: '/stable.conf', device: after.device },
      session.id,
      after.legacyPowershellPath,
    ),
    prompt,
  );
  store.acknowledgeNotice(session.id, store.notice(session.id, current));
  assert.equal(store.notice(session.id, current).text, '');
  store.compacted(session.id);
  const fresh = store.promptValues(session.id, current);
  assert.equal(fresh.legacyPowershellPath, undefined);
  assert.match(
    remotePrompt(
      fresh.projectPath,
      { configPath: '/stable.conf', device: fresh.device },
      session.id,
    ),
    /macOS/,
  );
});

test('history cuts reannounce environment changes and fresh native forks discard obsolete prompt metadata', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  const device = mac();
  store.move(session.id, '/Users/test/project', device);
  const pending = store.notice(session.id, device);
  const message = store.append(session.id, randomUUID(), {
    type: 'message.user',
    messageId: randomUUID(),
    text: '迁移后',
    scenario: 'chat',
  });
  store.acknowledgeNotice(session.id, pending);
  assert.equal(store.notice(session.id, device).text, '');
  const whole = store.fork(randomUUID(), session.id, randomUUID(), '完整分叉', true, { device });
  assert.equal(store.notice(whole.id, device).text, '');
  const cut = store.fork(
    randomUUID(),
    session.id,
    randomUUID(),
    '历史分叉',
    true,
    { device },
    message.sequence,
  );
  assert.equal(cut.device?.id, device.deviceId);
  assert.equal(cut.prompt?.toldDevice, undefined);
  assert.equal(cut.movedFrom, 'D:\\项目 甲');
  assert.match(store.notice(cut.id, device).text, /macOS/);
  assert.match(store.notice(cut.id, device).text, /POSIX shell/);
  assert.equal(store.notice(session.id, device).text, '');
  const fresh = store.fork(
    randomUUID(),
    session.id,
    randomUUID(),
    '从首条开始',
    false,
    { device },
    1,
  );
  assert.equal(fresh.prompt, undefined);
  assert.equal(fresh.movedFrom, undefined);
  assert.deepEqual(store.promptValues(fresh.id, device), {
    projectPath: '/Users/test/project',
    device,
  });
  assert.equal(store.notice(fresh.id, device).text, '');
});

test('a move is told once with the next message, and the system prompt keeps its path until a compaction', (t) => {
  const { store, session } = fixture(t);
  assert.equal(ran(store, session.id), 'D:\\项目 甲');
  store.move(session.id, 'D:\\项目 乙', device);
  store.move(session.id, 'D:\\项目 丙', device);
  // Nothing compacted: the prompt is byte for byte what it was, whichever connection the run is on.
  assert.equal(ran(store, session.id), 'D:\\项目 甲');
  const notice = acceptedNotice(store, session.id);
  // The notice names where the session is now and the path Claude knew, not the stops in between.
  assert.match(notice, /is now "D:\\\\项目 丙" \(it was "D:\\\\项目 甲"\)/);
  assert.doesNotMatch(notice, /乙/);
  assert.equal(acceptedNotice(store, session.id), '');
  assert.equal(ran(store, session.id), 'D:\\项目 甲');
  // A later move is told against what Claude heard last, not against the prompt.
  store.move(session.id, 'D:\\项目 丁', device);
  assert.match(
    acceptedNotice(store, session.id),
    /is now "D:\\\\项目 丁" \(it was "D:\\\\项目 丙"\)/,
  );
  store.move(session.id, 'D:\\项目 甲', device);
  assert.match(
    acceptedNotice(store, session.id),
    /is now "D:\\\\项目 甲" \(it was "D:\\\\项目 丁"\)/,
  );
  store.move(session.id, 'D:\\项目 丙', device);

  // A compaction rewrites what follows the prompt; from the next run the prompt says the current path, and
  // there is nothing left to tell.
  store.compacted(session.id);
  assert.equal(acceptedNotice(store, session.id), '');
  assert.equal(ran(store, session.id), 'D:\\项目 丙');
  assert.equal(store.get(session.id).session.prompt?.compacted, undefined);
});

test('a PowerShell path that differs on reconnect is told with the next message, not put in the prompt', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id, 'C:\\old\\pwsh.exe');
  assert.equal(acceptedNotice(store, session.id, windows('C:\\old\\pwsh.exe')), '');
  const notice = acceptedNotice(store, session.id, windows('D:\\new\\pwsh.exe'));
  assert.match(notice, /is now "D:\\\\new\\\\pwsh.exe" \(it was "C:\\\\old\\\\pwsh.exe"\)/);
  assert.equal(
    store.promptValues(session.id, windows('D:\\new\\pwsh.exe')).device.shell.path,
    'C:\\old\\pwsh.exe',
  );
  assert.equal(acceptedNotice(store, session.id, windows('D:\\new\\pwsh.exe')), '');
  // Back on the first computer: Claude was last told the other path.
  assert.match(
    acceptedNotice(store, session.id, windows('C:\\old\\pwsh.exe')),
    /is now "C:\\\\old/,
  );

  // After a compaction the prompt itself is current, and there is nothing left to tell.
  store.compacted(session.id);
  assert.equal(acceptedNotice(store, session.id, windows('D:\\new\\pwsh.exe')), '');
  assert.equal(
    store.promptValues(session.id, windows('D:\\new\\pwsh.exe')).device.shell.path,
    'D:\\new\\pwsh.exe',
  );
  assert.equal(acceptedNotice(store, session.id, windows('D:\\new\\pwsh.exe')), '');
});

test('moving back before anything was said leaves nothing to tell, and a running session cannot move', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  store.move(session.id, 'D:\\项目 乙');
  store.move(session.id, 'D:\\项目 甲');
  assert.equal(acceptedNotice(store, session.id), '');
  store.append(session.id, randomUUID(), {
    type: 'run.status',
    status: 'awaiting_approval',
    connectionId: randomUUID(),
    waiting: 'question',
  });
  assert.equal(store.get(session.id).session.activeRun?.waiting, 'question');
  assert.throws(() => store.move(session.id, 'D:\\项目 乙', device), /结束当前运行/);
});

test('a session taken to another computer tells Claude of the computer and its directory, once', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  const laptop = { id: randomUUID(), name: '笔记本 "二"' };
  // The same path on another computer is still another place.
  store.move(session.id, 'D:\\项目 甲', laptop);
  const notice = acceptedNotice(store, session.id);
  assert.match(notice, /another of their computers, "笔记本 \\"二\\""/);
  assert.match(notice, /is now "D:\\\\项目 甲" \(it was "D:\\\\项目 甲"\)/);
  assert.equal(acceptedNotice(store, session.id), '');
  // A move on that computer afterwards is only a move.
  store.move(session.id, 'E:\\别处', laptop);
  assert.doesNotMatch(acceptedNotice(store, session.id), /computers/);
  store.move(session.id, 'D:\\项目 甲', device);
  assert.match(acceptedNotice(store, session.id), /"台式机"/);
});

test('a session from before computers were told apart becomes that of the first to use it, unannounced', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  store.database.exec(
    "UPDATE sessions SET metadata = json_remove(metadata, '$.device', '$.prompt.device')",
  );
  assert.equal(store.get(session.id).session.device, undefined);
  assert.deepEqual(store.claim(session.id, device).device, device);
  assert.equal(acceptedNotice(store, session.id), '');
  // It is claimed once: the next computer has to take it over.
  const laptop = { id: randomUUID(), name: '笔记本' };
  assert.deepEqual(store.claim(session.id, laptop).device, device);
  assert.deepEqual(
    store.named({ ...device, name: '新名字' }).map(({ id }) => id),
    [session.id],
  );
  assert.equal(store.get(session.id).session.device?.name, '新名字');
});

test('protocol 15 durably normalizes both device metadata formats without changing events or prompt bytes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-device-migration-'));
  const before = new SessionStore(directory);
  const win = before.create(randomUUID(), '0.2.11 Windows', 'D:\\原始项目');
  const macDevice = mac();
  const macSession = before.create(randomUUID(), 'Mac 内测', '/Users/test/project');
  const legacy = {
    ...win,
    device,
    prompt: {
      projectPath: win.projectPath,
      device: device.id,
      told: { projectPath: win.projectPath, device: device.id },
    },
  };
  const macRecord = {
    ...macSession,
    deviceId: macDevice.deviceId,
    platform: 'darwin',
    prompt: { projectPath: macSession.projectPath, device: macDevice },
  };
  before.database
    .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(legacy), win.id);
  before.database
    .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(macRecord), macSession.id);
  before.database.prepare("DELETE FROM migrations WHERE name = 'device-contract-15'").run();
  before.close();
  const store = new SessionStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(store.get(win.id).session.device, device);
  const prompt = store.promptValues(win.id, windows());
  assert.equal(prompt.legacyEnvironment, true);
  const text = remotePrompt(
    prompt.projectPath,
    { configPath: '/tmp/device.conf', device: prompt.device },
    '00000000-0000-4000-8000-000000000001',
    undefined,
    prompt.legacyEnvironment,
  );
  // Golden bytes from PR28's 6aaef4f Windows environment prompt.
  assert.equal(
    createHash('sha256').update(text).digest('hex'),
    '81ef96e430b8c1ea1c4cb129e0edbed18bb338f997613cdfe7d7ee8947cfe466',
  );
  assert.equal(store.get(macSession.id).session.device?.id, macDevice.deviceId);
  assert.equal(store.get(macSession.id).session.platform, 'darwin');
  assert.deepEqual(store.promptValues(macSession.id, macDevice).device, macDevice);
  const persisted = JSON.parse(
    String(
      store.database.prepare('SELECT metadata FROM sessions WHERE id = ?').get(macSession.id)!
        .metadata,
    ),
  );
  assert.equal(persisted.deviceId, undefined);
  assert.equal(persisted.device.id, macDevice.deviceId);
  assert.equal(store.get(win.id).events.length, 0);
  assert.equal(store.get(macSession.id).events.length, 0);
  assert.throws(() => store.assertDevice(win.id, macDevice), { code: 'device_mismatch' });
});
