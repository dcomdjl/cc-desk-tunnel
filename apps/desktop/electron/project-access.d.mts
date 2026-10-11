import type { ProjectAccess, ProjectAccessFailure } from '../src/platform.ts';
export function accessFailure(
  error: { code?: string | number },
  stage: string,
  context?: {
    source?: 'filesystem' | 'sftp' | 'ssh';
    path?: string;
  },
): ProjectAccessFailure;
export function accessStatus(code: string, stage: string, path?: string): ProjectAccessFailure;
export function execAccessFailure(
  output: string,
  exitCode: number,
  path: string,
): ProjectAccessFailure;
export function accessGuidance(
  result: ProjectAccessFailure,
  platform: string,
  path: string,
): {
  privacy: boolean;
  text: string;
  privacyText?: string;
};
export type ToolAccessIssue = ProjectAccessFailure & {
  source: 'tool';
  targetPath?: string;
  targetOperation: 'read' | 'write';
};
export function toolAccessIssue(tool: {
  state: string;
  name: string;
  input: string;
  output?: string;
}): ToolAccessIssue | null;
