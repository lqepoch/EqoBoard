import { createHash } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.E2E_ALPACA_PORT ?? 4312);
const controlToken = process.env.E2E_CONTROL_TOKEN ?? "";
const expectedKey = "openbb-e2e-market-key-only";
const expectedSecret = "openbb-e2e-market-secret-only";
const calls = [];
const sockets = new Set();
const control = { bars: "normal", options: "normal" };

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error("control body too large");
  }
  return JSON.parse(body || "{}");
}

function record(req, url) {
  calls.push({
    method: req.method,
    path: url.pathname,
    feed: url.searchParams.get("feed"),
    symbols: url.searchParams.get("symbols"),
    symbol: url.pathname.match(/^\/v2\/stocks\/([^/]+)\/bars$/)?.[1] ?? null,
    timeframe: url.searchParams.get("timeframe"),
    limit: url.searchParams.get("limit"),
    sort: url.searchParams.get("sort"),
    start: url.searchParams.get("start"),
    expiration_date: url.searchParams.get("expiration_date"),
    page_token: url.searchParams.get("page_token"),
    key_id_present: req.headers["apca-api-key-id"] === expectedKey,
    secret_present: req.headers["apca-api-secret-key"] === expectedSecret,
  });
}

function validProviderHeaders(req) {
  return req.headers["apca-api-key-id"] === expectedKey &&
    req.headers["apca-api-secret-key"] === expectedSecret;
}

function controlAllowed(req) {
  return controlToken.length > 0 && req.headers["x-e2e-control"] === controlToken;
}

function stockSnapshot(symbol, now) {
  const base = symbol === "QQQ" ? 500 : symbol === "SPY" ? 600 : 150;
  return {
    latestTrade: { p: base + 0.12, t: now, c: ["@"] },
    latestQuote: { bp: base + 0.1, ap: base + 0.14, bs: 5, as: 6, t: now, c: ["R"] },
    dailyBar: { o: base - 1, h: base + 1, l: base - 2, c: base + 0.12, v: 120000, t: now },
    prevDailyBar: { c: base - 0.5, t: new Date(Date.now() - 86_400_000).toISOString() },
  };
}

function nextPageToken(prefix, url) {
  const previous = url.searchParams.get("page_token");
  const page = previous ? Number(previous.replace(`${prefix}-`, "")) + 1 : 1;
  return `${prefix}-${page}`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/__test/healthz" && req.method === "GET") {
    return json(res, 200, { status: "ok" });
  }
  if (url.pathname === "/__test/metrics" && req.method === "GET") {
    if (!controlAllowed(req)) return json(res, 404, { error: "not_found" });
    return json(res, 200, { calls, websocket_paths: [...sockets].map((socket) => socket.path), bars_mode: control.bars, options_mode: control.options });
  }
  if (url.pathname === "/__test/reset" && req.method === "POST") {
    if (!controlAllowed(req)) return json(res, 404, { error: "not_found" });
    calls.length = 0;
    control.bars = "normal";
    control.options = "normal";
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__test/control" && req.method === "POST") {
    if (!controlAllowed(req)) return json(res, 404, { error: "not_found" });
    try {
      const requested = await readJson(req);
      for (const key of ["bars", "options"]) {
        if (Object.hasOwn(requested, key) && !["normal", "empty-truncated"].includes(requested[key])) {
          return json(res, 400, { error: "invalid_mode" });
        }
        if (Object.hasOwn(requested, key)) control[key] = requested[key];
      }
      return json(res, 200, { ok: true, bars: control.bars, options: control.options });
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
  }

  record(req, url);
  if (!validProviderHeaders(req)) return json(res, 401, { message: "unauthorized" });
  const feed = url.searchParams.get("feed");
  if (url.pathname === "/v2/stocks/snapshots" && req.method === "GET") {
    if (feed !== "sip") return json(res, 400, { message: "only the explicit sip fixture is available" });
    const now = new Date().toISOString();
    const symbols = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
    return json(res, 200, Object.fromEntries(symbols.map((symbol) => [symbol, stockSnapshot(symbol, now)])));
  }

  const barsMatch = url.pathname.match(/^\/v2\/stocks\/([A-Z0-9.]+)\/bars$/);
  if (barsMatch && req.method === "GET") {
    if (feed !== "sip") return json(res, 400, { message: "only the explicit sip fixture is available" });
    if (control.bars === "empty-truncated") {
      return json(res, 200, {
        bars: [],
        next_page_token: nextPageToken("bar-page", url),
      });
    }
    const now = Date.now();
    return json(res, 200, {
      bars: [0, 1].map((offset) => ({
        t: new Date(now - offset * 86_400_000).toISOString(),
        o: 499 + offset,
        h: 501 + offset,
        l: 498 + offset,
        c: 500 + offset,
        v: 100_000 + offset,
      })),
      next_page_token: null,
    });
  }

  const optionsMatch = url.pathname.match(/^\/v1beta1\/options\/snapshots\/([A-Z0-9.]+)$/);
  if (optionsMatch && req.method === "GET") {
    if (feed !== "opra") return json(res, 400, { message: "only the explicit opra fixture is available" });
    const expiration = url.searchParams.get("expiration_date") ?? "";
    const occDate = expiration.replaceAll("-", "").slice(2);
    if (!/^\d{6}$/.test(occDate)) return json(res, 400, { message: "expiration_date is required" });
    if (control.options === "empty-truncated") {
      return json(res, 200, { snapshots: {}, next_page_token: nextPageToken("option-page", url) });
    }
    const now = new Date().toISOString();
    const contract = `${optionsMatch[1]}${occDate}C00500000`;
    return json(res, 200, {
      snapshots: {
        [contract]: {
          latestQuote: { bp: 4.99, ap: 5.01, bs: 12, as: 15, t: now },
          latestTrade: { p: 5, t: now },
          impliedVolatility: 0.31,
          greeks: { delta: 0.52, gamma: 0.08, theta: -0.03, vega: 0.12 },
        },
      },
      next_page_token: null,
    });
  }
  return json(res, 404, { message: "mock route not found" });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  if (!/^\/(v2\/sip|v1beta1\/opra)$/.test(path) || !validProviderHeaders(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n"));
  socket.path = path;
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
});

server.listen(port, "0.0.0.0");
