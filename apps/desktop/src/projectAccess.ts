import { accessStatus } from '../electron/project-access.mjs';
import type { ToolAccessIssue } from '../electron/project-access.mjs';
import type { ProjectAccess } from './platform.ts';

export async function checkProjectAccess(
  path: string,
  issue?: ToolAccessIssue,
): Promise<ProjectAccess> {
  try {
    return await window.desktop!.checkProject(
      path,
      issue && {
        targetPath: issue.targetPath,
        targetOperation: issue.targetOperation,
      },
    );
  } catch {
    // IPC/connection failures cannot identify a filesystem permission cause.
    return accessStatus('exec_failed', 'connect', path);
  }
}
