import type { DeviceInfo } from './platform.ts';
import type { Device, Session } from '@cc-desk-tunnel/protocol';

// Which of the user's computers this is to the service. The desktop keeps the identity with its settings; a
// browser, which only ever meets the simulation service, keeps one of its own.
export async function thisDevice(
  info?: DeviceInfo | null,
): Promise<Device & Partial<Pick<DeviceInfo, 'platform' | 'arch'>>> {
  if (window.desktop) {
    info ??= await window.desktop.deviceInfo();
    return {
      id: info.deviceId,
      name: info.name ?? (window.desktop.platform === 'darwin' ? 'macOS desktop' : 'Desktop'),
      platform: info.platform,
      arch: info.arch,
    };
  }
  const id = localStorage.getItem('proxy-device') ?? crypto.randomUUID();
  localStorage.setItem('proxy-device', id);
  return { id, name: '浏览器' };
}
// A session is on this computer when its project directory is; one from before computers were told apart
// is on whichever uses it first.
export function isHere(session: Session, device: Device | null) {
  return !session.device || session.device.id === device?.id;
}
