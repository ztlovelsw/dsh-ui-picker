/**
 * dsh-ui-picker — DSH 客户端（浏览器）侧
 *
 * 作用：
 *  1. 轮询本机桥接服务（127.0.0.1:17857），拿到页面端推送的控件描述或页面注释；
 *  2. 控件描述：通过输入框 facade 把文本插到光标处（原行为）；
 *  3. 页面注释：在输入框上方渲染「N 条注释」胶囊 —— 点开是逐条可编辑/可删除的卡片，
 *     改动实时回写到输入框里的【页面批注】文本块。
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
        /** 草稿里的注释块写过之后，至少隔这么久才检查「是不是已经被发送掉」 */
        const REAP_DELAY_MS = 1_200;

        // ---------- 全局单例状态（多会话挂载时只保留一个生效的输入口） ----------
        /**
         * 全局单例运行时：模块被 HMR 重载时会生成新的模块实例，
         * 若状态留在闭包里，旧实例的轮询不会停，导致同一条消息被写入两次。
         * 把状态挂到 window 上，保证整个页面只有一份「游标 + 输入口 + 注释集」。
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
            /** 输入框 facade（setDraft / state 都从这里拿） */
            facade: null,
            /** 当前待处理的页面注释 */
            annotations: [],
            /** 注释来自哪一页 */
            page: null,
            /** 注释卡片是否展开 */
            annoOpen: false,
            /** 正在编辑的注释 uid */
            editingUid: null,
            /** 上一次写进草稿的注释块（用于原地替换 / 清空） */
            block: '',
            blockAt: 0,
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

        // ---------- 草稿里的注释块 ----------
        function currentDraft() {
          const facade = store.facade;
          try {
            const snapshot = facade && facade.state && facade.state.getSnapshot();
            return (snapshot && snapshot.draft) || '';
          } catch (_) {
            return '';
          }
        }

        function writeDraft(text) {
          const facade = store.facade;
          if (!facade) return false;
          try {
            if (typeof facade.setDraft === 'function') {
              facade.setDraft(text);
              return true;
            }
            const actions = facade.actions;
            if (actions && typeof actions.setDraft === 'function') {
              actions.setDraft(text);
              return true;
            }
          } catch (error) {
            console.warn('[dsh-ui-picker] 写入草稿失败:', error);
          }
          return false;
        }

        /** 注释集 → 一段给模型看的文本块（与页面端 formatAnnotationsForAI 同格式）。 */
        function formatAnnotationsBlock(list) {
          if (!list || !list.length) return '';
          const page = store.page || {};
          const lines = [];
          lines.push(`【页面批注】共 ${list.length} 条`);
          lines.push(`页面：${page.title || '(无标题)'} — ${page.url || ''}`);
          if (page.w && page.h) {
            lines.push(`视口：${page.w} × ${page.h}　页面坐标以文档左上角为原点（不随滚动变化）`);
          }
          lines.push('');
          list.forEach((anno, index) => {
            const facts = [`页面坐标 (${anno.x}, ${anno.y})`];
            if (anno.offset) facts.push(`元素内 (${anno.offset.x}%, ${anno.offset.y}%)`);
            const label = anno.label || anno.selector || anno.tag || '元素';
            lines.push(`${index + 1}. ${label}　${facts.join('　')}`);
            lines.push(`   批注：${anno.comment || '（未填写具体描述）'}`);
          });
          lines.push('');
          lines.push('修改需求：');
          return lines.join('\n');
        }

        /**
         * 把草稿里的注释块换成新内容。
         * 旧块还在草稿里就原地替换（保留用户自己敲的正文），否则追加。
         */
        function syncDraftBlock(next) {
          const draft = currentDraft();
          const previous = store.block;
          let out;
          if (previous && draft.includes(previous)) {
            out = draft.replace(previous, next);
          } else if (!draft.trim()) {
            out = next;
          } else if (!next) {
            out = draft;
          } else {
            out = `${draft.trimEnd()}\n\n${next}`;
          }
          store.block = next;
          store.blockAt = Date.now();
          if (out !== draft) writeDraft(out);
        }

        /** 注释被发送掉以后（草稿里的块不见了）顺手把胶囊收掉。 */
        function reapSentBlock() {
          if (!store.block || !store.annotations.length) return;
          if (Date.now() - store.blockAt < REAP_DELAY_MS) return;
          const draft = currentDraft();
          if (draft.includes(store.block)) return;
          store.block = '';
          store.blockAt = 0;
          store.annotations = [];
          store.editingUid = null;
          store.annoOpen = false;
          emit();
        }

        // ---------- 注释数据操作 ----------
        function adoptAnnotations(payload, page) {
          const incoming = Array.isArray(payload) ? payload : [];
          if (!incoming.length) return;
          const existing = new Map(store.annotations.map((anno) => [anno.uid, anno]));
          for (const item of incoming) {
            const uid = item && item.uid ? String(item.uid) : `anno-${Date.now()}-${Math.random()}`;
            existing.set(uid, {
              uid,
              no: item && item.no,
              tag: (item && item.tag) || 'div',
              label: (item && item.label) || '',
              selector: (item && item.selector) || null,
              comment: (item && item.comment) || '',
              thumb: (item && item.thumb) || null,
              x: item && item.x,
              y: item && item.y,
              offset: (item && item.offset) || null,
            });
          }
          store.annotations = [...existing.values()];
          if (page) store.page = page;
          else if (!store.page) store.page = { title: document.title, url: location.href };
          syncDraftBlock(formatAnnotationsBlock(store.annotations));
          emit();
        }

        function removeAnnotation(uid) {
          store.annotations = store.annotations.filter((anno) => anno.uid !== uid);
          if (store.editingUid === uid) store.editingUid = null;
          if (!store.annotations.length) {
            store.annoOpen = false;
            syncDraftBlock('');
          } else {
            syncDraftBlock(formatAnnotationsBlock(store.annotations));
          }
          emit();
        }

        function updateAnnotation(uid, comment) {
          const next = String(comment == null ? '' : comment).slice(0, 200);
          let changed = false;
          store.annotations = store.annotations.map((anno) => {
            if (anno.uid !== uid) return anno;
            if (anno.comment === next) return anno;
            changed = true;
            return { ...anno, comment: next };
          });
          store.editingUid = null;
          if (changed) syncDraftBlock(formatAnnotationsBlock(store.annotations));
          emit();
        }

        function clearAnnotations() {
          store.annotations = [];
          store.editingUid = null;
          store.annoOpen = false;
          syncDraftBlock('');
          emit();
        }

        // ---------- 注释胶囊 UI（输入框上方的「N 条注释」） ----------
        const CHIP_CSS_ID = '__dsh_ui_picker_chip_css__';
        const CHIP_CSS = `
.dsh-anno-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 2px 0;
  font: 400 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.dsh-anno-card {
  border: 1px solid rgba(15, 23, 42, .10);
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 14px 34px -18px rgba(15, 23, 42, .35);
  overflow: hidden;
  max-height: 320px;
  overflow-y: auto;
}
.dsh-anno-row + .dsh-anno-row { border-top: 1px solid rgba(15, 23, 42, .07); }
.dsh-anno-row { padding: 9px 12px 10px; }
.dsh-anno-head { display: flex; align-items: center; gap: 8px; }
.dsh-anno-thumb {
  width: 26px; height: 26px; flex: none;
  border-radius: 7px; object-fit: cover;
  border: 1px solid rgba(15, 23, 42, .10);
  background: #f1f5f9;
  display: inline-block;
}
.dsh-anno-tag {
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, .12);
  background: rgba(15, 23, 42, .03);
  color: rgba(15, 23, 42, .62);
  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dsh-anno-flex { flex: 1 1 auto; }
.dsh-anno-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0;
  border: 0; border-radius: 7px; background: transparent;
  color: rgba(15, 23, 42, .45); cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.dsh-anno-icon:hover { background: rgba(15, 23, 42, .06); color: rgba(15, 23, 42, .8); }
.dsh-anno-icon.is-danger:hover { background: rgba(239, 68, 68, .1); color: #dc2626; }
.dsh-anno-comment {
  margin-top: 6px;
  color: #0f172a;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: text;
  border-radius: 7px;
  padding: 1px 2px;
}
.dsh-anno-comment:hover { background: rgba(15, 23, 42, .035); }
.dsh-anno-comment.is-empty { color: rgba(15, 23, 42, .35); }
.dsh-anno-input {
  margin-top: 6px; width: 100%; box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid rgba(37, 99, 235, .45);
  border-radius: 8px;
  outline: none;
  background: #fff;
  color: #0f172a;
  font: inherit;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, .10);
}
.dsh-anno-bar { display: flex; align-items: center; gap: 6px; }
.dsh-anno-pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px;
  border: 1px solid rgba(15, 23, 42, .12);
  border-radius: 999px;
  background: #fff;
  color: rgba(15, 23, 42, .78);
  font: inherit; font-size: 12.5px; font-weight: 500;
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.dsh-anno-pill:hover { background: rgba(37, 99, 235, .06); border-color: rgba(37, 99, 235, .28); color: #1d4ed8; }
.dsh-anno-pill svg { display: block; flex: none; opacity: .75; }
.dsh-anno-clear {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: 999px;
  background: #0f172a; color: #fff;
  font-size: 11px; line-height: 1; cursor: pointer;
}
.dsh-anno-clear:hover { background: #dc2626; }
@media (prefers-color-scheme: dark) {
  .dsh-anno-card {
    border-color: rgba(255, 255, 255, .10);
    background: #171d29;
    box-shadow: 0 16px 36px -18px rgba(0, 0, 0, .8);
  }
  .dsh-anno-row + .dsh-anno-row { border-top-color: rgba(255, 255, 255, .08); }
  .dsh-anno-thumb { border-color: rgba(255, 255, 255, .12); background: #1f2735; }
  .dsh-anno-tag {
    border-color: rgba(255, 255, 255, .14);
    background: rgba(255, 255, 255, .05);
    color: rgba(226, 232, 240, .72);
  }
  .dsh-anno-icon { color: rgba(226, 232, 240, .5); }
  .dsh-anno-icon:hover { background: rgba(255, 255, 255, .08); color: #e5e7eb; }
  .dsh-anno-comment { color: #e5e7eb; }
  .dsh-anno-comment:hover { background: rgba(255, 255, 255, .05); }
  .dsh-anno-comment.is-empty { color: rgba(226, 232, 240, .38); }
  .dsh-anno-input {
    border-color: rgba(147, 197, 253, .5);
    background: #0f1522;
    color: #e5e7eb;
    box-shadow: 0 0 0 3px rgba(147, 197, 253, .12);
  }
  .dsh-anno-pill {
    border-color: rgba(255, 255, 255, .14);
    background: #171d29;
    color: rgba(226, 232, 240, .8);
  }
  .dsh-anno-pill:hover { background: rgba(147, 197, 253, .12); border-color: rgba(147, 197, 253, .35); color: #bfdbfe; }
  .dsh-anno-clear { background: #e5e7eb; color: #0f172a; }
  .dsh-anno-clear:hover { background: #ef4444; color: #fff; }
}
`;

        function injectChipCss() {
          if (document.getElementById(CHIP_CSS_ID)) return;
          const style = document.createElement('style');
          style.id = CHIP_CSS_ID;
          style.textContent = CHIP_CSS;
          document.head.appendChild(style);
        }

        const ICON = {
          comment:
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
            '<path d="M4.2 5.6h15.6a1.4 1.4 0 0 1 1.4 1.4v8.2a1.4 1.4 0 0 1-1.4 1.4H9.4l-4.3 3.3a.5.5 0 0 1-.8-.4v-2.9a1.4 1.4 0 0 1-.1-1V7a1.4 1.4 0 0 1 0-1.4Z" ' +
            'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
          pencil:
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
            '<path d="M15.6 4.9l3.5 3.5M4.8 19.2l4.3-.8 9.4-9.4a1.6 1.6 0 0 0 0-2.3l-1.2-1.2a1.6 1.6 0 0 0-2.3 0L5.6 14.9l-.8 4.3Z" ' +
            'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          trash:
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
            '<path d="M4.4 6.6h15.2M9.4 6.6V4.7c0-.7.6-1.3 1.3-1.3h2.6c.7 0 1.3.6 1.3 1.3v1.9" ' +
            'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
            '<path d="M6.6 6.6l.8 12.1c.06.9.8 1.6 1.7 1.6h5.8c.9 0 1.64-.7 1.7-1.6l.8-12.1" ' +
            'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        };

        function svg(html) {
          return react.createElement('span', {
            className: 'dsh-anno-svg',
            dangerouslySetInnerHTML: { __html: html },
          });
        }

        function commitEdit(uid, value) {
          if (store.editingUid !== uid) return;
          updateAnnotation(uid, value);
        }

        function AnnotationRow(props) {
          const anno = props.anno;
          const editing = store.editingUid === anno.uid;
          const head = react.createElement(
            'div',
            { className: 'dsh-anno-head' },
            anno.thumb
              ? react.createElement('img', { className: 'dsh-anno-thumb', src: anno.thumb, alt: '' })
              : react.createElement('span', { className: 'dsh-anno-thumb' }),
            react.createElement('span', { className: 'dsh-anno-tag' }, anno.tag || 'div'),
            react.createElement('span', { className: 'dsh-anno-flex' }),
            react.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-anno-icon',
                title: '编辑注释',
                onClick: () => {
                  store.editingUid = anno.uid;
                  emit();
                },
              },
              svg(ICON.pencil),
            ),
            react.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-anno-icon is-danger',
                title: '删除这条注释',
                onClick: () => removeAnnotation(anno.uid),
              },
              svg(ICON.trash),
            ),
          );

          const body = editing
            ? react.createElement('input', {
                className: 'dsh-anno-input',
                defaultValue: anno.comment || '',
                autoFocus: true,
                placeholder: '写下要改什么…',
                onKeyDown: (event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitEdit(anno.uid, event.currentTarget.value);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    store.editingUid = null;
                    emit();
                  }
                },
                onBlur: (event) => commitEdit(anno.uid, event.currentTarget.value),
              })
            : react.createElement(
                'div',
                {
                  className: `dsh-anno-comment${anno.comment ? '' : ' is-empty'}`,
                  title: '点击编辑',
                  onClick: () => {
                    store.editingUid = anno.uid;
                    emit();
                  },
                },
                anno.comment || '未填写注释',
              );

          return react.createElement('div', { className: 'dsh-anno-row' }, head, body);
        }

        function AnnotationChip() {
          const state = usePickerState();
          const list = state.annotations || [];
          if (!list.length) return null;
          injectChipCss();
          const open = state.annoOpen;

          const children = [];
          if (open) {
            children.push(
              react.createElement(
                'div',
                { key: 'card', className: 'dsh-anno-card' },
                list.map((anno) =>
                  react.createElement(AnnotationRow, { key: anno.uid, anno }),
                ),
              ),
            );
          }
          children.push(
            react.createElement(
              'div',
              { key: 'bar', className: 'dsh-anno-bar' },
              react.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-anno-pill',
                  title: open ? '收起注释' : '查看注释',
                  onClick: () => {
                    store.annoOpen = !store.annoOpen;
                    store.editingUid = null;
                    emit();
                  },
                },
                svg(ICON.comment),
                `${list.length} 条注释`,
              ),
              open
                ? react.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-anno-clear',
                      title: '清空注释',
                      onClick: () => clearAnnotations(),
                    },
                    '✕',
                  )
                : null,
            ),
          );
          return react.createElement('div', { className: 'dsh-anno-wrap' }, children);
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
              const meta = item.meta || {};
              if (meta.kind === 'annotations' && Array.isArray(meta.annotations)) {
                // 页面注释：不往光标处插文本，交给输入框上方的注释胶囊
                adoptAnnotations(meta.annotations, meta.page);
                continue;
              }
              if (typeof item.text === 'string' && item.text.trim() !== '') {
                store.count += 1;
                store.lastTag = summarize(item.text);
                deliver(item.text);
              }
            }
            reapSentBlock();
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

        // ---------- 挂载点（输入框 dock：只渲染注释胶囊，没有注释时零视觉） ----------
        /**
         * 输入框 dock 组件：没有注释时返回 null（不占空间），
         * 有注释时渲染「N 条注释」胶囊 + 可展开的注释卡片。
         */
        function PickerDock(props) {
          const insertRef = react.useRef(null);
          insertRef.current = (props && props.insertText) || null;

          react.useEffect(() => {
            if (typeof insertRef.current !== 'function') return undefined;
            store.sink = (text) => {
              const insert = insertRef.current;
              return typeof insert === 'function' ? insert(text) : false;
            };
            return () => {
              store.sink = null;
            };
          }, []);

          return react.createElement(AnnotationChip, null);
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
                    // 注释块的原地改写要直接改草稿，这里把 facade 登记给全局状态
                    if (input) store.facade = input;
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
