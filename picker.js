/**
 * dsh-ui-picker — 页面端「UI 控件拾取器 / 页面批注」
 *
 * 用法（三选一）：
 *   1. 在你的页面里加一行：<script src="http://127.0.0.1:17857/picker.js"></script>
 *   2. 控制台粘贴本文件全部内容
 *   3. 装成油猴脚本（见同目录 dsh-ui-picker.user.js）
 *
 * 两种模式（点右下角小按钮选择，或用快捷键）：
 *   选取控件（Ctrl+Shift+P）：悬停高亮 → 点击控件 → 选择器/样式自动写入 DSH 输入框。
 *   页面批注（Ctrl+Shift+A）：在页面任意位置钉编号标记 → 每条写一句评论 →
 *     一次性压成编号清单写入 DSH 输入框（适合「这几处都要改」的场景）。
 */
(function () {
  'use strict';

  if (window.__DSH_UI_PICKER__) return;
  window.__DSH_UI_PICKER__ = true;

  // ---------- 配置 ----------
  const selfScript = document.currentScript;
  const PORT =
    (selfScript && selfScript.dataset && selfScript.dataset.port) ||
    window.__DSH_UI_PICKER_PORT__ ||
    17857;
  const BRIDGE = `http://127.0.0.1:${PORT}`;
  const PUSH_URL = `${BRIDGE}/push`;

  // ---------- 状态 ----------
  let picking = false;
  let hoverEl = null;
  let overlay = null;
  let tip = null;
  let rafId = 0;
  /** Shift 加选时收集的控件；Enter 一次性发送 */
  const batch = [];
  /** 防抖：同样的内容短时间内只发一次（避免重复写入输入框） */
  let lastPush = { text: '', at: 0 };

  // ---------- 工具 ----------
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&');

  function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function clip(text, max) {
    const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max) + '…' : value;
  }

  /** 稳定 CSS 选择器：优先 id，否则带 class + nth-of-type 的短路径。 */
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return `#${cssEscape(el.id)}`;
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${cssEscape(cur.id)}`);
        break;
      }
      const classes = Array.from(cur.classList || []).slice(0, 2);
      if (classes.length) part += classes.map((c) => `.${cssEscape(c)}`).join('');
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  /** 绝对 XPath。 */
  function xpathOf(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let index = 1;
      let sibling = cur.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === cur.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}[${index}]`);
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }

  /** React / Vue 组件名探测。 */
  function componentOf(el) {
    try {
      const fiberKey = Object.keys(el).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
      );
      if (fiberKey) {
        let fiber = el[fiberKey];
        let guard = 0;
        while (fiber && guard < 40) {
          const type = fiber.type;
          const name =
            typeof type === 'function' ? type.displayName || type.name : null;
          if (name && !/^(ForwardRef|Memo|Fragment|Anonymous)$/.test(name)) {
            return { framework: 'React', name };
          }
          fiber = fiber.return;
          guard += 1;
        }
        return { framework: 'React', name: null };
      }
      if (el.__vueParentComponent) {
        const type = el.__vueParentComponent.type || {};
        return { framework: 'Vue3', name: type.name || type.__name || null };
      }
      if (el.__vue__) {
        const options = el.__vue__.$options || {};
        return { framework: 'Vue2', name: options.name || options._componentTag || null };
      }
    } catch (_) {
      /* 探测失败不影响主流程 */
    }
    const classText = Array.from(el.classList || []).join(' ');
    const lib = classText.match(/\b(el-[a-z-]+|ant-[a-z-]+|van-[a-z-]+|v-[a-z-]+|mdc-[a-z-]+|Mui[A-Za-z]+)/);
    return { framework: null, name: lib ? lib[1] : null };
  }

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (tag === 'button' || type === 'submit' || type === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file-input';
      return 'text-input';
    }
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'img' || tag === 'svg') return 'image';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'table') return 'table';
    if (tag === 'form') return 'form';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'list-item';
    if (tag === 'dialog' || el.getAttribute('aria-modal') === 'true') return 'dialog';
    return tag;
  }

  const STYLE_KEYS = [
    'display', 'position', 'width', 'height', 'padding', 'margin',
    'color', 'background-color', 'background-image', 'border', 'border-radius',
    'font-size', 'font-weight', 'font-family', 'line-height', 'text-align',
    'box-shadow', 'z-index', 'opacity', 'overflow', 'cursor', 'flex', 'gap',
    'grid-template-columns', 'transform',
  ];

  function stylesOf(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const key of STYLE_KEYS) {
      const value = cs.getPropertyValue(key);
      if (!value || value === 'none' || value === 'normal' || value === 'auto') continue;
      if (key === 'background-image' && value.includes('url(')) {
        out[key] = value.slice(0, 80) + '…';
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  function parentChain(el, depth) {
    const chain = [];
    let cur = el.parentElement;
    let level = 0;
    while (cur && level < depth) {
      let label = cur.tagName.toLowerCase();
      if (cur.id) label += `#${cur.id}`;
      const cls = Array.from(cur.classList || []).slice(0, 3);
      if (cls.length) label += '.' + cls.join('.');
      chain.push(label);
      cur = cur.parentElement;
      level += 1;
    }
    return chain;
  }

  /** 采集一个元素的完整描述。 */
  function describe(el) {
    const rect = el.getBoundingClientRect();
    const component = componentOf(el);
    const attrs = {};
    for (const name of ['name', 'type', 'placeholder', 'aria-label', 'title', 'alt', 'href', 'src', 'for', 'data-testid']) {
      const value = el.getAttribute && el.getAttribute(name);
      if (value) attrs[name] = clip(value, 120);
    }
    let value = null;
    if ('value' in el && el.tagName !== 'BUTTON') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      value = type === 'password' ? '••••••' : clip(el.value, 80);
    }
    const siblings = el.parentElement ? el.parentElement.children.length : 0;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList || []),
      role: roleOf(el),
      text: clip(el.innerText || el.textContent || '', 160) || null,
      attrs,
      value,
      component,
      selector: cssPath(el),
      xpath: xpathOf(el),
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      styles: stylesOf(el),
      parents: parentChain(el, 3),
      siblings,
      page: { title: document.title, url: location.href },
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    };
  }

  /** 把结构化信息压成给 AI 看的文本。 */
  const ROLE_LABELS = {
    button: '按钮', link: '链接', 'text-input': '输入框', textarea: '多行输入框',
    select: '下拉框', checkbox: '复选框', radio: '单选框', slider: '滑块',
    'file-input': '文件选择框', image: '图片', heading: '标题', list: '列表',
    'list-item': '列表项', table: '表格', form: '表单', dialog: '弹窗',
    navigation: '导航', tab: '标签页', switch: '开关',
  };

  function roleLabel(info) {
    return ROLE_LABELS[info.role] || info.role || info.tag;
  }

  /** 一句话说清「这是哪个控件」：优先可见文案，其次 placeholder / aria-label / name。 */
  function titleOf(info) {
    const label = roleLabel(info);
    const name =
      info.text ||
      info.attrs.placeholder ||
      info.attrs['aria-label'] ||
      info.attrs.title ||
      info.attrs.name ||
      '';
    return name ? `「${clip(name, 16)}」${label}` : `<${info.tag}> ${label}`;
  }

  /** 父级链里去掉 html/body 这类没有信息量的层级。 */
  function parentChainText(info) {
    return (info.parents || []).filter((item) => item !== 'html' && item !== 'body').join(' ← ');
  }

  /** 只挑对改样式有用的计算属性，写成中文短语。 */
  function styleSummary(styles) {
    const fields = [
      ['padding', '内边距'], ['margin', '外边距'], ['border-radius', '圆角'],
      ['background-color', '背景'], ['color', '字色'], ['font-size', '字号'],
      ['font-weight', '字重'], ['border', '边框'], ['box-shadow', '阴影'],
      ['z-index', '层级'], ['position', '定位'],
    ];
    const boring = new Set([
      '0px', '0px 0px', 'rgba(0, 0, 0, 0)', 'transparent', 'normal',
      'none', 'auto', 'static', '400', 'initial', 'visible',
    ]);
    const parts = [];
    for (const [key, label] of fields) {
      const value = styles[key];
      if (!value || boring.has(value)) continue;
      if (key === 'border' && /^0px/.test(value)) continue;
      parts.push(`${label} ${value}`);
    }
    return parts.join('｜');
  }

  /** 单个控件：一段可直接阅读的说明。 */
  function formatForAI(info) {
    const lines = [];
    lines.push(`【UI 控件】${titleOf(info)}`);
    lines.push(`页面：${info.page.title || '(无标题)'} — ${info.page.url}`);

    let ident = info.tag;
    if (info.id) ident += `#${info.id}`;
    if (info.classes.length) ident += '.' + info.classes.slice(0, 3).join('.');
    const comp = info.component.name
      ? ` · ${info.component.name}${info.component.framework ? `（${info.component.framework}）` : ''}`
      : info.component.framework
        ? ` · ${info.component.framework}`
        : '';
    lines.push(`定位：${ident}${comp}`);

    const facts = [];
    if (info.text) facts.push(`文案「${clip(info.text, 40)}」`);
    facts.push(`尺寸 ${info.box.w} × ${info.box.h}`, `位于 (${info.box.x}, ${info.box.y})`);
    lines.push(facts.join('，'));

    const styleText = styleSummary(info.styles);
    if (styleText) lines.push(`样式：${styleText}`);
    const parents = parentChainText(info);
    if (parents) lines.push(`父级：${parents}（同级 ${info.siblings} 个）`);
    lines.push(`CSS：${info.selector}　XPath：${info.xpath}`);
    lines.push('');
    lines.push('修改需求：');
    return lines.join('\n');
  }

  /** 多个控件：编号列出，共用同一个页头与结尾。 */
  function formatBatchForAI(list) {
    const first = list[0];
    const lines = [];
    lines.push(`【UI 控件】共 ${list.length} 个`);
    lines.push(`页面：${first.page.title || '(无标题)'} — ${first.page.url}`);
    lines.push('');
    list.forEach((info, index) => {
      const no = String(index + 1).padStart(2, '0');
      let ident = info.tag;
      if (info.id) ident += `#${info.id}`;
      if (info.classes.length) ident += '.' + info.classes.slice(0, 2).join('.');
      const comp = info.component.name ? ` · ${info.component.name}` : '';
      lines.push(`${no}. ${titleOf(info)}　${ident}${comp}`);

      const facts = [];
      if (info.text) facts.push(`文案「${clip(info.text, 30)}」`);
      facts.push(`尺寸 ${info.box.w} × ${info.box.h}`, `位于 (${info.box.x}, ${info.box.y})`);
      lines.push(`    ${facts.join('，')}`);

      const styleText = styleSummary(info.styles);
      if (styleText) lines.push(`    样式：${styleText}`);
      const parents = parentChainText(info);
      if (parents) lines.push(`    父级：${parents}`);
      lines.push(`    CSS：${info.selector}`);
      if (index < list.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('修改需求：');
    return lines.join('\n');
  }

  // ---------- 与 DSH 桥接通信 ----------
  async function push(text, extra) {
    // 同一份内容 900ms 内只发一次：防止事件重入/双实例导致的重复写入
    const now = Date.now();
    if (text === lastPush.text && now - lastPush.at < 900) return true;
    lastPush = { text, at: now };
    try {
      const response = await fetch(PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // extra 带结构化数据（批注清单 / 缩略图），DSH 侧据此渲染输入框上方的注释胶囊
        body: JSON.stringify({
          text,
          meta: Object.assign(
            { from: location.host, url: location.href, title: document.title, ts: Date.now() },
            extra || null,
          ),
        }),
        mode: 'cors',
        keepalive: true,
      });
      return response.ok;
    } catch (_) {
      return false;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  // ---------- 视觉反馈 ----------
  let toastTimer = 0;
  function toast(message, ms) {
    let node = document.getElementById('__dsh_picker_toast__');
    if (!node) {
      node = document.createElement('div');
      node.id = '__dsh_picker_toast__';
      node.style.cssText = [
        'position:fixed', 'top:18px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'max-width:min(560px,90vw)',
        'background:#111827', 'color:#f9fafb', 'padding:10px 16px', 'border-radius:10px',
        'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'box-shadow:0 8px 24px rgba(0,0,0,.28)', 'pointer-events:none',
        'transition:opacity .18s ease', 'opacity:0',
      ].join(';');
      document.documentElement.appendChild(node);
    }
    node.textContent = message;
    node.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.style.opacity = '0';
    }, ms || 2600);
  }

  // ---------- 批量选择面板 ----------
  const BATCH_ID = '__dsh_picker_batch__';
  const BATCH_CSS = `
#__dsh_picker_batch__ {
  position: fixed;
  left: 50%;
  bottom: max(18px, env(safe-area-inset-bottom));
  transform: translateX(-50%) translateY(6px);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(780px, 92vw);
  padding: 7px 8px 7px 12px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, .10);
  background: rgba(255, 255, 255, .9);
  -webkit-backdrop-filter: blur(18px) saturate(1.8);
  backdrop-filter: blur(18px) saturate(1.8);
  box-shadow: 0 12px 34px -14px rgba(15, 23, 42, .45);
  font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #0f172a;
  opacity: 0;
  pointer-events: none;
  transition: opacity .16s ease, transform .16s cubic-bezier(.2,.8,.2,1);
}
#__dsh_picker_batch__.is-open { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }
#__dsh_picker_batch__ .bp-dot { width: 6px; height: 6px; border-radius: 50%; background: #2563eb; flex: none; }
#__dsh_picker_batch__ .bp-count { white-space: nowrap; font-weight: 600; }
#__dsh_picker_batch__ .bp-names {
  color: rgba(15, 23, 42, .5); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; max-width: 320px;
}
#__dsh_picker_batch__ .bp-btn {
  border: 0; border-radius: 999px; padding: 6px 11px; font: inherit;
  font-weight: 600; cursor: pointer; transition: background-color .15s ease, color .15s ease;
}
#__dsh_picker_batch__ .bp-send { background: #0f172a; color: #fff; }
#__dsh_picker_batch__ .bp-send:hover { background: #1f2937; }
#__dsh_picker_batch__ .bp-cancel { background: transparent; color: rgba(15, 23, 42, .58); }
#__dsh_picker_batch__ .bp-cancel:hover { background: rgba(15, 23, 42, .06); }
#__dsh_picker_batch__ kbd {
  font: inherit; font-size: 10.5px; opacity: .5; margin-left: 3px;
}
@media (prefers-color-scheme: dark) {
  #__dsh_picker_batch__ {
    border-color: rgba(255, 255, 255, .10);
    background: rgba(17, 24, 39, .88);
    color: #e5e7eb;
    box-shadow: 0 14px 36px -12px rgba(0, 0, 0, .7);
  }
  #__dsh_picker_batch__ .bp-names { color: rgba(226, 232, 240, .55); }
  #__dsh_picker_batch__ .bp-send { background: #e5e7eb; color: #0f172a; }
  #__dsh_picker_batch__ .bp-cancel { color: rgba(226, 232, 240, .6); }
  #__dsh_picker_batch__ .bp-cancel:hover { background: rgba(255, 255, 255, .08); }
}
@media (prefers-reduced-motion: reduce) {
  #__dsh_picker_batch__ { transition: none; }
}
`;

  function ensureBatchStyle() {
    if (document.getElementById('__dsh_picker_batch_css__')) return;
    const style = document.createElement('style');
    style.id = '__dsh_picker_batch_css__';
    style.textContent = BATCH_CSS;
    document.head.appendChild(style);
  }

  function batchNames() {
    const names = batch.map((info) =>
      info.text ? `「${clip(info.text, 8)}」` : `<${info.tag}>`,
    );
    const text = names.join('');
    return text.length > 34 ? text.slice(0, 34) + '…' : text;
  }

  function renderBatchPanel() {
    if (!batch.length) {
      hideBatchPanel();
      return;
    }
    ensureBatchStyle();
    let panel = document.getElementById(BATCH_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = BATCH_ID;
      panel.setAttribute('role', 'dialog');
      panel.innerHTML =
        '<span class="bp-dot"></span>' +
        '<span class="bp-count"></span>' +
        '<span class="bp-names"></span>' +
        '<button type="button" class="bp-btn bp-cancel">取消<kbd>Esc</kbd></button>' +
        '<button type="button" class="bp-btn bp-send">发送<kbd>⏎</kbd></button>';
      panel.querySelector('.bp-send').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void sendBatch();
      });
      panel.querySelector('.bp-cancel').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        stopPicking();
        toast('已取消这次多选');
      });
      // 面板自身的点击不要被拾取逻辑吃掉
      panel.addEventListener('click', (event) => event.stopPropagation());
      document.documentElement.appendChild(panel);
    }
    panel.querySelector('.bp-count').textContent = `已选 ${batch.length} 个`;
    panel.querySelector('.bp-names').textContent = batchNames();
    if (!panel.classList.contains('is-open')) {
      // 强制一次回流，让淡入过渡从 opacity 0 开始（不用 rAF，避免和关闭竞态）
      void panel.offsetWidth;
      panel.classList.add('is-open');
    }
  }

  function hideBatchPanel() {
    const panel = document.getElementById(BATCH_ID);
    if (panel) panel.classList.remove('is-open');
  }

  /** 把批量选择合并成一条消息发出。 */
  async function sendBatch() {
    if (!batch.length) return;
    const items = batch.slice();
    batch.length = 0;
    hideBatchPanel();
    stopPicking();

    const text = items.length === 1 ? formatForAI(items[0]) : formatBatchForAI(items);
    const ok = await push(text);
    if (ok) {
      toast(items.length === 1 ? '已发送到 DSH 输入框' : `已发送 ${items.length} 个控件到 DSH 输入框`);
      return;
    }
    const copied = await copyText(text);
    toast(
      copied
        ? '没连上 DSH（插件未启动？），控件信息已复制到剪贴板，可直接粘贴'
        : '没连上 DSH，且自动复制失败，请打开控制台查看',
      4200,
    );
    if (!copied) console.log('[dsh-ui-picker]', text);
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = '__dsh_picker_overlay__';
    overlay.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
      'border:2px solid #2563eb', 'background:rgba(37,99,235,.12)',
      'box-sizing:border-box', 'pointer-events:none', 'z-index:2147483646',
      'transition:all .05s linear', 'display:none',
    ].join(';');
    tip = document.createElement('div');
    tip.id = '__dsh_picker_tip__';
    tip.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'max-width:min(520px,80vw)',
      'padding:5px 9px', 'border-radius:6px', 'background:#111827', 'color:#f3f4f6',
      'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      'pointer-events:none', 'z-index:2147483647', 'display:none',
      'box-shadow:0 4px 14px rgba(0,0,0,.3)',
    ].join(';');
    document.documentElement.append(overlay, tip);
  }

  function paint(el, event) {
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    let label = el.tagName.toLowerCase();
    if (el.id) label += `#${el.id}`;
    else if (el.classList.length) label += '.' + Array.from(el.classList).slice(0, 2).join('.');
    const role = roleOf(el);
    const text = clip(el.innerText || el.textContent || '', 40);
    tip.textContent = `${label}  ·  ${role}${text ? '  ·  ' + text : ''}`;
    tip.style.display = 'block';
    const left = Math.min(event.clientX + 14, innerWidth - 40);
    const top = Math.max(8, event.clientY - 34);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hidePaint() {
    if (overlay) overlay.style.display = 'none';
    if (tip) tip.style.display = 'none';
  }

  // ---------- 拾取事件 ----------
  /** 插件自己的 UI（悬浮按钮、批注标记、工具栏、评论气泡）不算页面控件。 */
  function isPickerUi(node) {
    return !!(node && node.closest && (node.closest('#__dsh_picker_fab__') || annoUiNode(node)));
  }

  /** 取事件最深目标：穿透 Shadow DOM（mousemove/click 的 target 会被重定向到宿主）。 */
  function deepTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (path && path.length) {
      for (const node of path) {
        if (node instanceof Element && node !== overlay && node !== tip) {
          if (isPickerUi(node)) continue;
          return node;
        }
      }
    }
    return event.target instanceof Element ? event.target : null;
  }

  function onMove(event) {
    if (!picking) return;
    cancelAnimationFrame(rafId);
    const x = event.clientX;
    const y = event.clientY;
    rafId = requestAnimationFrame(() => {
      const el = deepTarget(event) || document.elementFromPoint(x, y);
      if (!el || el === overlay || el === tip || isPickerUi(el)) return;
      hoverEl = el;
      paint(el, event);
    });
  }

  async function onPick(event) {
    if (!picking) return;
    // 点在自己的 UI 上：交给它们自己处理（按钮开菜单、标记回看评论），别当成页面控件
    if (isPickerUi(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const el = hoverEl || deepTarget(event) || event.target;

    if (!(el instanceof Element) || el === document.documentElement || el === document.body) {
      toast('没有选中有效控件，请重新点选');
      return;
    }

    const info = describe(el);

    // Shift 加选，或已经在多选过程中：先攒着，按 Enter 一次性发送
    if (event.shiftKey || batch.length > 0) {
      const duplicated = batch.some((item) => item.selector === info.selector && item.tag === info.tag);
      if (!duplicated) batch.push(info);
      hoverEl = null;
      hidePaint();
      renderBatchPanel();
      setFabState(true, `已选 ${batch.length}`);
      return;
    }

    // 单选：立即发送
    stopPicking();
    const text = formatForAI(info);
    const ok = await push(text);
    if (ok) {
      toast(`已发送到 DSH 输入框：${titleOf(info)}`);
      return;
    }
    const copied = await copyText(text);
    toast(
      copied
        ? '没连上 DSH（插件未启动？），控件信息已复制到剪贴板，可直接粘贴'
        : '没连上 DSH，且自动复制失败，请打开控制台查看',
      4200,
    );
    if (!copied) console.log('[dsh-ui-picker]', text);
  }

  function onKey(event) {
    if (event.key === 'Enter' && batch.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void sendBatch();
      return;
    }
    if (event.key === 'Escape' && (picking || batch.length > 0)) {
      const dropped = batch.length;
      stopPicking();
      toast(dropped ? `已取消，丢弃 ${dropped} 个已选控件` : '已取消拾取');
    }
  }

  function startPicking() {
    if (picking) return;
    if (annotating) stopAnnotating();
    hideModeMenu();
    picking = true;
    ensureOverlay();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onPick, true);
    document.addEventListener('keydown', onKey, true);
    document.body.style.cursor = 'crosshair';
    setFabState(true);
    toast('点选要修改的控件；按住 Shift 可连续多选（Esc 取消）', 3200);
  }

  function stopPicking() {
    picking = false;
    hoverEl = null;
    cancelAnimationFrame(rafId);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('keydown', onKey, true);
    document.body.style.cursor = '';
    batch.length = 0;
    hideBatchPanel();
    setFabState(false);
    hidePaint();
  }

  // ---------- 批注模式 ----------
  /**
   * 「批注」是「拾取」的另一半：
   *   拾取 = 说清「改哪个控件」（选择器 / 样式 / 组件名）；
   *   批注 = 说清「页面哪个位置、这块要改成什么」，还能一条条写评论。
   * 每条批注锚在文档坐标上（跟滚动无关），发送时压成编号清单写进 DSH 输入框。
   */
  let annotating = false;
  let annoSeq = 0;
  /** 每次页面加载生成一个前缀：DSH 侧按 uid 合并，同一条批注不会被算两遍 */
  const ANNO_UID = `a${Date.now().toString(36)}`;
  const annots = [];
  /**
   * 是否一直画出所有批注的元素轮廓。
   * 默认关（页面保持干净，跟设计稿一样只有编号点）；鼠标划过某个标记、
   * 或正在编辑它的评论时，单独描出它对应的元素。
   */
  let showRings = false;
  /** 鼠标正悬停的标记（临时描出它的元素轮廓） */
  let ringHoverId = 0;
  /** 临时隐藏所有标记，方便看清页面原貌 */
  let pinsHidden = false;
  /** 正在编辑评论的批注 id（0 = 没有） */
  let bubbleAnnoId = 0;
  let annoSyncFrame = 0;

  const ANNO_LAYER_ID = '__dsh_picker_anno_layer__';
  const ANNO_RING_ID = '__dsh_picker_anno_ring__';
  const ANNO_BAR_ID = '__dsh_picker_anno_bar__';
  const BUBBLE_ID = '__dsh_picker_anno_bubble__';
  /** 批注自己的 UI：落在这里的点击/移动不能当成「在页面上打点」 */
  const ANNO_SELF = `.dp-pin, #${ANNO_BAR_ID}, #${BUBBLE_ID}`;

  const ANNO_ICON = {
    target:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="6.6" stroke="currentColor" stroke-width="1.7"/>' +
      '<path d="M12 2.4v3.2M12 18.4v3.2M2.4 12h3.2M18.4 12h3.2" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round"/></svg>',
    eye:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12Z" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="12" r="2.7" stroke="currentColor" stroke-width="1.7"/></svg>',
    eyeOff:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M4 4.4 20 20.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
      '<path d="M9.6 6.3A9.7 9.7 0 0 1 12 5.9c5.8 0 9.4 6.2 9.4 6.2a17 17 0 0 1-3.1 3.7M6.5 8.1A17 17 0 0 0 2.6 12s3.6 6.2 9.4 6.2a9.4 9.4 0 0 0 3.5-.68" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M10.2 10.3a2.6 2.6 0 0 0 3.6 3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    copy:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2.4" stroke="currentColor" stroke-width="1.7"/>' +
      '<path d="M15.4 5.6a2 2 0 0 0-2-2H5.6a2 2 0 0 0-2 2v7.8a2 2 0 0 0 2 2" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    trash:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M4.4 6.6h15.2M9.4 6.6V4.7c0-.7.6-1.3 1.3-1.3h2.6c.7 0 1.3.6 1.3 1.3v1.9" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
      '<path d="M6.6 6.6l.8 12.1c.06.9.8 1.6 1.7 1.6h5.8c.9 0 1.64-.7 1.7-1.6l.8-12.1" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M10.6 10.4v6.1M13.4 10.4v6.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    check:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M5.2 12.6l4.3 4.2 9.3-9.6" stroke="currentColor" stroke-width="2.1" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round"/></svg>',
    grip:
      '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">' +
      '<circle cx="3" cy="3" r="1.15"/><circle cx="7" cy="3" r="1.15"/>' +
      '<circle cx="3" cy="7" r="1.15"/><circle cx="7" cy="7" r="1.15"/>' +
      '<circle cx="3" cy="11" r="1.15"/><circle cx="7" cy="11" r="1.15"/></svg>',
  };

  const ANNO_CSS = `
#__dsh_picker_anno_layer__ {
  position: fixed; inset: 0; z-index: 2147483644;
  pointer-events: none;
  font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
#__dsh_picker_anno_layer__.is-hidden { display: none; }
#__dsh_picker_anno_ring__ {
  position: fixed; inset: 0; z-index: 2147483642; pointer-events: none;
}
.dp-ring {
  position: absolute; box-sizing: border-box;
  border: 1.5px dashed rgba(47, 111, 237, .78);
  border-radius: 7px;
  box-shadow: 0 0 0 3px rgba(47, 111, 237, .08);
}
.dp-pin {
  position: fixed; width: 23px; height: 23px; padding: 0; margin: 0;
  transform: translate(-50%, -50%);
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; border: 2px solid #fff;
  background: #3b76f0; color: #fff;
  font: 700 11.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 3px 10px rgba(47, 111, 237, .42), 0 0 0 1px rgba(47, 111, 237, .22);
  cursor: pointer; pointer-events: auto; touch-action: none;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: transform .14s cubic-bezier(.2,.8,.2,1), box-shadow .14s ease, background-color .14s ease;
}
.dp-pin:hover { background: #2560e0; transform: translate(-50%, -50%) scale(1.14); }
.dp-pin.is-active {
  background: #1d4ed8;
  box-shadow: 0 0 0 4px rgba(47, 111, 237, .2), 0 6px 16px rgba(29, 78, 216, .45);
}
.dp-pin.is-dragging {
  transition: none; cursor: grabbing; transform: translate(-50%, -50%) scale(1.16);
}
.dp-pin.is-offscreen { opacity: 0; pointer-events: none; }
.dp-pin.has-comment::after {
  content: ''; position: absolute; right: -2px; bottom: -2px;
  width: 7px; height: 7px; border-radius: 50%;
  background: #34d399; border: 1.5px solid #fff;
}

#__dsh_picker_anno_bar__ {
  position: fixed;
  left: 50%;
  bottom: max(18px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex; align-items: center; gap: 2px;
  padding: 6px 8px 6px 6px;
  border-radius: 13px;
  border: 1px solid rgba(255, 255, 255, .08);
  background: rgba(17, 24, 39, .93);
  -webkit-backdrop-filter: blur(16px) saturate(1.5);
  backdrop-filter: blur(16px) saturate(1.5);
  box-shadow: 0 18px 42px -18px rgba(15, 23, 42, .75);
  color: #e5e7eb;
  font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-user-select: none; user-select: none;
}
#__dsh_picker_anno_bar__.is-dragging { transition: none; }
#__dsh_picker_anno_bar__ .dp-grip {
  display: flex; align-items: center; justify-content: center;
  width: 18px; height: 24px; margin-right: 2px;
  color: rgba(229, 231, 235, .34); cursor: grab; touch-action: none;
}
#__dsh_picker_anno_bar__ .dp-grip:active { cursor: grabbing; }
#__dsh_picker_anno_bar__ .dp-label {
  padding: 0 10px 0 2px; white-space: nowrap; font-weight: 600; letter-spacing: .01em;
}
#__dsh_picker_anno_bar__ .dp-sep {
  width: 1px; height: 16px; margin: 0 4px; background: rgba(255, 255, 255, .12);
}
#__dsh_picker_anno_bar__ .dp-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 27px; height: 27px; padding: 0; border: 0; border-radius: 7px;
  background: transparent; color: rgba(229, 231, 235, .82);
  cursor: pointer; transition: background-color .14s ease, color .14s ease, opacity .14s ease;
  font: inherit;
}
#__dsh_picker_anno_bar__ .dp-icon:hover { background: rgba(255, 255, 255, .1); color: #fff; }
#__dsh_picker_anno_bar__ .dp-icon.is-off { color: rgba(229, 231, 235, .42); }
#__dsh_picker_anno_bar__ .dp-icon:disabled { opacity: .32; cursor: default; }
#__dsh_picker_anno_bar__ .dp-icon:disabled:hover { background: transparent; color: rgba(229, 231, 235, .82); }
#__dsh_picker_anno_bar__ .dp-close { margin-left: 2px; }
#__dsh_picker_anno_bar__ .dp-send {
  height: 27px; margin-left: 2px; padding: 0 13px;
  border: 0; border-radius: 8px; background: #3b76f0; color: #fff;
  font: inherit; font-weight: 600; cursor: pointer;
  transition: background-color .14s ease, opacity .14s ease;
}
#__dsh_picker_anno_bar__ .dp-send:hover { background: #2f68e6; }
#__dsh_picker_anno_bar__ .dp-send:disabled { opacity: .45; cursor: default; }

#__dsh_picker_anno_bubble__ {
  position: fixed; z-index: 2147483647;
  display: none;
  align-items: center; gap: 6px;
  width: min(320px, 88vw);
  padding: 6px 6px 6px 8px;
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, .1);
  background: rgba(255, 255, 255, .98);
  box-shadow: 0 16px 36px -14px rgba(15, 23, 42, .45);
  font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
#__dsh_picker_anno_bubble__.is-open { display: flex; }
#__dsh_picker_anno_bubble__ .dp-input {
  flex: 1 1 auto; min-width: 0; height: 26px;
  padding: 0; margin: 0; border: 0; outline: none; background: transparent;
  color: #0f172a; font: inherit;
}
#__dsh_picker_anno_bubble__ .dp-input::placeholder { color: rgba(15, 23, 42, .35); }
#__dsh_picker_anno_bubble__ .dp-ok {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; flex: none;
  border: 0; border-radius: 50%; background: #3b76f0; color: #fff; cursor: pointer;
  transition: background-color .14s ease, transform .14s ease;
}
#__dsh_picker_anno_bubble__ .dp-ok:hover { background: #2560e0; transform: scale(1.06); }
#__dsh_picker_anno_bubble__ .dp-remove {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; flex: none;
  border: 0; border-radius: 8px; background: transparent;
  color: rgba(15, 23, 42, .38); cursor: pointer;
  transition: background-color .14s ease, color .14s ease;
}
#__dsh_picker_anno_bubble__ .dp-remove:hover { background: rgba(239, 68, 68, .1); color: #dc2626; }

@media (prefers-color-scheme: dark) {
  #__dsh_picker_anno_bubble__ {
    border-color: rgba(255, 255, 255, .1);
    background: rgba(17, 24, 39, .97);
    box-shadow: 0 18px 40px -14px rgba(0, 0, 0, .75);
  }
  #__dsh_picker_anno_bubble__ .dp-input { color: #e5e7eb; }
  #__dsh_picker_anno_bubble__ .dp-input::placeholder { color: rgba(226, 232, 240, .38); }
  #__dsh_picker_anno_bubble__ .dp-remove { color: rgba(226, 232, 240, .45); }
  #__dsh_picker_anno_bubble__ .dp-remove:hover { background: rgba(239, 68, 68, .18); color: #fca5a5; }
}
@media (prefers-reduced-motion: reduce) {
  .dp-pin, #__dsh_picker_anno_bar__ .dp-icon, #__dsh_picker_anno_bar__ .dp-send,
  #__dsh_picker_anno_bubble__ .dp-ok { transition: none; }
}
`;

  function ensureAnnoStyle() {
    if (document.getElementById('__dsh_picker_anno_css__')) return;
    const style = document.createElement('style');
    style.id = '__dsh_picker_anno_css__';
    style.textContent = ANNO_CSS;
    document.head.appendChild(style);
  }

  /** 事件目标是否落在批注 UI 自己身上。 */
  function annoUiNode(node) {
    return !!(node && node.closest && node.closest(ANNO_SELF));
  }

  const scrollLeft = () => window.scrollX || window.pageXOffset || 0;
  const scrollTop = () => window.scrollY || window.pageYOffset || 0;

  /** 视口坐标 → 文档坐标（批注锚点用文档坐标，滚动后仍然贴在同一块内容上）。 */
  function docPoint(clientX, clientY) {
    return { x: Math.round(clientX + scrollLeft()), y: Math.round(clientY + scrollTop()) };
  }

  /** 穿透 shadow root 的命中测试。 */
  function deepElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard < 6) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
      guard += 1;
    }
    return el instanceof Element ? el : null;
  }

  function targetAt(x, y) {
    const el = deepElementAt(x, y);
    if (!el || annoUiNode(el)) return null;
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  function ensureAnnoLayer() {
    ensureAnnoStyle();
    let layer = document.getElementById(ANNO_LAYER_ID);
    if (!layer) {
      layer = document.createElement('div');
      layer.id = ANNO_LAYER_ID;
      document.documentElement.appendChild(layer);
    }
    if (!document.getElementById(ANNO_RING_ID)) {
      const rings = document.createElement('div');
      rings.id = ANNO_RING_ID;
      document.documentElement.appendChild(rings);
    }
    return layer;
  }

  function annoIndexById(id) {
    return annots.findIndex((item) => item.id === id);
  }

  /** 把一条批注钉在页面上：编号点 + 可拖动。 */
  function makePin(anno, index) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'dp-pin';
    pin.dataset.annoId = String(anno.id);
    pin.textContent = String(index + 1);
    if (anno.comment) pin.classList.add('has-comment');
    if (anno.id === bubbleAnnoId) pin.classList.add('is-active');
    pin.title = anno.comment
      ? `${index + 1}. ${clip(anno.comment, 60)}`
      : `${index + 1}. 点这里写评论`;

    let drag = null;
    let suppressClickUntil = 0;

    pin.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.stopPropagation();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: anno.x,
        y: anno.y,
        moved: false,
      };
      try {
        pin.setPointerCapture(event.pointerId);
      } catch (_) {
        /* 老浏览器忽略 */
      }
    });

    pin.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      drag.moved = true;
      pin.classList.add('is-dragging');
      anno.x = Math.round(drag.x + dx);
      anno.y = Math.round(drag.y + dy);
      syncAnnoLayout();
    });

    const endDrag = (event) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      pin.classList.remove('is-dragging');
      try {
        pin.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* 忽略 */
      }
      if (moved) suppressClickUntil = Date.now() + 260;
    };
    pin.addEventListener('pointerup', endDrag);
    pin.addEventListener('pointercancel', endDrag);

    pin.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressClickUntil) return;
      openBubble(anno);
    });

    // 划过标记时临时描出它锚定的元素：既能核对选对了没有，又不打扰页面
    pin.addEventListener('mouseenter', () => {
      ringHoverId = anno.id;
      syncRings();
    });
    pin.addEventListener('mouseleave', () => {
      if (ringHoverId === anno.id) ringHoverId = 0;
      syncRings();
    });

    return pin;
  }

  function renderPins() {
    const layer = ensureAnnoLayer();
    layer.textContent = '';
    annots.forEach((anno, index) => layer.appendChild(makePin(anno, index)));
    layer.classList.toggle('is-hidden', pinsHidden);
    syncAnnoLayout();
  }

  /** 滚动 / 缩放 / 拖拽后重新对齐钉子、轮廓和评论气泡。 */
  function syncAnnoLayout() {
    const layer = document.getElementById(ANNO_LAYER_ID);
    if (layer) {
      const sx = scrollLeft();
      const sy = scrollTop();
      for (const pin of Array.from(layer.children)) {
        const anno = annots.find((item) => String(item.id) === pin.dataset.annoId);
        if (!anno) continue;
        const left = anno.x - sx;
        const top = anno.y - sy;
        pin.style.left = `${left}px`;
        pin.style.top = `${top}px`;
        pin.classList.toggle(
          'is-offscreen',
          left < -40 || top < -40 || left > innerWidth + 40 || top > innerHeight + 40,
        );
      }
    }
    syncRings();
    positionBubble();
  }

  function syncRings() {
    const host = document.getElementById(ANNO_RING_ID);
    if (!host) return;
    const wanted = pinsHidden
      ? []
      : annots.filter(
          (anno) => showRings || anno.id === ringHoverId || anno.id === bubbleAnnoId,
        );
    if (!wanted.length) {
      while (host.firstChild) host.removeChild(host.firstChild);
      return;
    }
    while (host.children.length < wanted.length) host.appendChild(document.createElement('div'));
    while (host.children.length > wanted.length) host.lastElementChild.remove();
    wanted.forEach((anno, index) => {
      const ring = host.children[index];
      ring.className = 'dp-ring';
      const rect = anno.el && anno.el.isConnected ? anno.el.getBoundingClientRect() : null;
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        ring.style.display = 'none';
        return;
      }
      ring.style.display = 'block';
      ring.style.left = `${Math.round(rect.left)}px`;
      ring.style.top = `${Math.round(rect.top)}px`;
      ring.style.width = `${Math.round(rect.width)}px`;
      ring.style.height = `${Math.round(rect.height)}px`;
    });
  }

  function scheduleAnnoSync() {
    if (annoSyncFrame || !annots.length) return;
    annoSyncFrame = requestAnimationFrame(() => {
      annoSyncFrame = 0;
      syncAnnoLayout();
    });
  }

  // ---------- 批注工具栏 ----------
  function attachBarDrag(bar) {
    const grip = bar.querySelector('.dp-grip');
    let drag = null;

    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = bar.getBoundingClientRect();
      bar.classList.add('is-dragging');
      bar.style.left = `${rect.left}px`;
      bar.style.top = `${rect.top}px`;
      bar.style.bottom = 'auto';
      bar.style.transform = 'none';
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      try {
        grip.setPointerCapture(event.pointerId);
      } catch (_) {
        /* 忽略 */
      }
    });

    grip.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const left = Math.min(
        Math.max(6, drag.left + (event.clientX - drag.x)),
        Math.max(6, innerWidth - bar.offsetWidth - 6),
      );
      const top = Math.min(
        Math.max(6, drag.top + (event.clientY - drag.y)),
        Math.max(6, innerHeight - bar.offsetHeight - 6),
      );
      bar.style.left = `${left}px`;
      bar.style.top = `${top}px`;
    });

    const endDrag = (event) => {
      if (!drag) return;
      drag = null;
      bar.classList.remove('is-dragging');
      try {
        grip.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* 忽略 */
      }
    };
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);
  }

  function ensureAnnoBar() {
    ensureAnnoStyle();
    let bar = document.getElementById(ANNO_BAR_ID);
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = ANNO_BAR_ID;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '页面批注');
    bar.innerHTML =
      `<span class="dp-grip" title="拖动移动工具栏">${ANNO_ICON.grip}</span>` +
      '<span class="dp-label">正在批注</span>' +
      '<span class="dp-sep"></span>' +
      `<button type="button" class="dp-icon dp-rings" title="隐藏元素轮廓">${ANNO_ICON.target}</button>` +
      `<button type="button" class="dp-icon dp-eye" title="隐藏标记">${ANNO_ICON.eyeOff}</button>` +
      `<button type="button" class="dp-icon dp-copy" title="复制批注文本">${ANNO_ICON.copy}</button>` +
      `<button type="button" class="dp-icon dp-trash" title="清空批注">${ANNO_ICON.trash}</button>` +
      '<button type="button" class="dp-send" title="发送到 DSH（Ctrl+Enter）">发送</button>' +
      `<button type="button" class="dp-icon dp-close" title="退出批注（标记保留）">${ANNO_ICON.close}</button>`;

    // 工具栏自己的事件不要漏到页面（否则会顺手钉一条批注）
    for (const type of ['click', 'pointerdown', 'pointerup', 'mousedown']) {
      bar.addEventListener(type, (event) => event.stopPropagation());
    }

    bar.querySelector('.dp-rings').addEventListener('click', () => {
      showRings = !showRings;
      renderAnnoBar();
      syncAnnoLayout();
    });
    bar.querySelector('.dp-eye').addEventListener('click', () => {
      pinsHidden = !pinsHidden;
      renderAnnoBar();
      renderPins();
    });
    bar.querySelector('.dp-copy').addEventListener('click', () => void copyAnnotations());
    bar.querySelector('.dp-trash').addEventListener('click', () => {
      const count = annots.length;
      if (!count) return;
      clearAnnotations();
      toast(`已清空 ${count} 条批注`);
    });
    bar.querySelector('.dp-send').addEventListener('click', () => void sendAnnotations());
    bar.querySelector('.dp-close').addEventListener('click', () => {
      stopAnnotating();
      toast(annots.length ? `已退出批注，${annots.length} 条标记保留在页面上` : '已退出批注');
    });

    attachBarDrag(bar);
    document.documentElement.appendChild(bar);
    return bar;
  }

  function renderAnnoBar() {
    // 不在批注模式时不要顺手把工具栏建出来（关闭气泡/清空批注也会走到这里）
    if (!annotating) {
      const stale = document.getElementById(ANNO_BAR_ID);
      if (stale) stale.remove();
      return;
    }
    const bar = ensureAnnoBar();
    const count = annots.length;
    bar.querySelector('.dp-label').textContent = count ? `正在批注 · ${count}` : '正在批注';

    const ringsBtn = bar.querySelector('.dp-rings');
    ringsBtn.classList.toggle('is-off', !showRings);
    ringsBtn.title = showRings ? '隐藏元素轮廓' : '显示元素轮廓';

    const eyeBtn = bar.querySelector('.dp-eye');
    eyeBtn.innerHTML = pinsHidden ? ANNO_ICON.eye : ANNO_ICON.eyeOff;
    eyeBtn.title = pinsHidden ? '显示标记' : '隐藏标记';
    eyeBtn.classList.toggle('is-off', pinsHidden);

    bar.querySelector('.dp-send').textContent = count ? `发送 ${count}` : '发送';
    bar.querySelector('.dp-send').disabled = count === 0;
    bar.querySelector('.dp-copy').disabled = count === 0;
    bar.querySelector('.dp-trash').disabled = count === 0;
  }

  // ---------- 评论气泡 ----------
  function ensureBubble() {
    ensureAnnoStyle();
    let bubble = document.getElementById(BUBBLE_ID);
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.id = BUBBLE_ID;
    bubble.innerHTML =
      '<input class="dp-input" type="text" maxlength="200" placeholder="添加评论…" ' +
      'aria-label="批注内容" title="写完按 Enter 保存">' +
      `<button type="button" class="dp-ok" title="保存（Enter）">${ANNO_ICON.check}</button>` +
      `<button type="button" class="dp-remove" title="删除这条批注">${ANNO_ICON.trash}</button>`;

    for (const type of ['click', 'pointerdown', 'pointerup', 'mousedown']) {
      bubble.addEventListener(type, (event) => event.stopPropagation());
    }

    const input = bubble.querySelector('.dp-input');
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        closeBubble(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeBubble(true);
      }
    });
    bubble.querySelector('.dp-ok').addEventListener('click', () => closeBubble(true));
    bubble.querySelector('.dp-remove').addEventListener('click', () => {
      const id = bubbleAnnoId;
      closeBubble(false);
      if (id) removeAnnotation(id);
    });
    document.documentElement.appendChild(bubble);
    return bubble;
  }

  function openBubble(anno) {
    const bubble = ensureBubble();
    bubbleAnnoId = anno.id;
    const input = bubble.querySelector('.dp-input');
    input.value = anno.comment || '';
    bubble.classList.add('is-open');
    renderPins();
    positionBubble();
    try {
      input.focus({ preventScroll: true });
      input.select();
    } catch (_) {
      input.focus();
    }
  }

  function closeBubble(save) {
    const bubble = document.getElementById(BUBBLE_ID);
    if (!bubble || !bubble.classList.contains('is-open')) return;
    if (save) {
      const anno = annots.find((item) => item.id === bubbleAnnoId);
      if (anno) {
        anno.comment = (bubble.querySelector('.dp-input').value || '').trim().slice(0, 200);
      }
    }
    bubble.classList.remove('is-open');
    bubbleAnnoId = 0;
    renderPins();
    renderAnnoBar();
  }

  function positionBubble() {
    const bubble = document.getElementById(BUBBLE_ID);
    if (!bubble || !bubble.classList.contains('is-open')) return;
    const anno = annots.find((item) => item.id === bubbleAnnoId);
    if (!anno) return;
    const width = bubble.offsetWidth || 320;
    const height = bubble.offsetHeight || 40;
    const pinLeft = anno.x - scrollLeft();
    const pinTop = anno.y - scrollTop();
    const left = Math.min(Math.max(8, pinLeft - 24), Math.max(8, innerWidth - width - 8));
    const above = pinTop - height - 14;
    const top =
      above > 8 ? above : Math.min(pinTop + 17, Math.max(8, innerHeight - height - 8));
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
  }

  // ---------- 批注数据 ----------
  function addAnnotation(clientX, clientY) {
    const el = targetAt(clientX, clientY);
    const point = docPoint(clientX, clientY);
    let offset = null;
    if (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        offset = {
          x: Math.round(((clientX - rect.left) / rect.width) * 100),
          y: Math.round(((clientY - rect.top) / rect.height) * 100),
        };
      }
    }
    annoSeq += 1;
    const anno = {
      id: annoSeq,
      x: point.x,
      y: point.y,
      offset,
      comment: '',
      el,
      target: el ? describe(el) : null,
    };
    annots.push(anno);
    return anno;
  }

  function removeAnnotation(id) {
    const index = annoIndexById(id);
    if (index < 0) return;
    annots.splice(index, 1);
    if (bubbleAnnoId === id) bubbleAnnoId = 0;
    renderPins();
    renderAnnoBar();
  }

  function clearAnnotations() {
    const bubble = document.getElementById(BUBBLE_ID);
    if (bubble) bubble.classList.remove('is-open');
    bubbleAnnoId = 0;
    annots.length = 0;
    renderPins();
    renderAnnoBar();
  }

  function annotationTitle(anno) {
    const target = anno.target;
    if (!target) return '页面空白区域';
    let title = target.tag;
    if (target.id) title += `#${target.id}`;
    if (target.classes.length) {
      title += '.' + target.classes.slice(0, 2).join('.');
    }
    const name =
      target.text ||
      target.attrs.placeholder ||
      target.attrs['aria-label'] ||
      target.attrs.title ||
      '';
    if (name) title += `「${clip(name, 24)}」`;
    if (target.component && target.component.name) title += ` · ${target.component.name}`;
    return title;
  }

  /**
   * 给每条批注生成一个 26×26 的小缩略图（data URL）：
   * 元素是图片（或内部有图片）就裁一张真图，否则按计算样式画一个小色块示意图。
   * 缩略图只在 DSH 的注释卡片里显示，尺寸很小，几 KB。
   */
  const THUMB_PX = 56;
  let thumbCanvas = null;

  function drawCover(ctx, source, sw, sh, size) {
    const scale = Math.max(size / sw, size / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(source, (size - dw) / 2, (size - dh) / 2, dw, dh);
  }

  function wireframeThumb(ctx, el, size) {
    const styles = getComputedStyle(el);
    const bg = styles.backgroundColor;
    const opaque = bg && !/^rgba?\(\s*0,\s*0,\s*0,\s*0\)/.test(bg) && bg !== 'transparent';
    ctx.fillStyle = opaque ? bg : '#eef2f7';
    ctx.fillRect(0, 0, size, size);
    // 顶部一条浅色带 + 两条文字行，看起来像一块界面
    ctx.fillStyle = 'rgba(15, 23, 42, .10)';
    ctx.fillRect(0, 0, size, Math.round(size * 0.10));
    ctx.fillStyle = 'rgba(15, 23, 42, .16)';
    ctx.fillRect(size * 0.14, size * 0.34, size * 0.62, Math.max(2, size * 0.07));
    ctx.fillStyle = 'rgba(15, 23, 42, .10)';
    ctx.fillRect(size * 0.14, size * 0.54, size * 0.44, Math.max(2, size * 0.07));
    ctx.strokeStyle = 'rgba(15, 23, 42, .12)';
    ctx.lineWidth = Math.max(1, size * 0.02);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, size - ctx.lineWidth, size - ctx.lineWidth);
  }

  function thumbFor(anno) {
    if (anno.thumb !== undefined) return anno.thumb;
    anno.thumb = null;
    try {
      const el = anno.el;
      if (!el || !el.isConnected) return null;
      const size = THUMB_PX;
      if (!thumbCanvas) thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = size;
      thumbCanvas.height = size;
      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, size, size);

      // 1) 真图：元素本身是 <img>，或内部第一个已加载的 <img>
      const img = el.tagName === 'IMG' ? el : el.querySelector && el.querySelector('img');
      if (img && img.complete && img.naturalWidth > 0) {
        try {
          drawCover(ctx, img, img.naturalWidth, img.naturalHeight, size);
          anno.thumb = thumbCanvas.toDataURL('image/png');
          return anno.thumb;
        } catch (_) {
          // 跨域图片会污染画布，toDataURL 抛错：退回示意图
          ctx.clearRect(0, 0, size, size);
        }
      }
      wireframeThumb(ctx, el, size);
      anno.thumb = thumbCanvas.toDataURL('image/png');
    } catch (_) {
      anno.thumb = null;
    }
    return anno.thumb;
  }

  /** 页面注释 → 桥接 payload（DSH 侧据此渲染「N 条注释」卡片）。 */
  function annotationPayload(list) {
    return {
      kind: 'annotations',
      page: { title: document.title, url: location.href, w: innerWidth, h: innerHeight },
      annotations: list.map((anno, index) => ({
        uid: `${ANNO_UID}-${anno.id}`,
        no: index + 1,
        tag: anno.target ? anno.target.tag : 'div',
        label: annotationTitle(anno),
        selector: anno.target ? anno.target.selector : null,
        comment: anno.comment || '',
        thumb: thumbFor(anno),
        x: anno.x,
        y: anno.y,
        offset: anno.offset || null,
      })),
    };
  }

  /** 多条批注 → 一条给 AI 看的编号清单（与 client.js 的 formatAnnotationsBlock 同格式）。 */
  function formatAnnotationsForAI(list) {
    const items = list && list.length ? list : annots;
    const first = items[0];
    const page = first && first.target ? first.target.page : { title: document.title, url: location.href };
    const lines = [];
    lines.push(`【页面批注】共 ${items.length} 条`);
    lines.push(`页面：${page.title || '(无标题)'} — ${page.url}`);
    lines.push(
      `视口：${innerWidth} × ${innerHeight}　页面坐标以文档左上角为原点（不随滚动变化）`,
    );
    lines.push('');
    items.forEach((anno, index) => {
      const facts = [`页面坐标 (${anno.x}, ${anno.y})`];
      if (anno.offset && anno.target) {
        facts.push(`元素内 (${anno.offset.x}%, ${anno.offset.y}%)`);
      }
      lines.push(`${index + 1}. ${annotationTitle(anno)}　${facts.join('　')}`);
      lines.push(`   批注：${anno.comment ? clip(anno.comment, 200) : '（未填写具体描述）'}`);
    });
    lines.push('');
    lines.push('修改需求：');
    return lines.join('\n');
  }

  async function sendAnnotations() {
    if (!annots.length) {
      toast('还没有批注：点页面任意位置钉一个编号标记', 2800);
      return;
    }
    const list = annots.slice();
    closeBubble(true);
    const text = formatAnnotationsForAI(list);
    const ok = await push(text, annotationPayload(list));
    if (ok) {
      clearAnnotations();
      stopAnnotating();
      toast(`已发送 ${list.length} 条批注 → DSH 输入框上方的「${list.length} 条注释」`);
      return;
    }
    const copied = await copyText(text);
    toast(
      copied
        ? '没连上 DSH（插件未启动？），批注文本已复制到剪贴板，可直接粘贴'
        : '没连上 DSH，且自动复制失败，请打开控制台查看',
      4200,
    );
    if (!copied) console.log('[dsh-ui-picker]', text);
  }

  async function copyAnnotations() {
    if (!annots.length) return;
    closeBubble(true);
    const ok = await copyText(formatAnnotationsForAI(annots.slice()));
    toast(ok ? '批注文本已复制到剪贴板' : '复制失败，请打开控制台查看', 2400);
  }

  // ---------- 批注模式事件 ----------
  function onAnnoMove(event) {
    if (!annotating) return;
    cancelAnimationFrame(rafId);
    const x = event.clientX;
    const y = event.clientY;
    const target = event.target;
    rafId = requestAnimationFrame(() => {
      if (annoUiNode(target)) {
        hidePaint();
        return;
      }
      const el = targetAt(x, y);
      if (!el) {
        hidePaint();
        return;
      }
      hoverEl = el;
      paint(el, event);
    });
  }

  function onAnnoClick(event) {
    if (!annotating) return;
    // 点在自己的 UI 上：交给 UI 自己处理，别顺手钉一条批注
    if (annoUiNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const anno = addAnnotation(event.clientX, event.clientY);
    renderPins();
    renderAnnoBar();
    hidePaint();
    openBubble(anno);
  }

  function onAnnoKey(event) {
    if (event.key === 'Escape') {
      if (bubbleAnnoId) {
        event.preventDefault();
        event.stopPropagation();
        closeBubble(true);
        return;
      }
      if (annotating) {
        event.preventDefault();
        event.stopPropagation();
        stopAnnotating();
        toast(annots.length ? `已退出批注，${annots.length} 条标记保留在页面上` : '已退出批注');
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void sendAnnotations();
    }
  }

  function startAnnotating() {
    if (annotating) return;
    if (picking) stopPicking();
    hideModeMenu();
    annotating = true;
    ensureAnnoLayer();
    ensureAnnoBar();
    renderAnnoBar();
    renderPins();
    document.addEventListener('mousemove', onAnnoMove, true);
    document.addEventListener('click', onAnnoClick, true);
    document.addEventListener('keydown', onAnnoKey, true);
    document.body.style.cursor = 'crosshair';
    const fab = document.getElementById(FAB_ID);
    if (fab) fab.style.display = 'none';
    toast(
      annots.length
        ? `继续批注：页面上还有 ${annots.length} 条标记`
        : '点页面任意位置钉一个标记，写完评论按 Enter；Esc 退出',
      3400,
    );
  }

  function stopAnnotating(options) {
    const keep = !options || options.keep !== false;
    if (!annotating) return;
    annotating = false;
    document.removeEventListener('mousemove', onAnnoMove, true);
    document.removeEventListener('click', onAnnoClick, true);
    document.removeEventListener('keydown', onAnnoKey, true);
    document.body.style.cursor = '';
    hoverEl = null;
    hidePaint();
    const bar = document.getElementById(ANNO_BAR_ID);
    if (bar) bar.remove();
    closeBubble(true);
    const fab = document.getElementById(FAB_ID);
    if (fab) fab.style.display = '';
    if (!keep) clearAnnotations();
    else renderPins();
  }

  // ---------- 悬浮按钮（克制的玻璃拟态小件，不抢页面视觉） ----------
  const FAB_ID = '__dsh_picker_fab__';
  const FAB_CSS = `
#__dsh_picker_fab__ {
  position: fixed;
  right: max(18px, env(safe-area-inset-right));
  bottom: max(18px, env(safe-area-inset-bottom));
  z-index: 2147483645;
  display: inline-flex;
  align-items: center;
  height: 33px;
  padding: 0 9px;
  margin: 0;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, .09);
  background: rgba(255, 255, 255, .74);
  -webkit-backdrop-filter: blur(14px) saturate(1.7);
  backdrop-filter: blur(14px) saturate(1.7);
  color: rgba(15, 23, 42, .62);
  box-shadow: 0 1px 2px rgba(15, 23, 42, .05), 0 6px 18px -6px rgba(15, 23, 42, .18);
  cursor: grab;
  opacity: .68;
  touch-action: none;
  transform: translate(var(--dsh-picker-shift, 0px), 0);
  transition: opacity .2s ease, box-shadow .2s ease, transform .2s cubic-bezier(.2,.8,.2,1),
              background-color .2s ease, border-color .2s ease, color .2s ease;
  font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  letter-spacing: .01em;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
#__dsh_picker_fab__:hover {
  opacity: 1;
  transform: translate(var(--dsh-picker-shift, 0px), -1px);
  box-shadow: 0 2px 4px rgba(15, 23, 42, .06), 0 14px 32px -10px rgba(15, 23, 42, .28);
}
#__dsh_picker_fab__:active {
  cursor: grabbing;
  transform: translate(var(--dsh-picker-shift, 0px), 0) scale(.97);
}
#__dsh_picker_fab__.is-dragging {
  opacity: 1;
  cursor: grabbing;
  transition: none !important;
  transform: translate(var(--dsh-picker-shift, 0px), 0) scale(1.04);
  box-shadow: 0 3px 8px rgba(15, 23, 42, .12), 0 20px 42px -14px rgba(15, 23, 42, .38);
}
#__dsh_picker_fab__:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, .22), 0 6px 18px -6px rgba(15, 23, 42, .2);
}
#__dsh_picker_fab__ svg { display: block; flex: none; }
#__dsh_picker_fab__ .dsh-picker-label {
  max-width: 0;
  margin-left: 0;
  overflow: hidden;
  white-space: nowrap;
  opacity: 0;
  transition: max-width .24s cubic-bezier(.2,.8,.2,1), opacity .16s ease, margin-left .24s cubic-bezier(.2,.8,.2,1);
}
#__dsh_picker_fab__:hover .dsh-picker-label,
#__dsh_picker_fab__.is-active .dsh-picker-label,
#__dsh_picker_fab__.is-teaser .dsh-picker-label {
  max-width: 110px;
  margin-left: 7px;
  opacity: 1;
}
#__dsh_picker_fab__.is-active {
  opacity: 1;
  color: #1d4ed8;
  border-color: rgba(37, 99, 235, .28);
  background: rgba(239, 246, 255, .9);
  box-shadow: 0 0 0 4px rgba(37, 99, 235, .08), 0 8px 22px -8px rgba(37, 99, 235, .45);
}
@media (prefers-color-scheme: dark) {
  #__dsh_picker_fab__ {
    border-color: rgba(255, 255, 255, .10);
    background: rgba(17, 24, 39, .72);
    color: rgba(226, 232, 240, .72);
    box-shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 10px 28px -8px rgba(0, 0, 0, .6);
  }
  #__dsh_picker_fab__.is-active {
    color: #93c5fd;
    background: rgba(30, 58, 138, .62);
    border-color: rgba(147, 197, 253, .3);
  }
}
@media (prefers-reduced-motion: reduce) {
  #__dsh_picker_fab__, #__dsh_picker_fab__ .dsh-picker-label { transition: none; }
}

/* 模式菜单：单击悬浮按钮先选「选取控件 / 页面批注」 */
#__dsh_picker_menu__ {
  position: fixed;
  z-index: 2147483647;
  width: 236px;
  padding: 5px;
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, .09);
  background: rgba(255, 255, 255, .95);
  -webkit-backdrop-filter: blur(16px) saturate(1.7);
  backdrop-filter: blur(16px) saturate(1.7);
  box-shadow: 0 18px 40px -16px rgba(15, 23, 42, .4);
  color: #0f172a;
  font: 500 12.5px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  animation: dsh-picker-menu-in .13s cubic-bezier(.2, .8, .2, 1);
}
@keyframes dsh-picker-menu-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
#__dsh_picker_menu__ .dp-menu-item {
  display: block;
  width: 100%;
  padding: 7px 9px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color .12s ease;
}
#__dsh_picker_menu__ .dp-menu-item:hover { background: rgba(37, 99, 235, .09); }
#__dsh_picker_menu__ .dp-menu-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 650;
  font-size: 12.5px;
}
#__dsh_picker_menu__ .dp-menu-desc {
  display: block;
  margin-top: 2px;
  color: rgba(15, 23, 42, .52);
  font-size: 11.5px;
  font-weight: 400;
}
#__dsh_picker_menu__ .dp-menu-kbd {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: none;
  font: 500 10.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: rgba(15, 23, 42, .38);
  letter-spacing: .02em;
}
@media (prefers-color-scheme: dark) {
  #__dsh_picker_menu__ {
    border-color: rgba(255, 255, 255, .1);
    background: rgba(17, 24, 39, .95);
    color: #e5e7eb;
    box-shadow: 0 18px 40px -14px rgba(0, 0, 0, .75);
  }
  #__dsh_picker_menu__ .dp-menu-item:hover { background: rgba(147, 197, 253, .13); }
  #__dsh_picker_menu__ .dp-menu-desc { color: rgba(226, 232, 240, .55); }
  #__dsh_picker_menu__ .dp-menu-kbd { color: rgba(226, 232, 240, .4); }
}
@media (prefers-reduced-motion: reduce) {
  #__dsh_picker_menu__ { animation: none; }
}
`;

  function injectFabCss() {
    if (document.getElementById('__dsh_picker_fab_css__')) return;
    const style = document.createElement('style');
    style.id = '__dsh_picker_fab_css__';
    style.textContent = FAB_CSS;
    document.head.appendChild(style);
  }

  // ---------- 模式菜单（单击悬浮按钮展开） ----------
  const MENU_ID = '__dsh_picker_menu__';

  function hideModeMenu() {
    const menu = document.getElementById(MENU_ID);
    if (menu) menu.remove();
    document.removeEventListener('click', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }

  function onMenuOutside(event) {
    const menu = document.getElementById(MENU_ID);
    if (menu && menu.contains(event.target)) return;
    const fab = document.getElementById(FAB_ID);
    if (fab && fab.contains(event.target)) return;
    hideModeMenu();
  }

  function onMenuKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hideModeMenu();
    }
  }

  function toggleModeMenu() {
    if (document.getElementById(MENU_ID)) {
      hideModeMenu();
      return;
    }
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    injectFabCss();

    const rect = fab.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.innerHTML =
      '<button type="button" class="dp-menu-item" data-mode="pick" role="menuitem">' +
      '<span class="dp-menu-head">选取控件<span class="dp-menu-kbd">Ctrl ⇧ P</span></span>' +
      '<span class="dp-menu-desc">点一下控件，把选择器和样式发给 AI</span>' +
      '</button>' +
      '<button type="button" class="dp-menu-item" data-mode="annotate" role="menuitem">' +
      '<span class="dp-menu-head">页面批注<span class="dp-menu-kbd">Ctrl ⇧ A</span></span>' +
      '<span class="dp-menu-desc">钉编号标记，逐条写要改的地方</span>' +
      '</button>';

    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    menu.addEventListener('click', (event) => {
      const item = event.target.closest && event.target.closest('.dp-menu-item');
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      hideModeMenu();
      if (item.dataset.mode === 'annotate') startAnnotating();
      else startPicking();
    });

    document.documentElement.appendChild(menu);

    // 贴着按钮摆：默认在按钮上方，右对齐，越界时夹回视口
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, innerWidth - width - 8));
    const top =
      rect.top - height - 10 > 8
        ? rect.top - height - 10
        : Math.min(rect.bottom + 10, Math.max(8, innerHeight - height - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    // 放到下一个事件循环再挂外部监听，避免被「打开菜单的这次点击」立刻关掉
    setTimeout(() => {
      document.addEventListener('click', onMenuOutside, true);
      document.addEventListener('keydown', onMenuKey, true);
    }, 0);
  }

  const FAB_ICON =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M4.6 8.6V6.3c0-.94.76-1.7 1.7-1.7h2.3M15.4 4.6h2.3c.94 0 1.7.76 1.7 1.7v2.3' +
    'M19.4 15.4v2.3c0 .94-.76 1.7-1.7 1.7h-2.3M8.6 19.4H6.3c-.94 0-1.7-.76-1.7-1.7v-2.3" ' +
    'stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>' +
    '<circle cx="12" cy="12" r="1.45" fill="currentColor"/>' +
    '</svg>';

  function setFabState(active, labelText) {
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    fab.classList.toggle('is-active', !!active);
    const label = fab.querySelector('.dsh-picker-label');
    if (label) label.textContent = labelText || (active ? 'Esc 退出' : '点选 / 批注');
    fab.setAttribute('aria-pressed', active ? 'true' : 'false');
    setTimeout(() => updateShift(fab), 240);
  }

  // 位置持久化：每个站点记一套坐标（视口坐标，px）
  const POS_KEY = '__dsh_picker_pos__';
  const DRAG_THRESHOLD = 4;

  function loadFabPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (typeof pos.x === 'number' && typeof pos.y === 'number') return pos;
    } catch (_) {
      /* 隐私模式 / 脏数据：用默认位置 */
    }
    return null;
  }

  function saveFabPos(x, y) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    } catch (_) {
      /* 忽略写入失败 */
    }
  }

  function clampFabPos(x, y, el) {
    const width = el.offsetWidth || 33;
    const height = el.offsetHeight || 33;
    const margin = 4;
    return {
      x: Math.min(Math.max(margin, x), Math.max(margin, innerWidth - width - margin)),
      y: Math.min(Math.max(margin, y), Math.max(margin, innerHeight - height - margin)),
    };
  }

  /** 固定到视口坐标（脱离默认的右下角定位）。 */
  function placeFab(el, x, y) {
    const pos = clampFabPos(x, y, el);
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    return pos;
  }

  /** 回到默认的右下角，并清掉记忆。 */
  function resetFabPos(el) {
    try {
      localStorage.removeItem(POS_KEY);
    } catch (_) {
      /* 忽略 */
    }
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
  }

  /**
   * 悬停展开时如果贴到右/左边缘，把按钮整体往回挪，避免被视口裁掉。
   * 用 CSS 变量驱动 transform，不影响拖拽用的 left/top。
   */
  function updateShift(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let shift = 0;
    if (rect.right > innerWidth - margin) shift = -(rect.right - (innerWidth - margin));
    else if (rect.left < margin) shift = margin - rect.left;
    el.style.setProperty('--dsh-picker-shift', shift ? shift.toFixed(1) + 'px' : '0px');
  }

  function mountButton() {
    if (document.getElementById(FAB_ID)) return;
    injectFabCss();

    const fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.type = 'button';
    fab.title = '选取控件或批注页面（Ctrl+Shift+P 拾取 / Ctrl+Shift+A 批注）';
    fab.setAttribute('aria-label', '选取控件或批注页面');
    fab.innerHTML = FAB_ICON + '<span class="dsh-picker-label">点选 / 批注</span>';

    // ---- 拖拽移动（Pointer Events：鼠标 / 触屏 / 手写笔通用）----
    let drag = null;
    let suppressClickUntil = 0;

    const onPointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      // 别让页面自己的拖拽/选中逻辑接管这次按下
      event.stopPropagation();
      const rect = fab.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
        x: rect.left,
        y: rect.top,
      };
      try {
        fab.setPointerCapture(event.pointerId);
      } catch (_) {
        /* 老浏览器忽略 */
      }
    };

    const onPointerMove = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      fab.classList.add('is-dragging');
      document.documentElement.style.userSelect = 'none';
      const pos = placeFab(fab, drag.left + dx, drag.top + dy);
      drag.x = pos.x;
      drag.y = pos.y;
      updateShift(fab);
    };

    const endDrag = (event) => {
      if (!drag) return;
      const moved = drag.moved;
      const { x, y } = drag;
      drag = null;
      fab.classList.remove('is-dragging');
      document.documentElement.style.userSelect = '';
      try {
        fab.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* 忽略 */
      }
      if (moved) {
        saveFabPos(x, y);
        // 拖拽之后的 click 不算点击，避免误进入拾取模式
        suppressClickUntil = Date.now() + 300;
      }
    };

    fab.addEventListener('pointerdown', onPointerDown);
    fab.addEventListener('pointermove', onPointerMove);
    fab.addEventListener('pointerup', endDrag);
    fab.addEventListener('pointercancel', endDrag);

    // 右键：恢复默认位置（回到右下角）
    fab.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetFabPos(fab);
      updateShift(fab);
      toast('已还原到右下角', 1400);
    });

    fab.addEventListener('mouseenter', () => {
      // 展开后量一次，贴边时自动回挪
      setTimeout(() => updateShift(fab), 220);
    });
    fab.addEventListener('mouseleave', () => {
      setTimeout(() => updateShift(fab), 220);
    });

    fab.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressClickUntil) return;
      // 已经进了某个模式：再点按钮就是退出；否则先让用户选模式
      if (picking) stopPicking();
      else if (annotating) {
        stopAnnotating();
        toast(annots.length ? `已退出批注，${annots.length} 条标记保留在页面上` : '已退出批注');
      } else toggleModeMenu();
    });

    // 还原上次拖到的位置（没有记录就保持默认右下角）
    const saved = loadFabPos();
    if (saved) placeFab(fab, saved.x, saved.y);

    // 首次出现时轻轻展开一次，告诉用户它是什么；之后保持收起
    let teased = false;
    try {
      teased = sessionStorage.getItem('__dsh_picker_teased__') === '1';
    } catch (_) {
      /* 隐私模式下忽略 */
    }
    if (!teased) {
      setTimeout(() => {
        fab.classList.add('is-teaser');
        setTimeout(() => fab.classList.remove('is-teaser'), 2200);
        try {
          sessionStorage.setItem('__dsh_picker_teased__', '1');
        } catch (_) {
          /* 忽略 */
        }
      }, 1200);
    }

    document.documentElement.appendChild(fab);
  }

  // ---------- 同源 iframe 支持 ----------
  function hookFrames() {
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const doc = frame.contentDocument;
        if (!doc || doc.__dshPickerHooked) continue;
        doc.__dshPickerHooked = true;
        doc.addEventListener('mousemove', (event) => {
          if (!picking) return;
          const el = event.target;
          if (!(el instanceof Element)) return;
          hoverEl = el;
          paint(el, event);
        }, true);
        doc.addEventListener('click', (event) => {
          if (!picking) return;
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          const el = event.target;
          stopPicking();
          if (!(el instanceof Element)) return;
          const text = formatForAI(describe(el));
          push(text).then((ok) => toast(ok ? '已发送到 DSH 输入框' : '推送失败'));
        }, true);
      } catch (_) {
        /* 跨域 iframe 无法注入，忽略 */
      }
    }
  }

  // ---------- 启动 ----------
  function boot() {
    mountButton();

    // 窗口尺寸变化：把按钮夹回可视区，并重算贴边偏移
    window.addEventListener('resize', () => {
      const fab = document.getElementById(FAB_ID);
      if (fab && fab.style.left) {
        placeFab(fab, parseFloat(fab.style.left) || 0, parseFloat(fab.style.top) || 0);
      }
      if (fab) updateShift(fab);
      scheduleAnnoSync();
    });
    // 滚动时把批注钉子、轮廓、评论气泡重新贴到内容上（捕获阶段，内部滚动容器也能收到）
    window.addEventListener('scroll', scheduleAnnoSync, true);
    document.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || !event.shiftKey) return;
      const key = event.key ? event.key.toLowerCase() : '';
      if (key === 'p' || event.code === 'KeyP') {
        event.preventDefault();
        picking ? stopPicking() : startPicking();
      } else if (key === 'a' || event.code === 'KeyA') {
        event.preventDefault();
        if (annotating) {
          stopAnnotating();
          toast(annots.length ? `已退出批注，${annots.length} 条标记保留在页面上` : '已退出批注');
        } else startAnnotating();
      }
    }, true);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        mountButton();
        hookFrames();
      }, { once: true });
    } else {
      hookFrames();
    }
    setInterval(hookFrames, 3000);
  }

  window.dshUiPicker = {
    start: startPicking,
    stop: stopPicking,
    /** 进入批注模式（在页面上钉编号标记 + 写评论） */
    annotate: startAnnotating,
    stopAnnotate: () => stopAnnotating({ keep: true }),
    clearAnnotations,
    annotations: () =>
      annots.map((anno, index) => ({
        no: index + 1,
        id: anno.id,
        x: anno.x,
        y: anno.y,
        comment: anno.comment,
        selector: anno.target ? anno.target.selector : null,
      })),
    formatAnnotations: () => formatAnnotationsForAI(annots.slice()),
    describe,
    format: formatForAI,
    push,
    /** 把按钮还原到右下角默认位置（等同右键按钮） */
    resetPosition() {
      const fab = document.getElementById(FAB_ID);
      if (fab) {
        resetFabPos(fab);
        updateShift(fab);
      }
    },
  };

  boot();
})();
