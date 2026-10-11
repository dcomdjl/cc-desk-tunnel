import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PROTOCOL_VERSION,
  authSchema,
  commandSchema,
  eventSchema,
  deviceDescriptorSchema,
  tunnelCredentialsSchema,
  sessionSchema,
  terminalControlSchema,
} from '../src/index.ts';

test('protocol validates UTF-8 text, IDs and bounded input', () => {
  const command = {
    type: 'message.send',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    text: ' 检查 D:\\工作\\测试 ',
  };
  const parsed = commandSchema.parse(command);
  assert.equal(parsed.type, 'message.send');
  if (parsed.type === 'message.send') assert.equal(parsed.text, '检查 D:\\工作\\测试');
  assert.equal(commandSchema.safeParse({ ...command, text: ' ' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, text: 'a'.repeat(16001) }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, sessionId: 'not-an-id' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, token: 'unexpected' }).success, false);
});

test('project commands preserve significant POSIX whitespace and Unicode in absolute paths', () => {
  const projectPath = '/Users/test/项目 e\u0301 ';
  for (const command of [
    { type: 'session.create', requestId: randomUUID(), title: '项目', projectPath },
    { type: 'session.move', requestId: randomUUID(), sessionId: randomUUID(), projectPath },
  ]) {
    const parsed = commandSchema.parse(command);
    assert.ok(parsed.type === 'session.create' || parsed.type === 'session.move');
    assert.equal(parsed.projectPath, projectPath);
    assert.equal(commandSchema.safeParse({ ...command, projectPath: ' ' }).success, false);
  }
});

test('device descriptors enforce platform shell contracts and absolute executable and schedule paths', () => {
  const device = {
    deviceId: randomUUID(),
    platform: 'darwin',
    arch: 'arm64',
    shell: { kind: 'posix', path: '/bin/zsh' },
    schedulesPath: '/Users/test/Library/Application Support/CC Desk Tunnel/schedules.json',
    capabilities: { exec: true, sftp: true },
  };
  assert.ok(deviceDescriptorSchema.safeParse(device).success);
  assert.ok(
    deviceDescriptorSchema.safeParse({ ...device, platform: 'linux', arch: 'x64' }).success,
  );
  for (const invalid of [
    { ...device, deviceId: 'invalid' },
    { ...device, platform: 'win32' },
    { ...device, shell: { kind: 'powershell', path: '/bin/zsh' } },
    { ...device, shell: { kind: 'posix', path: 'zsh' } },
    { ...device, schedulesPath: 'schedules.json' },
    { ...device, schedulesPath: '/tmp/schedules\n.json' },
    { ...device, capabilities: { exec: true, sftp: false } },
  ])
    assert.equal(deviceDescriptorSchema.safeParse(invalid).success, false);
  const windows = {
    ...device,
    platform: 'win32',
    shell: { kind: 'powershell', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    schedulesPath: 'C:\\Users\\test\\schedules.json',
  };
  assert.ok(deviceDescriptorSchema.safeParse(windows).success);
  assert.equal(
    deviceDescriptorSchema.safeParse({
      ...windows,
      shell: { kind: 'powershell', path: 'C:\\bad"&command' },
    }).success,
    false,
  );
  const credentials = {
    type: 'tunnel.credentials',
    connectionId: randomUUID(),
    username: 'user',
    privateKey: 'test',
    hostPublicKey: 'ssh-ed25519 AAAA',
    device,
  };
  assert.ok(tunnelCredentialsSchema.safeParse(credentials).success);
  assert.equal(
    tunnelCredentialsSchema.safeParse({ ...credentials, powershellPath: 'C:\\pwsh.exe' }).success,
    false,
  );
});

test('unbound historical sessions parse as Windows without claiming the current device', () => {
  const now = new Date().toISOString();
  const session = sessionSchema.parse({
    id: randomUUID(),
    title: '旧会话',
    projectPath: 'D:\\项目',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  });
  assert.equal(session.platform, 'win32');
  assert.equal(session.device?.id, undefined);
});

test('legacy device aliases normalize to one owner and conflicting owners are rejected', () => {
  const now = new Date().toISOString();
  const deviceId = randomUUID();
  const value = {
    id: randomUUID(),
    title: '旧 Mac',
    projectPath: '/Users/test/project',
    platform: 'darwin',
    deviceId,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const normalized = sessionSchema.parse(value);
  assert.equal(normalized.device?.id, deviceId);
  assert.equal('deviceId' in normalized, false);
  assert.equal(
    sessionSchema.safeParse({ ...value, device: { id: randomUUID(), name: '不同设备' } }).success,
    false,
  );
});

test('authentication version and event ordering are explicit', () => {
  const auth = {
    type: 'auth',
    protocolVersion: PROTOCOL_VERSION,
    token: 'x'.repeat(32),
    deviceName: '开发机',
  };
  assert.equal(authSchema.safeParse(auth).success, true);
  // Another version still authenticates, so that the service can answer with how to upgrade.
  assert.equal(authSchema.safeParse({ ...auth, protocolVersion: 9999 }).success, true);
  assert.equal(authSchema.safeParse({ ...auth, protocolVersion: 0 }).success, false);
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: { type: 'run.status', status: 'running', connectionId: randomUUID() },
  };
  assert.equal(eventSchema.safeParse(event).success, true);
  assert.equal(eventSchema.safeParse({ ...event, sequence: 0 }).success, false);
});

test('terminal control frames are explicitly scoped and bounded without request caches', () => {
  const frame = {
    type: 'terminal.input',
    sessionId: randomUUID(),
    terminalId: randomUUID(),
    data: '中文\r',
  };
  assert.equal(terminalControlSchema.safeParse(frame).success, true);
  assert.equal(
    terminalControlSchema.safeParse({ ...frame, data: 'x'.repeat(8193) }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({ ...frame, requestId: randomUUID() }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({
      type: 'terminal.ack',
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      bytes: -1,
    }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({
      type: 'terminal.resize',
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      cols: 0,
      rows: 30,
    }).success,
    false,
  );
});

test('a run waiting only for background tasks, its task list and the request to end one are valid', () => {
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
  };
  const status = { type: 'run.status', status: 'running', connectionId: randomUUID() };
  assert.ok(
    eventSchema.safeParse({ ...event, payload: { ...status, waiting: 'background' } }).success,
  );
  assert.ok(
    eventSchema.safeParse({
      ...event,
      payload: {
        type: 'native.tasks',
        tasks: [{ id: 'b1', kind: 'local_bash', description: '渲染' }],
      },
    }).success,
  );
  const stop = {
    type: 'run.task.stop',
    requestId: randomUUID(),
    sessionId: event.sessionId,
    runId: event.runId,
    taskId: 'b1',
  };
  assert.ok(commandSchema.safeParse(stop).success);
  assert.equal(commandSchema.safeParse({ ...stop, taskId: '' }).success, false);
});
