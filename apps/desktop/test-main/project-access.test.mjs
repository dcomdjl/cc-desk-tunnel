import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessFailure, accessGuidance, toolAccessIssue } from '../electron/project-access.mjs';

test('filesystem classification preserves errno at every access stage without inventing privacy denial', () => {
  const causes = {
    EACCES: 'permission_denied',
    EPERM: 'operation_not_permitted',
    EROFS: 'read_only',
    ENOSPC: 'no_space',
    EDQUOT: 'quota_exceeded',
    ENOENT: 'not_found',
    ENOTDIR: 'not_directory',
  };
  for (const stage of ['path', 'exec', 'sftp', 'write', 'cleanup', 'target'])
    for (const [systemCode, code] of Object.entries(causes)) {
      const result = accessFailure({ code: systemCode }, stage, { path: '/project' });
      assert.equal(result.code, code);
      assert.equal(result.stage, stage);
      assert.equal(result.systemCode, systemCode);
      assert.equal(result.path, '/project');
      assert.equal(result.source, 'filesystem');
      assert.doesNotMatch(result.message, /完整磁盘访问/);
    }
});

test('SFTP generic and transport errors do not become filesystem or privacy errors', () => {
  assert.equal(accessFailure({ code: 3 }, 'write', { source: 'sftp' }).code, 'permission_denied');
  assert.equal(accessFailure({ code: 4 }, 'write', { source: 'sftp' }).code, 'write_failed');
  assert.equal(accessFailure({ code: 'EACCES' }, 'connect', { source: 'ssh' }).code, 'exec_failed');
});

test('macOS guidance is conditional on denied access and protected location', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const result = accessFailure({ code }, 'write');
    for (const path of [
      '/Users/test/Desktop/project',
      '/Users/test/Documents/project',
      '/Users/test/Downloads/project',
      '/Volumes/disk/project',
    ]) {
      assert.equal(accessGuidance(result, 'darwin', path).privacy, true);
      assert.match(accessGuidance(result, 'darwin', path).privacyText, /无法确认/);
    }
    assert.equal(accessGuidance(result, 'darwin', '/Users/test/Dev/project').privacy, false);
    assert.equal(accessGuidance(result, 'linux', '/Users/test/Documents/project').privacy, false);
  }
  for (const code of ['EROFS', 'ENOSPC', 'EDQUOT'])
    assert.equal(
      accessGuidance(accessFailure({ code }, 'write'), 'darwin', '/Volumes/disk/project').privacy,
      false,
    );
});

test('only failed filesystem tools offer diagnosis and structured inputs identify targets', () => {
  const tool = {
    state: 'failed',
    name: 'Edit',
    input: JSON.stringify({ file_path: '/project/existing.txt' }),
    output: 'EACCES: permission denied',
  };
  assert.equal(toolAccessIssue(tool).targetPath, '/project/existing.txt');
  assert.equal(toolAccessIssue(tool).code, 'permission_denied');
  assert.equal(toolAccessIssue({ ...tool, name: 'Read' }).targetOperation, 'read');
  for (const state of ['completed', 'denied', 'cancelled', 'running'])
    assert.equal(toolAccessIssue({ ...tool, state }), null);
  assert.equal(toolAccessIssue({ ...tool, name: 'WebFetch' }), null);
  assert.equal(toolAccessIssue({ ...tool, name: 'Bash', output: 'HTTP 403 Forbidden' }), null);
  assert.equal(
    toolAccessIssue({ ...tool, name: 'Bash', output: 'Read-only file system' }).code,
    'read_only',
  );
  assert.equal(toolAccessIssue({ ...tool, name: 'Bash' }).targetPath, undefined);
  assert.equal(toolAccessIssue({ ...tool, input: '{' }).targetPath, undefined);
  assert.equal(
    toolAccessIssue({ ...tool, output: 'The requested string was not found' }).code,
    'target_failed',
  );
  const filesystem = accessFailure({ code: 'EIO' }, 'path');
  assert.equal(filesystem.code, 'path_failed');
  assert.equal(filesystem.systemCode, 'EIO');
  assert.equal(filesystem.source, 'filesystem');
});
