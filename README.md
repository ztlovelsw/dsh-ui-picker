# dsh-ui-picker

**点一下页面上的控件，AI 就知道你要改哪里。**

给不熟悉前端术语的人用的 UI 修改助手：不用知道「CSS 选择器」「DOM 节点」「class 名」，
只要在页面上点一下要改的地方，控件的全部技术细节就会自动写进 **DeepSeek Harness** 的输入框，
再补一句「改成圆角蓝色」，AI 就能精准定位、精准修改。

> Point at any UI control on your page — its selector, XPath, component name and computed
> styles are written straight into the **DeepSeek Harness** composer, so the model knows
> exactly which element you mean.

![按钮三态](preview-fab.png)

---

## 为什么需要它

非前端同学描述界面问题时，只能说出「那个蓝色的按钮」「右边那个卡片」；
而 AI 改 UI 需要的是 `#submit-order`、`//*[@id="submit-order"]`、`.btn.btn-primary`。
中间这层翻译，现在由一次点击完成。

## 工作方式

```
你正在开发的页面                        DSH Web GUI
┌──────────────────┐   POST /push    ┌──────────────────────────────┐
│ picker.js        │ ───────────────▶│ 桥接服务 127.0.0.1:17857      │
│ 点选控件 → 采集   │                 │        │ 长轮询              │
└──────────────────┘                 │        ▼                     │
                                     │ 客户端插件 → 写入输入框        │
                                     └──────────────────────────────┘
```

- **宿主侧**（`index.js`）：在 `127.0.0.1:17857` 起一个只监听本机的迷你 HTTP 服务，
  接收控件描述、提供长轮询，同时把 `picker.js` 当静态文件发出去。
- **客户端侧**（`client.js`）：DSH 网页里运行，轮询桥接服务，通过输入框 facade
  （`captureInsertion` + `insertText`）把文本插到光标处。**不渲染任何可见 UI**。
- **页面侧**（`picker.js`）：在你自己的页面里运行，负责悬停高亮、点选、采集信息。

桥接服务刻意不复用 DSH 自己的端口和鉴权：任意网页（不同源）拿不到 DSH 的会话 cookie，
独立回环端口最简单可靠。它只传文本，不执行代码、不读写文件。

## 特性

- **一次点击拿到全部定位信息**：标签 / id / class / role / 文案 / placeholder / aria-label、
  CSS 选择器、绝对 XPath、父级链、尺寸位置、关键计算样式
- **组件识别**：自动探测 React（fiber）、Vue 2/3 组件名，以及 Element / Ant Design / Vant / MUI 等库的类名
- **多选**：`Shift` 加选，底部面板显示已选数量，`Enter` 一次性发送成编号清单
- **可拖动的悬浮按钮**：玻璃拟态取景框图标，位置按站点记忆，右键还原；支持深色模式
- **零侵入**：不改变页面布局、不污染 DOM 结构；DSH 侧也没有任何可见 UI
- **兜底**：桥接没起来时自动复制到剪贴板，并给出提示
- **Shadow DOM / 同源 iframe**：能穿透 shadow root，也能钩住同源 iframe

## 安装

### 1. 装进 DeepSeek Harness

```bash
git clone https://github.com/ztlovelsw/dsh-ui-picker.git
cd dsh-ui-picker
node install.mjs          # 自动探测 profile，复制插件并写入配置
```

脚本会：复制插件文件到 `~/.dsh/plugins/dsh-ui-picker` → 备份 profile 的 `package.json`
→ 追加依赖与 `dsh.profile.bundles` → 执行 `pnpm install`。

不想用脚本就手动来：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-ui-picker": "file:../../plugins/dsh-ui-picker"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-ui-picker"]
    }
  }
}
```

然后 `cd ~/.dsh/profiles/<profile> && pnpm install`，**重启 DSH**。

> 插件是零依赖的；`pnpm install` 起不来时，直接把包目录链接/复制到
> `profiles/<profile>/node_modules/dsh-ui-picker` 也能跑（Windows 可用目录联接 `mklink /J`）。

### 2. 让页面长出拾取按钮（三选一）

**A. 加一行（推荐）**

```html
<script src="http://127.0.0.1:17857/picker.js"></script>
```

放在 `</body>` 前。Vite / Next 项目放进入口 HTML 即可。

**B. 油猴脚本**：把 `dsh-ui-picker.user.js` 拖进 Tampermonkey。
默认匹配 `localhost` / `127.0.0.1` / `file://`；要覆盖其它域名，在脚本头加
`// @match https://your-dev-domain/*`。

