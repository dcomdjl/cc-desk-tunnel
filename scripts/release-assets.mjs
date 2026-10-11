import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clientAsset } from '../apps/server/src/client-release.ts';

export function sourceRevision(root) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  return { sourceCommit: git('rev-parse', 'HEAD'), sourceClean: !git('status', '--porcelain') };
}

export function assertSameSource(root, source) {
  const current = sourceRevision(root);
  if (current.sourceCommit !== source.sourceCommit || current.sourceClean !== source.sourceClean)
    throw new Error('打包期间源码发生变化，请从同一源码重新构建。');
}

export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: statSync(path).size, sha256: hash.digest('hex') };
}

export async function stageClientAssets(assets, directory) {
  for (const asset of assets) {
    const target = join(directory, asset.name);
    copyFileSync(asset.path, target);
    const digest = await fileDigest(target);
    if (digest.size !== asset.size || digest.sha256 !== asset.sha256)
      throw new Error(`客户端资产 ${asset.name} 在复制期间发生变化，请重新构建并组装。`);
  }
}

// Multiple build machines contribute assets from the same clean commit. Recheck their native-smoke-tested
// packaging receipts against the actual files; macOS also requires signing and notarization.
export async function collectClientAssets(directories, version, commit) {
  if (!/^[0-9a-f]{40,64}$/.test(commit ?? '')) throw new Error('发布资产校验需要明确的源码提交。');
  const files = new Map();
  for (const directory of directories) {
    for (const name of readdirSync(directory).sort()) {
      const asset = clientAsset(name);
      if (!asset || asset.version !== version) continue;
      const path = join(directory, name);
      if (!statSync(path).isFile()) throw new Error(`客户端发布资产不是文件：${name}`);
      const digest = await fileDigest(path);
      if (asset.platform === 'darwin' || asset.platform === 'win32') {
        const receipt = JSON.parse(
          readFileSync(
            join(
              directory,
              `${asset.platform === 'darwin' ? 'macos' : 'windows'}-${asset.arch}.json`,
            ),
            'utf8',
          ),
        );
        const entry = receipt.files?.find((file) => file.name === name);
        if (receipt.sourceCommit !== commit || receipt.sourceClean !== true)
          throw new Error(
            `客户端资产 ${name} 与当前发布源码提交不一致，或包含未提交修改；请重新构建。`,
          );
        if (
          receipt.version !== version ||
          receipt.arch !== asset.arch ||
          receipt.platform !== asset.platform ||
          (asset.platform === 'darwin' &&
            (receipt.signed !== true || receipt.notarized !== true)) ||
          receipt.smokeTested !== true ||
          entry?.size !== digest.size ||
          entry?.sha256 !== digest.sha256
        )
          throw new Error(
            asset.platform === 'darwin'
              ? `macOS 资产 ${name} 没有匹配的签名、公证与本机启动验证记录；--unsigned 产物仅供内测。`
              : `Windows 资产 ${name} 没有匹配的本机启动验证记录。`,
          );
      }
      const previous = files.get(name);
      if (previous && previous.sha256 !== digest.sha256)
        throw new Error(`客户端资产重名且内容不一致：${name}`);
      files.set(name, { name, ...asset, ...digest, path });
    }
  }
  if (!files.size) throw new Error(`没有找到 ${version} 的客户端发布资产。`);
  for (const arch of ['arm64', 'x64']) {
    const mac = [...files.values()].filter(
      (file) => file.platform === 'darwin' && file.arch === arch,
    );
    if (mac.length && !['zip', 'dmg'].every((format) => mac.some((file) => file.format === format)))
      throw new Error(`macOS ${arch} 发布必须同时包含 ZIP 更新包和 DMG 手动安装包。`);
  }
  return [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function assertStableClientAssets(files) {
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
  ])
    if (!files.some((file) => file.platform === platform && file.arch === arch))
      throw new Error(
        `稳定发布缺少 ${platform}/${arch} 客户端资产；协议升级必须保证所有受支持设备可以更新。预发布可通过 --prerelease 提供部分平台。`,
      );
}
