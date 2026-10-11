const messages = {
  invalid_path: '项目目录必须是本机绝对路径，且不能含换行或空字符。',
  not_found: '路径不存在，请检查项目或目标文件是否已移动。',
  not_directory: '路径中的项目或父级不是目录，请检查路径。',
  permission_denied: '访问被拒绝，请检查文件、目录及父目录的读写和访问权限。',
  operation_not_permitted: '系统不允许此操作，请检查访问授权、ACL 和文件锁定状态。',
  read_only: '文件系统为只读，请检查磁盘或挂载状态。',
  no_space: '磁盘可用空间不足，请释放空间后重新检测。',
  quota_exceeded: '存储配额已用尽，请检查磁盘或账号配额。',
  exec_failed: '无法通过执行通道访问项目，请检查连接和本机执行环境。',
  path_failed: '项目路径检测失败，未能确定原因，请检查路径和文件系统状态。',
  sftp_failed: '文件通道检测失败，未能确定原因，请检查连接及文件通道。',
  write_failed: '创建或写入检测失败，未能确定原因，请检查工具输出和磁盘状态。',
  cleanup_failed: '测试文件清理失败，请检查权限并清理检测目录。',
  target_failed: '目标文件访问检测失败，请检查具体文件及父目录。',
  timeout: '项目访问检测超时，请重新连接后再试。',
  cancelled: '项目访问检测已取消。',
  offline: '执行端未连接，请先连接服务再重新检测。',
};
const systemCodes = {
  EACCES: 'permission_denied',
  EPERM: 'operation_not_permitted',
  EROFS: 'read_only',
  ENOSPC: 'no_space',
  EDQUOT: 'quota_exceeded',
  ENOENT: 'not_found',
  ENOTDIR: 'not_directory',
};

// SFTP v3's generic Failure does not identify a filesystem cause. Never infer
// privacy denial or a read-only disk from it, or from an SSH transport error.
export function accessFailure(error, stage, { source = 'filesystem', path } = {}) {
  const systemCode = error?.code;
  const fallback = {
    connect: 'exec_failed',
    path: 'path_failed',
    exec: source === 'filesystem' ? 'path_failed' : 'exec_failed',
    sftp: 'sftp_failed',
    write: 'write_failed',
    cleanup: 'cleanup_failed',
    target: 'target_failed',
  }[stage];
  const code =
    source === 'sftp'
      ? ({ 2: 'not_found', 3: 'permission_denied' }[systemCode] ?? fallback)
      : source === 'ssh'
        ? fallback
        : (systemCodes[systemCode] ?? fallback);
  return {
    ok: false,
    code,
    stage,
    message: messages[code],
    source,
    ...(typeof systemCode === 'string' || typeof systemCode === 'number' ? { systemCode } : {}),
    ...(path ? { path } : {}),
  };
}

export function accessStatus(code, stage, path) {
  return { ok: false, code, stage, message: messages[code], ...(path ? { path } : {}) };
}

function reportedError(output) {
  for (const [systemCode, code] of Object.entries(systemCodes))
    if (new RegExp(`\\b${systemCode}\\b`).test(output)) return { code, systemCode };
  const code = /permission denied|access (?:is )?denied|权限不足|拒绝访问/i.test(output)
    ? 'permission_denied'
    : /operation not permitted/i.test(output)
      ? 'operation_not_permitted'
      : /read[- ]only file system/i.test(output)
        ? 'read_only'
        : /no space left on device/i.test(output)
          ? 'no_space'
          : /disk quota exceeded/i.test(output)
            ? 'quota_exceeded'
            : /no such file or directory/i.test(output)
              ? 'not_found'
              : /not a directory/i.test(output)
                ? 'not_directory'
                : undefined;
  return { code };
}

export function execAccessFailure(output, exitCode, path) {
  const { code, systemCode } = reportedError(output);
  return {
    ...accessStatus(
      code ?? { 44: 'not_found', 45: 'not_directory' }[exitCode] ?? 'exec_failed',
      'exec',
      path,
    ),
    source: 'ssh',
    exitCode,
    ...(systemCode ? { systemCode } : {}),
  };
}

export function accessGuidance(result, platform, path) {
  const denied = ['permission_denied', 'operation_not_permitted'].includes(result.code);
  // Location is evidence for a possible TCC issue, not proof of the granted state.
  const protectedPath =
    /^\/Users\/[^/]+\/(Desktop|Documents|Downloads)(\/|$)/.test(path) || /^\/Volumes\//.test(path);
  const privacy = platform === 'darwin' && denied && protectedPath;
  const text = denied
    ? '检查具体文件、父目录的所有者、读写权限、ACL 和锁定状态。'
    : result.code === 'read_only'
      ? '检查磁盘或网络卷是否以只读方式挂载；授权不能改变只读状态。'
      : ['no_space', 'quota_exceeded'].includes(result.code)
        ? '释放存储空间或调整配额后重新检测。'
        : ['exec_failed', 'sftp_failed', 'offline', 'timeout'].includes(result.code)
          ? '检查连接和本机执行环境，恢复连接后重新检测。'
          : '';
  return {
    privacy,
    text,
    ...(privacy
      ? {
          privacyText:
            '此路径可能受 macOS 隐私保护。请在“隐私与安全性 → 文件与文件夹”检查本应用对应授权；仅凭此错误无法确认是否缺少授权。',
        }
      : {}),
  };
}

// Tool output is unstructured evidence. It only offers a user-initiated check;
// it never authorizes a write or establishes the actual local permission state.
export function toolAccessIssue(tool) {
  if (tool.state !== 'failed') return null;
  const fileTool = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read'].includes(tool.name);
  if (!fileTool && !['Bash', 'PowerShell'].includes(tool.name)) return null;
  const output = tool.output ?? '';
  const { code, systemCode } = reportedError(output);
  if (!code && !fileTool) return null;
  let targetPath;
  if (fileTool) {
    try {
      const input = JSON.parse(tool.input);
      const target = input.file_path ?? input.notebook_path;
      if (typeof target === 'string' && target && !/[\0\r\n]/.test(target)) targetPath = target;
    } catch {
      /* Incomplete input cannot identify a file. */
    }
  }
  return {
    ...accessStatus(code ?? 'target_failed', 'target'),
    ...(!code ? { message: '文件工具未成功，访问原因尚未确定。' } : {}),
    source: 'tool',
    targetOperation: tool.name === 'Read' ? 'read' : 'write',
    ...(systemCode ? { systemCode } : {}),
    ...(targetPath ? { targetPath } : {}),
  };
}
