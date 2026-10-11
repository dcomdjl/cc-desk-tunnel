import type { ProjectIdentity } from './platform.ts';

const windowsPath = (path: string) => /^[a-z]:[\\/]|^\\\\/i.test(path);
export const lexicalPathKey = (path: string) =>
  windowsPath(path)
    ? path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    : path.replace(/\/+$/, '') || '/';
const identities = new Map<string, string>();
const canonicalPaths = new Map<string, string>();
export function registerPathIdentities(values: ProjectIdentity[]) {
  for (const value of values) {
    identities.set(lexicalPathKey(value.path), value.key);
    identities.set(lexicalPathKey(value.canonical), value.key);
    canonicalPaths.set(lexicalPathKey(value.path), lexicalPathKey(value.canonical));
  }
}
export const pathKey = (path: string) =>
  identities.get(lexicalPathKey(path)) ?? lexicalPathKey(path);
export const folderName = (path: string) =>
  path
    .replace(windowsPath(path) ? /[\\/]+$/ : /\/+$/, '')
    .split(windowsPath(path) ? /[\\/]/ : /\//)
    .at(-1) || path;
// Whether a path lies under one of the folders that hold the sessions without a project.
export const isInside = (path: string, roots: string[]) =>
  roots.some((root) => {
    const target = canonicalPaths.get(lexicalPathKey(path)) ?? lexicalPathKey(path);
    const base = canonicalPaths.get(lexicalPathKey(root)) ?? lexicalPathKey(root);
    return target.startsWith(`${base.replace(/\/+$/, '')}${windowsPath(root) ? '\\' : '/'}`);
  });
// Dotted numeric versions, e.g. 0.10.1 is newer than 0.9.0.
export function isNewer(candidate: string, current: string) {
  const [a, b] = [candidate, current].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++)
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}
// How long ago, in the fewest words that still tell recent from old.
export function ago(time: number) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时`;
  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / 60 / 24)} 天`;
  return new Date(time).toLocaleDateString('zh-CN');
}
export const withProject = (projects: string[], path: string) =>
  projects.some((item) => pathKey(item) === pathKey(path)) ? projects : [...projects, path];
