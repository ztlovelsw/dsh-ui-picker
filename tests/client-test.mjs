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
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
  head: { appendChild() {} },
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
// dock 返回的是注释胶囊组件；没有注释时它必须渲染成 null（零视觉、不占空间）
const rendered = tree && typeof tree.type === 'function' ? tree.type(tree.props) : tree;
if (rendered !== null) {
  throw new Error('没有注释时 dock 应渲染 null（零视觉），实际返回: ' + JSON.stringify(rendered));
}
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

// ---------- 页面注释：写成草稿块 + 输入框上方的「N 条注释」胶囊 ----------
let currentDraft = '';
const drafted = [];
fakeInput.setDraft = (text) => {
  currentDraft = text;
  drafted.push(text);
};
fakeInput.state = { getSnapshot: () => ({ draft: currentDraft }) };


// 新桥接的 seq 从 1 重新开始，把游标复位（相当于页面刷新后重新连）
const runtime = windowStub.__DSH_UI_PICKER_RUNTIME__;
runtime.seq = 0;
runtime.deliveredSeq = -1;
const bridge2 = await startBridge({ port: 17858 });
const annoText =
  '【页面批注】共 2 条\n页面：演示页 — http://localhost:5173/\n视口：1280 × 800　页面坐标以文档左上角为原点（不随滚动变化）\n\n' +
  '1. div.card「结算卡片」　页面坐标 (10, 20)　元素内 (22%, 50%)\n   批注：这块太挤了\n' +
  '2. img.hero　页面坐标 (30, 40)\n   批注：（未填写具体描述）\n\n修改需求：';
await fetch('http://127.0.0.1:17858/push', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    text: annoText,
    meta: {
      kind: 'annotations',
      page: { title: '演示页', url: 'http://localhost:5173/', w: 1280, h: 800 },
      annotations: [
        { uid: 'u1', no: 1, tag: 'div', label: 'div.card「结算卡片」', comment: '这块太挤了', x: 10, y: 20, offset: { x: 22, y: 50 } },
        { uid: 'u2', no: 2, tag: 'img', label: 'img.hero', comment: '', x: 30, y: 40 },
      ],
    },
  }),
});

const annoDeadline = Date.now() + 5000;
while (drafted.length === 0 && Date.now() < annoDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
await bridge2.close();

if (drafted.length === 0) {
  console.error('[X] 注释没有被写进草稿');
  process.exit(1);
}
console.log('drafted block:', JSON.stringify(drafted[0].split('\n')[0]));
const wants = ['【页面批注】共 2 条', '1. div.card', '批注：这块太挤了', '修改需求：'];
for (const want of wants) {
  if (!drafted[0].includes(want)) {
    console.error('[X] 草稿块缺少:', want);
    process.exit(1);
  }
}

// 客户端拼出来的块必须和页面端 formatAnnotationsForAI 逐字一致（否则草稿会被改花）
if (drafted[0] !== annoText) {
  console.error('[X] 客户端注释块与页面端格式不一致:\n--- 客户端 ---\n' + drafted[0] + '\n--- 页面端 ---\n' + annoText);
  process.exit(1);
}
console.log('client block === page block（两边格式一致）OK');

resetHooks();
const tree2 = slotComponent(props);
const rendered2 = tree2 && typeof tree2.type === 'function' ? tree2.type(tree2.props) : tree2;
const treeJson = JSON.stringify(rendered2);
if (!treeJson.includes('2 条注释')) {
  console.error('[X] 注释胶囊没有渲染:', treeJson.slice(0, 200));
  process.exit(1);
}
console.log('chip rendered: 2 条注释 + 卡片组件 OK');
console.log('CLIENT TEST OK');
process.exit(0);