**C. 控制台临时粘贴** `picker.js` 全文。

## 使用

1. 页面右下角出现一个玻璃质感的小按钮（取景框图标），或按 `Ctrl + Shift + P`
2. 点它 → 鼠标划过控件会蓝色描边
3. 点一下目标控件 → 文本出现在 DSH 输入框
4. 在最后一行「修改需求：」后面补一句话，回车

### 多选

按住 `Shift` 点第一个控件进入多选，之后直接点其它控件继续加选；底部出现「已选 N 个」面板：

| 操作 | 效果 |
|---|---|
| `Enter` / 面板「发送」 | 合并成一条消息发出 |
| `Esc` / 面板「取消」 | 丢弃本次多选 |

### 按钮手势

| 操作 | 效果 |
|---|---|
| 拖动 | 移动位置，按站点记住（`localStorage`），越界自动夹回 |
| 右键 | 还原到右下角默认位置 |
| 单击 | 进入 / 退出拾取模式 |

也可以 `window.dshUiPicker.resetPosition()` 复位。

## 输出长什么样

单个控件：

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

多个控件：

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

只保留对改样式有用的信息：`display: block`、`overflow: visible` 这类噪音会被过滤，
`body ← html` 这种无信息量的父级也会去掉。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-ui-picker
      name: dsh-ui-picker
      config:
        enabled: true
        port: 17857     # 改端口后，页面里的 script 地址也要跟着改
```

## 快捷键

| 键 | 作用 |
|---|---|
| `Ctrl + Shift + P` | 开关拾取模式 |
| `Shift + 点击` | 加选（进入多选） |
| `Enter` | 发送多选结果 |
| `Esc` | 取消拾取 / 丢弃多选 |

## 排错

| 现象 | 处理 |
|---|---|
| 页面右下角没有按钮 | 脚本没加载：看 Network 里 `picker.js` 是否 200；控制台执行 `window.dshUiPicker` 是否为对象 |
| 点了提示「没连上 DSH」 | 桥接没起来：`curl http://127.0.0.1:17857/health`；确认重启过 DSH |
| 有提示但输入框没字 | 输入框 facade 变了：看 DSH 控制台有没有 `[dsh-ui-picker]` 警告；此时控件信息会打印在控制台可手动复制 |
| 端口被占用 | `netstat -ano | findstr 17857`，改端口或结束占用进程 |
| 按钮位置跑到屏幕外 | 右键按钮还原，或 `window.dshUiPicker.resetPosition()` |

## 开发

```bash
npm test          # 桥接 + 客户端 + 重复写入回归
```

单独跑：

```bash
node tests/bridge-test.mjs      # push / poll / 长轮询 / health / picker.js 静态服务
node tests/client-test.mjs      # 假 react + 假 ctx 驱动客户端插件，验证 insertText 链路
node tests/client-dup-test.mjs  # 同一页面加载两份模块，断言只写入一次
```

`tests/*.html` 是浏览器端的可视化用例（拖拽、多选、点击链路、按钮三态），
直接用 Chrome 打开即可，需要桥接服务在跑。

### 目录

```
dsh-ui-picker/
├── index.js              宿主：桥接 HTTP 服务（push / poll / health / picker.js）
├── client.js             DSH 网页侧：轮询 + 写入输入框（零可见 UI）
├── picker.js             页面侧：拾取按钮、高亮、信息采集与格式化
├── dsh-ui-picker.user.js 油猴版本（picker.js + 脚本头）
├── cordis.patch.yml      插件注册条目
├── install.mjs           安装脚本
├── demo.html             演示页
├── preview-fab.png       按钮三态预览
└── tests/                自测脚本与可视化用例
```

## 说明

- 桥接只监听 `127.0.0.1`，只传文本，不执行代码、不读写文件。
- 页面若是 `https://` 且部署在公网域名，浏览器可能拦截到本机端口的请求
  （Private Network Access）；本地 `localhost` 开发不受影响。
- 多标签页同时打开多个 DSH 会话时，拾取结果写入最后挂载的那个会话输入框。

## License

[MIT](LICENSE)
