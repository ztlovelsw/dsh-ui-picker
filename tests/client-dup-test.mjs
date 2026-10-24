/**
 * 重复写入回归测试：
 * 模拟「模块被 HMR 重载」——同一页面里加载两份 client.js（两个模块实例），
 * 推送一条消息，断言只调用一次 insertText。
 *   node tests/client-dup-test.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../index.js';

const source = await readFile(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');

const windowStub = { __DSH_UI_PICKER_PORT__: 17859 };
const documentStub = { querySelector: () => null, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }) };
globalThis.window = windowStub;
globalThis.document = documentStub;

function makeReact() {
  let hookIndex = 0;
  const slots = [];
  return {
    api: {
      useState(initial) {
        const i = hookIndex++;
        if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
        return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
      },
      useEffect(effect) { hookIndex++; effect(); },
      useRef(initial) {
        const i = hookIndex++;
        if (!(i in slots)) slots[i] = { current: initial };
        return slots[i];
      },
      createElement(type, props, ...children) { return { type, props: { ...(props || {}), children } }; },
    },
    reset() { hookIndex = 0; },
  };
}

const inserted = [];
const fakeInput = {
  actions: {
    captureInsertion: () => ({ draftRev: 1 }),
    insertText: (text) => { inserted.push(text); return true; },
  },
  setDraft: (text) => { inserted.push(text); },
  state: { getSnapshot: () => ({ draft: '' }) },
};

function loadInstance(label) {
  const react = makeReact();
  const instances = [];
  windowStub.__ModuleLoader__ = {
    load({ id, factory }) {
      instances.push({ id, exports: factory((name) => (name === 'react' ? react.api : undefined)) });
    },
  };
  new Function('window', 'document', 'console', source)(windowStub, documentStub, console);
  const mod = instances[0];
  if (!mod) throw new Error(`${label}: module not registered`);

  let slotComponent = null;
  let slotOptions = null;
  const ctx = {
    slots: {
      inject(name, fn) { fn(); },
      register(options, component) { slotOptions = options; slotComponent = component; return () => {}; },
    },
    sessions: { scope: () => ({ get: () => ({ input: { for: () => fakeInput } }) }) },
    get: () => undefined,
    on: () => () => {},
  };
  mod.exports.apply(ctx);
  if (slotComponent) {
    react.reset();
    slotComponent(slotOptions.inject('session-1'));
  }
  return mod;
}

// 两个模块实例（模拟旧实例未销毁 + HMR 新实例）
loadInstance('first');
loadInstance('second');

const bridge = await startBridge({ port: 17859 });
await new Promise((r) => setTimeout(r, 400));

const payload = '【UI 控件】「提交订单」按钮\n页面：dup test\n\n修改需求：';
await fetch('http://127.0.0.1:17859/push', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: payload }),
});

const deadline = Date.now() + 4000;
while (inserted.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 80));
}
await new Promise((r) => setTimeout(r, 600)); // 再等一会，看会不会来第二次
await bridge.close();

console.log('insertText 调用次数:', inserted.length);
if (inserted.length !== 1) {
  console.error(`[X] 期望 1 次，实际 ${inserted.length} 次 —— 仍会重复写入`);
  process.exit(1);
}
console.log('CLIENT DUP TEST OK');
process.exit(0);
