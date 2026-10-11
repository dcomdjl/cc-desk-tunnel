import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type ClientPlatform = 'win32' | 'darwin' | 'linux';
export type ClientArch = 'x64' | 'arm64';
export type ClientAsset = {
  version: string;
  platform: ClientPlatform;
  arch: ClientArch;
  format: 'exe' | 'zip' | 'dmg' | 'AppImage';
};
export type ClientRelease = ClientAsset & { size: number; sha256: string; path: string };

// The Windows filename stays compatible with existing releases and clients.
export function clientAsset(name: string): ClientAsset | undefined {
  const windows = /^CC-Desk-Tunnel-Setup-(\d+\.\d+\.\d+)-(x64|arm64)\.exe$/.exec(name);
  if (windows)
    return {
      version: windows[1],
      platform: 'win32',
      arch: windows[2] as ClientArch,
      format: 'exe',
    };
  const portable =
    /^CC-Desk-Tunnel-(\d+\.\d+\.\d+)-(darwin|linux)-(x64|arm64)\.(zip|dmg|AppImage)$/.exec(name);
  if (
    !portable ||
    (portable[2] === 'darwin' ? portable[4] === 'AppImage' : portable[4] !== 'AppImage')
  )
    return undefined;
  return {
    version: portable[1],
    platform: portable[2] as ClientPlatform,
    arch: portable[3] as ClientArch,
    format: portable[4] as ClientAsset['format'],
  };
}

const KEPT = 3;
const compare = (a: string, b: string) => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
};

// Each platform, architecture and format owns its retention history. Mac ZIP updates and manual DMGs
// therefore cannot evict each other or a Windows installer.
export class ClientReleases {
  private directory: string;
  private releases = new Map<string, ClientRelease>();
  private keys = new Map<string, string>();
  private pending: Promise<void> | undefined;
  constructor(directory: string) {
    this.directory = directory;
  }
  get current() {
    return this.select('win32', 'x64');
  }
  select(platform: ClientPlatform = 'win32', arch: ClientArch = 'x64'): ClientRelease | null {
    const formats =
      platform === 'darwin' ? ['zip', 'dmg'] : platform === 'win32' ? ['exe'] : ['AppImage'];
    // Only offer a ZIP of the latest version; an older ZIP must not mask a newer manual DMG.
    return (
      formats
        .map((format) => this.releases.get(`${platform}:${arch}:${format}`))
        .filter((release): release is ClientRelease => !!release)
        .sort((a, b) => compare(a.version, b.version))[0] ?? null
    );
  }
  refresh() {
    this.pending ??= this.scan().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async scan() {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      names = [];
    }
    const groups = new Map<string, { name: string; asset: ClientAsset }[]>();
    for (const name of names) {
      const asset = clientAsset(name);
      if (!asset) continue;
      try {
        const stat = lstatSync(join(this.directory, name));
        if (!stat.isFile() || !stat.size) continue;
      } catch {
        continue;
      }
      const key = `${asset.platform}:${asset.arch}:${asset.format}`;
      const group = groups.get(key) ?? [];
      group.push({ name, asset });
      groups.set(key, group);
    }
    const selected = new Map<string, ClientRelease>();
    for (const [key, group] of groups) {
      group.sort((a, b) => compare(a.asset.version, b.asset.version));
      for (const old of group.slice(KEPT)) {
        try {
          rmSync(join(this.directory, old.name), { force: true });
        } catch {
          // An administrator may replace or protect an old asset during the scan. Keep serving updates.
        }
      }
      const newest = group[0];
      const path = join(this.directory, newest.name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || !stat.size) continue;
        const prior = this.releases.get(key);
        const cacheKey = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (prior && this.keys.get(key) === cacheKey) selected.set(key, prior);
        else {
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(path)) hash.update(chunk);
          selected.set(key, { ...newest.asset, size: stat.size, sha256: hash.digest('hex'), path });
          this.keys.set(key, cacheKey);
        }
      } catch {
        this.keys.delete(key);
      }
    }
    this.releases = selected;
    for (const key of this.keys.keys()) if (!selected.has(key)) this.keys.delete(key);
  }
}
