# dsh-ui-picker

**Click the control you want to change — the AI knows exactly which one.**

[中文](README.md) · **English**

A UI-editing helper for people who don't live in DevTools. You don't need to know what a
CSS selector, DOM node or class name is. Click the element on the page and its full technical
identity — tag, selector, XPath, component name, computed styles — is written straight into the
**DeepSeek Harness** composer. Then just say "make it a rounded blue button" and the model edits
the right element.

![Floating button states](preview-fab.png)

---

## Why

When a non-frontend teammate reports "that blue button on the right", an AI needs
`#submit-order`, `//*[@id="submit-order"]`, `.btn.btn-primary` to act. This tool is that
translation layer, compressed into one click.

## How it works

```
Your page under development              DSH Web GUI
┌──────────────────┐   POST /push      ┌───────────────────────────────┐
│ picker.js        │ ─────────────────▶│ bridge 127.0.0.1:17857        │
│ pick → describe  │                   │        │ long-poll            │
└──────────────────┘                   │        ▼                      │
                                       │ client plugin → composer      │
                                       └───────────────────────────────┘
```

- **Host half** (`index.js`): a loopback-only HTTP bridge on `127.0.0.1:17857` that receives
  descriptions, serves long-polling, and also serves `picker.js` as a static asset.
- **Client half** (`client.js`): runs inside the DSH web client, polls the bridge and inserts
  the text at the caret through the composer facade (`captureInsertion` + `insertText`).
  It renders **no visible UI**.
- **Page half** (`picker.js`): runs in your page — hover outline, element picking, description.

The bridge deliberately does *not* reuse DSH's own port or auth: arbitrary pages are
cross-origin and cannot hold DSH session cookies. A dedicated loopback port is the simplest
reliable channel. It carries text only — no code execution, no file access.

## Features

- **One click, full identity**: tag / id / class / role / text / placeholder / aria-label,
  CSS selector, absolute XPath, ancestor chain, box size & position, key computed styles
- **Component awareness**: detects React (fiber), Vue 2/3 component names, plus
  Element / Ant Design / Vant / MUI class prefixes
- **Multi-select**: `Shift`-click to add, a bottom panel shows the count, `Enter` sends them
  as one numbered list
- **Draggable floating button**: glass-morphism viewfinder icon, position remembered per site,
  right-click to reset, dark-mode aware
- **Non-invasive**: no layout changes, no DOM pollution; nothing visible inside DSH either
- **Graceful fallback**: if the bridge is down, the description is copied to the clipboard
- **Shadow DOM & same-origin iframes** supported

## Install

### 1. Add the plugin to DeepSeek Harness

```bash
git clone https://github.com/ztlovelsw/dsh-ui-picker.git
cd dsh-ui-picker
node install.mjs          # detects the profile, copies the plugin, wires package.json
```

The script copies the plugin into `~/.dsh/plugins/dsh-ui-picker`, backs up the profile's
`package.json`, appends the dependency and `dsh.profile.bundles` entry, then runs `pnpm install`.

Manual equivalent:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-ui-picker": "file:../../plugins/dsh-ui-picker" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-ui-picker"] } }
}
```

Then `cd ~/.dsh/profiles/<profile> && pnpm install` and **restart DSH**.

> The plugin has zero runtime dependencies. If `pnpm install` is unavailable, copy or link the
> package into `profiles/<profile>/node_modules/dsh-ui-picker` instead (`mklink /J` on Windows).

### 2. Put the picker on your page (pick one)

**A. One line (recommended)**

```html
<script src="http://127.0.0.1:17857/picker.js"></script>
```

Put it before `</body>`. Works in Vite / Next entry HTML.

**B. Userscript**: drag `dsh-ui-picker.user.js` into Tampermonkey. It matches
`localhost`, `127.0.0.1` and `file://` by default; add
`// @match https://your-dev-domain/*` for anything else.

**C. Console**: paste the whole `picker.js` into DevTools.

## Usage

1. A small glass button appears at the bottom-right (or press `Ctrl + Shift + P`)
2. Click it — hovering any control draws a blue outline
3. Click the target — the description lands in the DSH composer
4. Append your request after `修改需求：` and hit Enter

### Multi-select

Hold `Shift` on the first pick to start a batch; afterwards click further controls directly.
A bottom panel shows **已选 N 个** (N selected):

