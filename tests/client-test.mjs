/**
 * 客户端插件自测：不启动 DSH，用假的 react/ctx 驱动 client.js，
 * 验证「桥接收到 push → 组件挂载 → 调 insertText」这条链路。
 *   node tests/client-test.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../index.js';

const source = await readFile(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');

// ---------- 假 DOM / 全局 ----------
const windowStub = { __DSH_UI_PICKER_PORT__: 17858 };
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
};
globalThis.window = windowStub;
globalThis.document = documentStub;

// ---------- 极简 hooks 运行时 ----------
let hookIndex = 0;
const hookSlots = [];
function resetHooks() {
  hookIndex = 0;
}
const reactStub = {
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [hookSlots[index], (next) => { hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next; }];
  },
  useEffect(effect) {
    hookIndex++;
    effect();
  },
  useRef(initial) {
    const index = hookIndex++;
    if (!(index in hookSlots)) hookSlots[index] = { current: initial };
    return hookSlots[index];
  },
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length ? children : undefined } };
  },
};

// ---------- 捕获客户端模块 ----------
let registered = null;
windowStub.__ModuleLoader__ = {
  load({ id, factory }) {
    registered = { id, exports: factory((name) => (name === 'react' ? reactStub : undefined)) };
  },
};

new Function('window', 'document', 'console', source)(windowStub, documentStub, console);
if (!registered) throw new Error('client.js did not register a module');
console.log('module id:', registered.id, '| exports:', Object.keys(registered.exports).join(', '));

// ---------- 假 ctx ----------
let slotOptions = null;
let slotComponent = null;
let inserted = [];
const fakeInput = {
  actions: {
    captureInsertion: () => ({ draftRev: 1 }),
    insertText: (text) => {
      inserted.push(text);
      return true;
    },
  },
  setDraft: (text) => {
    inserted.push(text);
  },
  state: { getSnapshot: () => ({ draft: '' }) },
};

const ctx = {
  slots: {
    inject(name, fn) { fn(); },
    register(options, component) {
      slotOptions = options;
      slotComponent = component;
      return () => {};
    },
  },
  sessions: { scope: () => ({ get: () => ({ input: { for: () => fakeInput } }) }) },
  get: () => undefined,
  on: () => () => {},
};

registered.exports.apply(ctx);

if (!slotOptions) throw new Error('slot not registered');
console.log('slot:', slotOptions.name, '| id:', slotOptions.id, '| order:', slotOptions.order);

// ---------- 模拟挂载 ----------
const props = slotOptions.inject('session-1');
console.log('injected props:', Object.keys(props));
resetHooks();
const tree = slotComponent(props);
if (tree !== null) throw new Error('dock 组件应返回 null（零视觉），实际返回: ' + JSON.stringify(tree));
console.log('component rendered: null (零视觉) OK');

// ---------- 桥接推送 ----------
const bridge = await startBridge({ port: 17858 });
await new Promise((resolve) => setTimeout(resolve, 400));
const payload = '【UI 控件定位】\n元素: <button id="submit-order">';
const response = await fetch('http://127.0.0.1:17858/push', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: payload }),
});
console.log('push status:', response.status);

const deadline = Date.now() + 5000;
while (inserted.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

await bridge.close();

if (inserted.length === 0) {
  console.error('[X] insertText 未被调用');
  process.exit(1);
}
console.log('insertText called with:', JSON.stringify(inserted[0].slice(0, 40)) + '…');
if (inserted[0] !== payload) {
  console.error('[X] 插入内容与推送不一致');
  process.exit(1);
}
console.log('CLIENT TEST OK');
process.exit(0);
