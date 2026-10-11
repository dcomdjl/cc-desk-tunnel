import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotSchema, sessionSchema, terminalStatuses } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import type {
  Device,
  Effort,
  DeviceDescriptor,
  EventPayload,
  HistoryPage,
  PermissionMode,
  Session,
  SessionEvent,
  SessionSnapshot,
} from '@cc-desk-tunnel/protocol';

type StoredSession = SessionSnapshot & { createRequestId: string };
export type PromptValues = {
  projectPath: string;
  device: DeviceDescriptor;
  legacyPowershellPath?: string;
  legacyEnvironment?: true;
  afterCompaction?: true;
};
export type SessionNotice = {
  text: string;
  projectPath: string;
  movedFrom?: string;
  device?: DeviceDescriptor;
  knownEnvironment?: string;
  ownerId?: string;
};
const environment = (
  device: Pick<DeviceDescriptor, 'platform' | 'shell'> & { schedulesPath?: string },
) =>
  JSON.stringify({
    platform: device.platform,
    shell: device.shell,
    schedulesPath: device.schedulesPath,
  });
function knownDevice(prompt: NonNullable<Session['prompt']>) {
  return (
    prompt.toldDevice ??
    prompt.device ??
    (prompt.format === 'environment'
      ? {
          platform: 'win32' as const,
          shell: { kind: 'powershell' as const, path: '%CC_DESK_TUNNEL_PWSH%' },
          schedulesPath: '%CC_DESK_TUNNEL_SCHEDULES%',
        }
      : undefined) ??
    (prompt.powershellPath
      ? {
          platform: 'win32' as const,
          shell: {
            kind: 'powershell' as const,
            path: prompt.toldPowershellPath ?? prompt.powershellPath,
          },
        }
      : undefined)
  );
}
const platformName = (platform: DeviceDescriptor['platform']) =>
  platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
type BoundDevice = (Device & { platform?: DeviceDescriptor['platform'] }) | DeviceDescriptor;
const identityOf = (device: BoundDevice): Device =>
  'deviceId' in device
    ? { id: device.deviceId, name: device.name ?? platformName(device.platform) }
    : { id: device.id, name: device.name };
const platformOf = (device: BoundDevice) =>
  'platform' in device ? (device.platform ?? 'win32') : 'win32';
function assertProjectPath(projectPath: string, platform: DeviceDescriptor['platform']) {
  const absolute =
    platform === 'win32'
      ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(projectPath) && win32.isAbsolute(projectPath)
      : posix.isAbsolute(projectPath);
  if (!absolute || /[\0\r\n]/.test(projectPath))
    throw new DomainError(
      'invalid_project_path',
      '项目目录必须是执行设备上的绝对路径，且不能含换行或空字符。',
    );
}
const pageEvents = 1000;
const pageBytes = 512 * 1024;

function batchHistory(events: SessionEvent[]) {
  const result: SessionEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    const current = event.payload;
    const last = previous?.payload;
    if (
      previous &&
      last &&
      event.runId === previous.runId &&
      ((current.type === 'text.delta' &&
        last.type === 'text.delta' &&
        current.messageId === last.messageId) ||
        (current.type === 'thinking.delta' &&
          last.type === 'thinking.delta' &&
          current.messageId === last.messageId) ||
        (current.type === 'tool.input.delta' &&
          last.type === 'tool.input.delta' &&
          current.toolId === last.toolId) ||
        (current.type === 'tool.output' &&
          last.type === 'tool.output' &&
          current.toolId === last.toolId &&
          current.stream === last.stream))
    ) {
      result[result.length - 1] = {
        ...event,
        payload: { ...current, text: (last as typeof current).text + current.text },
      };
    } else result.push(event);
  }
  return result;
}

// Reading a session's native state when it is opened is not use of it: these do not move it up the list.
const stateReadings = new Set<EventPayload['type']>(['native.capabilities', 'native.metrics']);

