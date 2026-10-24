/**
 * 桥接服务的独立自测（不依赖 DSH 宿主）：
 *   node tests/bridge-test.mjs
 */
import { startBridge } from '../index.js';

const port = 17899;
const bridge = await startBridge({ port, log: (m) => console.log('  [log]', m) });
console.log('bridge up on', bridge.port);

const pushRes = await fetch(`http://127.0.0.1:${port}/push`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '【UI 控件定位】\n元素: <button id="x">', meta: { from: 'test' } }),
});
console.log('push ->', pushRes.status, await pushRes.json());

const pollRes = await fetch(`http://127.0.0.1:${port}/poll?since=0`);
const polled = await pollRes.json();
console.log('poll ->', JSON.stringify(polled).slice(0, 200));

const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
console.log('health ->', health);

const picker = await fetch(`http://127.0.0.1:${port}/picker.js`);
const text = await picker.text();
console.log('picker.js ->', picker.status, text.length, 'bytes');

const empty = await (await fetch(`http://127.0.0.1:${port}/poll?since=999`)).json();
console.log('poll(since=999) ->', JSON.stringify(empty));

const bad = await fetch(`http://127.0.0.1:${port}/push`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"text":"   "}',
});
console.log('empty push ->', bad.status);

await bridge.close();
console.log('closed');

// 长轮询测试：先挂起，再 push
const bridge2 = await startBridge({ port: port + 1 });
const started = Date.now();
const longPoll = fetch(`http://127.0.0.1:${port + 1}/poll?since=0`).then((r) => r.json());
setTimeout(async () => {
  await fetch(`http://127.0.0.1:${port + 1}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"text":"late"}',
  });
}, 300);
const result = await longPoll;
console.log('long-poll ->', JSON.stringify(result), `after ${Date.now() - started}ms`);
await bridge2.close();
console.log('ALL OK');
