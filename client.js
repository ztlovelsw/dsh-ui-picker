/**
 * dsh-ui-picker — DSH 客户端（浏览器）侧
 *
 * 作用：
 *  1. 轮询本机桥接服务（127.0.0.1:17857），拿到页面端推送的控件描述；
 *  2. 通过输入框 facade（conversation.input.for(actx)）把文本插到当前会话输入框；
 *  3. 不占用任何可见 UI：只在输入框 dock 里挂一个 display:none 的占位节点。
 *
 * 形态：DSH 客户端模块（window.__ModuleLoader__.load），不是 ESM。
 */
(() => {
  try {
    window.__ModuleLoader__.load({
      id: 'dsh-ui-picker',
      factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        const react = require('react');

        // ---------- 常量 ----------
        const DEFAULT_PORT =
          (typeof window !== 'undefined' && Number(window.__DSH_UI_PICKER_PORT__)) || 17857;
        const POLL_TIMEOUT_MS = 25_000;
        const RETRY_MS = 3_000;

        // ---------- 全局单例状态（多会话挂载时只保留一个生效的输入口） ----------
        /**
         * 全局单例运行时：模块被 HMR 重载时会生成新的模块实例，
         * 若状态留在闭包里，旧实例的轮询不会停，导致同一条消息被写入两次。
         * 把状态挂到 window 上，保证整个页面只有一份「游标 + 输入口」。
         */
        const RUNTIME_KEY = '__DSH_UI_PICKER_RUNTIME__';
        const store =
          (typeof window !== 'undefined' && window[RUNTIME_KEY]) || {
            port: DEFAULT_PORT,
            seq: 0,
            deliveredSeq: -1,
            online: false,
            lastTag: null,
            count: 0,
            sink: null,
            listeners: new Set(),
            started: false,
          };
        if (typeof window !== 'undefined') window[RUNTIME_KEY] = store;

        function emit() {
          for (const listener of [...store.listeners]) {
            try {
              listener();
            } catch (_) {
              /* 订阅者异常不影响轮询 */
            }
          }
        }

        function subscribe(listener) {
          store.listeners.add(listener);
          return () => store.listeners.delete(listener);
        }

        function usePickerState() {
          const [, force] = react.useState(0);
          react.useEffect(() => {
            const unsubscribe = subscribe(() => force((n) => n + 1));
            return () => {
              unsubscribe();
            };
          }, []);
          return store;
        }

        // ---------- 输入框写入 ----------
        /** 兜底：向 lexical contenteditable 派发一次 paste 事件。 */
        function pasteIntoComposer(text) {
          const el = document.querySelector('[data-composer-input]');
          if (!el) return false;
          try {
            el.focus();
            const data = new DataTransfer();
            data.setData('text/plain', text);
            const event = new ClipboardEvent('paste', {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            });
            el.dispatchEvent(event);
            return true;
          } catch (_) {
            return false;
          }
        }

        function deliver(text) {
          if (!text) return;
          const sink = store.sink;
          if (sink) {
            try {
              if (sink(text)) return;
            } catch (_) {
              /* 落到下面的 DOM 兜底 */
            }
          }
          if (pasteIntoComposer(text)) return;
          // 两条路都失败：至少把内容留在控制台，用户可手动复制
          console.warn('[dsh-ui-picker] 无法写入输入框，控件信息如下（可手动复制）：\n' + text);
        }

        // ---------- 轮询桥接 ----------
        function summarize(text) {
          const match = /<([a-z0-9-]+)([^>]*)>/i.exec(text);
          if (!match) return '控件';
          const idMatch = /id="([^"]+)"/.exec(match[2] || '');
          return `<${match[1]}${idMatch ? '#' + idMatch[1] : ''}>`;
        }

        async function pollOnce() {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
          try {
            const url = `http://127.0.0.1:${store.port}/poll?since=${store.seq}`;
            const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok) throw new Error(`status ${response.status}`);
            const payload = await response.json();
            if (!store.online) {
              store.online = true;
              emit();
            }
            const items = Array.isArray(payload.items) ? payload.items : [];
            for (const item of items) {
              if (typeof item.seq === 'number') {
                if (item.seq > store.seq) store.seq = item.seq;
                // 已交付过的序号直接跳过：双轮询 / 双实例都不会重复写入
                if (item.seq <= store.deliveredSeq) continue;
                store.deliveredSeq = item.seq;
              }
              if (typeof item.text === 'string' && item.text.trim() !== '') {
                store.count += 1;
                store.lastTag = summarize(item.text);
                deliver(item.text);
              }
            }
            if (items.length > 0) emit();
            return true;
          } catch (_) {
            if (store.online) {
              store.online = false;
              emit();
            }
            return false;
          } finally {
            clearTimeout(timer);
          }
        }

        async function pollLoop() {
          if (store.started) return;
          store.started = true;
          // 首次探测：避免页面刷新后重复消费历史条目
          try {
            const response = await fetch(`http://127.0.0.1:${store.port}/health`, { cache: 'no-store' });
            if (response.ok) {
              const health = await response.json();
              if (typeof health.seq === 'number') {
                // 首连：把游标推到当前队尾，避免把历史条目再放一遍
                if (store.seq === 0) store.seq = health.seq;
                if (store.deliveredSeq < health.seq) store.deliveredSeq = health.seq;
              }
              store.online = true;
              emit();
            }
          } catch (_) {
            /* 桥接未启动时保持离线状态 */
          }
          for (;;) {
            const ok = await pollOnce();
            if (!ok) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
          }
        }

        // ---------- 挂载点（零视觉：只保留一个不可见节点，避免占用输入框上方空间） ----------
        /**
         * 输入框 dock 的占位组件：不渲染任何可见内容。
         * 组件存在只为拿到 `insertText` 这个 session 级 props，
         * 并把写入能力登记为全局 sink。
         */
        function PickerDock(props) {
          const insertRef = react.useRef(null);
          insertRef.current = (props && props.insertText) || null;

          react.useEffect(() => {
            if (typeof insertRef.current !== 'function') return undefined;
            const token = { active: true };
            store.sink = (text) => {
              const insert = insertRef.current;
              return typeof insert === 'function' ? insert(text) : false;
            };
            return () => {
              token.active = false;
              store.sink = null;
            };
          }, []);

          // 返回 null：不生成任何 DOM，输入框上方不留空行
          return null;
        }

        // ---------- 插件入口 ----------
        function apply(ctx) {
          // 启动轮询（全局一次）
          void pollLoop();

          try {
            ctx.slots.inject('conversation.input.dock', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.dock',
                  id: 'ui-picker',
                  order: 55,
                  inject: (sessionId) => {
                    let input = null;
                    try {
                      const actx = ctx.sessions.scope(sessionId);
                      const conversation = actx && actx.get('conversation');
                      input = (conversation && conversation.input && conversation.input.for(actx)) || null;
                    } catch (error) {
                      console.warn('[dsh-ui-picker] composer facade unavailable:', error);
                    }
                    return {
                      insertText: (text) => {
                        if (!input) return false;
                        try {
                          const span = input.actions.captureInsertion();
                          if (input.actions.insertText(text, span)) return true;
                        } catch (_) {
                          /* 落到 setDraft */
                        }
                        try {
                          const current =
                            (input.state && input.state.getSnapshot && input.state.getSnapshot().draft) || '';
                          input.setDraft(current ? `${current}\n${text}` : text);
                          return true;
                        } catch (_) {
                          return false;
                        }
                      },
                    };
                  },
                },
                PickerDock,
              ),
            );
          } catch (error) {
            console.warn('[dsh-ui-picker] slot registration failed:', error);
          }
        }

        exports.name = 'dsh-ui-picker';
        exports.inject = ['slots', 'sessions', 'conversation'];
        exports.apply = apply;
        return module.exports;
      },
    });
  } catch (error) {
    console.warn('[dsh-ui-picker] client runtime error:', error);
  }
})();
