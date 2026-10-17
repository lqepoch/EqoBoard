"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const SYM = /^[A-Z][A-Z0-9.-]{0,11}$/;
  const PINNED = ["QQQ", "SPY"];
  const DEFAULT_WATCH = ["QQQ", "SPY", "TSLA", "AAPL", "NVDA", "MSFT", "IWM", "AMD"];
  const TF_SEC = { "1s": 1, "5s": 5, "10s": 10, "1m": 60, "5m": 300, "10m": 600, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400 };
  const SECOND_TF = new Set(["1s", "5s", "10s"]);
  const DAILY_TF = new Set(["D", "W", "M"]);
  const MAX_BARS = 3600;
  const GAP_FILL_S = 60;
  // Local seconds cache keeps one hour; the 2 hour window still shows the axis, with the older part empty.
  const CACHE_CAP_S = 3600;
  // Default visible span per timeframe when a chart opens (seconds, or days for daily and longer).
  const VIEW_SEC = { "1m": 6 * 3600, "5m": 3 * 86400, "10m": 5 * 86400, "15m": 5 * 86400, "30m": 10 * 86400, "1h": 30 * 86400, "2h": 60 * 86400, "4h": 120 * 86400 };
  const VIEW_DAYS = { D: 365, W: 5 * 365, M: 10 * 365 };
  const WINDOW_LABEL = { 600: "10 分钟", 1800: "30 分钟", 3600: "1 小时", 7200: "2 小时" };
  const ERR_TEXT = {
    futu_disconnected: "富途 OpenD 未连接",
    stock_buffer_full: "订阅名额已满",
    quota_unavailable: "富途订阅额度不足",
    alpaca_unconfigured: "未配置 Alpaca 密钥",
    alpaca_unavailable: "Alpaca 暂时不可用",
    yfinance_unavailable: "yfinance 暂时不可用",
    unsupported_timeframe: "不支持的周期",
    invalid_symbol: "代码格式不对",
    futu_read_failed: "富途读取失败",
    upstream_failed: "上游暂时不可用",
  };

  // ---------- formatting ----------
  const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const etDayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  const etClock = (ms) => etFmt.format(new Date(ms));
  const etClockMs = (ms) => `${etFmt.format(new Date(ms))}.${String(ms % 1000).padStart(3, "0")}`;
  // Chart times are ET. The library would format them with the viewer's local clock, so the axis
  // would show another timezone's hours.
  const etHm = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  const etMd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit" });
  const chartTime = (time) => (typeof time === "number" ? `${etClock(time * 1000)} ET` : String(time));
  const chartTick = (time, type, LC) => {
    if (typeof time !== "number") return String(time);
    if (type === LC.TickMarkType.Time) return etHm.format(new Date(time * 1000));
    if (type === LC.TickMarkType.TimeWithSeconds) return etClock(time * 1000);
    return etMd.format(new Date(time * 1000));
  };
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const px = (v, d = 2) => (isNum(v) ? v.toFixed(d) : "—");
  const pxSmart = (v) => (isNum(v) ? (Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? v.toFixed(2) : v.toFixed(4)) : "—");
  const pct = (v) => (isNum(v) ? `${v > 0 ? "+" : ""}${v.toFixed(2)}%` : "—");
  const signed = (v) => (isNum(v) ? `${v > 0 ? "+" : ""}${v.toFixed(2)}` : "—");
  const size = (v) => (isNum(v) ? (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(3)) : "—");
  const cn = (v) => {
    if (!isNum(v)) return "—";
    if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
    if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
    return Math.round(v).toLocaleString("en-US");
  };
  const upDown = (v) => (isNum(v) ? (v >= 0 ? "up" : "down") : "");
  const shiftDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const setText = (id, text) => {
    $(id).textContent = text;
  };

  function sessionLabel(ms) {
    const parts = Object.fromEntries(etDayFmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    if (parts.weekday === "Sat" || parts.weekday === "Sun") return "周末休市（ET）";
    const mins = Number(parts.hour) * 60 + Number(parts.minute);
    if (mins >= 570 && mins < 960) return "美股正盘（ET）";
    if (mins >= 240 && mins < 570) return "盘前（ET）";
    if (mins >= 960 && mins < 1200) return "盘后（ET）";
    return "休市（ET）";
  }

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  async function api(path) {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = body.error ?? `http_${res.status}`;
      const err = new Error(code);
      err.code = code;
      throw err;
    }
    return body;
  }
  const errText = (e) => ERR_TEXT[e?.code] ?? "请求失败";

  // ---------- state ----------
  function loadWatch() {
    try {
      const raw = JSON.parse(localStorage.getItem("desk.watch") ?? "null");
      if (Array.isArray(raw)) {
        const list = raw.filter((s) => typeof s === "string" && SYM.test(s));
        if (list.length) return [...new Set([...PINNED, ...list])];
      }
    } catch {
      // Blocked storage falls back to the default list.
    }
    return [...DEFAULT_WATCH];
  }
  function saveWatch() {
    try {
      localStorage.setItem("desk.watch", JSON.stringify(state.watch));
    } catch {
      // Ignored: the list resets on reload.
    }
  }

  const state = {
    watch: loadWatch(),
    current: "TSLA",
    tf: "1m",
    secWindow: 600,
    view: "chart",
    quotes: new Map(),
    header: null,
    trades: [],
    // 1s bars of the current symbol. For tf 1s this is the same array as `bars`.
    base: [],
    // Bars drawn on the chart (for 5s and 10s these are derived from `base`).
    bars: [],
    ready: false,
    source: null,
    asOfSeq: 0,
    depth: null,
    rateCount: 0,
    es: null,
    expiry: null,
    expiries: [],
    chainTimer: null,
    optSide: "all",
    chain: null,
    chainFocus: null,
    // Moneyness filter for the option chain: all, itm (in the money) or otm (out of the money).
    optMoney: "all",
    // Subscription confirmation for the current symbol, from the server's 'subscribed' event.
    subAcked: null,
    subError: null,
  };

  // ---------- chart ----------
  let chart = null;
  let candles = null;
  let volume = null;
  // True while the crosshair is over a bar; live updates must not overwrite that readout.
  let hovering = false;

  function initChart() {
    const LC = window.LightweightCharts;
    if (!LC) {
      notice("图表库没有加载，请检查网络后刷新。");
      return;
    }
    chart = LC.createChart($("chart"), {
      autoSize: true,
      layout: {
        background: { type: LC.ColorType.Solid, color: "#0d1015" },
        textColor: "#8a94a4",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: "#161c26" }, horzLines: { color: "#161c26" } },
      crosshair: { mode: LC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#232a36", scaleMargins: { top: 0.1, bottom: 0.25 } },
      localization: { timeFormatter: chartTime },
      timeScale: {
        borderColor: "#232a36",
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 4,
        tickMarkFormatter: (time, type) => chartTick(time, type, LC),
      },
    });
    candles = chart.addSeries(LC.CandlestickSeries, {
      upColor: "#2fc182",
      downColor: "#ff5d5d",
      borderUpColor: "#2fc182",
      borderDownColor: "#ff5d5d",
      wickUpColor: "#2fc182",
      wickDownColor: "#ff5d5d",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    volume = chart.addSeries(LC.HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.subscribeCrosshairMove((param) => {
      hovering = Boolean(param && param.time !== undefined);
      legend(param);
    });
  }

  function notice(text) {
    const el = $("chartNotice");
    el.textContent = text;
    el.hidden = !text;
  }

  const candleOf = (b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c });
  const volumeOf = (b) => ({ time: b.t, value: b.v ?? 0, color: b.c >= b.o ? "rgba(47,193,130,0.42)" : "rgba(255,93,93,0.42)" });

  // Seconds timeframes show a fixed window ending now, so the axis always spans the selected
  // time even when less history has accumulated (the missing part stays empty).
  function applyWindow() {
    if (!chart || !SECOND_TF.has(state.tf)) return;
    const now = Math.floor(Date.now() / 1000);
    chart.timeScale().setVisibleRange({ from: now - state.secWindow, to: now + 10 });
  }

  // Minute and longer timeframes open on a default span set per timeframe, not on the whole history.
  function applyView() {
    if (!chart) return;
    if (SECOND_TF.has(state.tf)) return applyWindow();
    const last = state.bars[state.bars.length - 1];
    if (!last) return;
    if (DAILY_TF.has(state.tf)) {
      chart.timeScale().setVisibleRange({ from: shiftDay(last.t, -VIEW_DAYS[state.tf]), to: last.t });
      return;
    }
    chart.timeScale().setVisibleRange({ from: last.t - VIEW_SEC[state.tf], to: last.t + TF_SEC[state.tf] * 4 });
  }

  function setBars(bars) {
    if (!candles) return;
    candles.setData(bars.map(candleOf));
    volume.setData(bars.map(volumeOf));
    state.ready = true;
    applyView();
    legend(null);
  }

  function publish(list) {
    for (const b of list) {
      candles.update(candleOf(b));
      volume.update(volumeOf(b));
    }
    if (!hovering) legend(null);
  }

  /**
   * Adds one trade to a bar list at the given bucket size. Mirrors the server cache: only trades
   * flagged movesPrice move the price; other prints add volume at the previous price.
   * Seconds carry the price across gaps up to 60 s.
   * Returns the index of the first bar that changed, or -1 when the trade was skipped.
   */
  function ingest(bars, secs, trade) {
    const bucket = Math.floor(trade.ms / 1000 / secs) * secs;
    const last = bars[bars.length - 1];
    if (last && bucket < last.t) return -1;
    const price = trade.movesPrice ? trade.price : last ? last.c : null;
    if (price === null) return -1;
    if (last && bucket === last.t) {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
      last.v = (last.v ?? 0) + trade.size;
      last.n = (last.n ?? 0) + 1;
      return bars.length - 1;
    }
    const first = bars.length;
    if (last && secs < 60 && bucket - last.t <= GAP_FILL_S) {
      for (let t = last.t + secs; t < bucket; t += secs) {
        bars.push({ t, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, n: 0, filled: true });
      }
    }
    bars.push({ t: bucket, o: price, h: price, l: price, c: price, v: trade.size, n: 1 });
    const drop = Math.max(0, bars.length - MAX_BARS);
    if (drop) bars.splice(0, drop);
    return Math.max(0, first - drop);
  }

  /** Builds 5s or 10s bars from 1s bars. Same rule as the server: open first, close last, sums for volume. */
  function deriveSeconds(base, secs) {
    const out = [];
    for (const b of base) {
      const t = Math.floor(b.t / secs) * secs;
      const last = out[out.length - 1];
      if (last && last.t === t) {
        last.h = Math.max(last.h, b.h);
        last.l = Math.min(last.l, b.l);
        last.c = b.c;
        last.v += b.v;
        last.n += b.n;
        last.filled = Boolean(last.filled && b.filled);
      } else {
        out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: b.n, filled: Boolean(b.filled) });
      }
    }
    return out;
  }

  function applySecondTrade(trade, secs) {
    const from = ingest(state.base, 1, trade);
    if (from < 0) return;
    if (secs === 1) {
      publish(state.bars.slice(from));
      return;
    }
    // 5s and 10s are rebuilt from the 1s bars that changed, never from raw trades.
    const bucket = Math.floor(state.base[from].t / secs) * secs;
    let start = state.base.length;
    while (start > 0 && state.base[start - 1].t >= bucket) start -= 1;
    const tail = deriveSeconds(state.base.slice(start), secs);
    while (state.bars.length && state.bars[state.bars.length - 1].t >= bucket) state.bars.pop();
    state.bars.push(...tail);
    if (state.bars.length > MAX_BARS) state.bars.splice(0, state.bars.length - MAX_BARS);
    publish(tail);
  }

  function applyTrade(trade) {
    if (!candles || !state.ready) return;
    if (trade.seq <= state.asOfSeq) return; // already inside the bars response
    const secs = TF_SEC[state.tf];
    if (!secs || DAILY_TF.has(state.tf)) return;
    if (SECOND_TF.has(state.tf)) {
      applySecondTrade(trade, secs);
      return;
    }
    const from = ingest(state.bars, secs, trade);
    if (from < 0) return;
    publish(state.bars.slice(from));
  }

  function legend(param) {
    let bar = null;
    if (param && param.time !== undefined && param.seriesData && candles) {
      const c = param.seriesData.get(candles);
      if (c) bar = state.bars.find((b) => b.t === c.time) ?? null;
    }
    if (!bar) bar = state.bars[state.bars.length - 1] ?? null;
    if (!bar) {
      $("legend").replaceChildren();
      return;
    }
    const when = typeof bar.t === "string" ? bar.t : `${etClock(bar.t * 1000)} ET`;
    const up = bar.c >= bar.o;
    const nodes = [
      h("span", {}, when),
      h("span", {}, ["开 ", h("b", {}, px(bar.o))]),
      h("span", {}, ["高 ", h("b", {}, px(bar.h))]),
      h("span", {}, ["低 ", h("b", {}, px(bar.l))]),
      h("span", {}, ["收 ", h("b", { class: up ? "up" : "down" }, px(bar.c))]),
      h("span", {}, ["量 ", h("b", {}, size(bar.v))]),
    ];
    if (bar.filled) nodes.push(h("span", { class: "subtle" }, "无成交·上一价平推"));
    $("legend").replaceChildren(...nodes);
  }

  function renderFoot() {
    if (!SECOND_TF.has(state.tf)) {
      $("chartFoot").textContent = state.source ?? "";
      return;
    }
    const first = state.base[0]?.t ?? null;
    const covered = first ? Math.max(0, Math.floor((Date.now() / 1000 - first) / 60)) : 0;
    const cap = state.secWindow > CACHE_CAP_S ? " · 秒级缓存上限 60 分钟，更早时段无数据" : "";
    $("chartFoot").textContent = `${state.source ?? "富途逐笔"} · 已累积 ${covered} 分钟 · 窗口 ${WINDOW_LABEL[state.secWindow]}${cap}`;
  }

  async function loadChart() {
    const sym = state.current;
    const tf = state.tf;
    const seconds = SECOND_TF.has(tf);
    state.ready = false;
    $("windowSeg").hidden = !seconds;
    notice("加载中…");
    try {
      // Seconds timeframes load the 1s base once (the whole cache hour); 5s and 10s are derived here.
      const fetchTf = seconds ? "1s" : tf;
      const limit = seconds ? CACHE_CAP_S : 1000;
      const body = await api(`/api/bars?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(fetchTf)}&limit=${limit}`);
      if (state.current !== sym || state.tf !== tf) return;
      state.asOfSeq = body.asOfSeq ?? 0;
      state.source = body.source;
      if (tf === "1s") {
        state.base = body.bars.slice();
        state.bars = state.base;
      } else if (seconds) {
        state.base = body.bars.slice();
        state.bars = deriveSeconds(state.base, TF_SEC[tf]);
      } else {
        state.base = [];
        state.bars = body.bars.slice();
      }
      setBars(state.bars);
      renderFoot();
      notice(state.bars.length ? "" : seconds ? "本地还没有该窗口的逐笔，从订阅开始累积。" : body.localOnly ? "最近 20 分钟还没有富途逐笔成交。" : "没有返回数据。");
    } catch (e) {
      notice(errText(e));
    }
  }

  // ---------- quotes, watchlist, header ----------
  function renderWatch() {
    const rows = state.watch.map((sym) => {
      const q = state.quotes.get(sym);
      const last = q?.last ?? null;
      const prev = q?.prevClose ?? null;
      const d = isNum(last) && isNum(prev) ? last - prev : null;
      const p = d !== null && prev ? (d / prev) * 100 : null;
      const cls = upDown(d);
      const pinned = PINNED.includes(sym);
      const row = h("div", { class: `wrow${sym === state.current ? " active" : ""}`, "data-sym": sym, tabindex: "0" }, [
        h("div", {}, [
          h("div", { class: "wname" }, [sym, pinned ? h("span", { class: "tag" }, "常驻逐笔") : ""]),
          h("div", { class: "wcode" }, `US.${sym}`),
        ]),
        h("div", { class: `wlast ${cls}` }, px(last)),
        h("div", { class: `wchg ${cls}` }, pct(p)),
      ]);
      if (!pinned) row.append(h("button", { class: "wdel", type: "button", "aria-label": `移除 ${sym}`, title: "移除" }, "×"));
      return row;
    });
    // The list re-renders every few seconds; keep keyboard focus on the same row across it.
    const focused = document.activeElement?.closest?.(".wrow")?.dataset.sym ?? null;
    $("watchList").replaceChildren(...rows);
    if (focused) $("watchList").querySelector(`.wrow[data-sym="${focused}"]`)?.focus({ preventScroll: true });
    $("watchCount").textContent = `${state.watch.length} 只`;
  }

  async function pollWatch() {
    try {
      const body = await api(`/api/quote?symbols=${encodeURIComponent(state.watch.slice(0, 32).join(","))}`);
      for (const q of body.quotes) state.quotes.set(q.symbol, q);
      renderWatch();
      renderHeader();
      renderSide();
      $("watchCount").textContent = `${state.watch.length} 只 · ${etClock(Date.now())} ET 更新`;
    } catch {
      // The connection line is owned by renderLink (pollStatus and the live status event); a failed quote poll does not override it.
    }
  }

  function renderHeader() {
    const sym = state.current;
    const q = state.quotes.get(sym);
    const last = q?.last ?? null;
    const prev = q?.prevClose ?? null;
    const d = isNum(last) && isNum(prev) ? last - prev : null;
    const p = d !== null && prev ? (d / prev) * 100 : null;
    setText("symName", state.header?.name ?? sym);
    setText("symCode", `US.${sym}`);
    setText("symPx", px(last));
    $("symPx").className = `price ${upDown(d)}`;
    setText("symChg", `${signed(d)}  ${pct(p)}`);
    $("symChg").className = `chg ${upDown(d)}`;
  }

  function renderSide() {
    const sym = state.current;
    const q = state.quotes.get(sym);
    const last = q?.last ?? null;
    const prev = q?.prevClose ?? null;
    const d = isNum(last) && isNum(prev) ? last - prev : null;
    const p = d !== null && prev ? (d / prev) * 100 : null;
    setText("sideName", state.header?.name ?? sym);
    setText("sidePx", px(last));
    $("sidePx").className = `side-px ${upDown(d)}`;
    setText(
      "sideStatus",
      q?.updatedAt
        ? `${signed(d)}  ${pct(p)} · 富途 ${etClock(Date.parse(q.updatedAt))} ET · ${sessionLabel(Date.parse(q.updatedAt))}`
        : "等待富途报价",
    );
    const hd = state.header;
    const set = (id, v, f = px) => setText(id, v === null || v === undefined ? "—" : f(v));
    set("stHigh", hd?.high ?? null);
    set("stLow", hd?.low ?? null);
    set("stOpen", hd?.open ?? null);
    set("stPrev", hd?.prevClose ?? null);
    set("stVol", hd?.volume ?? null, cn);
    set("stCap", hd?.marketCap ?? null, cn);
    set("stPe", hd?.trailingPe ?? null);
    set("stHi52", hd?.week52High ?? null);
    set("stLo52", hd?.week52Low ?? null);
  }

  async function loadHeader() {
    const sym = state.current;
    try {
      const body = await api(`/api/quote?symbols=${encodeURIComponent(sym)}&header=1`);
      if (state.current !== sym) return;
      for (const q of body.quotes) state.quotes.set(q.symbol, q);
      state.header = body.header ?? null;
      renderHeader();
      renderSide();
    } catch (e) {
      setText("sideStatus", errText(e));
    }
  }

  // ---------- live stream (Futu OpenD through the server) ----------
  // Coalesced timers, not requestAnimationFrame: rAF pauses in background panes and would freeze the tape and ladder.
  let tapeQueued = false;
  let depthQueued = false;
  const queueTape = () => {
    if (tapeQueued) return;
    tapeQueued = true;
    setTimeout(() => {
      tapeQueued = false;
      renderTape();
    }, 100);
  };
  const queueDepth = () => {
    if (depthQueued) return;
    depthQueued = true;
    setTimeout(() => {
      depthQueued = false;
      renderDepth();
    }, 100);
  };

  // Four fixed columns, shared with the header row in app.css: time, price, size, odd-lot mark.
  function renderTape() {
    const trades = state.trades;
    const rows = [];
    for (let i = trades.length - 1; i >= 0 && rows.length < 200; i -= 1) {
      const t = trades[i];
      const prev = trades[i - 1];
      const cls = !prev || t.price === prev.price ? "" : t.price > prev.price ? "up" : "down";
      rows.push(
        h("div", { class: `trow ${cls}`, title: "零 表示零股成交" }, [
          h("span", { class: "t" }, etClockMs(t.ms)),
          h("span", { class: "p" }, pxSmart(t.price)),
          h("span", { class: "q" }, size(t.size)),
          h("span", { class: "o" }, t.oddLot ? "零" : ""),
        ]),
      );
    }
    if (!rows.length) rows.push(h("div", { class: "tape-empty" }, "暂无逐笔成交"));
    $("tapeRows").replaceChildren(...rows);
    $("tapeCount").textContent = `${trades.length} 笔`;
  }

  // Bid rows read price then size, the bar anchors to the outer (left) edge. Ask rows mirror it.
  function levelRow(level, kind, maxSize) {
    const width = `${(((level.size ?? 0) / maxSize) * 100).toFixed(1)}%`;
    const cells = kind === "bid"
      ? [h("span", {}, px(level.price)), h("span", {}, size(level.size))]
      : [h("span", {}, size(level.size)), h("span", {}, px(level.price))];
    return h("div", { class: `dlvl ${kind}`, style: `--w:${width}` }, cells);
  }

  function renderDepth() {
    const d = state.depth;
    if (!d) {
      // Keep the 10 rows per side as dashes so the ladder does not jump in height when Futu data arrives.
      $("depthBid").replaceChildren(...Array.from({ length: 10 }, () => levelRow({}, "bid", 1)));
      $("depthAsk").replaceChildren(...Array.from({ length: 10 }, () => levelRow({}, "ask", 1)));
      for (const id of ["bboBidPx", "bboBidSz", "bboAskPx", "bboAskSz", "bbBuyPct", "bbSellPct"]) setText(id, "—");
      $("bbBuy").style.width = "50%";
      $("bbSell").style.width = "50%";
      return;
    }
    const bids = d.bids.slice(0, 10);
    const asks = d.asks.slice(0, 10);
    const maxSize = Math.max(1, ...bids.map((l) => l.size ?? 0), ...asks.map((l) => l.size ?? 0));
    $("depthBid").replaceChildren(...bids.map((l) => levelRow(l, "bid", maxSize)));
    $("depthAsk").replaceChildren(...asks.map((l) => levelRow(l, "ask", maxSize)));
    const buy = bids.reduce((s, l) => s + (l.size ?? 0), 0);
    const sell = asks.reduce((s, l) => s + (l.size ?? 0), 0);
    const total = buy + sell;
    const buyPct = total > 0 ? (buy / total) * 100 : 50;
    $("bbBuy").style.width = `${buyPct}%`;
    $("bbSell").style.width = `${100 - buyPct}%`;
    setText("bbBuyPct", `${buyPct.toFixed(0)}%`);
    setText("bbSellPct", `${(100 - buyPct).toFixed(0)}%`);
    const b1 = bids[0];
    const a1 = asks[0];
    setText("bboBidPx", px(b1?.price ?? null));
    setText("bboBidSz", isNum(b1?.size) ? size(b1.size) : "—");
    setText("bboAskPx", px(a1?.price ?? null));
    setText("bboAskSz", isNum(a1?.size) ? size(a1.size) : "—");
  }

  function onTrade(t) {
    state.trades.push(t);
    if (state.trades.length > 300) state.trades.splice(0, state.trades.length - 200);
    state.rateCount += 1;
    applyTrade(t);
    queueTape();
  }

  function connectStream() {
    if (state.es) state.es.close();
    const sym = state.current;
    const es = new EventSource(`/api/stream?symbols=${encodeURIComponent(sym)}`);
    state.es = es;
    const data = (ev) => JSON.parse(ev.data);
    es.addEventListener("history", (ev) => {
      if (state.current !== sym) return;
      const d = data(ev);
      state.trades = d.trades ?? [];
      state.depth = d.depth ?? null;
      if (d.quote) state.quotes.set(sym, d.quote);
      renderTape();
      queueDepth();
      renderHeader();
      renderSide();
    });
    es.addEventListener("trade", (ev) => {
      if (state.current === sym) onTrade(data(ev));
    });
    es.addEventListener("depth", (ev) => {
      if (state.current !== sym) return;
      state.depth = data(ev);
      queueDepth();
    });
    es.addEventListener("quote", (ev) => {
      if (state.current !== sym) return;
      state.quotes.set(sym, data(ev));
      renderHeader();
      renderSide();
    });
    es.addEventListener("status", (ev) => {
      renderLink(data(ev));
    });
    es.addEventListener("subscribed", (ev) => {
      if (state.current !== sym) return;
      state.subAcked = new Set(data(ev).subscribed ?? []);
      state.subError = null;
      renderSub();
    });
    es.addEventListener("fault", (ev) => {
      if (state.current !== sym) return;
      const text = ERR_TEXT[data(ev).code] ?? "订阅失败";
      state.subError = text;
      renderSub();
      notice(text);
    });
  }

  // ---------- options (Alpaca indicative) ----------
  const CALL_LABELS = ["时间价值", "涨跌", "买量", "卖量", "卖出价", "买入价"];
  const PUT_LABELS = ["买入价", "卖出价", "卖量", "买量", "涨跌", "时间价值"];
  const contracts = (v) => (isNum(v) ? `${cn(v)}张` : "—");

  function expiryLabel(expiry) {
    const tdy = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const days = Math.max(0, Math.round((Date.parse(`${expiry}T00:00:00Z`) - tdy) / 86_400_000));
    return `${expiry.slice(5).replace("-", "/")} (${days}天)`;
  }

  function renderExpiries() {
    $("expiries").replaceChildren(
      ...state.expiries.map((ex) => h("button", { class: `exp${ex === state.expiry ? " on" : ""}`, type: "button", "data-exp": ex }, expiryLabel(ex))),
    );
  }

  async function loadOptions() {
    const sym = state.current;
    if (state.chainTimer) clearInterval(state.chainTimer);
    setText("optNote", "正在加载期权到期日…");
    try {
      const body = await api(`/api/options/expiries?underlying=${encodeURIComponent(sym)}`);
      if (state.current !== sym) return;
      state.expiries = body.expiries ?? [];
      if (!state.expiry || !state.expiries.includes(state.expiry)) state.expiry = state.expiries[0] ?? null;
      renderExpiries();
      await loadChain();
      state.chainTimer = setInterval(loadChain, 15_000);
    } catch (e) {
      setText("optNote", errText(e));
    }
  }

  async function loadChain() {
    const sym = state.current;
    const exp = state.expiry;
    if (!exp) return;
    try {
      const body = await api(`/api/options/chain?underlying=${encodeURIComponent(sym)}&expiry=${encodeURIComponent(exp)}`);
      if (state.current !== sym || state.expiry !== exp) return;
      renderChain(body);
    } catch (e) {
      setText("optNote", errText(e));
    }
  }

  // One leg of a strike row. Call legs read left to right from the centre; put legs mirror them.
  // Ask prices carry the green tint and bid prices the red tint, as in the Futu reference.
  function legCells(r, kind, itm) {
    const td = (cls, text) => h("td", { class: itm ? `${cls} itm` : cls }, text);
    if (!r) return Array.from({ length: 6 }, () => td("", "—"));
    const ask = td("px ask", px(r.ask));
    const bid = td("px bid", px(r.bid));
    const chg = td(upDown(r.change), pct(r.change));
    const bidQty = td("", contracts(r.bidSize));
    const askQty = td("", contracts(r.askSize));
    const tv = td("", px(r.timeValue));
    return kind === "call" ? [tv, chg, bidQty, askQty, ask, bid] : [bid, ask, askQty, bidQty, chg, tv];
  }

  function strikeRow(s, side, spot, atm) {
    const callItm = isNum(spot) && s.strike < spot;
    const putItm = isNum(spot) && s.strike > spot;
    const cells = [];
    if (side !== "put") cells.push(...legCells(s.call, "call", callItm));
    cells.push(h("td", { class: "strike" }, px(s.strike)));
    if (side !== "call") cells.push(...legCells(s.put, "put", putItm));
    return h("tr", { class: s.strike === atm ? "atm" : "" }, cells);
  }

  // The divider between strikes above and below the underlying, as in the Futu chain.
  function spotRow(spot, prev, width) {
    const d = isNum(spot) && isNum(prev) ? spot - prev : null;
    const p = d !== null && prev ? (d / prev) * 100 : null;
    return h("tr", { class: "spot" }, [
      h("td", { colspan: width }, [`${state.current} ${px(spot)}  `, h("span", { class: upDown(d) }, `${signed(d)}  ${pct(p)}`)]),
    ]);
  }

  function headRows(side, totals, atmIv) {
    const groups = [];
    if (side !== "put") groups.push(h("th", { class: "grp", colspan: 6 }, `看涨 · 成交 ${contracts(totals.callVol)}`));
    groups.push(h("th", { class: "grp strike" }, `IV ${isNum(atmIv) ? `${(atmIv * 100).toFixed(2)}%` : "—"}`));
    if (side !== "call") groups.push(h("th", { class: "grp", colspan: 6 }, `看跌 · 成交 ${contracts(totals.putVol)}`));
    const labels = [];
    if (side !== "put") labels.push(...CALL_LABELS.map((t) => h("th", {}, t)));
    labels.push(h("th", { class: "strike" }, "行权价"));
    if (side !== "call") labels.push(...PUT_LABELS.map((t) => h("th", {}, t)));
    return [h("tr", {}, groups), h("tr", {}, labels)];
  }

  function renderChain(body) {
    state.chain = body;
    const rows = body.rows ?? [];
    const spot = body.spot ?? null;
    const side = state.optSide;
    const byStrike = new Map();
    for (const r of rows) {
      if (!isNum(r.strike)) continue;
      const entry = byStrike.get(r.strike) ?? { strike: r.strike, call: null, put: null };
      entry[r.type] = r;
      byStrike.set(r.strike, entry);
    }
    const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
    // Calls are in the money below the spot and puts above it; the ATM strike is in neither group.
    const moneyKeep = (s) => {
      if (state.optMoney === "all" || side === "all" || !isNum(spot)) return true;
      const itm = side === "call" ? s.strike < spot : s.strike > spot;
      const otm = side === "call" ? s.strike > spot : s.strike < spot;
      return state.optMoney === "itm" ? itm : otm;
    };
    const shown = strikes.filter(moneyKeep);
    const sum = (type, key) => rows.filter((r) => r.type === type).reduce((s, r) => s + (isNum(r[key]) ? r[key] : 0), 0);
    const totals = {
      callVol: sum("call", "volume"),
      putVol: sum("put", "volume"),
      callOi: sum("call", "openInterest"),
      putOi: sum("put", "openInterest"),
    };
    const atmStrike = isNum(spot) && strikes.length
      ? strikes.reduce((best, s) => (Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best)).strike
      : null;
    const atmIvs = strikes.filter((s) => s.strike === atmStrike).map((s) => s.call?.iv ?? s.put?.iv).filter(isNum);
    const atmIv = atmIvs.length ? atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length : null;
    const quoteTimes = rows.map((r) => r.quoteAt ?? r.lastAt).filter(Boolean).map((t) => Date.parse(t)).filter(isNum);
    const latestQuote = quoteTimes.length ? Math.max(...quoteTimes) : null;
    const prev = state.quotes.get(state.current)?.prevClose ?? null;

    const ratio = (num, den) => (den > 0 ? (num / den).toFixed(2) : "—");
    const metric = (label, value) => h("span", {}, [label, h("b", {}, value)]);
    $("optSummary").replaceChildren(
      metric("标的价", px(spot)),
      metric("成交量", contracts(totals.callVol + totals.putVol)),
      metric("Put/Call 成交量比", ratio(totals.putVol, totals.callVol)),
      metric("持仓量", contracts(totals.callOi + totals.putOi)),
      metric("Put/Call 持仓量比", ratio(totals.putOi, totals.callOi)),
      metric("IV", isNum(atmIv) ? `${(atmIv * 100).toFixed(2)}%` : "—"),
    );
    const lagSec = latestQuote ? Math.max(0, Math.round((Date.now() - latestQuote) / 1000)) : null;
    setText(
      "optNote",
      `Alpaca 指示性数据：最近报价 ${latestQuote ? etClock(latestQuote) : "—"} ET，距今约 ${lagSec ?? "—"} 秒（实测）。` +
        "IV 与希腊字母未提供，显示 —。标的价来自富途 OpenD。",
    );

    const width = side === "all" ? 13 : 7;
    $("optHead").replaceChildren(...headRows(side, totals, atmIv));
    const trs = [];
    let spotShown = false;
    for (const s of shown) {
      if (!spotShown && isNum(spot) && s.strike > spot) {
        trs.push(spotRow(spot, prev, width));
        spotShown = true;
      }
      trs.push(strikeRow(s, side, spot, atmStrike));
    }
    if (!spotShown && isNum(spot) && shown.length) trs.push(spotRow(spot, prev, width));
    if (!shown.length) {
      trs.push(h("tr", {}, [h("td", { class: "empty", colspan: width }, strikes.length ? "当前价位筛选下没有合约" : "暂无合约")]));
    }
    $("optBody").replaceChildren(...trs);
    // Like the Futu chain, open centred on the underlying; re-centre when the symbol or expiry changes.
    const focusKey = `${state.current}|${state.expiry}`;
    const spotEl = $("optBody").querySelector("tr.spot");
    const wrap = document.querySelector(".opt-wrap");
    if (spotEl && state.chainFocus !== focusKey && !$("optionsView").hidden) {
      state.chainFocus = focusKey;
      wrap.scrollTop += spotEl.getBoundingClientRect().top - wrap.getBoundingClientRect().top - wrap.clientHeight / 2;
    }
  }

  // Subscription state for the current symbol: the server confirms it once Futu accepts the subscription.
  function renderSub() {
    const sym = state.current;
    let text;
    if (state.subError) text = `订阅未生效：${state.subError}`;
    else if (!state.subAcked) text = "订阅：等待富途确认";
    else if (state.subAcked.has(sym)) text = `订阅：已确认（富途共 ${state.subAcked.size} 个标的）`;
    else text = "订阅：未确认，等待富途";
    setText("sideSub", text);
  }

  // Moneyness is defined per side, so it is only usable when the chain shows calls or puts alone.
  function syncMoneyness() {
    const usable = state.optSide !== "all";
    for (const b of document.querySelectorAll("#optMoney .fbtn")) {
      b.disabled = !usable;
      b.title = usable ? "" : "选择看涨或看跌后可用";
    }
  }

  // ---------- switching ----------
  function setCurrent(sym) {
    if (!SYM.test(sym)) return;
    if (!state.watch.includes(sym)) {
      state.watch.push(sym);
      saveWatch();
    }
    state.current = sym;
    state.trades = [];
    state.depth = null;
    state.header = null;
    state.base = [];
    state.bars = [];
    state.ready = false;
    state.source = null;
    state.asOfSeq = 0;
    state.chain = null;
    state.subAcked = null;
    state.subError = null;
    renderSub();
    renderWatch();
    renderHeader();
    renderSide();
    renderTape();
    renderDepth();
    connectStream();
    loadChart();
    loadHeader();
    if (state.view === "options") loadOptions();
  }

  function setView(view) {
    state.view = view;
    for (const b of document.querySelectorAll(".tab")) {
      const on = b.dataset.view === view;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    $("chartView").hidden = view !== "chart";
    $("optionsView").hidden = view !== "options";
    if (view === "options") {
      loadOptions();
    } else if (state.chainTimer) {
      clearInterval(state.chainTimer);
      state.chainTimer = null;
    }
  }

  // ---------- events ----------
  $("watchList").addEventListener("click", (event) => {
    const row = event.target.closest(".wrow");
    if (!row) return;
    const sym = row.dataset.sym;
    if (event.target.closest(".wdel")) {
      if (PINNED.includes(sym)) return;
      state.watch = state.watch.filter((s) => s !== sym);
      saveWatch();
      if (state.current === sym) setCurrent(state.watch[0] ?? "QQQ");
      else renderWatch();
      return;
    }
    setCurrent(sym);
  });
  // Rows are focusable; Enter or Space selects the symbol, as a click does.
  $("watchList").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".wrow");
    if (!row || event.target !== row) return;
    event.preventDefault();
    setCurrent(row.dataset.sym);
  });
  $("addForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("addInput");
    setCurrent(input.value.trim().toUpperCase());
    input.value = "";
  });
  $("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("searchInput");
    setCurrent(input.value.trim().toUpperCase());
    input.value = "";
  });
  for (const b of document.querySelectorAll(".tf")) {
    b.addEventListener("click", () => {
      state.tf = b.dataset.tf;
      for (const x of document.querySelectorAll(".tf")) x.classList.toggle("on", x === b);
      loadChart();
    });
  }
  for (const b of document.querySelectorAll(".win")) {
    b.addEventListener("click", () => {
      // The window only moves the axis; the 1s base already holds the whole cache hour.
      state.secWindow = Number(b.dataset.win);
      for (const x of document.querySelectorAll(".win")) x.classList.toggle("on", x === b);
      applyWindow();
      renderFoot();
    });
  }
  for (const b of document.querySelectorAll(".tab")) {
    b.addEventListener("click", () => setView(b.dataset.view));
  }
  $("expiries").addEventListener("click", (event) => {
    const btn = event.target.closest(".exp");
    if (!btn) return;
    state.expiry = btn.dataset.exp;
    renderExpiries();
    loadChain();
  });
  $("optSide").addEventListener("click", (event) => {
    const btn = event.target.closest(".fbtn");
    if (!btn) return;
    state.optSide = btn.dataset.side;
    for (const b of document.querySelectorAll("#optSide .fbtn")) b.classList.toggle("on", b === btn);
    // Moneyness needs a single side; with both sides shown the filter resets so the buttons match the rows.
    if (state.optSide === "all") {
      state.optMoney = "all";
      for (const b of document.querySelectorAll("#optMoney .fbtn")) b.classList.toggle("on", b.dataset.money === "all");
    }
    syncMoneyness();
    if (state.chain) renderChain(state.chain);
  });
  $("optMoney").addEventListener("click", (event) => {
    const btn = event.target.closest(".fbtn");
    if (!btn || btn.disabled) return;
    state.optMoney = btn.dataset.money;
    for (const b of document.querySelectorAll("#optMoney .fbtn")) b.classList.toggle("on", b === btn);
    if (state.chain) renderChain(state.chain);
  });

  // ---------- timers ----------
  // The SDK reports connection changes on the live stream; this poll covers the page before any stream opens.
  const LINK_TEXT = { idle: "未启动", connecting: "连接中", connected: "已连接", reconnecting: "重连中", login_rejected: "登录被拒绝" };
  function renderLink(f) {
    const state = f.connected ? "connected" : (f.state ?? "idle");
    const pill = $("futuPill");
    if (f.connected) {
      pill.textContent = `富途 · 已连接${f.quota ? ` · 剩余额度 ${f.quota.remain}` : ""}`;
    } else if (state === "reconnecting") {
      pill.textContent = `富途 · 重连中（第 ${f.attempts} 次）`;
    } else {
      pill.textContent = `富途 · ${LINK_TEXT[state] ?? "未连接"}`;
    }
    pill.className = `pill ${f.connected ? "ok" : "bad"}`;
    const reason = !f.connected && f.reason ? ` · ${f.reason}` : "";
    setText("stFutu", f.connected ? "富途 OpenD：已连接" : `富途 OpenD：${LINK_TEXT[state] ?? "未连接"}${reason}`);
  }

  async function pollStatus() {
    try {
      const s = await api("/api/status");
      renderLink(s.futu);
    } catch {
      setText("futuPill", "富途 · 状态不可用");
      $("futuPill").className = "pill bad";
    }
  }

  setInterval(() => {
    const now = Date.now();
    setText("clock", `${etClock(now)} ET`);
    setText("stSess", sessionLabel(now));
    setText("stRate", `逐笔：${state.rateCount} 笔/秒`);
    state.rateCount = 0;
    if (SECOND_TF.has(state.tf)) {
      applyWindow();
      renderFoot();
    }
  }, 1000);

  initChart();
  renderWatch();
  renderHeader();
  renderSide();
  renderTape();
  renderDepth();
  syncMoneyness();
  renderSub();
  setCurrent(state.current);
  pollWatch();
  setInterval(pollWatch, 3000);
  setInterval(loadHeader, 60_000);
  pollStatus();
  setInterval(pollStatus, 10_000);
})();