export class SessionStore {
  directory: string;
  database: DatabaseSync;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(directory, 'sessions.sqlite'));
    if (process.platform !== 'win32') chmodSync(join(directory, 'sessions.sqlite'), 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, metadata TEXT NOT NULL, create_request_id TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(session_id, run_id, sequence);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
    `);
    try {
      this.importJson();
      this.migrateDeviceMetadata();
      this.restoreUpdatedAt();
      for (const session of this.list()) {
        if (!session.activeRun) continue;
        const { id: runId, connectionId } = session.activeRun;
        const events = this.runEvents(session.id, runId);
        const native = events.some((event) => event.payload.type === 'native.session');
        for (const event of events) {
          if (event.payload.type !== 'message.user') continue;
          const messageId = event.payload.messageId;
          const delivery = events.findLast(
            (item) =>
              item.payload.type === 'message.delivery' && item.payload.messageId === messageId,
          )?.payload;
          if (
            delivery?.type === 'message.delivery' &&
            ['submitted', 'queued'].includes(delivery.status)
          )
            this.append(session.id, runId, {
              type: 'message.delivery',
              messageId,
              status: delivery.status === 'submitted' ? 'not_sent' : 'unconfirmed',
            });
        }
        for (const event of events) {
          if (event.payload.type !== 'tool.requested') continue;
          const toolId = event.payload.toolId;
          if (
            events.some(
              (item) => item.payload.type === 'tool.result' && item.payload.toolId === toolId,
            )
          )
            continue;
          this.append(session.id, runId, {
            type: 'tool.result',
            toolId,
            status: native ? 'unknown' : 'cancelled',
            output: native
              ? '服务重启；工具最终执行结果未确认，不能自动重放。'
              : '服务重启；模拟工具未执行。',
            exitCode: null,
          });
        }
        this.append(session.id, runId, {
          type: 'run.status',
          status: 'cancelled',
          connectionId,
          reason: '服务重启，运行未重放。',
        });
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private importJson() {
    if (this.database.prepare('SELECT name FROM migrations WHERE name = ?').get('json-import'))
      return;
    this.database.exec('BEGIN');
    try {
      for (const file of readdirSync(this.directory).filter((file) => file.endsWith('.json'))) {
        const value = JSON.parse(readFileSync(join(this.directory, file), 'utf8'));
        const record = snapshotSchema.parse(value);
        if (
          file !== `${record.session.id}.json` ||
          typeof value.createRequestId !== 'string' ||
          record.events.some(
            (event, index) => event.sessionId !== record.session.id || event.sequence !== index + 1,
          )
        )
          throw new Error(`Invalid legacy session: ${file}`);
        this.database
          .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
          .run(record.session.id, JSON.stringify(record.session), value.createRequestId);
        const insert = this.database.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
        for (const event of record.events)
          insert.run(event.sessionId, event.sequence, event.runId, JSON.stringify(event));
      }
      this.database.prepare('INSERT INTO migrations VALUES (?)').run('json-import');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  // Sessions that had only been looked at carry the time of that look; they get back the time of what last
  // happened in them.
  private restoreUpdatedAt() {
    if (this.database.prepare("SELECT 1 FROM migrations WHERE name = 'updated-at-activity'").get())
      return;
    const kinds = [...stateReadings].map((kind) => `'${kind}'`).join(', ');
    const last = this.database.prepare(
      'SELECT data FROM events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1',
    );
    const activity = this.database.prepare(
      `SELECT data FROM events WHERE session_id = ? AND json_extract(data, '$.payload.type') NOT IN (${kinds})
      ORDER BY sequence DESC LIMIT 1`,
    );
    this.database.exec('BEGIN');
    try {
      for (const session of this.list()) {
        const row = last.get(session.id);
        if (!row) continue;
        const event = JSON.parse(String(row.data)) as SessionEvent;
        if (!stateReadings.has(event.payload.type) || session.updatedAt !== event.createdAt)
          continue;
        const before = activity.get(session.id);
        session.updatedAt = before
          ? (JSON.parse(String(before.data)) as SessionEvent).createdAt
          : session.createdAt;
        this.save(session);
      }
      this.database.prepare("INSERT INTO migrations VALUES ('updated-at-activity')").run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  list(): Session[] {
    return this.database
      .prepare('SELECT metadata FROM sessions')
      .all()
      .map((row) => sessionSchema.parse(JSON.parse(String(row.metadata))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private migrateDeviceMetadata() {
    if (this.database.prepare("SELECT 1 FROM migrations WHERE name = 'device-contract-15'").get())
      return;
    this.database.exec('BEGIN');
    try {
      for (const session of this.list()) this.save(session);
      this.database.prepare("INSERT INTO migrations VALUES ('device-contract-15')").run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(sessionId: string): StoredSession {
    const row = this.database
      .prepare('SELECT metadata, create_request_id FROM sessions WHERE id = ?')
      .get(sessionId);
    if (!row) throw new DomainError('not_found', '会话不存在。');
    const store = this;
    return {
      session: sessionSchema.parse(JSON.parse(String(row.metadata))),
      createRequestId: String(row.create_request_id),
      get events() {
        return store.events(sessionId);
      },
    };
  }

  private events(sessionId: string, after = 0, before = Number.MAX_SAFE_INTEGER) {
    return this.database
      .prepare(
        'SELECT data FROM events WHERE session_id = ? AND sequence > ? AND sequence < ? ORDER BY sequence',
      )
      .all(sessionId, after, before)
      .map((row) => JSON.parse(String(row.data)) as SessionEvent);
  }
  private runEvents(sessionId: string, runId: string) {
    return this.database
      .prepare('SELECT data FROM events WHERE session_id = ? AND run_id = ? ORDER BY sequence')
      .all(sessionId, runId)
      .map((row) => JSON.parse(String(row.data)) as SessionEvent);
  }
  private lastSequence(sessionId: string) {
    return Number(
      this.database
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM events WHERE session_id = ?')
        .get(sessionId)!.value,
    );
  }
  hasNativeContext(sessionId: string) {
    return !!this.database
      .prepare(
        "SELECT 1 FROM events WHERE session_id = ? AND json_extract(data, '$.payload.type') = 'native.session' LIMIT 1",
      )
      .get(sessionId);
  }
  userMessage(sessionId: string, messageId: string) {
    const row = this.database
      .prepare(
        "SELECT data FROM events WHERE session_id = ? AND json_extract(data, '$.payload.messageId') = ? AND json_extract(data, '$.payload.type') = 'message.user' LIMIT 1",
      )
      .get(sessionId, messageId);
    return row ? (JSON.parse(String(row.data)) as SessionEvent) : undefined;
  }

  create(requestId: string, title: string, projectPath: string, device?: BoundDevice): Session {
    if (device) assertProjectPath(projectPath, platformOf(device));
    const row = this.database
      .prepare('SELECT metadata FROM sessions WHERE create_request_id = ?')
      .get(requestId);
    if (row) {
      const session = sessionSchema.parse(JSON.parse(String(row.metadata)));
      if (
        ((!session.autoTitle || title !== '新会话') && session.title !== title) ||
        session.projectPath !== projectPath ||
        (device &&
          (session.device?.id !== identityOf(device).id || session.platform !== platformOf(device)))
      )
        throw new DomainError('request_conflict', '请求 ID 已被其他内容使用。');
      return session;
    }
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      title,
      autoTitle: title === '新会话',
      projectPath,
      platform: device ? platformOf(device) : 'win32',
      ...(device ? { device: identityOf(device) } : {}),
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    this.database
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(session.id, JSON.stringify(session), requestId);
    return session;
  }

  created(requestId: string) {
    const row = this.database
      .prepare('SELECT metadata FROM sessions WHERE create_request_id = ?')
      .get(requestId);
    return row ? sessionSchema.parse(JSON.parse(String(row.metadata))) : undefined;
  }
  // Where a fork that stops before this message cuts the history. Only a message that started its run
  // qualifies: cutting at one added mid-run would leave half a run behind.
  forkPoint(sessionId: string, messageId: string) {
    const event = this.userMessage(sessionId, messageId);
    if (!event) throw new DomainError('not_found', '消息不存在。');
    if (this.runEvents(sessionId, event.runId)[0]!.sequence !== event.sequence)
      throw new DomainError('fork_point', '运行途中追加的消息不能作为分叉点。');
    return event.sequence;
  }
  // Copies a session and its events before `beforeSequence` under `id`, onto the computer that asked and
  // into its directory there. Without native history to resume, the copy also drops the events that would
  // claim there is one.
  fork(
    requestId: string,
    sourceId: string,
    id: string,
    title: string,
    native: boolean,
    place: { device: BoundDevice; projectPath?: string },
    beforeSequence?: number,
  ): Session {
    const { session: source } = this.get(sourceId);
    if (
      source.device &&
      (source.device.id !== identityOf(place.device).id ||
        source.platform !== platformOf(place.device)) &&
      !place.projectPath
    )
      throw new DomainError('project_required', '分叉到另一设备前请明确选择本机项目目录。');
    if (place.projectPath) assertProjectPath(place.projectPath, platformOf(place.device));
    const now = new Date().toISOString();
    const session: Session = {
      ...source,
      id,
      title,
      device: identityOf(place.device),
      platform: platformOf(place.device),
      projectPath: place.projectPath ?? source.projectPath,
      autoTitle: false,
      nativeRoot: native ? (source.nativeRoot ?? source.id) : undefined,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    if (!native) {
      session.prompt = undefined;
      session.movedFrom = undefined;
      session.movedFromPlatform = undefined;
      session.movedFromDevice = undefined;
    } else if (beforeSequence !== undefined && session.prompt) {
      // A cut may exclude the inputs that confirmed the latest environment. Reannounce it against the
      // stable system prompt instead of claiming that the truncated native history still contains them.
      session.prompt = { ...session.prompt, toldDevice: undefined, toldPowershellPath: undefined };
      const platform = session.prompt.device?.platform ?? 'win32';
      session.movedFrom =
        session.prompt.projectPath !== session.projectPath || platform !== session.platform
          ? session.prompt.projectPath
          : undefined;
      session.movedFromPlatform = session.movedFrom ? platform : undefined;
    }
    const events = this.events(sourceId, 0, beforeSequence).filter(
      ({ payload }) =>
        native || (payload.type !== 'native.session' && payload.type !== 'native.context'),
    );
    this.database.exec('BEGIN');
    try {
      this.database
        .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
        .run(id, JSON.stringify(session), requestId);
      const insert = this.database.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
      events.forEach((event, index) => {
        const payload =
          'nativeSessionId' in event.payload
            ? { ...event.payload, nativeSessionId: id }
            : event.payload;
        const copy: SessionEvent = { ...event, sessionId: id, sequence: index + 1, payload };
        insert.run(id, copy.sequence, copy.runId, JSON.stringify(copy));
      });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return session;
  }

  snapshot(sessionId: string, afterSequence = 0): SessionSnapshot {
    const { session } = this.get(sessionId);
    if (afterSequence > this.lastSequence(sessionId))
      throw new DomainError('invalid_cursor', '恢复游标超出历史范围。');
    return { session, events: this.events(sessionId, afterSequence) };
  }

  history(
    sessionId: string,
    requestId: string,
    afterSequence = 0,
    beforeSequence?: number,
  ): HistoryPage {
    const { session } = this.get(sessionId);
    const last = this.lastSequence(sessionId);
    if (afterSequence > last || (beforeSequence !== undefined && beforeSequence > last + 1))
      throw new DomainError('invalid_cursor', '历史游标超出范围。');
    if (afterSequence > 0) {
      const size = this.database
        .prepare(
          'SELECT COUNT(*) AS count, COALESCE(SUM(length(data)), 0) AS bytes FROM events WHERE session_id = ? AND sequence > ?',
        )
        .get(sessionId, afterSequence)!;
      if (Number(size.count) <= pageEvents && Number(size.bytes) <= pageBytes) {
        const events = this.events(sessionId, afterSequence);
        return {
          session,
          requestId,
          mode: 'append',
          events: batchHistory(events),
          firstSequence: events[0]?.sequence ?? 0,
          lastSequence: last,
          hasEarlier: false,
        };
      }
    }
    // Keep a complete run together: a single unusually large run may exceed the soft page budget.
    const groups = this.database
      .prepare(
        `
      SELECT run_id, MIN(sequence) AS first, COUNT(*) AS count, SUM(length(data)) AS bytes
      FROM events WHERE session_id = ? AND sequence < ? GROUP BY run_id ORDER BY first DESC LIMIT 1000
    `,
      )
      .all(sessionId, beforeSequence ?? last + 1);
    let first = 0,
      count = 0,
      bytes = 0;
    for (const group of groups) {
      if (
        first &&
        (count + Number(group.count) > pageEvents || bytes + Number(group.bytes) > pageBytes)
      )
        break;
      first = Number(group.first);
      count += Number(group.count);
      bytes += Number(group.bytes);
    }
    const events = first ? this.events(sessionId, first - 1, beforeSequence) : [];
    return {
      session,
      requestId,
      mode: beforeSequence === undefined ? 'replace' : 'prepend',
      events: batchHistory(events),
      firstSequence: first,
      lastSequence: events.at(-1)?.sequence ?? 0,
      hasEarlier: first > 1,
    };
  }

  append(sessionId: string, runId: string, payload: EventPayload): SessionEvent {
    const { session } = this.get(sessionId);
    const event: SessionEvent = {
      sessionId,
      runId,
      sequence: this.lastSequence(sessionId) + 1,
      createdAt: new Date().toISOString(),
      payload,
    };
    if (!stateReadings.has(payload.type)) session.updatedAt = event.createdAt;
    if (payload.type === 'run.status')
      session.activeRun = terminalStatuses.has(payload.status)
        ? null
        : {
            id: runId,
            status: payload.status,
            connectionId: payload.connectionId,
            ...(payload.surface ? { surface: payload.surface } : {}),
            ...(payload.waiting ? { waiting: payload.waiting } : {}),
          };
    this.database.exec('BEGIN');
    try {
      this.database
        .prepare('INSERT INTO events VALUES (?, ?, ?, ?)')
        .run(sessionId, event.sequence, runId, JSON.stringify(event));
      this.save(session);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return event;
  }

  delete(sessionId: string): void {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先停止运行再删除会话。');
    this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
  configure(
    sessionId: string,
    permissionMode: PermissionMode,
    model?: string | null,
    effort?: Effort | null,
  ) {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再修改审批模式。');
    session.permissionMode = permissionMode;
    if (model !== undefined) session.model = model;
    if (effort !== undefined) session.effort = effort;
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return session;
  }
  // Points the session at another project. Once Claude has been told a path, the one it knows is kept until
  // the next message tells it of the move.
  move(sessionId: string, projectPath: string, device?: BoundDevice) {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再更换项目。');
    if (device) assertProjectPath(projectPath, platformOf(device));
    if (
      session.projectPath === projectPath &&
      (!device ||
        (session.device?.id === identityOf(device).id && session.platform === platformOf(device)))
    )
      return session;
    if (session.prompt || this.hasNativeContext(sessionId)) {
      const known = session.movedFrom ?? session.projectPath;
      const platform = session.movedFromPlatform ?? session.platform;
      const changedOwner = device && session.device?.id !== identityOf(device).id;
      session.movedFrom =
        known === projectPath && (!device || platform === platformOf(device)) && !changedOwner
          ? undefined
          : known;
      session.movedFromDevice ??= changedOwner ? session.device?.id : undefined;
      session.movedFromPlatform = session.movedFrom ? platform : undefined;
    }
    session.projectPath = projectPath;
    if (device) {
      session.device = identityOf(device);
      session.platform = platformOf(device);
    }
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return session;
  }
  // A legacy Windows session may claim its first Windows connection; all other changes require `move`.
  assertDevice(sessionId: string, device: DeviceDescriptor) {
    const { session } = this.get(sessionId);
    if (session.device?.id === device.deviceId && session.platform === device.platform) {
      assertProjectPath(session.projectPath, device.platform);
      return;
    }
    if (!session.device && session.platform === 'win32' && device.platform === 'win32') {
      assertProjectPath(session.projectPath, device.platform);
      session.device = identityOf(device);
      this.save(session);
      return;
    }
    throw new DomainError(
      'device_mismatch',
      '会话属于另一台设备。请先更换项目，将会话明确迁移到当前设备后再运行。',
    );
  }
  claim(sessionId: string, device: Device) {
    const { session } = this.get(sessionId);
    if (!session.device) {
      session.device = device;
      this.save(session);
    }
    return session;
  }
  named(device: Device) {
    return this.list().filter((session) => {
      if (session.device?.id !== device.id || session.device.name === device.name) return false;
      session.device = device;
      this.save(session);
      return true;
    });
  }
  // Preparing an input must not consume its reminders: only an SDK receipt confirms they reached Claude.
  notice(
    sessionId: string,
    device?: DeviceDescriptor,
    input?: string,
    activePrompt?: PromptValues,
  ): SessionNotice {
    const { session } = this.get(sessionId);
    // Native slash commands must start the input. They cannot acknowledge environment text they never saw.
    if (input?.startsWith('/')) return { text: '', projectPath: session.projectPath };
    if (session.prompt?.compacted && !activePrompt)
      return { text: '', projectPath: session.projectPath };
    let text = '';
    if (session.movedFrom) {
      const computer =
        session.movedFromDevice && session.movedFromDevice !== session.device?.id
          ? `another of their computers, ${JSON.stringify(session.device?.name)}. From now on the device is that computer: ${platformName(session.platform)}`
          : `the connected ${platformName(session.platform)} computer`;
      text += `[CC Desk Tunnel: the user explicitly moved this session to ${computer}. The project directory is now ${JSON.stringify(session.projectPath)} (it was ${JSON.stringify(session.movedFrom)}). From now on use the new directory as the project cwd, in place of the one given earlier. Files and processes of the earlier computer are not on this one unless you find them here.]\n\n`;
    }
    const said = session.prompt;
    // Compaction only permits a new process to replace its prompt. Follow-ups in the process that
    // compacted still use its original append-system-prompt and need any pending environment correction.
    const known =
      said && (!said.compacted || (activePrompt && !activePrompt.afterCompaction))
        ? knownDevice(said)
        : undefined;
    const changed =
      known &&
      device &&
      (known.platform !== device.platform ||
        known.shell.path !== device.shell.path ||
        ('schedulesPath' in known && known.schedulesPath !== device.schedulesPath));
    if (changed && device) {
      text += `[CC Desk Tunnel: the connected computer now runs ${platformName(device.platform)}. Its ${device.shell.kind === 'powershell' ? 'PowerShell' : 'POSIX shell'} executable is now ${JSON.stringify(device.shell.path)} (it was ${JSON.stringify(known.shell.path)}). Use this shell and its native quoting and path syntax for commands through the SSH alias device. The desktop schedule file is now ${JSON.stringify(device.schedulesPath)}. These values replace the environment instructions given earlier.]\n\n`;
    }
    return {
      text,
      projectPath: session.projectPath,
      movedFrom: session.movedFrom,
      ownerId: session.device?.id,
      ...(changed && device ? { device, knownEnvironment: environment(known) } : {}),
    };
  }
  acknowledgeNotice(sessionId: string, notice: SessionNotice) {
    const { session } = this.get(sessionId);
    let changed = false;
    if (
      notice.movedFrom &&
      session.movedFrom === notice.movedFrom &&
      session.device?.id === notice.ownerId &&
      session.projectPath === notice.projectPath
    ) {
      session.movedFrom = undefined;
      session.movedFromPlatform = undefined;
      session.movedFromDevice = undefined;
      changed = true;
    }
    const said = session.prompt;
    const known = said && knownDevice(said);
    if (said && known && notice.device && environment(known) === notice.knownEnvironment) {
      said.toldDevice = notice.device;
      changed = true;
    }
    if (changed) this.save(session);
  }
  // What the system prompt of a run says, given the device of the connection it runs on. A prompt
  // that changes costs the whole conversation's prompt cache, so it stays what it first was — through moves
  // and reconnects, which `notice` tells Claude of — until a compaction, which rewrites everything after
  // the prompt anyway; the run after that says what is current.
  promptValues(sessionId: string, device: DeviceDescriptor): PromptValues {
    const { session } = this.get(sessionId);
    const said = session.prompt;
    if (said && !said.compacted) {
      if (said.format === 'environment')
        return {
          projectPath: said.projectPath,
          device: said.device ?? device,
          legacyEnvironment: true,
        };
      if (said.device) return { projectPath: said.projectPath, device: said.device };
      if (said.powershellPath)
        return { projectPath: said.projectPath, device, legacyPowershellPath: said.powershellPath };
      return { projectPath: said.projectPath, device };
    }
    return {
      projectPath: session.projectPath,
      device,
      ...(device.platform === 'win32' ? { legacyEnvironment: true as const } : {}),
      ...(said?.compacted ? { afterCompaction: true as const } : {}),
    };
  }
  acknowledgePrompt(sessionId: string, values: PromptValues) {
    const { session } = this.get(sessionId);
    if (
      session.prompt &&
      (!session.prompt.compacted || !values.afterCompaction) &&
      (session.prompt.device || session.prompt.powershellPath || session.prompt.format)
    )
      return;
    session.prompt = {
      projectPath: values.projectPath,
      device: values.device,
      ...(values.legacyEnvironment ? { format: 'environment' as const } : {}),
    };
    this.save(session);
  }
  compacted(sessionId: string) {
    const { session } = this.get(sessionId);
    if (!session.prompt || session.prompt.compacted) return;
    session.prompt.compacted = true;
    this.save(session);
  }
  rename(sessionId: string, title: string) {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再改名。');
    session.title = title;
    session.autoTitle = false;
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return session;
  }
  renameNative(sessionId: string, title: string) {
    const { session } = this.get(sessionId);
    session.title = title;
    this.save(session);
    return session;
  }
  private save(session: Session) {
    this.database
      .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(session), session.id);
  }
  close() {
    this.database.close();
  }
}
