import { builtinModules, createRequire } from 'node:module';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build as viteBuild } from 'vite';

// ssh2's native crypto and CPU detection are optional optimizations. Ship the supported JS fallback so
// no host-Node ABI or host-architecture addon can accidentally enter either Electron package.
function copyRuntimeDependencies(root, app, name, copied = new Set()) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = dirname(createRequire(join(root, 'package.json')).resolve(`${name}/package.json`));
  const destination = join(app, 'node_modules', name);
  cpSync(source, destination, {
    recursive: true,
    filter: (path) =>
      !/(?:^|[\\/])(?:node_modules|test|tests|examples|build)(?:[\\/]|$)/.test(
        path.slice(source.length),
      ) && !path.endsWith('.node'),
  });
  const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  delete manifest.optionalDependencies;
  delete manifest.scripts;
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyRuntimeDependencies(root, app, dependency, copied);
}

export async function stageDesktop(root, app, { platform, unsigned = false } = {}) {
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  await viteBuild({
    root: join(root, 'apps/desktop'),
    build: { outDir: join(app, 'dist'), emptyOutDir: true },
  });
  await viteBuild({
    configFile: false,
    root,
    ssr: { noExternal: true },
    build: {
      ssr: true,
      target: 'node24',
      outDir: join(app, 'electron'),
      emptyOutDir: true,
      rolldownOptions: {
        input: join(root, 'apps/desktop/electron/proxy-bridge.mjs'),
        external: [
          ...builtinModules,
          ...builtinModules.map((name) => `node:${name}`),
          'ssh2',
          'bufferutil',
          'utf-8-validate',
        ],
        output: { format: 'es', entryFileNames: 'proxy-bridge.mjs', codeSplitting: false },
      },
    },
  });
  // Forked workers resolve sibling modules at runtime, outside Vite's static bridge dependency graph.
  const runtimeModules = readdirSync(join(root, 'apps/desktop/electron')).filter(
    (file) => file.endsWith('.cjs') || (file.endsWith('.mjs') && file !== 'proxy-bridge.mjs'),
  );
  const resources = platform === 'win32' ? ['prepare-ssh.ps1', 'component-host.ps1'] : [];
  for (const file of [...runtimeModules, 'icon.png', ...resources])
    cpSync(join(root, 'apps/desktop/electron', file), join(app, 'electron', file));
  const desktop = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'cc-desk-tunnel',
        productName: 'CC Desk Tunnel',
        version: desktop.version,
        description: 'Desktop client for a native remote Claude Code session',
        author: 'CC Desk Tunnel contributors',
        private: true,
        main: 'electron/main.cjs',
        type: 'module',
        ...(platform === 'darwin' ? { macUnsigned: unsigned } : {}),
        dependencies: { ssh2: desktop.dependencies.ssh2 },
      },
      null,
      2,
    ) + '\n',
  );
  copyRuntimeDependencies(root, app, 'ssh2');
}
