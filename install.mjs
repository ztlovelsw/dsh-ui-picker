/**
 * dsh-ui-picker 安装脚本（跨平台）
 *   node install.mjs                 # 自动探测 profile
 *   node install.mjs --profile desktop
 *   node install.mjs --dry-run
 *   node install.mjs --no-pnpm       # 只复制 + 写配置，不跑 pnpm install
 *
 * 做四件事：复制插件文件 → 备份 package.json → 写入依赖与 bundles → pnpm install
 */
import { copyFile, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const NAME = 'dsh-ui-picker';

/** 需要装进 DSH 插件目录的文件（demo / tests / 文档不装） */
const PLUGIN_FILES = [
  'index.js',
  'client.js',
  'picker.js',
  'dsh-ui-picker.user.js',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'LICENSE',
];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipPnpm = argv.includes('--no-pnpm');
const profileArg = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : null;

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profilesRoot = join(dshHome, 'profiles');

function fail(message) {
  console.error(`\n[X] ${message}\n`);
  process.exit(1);
}

async function pickProfile() {
  const candidates = [];
  if (profileArg) candidates.push(join(profilesRoot, profileArg));
  else if (process.env.DSH_PROFILE) candidates.push(join(profilesRoot, process.env.DSH_PROFILE));
  for (const name of ['desktop', 'web', 'default']) candidates.push(join(profilesRoot, name));
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  if (existsSync(profilesRoot)) {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(profilesRoot, entry.name, 'package.json'))) {
        return join(profilesRoot, entry.name);
      }
    }
  }
  fail(`找不到 DSH profile，检查 ${profilesRoot}，或用 --profile 指定`);
}

const profileDir = await pickProfile();
const targetDir = join(dshHome, 'plugins', NAME);
const pkgPath = join(profileDir, 'package.json');

console.log(`DSH_HOME : ${dshHome}`);
console.log(`profile  : ${profileDir}`);
console.log(`plugin   : ${targetDir}`);
if (dryRun) console.log('(--dry-run: 不写入任何文件)');

// 1. 复制插件文件
if (!dryRun) {
  await mkdir(targetDir, { recursive: true });
  for (const file of PLUGIN_FILES) {
    const source = join(SELF_DIR, file);
    if (!existsSync(source)) continue;
    await copyFile(source, join(targetDir, file));
  }
  const check = await stat(join(targetDir, 'index.js'));
  console.log(`[1/4] 已复制 ${PLUGIN_FILES.length} 个文件（index.js ${check.size} bytes）`);
} else {
  console.log('[1/4] 跳过复制');
}

// 2. 读 package.json + 备份
const raw = await readFile(pkgPath, 'utf8');
const pkg = JSON.parse(raw);
if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(`${pkgPath}.bak-ui-picker-${stamp}`, raw, 'utf8');
  console.log('[2/4] 已备份 package.json');
}

// 3. 写入依赖与 bundles
const rel = `file:../../plugins/${NAME}`;
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies[NAME] = rel;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
const hasBundle = pkg.dsh.profile.bundles.includes(NAME);
if (!hasBundle) pkg.dsh.profile.bundles.push(NAME);

if (!dryRun) {
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}
console.log(`[3/4] 依赖 ${NAME} -> ${rel}${hasBundle ? '（已存在）' : ''}，bundles ${hasBundle ? '已含' : '已追加'}`);

// 4. pnpm install（可选）
if (dryRun || skipPnpm) {
  console.log('[4/4] 跳过 pnpm install');
} else {
  const pnpm = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install'], {
    cwd: profileDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (pnpm.status !== 0) {
    console.warn('\n[!] pnpm install 失败或已取消。插件文件已就位，可手动建立链接：');
    console.warn(`    ${targetDir}  ->  ${join(profileDir, 'node_modules', NAME)}`);
  } else {
    console.log('[4/4] pnpm install 完成');
  }
}

console.log(`
完成。接下来：
  1. 重启 DSH（完全关闭后重新打开）
  2. 在要调试的页面里加一行：
     <script src="http://127.0.0.1:17857/picker.js"></script>
  3. 点页面右下角的取景框按钮，点选控件 → 看 DSH 输入框
  4. 自检桥接：curl http://127.0.0.1:17857/health
`);
