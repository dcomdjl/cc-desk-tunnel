export const platform = () =>
  typeof window !== 'undefined' && window.desktop ? window.desktop.platform : 'browser';
export const isMac = () => platform() === 'darwin';
export type DeviceInfo = {
  deviceId: string;
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  name?: string;
};
export type ProjectIdentity = { path: string; canonical: string; key: string };
export function belongsToDevice(
  session: { device?: { id: string }; platform: DeviceInfo['platform'] },
  device: DeviceInfo | null,
) {
  if (!device || session.platform !== device.platform) return false;
  return session.device ? session.device.id === device.deviceId : device.platform === 'win32';
}
export type ProjectAccessFailure = {
  ok: false;
  code: string;
  stage: string;
  message: string;
  source?: 'filesystem' | 'sftp' | 'ssh' | 'tool';
  systemCode?: string | number;
  exitCode?: number;
  path?: string;
  projectOk?: boolean;
  cleanup?: ProjectAccessFailure;
};
export type ProjectAccess =
  { ok: true; path: string; identity: ProjectIdentity; targetPath?: string } | ProjectAccessFailure;