| Action | Result |
|---|---|
| `Enter` / **发送** | sends all picks as a single message |
| `Esc` / **取消** | discards the batch |

### Button gestures

| Action | Result |
|---|---|
| Drag | moves the button; remembered per site in `localStorage`, clamped to the viewport |
| Right-click | resets to the bottom-right corner |
| Click | toggles pick mode |

`window.dshUiPicker.resetPosition()` does the same reset from code.

## What the model receives

Single element:

```
【UI 控件】「提交订单」按钮
页面：青柠商城 · 控制台 — http://localhost:5173/checkout
定位：button#submit-order.btn.btn-primary · PrimaryButton（React）
文案「提交订单」，尺寸 112 × 44，位于 (56, 402)
样式：内边距 10px 20px｜圆角 10px｜背景 rgb(37, 99, 235)｜字色 rgb(255, 255, 255)｜字号 14px｜字重 600
父级：div.row ← section.card ← main（同级 3 个）
CSS：#submit-order　XPath：//*[@id="submit-order"]

修改需求：
```

Multiple elements:

```
【UI 控件】共 2 个
页面：青柠商城 · 控制台 — http://localhost:5173/checkout

01. 「提交订单」按钮　button#submit-order.btn.btn-primary
    文案「提交订单」，尺寸 112 × 44，位于 (56, 402)
    样式：内边距 10px 20px｜圆角 10px｜背景 rgb(37, 99, 235)｜字号 14px｜字重 600
    CSS：#submit-order

02. 「客户名称」输入框　input#customer
    尺寸 320 × 40，位于 (56, 300)
    样式：内边距 10px 12px｜圆角 10px｜边框 1px solid rgb(226, 232, 240)｜字号 14px
    CSS：#customer

修改需求：
```

Only styling-relevant facts survive: `display: block`, `overflow: visible` and similar noise
are filtered out, and pointless ancestors such as `body ← html` are dropped.

## Configuration

`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-ui-picker
      name: dsh-ui-picker
      config:
        enabled: true
        port: 17857     # change the port here and in the page <script> URL
```

## Shortcuts

| Key | Action |
|---|---|
| `Ctrl + Shift + P` | toggle pick mode |
| `Shift + click` | add to selection (starts a batch) |
| `Enter` | send the batch |
| `Esc` | cancel picking / discard the batch |

## Troubleshooting

| Symptom | Fix |
|---|---|
| No floating button | `picker.js` didn't load — check Network for 200, and `window.dshUiPicker` in the console |
| "没连上 DSH" (bridge unreachable) | `curl http://127.0.0.1:17857/health`; make sure DSH was restarted |
| Text arrives nowhere | Composer facade changed — look for `[dsh-ui-picker]` warnings in the DSH console; the description is logged there for manual copy |
| Port already in use | `netstat -ano | findstr 17857`, free it or change the port |
| Button off-screen | Right-click it, or `window.dshUiPicker.resetPosition()` |

## Development

```bash
npm test          # bridge + client + duplicate-write regression
```

Individually:

```bash
node tests/bridge-test.mjs      # push / poll / long-poll / health / static picker.js
node tests/client-test.mjs      # drives the client plugin with fake react + ctx, asserts insertText
node tests/client-dup-test.mjs  # loads the module twice, asserts a single insertion
```

`tests/*.html` are visual browser cases (drag, multi-select, click flow, button states) —
open them in Chrome while the bridge is running.

### Layout

```
dsh-ui-picker/
├── index.js              host bridge (push / poll / health / picker.js)
├── client.js             DSH client half: polling + composer insertion (no visible UI)
├── picker.js             page half: floating button, highlight, description & formatting
├── dsh-ui-picker.user.js userscript build (picker.js + header)
├── cordis.patch.yml      plugin registration entry
├── install.mjs           installer
├── demo.html             demo page
├── preview-fab.png       button state preview
└── tests/                self-tests and visual cases
```

## Notes

- The bridge listens on `127.0.0.1` only and moves text only.
- Pages served over `https://` on a public domain may be blocked from reaching a local port
  (Private Network Access); local `localhost` development is unaffected.
- With several DSH sessions open in multiple tabs, the description goes to the session whose
  composer mounted last.

## License

[MIT](LICENSE)
