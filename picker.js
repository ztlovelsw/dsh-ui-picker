/**
 * dsh-ui-picker — 页面端「UI 控件拾取器」
 *
 * 用法（三选一）：
 *   1. 在你的页面里加一行：<script src="http://127.0.0.1:17857/picker.js"></script>
 *   2. 控制台粘贴本文件全部内容
 *   3. 装成油猴脚本（见同目录 dsh-ui-picker.user.js）
 *
 * 交互：点右下角的取景框按钮（或 Ctrl+Shift+P）进入拾取模式 → 鼠标悬停高亮 →
 *       点击目标控件 → 控件详情自动写入 DSH 输入框。
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
  async function push(text) {
    // 同一份内容 900ms 内只发一次：防止事件重入/双实例导致的重复写入
    const now = Date.now();
    if (text === lastPush.text && now - lastPush.at < 900) return true;
    lastPush = { text, at: now };
    try {
      const response = await fetch(PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          meta: { from: location.host, url: location.href, title: document.title, ts: Date.now() },
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
  /** 取事件最深目标：穿透 Shadow DOM（mousemove/click 的 target 会被重定向到宿主）。 */
  function deepTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (path && path.length) {
      for (const node of path) {
        if (node instanceof Element && node !== overlay && node !== tip) {
          if (node.closest && node.closest('#__dsh_picker_fab__')) continue;
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
      if (!el || el === overlay || el === tip || (el.closest && el.closest('#__dsh_picker_fab__'))) return;
      hoverEl = el;
      paint(el, event);
    });
  }

  async function onPick(event) {
    if (!picking) return;
    // 点在按钮自己身上：交给按钮的 click 处理（切换拾取），别把按钮本身当目标
    if (event.target && event.target.closest && event.target.closest('#__dsh_picker_fab__')) return;
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
`;

  function injectFabCss() {
    if (document.getElementById('__dsh_picker_fab_css__')) return;
    const style = document.createElement('style');
    style.id = '__dsh_picker_fab_css__';
    style.textContent = FAB_CSS;
    document.head.appendChild(style);
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
    if (label) label.textContent = labelText || (active ? 'Esc 退出' : '选取控件');
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
    fab.title = '选取页面控件发给 DSH（Ctrl+Shift+P）';
    fab.setAttribute('aria-label', '选取页面控件发给 DSH');
    fab.innerHTML = FAB_ICON + '<span class="dsh-picker-label">选取控件</span>';

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
      if (picking) stopPicking();
      else startPicking();
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
      if (!fab) return;
      if (fab.style.left) {
        placeFab(fab, parseFloat(fab.style.left) || 0, parseFloat(fab.style.top) || 0);
      }
      updateShift(fab);
    });
    document.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.shiftKey && (event.key === 'P' || event.code === 'KeyP')) {
        event.preventDefault();
        picking ? stopPicking() : startPicking();
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
