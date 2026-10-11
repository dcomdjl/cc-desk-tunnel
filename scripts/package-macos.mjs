import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as electronBuild, Platform, Arch } from 'electron-builder';
import { notarize } from '@electron/notarize';
import { stageDesktop } from './package-desktop.mjs';
import { assertSameSource, sourceRevision } from './release-assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const allowed = ['--dir', '--unsigned', '--arm64', '--x64'];
if (
  args.some((arg) => !allowed.includes(arg)) ||
  (args.includes('--arm64') && args.includes('--x64'))
)
  throw new Error('Usage: npm run package:macos -- [--arm64|--x64] [--dir] [--unsigned]');
if (process.platform !== 'darwin') throw new Error('Build the macOS package on macOS.');
const architecture = args.includes('--arm64')
  ? 'arm64'
  : args.includes('--x64')
    ? 'x64'
    : process.arch;
if (!['arm64', 'x64'].includes(architecture))
  throw new Error('macOS packages support arm64 and x64.');
const unsigned = args.includes('--unsigned');
const unpacked = args.includes('--dir');
const app = join(root, `.local/macos-package/${architecture}/app`);
const output = join(root, 'artifacts/macos');
const appBundle = join(
  output,
  architecture === 'arm64' ? 'mac-arm64' : 'mac',
  'CC Desk Tunnel.app',
);
const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'));
const source = sourceRevision(root);

function notarizationOptions() {
  const env = process.env;
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
    return {
      appleId: env.APPLE_ID,
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID,
    };
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
    return {
      appleApiKey: env.APPLE_API_KEY,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      appleApiIssuer: env.APPLE_API_ISSUER,
    };
  if (env.APPLE_KEYCHAIN_PROFILE)
    return {
      keychainProfile: env.APPLE_KEYCHAIN_PROFILE,
      ...(env.APPLE_KEYCHAIN ? { keychain: env.APPLE_KEYCHAIN } : {}),
    };
  throw new Error(
    '正式 macOS 构建需要 Apple 公证凭据（APPLE_KEYCHAIN_PROFILE、完整 APPLE_ID 配置或完整 APPLE_API_KEY 配置）；本机内测请显式传 --unsigned。',
  );
}
const credentials = unsigned ? undefined : notarizationOptions();
if (unsigned) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await stageDesktop(root, app, { platform: 'darwin', unsigned });
// macOS icon conversion requires a 512px source; preserve the existing artwork in the staging area.
const icon = join(app, 'macos-icon.png');
execFileSync(
  'sips',
  ['-z', '1024', '1024', join(root, 'apps/desktop/electron/icon.png'), '--out', icon],
  { stdio: 'ignore' },
);
const results = await electronBuild({
  targets: Platform.MAC.createTarget(unpacked ? 'dir' : ['dmg', 'zip'], Arch[architecture]),
  publish: 'never',
  config: {
    appId: 'io.github.ccdesktunnel.desktop',
    productName: 'CC Desk Tunnel',
    electronVersion: electron.version,
    // A locally installed Electron can only be reused for its native architecture.
    ...(architecture === process.arch &&
    existsSync(join(root, 'node_modules/electron/dist/Electron.app'))
      ? { electronDist: join(root, 'node_modules/electron/dist') }
      : {}),
    directories: { app, output, buildResources: join(root, 'apps/desktop/electron') },
    npmRebuild: false,
    forceCodeSigning: !unsigned,
    asar: true,
    files: ['package.json', 'electron/**', 'dist/**', 'node_modules/**'],
    mac: {
      category: 'public.app-category.developer-tools',
      minimumSystemVersion: '13.0',
      icon,
      artifactName: 'CC-Desk-Tunnel-${version}-darwin-${arch}.${ext}',
      identity: unsigned ? null : process.env.CSC_NAME,
      hardenedRuntime: !unsigned,
      notarize: !unsigned,
      entitlements: join(root, 'scripts/entitlements.macos.plist'),
      entitlementsInherit: join(root, 'scripts/entitlements.macos.plist'),
      extendInfo: {
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        NSDesktopFolderUsageDescription: '访问你选择的桌面项目，让开发工具读取和修改项目文件。',
        NSDocumentsFolderUsageDescription: '访问你选择的文稿项目，让开发工具读取和修改项目文件。',
        NSDownloadsFolderUsageDescription: '访问你选择的下载项目，让开发工具读取和修改项目文件。',
        NSRemovableVolumesUsageDescription:
          '访问你选择的外接磁盘项目，让开发工具读取和修改项目文件。',
        NSNetworkVolumesUsageDescription:
          '访问你选择的网络磁盘项目，让开发工具读取和修改项目文件。',
      },
    },
    dmg: { sign: !unsigned },
  },
});
if (!unsigned) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'inherit' });
  // codesign writes its detail to stderr; inspect the actual authority and hardened runtime flag.
  const { spawnSync } = await import('node:child_process');
  const signature = spawnSync('codesign', ['--display', '--verbose=4', appBundle], {
    encoding: 'utf8',
  });
  if (
    signature.status !== 0 ||
    !/Authority=Developer ID Application:/.test(signature.stderr) ||
    !/flags=.*runtime/.test(signature.stderr)
  )
    throw new Error('正式构建必须具有 Developer ID Application 签名和 Hardened Runtime。');
  execFileSync('xcrun', ['stapler', 'validate', appBundle], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose', appBundle], {
    stdio: 'inherit',
  });
  for (const artifact of results.filter((path) => path.endsWith('.dmg'))) {
    await notarize({ appPath: artifact, ...credentials });
    execFileSync('xcrun', ['stapler', 'validate', artifact], { stdio: 'inherit' });
    execFileSync(
      'spctl',
      [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose',
        artifact,
      ],
      { stdio: 'inherit' },
    );
  }
}
// Native-architecture packages must launch offline before they are usable as release assets.
if (architecture === process.arch)
  execFileSync(process.execPath, [join(root, 'scripts/smoke-macos-package.mjs'), appBundle], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NATIVE_TEST_CONFIG: '' },
  });
const files = results
  .filter((path) => /\.(zip|dmg)$/.test(path))
  .map((path) => ({
    name: path.split('/').at(-1),
    size: statSync(path).size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    platform: 'darwin',
    arch: architecture,
    format: path.endsWith('.zip') ? 'zip' : 'dmg',
  }));
assertSameSource(root, source);
writeFileSync(
  join(output, `macos-${architecture}.json`),
  JSON.stringify(
    {
      version,
      ...source,
      platform: 'darwin',
      arch: architecture,
      signed: !unsigned,
      notarized: !unsigned,
      smokeTested: architecture === process.arch,
      files,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `macOS ${unsigned ? 'unsigned internal test' : 'signed and notarized'} package: ${results.join(', ') || appBundle}`,
);
console.log(`Bundle: ${appBundle}`);
