/**
 * dsh-ui-picker — 宿主侧桥接服务
 *
 * 目的：浏览器里「点选 UI 控件」的页面脚本，把控件详情 POST 到本机回环端口；
 * DSH Web GUI 里的客户端插件轮询该端口，把文本写进当前会话输入框。
 *
 * 设计要点：
 * - 只监听 127.0.0.1（绝不对外网暴露），无鉴权：这是一个本机开发辅助工具，
 *   桥接的只有「控件描述文本」，不执行任何代码、不读写文件。
 * - 不占用 DSH 自己的 webServer 端口，避免与会话鉴权（cookie/launch token）耦合：
 *   页面脚本来自任意站点，本来也拿不到 DSH 的会话 cookie。
 * - 同时把 picker.js 作为静态资源暴露，用户可在自己的页面里加一行
 *   <script src="http://127.0.0.1:17857/picker.js"></script> 完成接入。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const name = "dsh-ui-picker";

/** 需要注入的服务：一个都不需要（纯 HTTP 桥）。 */
export const inject = [];

/**
 * 配置（保持纯对象：插件零依赖，不引入 schemastery，避免 profile 解析问题）。
 * @typedef {{enabled?: boolean, port?: number, host?: string, logger?: boolean}} PickerConfig
 */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ITEMS = 50;
const POLL_TIMEOUT_MS = 20_000;

/**
 * 一个极小的「信箱」：页面脚本 push，DSH 页面 poll。
 * 保留最近 MAX_ITEMS 条，seq 单调递增，长轮询挂起等待。
 */
class Mailbox {
  constructor() {
    this.seq = 0;
    this.items = [];
    this.waiters = new Set();
  }

  push(text, meta) {
    this.seq += 1;
    const item = { seq: this.seq, text, meta: meta ?? null, ts: Date.now() };
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    for (const waiter of [...this.waiters]) waiter(item);
    return item;
  }

  since(seq) {
    const from = Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0;
    return this.items.filter((item) => item.seq > from);
  }
}

function applyCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  // Private Network Access：公网页面访问 127.0.0.1 时 Chrome 会先发预检，
  // 必须显式允许，否则请求被拦成 CORS 错误。
  res.setHeader("access-control-allow-private-network", "true");
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("cache-control", "no-store");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  applyCors(res);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 启动桥接服务器。
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function startBridge(options = {}) {
  const mailbox = new Mailbox();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 17857;
  const log = options.log ?? (() => {});
  const pickerPath = fileURLToPath(new URL("./picker.js", import.meta.url));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      if (req.method === "OPTIONS") {
        applyCors(res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "POST" && url.pathname === "/push") {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" });
          return;
        }
        const text = typeof payload?.text === "string" ? payload.text : "";
        if (text.trim() === "") {
          sendJson(res, 400, { ok: false, error: "empty text" });
          return;
        }
        const item = mailbox.push(text.slice(0, 32_000), payload?.meta ?? null);
        log(`push #${item.seq} (${text.length} chars)`);
        sendJson(res, 200, { ok: true, seq: item.seq });
        return;
      }

      if (req.method === "GET" && url.pathname === "/poll") {
        const since = Number(url.searchParams.get("since") ?? "0");
        const immediate = mailbox.since(since);
        if (immediate.length > 0) {
          sendJson(res, 200, { ok: true, seq: mailbox.seq, items: immediate });
          return;
        }
        // 长轮询：有新条目、或超时（客户端随后重连）时返回。
        const timeout = setTimeout(() => {
          mailbox.waiters.delete(waiter);
          sendJson(res, 200, { ok: true, seq: mailbox.seq, items: [] });
        }, POLL_TIMEOUT_MS);
        const waiter = (item) => {
          clearTimeout(timeout);
          mailbox.waiters.delete(waiter);
          sendJson(res, 200, { ok: true, seq: item.seq, items: [item] });
        };
        mailbox.waiters.add(waiter);
        req.on("close", () => {
          clearTimeout(timeout);
          mailbox.waiters.delete(waiter);
        });
        return;
      }

      if (req.method === "GET" && (url.pathname === "/picker.js" || url.pathname === "/")) {
        const source = await readFile(pickerPath, "utf8");
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        });
        res.end(source);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, plugin: "dsh-ui-picker", port, seq: mailbox.seq });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const actualPort = server.address()?.port ?? port;
  log(`bridge listening on http://${host}:${actualPort}`);

  return {
    port: actualPort,
    mailbox,
    close: () =>
      new Promise((resolve) => {
        for (const waiter of [...mailbox.waiters]) waiter({ seq: mailbox.seq, text: "" });
        mailbox.waiters.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/**
 * cordis 插件入口。
 * @param ctx - 宿主上下文。
 * @param config - 本插件配置。
 */
export function apply(ctx, config) {
  const conf = { enabled: true, port: 17857, host: "127.0.0.1", logger: false, ...(config ?? {}) };
  if (!conf.enabled) {
    ctx.logger?.info?.("[dsh-ui-picker] disabled by config");
    return;
  }

  const log = (message) => {
    if (conf.logger) ctx.logger?.info?.(`[dsh-ui-picker] ${message}`);
  };

  let bridge;
  ctx.effect(() => {
    let disposed = false;
    startBridge({ host: conf.host, port: conf.port, log })
      .then((handle) => {
        if (disposed) {
          void handle.close();
          return;
        }
        bridge = handle;
        ctx.logger?.info?.(
          `[dsh-ui-picker] ready — 页面接入: <script src="http://${conf.host}:${handle.port}/picker.js"></script>`,
        );
      })
      .catch((error) => {
        ctx.logger?.warn?.(
          `[dsh-ui-picker] bridge failed to listen on ${conf.host}:${conf.port} — ${error?.message ?? error}`,
        );
      });

    return async () => {
      disposed = true;
      await bridge?.close();
      bridge = undefined;
    };
  }, "dsh-ui-picker: bridge server");
}

export default { name, inject, apply };
