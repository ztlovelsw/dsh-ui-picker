/**
 * 注释胶囊用例的本地服务：桥接在 17901，静态文件在 17902。
 *   node tests/chip-bridge.mjs
 * 然后打开 http://127.0.0.1:17902/tests/client-chip.html
 *
 * 静态服务只为用例存在（浏览器 file:// 下 fetch 不到 client.js），
 * 只读仓库目录、只监听回环地址。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE_PORT = 17901;
const STATIC_PORT = 17902;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const bridge = await startBridge({ port: BRIDGE_PORT, log: (m) => console.log('[bridge]', m) });
console.log(`[chip-bridge] bridge  http://127.0.0.1:${BRIDGE_PORT}`);

const staticServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${STATIC_PORT}`);
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const target = join(ROOT, rel || 'tests/client-chip.html');
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

await new Promise((resolve) => staticServer.listen(STATIC_PORT, '127.0.0.1', resolve));
console.log(`[chip-bridge] static http://127.0.0.1:${STATIC_PORT}/tests/client-chip.html`);

const shutdown = async () => {
  await bridge.close();
  staticServer.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
