/*/Dashboard app — READ-ONLY frontend for the paper-portfolio API.
 * Polls the API on CIRCUIT_POLL_MS. If the API is unreachable the page keeps
 * its last good data but clearly marks the connection OFFLINE / STALE — it
 * never pretends stale data is live, and it never writes anything anywhere.
 *
 * MONEY DISPLAY: the dashboard is displayed in Indian Rupees (₹). The API
 * attaches real INR mirror fields (equityInr, cashInr, …) derived from the
 * real SOL/USD price and a live USD/INR rate — never fake or hard-coded.
 * Original SOL/USD values remain visible as secondary text / tooltips, and
 * the page falls back to SOL when no rate is available. Trading logic is
 * untouched and remains 100% paper.
 */
'use strict';

(function () {
  // ---- resolve API base ----------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const apiOverride = params.get('api');
  const SAME_ORIGIN = location.protocol === 'http:' || location.protocol === 'https:';
  const API_BASE = (apiOverride ||
    window.CIRCUIT_API_URL ||
    (SAME_ORIGIN ? '' : 'http://127.0.0.1:8787')).replace(/\/+$/, '');
  const POLL_MS = Math.max(1500, window.CIRCUIT_POLL_MS || 3000);

  // ---- tiny DOM helpers ----------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const fmt = (n, d = 5) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const signed = (n, d = 5) => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(d) : '—');
  const signedPct = (n, d = 2) => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(d) + '%' : '—');
  const upDown = (n) => (Number.isFinite(n) ? (n > 0 ? 'up' : n < 0 ? 'down' : '') : '');
  const solMoney = (n) => fmt(n, 5) + ' SOL';
  const ago = (ts) => {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's ago';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
  };
  const localTime = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString();
  };
  const localClock = (ts) => {
    if (!ts) return '—';
    const t = new Date(ts);
    return Number.isNaN(t.getTime()) ? '—' : t.toLocaleTimeString();
  };

  // ---- Indian number formatting (mirrors fx.js) -----------------------
  function groupIndian(intStr) {
    if (intStr.length <= 3) return intStr;
    const last3 = intStr.slice(-3);
    let rest = intStr.slice(0, -3);
    const parts = [];
    while (rest.length > 2) { parts.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
    if (rest.length) parts.unshift(rest);
    parts.push(last3);
    return parts.join(',');
  }
  function fmtInr(n, frac = 2, trim = false) {
    if (!Number.isFinite(n)) return '—';
    const neg = n < 0;
    let fixed = Math.abs(n).toFixed(frac);
    if (trim && Math.abs(n) > 0 && Math.abs(n) < 1) fixed = Math.abs(n).toFixed(8).replace(/0+$/, '');
    const dot = fixed.indexOf('.');
    const intStr = dot >= 0 ? fixed.slice(0, dot) : fixed;
    const dec = dot >= 0 ? fixed.slice(dot) : '';
    return '₹' + (neg ? '-' : '') + groupIndian(intStr) + dec;
  }
  const signInr = (n, frac = 2) => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + fmtInr(n, frac) : '—');
  /** Big-money default: 2 decimals. */
  const inr = (n) => fmtInr(n, 2);
  /** Token-price default: adaptive decimals so tiny values stay readable. */
  const priceInr = (n) => {
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs === 0) return '₹0.00';
    return fmtInr(n, abs >= 1 ? 2 : 4, true);
  };
  /** Card money value: ₹ when a rate is live, otherwise the SOL amount. */
  const bigMoney = (p, key) => {
    const iv = inrOf(p, key);
    if (iv != null) return inr(iv);
    const sv = p[key];
    return Number.isFinite(sv) ? fmt(sv, 5) + ' SOL' : '—';
  };
  /** Card signed money value (P&L): ₹ when live, otherwise signed SOL. */
  const bigSigned = (p, key) => {
    const iv = inrOf(p, key);
    if (iv != null) return signInr(iv);
    const sv = p[key];
    return Number.isFinite(sv) ? signed(sv, 5) + ' SOL' : '—';
  };
  /** Token price cell: ₹ when live, otherwise USD ($), else SOL. */
  const priceCell = (inrV, usd, sol) => {
    if (inrV != null) return priceInr(inrV);
    if (Number.isFinite(usd)) return '$' + fmt(usd, 10);
    if (Number.isFinite(sol)) return fmt(sol, 10) + ' SOL';
    return '—';
  };

  // ---- state -----------------------------------------------------------
  let state = {
    lastGoodAt: null,   // timestamp of the last SUCCESSFUL fetch
    conn: 'offline',    // offline | online | stale
    perf: null,
    heartbeat: null,
    positions: [],
    trades: [],
    equity: [],
    candidates: [],
    candidatesMeta: null,
    sources: [],
    lastErrors: [],
    fx: null,           // { available, usdInr, inrPerSol, solUsd, source, fetchedAt, cached, lastError }
    adaptive: null,     // adaptive intelligence view
    adaptivePerf: null, // { winRate, expectancyPct, maxDrawdownPct, lossStreak, winStreak, n }
    integrity: null,    // price-integrity diagnostics view
    tradingAgents: null, // TradingAgents research view
    sideFilter: 'ALL'
  };

  const fxAvailable = () => state.fx && state.fx.available && Number(state.fx.usdInr) > 0;
  /** INR value for a *Sol field: prefer the API mirror, else compute, else SOL fallback. */
  function inrOf(p, solKey) {
    const mirror = p[solKey.replace(/Sol$/, 'Inr')];
    if (Number.isFinite(mirror)) return mirror;
    const fx = state.fx;
    if (fxAvailable() && Number(fx.inrPerSol) > 0 && Number.isFinite(p[solKey])) {
      return p[solKey] * fx.inrPerSol;
    }
    return null;
  }

  // ---- connection badge ------------------------------------------------
  function setConn(conn, extra) {
    state.conn = conn;
    const badge = $('conn');
    badge.className = 'conn ' + conn;
    if (conn === 'online') {
      badge.textContent = '🟢 Ubuntu API Connected';
    } else if (conn === 'stale') {
      badge.textContent = '🟡 Ubuntu API Offline — showing data from ' + extra;
    } else {
      badge.textContent = '🔴 Ubuntu API Offline';
    }
  }

  // ---- fetch with timeout ----------------------------------------------
  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), 8000);
      fetch(url, { signal: ctrl ? ctrl.signal : undefined })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((j) => { clearTimeout(timer); resolve(j); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  async function poll() {
    try {
      const d = await fetchJson(API_BASE + '/api/dashboard');
      if (!d || !d.performance) throw new Error('bad dashboard payload');
      state.perf = d.performance;
      state.heartbeat = d.heartbeat;
      state.positions = d.portfolio && Array.isArray(d.portfolio.positions) ? d.portfolio.positions : [];
      state.trades = Array.isArray(d.trades) ? d.trades : [];
      state.equity = Array.isArray(d.equity) ? d.equity : [];
      state.candidates = Array.isArray(d.candidates) ? d.candidates : [];
      state.candidatesMeta = d.candidatesMeta || null;
      state.sources = Array.isArray(d.priceSources) ? d.priceSources : [];
      state.lastErrors = Array.isArray(d.lastErrors) ? d.lastErrors : [];
      state.fx = d.fx || null;
      state.adaptive = d.adaptive || null;
      state.adaptivePerf = d.adaptivePerf || null;
      state.integrity = d.integrity || null;
      state.tradingAgents = d.tradingAgents || null;
      state.atlas = d.atlas || null;
      state.lastGoodAt = Date.now();
      setConn('online');
      render();
    } catch (err) {
      if (state.lastGoodAt && state.perf) {
        setConn('stale', ago(state.lastGoodAt));
        const line = $('status-line');
        if (line) line.textContent = 'API unreachable (' + err.message + ') — data may be stale. Last update ' + ago(state.lastGoodAt) + '.';
      } else {
        setConn('offline');
        const line = $('status-line');
        if (line) line.textContent = 'API unreachable (' + err.message + ') — target ' + API_BASE;
        $('cards').innerHTML = '';
        $('positions-wrap').innerHTML = '';
        $('trades-wrap').innerHTML = '';
        $('perf-grid').innerHTML = '';
        $('live-grid').innerHTML = '';
        $('sys-grid').innerHTML = '';
        $('sources-wrap').innerHTML = '';
        $('candidates-wrap').innerHTML = '';
        $('errors-wrap').innerHTML = '';
        $('integrity-grid').innerHTML = '';
        if ($('integrity-sub')) $('integrity-sub').innerHTML = '';
        $('ta-grid').innerHTML = '';
        if ($('ta-sub')) $('ta-sub').innerHTML = '';
        $('atlas-grid').innerHTML = '';
        if ($('atlas-sub')) $('atlas-sub').innerHTML = '';
        if ($('atlas-scorecard-wrap')) $('atlas-scorecard-wrap').innerHTML = '';
        if ($('atlas-calibration-wrap')) $('atlas-calibration-wrap').innerHTML = '';
        if ($('atlas-ab-grid')) $('atlas-ab-grid').innerHTML = '';
        $('adaptive-grid').innerHTML = '';
        if ($('adaptive-sub')) $('adaptive-sub').innerHTML = '';
        if ($('cand-meta')) $('cand-meta').textContent = '';
        if ($('halt-banner')) { $('halt-banner').classList.add('hidden'); $('halt-banner').textContent = ''; }
        $('fx-line').textContent = '';
        showChartEmpty('Ubuntu API offline. Start dashboard-api.js on Ubuntu, then this dashboard will connect.');
      }
    }
  }

  // ---- renderers ---------------------------------------------------------
  function card(label, value, sub, title) {
    const c = el('div', 'card');
    c.appendChild(el('div', 'label', label));
    const v = el('div', 'value', value);
    if (title) v.title = title;
    c.appendChild(v);
    if (sub) c.appendChild(el('div', 'sub ' + upDown(sub.num), sub.text));
    return c;
  }

  function renderCards(p) {
    const cards = $('cards');
    cards.innerHTML = '';
    // Primary value in ₹ (real conversion); without a rate the card shows the
    // real SOL amount instead of an em-dash. SOL stays in the secondary line.
    const sol = (k) => (Number.isFinite(p[k]) ? p[k] : 0);
    cards.appendChild(card('EQUITY',
      bigMoney(p, 'equitySol'),
      { num: sol('totalPnlSol'), text: signed(sol('totalPnlSol'), 5) + ' SOL · ' + signedPct(p.pnlPct) },
      'Equity: ' + solMoney(sol('equitySol'))));
    cards.appendChild(card('TOTAL P&L',
      bigSigned(p, 'totalPnlSol'),
      { num: p.pnlPct, text: signedPct(p.pnlPct) },
      'Total P&L: ' + signed(sol('totalPnlSol'), 5) + ' SOL'));
    cards.appendChild(card('CASH',
      bigMoney(p, 'cashSol'),
      { num: 0, text: solMoney(sol('cashSol')) },
      'Cash: ' + solMoney(sol('cashSol'))));
    cards.appendChild(card('INVESTED',
      bigMoney(p, 'investedSol'),
      { num: 0, text: solMoney(sol('investedSol')) },
      'Invested: ' + solMoney(sol('investedSol'))));
    cards.appendChild(card('MARKET VALUE',
      bigMoney(p, 'marketValueSol'),
      { num: 0, text: solMoney(sol('marketValueSol')) },
      'Market value: ' + solMoney(sol('marketValueSol'))));
    cards.appendChild(card('UNREALIZED P&L',
      bigSigned(p, 'unrealizedPnlSol'),
      { num: sol('unrealizedPnlSol'), text: signed(sol('unrealizedPnlSol'), 5) + ' SOL' },
      'Unrealized P&L: ' + signed(sol('unrealizedPnlSol'), 5) + ' SOL'));
    cards.appendChild(card('REALIZED P&L',
      bigSigned(p, 'realizedPnlSol'),
      { num: sol('realizedPnlSol'), text: signed(sol('realizedPnlSol'), 5) + ' SOL' },
      'Realized P&L: ' + signed(sol('realizedPnlSol'), 5) + ' SOL'));
    cards.appendChild(card('STARTING CAPITAL',
      bigMoney(p, 'startingCapitalSol'),
      { num: 0, text: solMoney(sol('startingCapitalSol')) },
      'Starting capital: ' + solMoney(sol('startingCapitalSol'))));
  }

  function renderFxLine() {
    const line = $('fx-line');
    if (!line) return;
    if (!fxAvailable()) {
      line.textContent = 'Exchange rate unavailable — showing SOL/USD values.' +
        (state.fx && state.fx.lastError ? ' (' + state.fx.lastError + ')' : '');
      line.classList.add('warn');
      return;
    }
    line.classList.remove('warn');
    const fx = state.fx;
    let text = '1 USD = ₹' + fmt(fx.usdInr, 2);
    if (Number(fx.inrPerSol) > 0) text += '  ·  1 SOL ≈ ' + fmtInr(fx.inrPerSol);
    text += fx.cached
      ? '  ·  RATE CACHED (live refresh failing) · as of ' + localClock(fx.fetchedAt)
      : '  ·  live · updated ' + localClock(fx.fetchedAt);
    line.textContent = text;
    if (fx.source) line.title = 'Exchange rate source: ' + fx.source;
  }

  function renderLive(hb, p) {
    const g = $('live-grid');
    g.innerHTML = '';
    const cell = (k, v, cls) => {
      const d = el('div', 'live-cell');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
      g.appendChild(d);
    };
    cell('Agent state', hb && hb.state ? hb.state : 'unknown', hb && hb.state === 'running' ? 'good' : '');
    cell('Paper mode', 'true (paper only)', 'good');
    cell('Custody', hb && hb.custody ? hb.custody : 'local');
    cell('Scans', hb ? String(hb.scans) : '—');
    cell('Uptime', hb && Number.isFinite(hb.uptimeSec) ? hb.uptimeSec + 's' : '—');
    cell('Last scan', hb && hb.lastScanAt ? ago(hb.lastScanAt) : '—');
    cell('Last portfolio write', p && p.updatedAt ? ago(p.updatedAt) : '—');
    cell('Open positions', String(state.positions.length));
  }

  /** SL → TP progress bar for one open position (pure divs). Null when the
   *  position carries no usable stopLossPct/takeProfitPct. stopLossPct and
   *  takeProfitPct are percents vs entry (agentd.js arms them per trade). */
  function riskBar(pos) {
    const entry = pos.entryPriceSol != null ? pos.entryPriceSol : pos.entryPrice;
    const cur = pos.currentPriceSol != null ? pos.currentPriceSol : pos.currentPrice;
    if (!Number.isFinite(entry) || !Number.isFinite(cur)) return null;
    if (!Number.isFinite(pos.stopLossPct) || !Number.isFinite(pos.takeProfitPct)) return null;
    const sl = entry * (1 + pos.stopLossPct / 100);
    const tp = entry * (1 + pos.takeProfitPct / 100);
    const lo = Math.min(sl, tp, cur, entry);
    const hi = Math.max(sl, tp, cur, entry);
    if (!(hi > lo)) return null;
    const f = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const bar = el('div', 'pbar');
    bar.title = 'SL ' + fmt(sl, 10) + ' · entry ' + fmt(entry, 10) +
      ' · now ' + fmt(cur, 10) + ' · TP ' + fmt(tp, 10) + ' SOL';
    const mk = (pct, cls) => {
      const m = el('span', 'mark ' + cls);
      m.style.left = pct.toFixed(1) + '%';
      bar.appendChild(m);
    };
    mk(f(sl), 'sl');
    mk(f(entry), 'entry');
    mk(f(tp), 'tp');
    const dot = el('span', 'mark cur ' + (cur >= entry ? 'up' : 'down'));
    dot.style.left = f(cur).toFixed(1) + '%';
    bar.appendChild(dot);
    return bar;
  }

  function renderPositions() {
    const wrap = $('positions-wrap');
    wrap.innerHTML = '';
    if (!state.positions.length) {
      wrap.appendChild(el('div', 'empty', 'No open positions.'));
      return;
    }
    const tbl = el('table');
    const thead = el('thead');
    const hr = el('tr');
    ['SYMBOL', 'QTY', 'ENTRY (₹)', 'CURRENT (₹)', 'COST (₹)', 'MKT VALUE (₹)', 'UNREALIZED P&L (₹)', 'P&L %', 'RISK', 'OPENED'].forEach((h) => {
      hr.appendChild(el('th', h === 'SYMBOL' || h === 'OPENED' || h === 'RISK' ? '' : 'num', h));
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);

    const tb = el('tbody');
    for (const pos of state.positions) {
      const tr = el('tr');
      const pnlInr = pos.unrealizedPnlInr != null ? pos.unrealizedPnlInr
        : (Number.isFinite(pos.unrealizedPnlSol) && Number.isFinite(state.fx && state.fx.inrPerSol)
          ? pos.unrealizedPnlSol * state.fx.inrPerSol : null);
      const pnlSol = pos.unrealizedPnlSol || 0;
      const pct = pos.unrealizedPnlPct || 0;
      const cls = pnlSol > 0 ? 'up' : pnlSol < 0 ? 'down' : 'muted';
      const pill = pnlSol > 0 ? 'profit' : pnlSol < 0 ? 'loss' : 'flat';
      const costInr = pos.costInr != null ? pos.costInr
        : (Number.isFinite(pos.costSol) && Number.isFinite(state.fx && state.fx.inrPerSol) ? pos.costSol * state.fx.inrPerSol : null);
      const mvInr = pos.marketValueInr != null ? pos.marketValueInr
        : (Number.isFinite(pos.marketValueSol) && Number.isFinite(state.fx && state.fx.inrPerSol) ? pos.marketValueSol * state.fx.inrPerSol : null);
      const entryInr = pos.entryPriceInr != null ? pos.entryPriceInr
        : (Number.isFinite(pos.entryPriceUsd) && fxAvailable() ? pos.entryPriceUsd * state.fx.usdInr : null);
      const curInr = pos.currentPriceInr != null ? pos.currentPriceInr
        : (Number.isFinite(pos.currentPriceUsd) && fxAvailable() ? pos.currentPriceUsd * state.fx.usdInr : null);
      const symTxt = pos.symbol + (pos.mint ? ' · ' + String(pos.mint).slice(0, 4) + '…' : '');
      const rowCells = [
        symTxt,
        fmt(pos.quantity, 4),
        priceCell(entryInr, pos.entryPriceUsd, pos.entryPriceSol != null ? pos.entryPriceSol : pos.entryPrice),
        priceCell(curInr, pos.currentPriceUsd, pos.currentPriceSol != null ? pos.currentPriceSol : pos.currentPrice),
        costInr != null ? inr(costInr) : (Number.isFinite(pos.costSol) ? fmt(pos.costSol, 6) + ' SOL' : '—'),
        mvInr != null ? inr(mvInr) : (Number.isFinite(pos.marketValueSol) ? fmt(pos.marketValueSol, 6) + ' SOL' : '—'),
        pnlInr != null ? signInr(pnlInr) : (Number.isFinite(pnlSol) ? signed(pnlSol, 6) + ' SOL' : '—'),
        signedPct(pct), '' /* RISK bar injected below */, localTime(pos.openedAt)
      ];
      rowCells.forEach((txt, i) => {
        const td = el('td', '', txt);
        if (i === 0) td.className = 'pos';
        if (i >= 1 && i <= 5) td.className = 'num';
        if (i === 6) { td.className = 'num ' + cls; }
        if (i === 7) { td.className = 'num'; td.innerHTML = ''; const sp = el('span', 'pill ' + pill, signedPct(pct)); td.appendChild(sp); }
        if (i === 8) {
          td.className = '';
          td.textContent = '';
          const bar = riskBar(pos);
          td.appendChild(bar || el('span', 'muted', '—'));
        }
        if (i === 9) td.className = 'muted';
        tr.appendChild(td);
      });
      // SOL details in the tooltip — never the main display.
      tr.title = [
        'Entry: ' + fmt(pos.entryPriceSol != null ? pos.entryPriceSol : pos.entryPrice, 12) + ' SOL' +
          (Number.isFinite(pos.entryPriceUsd) ? ' ($' + fmt(pos.entryPriceUsd, 10) + ')' : ''),
        'Current: ' + fmt(pos.currentPriceSol != null ? pos.currentPriceSol : pos.currentPrice, 12) + ' SOL' +
          (Number.isFinite(pos.currentPriceUsd) ? ' ($' + fmt(pos.currentPriceUsd, 10) + ')' : ''),
        'Cost: ' + fmt(pos.costSol, 6) + ' SOL · Mkt: ' + fmt(pos.marketValueSol, 6) + ' SOL',
        'Unrealized: ' + signed(pnlSol, 6) + ' SOL'
      ].join('\n');
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  }

  function renderTrades() {
    const wrap = $('trades-wrap');
    wrap.innerHTML = '';
    const list = state.trades.filter((t) => state.sideFilter === 'ALL' || t.side === state.sideFilter);
    if (!list.length) {
      wrap.appendChild(el('div', 'empty', 'No trades yet.'));
      return;
    }
    const tbl = el('table');
    const thead = el('thead');
    const hr = el('tr');
    ['TIME', 'SIDE', 'SYMBOL', 'QTY', 'PRICE (₹)', 'VALUE (₹)', 'P&L (₹)', 'P&L %', 'REASON'].forEach((h) => {
      hr.appendChild(el('th', h === 'SIDE' || h === 'SYMBOL' || h === 'TIME' || h === 'REASON' ? '' : 'num', h));
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);

    const tb = el('tbody');
    for (const t of list) {
      const tr = el('tr');
      const sell = t.side === 'SELL';
      const pnlSol = t.realizedPnlSol || 0;
      const pct = t.realizedPnlPct || 0;
      const cls = pnlSol > 0 ? 'up' : pnlSol < 0 ? 'down' : 'muted';
      const pill = pnlSol > 0 ? 'profit' : pnlSol < 0 ? 'loss' : 'flat';
      const priceInrV = t.priceInr != null ? t.priceInr
        : (Number.isFinite(t.priceUsd) && fxAvailable() ? t.priceUsd * state.fx.usdInr : null);
      const valueInrV = t.valueInr != null ? t.valueInr
        : (Number.isFinite(t.valueSol) && Number.isFinite(state.fx && state.fx.inrPerSol) ? t.valueSol * state.fx.inrPerSol : null);
      const pnlInrV = t.realizedPnlInr != null ? t.realizedPnlInr
        : (Number.isFinite(t.realizedPnlSol) && Number.isFinite(state.fx && state.fx.inrPerSol) ? t.realizedPnlSol * state.fx.inrPerSol : null);
      const vals = [
        localTime(t.timestamp), t.side, t.symbol, fmt(t.quantity, 4),
        priceCell(priceInrV, t.priceUsd, t.price),
        valueInrV != null ? inr(valueInrV) : (Number.isFinite(t.valueSol) ? fmt(t.valueSol, 6) + ' SOL' : '—'),
        sell ? (pnlInrV != null ? signInr(pnlInrV) : (Number.isFinite(pnlSol) ? signed(pnlSol, 6) + ' SOL' : '—')) : '—',
        sell ? signedPct(pct) : '—',
        '' /* REASON pill injected below */
      ];
      vals.forEach((txt, i) => {
        const td = el('td', '', txt);
        if (i === 0) td.className = 'muted';
        if (i === 1) { td.textContent = ''; const s = el('span', 'side ' + t.side, t.side); td.appendChild(s); }
        if (i === 2) td.className = 'pos';
        if (i >= 3 && i <= 7) td.className = 'num';
        if (i === 6 && sell) td.className = 'num ' + cls;
        if (i === 7 && sell) { td.className = 'num'; td.textContent = ''; td.appendChild(el('span', 'pill ' + pill, signedPct(pct))); }
        if (i === 8) {
          td.className = 'wrap';
          td.textContent = '';
          if (sell && t.reason) {
            const r = String(t.reason);
            const rpill = r === 'take-profit' ? 'profit'
              : r === 'stop-loss' ? 'loss'
              : (r === 'gap-kill' || r === 'liquidity-kill') ? 'warn' : 'flat';
            td.appendChild(el('span', 'pill ' + rpill, r));
          } else {
            td.appendChild(el('span', 'muted', '—'));
          }
        }
        tr.appendChild(td);
      });
      const tooltip = [
        'Price: ' + fmt(t.price, 10) + ' SOL' + (Number.isFinite(t.priceUsd) ? ' ($' + fmt(t.priceUsd, 10) + ')' : ''),
        'Value: ' + fmt(t.valueSol, 6) + ' SOL'
      ];
      if (sell) tooltip.push('P&L: ' + signed(pnlSol, 6) + ' SOL');
      if (sell && t.reason) tooltip.push('Reason: ' + t.reason);
      tr.title = tooltip.join('\n');
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  }

  function renderSystem(hb) {
    const g = $('sys-grid');
    g.innerHTML = '';
    const cell = (k, v, cls) => {
      const d = el('div', 'sys-cell');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
      g.appendChild(d);
    };
    cell('Market', hb && hb.market ? hb.market : 'REAL SOLANA');
    cell('Execution', hb && hb.execution ? hb.execution : 'PAPER ONLY', 'good');
    cell('Wallet', hb && hb.wallet ? hb.wallet : 'DISABLED', 'good');
    cell('Signer', hb && hb.signer ? hb.signer : 'DISABLED', 'good');
    cell('Broadcast', hb && hb.broadcast ? hb.broadcast : 'DISABLED', 'good');
    cell('SOL price', state.solPriceUsd ? '$' + fmt(state.solPriceUsd, 2) : '—');
    cell('Exchange rate', fxAvailable()
      ? '1 USD = ₹' + fmt(state.fx.usdInr, 2) + (state.fx.cached ? ' (cached)' : '')
      : 'unavailable', fxAvailable() && !state.fx.cached ? '' : 'warn');
    cell('Positions', (state.positions.length) + ' / ' + (hb && hb.maxPositions ? hb.maxPositions : 3));
    cell('Candidates', state.candidatesMeta ? String(state.candidatesMeta.count || 0) : '—');
    cell('Agent lock', hb && hb.state ? hb.state : '—', hb && hb.state === 'running' ? 'good' : '');
  }

  function renderSources() {
    const wrap = $('sources-wrap');
    wrap.innerHTML = '';
    if (!state.sources.length) {
      wrap.appendChild(el('div', 'empty', 'No price sources reported yet.'));
      return;
    }
    for (const s of state.sources) {
      const row = el('div', 'source-row');
      const left = el('span');
      const dot = el('span', 'source-dot ' + (s.status || 'unknown'));
      dot.textContent = '';
      left.appendChild(dot);
      left.appendChild(document.createTextNode(s.name || '?'));
      if (s.role) left.appendChild(el('span', 'source-role', s.role));
      row.appendChild(left);
      const right = el('span');
      if (s.status === 'error') {
        right.className = 'source-err';
        right.textContent = 'error' + (s.lastError ? ' — ' + s.lastError : '');
      } else if (s.lastOkAt) {
        right.textContent = 'ok · ' + ago(s.lastOkAt);
      } else {
        right.textContent = 'not queried yet';
      }
      row.appendChild(right);
      wrap.appendChild(row);
    }
    // Exchange-rate source, when known.
    if (fxAvailable() && state.fx.source) {
      const row = el('div', 'source-row');
      const left = el('span');
      const dot = el('span', 'source-dot ' + (state.fx.cached ? 'unknown' : 'ok'));
      left.appendChild(dot);
      left.appendChild(document.createTextNode(state.fx.source + ' (USD/INR)'));
      row.appendChild(left);
      const right = el('span', 'source-err', state.fx.cached ? 'cached — live refresh failing' : 'ok · ' + localClock(state.fx.fetchedAt));
      row.appendChild(right);
      wrap.appendChild(row);
    }
  }

  function renderCandidates() {
    const wrap = $('candidates-wrap');
    wrap.innerHTML = '';
    const meta = state.candidatesMeta;
    $('cand-meta').textContent = meta && meta.scannedAt
      ? 'scanned ' + ago(meta.scannedAt) + ' · ' + meta.count + ' candidate(s) · ' + meta.openPositions + '/' + meta.maxPositions + ' open'
      : '';
    if (!state.candidates.length) {
      wrap.appendChild(el('div', 'empty', 'No candidates yet — the agent writes its discovery scan to candidates.json as it runs.'));
      return;
    }
    const tbl = el('table');
    const thead = el('thead');
    const hr = el('tr');
    ['SYMBOL', 'SCORE', 'P WIN', '1H', '5M', 'NATR', 'PRICE (₹)', 'PRICE SOL', 'LIQ', 'VOL', 'DECISION'].forEach((h) => {
      hr.appendChild(el('th', h === 'SYMBOL' || h === 'DECISION' ? '' : 'num', h));
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tb = el('tbody');
    for (const c of state.candidates) {
      const tr = el('tr');
      const rec5 = c.recoveryStatus === 'warming'
        ? 'warming(' + (c.recoverySamples || 0) + ')'
        : signedPct(c.recoveryPct);
      const decision = c.decision === 'BUY' ? 'BUY' : (c.reason ? 'FILTER · ' + c.reason : '—');
      const priceInrV = c.priceInr != null ? c.priceInr
        : (Number.isFinite(c.priceUsd) && fxAvailable() ? c.priceUsd * state.fx.usdInr : null);
      const vals = [
        c.symbol, String(c.score),
        Number.isFinite(c.pWin) ? (c.pWin * 100).toFixed(1) + '%' : '—',
        signedPct(c.change1hPct), rec5,
        Number.isFinite(c.natr) ? c.natr.toFixed(2) + '%' : '—',
        priceCell(priceInrV, c.priceUsd, c.priceSol), fmt(c.priceSol, 12), fmtCompact(c.liquidityUsd), fmtCompact(c.volume24hUsd), decision
      ];
      vals.forEach((txt, i) => {
        const td = el('td', '', txt);
        if (i === 0) td.className = 'pos';
        if (i >= 1 && i <= 9) td.className = 'num';
        if (i === 10) {
          td.className = '';
          td.textContent = '';
          td.appendChild(el('span', 'decision-pill ' + (c.decision === 'BUY' ? 'buy' : 'filter'), decision));
        }
        tr.appendChild(td);
      });
      tr.title = 'USD price: $' + (Number.isFinite(c.priceUsd) ? fmt(c.priceUsd, 10) : '—') +
        ' · Liq: $' + fmtCompact(c.liquidityUsd) + ' · Vol: $' + fmtCompact(c.volume24hUsd) +
        (Number.isFinite(c.pWin) ? ' · P(win) ' + (c.pWin * 100).toFixed(1) + '%' : '') +
        (Number.isFinite(c.natr) ? ' · NATR ' + c.natr.toFixed(2) + '%' : '');
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  }

  function renderErrors() {
    const wrap = $('errors-wrap');
    wrap.innerHTML = '';
    if (!state.lastErrors.length) {
      wrap.appendChild(el('div', 'empty', 'No errors recorded.'));
      return;
    }
    for (const e of state.lastErrors) {
      const row = el('div', 'error-row');
      row.appendChild(el('span', 'error-tag', '[' + e.tag + ']'));
      row.appendChild(el('span', 'error-msg', e.msg));
      row.appendChild(el('span', 'error-time', ago(e.ts)));
      wrap.appendChild(row);
    }
  }

  const fmtCompact = (n) => {
    if (!Number.isFinite(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  };

  function renderPerf(p) {
    const g = $('perf-grid');
    g.innerHTML = '';
    const cell = (k, v, cls) => {
      const d = el('div', 'perf-cell');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
      g.appendChild(d);
    };
    const inrOrSol = (vInr, vSol, sign = true) => {
      if (Number.isFinite(vInr)) return sign ? signInr(vInr) : inr(vInr);
      return Number.isFinite(vSol) ? (sign ? signed(vSol, 6) : fmt(vSol, 6)) + ' SOL' : '—';
    };
    cell('Total trades', String(p.totalTrades || 0));
    cell('Winning trades', String(p.winningTrades || 0), 'up');
    cell('Losing trades', String(p.losingTrades || 0), 'down');
    cell('Win rate', fmt(p.winRate, 2) + '%');
    cell('Avg win', inrOrSol(p.avgWinInr, p.avgWinSol), p.avgWinSol > 0 ? 'up' : '');
    cell('Avg loss', inrOrSol(p.avgLossInr, p.avgLossSol), p.avgLossSol < 0 ? 'down' : '');
    cell('Best trade', inrOrSol(p.bestTradeInr, p.bestTradeSol), 'up');
    cell('Worst trade', inrOrSol(p.worstTradeInr, p.worstTradeSol), 'down');
  }

  // ---- daily-loss-halt banner (risk visibility) -------------------------
  // Mirrors the agent rule (adaptive-policy.js: day P&L ≤ -3% → watchOnly
  // rest of the UTC day). Reads heartbeat.adaptive.dayPnlPct + the policy
  // reason, both served read-only by the API. Frontend display only.
  function renderHalt() {
    const banner = $('halt-banner');
    if (!banner) return;
    const hbA = state.heartbeat && state.heartbeat.adaptive;
    const dayPnl = hbA ? hbA.dayPnlPct : null;
    const reason = state.adaptive && state.adaptive.policy && state.adaptive.policy.reason
      ? String(state.adaptive.policy.reason) : '';
    const halted = (Number.isFinite(dayPnl) && dayPnl <= -3) || /daily loss halt/i.test(reason);
    if (!halted) {
      banner.classList.add('hidden');
      banner.textContent = '';
      banner.title = '';
      return;
    }
    banner.classList.remove('hidden');
    banner.textContent = '⛔ DAILY LOSS HALT — day P&L ' + signedPct(dayPnl) +
      ' · no new entries until next UTC day';
    if (reason) banner.title = reason;
  }

  // ---- adaptive intelligence --------------------------------------------
  function renderAdaptive() {
    const g = $('adaptive-grid');
    const sub = $('adaptive-sub');
    if (!g) return;
    g.innerHTML = '';
    if (sub) sub.innerHTML = '';
    const a = state.adaptive;
    if (!a || !a.enabled) {
      g.appendChild(el('div', 'empty', 'Adaptive layer disabled or not reported yet. Start agentd.js with the adaptive layer enabled to see agent-loop / reflection / regime / learned gates here.'));
      return;
    }
    const p = a.policy || {};
    const r = a.regime || {};
    const mh = a.marketHealth;
    const perf = state.adaptivePerf || (a.performance && (a.performance.week || a.performance.allTime)) || null;

    const cell = (k, v, cls) => {
      const d = el('div', 'adaptive-cell');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
      g.appendChild(d);
    };
    const modeCls = p.mode === 'watchOnly' ? 'warn' : p.mode === 'selective' ? '' : 'good';
    const regimeCls = r.regime === 'dump' || r.regime === 'recovery' ? 'warn' : r.regime === 'bull' ? 'good' : '';

    cell('Strategy version', p.strategyVersion || 'V1');
    cell('Mode', (p.mode || 'active') + (p.source === 'llm' ? ' (LLM)' : ''), modeCls);
    // Day P&L vs the persisted anchor (heartbeat.adaptive.dayPnlPct, read-only).
    // Amber at/below -3%: the agent is in daily-loss halt (watchOnly).
    {
      const hbA = state.heartbeat && state.heartbeat.adaptive;
      const dayPnl = hbA ? hbA.dayPnlPct : null;
      const halted = Number.isFinite(dayPnl) && dayPnl <= -3;
      cell('Day P&L', signedPct(dayPnl), halted ? 'warn' : (Number.isFinite(dayPnl) && dayPnl > 0 ? 'good' : ''));
    }
    cell('Regime', (r.regime || 'UNKNOWN') + (r.confidence ? ' · ' + Math.round(r.confidence * 100) + '%' : ''), regimeCls);
    cell('Min score', String(p.minScore != null ? p.minScore : 60));
    cell('Max buys (session)', String(p.maxBuys != null ? p.maxBuys : '—') + ' (' + (p.buysThisSession || 0) + ' used)');
    cell('Size multiplier', p.sizeMultiplier != null ? p.sizeMultiplier + '×' : '1.0×');
    cell('Market health', mh ? mh.score + '/100 · ' + mh.status + (mh.gate ? ' (GATED)' : '') : '—', mh && mh.gate ? 'warn' : '');
    if (perf) {
      cell('Win rate', fmt(perf.winRate, 2) + '% (n=' + perf.n + ')');
      cell('Expectancy', signedPct(perf.expectancyPct));
      cell('Max drawdown', '-' + fmt(Math.abs(perf.maxDrawdownPct || 0), 2) + '%');
      cell('Streaks', 'L' + (perf.lossStreak || 0) + ' / W' + (perf.winStreak || 0), (perf.lossStreak || 0) >= 3 ? 'warn' : '');
    }
    const s = a.schedule;
    if (s) {
      cell('Last agent-loop', s.lastAgentLoopAt ? ago(s.lastAgentLoopAt) : 'never');
      cell('Next agent-loop', s.nextAgentLoopAt ? localClock(s.nextAgentLoopAt) : '—');
      cell('Last reflection', s.lastReflectionAt ? ago(s.lastReflectionAt) : 'never');
      cell('Next reflection', s.nextReflectionAt ? localClock(s.nextReflectionAt) : '—');
    }

    if (!sub) return;
    // Learned gates + experiments + approvals + lessons + changes.
    const block = (title, rows) => {
      if (!rows || !rows.length) return '';
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', title));
      for (const row of rows) b.appendChild(row);
      return b;
    };
    const gateRows = (a.gates && a.gates.list || []).map((c) => {
      const n = el('div', 'adaptive-row');
      n.appendChild(el('span', 'muted', c.clusterKey + ': '));
      n.appendChild(document.createTextNode(c.gates.map((x) => x.parameter + '=' + x.value + ' (c' + Math.round(x.confidence * 100) + '%, n' + x.sample + ')').join(', ')));
      return n;
    });
    const expRows = ((a.experiments && a.experiments.experiments && a.experiments.experiments.recent) || []).slice(-6).map((e) => {
      const n = el('div', 'adaptive-row');
      const pill = el('span', 'pill ' + (e.state === 'PROMOTED' ? 'profit' : e.state === 'REJECTED' || e.state === 'ROLLED_BACK' ? 'loss' : 'flat'), e.state);
      n.appendChild(pill);
      n.appendChild(document.createTextNode(' ' + e.type + ': ' + e.parameter + ' ' + e.oldValue + '→' + e.newValue));
      return n;
    });
    const apprRows = ((a.experiments && a.experiments.approvals && a.experiments.approvals.pendingList) || []).slice(-4).map((x) => {
      const n = el('div', 'adaptive-row warn');
      n.appendChild(el('span', 'k', 'PENDING ' + (x.priority || '') + ' · '));
      n.appendChild(document.createTextNode(x.title));
      return n;
    });
    const changeRows = (a.policyChanges || []).slice(-6).map((c) => {
      const n = el('div', 'adaptive-row');
      const g = c.grade ? el('span', 'pill ' + (String(c.grade).includes('POSITIVE') ? 'profit' : String(c.grade).includes('NEGATIVE') ? 'loss' : 'flat'), String(c.grade)) : el('span', 'pill flat', 'PENDING');
      n.appendChild(g);
      n.appendChild(document.createTextNode(' ' + c.strategyVersion + ' ' + c.parameter + ' ' + c.oldValue + '→' + c.newValue));
      return n;
    });
    const lessonRows = (a.lessons || []).slice(-6).map((l) => {
      const n = el('div', 'adaptive-row');
      n.appendChild(el('span', 'muted', '[' + (l.type || 'lesson') + '] '));
      n.appendChild(document.createTextNode(l.summary || l.key || ''));
      return n;
    });
    const rbCount = a.experiments && a.experiments.rollback ? a.experiments.rollback.rolledBackExperiments : 0;
    const rollbackRow = el('div', 'adaptive-row');
    rollbackRow.appendChild(el('span', 'k', 'Rollbacks: '));
    rollbackRow.appendChild(document.createTextNode(String(rbCount) + ' · current baseline ' + ((a.baseline && a.baseline.versionId) || 'V1') + ' (minScore ' + ((a.baseline && a.baseline.minScoreBase) || 60) + ')'));
    const blocks = [
      block('LEARNED GATES (' + ((a.gates && a.gates.clusters) || 0) + ' clusters)', gateRows),
      block('EXPERIMENTS', expRows),
      block('PENDING APPROVALS', apprRows),
      block('POLICY CHANGES', changeRows),
      block('LESSONS', lessonRows)
    ];
    const wrap = el('div', 'adaptive-blocks');
    for (const b of blocks) if (b) wrap.appendChild(b);
    const reason = el('div', 'adaptive-reason');
    reason.appendChild(el('span', 'k', 'Policy reason: '));
    reason.appendChild(document.createTextNode(p.reason || '—'));
    sub.appendChild(wrap);
    sub.appendChild(reason);
    if (rollbackRow) sub.appendChild(rollbackRow);
  }

  // ---- price integrity (read-only diagnostics) --------------------------
  function renderIntegrity() {
    const g = $('integrity-grid');
    const sub = $('integrity-sub');
    if (!g) return;
    g.innerHTML = '';
    if (sub) sub.innerHTML = '';
    const i = state.integrity;
    if (!i || !i.enabled) {
      g.appendChild(el('div', 'empty', 'Price-integrity layer not reported yet. Start agentd.js to see integrity state (suspicious/rejected observations, quarantines, warnings) here.'));
      return;
    }
    const c = i.counters || {};
    const quarantined = Array.isArray(i.quarantined) ? i.quarantined : [];
    const warnings = Array.isArray(i.events) ? i.events : [];
    const cell = (k, v, cls) => {
      const d = el('div', 'adaptive-cell');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
      g.appendChild(d);
    };
    cell('Integrity status', String(i.status || 'ok'), i.status === 'ok' && quarantined.length === 0 ? 'good' : 'warn');
    cell('Last integrity check', i.lastCheckAt ? ago(i.lastCheckAt) : 'never');
    cell('Suspicious observations', String(c.suspiciousObservations || 0));
    cell('Rejected observations', String(c.rejectedObservations || 0));
    cell('Pair changes detected', String(c.pairChangesDetected || 0));
    cell('Source divergence events', String(c.sourceDivergenceEvents || 0));
    cell('Quarantined now', String(quarantined.length), quarantined.length ? 'warn' : 'good');
    if (!sub) return;

    const row = (txt, cls) => {
      const n = el('div', 'adaptive-row' + (cls ? ' ' + cls : ''));
      n.appendChild(document.createTextNode(txt));
      return n;
    };
    // Currently quarantined observations (waiting for confirmation).
    if (quarantined.length) {
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', 'QUARANTINED OBSERVATIONS (holding at last valid price — no sell)'));
      for (const q of quarantined) {
        const n = el('div', 'adaptive-row warn');
        n.appendChild(el('span', 'k', String(q.symbol || '?') + ' · ' + String(q.mint || '').slice(0, 6) + '… · '));
        n.appendChild(document.createTextNode('EXTREME_PRICE_MOVE ' + (q.direction === 'up' ? '▲' : '▼') +
          ' · confirmations ' + (q.confirmations || 0) + '/' + (q.required || 0) +
          ' · since ' + ago(q.since) + ' · observed ' + fmt(q.observedPriceSol != null ? q.observedPriceSol : q.observedPriceUsd, 10)));
        n.title = 'Baseline price: ' + fmt(q.baselinePriceSol != null ? q.baselinePriceSol : 0, 12) + ' SOL';
        b.appendChild(n);
      }
      sub.appendChild(b);
    } else if (warnings.length) {
      sub.appendChild(row('No quarantined observations — no suspicious price waiting for confirmation.', 'muted'));
    }
    // Last integrity warning.
    const lw = i.lastWarning;
    if (lw && lw.reason) {
      const n = el('div', 'adaptive-row');
      const pill = el('span', 'pill ' + (['PAIR_CHANGED', 'EXTREME_PRICE_MOVE', 'SOURCE_DIVERGENCE', 'REJECTED'].indexOf(lw.reason) >= 0 ? 'loss' : 'flat'), String(lw.reason));
      n.appendChild(pill);
      n.appendChild(document.createTextNode(' ' + (lw.symbol ? lw.symbol + ' · ' : '') + (lw.detail || '') + ' · ' + ago(lw.ts)));
      sub.appendChild(n);
    }
    // Recent integrity events.
    if (warnings.length) {
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', 'RECENT INTEGRITY EVENTS'));
      for (const e of warnings.slice(-6)) {
        const n = el('div', 'adaptive-row');
        const cls = ['PAIR_CHANGED', 'EXTREME_PRICE_MOVE', 'SOURCE_DIVERGENCE', 'REJECTED'].indexOf(e.reason) >= 0 ? 'loss'
          : ['SNAP_BACK', 'ACCEPTED_AFTER_CONFIRMATION'].indexOf(e.reason) >= 0 ? 'profit' : 'flat';
        const pill = el('span', 'pill ' + cls, String(e.reason));
        n.appendChild(pill);
        n.appendChild(document.createTextNode(' ' + (e.symbol ? e.symbol + ' · ' : '') + (e.detail || '') + ' · ' + ago(e.ts)));
        b.appendChild(n);
      }
      sub.appendChild(b);
    }
  }

  // ---- ATLAS intelligence (read-only research-grade) --------------------
  function renderAtlas() {
    const g = $('atlas-grid');
    const sub = $('atlas-sub');
    if (!g) return;
    g.innerHTML = '';
    if (sub) sub.innerHTML = '';
    const atlas = state.atlas;
    if (!atlas || !atlas.enabled) {
      g.appendChild(el('div', 'empty', 'ATLAS intelligence layer is OFF or not reported yet. Start agentd.js (mode SHADOW/ADVISORY) to see research-grade decisions here.'));
      return;
    }
    const lat = atlas.latest;
    const c = atlas.counters || {};
    const acc = atlas.accuracy || {};
    const cell = (k, v, cls) => {
      const d = el('div', 'adaptive-cell');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
      g.appendChild(d);
    };
    cell('ATLAS mode', String(atlas.mode || 'SHADOW'));
    cell('Agents', String((atlas.agents && atlas.agents.length) || 16));
    cell('Research cycles', String(c.cycles || 0));
    cell('Candidates researched', String(c.candidatesResearched || 0));
    cell('LLM calls', String(c.llmCalls || 0));
    cell('LLM fails (safe fallback)', String(c.llmFails || 0), c.llmFails && c.llmFails > 0 ? 'warn' : '');
    cell('Latest consensus', lat && lat.consensus ? String(lat.consensus).toUpperCase() : '—', lat && /bullish/.test(lat.consensus) ? 'good' : (lat && /bearish/.test(lat.consensus) ? 'warn' : ''));
    cell('ATLAS score', lat && lat.researchScore != null ? String(lat.researchScore) + (lat.circuitScore != null ? ' / Circuit ' + lat.circuitScore : '') : '—');
    cell('V1 score', lat && lat.v1 && lat.v1.score != null ? String(lat.v1.score) : '—');
    cell('Risk level', lat && lat.riskLevel ? String(lat.riskLevel).toUpperCase() : '—', lat && (lat.riskLevel === 'high' || lat.riskLevel === 'critical') ? 'warn' : 'good');
    if (!sub) return;
    const row = (txt, cls) => {
      const n = el('div', 'adaptive-row' + (cls ? ' ' + cls : ''));
      n.appendChild(document.createTextNode(txt));
      return n;
    };
    if (lat && lat.symbol) {
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', 'LATEST ATLAS RESEARCH — ' + lat.symbol));
      b.appendChild(row('Technical ' + (lat.technicalScore != null ? lat.technicalScore : '—') + ' · Quant ' + (lat.quantScore != null ? lat.quantScore : '—') +
        ' · Sentiment ' + (lat.sentimentScore != null ? lat.sentimentScore : '—') + ' · Market ' + (lat.marketScore != null ? lat.marketScore : '—')));
      b.appendChild(row('Bull ' + (lat.bullScore != null ? lat.bullScore : '—') + ' · Bear risk ' + (lat.bearRisk != null ? lat.bearRisk : '—')));
      const recPill = el('span', 'pill ' + (lat.recommendation === 'BUY' ? 'profit' : lat.recommendation === 'AVOID' ? 'loss' : 'flat'), String(lat.researchRecommendation || 'HOLD'));
      const rec = el('div', 'adaptive-row');
      rec.appendChild(el('span', 'k', 'Recommendation '));
      rec.appendChild(recPill);
      rec.appendChild(document.createTextNode(' · V1 decision ' + String(lat.v1 && lat.v1.eligible != null ? (lat.v1.eligible ? 'eligible' : 'not eligible') : '—') + ' · dataQuality ' + String(lat.dataQuality || 'ok')));
      b.appendChild(rec);
      if (lat.dataQuality === 'suspicious') b.appendChild(row('⚠ price-integrity suspicious — ATLAS does not override integrity', 'warn'));
      if (lat.warnings && lat.warnings.length) {
        const wb = el('div', 'adaptive-row warn');
        wb.appendChild(el('span', 'k', 'Warnings: '));
        wb.appendChild(document.createTextNode(lat.warnings.slice(0, 6).join(' · ')));
        b.appendChild(wb);
      }
      sub.appendChild(b);
    } else {
      sub.appendChild(row('No ATLAS research decision logged yet — ATLAS runs on top candidates each discovery scan.', 'muted'));
    }
    // Per-agent prediction accuracy (if exposed; otherwise hide).
    const byAgent = acc.byAgent || {};
    const agentKeys = Object.keys(byAgent).filter((k) => byAgent[k] && byAgent[k].n);
    if (agentKeys.length) {
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', 'AGENT PREDICTION ACCURACY'));
      for (const k of agentKeys) {
        const a = byAgent[k];
        const accPct = a.n ? Math.round((a.correct / a.n) * 100) : null;
        b.appendChild(row(String(k) + ': ' + (accPct != null ? accPct + '% (' + a.correct + '/' + a.n + ')' : a.n + ' predicted')));
      }
      sub.appendChild(b);
    }
    // Prediction quality summary.
    const pred = atlas.predictions || {};
    if (pred.n) {
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', 'PREDICTION QUALITY'));
      b.appendChild(row('Total predictions: ' + pred.n + (pred.pct != null ? ' · accuracy ' + pred.pct + '% (' + pred.correct + '/' + pred.n + ')' : '')));
      if (pred.correct != null && pred.incorrect != null) b.appendChild(row('Correct ' + pred.correct + ' · Incorrect ' + pred.incorrect));
      if (Array.isArray(pred.recent) && pred.recent.length) {
        b.appendChild(row('Latest predictions: ' + pred.recent.slice(0, 5).map((r) => (r.symbol || r.mint ? (r.symbol || r.mint) + ' ' + r.direction + ' (' + (r.confidence || 0) + '%)' : '—')).join(' · ')));
      }
      sub.appendChild(b);
    }
  }

  // ---- ATLAS Agent Scorecard ----
  function renderAtlasScorecard() {
    const wrap = $('atlas-scorecard-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const atlas = state.atlas;
    if (!atlas || !atlas.enabled) {
      wrap.appendChild(el('div', 'empty', 'No ATLAS scorecard data yet.'));
      return;
    }
    const cal = atlas.calibration || {};
    const agentCal = cal.agentCalibrations || {};
    const agentNames = Object.keys(agentCal).filter((k) => agentCal[k] && (agentCal[k].totalPredictions || 0) > 0);
    if (!agentNames.length) {
      wrap.appendChild(el('div', 'empty', 'No agent calibration data yet — agents need trade outcomes to score.'));
      return;
    }
    const table = el('table', 'data-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Agent', 'Predictions', 'Accuracy', 'Avg Return', 'Cal Error']) {
      hr.appendChild(el('th', '', h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const name of agentNames) {
      const a = agentCal[name];
      const tr = el('tr');
      tr.appendChild(el('td', '', name));
      tr.appendChild(el('td', '', String(a.totalPredictions || 0)));
      const acc = a.buckets ? Object.values(a.buckets).reduce((s, b) => s + (b.correct || 0), 0) : 0;
      const total = a.totalPredictions || 0;
      tr.appendChild(el('td', '', total > 0 ? Math.round((acc / total) * 100) + '%' : '—'));
      tr.appendChild(el('td', '', a.calibrationError != null ? String(a.calibrationError) : '—'));
      tr.appendChild(el('td', '', a.calibrationError != null ? String(a.calibrationError) : '—'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---- ATLAS Calibration ----
  function renderAtlasCalibration() {
    const wrap = $('atlas-calibration-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const atlas = state.atlas;
    if (!atlas || !atlas.enabled || !atlas.calibration) {
      wrap.appendChild(el('div', 'empty', 'No calibration data yet.'));
      return;
    }
    const cal = atlas.calibration;
    const buckets = cal.buckets || {};
    const bucketKeys = Object.keys(buckets).filter((k) => buckets[k] && buckets[k].predictionCount > 0);
    if (!bucketKeys.length) {
      wrap.appendChild(el('div', 'empty', 'No predictions in calibration buckets yet.'));
      return;
    }
    const table = el('table', 'data-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Confidence Bucket', 'Predictions', 'Accuracy', 'Avg Return']) {
      hr.appendChild(el('th', '', h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const label of bucketKeys) {
      const b = buckets[label];
      const tr = el('tr');
      tr.appendChild(el('td', '', label));
      tr.appendChild(el('td', '', String(b.predictionCount)));
      tr.appendChild(el('td', '', b.accuracy != null ? b.accuracy + '%' : '—'));
      tr.appendChild(el('td', '', b.averageReturn != null ? b.averageReturn + '%' : '—'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (cal.calibrationError != null) {
      wrap.appendChild(el('div', 'adaptive-row', 'Overall calibration error: ' + cal.calibrationError + ' (lower is better, 0 = perfect)'));
    }
  }

  // ---- ATLAS A/B Paper ----
  function renderAtlasAB() {
    const g = $('atlas-ab-grid');
    if (!g) return;
    g.innerHTML = '';
    const atlas = state.atlas;
    if (!atlas || !atlas.enabled || !atlas.abPaper) {
      g.appendChild(el('div', 'empty', 'No A/B paper data yet — trades need outcomes to compare.'));
      return;
    }
    const ab = atlas.abPaper;
    const cell = (k, v, cls) => {
      const d = el('div', 'adaptive-cell');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
      g.appendChild(d);
    };
    const a = ab.groupA || {};
    const b = ab.groupB || {};
    cell('V1 trades', String(a.totalTrades || 0));
    cell('V1 win rate', a.winRate != null ? a.winRate + '%' : '—');
    cell('V1 expectancy', a.expectancyPct != null ? a.expectancyPct + '%' : '—');
    cell('V1 profit factor', a.profitFactor != null ? String(a.profitFactor) : '—');
    cell('V1 max drawdown', a.maxDrawdownPct != null ? a.maxDrawdownPct + '%' : '—');
    cell('V1+ATLAS trades', String(b.totalTrades || 0));
    cell('V1+ATLAS win rate', b.winRate != null ? b.winRate + '%' : '—');
    cell('V1+ATLAS expectancy', b.expectancyPct != null ? b.expectancyPct + '%' : '—');
    cell('V1+ATLAS profit factor', b.profitFactor != null ? String(b.profitFactor) : '—');
    cell('V1+ATLAS max drawdown', b.maxDrawdownPct != null ? b.maxDrawdownPct + '%' : '—');
    cell('Catastrophic losses (V1)', String(a.catastrophicLosses || 0), (a.catastrophicLosses || 0) > 0 ? 'warn' : '');
    cell('Catastrophic losses (V1+ATLAS)', String(b.catastrophicLosses || 0), (b.catastrophicLosses || 0) > 0 ? 'warn' : '');
    cell('Total comparisons', String(ab.totalComparisons || 0));
  }

  // ---- TradingAgents intelligence (read-only research) --------------------
  function renderTradingAgents() {
    const g = $('ta-grid');
    const sub = $('ta-sub');
    if (!g) return;
    g.innerHTML = '';
    if (sub) sub.innerHTML = '';
    const ta = state.tradingAgents;
    if (!ta || !ta.enabled) {
      g.appendChild(el('div', 'empty', 'TradingAgents research layer is OFF or not reported yet. Start agentd.js (mode SHADOW/ADVISORY) to see research here.'));
      return;
    }
    const lat = ta.latest;
    const c = ta.counters || {};
    const acc = ta.accuracy || {};
    const cell = (k, v, cls) => {
      const d = el('div', 'adaptive-cell');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
      g.appendChild(d);
    };
    cell('Research mode', String(ta.mode || 'SHADOW'), ta.mode === 'ADVISORY' ? '' : 'good');
    cell('Agents', String((ta.agents && ta.agents.length) || 8));
    cell('Research cycles', String(c.cycles || 0));
    cell('Predictions evaluated', String(acc.rowsEvaluated || acc.n || 0));
    cell('Research accuracy', acc.n ? acc.pct + '% (' + acc.correct + '/' + acc.n + ')' : 'n/a');
    cell('Latest consensus', lat && lat.consensus ? String(lat.consensus).toUpperCase() : '—', lat && /bullish/.test(lat.consensus) ? 'good' : (lat && /bearish/.test(lat.consensus) ? 'warn' : ''));
    cell('Research score', lat && lat.researchScore != null ? String(lat.researchScore) + (lat.circuitScore != null ? ' / Circuit ' + lat.circuitScore : '') : '—');
    cell('Risk level', lat && lat.riskLevel ? String(lat.riskLevel).toUpperCase() : '—', lat && (lat.riskLevel === 'high' || lat.riskLevel === 'critical') ? 'warn' : 'good');
    if (!sub) return;
    const row = (txt, cls) => {
      const n = el('div', 'adaptive-row' + (cls ? ' ' + cls : ''));
      n.appendChild(document.createTextNode(txt));
      return n;
    };
    if (lat && lat.symbol) {
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', 'LATEST RESEARCH — ' + lat.symbol));
      b.appendChild(row('Technical ' + (lat.technicalScore != null ? lat.technicalScore : '—') + ' · Quant ' + (lat.quantScore != null ? lat.quantScore : '—') +
        ' · Sentiment ' + (lat.sentimentScore != null ? lat.sentimentScore : '—') + ' · Market ' + (lat.marketScore != null ? lat.marketScore : '—')));
      b.appendChild(row('Bull ' + (lat.bullScore != null ? lat.bullScore : '—') + ' · Bear risk ' + (lat.bearRisk != null ? lat.bearRisk : '—')));
      const recPill = el('span', 'pill ' + (lat.recommendation === 'BUY' ? 'profit' : lat.recommendation === 'AVOID' ? 'loss' : 'flat'), String(lat.recommendation));
      const rec = el('div', 'adaptive-row');
      rec.appendChild(el('span', 'k', 'Recommendation '));
      rec.appendChild(recPill);
      rec.appendChild(document.createTextNode(' · Circuit decision ' + String(lat.circuitDecision || '—') + ' · dataQuality ' + String(lat.dataQuality || 'ok')));
      b.appendChild(rec);
      if (lat.dataQuality === 'suspicious') b.appendChild(row('⚠ price-integrity suspicious — research does not override integrity', 'warn'));
      if (lat.warnings && lat.warnings.length) {
        const wb = el('div', 'adaptive-row warn');
        wb.appendChild(el('span', 'k', 'Warnings: '));
        wb.appendChild(document.createTextNode(lat.warnings.slice(0, 4).join(' · ')));
        b.appendChild(wb);
      }
      sub.appendChild(b);
    } else {
      sub.appendChild(row('No research decision logged yet — research runs on top candidates each discovery scan.', 'muted'));
    }
    // Position assessments (research has no sell authority).
    const posAssess = Array.isArray(ta.lastPositionAssessments) ? ta.lastPositionAssessments : [];
    if (posAssess.length) {
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', 'POSITION RESEARCH (hold / caution / high_risk — no sell authority)'));
      for (const p of posAssess.slice(-4)) {
        b.appendChild(row(String(p.symbol) + ' → ' + String(p.assessment || 'hold').toUpperCase() + ' · risk ' + String(p.riskLevel || 'medium') + ' · dataQuality ' + String(p.dataQuality || 'ok') + ' · ' + ago(p.ts)));
      }
      sub.appendChild(b);
    }
    // Per-agent prediction accuracy.
    const byAgent = acc.byAgent || {};
    const agentKeys = Object.keys(byAgent).filter((k) => byAgent[k] && byAgent[k].n);
    if (agentKeys.length) {
      const b = el('div', 'adaptive-block');
      b.appendChild(el('div', 'adaptive-block-title', 'AGENT PREDICTION ACCURACY'));
      for (const k of agentKeys) {
        const a = byAgent[k];
        const pct = a.n ? Math.round((a.correct / a.n) * 1000) / 10 : null;
        b.appendChild(row(k + ': ' + (pct == null ? 'n/a' : pct + '%') + ' (' + a.correct + '/' + a.n + ')'));
      }
      sub.appendChild(b);
    }
  }

  // ---- equity curve (observed data only) --------------------------------
  function showChartEmpty(msg) {
    $('chart-empty').textContent = msg;
    $('chart-empty').classList.remove('hidden');
  }
  function hideChartEmpty() { $('chart-empty').classList.add('hidden'); }

  // Trade markers on the equity curve: ▲ green below the curve for BUYs,
  // ▼ above it for SELLs (green/red/grey by realized-P&L sign). The equity
  // value at each trade timestamp is linearly interpolated from the plotted
  // points. Capped at the 150 most recent in-range trades. Display only.
  function drawTradeMarkers(ctx, pts, x, y) {
    if (!state.trades.length || pts.length < 2) return;
    const asc = pts.slice().sort((a, b) => a.ts - b.ts);
    const minT = asc[0].ts, maxT = asc[asc.length - 1].ts;
    if (!(maxT > minT)) return;
    const at = (ts) => {
      if (ts <= minT) return asc[0].eq;
      if (ts >= maxT) return asc[asc.length - 1].eq;
      for (let i = 1; i < asc.length; i++) {
        if (asc[i].ts >= ts) {
          const a = asc[i - 1], b = asc[i];
          const f = b.ts === a.ts ? 0 : (ts - a.ts) / (b.ts - a.ts);
          return a.eq + (b.eq - a.eq) * f;
        }
      }
      return asc[asc.length - 1].eq;
    };
    const list = state.trades
      .map((t) => ({ t, ts: new Date(t.timestamp).getTime() }))
      .filter((o) => Number.isFinite(o.ts) && o.ts >= minT && o.ts <= maxT)
      .slice(-150);
    for (const o of list) {
      const t = o.t;
      const cx = x(o.ts), cy = y(at(o.ts));
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const buy = t.side === 'BUY';
      const pnl = t.realizedPnlSol || 0;
      ctx.fillStyle = buy ? '#2ecc8f' : (pnl > 0 ? '#2ecc8f' : pnl < 0 ? '#ff5c6c' : '#8a94a6');
      const s = 4;
      ctx.beginPath();
      if (buy) { ctx.moveTo(cx, cy + 7 + s); ctx.lineTo(cx - s, cy + 7); ctx.lineTo(cx + s, cy + 7); }
      else { ctx.moveTo(cx, cy - 7 - s); ctx.lineTo(cx - s, cy - 7); ctx.lineTo(cx + s, cy - 7); }
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawEquity() {
    const canvas = $('equity-chart');
    const empty = $('chart-empty');
    if (!state.equity.length) {
      empty.classList.remove('hidden');
      empty.textContent = 'No equity history recorded yet. The agent appends a point after each scan — check back after it runs for a minute or two.';
      return;
    }
    hideChartEmpty();

    // Point chart at its rendered size (retina-aware).
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(2, Math.floor(rect.width * dpr));
    canvas.height = Math.max(2, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    // Equity points in INR (observed equity × real conversion); falls back
    // to SOL when no rate is available.
    const hasRate = fxAvailable() && Number(state.fx.inrPerSol) > 0;
    const pts = state.equity.map((r) => {
      const inrV = Number.isFinite(r.equityInr) ? r.equityInr
        : (hasRate && Number.isFinite(r.equitySol) ? r.equitySol * state.fx.inrPerSol : null);
      return { ts: r.ts, eq: inrV != null ? inrV : r.equitySol };
    }).filter((p) => Number.isFinite(p.eq) && p.eq !== null && p.eq !== undefined);
    if (!pts.length) { showChartEmpty('No usable equity history yet.'); return; }
    const minT = Math.min.apply(null, pts.map((p) => p.ts));
    const maxT = Math.max.apply(null, pts.map((p) => p.ts));
    const eqs = pts.map((p) => p.eq);
    // Starting-capital baseline, in the same units as the plotted points, so
    // the y-range always includes it and profit/loss vs start is visible.
    let baseEq = null;
    if (state.perf && Number.isFinite(state.perf.startingCapitalSol)) {
      const b = hasRate ? state.perf.startingCapitalSol * state.fx.inrPerSol : state.perf.startingCapitalSol;
      if (Number.isFinite(b)) { baseEq = b; eqs.push(b); }
    }
    const minEq = Math.min.apply(null, eqs);
    const maxEq = Math.max.apply(null, eqs);
    const spanEq = maxEq - minEq || 1;

    const padL = 10, padR = 10, padT = 12, padB = 24;
    const x = (ts) => padL + (maxT === minT ? 0.5 : (ts - minT) / (maxT - minT)) * (W - padL - padR);
    const y = (eq) => padT + (1 - (eq - minEq) / spanEq) * (H - padT - padB);

    // grid + zero-ish baseline
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#1e2634';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const yy = padT + (i / 4) * (H - padT - padB);
      ctx.moveTo(padL, yy);
      ctx.lineTo(W - padR, yy);
    }
    ctx.stroke();

    // area + line
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(p.ts), y(p.eq)) : ctx.moveTo(x(p.ts), y(p.eq))));
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.lineTo(x(pts[pts.length - 1].ts), H - padB);
    ctx.lineTo(x(pts[0].ts), H - padB);
    ctx.closePath();
    ctx.fillStyle = 'rgba(79, 140, 255, 0.10)';
    ctx.fill();

    // starting-capital baseline (dashed grey) + trade markers
    if (baseEq != null) {
      ctx.save();
      ctx.strokeStyle = '#8a94a6';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y(baseEq));
      ctx.lineTo(W - padR, y(baseEq));
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#8a94a6';
      ctx.font = '10px monospace';
      ctx.fillText('start', padL + 2, y(baseEq) - 4);
    }
    drawTradeMarkers(ctx, pts, x, y);

    // first/last labels
    ctx.fillStyle = '#8a94a6';
    ctx.font = '11px monospace';
    ctx.textBaseline = 'alphabetic';
    const last = pts[pts.length - 1];
    ctx.fillStyle = last.eq >= minEq + spanEq * 0.5 ? '#e6ebf2' : '#8a94a6';
    ctx.fillText(hasRate ? fmtInr(last.eq) : fmt(last.eq, 5) + ' SOL', padL, H - 6);
    ctx.fillStyle = '#8a94a6';
    ctx.fillText(new Date(pts[0].ts).toLocaleDateString(), padL, H - 6);
    ctx.textAlign = 'right';
    ctx.fillText(new Date(last.ts).toLocaleString(), W - padR, H - 6);
    ctx.textAlign = 'left';
    canvas.title = hasRate
      ? 'Equity plotted in ₹ (SOL × real SOL/USD × USD/INR). ' + fmt(last.eq, 4) + ' currently.'
      : 'No INR rate available — equity plotted in SOL.';
  }

  // ---- main render --------------------------------------------------------
  function render() {
    const p = state.perf;
    if (!p) return;
    state.solPriceUsd = state.heartbeat ? state.heartbeat.solPriceUsd : null;
    renderHalt();
    renderFxLine();
    renderCards(p);
    renderLive(state.heartbeat, p);
    renderSystem(state.heartbeat);
    renderSources();
    renderCandidates();
    renderErrors();
    renderPositions();
    renderTrades();
    renderPerf(p);
    renderAdaptive();
    renderIntegrity();
    renderTradingAgents();
    renderAtlas();
    renderAtlasScorecard();
    renderAtlasCalibration();
    renderAtlasAB();
    drawEquity();
    const line = $('status-line');
    if (line && state.conn !== 'stale') {
      line.textContent = 'refreshed ' + ago(state.lastGoodAt) + ' · api ' + API_BASE +
        (state.heartbeat && state.heartbeat.lastScanAt ? ' · last scan ' + ago(state.heartbeat.lastScanAt) : '');
    }
  }

  // ---- wiring -------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    $('status-line').textContent = 'connecting to ' + API_BASE + ' …';

    const filter = $('side-filter');
    if (filter) {
      filter.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        state.sideFilter = b.dataset.side;
        filter.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        renderTrades();
      });
    }

    window.addEventListener('resize', () => { if (state.perf) drawEquity(); });

    poll();
    setInterval(poll, POLL_MS);
  });
})();
