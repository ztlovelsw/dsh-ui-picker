/**
 * 生成油猴脚本 dsh-ui-picker.user.js：油猴头 + picker.js 全文。
 *
 * picker.js 是唯一实现，油猴版必须是它的机械副本（否则两边会走偏）。
 * 脚本头从现有 user.js 里原样保留，只同步 @version 与包的 version。
 *
 *   node scripts/sync-userscript.mjs          # 写入
 *   node scripts/sync-userscript.mjs --check  # 只检查是否同步（CI / npm test 用）
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PICKER = `${ROOT}picker.js`;
const USER = `${ROOT}dsh-ui-picker.user.js`;
const PKG = `${ROOT}package.json`;

const BODY_START = '(function () {';

const pickerSource = await readFile(PICKER, 'utf8');
const userSource = await readFile(USER, 'utf8');
const pkg = JSON.parse(await readFile(PKG, 'utf8'));

const pickerBodyAt = pickerSource.indexOf(BODY_START);
if (pickerBodyAt < 0) throw new Error('picker.js 里找不到 `(function () {`');
const userBodyAt = userSource.indexOf(BODY_START);
if (userBodyAt < 0) throw new Error('user.js 里找不到 `(function () {' );

let header = userSource.slice(0, userBodyAt);
header = header.replace(/^\/\/ @version\s+.*$/m, `// @version      ${pkg.version}`);
const next = header + pickerSource.slice(pickerBodyAt);

if (process.argv.includes('--check')) {
  if (next !== userSource) {
    console.error('[sync-userscript] user.js 与 picker.js 不一致，跑一次 node scripts/sync-userscript.mjs');
    process.exit(1);
  }
  console.log('[sync-userscript] 已同步');
} else {
  await writeFile(USER, next, 'utf8');
  console.log(`[sync-userscript] 写入 dsh-ui-picker.user.js（v${pkg.version}，${next.length} 字符）`);
}
