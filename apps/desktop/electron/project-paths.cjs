const path = require('node:path');
const { realpath, stat, lstat, rmdir } = require('node:fs/promises');

// Filesystem identity, rather than guessed volume case rules, makes aliases share one project.
async function projectIdentity(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))
    throw new Error('请选择本机的绝对目录。');
  const canonical = await realpath(directory);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error('不是文件夹。');
  return { path: directory, canonical, key: `fs:${info.dev}:${info.ino}` };
}

async function projectIdentities(directories) {
  if (!Array.isArray(directories) || directories.length > 2000)
    throw new Error('项目目录列表无效。');
  return (
    await Promise.all(directories.map((directory) => projectIdentity(directory).catch(() => null)))
  ).filter(Boolean);
}

async function removeEmptyWorkspace(directory, roots) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return;
  const target = path.resolve(directory);
  const root = roots.find((item) =>
    /^\d{4}-\d{2}-\d{2}[\\/][^\\/]+$/.test(path.relative(item, target)),
  );
  if (!root) return;
  try {
    // Never follow a replaced day directory or workspace symlink outside the managed root.
    const [base, day, leaf] = await Promise.all([
      realpath(root),
      realpath(path.dirname(target)),
      lstat(target),
    ]);
    if (leaf.isSymbolicLink() || path.dirname(day) !== base) return;
    await rmdir(target);
    await rmdir(path.dirname(target)).catch(() => {});
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

module.exports = { projectIdentity, projectIdentities, removeEmptyWorkspace };
