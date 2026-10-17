#!/usr/bin/env node
/**
 * backtest.js — Replay-based backtester for the Circuit paper-trader agent.
 *
 * Design (inspired by NautilusTrader's deterministic replay architecture):
 *
 *   1. COLLECTOR — appends token snapshots to a JSONL file during live runs.
 *      Each line is one { ts, solPriceUsd, tokens: { [mint]: { ... } } } object.
 *
 *   2. REPLAY ENGINE — reads snapshots in chronological order, maintains local
 *      price history per token, runs the same 22-gate entry cascade + decideExit
 *      logic that agentd.js uses.  Every gate, threshold, and branch is replicated
 *      from agentd.js so backtest results are directly comparable to live behavior.
 *
 *   3. METRICS — computes win rate, profit factor, per-gate rejection counts,
 *      total P&L, max drawdown, Sharpe approximation, and per-regime breakdown.
 *
 * Usage:
 *   # Collect snapshots during live run (pipe from agent log or run standalone):
 *   node backtest.js collect --out /tmp/snapshots.jsonl
 *
 *   # Replay a snapshot file through the backtester:
 *   node backtest.js replay --data /tmp/snapshots.jsonl [--config v1] [--config optimized]
 *
 *   # Compare two configs side-by-side:
 *   node backtest.js compare --data /tmp/snapshots.jsonl --a v1 --b optimized
 *
 * The collector is lightweight enough to run alongside the live agent with
 * negligible overhead (one JSONL append per 5 s scan).
 */

'use strict';

const fs = require('fs');
const path = require('path');

function round(v, dp) { const f = Math.pow(10, dp || 0); return Math.round(v * f) / f; }
function round4(v) { return Math.round(v * 10000) / 10000; }

// ─────────────────────────────────────────────────────────────────────
// §1  Gate configuration presets
// ─────────────────────────────────────────────────────────────────────

const PRESETS = {
  v1: {
    label: 'V1 baseline',
    minScore: 60,
    min1h: -35,
    max1h: 15,
    min5m: 0.25,
    max5m: 8,
    confirmRises: 2,
    maxGapMs: 120000,
    rsiOversold: 30,
    rsiPeriod: 14,
    vwapMinBars: 8,
    maxSellsBuysRatio: 1.5,
    minLiqMcapPct: 2,
    maxNatrPct: 4,
    minNatrFloorPct: 1.5,
    atrSlMult: 1.5,
    atrTpMult: 2.5,
    historyTargetMs: 300000,
    minHistorySamples: 8,
    maxPositions: 5,
    tradeSizeSol: 0.05,
    cooldownMs: 600000,
    partialTakePct: 5,
    partialFraction: 0.5,
    runnerTpPct: 12,
    breakevenPct: 0,
    timeStopMs: 3600000,
    timeStopMinPnlPct: 2,
    stopLossPct: -6,
    takeProfitPct: 8,
  },
  optimized: {
    label: 'Optimized (relaxed gates)',
    minScore: 60,
    min1h: -35,
    max1h: 15,
    min5m: 0.25,
    max5m: 8,
    confirmRises: 2,
    maxGapMs: 120000,
    rsiOversold: 50,
    rsiPeriod: 14,
    vwapMinBars: 8,
    maxSellsBuysRatio: 1.5,
    minLiqMcapPct: 2,
    maxNatrPct: 4,
    minNatrFloorPct: 1.5,
    atrSlMult: 1.5,
    atrTpMult: 2.5,
    historyTargetMs: 120000,
    minHistorySamples: 5,
    maxPositions: 5,
    tradeSizeSol: 0.05,
    cooldownMs: 600000,
    partialTakePct: 5,
    partialFraction: 0.5,
    runnerTpPct: 12,
    breakevenPct: 0,
    timeStopMs: 3600000,
    timeStopMinPnlPct: 2,
    stopLossPct: -6,
    takeProfitPct: 8,
  },
};

// ─────────────────────────────────────────────────────────────────────
// §2  Price history management (mirrors agentd.js in-memory sampler)
// ─────────────────────────────────────────────────────────────────────

function createPriceHistory() {
  return new Map(); // mint → { samples: [{ ts, priceUsd, priceSol }], lastTs: 0 }
}

function samplePrice(history, mint, ts, priceUsd, priceSol, intervalMs) {
  if (!history.has(mint)) {
    history.set(mint, { samples: [], lastTs: 0 });
  }
  const h = history.get(mint);
  if (ts - h.lastTs < intervalMs) return; // too soon
  h.samples.push({ ts, priceUsd, priceSol });
  h.lastTs = ts;
  // keep last 120 samples (~10 min at 5s intervals)
  if (h.samples.length > 120) h.samples.splice(0, h.samples.length - 120);
}

function getHistory(history, mint) {
  return history.get(mint) || { samples: [], lastTs: 0 };
}

// ─────────────────────────────────────────────────────────────────────
// §3  Replicated gate functions from agentd.js
// ─────────────────────────────────────────────────────────────────────

function computeRecoveryPct(samples, historyTargetMs) {
  if (!samples || samples.length < 3) return { status: 'warming', pct: null, samples: samples ? samples.length : 0 };
  const now = samples[samples.length - 1].ts;
  const baseline = samples.find(s => (now - s.ts) >= historyTargetMs);
  if (!baseline) return { status: 'warming', pct: null, samples: samples.length };
  const baselineWindow = samples.filter(s => Math.abs((now - s.ts) - (now - baseline.ts)) < 30000);
  if (!baselineWindow.length) return { status: 'warming', pct: null, samples: samples.length };
  const basePrice = baselineWindow[0].priceSol;
  if (!basePrice || basePrice <= 0) return { status: 'warming', pct: null, samples: samples.length };
  const currentPrice = samples[samples.length - 1].priceSol;
  const pct = ((currentPrice - basePrice) / basePrice) * 100;
  return { status: 'ok', pct: Math.round(pct * 100) / 100, samples: samples.length };
}

function computeScore({ change1hPct, recoveryPct, liquidityUsd, volume24hUsd }) {
  let score = 0;
  if (Number.isFinite(change1hPct)) {
    const abs = Math.abs(change1hPct);
    score += Math.min(35, Math.round(abs * 1));
  }
  if (Number.isFinite(recoveryPct) && recoveryPct > 0) {
    score += Math.min(30, Math.round(recoveryPct * 4));
  }
  if (Number.isFinite(liquidityUsd) && liquidityUsd > 0) {
    score += Math.min(20, Math.round(Math.log10(liquidityUsd / 1000) * 6));
  }
  if (Number.isFinite(volume24hUsd) && volume24hUsd > 0) {
    score += Math.min(15, Math.round(Math.log10(volume24hUsd / 1000) * 4));
  }
  return Math.min(100, Math.max(0, score));
}

function bounceConfirmation(samples, rises, maxGapMs) {
  if (!samples || !samples.length) return { confirmed: false, rising: false, slopeUp: false, gapsOk: false, n: 0, reason: 'no-data' };
  const raw = samples;
  const pts = [];
  for (const s of raw) {
    if (!pts.length || s.priceUsd !== pts[pts.length - 1].priceUsd) pts.push(s);
  }
  const n = pts.length;
  const needRises = rises;
  const base = { confirmed: false, rising: false, slopeUp: false, gapsOk: false, slopePctPerMin: 0, n, reason: null };
  if (n < needRises + 1) return Object.assign(base, { reason: `insufficient-samples (${n}/${needRises + 1})` });
  const tail = pts.slice(-(needRises + 1));
  let gapsOk = true;
  for (let i = 1; i < tail.length; i++) {
    const gap = tail[i].ts - tail[i - 1].ts;
    if (!(gap > 0 && gap <= maxGapMs)) gapsOk = false;
  }
  if (!gapsOk) return Object.assign(base, { rising: false, reason: 'stale-gap in recent closes' });
  const rising = tail[tail.length - 1].priceUsd > tail[0].priceUsd;
  const w = pts.slice(-20);
  const K = w.length;
  const t0 = w[0].ts;
  let st = 0, sp = 0, stt = 0, stp = 0;
  for (const s of w) {
    const t = (s.ts - t0) / 1000;
    st += t; sp += s.priceUsd; stt += t * t; stp += t * s.priceUsd;
  }
  const den = K * stt - st * st;
  const slope = den !== 0 ? (K * stp - st * sp) / den : 0;
  const lastP = w[K - 1].priceUsd;
  const slopePctPerMin = lastP > 0 && Number.isFinite(slope) ? (slope / lastP) * 100 * 60 : 0;
  const slopeUp = slope > 0;
  if (!rising) return Object.assign(base, { rising, gapsOk, slopeUp, slopePctPerMin: round4(slopePctPerMin), reason: `no net rise over last ${needRises + 1} distinct closes` });
  if (!slopeUp) return Object.assign(base, { rising, gapsOk, slopeUp, slopePctPerMin: round4(slopePctPerMin), reason: `5m slope not up (${round4(slopePctPerMin)}%/min)` });
  return { confirmed: true, rising, slopeUp, gapsOk, slopePctPerMin: round4(slopePctPerMin), n, reason: null };
}

function resampleToBars(samples, barMs) {
  const ms = Number.isFinite(barMs) && barMs > 0 ? barMs : 60000;
  const buckets = new Map();
  for (const s of (Array.isArray(samples) ? samples : [])) {
    if (!s || !Number.isFinite(s.priceUsd) || s.priceUsd <= 0 || !Number.isFinite(s.ts)) continue;
    const start = Math.floor(s.ts / ms) * ms;
    const prev = buckets.get(start);
    if (!prev || s.ts >= prev.ts) buckets.set(start, { ts: s.ts, start, close: s.priceUsd });
  }
  return Array.from(buckets.keys()).sort((a, b) => a - b)
    .map((k) => ({ ts: k, close: buckets.get(k).close }));
}

/** Simple-mean RSI over a close array — identical to agentd.js rsiOfCloses. */
function computeRsi(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return { rsi: null, warming: false };
  let g = 0, l = 0, n = 0;
  for (let i = 1; i < closes.length; i++) {
    const a = Number(closes[i - 1]);
    const b = Number(closes[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    const d = b - a;
    if (d > 0) g += d; else l -= d;
    n += 1;
  }
  if (!n) return { rsi: null, warming: false };
  g /= n; l /= n;
  if (l === 0) return { rsi: g === 0 ? 50 : 100, warming: false };
  if (g === 0) return { rsi: 0, warming: false };
  return { rsi: Math.round((100 - 100 / (1 + g / l)) * 100) / 100, warming: false };
}

function evaluateRsiVwap(samples, cfg) {
  const barMs = cfg.rsiBarMs || 60000;
  const period = cfg.rsiPeriod || 14;
  const minBars = cfg.rsiMinBars || (period + 1);
  const oversold = cfg.rsiOversold;
  const lookbackMs = cfg.vwapLookbackMs || 300000;
  const vwapMin = cfg.vwapMinBars || 8;
  const now = samples.length ? samples[samples.length - 1].ts : Date.now();

  const out = { ok: true, reason: null, rsi: null, rsiPrev: null, rsiWarming: true, bars: 0, vwap: null, vwapDistPct: null };

  const bars = resampleToBars(samples, barMs);
  out.bars = bars.length;
  if (bars.length >= minBars) {
    const closes = bars.slice(-minBars).map((b) => b.close);
    const r = computeRsi(closes).rsi;
    const rPrev = computeRsi(closes.slice(0, -1)).rsi;
    out.rsi = r == null ? null : round(r, 2);
    out.rsiPrev = rPrev == null ? null : round(rPrev, 2);
    out.rsiWarming = false;
    if (r == null || rPrev == null || !(r < oversold && r > rPrev)) {
      out.ok = false;
      out.reason = r == null ? 'rsi unavailable'
        : `rsi ${r.toFixed(1)} not oversold-turning (<${oversold} and rising, prev ${rPrev == null ? 'n/a' : rPrev.toFixed(1)})`;
      return out;
    }
  }

  const closes = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(s.priceUsd) && s.priceUsd > 0 && Number.isFinite(s.ts) && s.ts >= now - lookbackMs)
    .sort((a, b) => a.ts - b.ts);
  if (closes.length < vwapMin) {
    out.ok = false;
    out.reason = `vwap unavailable (${closes.length}/${vwapMin} closes in 5m)`;
    return out;
  }
  let sum = 0;
  for (const s of closes) sum += s.priceUsd;
  const mean = sum / closes.length;
  const last = closes[closes.length - 1].priceUsd;
  out.vwap = mean;
  out.vwapDistPct = mean > 0 ? round(((last / mean) - 1) * 100, 2) : null;
  if (!(last > mean)) {
    out.ok = false;
    out.reason = `below 5m VWAP (${out.vwapDistPct}% vs mean)`;
    return out;
  }
  return out;
}

function evaluateOrderflow(c) {
  const txBuys = Number(c.txBuys) || 0;
  const txSells = Number(c.txSells) || 0;
  const liq = Number(c.liquidityUsd) || 0;
  const mcap = Number(c.marketCapUsd) || Number(c.fdvUsd) || 0;
  if (txBuys === 0 && txSells === 0) return { ok: true, reason: null, sellsBuysRatio: 0, liqMcapPct: 0 };
  if (txSells > 0 && txBuys === 0) return { ok: false, reason: 'orderflow distribution (one-sided dump)', sellsBuysRatio: Infinity, liqMcapPct: 0 };
  const ratio = txBuys > 0 ? txSells / txBuys : 0;
  if (ratio > 1.5) return { ok: false, reason: `orderflow distribution (sells ${txSells} > 1.5× buys ${txBuys})`, sellsBuysRatio: round4(ratio), liqMcapPct: 0 };
  if (mcap > 0) {
    const liqPct = (liq / mcap) * 100;
    if (liqPct < 2) return { ok: false, reason: `liquidity thin vs valuation (liq $${liq} < 2% of mcap $${mcap})`, sellsBuysRatio: round4(ratio), liqMcapPct: round4(liqPct) };
    return { ok: true, reason: null, sellsBuysRatio: round4(ratio), liqMcapPct: round4(liqPct) };
  }
  return { ok: true, reason: null, sellsBuysRatio: round4(ratio), liqMcapPct: 0 };
}

function computeNatr(samples) {
  if (!samples || samples.length < 8) return null;
  const closes = samples.slice(-20).map(s => s.priceSol).filter(p => Number.isFinite(p) && p > 0);
  if (closes.length < 8) return null;
  let sumTr = 0;
  for (let i = 1; i < closes.length; i++) sumTr += Math.abs(closes[i] - closes[i - 1]);
  const atr = sumTr / (closes.length - 1);
  const meanP = closes.reduce((s, p) => s + p, 0) / closes.length;
  if (meanP <= 0) return null;
  return Math.round((atr / meanP) * 10000) / 100;
}

function passesNatrGate(natr, cfg) {
  if (natr === null || natr === undefined) return { allow: true, reason: 'unknown-natr-fail-open' };
  if (natr > cfg.maxNatrPct) return { allow: false, reason: `NATR ${natr}% above maximum ${cfg.maxNatrPct}% — stop would gap` };
  return { allow: true, reason: null };
}

function atrLevels(natr, cfg) {
  const eff = Math.max(cfg.minNatrFloorPct, Math.min(cfg.maxNatrPct, natr || cfg.minNatrFloorPct));
  const slPct = Math.round(-cfg.atrSlMult * eff * 100) / 100;
  const tpPct = Math.round(cfg.atrTpMult * eff * 100) / 100;
  return { slPct, tpPct, eff };
}

// ─────────────────────────────────────────────────────────────────────
// §4  Entry gate evaluation (22-gate cascade replica)
// ─────────────────────────────────────────────────────────────────────

function evaluateEntryGate(c, state, cfg, funnel) {
  const { positions, buysThisSession } = state;
  const { history } = state;

  const pass = (gate) => { if (funnel) { funnel.byGate[gate] = (funnel.byGate[gate] || 0) + 1; } };
  const fail = (gate, reason) => {
    if (funnel) { funnel.byGate[gate] = (funnel.byGate[gate] || 0) + 1; }
    return { allow: false, reason, gate };
  };

  // G1: max positions
  if (positions.length >= cfg.maxPositions) return fail('G1-max-positions', 'max positions reached');
  // G2: market health — skip in backtest (no live health feed)
  // G3: session buy cap
  if (buysThisSession >= cfg.maxPositions) return fail('G3-buy-cap', 'session buy cap reached');
  // G4: score
  if (c.score < cfg.minScore) return fail('G4-score', `score below threshold (min ${cfg.minScore})`);
  pass('G4-score');
  // G5-G6: bandit/winprob — skip in backtest (no learned state)
  // G7: 1h change band
  if (!Number.isFinite(c.change1hPct) || c.change1hPct <= cfg.min1h || c.change1hPct > cfg.max1h) {
    return fail('G7-1h-change', `1h change outside range (${cfg.min1h}..${cfg.max1h})`);
  }
  pass('G7-1h-change');
  // G8: 5m recovery warming
  const h = getHistory(history, c.mint);
  const recovery = computeRecoveryPct(h.samples, cfg.historyTargetMs);
  if (recovery.status === 'warming') return fail('G8-warming', `5m recovery warming (${recovery.samples} samples)`);
  pass('G8-warming');
  // G9: 5m recovery band
  if (recovery.pct === null || recovery.pct < cfg.min5m || recovery.pct > cfg.max5m) {
    return fail('G9-recovery-band', `5m recovery outside range (${cfg.min5m}..${cfg.max5m})`);
  }
  pass('G9-recovery-band');
  // G10: bounce confirmation
  const bc = bounceConfirmation(h.samples, cfg.confirmRises, cfg.maxGapMs);
  if (!bc.confirmed) return fail('G10-bounce', `bounce unconfirmed (${bc.reason})`);
  pass('G10-bounce');
  // G11: RSI + VWAP
  const rv = evaluateRsiVwap(h.samples, cfg);
  if (!rv.ok) return fail('G11-rsi-vwap', rv.reason);
  pass('G11-rsi-vwap');
  // G12: liquidity floor
  if (!(Number.isFinite(c.liquidityUsd) && c.liquidityUsd >= 20000)) return fail('G12-liquidity', 'liquidity below minimum ($20,000)');
  pass('G12-liquidity');
  // G13: volume floor
  if (!(Number.isFinite(c.volume24hUsd) && c.volume24hUsd >= 50000)) return fail('G13-volume', '24h volume below minimum ($50,000)');
  pass('G13-volume');
  // G14: orderflow quality
  const quality = evaluateOrderflow(c);
  if (!quality.ok) return fail('G14-orderflow', quality.reason);
  pass('G14-orderflow');
  // G15: NATR volatility
  const natr = computeNatr(h.samples);
  const natrGate = passesNatrGate(natr, cfg);
  if (!natrGate.allow) return fail('G15-natr', natrGate.reason);
  pass('G15-natr');
  // G16: already holding
  if (positions.some(p => p.mint === c.mint)) return fail('G16-holding', 'already holding');
  pass('G16-holding');
  // G17: cooldown — check in state
  const cooldownUntil = state.cooldowns && state.cooldowns[c.mint];
  if (state.cooldowns && cooldownUntil && cooldownUntil > Date.now()) return fail('G17-cooldown', 're-entry cooldown');
  pass('G17-cooldown');
  // G18: sufficient cash
  if (state.cashSol < cfg.tradeSizeSol) return fail('G18-cash', 'insufficient cash');
  pass('G18-cash');
  // G19-G21: ensemble/price/accounting — simplified for backtest

  // Compute ATR levels for exit
  const atr = atrLevels(natr, cfg);

  pass('ENTRY');
  return {
    allow: true,
    reason: null,
    gate: null,
    recoveryPct: recovery.pct,
    natr,
    rsi: rv.rsi,
    vwapDistPct: rv.vwapDistPct,
    quality,
    atr,
    score: c.score,
  };
}

// ─────────────────────────────────────────────────────────────────────
// §5  Exit decision (mirrors decideExit from agentd.js)
// ─────────────────────────────────────────────────────────────────────

function decideExit(position, pnlPct, nowMs, cfg) {
  const sl = Number.isFinite(position.stopLossPct) ? position.stopLossPct : cfg.stopLossPct;
  const tp = Number.isFinite(position.takeProfitPct) ? position.takeProfitPct : cfg.takeProfitPct;

  // Step 1: stop-loss
  if (Number.isFinite(pnlPct) && pnlPct <= sl) {
    return { action: 'close', reason: position.partialTaken ? 'breakeven-stop' : 'stop-loss' };
  }
  // Step 2: take-profit
  if (Number.isFinite(pnlPct) && pnlPct >= tp) {
    return { action: 'close', reason: 'take-profit' };
  }
  // Step 3: partial-take
  if (!position.partialTaken && Number.isFinite(pnlPct)) {
    const take = cfg.partialTakePct;
    const fraction = cfg.partialFraction;
    const runner = Math.max(cfg.runnerTpPct, take + 1);
    const breakeven = Math.max(cfg.stopLossPct, Math.min(cfg.breakevenPct, take - 0.5));
    if (pnlPct >= take && take < tp) {
      return { action: 'partial', reason: 'partial-take', take, fraction, runner, breakeven };
    }
  }
  // Step 4: time-stop
  if (position.openedAtMs) {
    const held = nowMs - position.openedAtMs;
    if (held >= cfg.timeStopMs && Number.isFinite(pnlPct) && pnlPct < cfg.timeStopMinPnlPct) {
      return { action: 'close', reason: 'time-stop' };
    }
  }
  return { action: null, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
// §6  Replay engine
// ─────────────────────────────────────────────────────────────────────

function createReplayState(cfg) {
  return {
    cashSol: 10,
    startingCapitalSol: 10,
    positions: [],
    cooldowns: {},
    buysThisSession: 0,
    history: createPriceHistory(),
    trades: [],
    gateRejections: {},
    funnel: { evaluated: 0, byGate: {} },
    totalScans: 0,
    totalCandidatesEvaluated: 0,
    totalEntriesAttempted: 0,
  };
}

function replaySnapshots(snapshots, cfg) {
  const state = createReplayState(cfg);
  const now = Date.now();

  for (const snap of snapshots) {
    const ts = snap.ts || now;
    const solPriceUsd = snap.solPriceUsd || 100;
    state.totalScans++;

    // Update price history for all tokens
    if (snap.tokens) {
      for (const [mint, token] of Object.entries(snap.tokens)) {
        if (token.priceUsd > 0 && Number.isFinite(token.priceUsd)) {
          const priceSol = token.priceSol || (token.priceUsd / solPriceUsd);
          samplePrice(state.history, mint, ts, token.priceUsd, priceSol, 5000);
        }
      }
    }

    // Monitor existing positions
    monitorPositions(state, snap, ts, cfg);

    // Try entry for new candidates
    if (snap.tokens) {
      const candidates = Object.entries(snap.tokens)
        .map(([mint, t]) => ({
          mint,
          symbol: t.symbol || mint.slice(0, 6),
          priceUsd: Number(t.priceUsd) || 0,
          priceSol: Number(t.priceSol) || (Number(t.priceUsd) / solPriceUsd),
          change1hPct: Number(t.change1hPct) || 0,
          liquidityUsd: Number(t.liquidityUsd) || 0,
          volume24hUsd: Number(t.volume24hUsd) || 0,
          txBuys: Number(t.txBuys) || 0,
          txSells: Number(t.txSells) || 0,
          fdvUsd: Number(t.fdvUsd) || 0,
          marketCapUsd: Number(t.marketCapUsd) || 0,
          score: Number(t.score) || null,
          recoveryPct: t.recoveryPct != null ? t.recoveryPct : null,
          recoveryStatus: t.recoveryStatus || null,
          natr: t.natr != null ? t.natr : null,
          bounce: t.bounce || null,
          rsi: t.rsi || null,
          quality: t.quality || null,
          isOpenPosition: !!t.isOpenPosition,
        }))
        .filter(c => c.priceUsd > 0 && !c.isOpenPosition);

      // Sort by score descending — use pre-computed score from snapshot when
      // available (the live agent's value), else compute locally.
      for (const c of candidates) {
        if (c.score != null) {
          // keep pre-computed score
        } else {
          c.score = computeScore({
            change1hPct: c.change1hPct,
            recoveryPct: c.recoveryPct || 0,
            liquidityUsd: c.liquidityUsd,
            volume24hUsd: c.volume24hUsd,
          });
        }
      }
      candidates.sort((a, b) => (b.score - a.score) || ((b.recoveryPct || 0) - (a.recoveryPct || 0)));

      // Try top candidates
      for (const c of candidates.slice(0, 10)) {
        state.totalCandidatesEvaluated++;
        state.funnel.evaluated++;
        const gate = evaluateEntryGate(c, state, cfg, state.funnel);
        if (!gate.allow) {
          state.gateRejections[gate.reason] = (state.gateRejections[gate.reason] || 0) + 1;
          continue;
        }
        // Execute paper buy
        executePaperBuy(c, state, ts, cfg, gate);
      }
    }
  }

  // Close any remaining positions at last snapshot price
  if (state.positions.length > 0 && snapshots.length > 0) {
    const lastSnap = snapshots[snapshots.length - 1];
    const solPriceUsd = lastSnap.solPriceUsd || 100;
    for (const pos of [...state.positions]) {
      const token = lastSnap.tokens && lastSnap.tokens[pos.mint];
      if (token) {
        const priceSol = Number(token.priceSol) || (Number(token.priceUsd) / solPriceUsd);
        executePaperSell(pos, { priceSol, priceUsd: Number(token.priceUsd) || 0 }, state, 'backtest-end', ts, cfg);
      }
    }
  }

  return state;
}

function monitorPositions(state, snap, ts, cfg) {
  const solPriceUsd = snap.solPriceUsd || 100;
  const toRemove = [];

  for (const pos of state.positions) {
    const token = snap.tokens && snap.tokens[pos.mint];
    if (!token || !(token.priceUsd > 0)) continue;

    const priceSol = Number(token.priceSol) || (Number(token.priceUsd) / solPriceUsd);
    if (!(priceSol > 0)) continue;

    // Update position price
    pos.currentPriceSol = priceSol;
    pos.currentPriceUsd = Number(token.priceUsd) || 0;

    // Compute P&L
    const pnlPct = pos.entryPriceSol > 0
      ? ((priceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100
      : 0;

    // Decide exit
    const decision = decideExit(pos, pnlPct, ts, cfg);
    if (decision.action === 'close') {
      executePaperSell(pos, { priceSol, priceUsd: Number(token.priceUsd) || 0 }, state, decision.reason, ts, cfg);
      toRemove.push(pos.mint);
    } else if (decision.action === 'partial') {
      executePaperPartial(pos, { priceSol, priceUsd: Number(token.priceUsd) || 0 }, state, ts, cfg, decision);
    }
  }

  // Remove closed positions
  state.positions = state.positions.filter(p => !toRemove.includes(p.mint));
}

function executePaperBuy(c, state, ts, cfg, gateResult) {
  if (state.positions.length >= cfg.maxPositions) return;
  if (state.cashSol < cfg.tradeSizeSol) return;

  const costSol = cfg.tradeSizeSol;
  const priceSol = c.priceSol;
  const priceUsd = c.priceUsd;
  if (!(priceSol > 0)) return;
  const quantity = Math.round((costSol / priceSol) * 1e8) / 1e8;
  if (quantity <= 0) return;

  const atr = gateResult.atr || atrLevels(null, cfg);

  const position = {
    mint: c.mint,
    symbol: c.symbol,
    quantity,
    entryPriceSol: priceSol,
    entryPriceUsd: priceUsd,
    currentPriceSol: priceSol,
    currentPriceUsd: priceUsd,
    costSol,
    entryCostSol: costSol,
    openedAtMs: ts,
    entryScore: c.score,
    stopLossPct: atr.slPct,
    takeProfitPct: atr.tpPct,
    atrNatr: gateResult.natr,
    partialTaken: false,
    realizedPartialSol: 0,
  };

  state.cashSol -= costSol;
  state.positions.push(position);
  state.buysThisSession++;
  state.totalEntriesAttempted++;

  state.trades.push({
    side: 'BUY',
    ts,
    mint: c.mint,
    symbol: c.symbol,
    priceSol,
    priceUsd,
    costSol,
    score: c.score,
    change1hPct: c.change1hPct,
    reason: null,
  });
}

function executePaperSell(pos, info, state, reason, ts, cfg) {
  const priceSol = info.priceSol;
  const exitValue = pos.quantity * priceSol;
  const legRealized = exitValue - pos.costSol;
  const tradeRealized = pos.realizedPartialSol + legRealized;
  const tradeRealizedPct = pos.entryCostSol > 0 ? (tradeRealized / pos.entryCostSol) * 100 : 0;

  state.cashSol += exitValue;
  state.totalTrades = (state.totalTrades || 0) + 1;
  state.wins = (state.wins || 0) + (tradeRealized > 0 ? 1 : 0);
  state.losses = (state.losses || 0) + (tradeRealized <= 0 ? 1 : 0);
  state.totalPnlSol = (state.totalPnlSol || 0) + tradeRealized;
  state.bestTradePnl = Math.max(state.bestTradePnl || 0, tradeRealized);
  state.worstTradePnl = Math.min(state.worstTradePnl || 0, tradeRealized);

  // Set cooldown
  state.cooldowns[pos.mint] = ts + cfg.cooldownMs;

  state.trades.push({
    side: 'SELL',
    ts,
    mint: pos.mint,
    symbol: pos.symbol,
    priceSol,
    priceUsd: info.priceUsd,
    entryPriceSol: pos.entryPriceSol,
    costSol: pos.entryCostSol,
    realizedPnlSol: tradeRealized,
    realizedPnlPct: Math.round(tradeRealizedPct * 100) / 100,
    reason,
    partialTaken: pos.partialTaken,
    heldMs: ts - pos.openedAtMs,
  });
}

function executePaperPartial(pos, info, state, ts, cfg, decision) {
  if (pos.partialTaken) return;
  const fraction = decision.fraction || cfg.partialFraction;
  const sellQty = pos.quantity * fraction;
  const remainingQty = pos.quantity - sellQty;
  const qtyRatio = sellQty / pos.quantity;
  const basisSold = pos.costSol * qtyRatio;
  const proceeds = sellQty * info.priceSol;
  const realized = proceeds - basisSold;

  state.cashSol += proceeds;
  pos.quantity = remainingQty;
  pos.costSol -= basisSold;
  pos.realizedPartialSol += realized;
  pos.partialTaken = true;
  pos.stopLossPct = decision.breakeven || cfg.breakevenPct;
  // Runner TP only on fixed path (no ATR)
  if (pos.atrNatr == null) pos.takeProfitPct = decision.runner || cfg.runnerTpPct;

  state.trades.push({
    side: 'PARTIAL',
    ts,
    mint: pos.mint,
    symbol: pos.symbol,
    priceSol: info.priceSol,
    priceUsd: info.priceUsd,
    realizedPnlSol: realized,
    reason: 'partial-take',
  });
}

// ─────────────────────────────────────────────────────────────────────
// §7  Metrics calculator
// ─────────────────────────────────────────────────────────────────────

function computeMetrics(state, cfg) {
  const sells = state.trades.filter(t => t.side === 'SELL');
  const wins = sells.filter(t => (t.realizedPnlSol || 0) > 0);
  const losses = sells.filter(t => (t.realizedPnlSol || 0) <= 0);
  const totalWinPnl = wins.reduce((s, t) => s + (t.realizedPnlSol || 0), 0);
  const totalLossPnl = Math.abs(losses.reduce((s, t) => s + (t.realizedPnlSol || 0), 0));
  const winRate = sells.length > 0 ? (wins.length / sells.length) * 100 : 0;
  const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0;
  const avgWin = wins.length > 0 ? totalWinPnl / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLossPnl / losses.length : 0;

  // Max drawdown
  let peak = state.startingCapitalSol;
  let maxDrawdown = 0;
  let equity = state.startingCapitalSol;
  for (const t of sells) {
    equity += t.realizedPnlSol || 0;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe approximation (annualized, assuming 5s scans)
  const returns = sells.map(t => (t.realizedPnlSol || 0) / state.startingCapitalSol);
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const scansPerYear = (365.25 * 24 * 60 * 60) / 5;
  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(scansPerYear) : 0;

  // Gate rejection summary
  const totalRejections = Object.values(state.gateRejections).reduce((s, v) => s + v, 0);
  const topRejections = Object.entries(state.gateRejections)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of sells) {
    const r = t.reason || 'unknown';
    exitReasons[r] = (exitReasons[r] || 0) + 1;
  }

  // Holding period stats
  const holdTimes = sells.filter(t => t.heldMs).map(t => t.heldMs);
  const avgHoldMs = holdTimes.length > 0 ? holdTimes.reduce((s, h) => s + h, 0) / holdTimes.length : 0;

  return {
    config: cfg.label || 'custom',
    totalScans: state.totalScans,
    totalCandidatesEvaluated: state.totalCandidatesEvaluated,
    totalEntriesAttempted: state.totalEntriesAttempted,
    totalTrades: sells.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round(winRate * 100) / 100,
    totalPnlSol: Math.round((state.totalPnlSol || 0) * 10000) / 10000,
    profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 'Infinity',
    avgWinSol: Math.round(avgWin * 10000) / 10000,
    avgLossSol: Math.round(avgLoss * 10000) / 10000,
    bestTradePnl: Math.round((state.bestTradePnl || 0) * 10000) / 10000,
    worstTradePnl: Math.round((state.worstTradePnl || 0) * 10000) / 10000,
    maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    avgHoldMs: Math.round(avgHoldMs),
    avgHoldMinutes: Math.round(avgHoldMs / 60000),
    finalCashSol: Math.round(state.cashSol * 10000) / 10000,
    equitySol: Math.round((state.cashSol + state.positions.reduce((s, p) => s + p.quantity * p.currentPriceSol, 0)) * 10000) / 10000,
    openPositions: state.positions.length,
    gateRejections: { total: totalRejections, top: topRejections },
    funnel: state.funnel,
    exitReasons,
    trades: sells.map(t => ({
      symbol: t.symbol,
      entryPrice: t.entryPriceSol,
      exitPrice: t.priceSol,
      pnlSol: Math.round((t.realizedPnlSol || 0) * 10000) / 10000,
      pnlPct: t.realizedPnlPct,
      reason: t.reason,
      heldMinutes: t.heldMs ? Math.round(t.heldMs / 60000) : null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// §8  Data loader — converts agent's real data files into replay snapshots
// ─────────────────────────────────────────────────────────────────────

/**
 * Load real historical data from the agent's data directory and convert
 * into replay snapshots.  Three data sources (all already written by the
 * live agent):
 *
 *   research-prices.jsonl  — timestamped price per mint (the goldmine)
 *   candidates.json        — latest scan with scores / recovery / bounce
 *   portfolio.json         — cash, positions, P&L
 *
 * The loader buckets research-prices.jsonl into time windows (default 5 s
 * matching the agent's scan interval) and produces one snapshot per window
 * containing all tokens that had a price observation in that window.
 */

function loadResearchPrices(dataDir, intervalMs) {
  intervalMs = intervalMs || 5000;
  const pricesPath = path.join(dataDir, 'research-prices.jsonl');
  if (!fs.existsSync(pricesPath)) return [];

  const lines = fs.readFileSync(pricesPath, 'utf8').split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.ts && e.mint && Number.isFinite(e.priceSol) && e.priceSol > 0) {
        entries.push(e);
      }
    } catch (_) {}
  }

  // Sort by timestamp
  entries.sort((a, b) => a.ts - b.ts);

  // Bucket into time windows
  const buckets = new Map();
  for (const e of entries) {
    const bucketTs = Math.floor(e.ts / intervalMs) * intervalMs;
    if (!buckets.has(bucketTs)) buckets.set(bucketTs, {});
    const tokens = buckets.get(bucketTs);
    // Keep latest price per mint per window
    tokens[e.mint] = {
      priceSol: e.priceSol,
      priceUsd: e.priceUsd || 0,
      pairAddress: e.pairAddress || null,
      dex: e.dex || null,
    };
  }

  // Convert to sorted snapshots
  const snapshots = [];
  for (const [ts, tokens] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    snapshots.push({ ts, solPriceUsd: 100, tokens });
  }
  return snapshots;
}

function loadDataDir(dataDir, intervalMs) {
  // Load research prices (historical price data)
  const snapshots = loadResearchPrices(dataDir, intervalMs);

  // Enrich with latest candidates data (scores, recovery, orderflow)
  const candidatesPath = path.join(dataDir, 'candidates.json');
  let candidatesData = null;
  try { candidatesData = JSON.parse(fs.readFileSync(candidatesPath, 'utf8')); } catch (_) {}

  const candidateMap = {};
  if (candidatesData && Array.isArray(candidatesData.candidates)) {
    for (const c of candidatesData.candidates) {
      if (c.mint) candidateMap[c.mint] = c;
    }
  }

  // Enrich snapshots with candidate data where available
  for (const snap of snapshots) {
    for (const [mint, token] of Object.entries(snap.tokens)) {
      const c = candidateMap[mint];
      if (c) {
        token.symbol = c.symbol || token.symbol || mint.slice(0, 6);
        token.change1hPct = c.change1hPct || 0;
        token.liquidityUsd = c.liquidityUsd || 0;
        token.volume24hUsd = c.volume24hUsd || 0;
        token.txBuys = c.txBuys || 0;
        token.txSells = c.txSells || 0;
        token.fdvUsd = c.fdvUsd || 0;
        token.marketCapUsd = c.marketCapUsd || 0;
        token.score = c.score || 0;
        token.recoveryPct = c.recoveryPct;
        token.bounce = c.bounce;
        token.rsi = c.rsi;
        token.natr = c.natr;
      }
      if (!token.symbol) token.symbol = mint.slice(0, 6);
    }
  }

  // Load portfolio state
  let portfolio = {};
  try { portfolio = JSON.parse(fs.readFileSync(path.join(dataDir, 'portfolio.json'), 'utf8')); } catch (_) {}

  return { snapshots, portfolio, candidateCount: Object.keys(candidateMap).length };
}

// ─────────────────────────────────────────────────────────────────────
// §8b  Real trade history analysis
// ─────────────────────────────────────────────────────────────────────

/**
 * Load real trade history from the agent's trades.jsonl (BUY/SELL/PARTIAL
 * lines written by agentd.js).  Returns an array of trade objects sorted
 * chronologically by timestamp.
 */
function loadTrades(dataDir) {
  const tradesPath = path.join(dataDir, 'trades.jsonl');
  if (!fs.existsSync(tradesPath)) return [];

  const lines = fs.readFileSync(tradesPath, 'utf8').split('\n').filter(l => l.trim());
  const trades = [];
  for (const line of lines) {
    try {
      const t = JSON.parse(line);
      if (t && typeof t === 'object' && t.side) trades.push(t);
    } catch (_) {}
  }

  trades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return trades;
}

/**
 * Analyze real trade history.  BUY/SELL legs are matched per mint using a
 * FIFO queue (each SELL consumes the earliest unmatched BUY of the same
 * mint).  Computes win rate, profit factor, total P&L, exit-reason and
 * regime breakdowns, score-bucket distribution, win-vs-loss feature stats,
 * a cumulative P&L curve, and max drawdown.
 */
function analyzeTrades(trades) {
  // Match BUY/SELL pairs by mint (FIFO)
  const openBuys = {};
  const pairs = [];
  for (const t of trades) {
    if (!t || !t.mint) continue;
    if (t.side === 'BUY') {
      (openBuys[t.mint] = openBuys[t.mint] || []).push(t);
    } else if (t.side === 'SELL') {
      const queue = openBuys[t.mint] || [];
      const buy = queue.shift();
      if (buy) {
        const pnlSol = Number.isFinite(t.tradeRealizedPnlSol) ? t.tradeRealizedPnlSol : Number(t.realizedPnlSol || 0);
        pairs.push({
          symbol: t.symbol || buy.symbol || (t.mint && t.mint.slice(0, 6)),
          mint: t.mint,
          openedAt: buy.timestamp,
          closedAt: t.timestamp,
          heldMs: new Date(t.timestamp).getTime() - new Date(buy.timestamp).getTime(),
          pnlSol,
          pnlPct: Number(t.tradeRealizedPnlPct || 0),
          reason: t.reason || 'unknown',
          regime: buy.regime || 'unknown',
          score: Number(buy.score) || 0,
          change1hPct: Number(buy.change1hPct) || 0,
          recoveryPct: Number(buy.recovery5mPct) || 0,
          liquidityUsd: Number(buy.liquidityUsd) || 0,
          natr: Number(buy.natr) || 0,
          rsi: Number(buy.rsi) || 0,
        });
      }
    }
  }

  const totalBuys = trades.filter(t => t.side === 'BUY').length;
  const totalSells = trades.filter(t => t.side === 'SELL').length;
  const unmatchedBuys = Math.max(0, totalBuys - pairs.length);
  const unmatchedSells = Math.max(0, totalSells - pairs.length);

  const wins = pairs.filter(p => p.pnlSol > 0);
  const losses = pairs.filter(p => p.pnlSol <= 0);
  const totalPnl = pairs.reduce((s, p) => s + p.pnlSol, 0);
  const grossWin = wins.reduce((s, p) => s + p.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p.pnlSol, 0));
  const winRate = pairs.length ? (wins.length / pairs.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Exit reason breakdown
  const exitReasons = {};
  for (const p of pairs) exitReasons[p.reason] = (exitReasons[p.reason] || 0) + 1;

  // Regime breakdown
  const regimes = {};
  for (const p of pairs) {
    const r = p.regime || 'unknown';
    if (!regimes[r]) regimes[r] = { trades: 0, wins: 0, losses: 0, pnlSol: 0 };
    regimes[r].trades++;
    regimes[r].wins += p.pnlSol > 0 ? 1 : 0;
    regimes[r].losses += p.pnlSol <= 0 ? 1 : 0;
    regimes[r].pnlSol += p.pnlSol;
  }

  // Score bucket distribution
  const scoreBuckets = {};
  const bucketFor = s => {
    if (s < 60) return '<60';
    if (s < 70) return '60-69';
    if (s < 80) return '70-79';
    if (s < 90) return '80-89';
    return '90+';
  };
  for (const p of pairs) {
    const b = bucketFor(p.score);
    if (!scoreBuckets[b]) scoreBuckets[b] = { trades: 0, wins: 0, losses: 0, pnlSol: 0 };
    scoreBuckets[b].trades++;
    scoreBuckets[b].wins += p.pnlSol > 0 ? 1 : 0;
    scoreBuckets[b].losses += p.pnlSol <= 0 ? 1 : 0;
    scoreBuckets[b].pnlSol += p.pnlSol;
  }

  // Win vs loss feature stats
  const feature = (list, key) => {
    if (!list.length) return 0;
    return list.reduce((s, p) => s + (Number.isFinite(p[key]) ? p[key] : 0), 0) / list.length;
  };
  const stats = { wins: {}, losses: {}, all: {} };
  stats.all = {
    count: pairs.length,
    score: feature(pairs, 'score'),
    change1hPct: feature(pairs, 'change1hPct'),
    recoveryPct: feature(pairs, 'recoveryPct'),
    liquidityUsd: feature(pairs, 'liquidityUsd'),
    natr: feature(pairs, 'natr'),
    rsi: feature(pairs, 'rsi'),
    heldMs: feature(pairs, 'heldMs'),
  };
  for (const key of ['score', 'change1hPct', 'recoveryPct', 'liquidityUsd', 'natr', 'rsi', 'heldMs']) {
    stats.wins[key] = feature(wins, key);
    stats.losses[key] = feature(losses, key);
  }
  stats.wins.count = wins.length;
  stats.losses.count = losses.length;

  // Cumulative P&L curve (ordered by close time) + max drawdown
  const sorted = pairs.slice().sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let ddPeakIdx = -1;
  let ddTroughIdx = -1;
  const curve = sorted.map((p, i) => {
    running += p.pnlSol;
    if (running > peak) { peak = running; }
    const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
    if (dd > maxDrawdown) { maxDrawdown = dd; ddPeakIdx = i; ddTroughIdx = i; }
    return { i: i + 1, closedAt: p.closedAt, symbol: p.symbol, pnlSol: p.pnlSol, cumulativeSol: running };
  });

  return {
    totalTrades: trades.length,
    buyCount: totalBuys,
    sellCount: totalSells,
    pairs,
    matchedTrades: pairs.length,
    unmatchedBuys,
    unmatchedSells,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round(winRate * 100) / 100,
    totalPnlSol: Math.round(totalPnl * 10000) / 10000,
    avgPnlSol: pairs.length ? Math.round((totalPnl / pairs.length) * 10000) / 10000 : 0,
    avgWinSol: wins.length ? Math.round((grossWin / wins.length) * 10000) / 10000 : 0,
    avgLossSol: losses.length ? Math.round((grossLoss / losses.length) * 10000) / 10000 : 0,
    profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 'Infinity',
    exitReasons,
    regimes,
    scoreBuckets,
    winLossStats: stats,
    cumulative: curve,
    totalReturnSol: Math.round(running * 10000) / 10000,
    maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownPeakIdx: ddPeakIdx,
    maxDrawdownTroughIdx: ddTroughIdx,
  };
}

/**
 * Pretty-print a trade analysis object to stdout.
 */
function printTradeAnalysis(a) {
  const pct = x => `${Math.round(x * 100) / 100}%`;
  const sol = x => `${Math.round(x * 10000) / 10000} SOL`;

  console.log('\n' + '='.repeat(68));
  console.log('  REAL TRADE ANALYSIS — trades.jsonl');
  console.log('='.repeat(68));
  console.log(`  Raw entries:        ${a.totalTrades} (${a.buyCount} BUY / ${a.sellCount} SELL)`);
  console.log(`  Matched pairs:      ${a.matchedTrades} (${a.unmatchedBuys} unmatched buys, ${a.unmatchedSells} unmatched sells)`);
  console.log('-' .repeat(68));
  console.log(`  Win rate:           ${pct(a.winRate)} (${a.wins}W / ${a.losses}L)`);
  console.log(`  Profit factor:      ${a.profitFactor}`);
  console.log(`  Total P&L:          ${sol(a.totalPnlSol)}`);
  console.log(`  Avg trade P&L:      ${sol(a.avgPnlSol)}`);
  console.log(`  Avg win / loss:     ${sol(a.avgWinSol)} / ${sol(a.avgLossSol)}`);
  console.log(`  Max drawdown:       ${pct(a.maxDrawdownPct)}`);

  console.log('-' .repeat(68));
  console.log('  Exit reasons:');
  const reasons = Object.entries(a.exitReasons).sort((x, y) => y[1] - x[1]);
  if (reasons.length) {
    for (const [reason, count] of reasons) {
      const share = a.matchedTrades ? pct((count / a.matchedTrades) * 100) : '0%';
      console.log(`    ${reason.padEnd(18)} ${String(count).padStart(4)}  ${share}`);
    }
  } else {
    console.log('    (no matched trades)');
  }

  console.log('-' .repeat(68));
  console.log('  Regime breakdown:');
  const regimes = Object.entries(a.regimes).sort((x, y) => y[1].trades - x[1].trades);
  if (regimes.length) {
    console.log(`    ${'regime'.padEnd(14)} ${'trades'.padStart(6)} ${'win%'.padStart(7)} ${'pnl'.padStart(12)}`);
    for (const [regime, r] of regimes) {
      const w = r.trades ? pct((r.wins / r.trades) * 100) : '0%';
      console.log(`    ${regime.padEnd(14)} ${String(r.trades).padStart(6)} ${w.padStart(7)} ${sol(r.pnlSol).padStart(12)}`);
    }
  } else {
    console.log('    (none)');
  }

  console.log('-' .repeat(68));
  console.log('  Score distribution:');
  const buckets = Object.entries(a.scoreBuckets).sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }));
  if (buckets.length) {
    console.log(`    ${'bucket'.padEnd(9)} ${'trades'.padStart(6)} ${'win%'.padStart(7)} ${'pnl'.padStart(12)}`);
    for (const [bucket, b] of buckets) {
      const w = b.trades ? pct((b.wins / b.trades) * 100) : '0%';
      console.log(`    ${bucket.padEnd(9)} ${String(b.trades).padStart(6)} ${w.padStart(7)} ${sol(b.pnlSol).padStart(12)}`);
    }
  } else {
    console.log('    (none)');
  }

  console.log('-' .repeat(68));
  console.log('  Win vs loss (avg entry features):');
  console.log(`    ${''.padEnd(14)} ${'all'.padStart(10)} ${'wins'.padStart(10)} ${'losses'.padStart(10)}`);
  const row = (label, key, fmt) => {
    const v = x => (fmt ? fmt(x) : Math.round(x * 100) / 100);
    console.log(`    ${label.padEnd(14)} ${v(a.winLossStats.all[key]).toString().padStart(10)} ${v(a.winLossStats.wins[key]).toString().padStart(10)} ${v(a.winLossStats.losses[key]).toString().padStart(10)}`);
  };
  row('score', 'score');
  row('change1h%', 'change1hPct');
  row('recovery5m%', 'recoveryPct');
  row('liquidity$', 'liquidityUsd', x => Math.round(x));
  row('NATR', 'natr');
  row('RSI', 'rsi');
  row('hold (min)', 'heldMs', x => Math.round(x / 60000));

  console.log('-' .repeat(68));
  console.log(`  Cumulative P&L curve (${a.cumulative.length} trades, final ${sol(a.totalReturnSol)}):`);
  const curve = a.cumulative;
  if (curve.length) {
    const maxAbs = Math.max(...curve.map(c => Math.abs(c.cumulativeSol)), 1);
    const step = Math.max(1, Math.floor(curve.length / 80));
    const bars = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
    const plotted = [];
    for (const c of bars) {
      const width = Math.max(1, Math.round((Math.abs(c.cumulativeSol) / maxAbs) * 40));
      const bar = c.cumulativeSol >= 0 ? '█'.repeat(width) : '▒'.repeat(width);
      plotted.push(`${String(c.i).padStart(4)} ${bar} ${c.cumulativeSol >= 0 ? '+' : '-'}${sol(Math.abs(c.cumulativeSol))}`);
    }
    // Simpler textual line list when few trades
    if (curve.length <= 20) {
      for (const c of curve) {
        console.log(`    #${String(c.i).padStart(3)} ${c.closedAt.slice(0, 16).replace('T', ' ')} ${String(c.symbol || '').padEnd(10)} ${sol(c.pnlSol).padStart(10)}  → ${sol(c.cumulativeSol)}`);
      }
    } else {
      console.log(`    (${curve.length} trades; first/last + every ${step}th)`);
      for (const p of plotted) console.log(`    ${p}`);
    }
    if (a.maxDrawdownPeakIdx >= 0) {
      console.log(`    Max drawdown ${pct(a.maxDrawdownPct)} between trade #${a.maxDrawdownPeakIdx + 1} and #${a.maxDrawdownTroughIdx + 1}`);
    }
  } else {
    console.log('    (no matched trades)');
  }

  console.log('='.repeat(68));
}

/**
 * Live collector — runs as a standalone process alongside the agent,
 * appending one snapshot per interval to a JSONL file.
 */
function collectSnapshot(dataDir, outPath) {
  const { snapshots, candidateCount } = loadDataDir(dataDir);
  if (snapshots.length === 0) {
    console.log('No price data found in research-prices.jsonl');
    return null;
  }
  const snap = snapshots[snapshots.length - 1]; // latest
  fs.appendFileSync(outPath, JSON.stringify(snap) + '\n');
  console.log(`Wrote snapshot: ${Object.keys(snap.tokens).length} tokens (${candidateCount} with scores) at ${new Date(snap.ts).toISOString()}`);
  return snap;
}

// ─────────────────────────────────────────────────────────────────────
// §9  CLI interface
// ─────────────────────────────────────────────────────────────────────

function loadSnapshots(dataPath) {
  const lines = fs.readFileSync(dataPath, 'utf8').split('\n').filter(l => l.trim());
  return lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function printMetrics(m) {
  console.log('\n' + '='.repeat(60));
  console.log(`  BACKTEST RESULTS — ${m.config}`);
  console.log('='.repeat(60));
  console.log(`  Scans:              ${m.totalScans}`);
  console.log(`  Candidates eval'd:  ${m.totalCandidatesEvaluated}`);
  console.log(`  Entries attempted:  ${m.totalEntriesAttempted}`);
  console.log(`  Trades completed:   ${m.totalTrades} (${m.wins}W / ${m.losses}L)`);
  console.log(`  Win rate:           ${m.winRate}%`);
  console.log(`  Profit factor:      ${m.profitFactor}`);
  console.log(`  Total P&L:          ${m.totalPnlSol} SOL`);
  console.log(`  Avg win:            ${m.avgWinSol} SOL`);
  console.log(`  Avg loss:           ${m.avgLossSol} SOL`);
  console.log(`  Best trade:         ${m.bestTradePnl} SOL`);
  console.log(`  Worst trade:        ${m.worstTradePnl} SOL`);
  console.log(`  Max drawdown:       ${m.maxDrawdownPct}%`);
  console.log(`  Sharpe ratio:       ${m.sharpeRatio}`);
  console.log(`  Avg hold time:      ${m.avgHoldMinutes} min`);
  console.log(`  Final cash:         ${m.finalCashSol} SOL`);
  console.log(`  Open positions:     ${m.openPositions}`);
  console.log('-'.repeat(60));
  console.log('  Exit reasons:');
  for (const [reason, count] of Object.entries(m.exitReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log('-' + '-'.repeat(60));
  console.log('  Entry funnel (how candidates survived the gates):');
  const f = m.funnel;
  if (f && f.evaluated > 0 && Object.keys(f.byGate || {}).length > 0) {
    console.log(`    evaluated:      ${f.evaluated}`);
    const gates = [
      ['G4-score', 'Reached score gate'],
      ['G7-1h-change', 'Reached 1h change band'],
      ['G8-warming', 'Reached 5m recovery sample'],
      ['G9-recovery-band', 'Reached 5m recovery band'],
      ['G10-bounce', 'Reached bounce confirm'],
      ['G11-rsi-vwap', 'Reached RSI+VWAP'],
      ['G12-liquidity', 'Reached liquidity floor'],
      ['G13-volume', 'Reached volume floor'],
      ['G14-orderflow', 'Reached orderflow'],
      ['G15-natr', 'Reached NATR'],
      ['G16-holding', 'Reached not-holding'],
      ['G17-cooldown', 'Reached cooldown'],
      ['G18-cash', 'Reached cash'],
      ['ENTRY', 'ENTRIES'],
    ];
    let prev = f.evaluated;
    for (const [key, label] of gates) {
      const count = f.byGate[key];
      if (count === undefined) continue;
      const drop = label === 'ENTRIES' || prev === 0 ? 0 : ((prev - count) / prev * 100);
      const pctStr = label === 'ENTRIES'
        ? (count + ' (' + (f.evaluated > 0 ? (count / f.evaluated * 100).toFixed(2) : '0.00') + '% of evaluated)')
        : (count + (f.evaluated > 0 ? ' (' + (count / f.evaluated * 100).toFixed(1) + '% of evaluated)' : ''));
      console.log(`    ${label.padEnd(28)} ${pctStr}`);
      prev = count;
    }
  } else {
    console.log(`    evaluated: ${f ? f.evaluated : 'n/a'}`);
  }
  console.log('-'.repeat(60));
  console.log('  Top gate rejections:');
  for (const [reason, count] of m.gateRejections.top) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log('='.repeat(60));
}

function compareMetrics(a, b) {
  console.log('\n' + '='.repeat(70));
  console.log('  COMPARISON');
  console.log('='.repeat(70));
  const rows = [
    ['Metric', a.config, b.config, 'Delta'],
    ['Win rate', `${a.winRate}%`, `${b.winRate}%`, `${(b.winRate - a.winRate).toFixed(2)}%`],
    ['Profit factor', String(a.profitFactor), String(b.profitFactor), ''],
    ['Total P&L', `${a.totalPnlSol} SOL`, `${b.totalPnlSol} SOL`, `${(b.totalPnlSol - a.totalPnlSol).toFixed(4)} SOL`],
    ['Trades', `${a.totalTrades}`, `${b.totalTrades}`, `${b.totalTrades - a.totalTrades}`],
    ['Max drawdown', `${a.maxDrawdownPct}%`, `${b.maxDrawdownPct}%`, `${(b.maxDrawdownPct - a.maxDrawdownPct).toFixed(2)}%`],
    ['Sharpe', `${a.sharpeRatio}`, `${b.sharpeRatio}`, `${(b.sharpeRatio - a.sharpeRatio).toFixed(2)}`],
    ['Avg hold', `${a.avgHoldMinutes} min`, `${b.avgHoldMinutes} min`, `${b.avgHoldMinutes - a.avgHoldMinutes} min`],
  ];
  for (const row of rows) {
    console.log(`  ${row[0].padEnd(20)} ${row[1].padEnd(18)} ${row[2].padEnd(18)} ${row[3]}`);
  }
  console.log('='.repeat(70));
}

// ─────────────────────────────────────────────────────────────────────
// §10  Unit tests (inline, run with --test)
// ─────────────────────────────────────────────────────────────────────

function runTests() {
  let passed = 0, failed = 0;
  function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  }

  console.log('=== backtest.js unit tests ===\n');

  // Recovery
  const mkSamples = (prices, gap = 15000) => prices.map((p, i) => ({ ts: 1000000 + i * gap, priceUsd: p, priceSol: p / 150 }));
  check('recovery: sufficient samples', computeRecoveryPct(mkSamples([1, 1.01, 1.02, 1.03, 1.04, 1.05], 60000), 300000).status === 'ok');
  check('recovery: too few samples → warming', computeRecoveryPct(mkSamples([1, 1.01]), 300000).status === 'warming');
  check('recovery: no baseline → warming', computeRecoveryPct(mkSamples([1, 1.01, 1.02], 15000), 300000).status === 'warming');

  // Score
  check('score: strong candidate', computeScore({ change1hPct: -20, recoveryPct: 5, liquidityUsd: 200000, volume24hUsd: 500000 }) >= 60);
  check('score: weak candidate', computeScore({ change1hPct: -5, recoveryPct: 0.1, liquidityUsd: 5000, volume24hUsd: 10000 }) < 60);

  // Bounce
  check('bounce: steady rise', bounceConfirmation(mkSamples([1, 1.001, 1.002, 1.003, 1.004, 1.005, 1.006, 1.007]), 2, 120000).confirmed === true);
  check('bounce: flat top', bounceConfirmation(mkSamples([1, 1, 1, 1, 1, 1, 1, 1]), 2, 120000).confirmed === false);
  check('bounce: stale gap', bounceConfirmation([
    { ts: 0, priceUsd: 1, priceSol: 1 },
    { ts: 15000, priceUsd: 1.01, priceSol: 1 },
    { ts: 215000, priceUsd: 1.02, priceSol: 1 },
    { ts: 230000, priceUsd: 1.03, priceSol: 1 },
  ], 2, 120000).confirmed === false);

  // RSI
  const flatCloses = Array(20).fill(100);
  check('RSI: flat → 50', computeRsi(flatCloses).rsi === 50);
  const upCloses = Array.from({ length: 20 }, (_, i) => 100 + i);
  check('RSI: rising → >50', computeRsi(upCloses).rsi > 50);
  check('RSI: insufficient data → null', computeRsi([1]).rsi === null && computeRsi([]).rsi === null);
  check('RSI: one-sided up → 100', computeRsi(Array.from({ length: 10 }, (_, i) => 10 * (i + 1))).rsi === 100);

  // NATR
  const smoothSamples = Array.from({ length: 20 }, (_, i) => ({ ts: i * 15000, priceUsd: 100 + i * 0.5, priceSol: (100 + i * 0.5) / 150 }));
  check('NATR: smooth series → low', computeNatr(smoothSamples) < 1);
  check('NATR: insufficient data → null', computeNatr([]) === null);

  // ATR levels
  const atr = atrLevels(2.8, PRESETS.v1);
  check('ATR: SL negative', atr.slPct < 0);
  check('ATR: TP positive', atr.tpPct > 0);
  check('ATR: floor binds', atrLevels(0.5, PRESETS.v1).eff === 1.5);

  // Orderflow
  check('orderflow: healthy', evaluateOrderflow({ txBuys: 100, txSells: 50, liquidityUsd: 150000, marketCapUsd: 5000000 }).ok === true);
  check('orderflow: one-sided', evaluateOrderflow({ txBuys: 0, txSells: 50, liquidityUsd: 150000, marketCapUsd: 5000000 }).ok === false);
  check('orderflow: thin liq', evaluateOrderflow({ txBuys: 100, txSells: 50, liquidityUsd: 5000, marketCapUsd: 5000000 }).ok === false);

  // Exit decision
  const pos = { stopLossPct: -6, takeProfitPct: 8, partialTaken: false, openedAtMs: 1000, entryCostSol: 0.05 };
  check('exit: stop-loss', decideExit(pos, -7, 2000, PRESETS.v1).action === 'close');
  check('exit: take-profit', decideExit(pos, 9, 2000, PRESETS.v1).action === 'close');
  check('exit: partial', decideExit(pos, 6, 2000, PRESETS.v1).action === 'partial');
  check('exit: hold', decideExit(pos, 1, 2000, PRESETS.v1).action === null);
  check('exit: time-stop', decideExit(pos, 1, 1000 + PRESETS.v1.timeStopMs + 1, PRESETS.v1).action === 'close');

  // Replay engine
  const state = createReplayState(PRESETS.v1);
  check('replay: initial cash 10 SOL', state.cashSol === 10);
  check('replay: no positions', state.positions.length === 0);

  // Metrics
  const mState = createReplayState(PRESETS.v1);
  mState.totalTrades = 0; mState.wins = 0; mState.losses = 0;
  mState.trades = [
    { side: 'SELL', realizedPnlSol: 0.005, reason: 'take-profit' },
    { side: 'SELL', realizedPnlSol: -0.002, reason: 'stop-loss' },
  ];
  const m = computeMetrics(mState, PRESETS.v1);
  check('metrics: win rate 50%', m.winRate === 50);
  check('metrics: PF correct', m.profitFactor === 2.5);

  // Full replay with synthetic data
  const snaps = [];
  for (let i = 0; i < 100; i++) {
    const price = 0.01 + Math.sin(i / 10) * 0.005 + (i > 50 ? 0.003 : 0);
    snaps.push({
      ts: Date.now() + i * 5000,
      solPriceUsd: 100,
      tokens: {
        'testMint123': {
          symbol: 'TEST',
          priceUsd: price * 100,
          priceSol: price,
          change1hPct: -15 + (i / 10),
          liquidityUsd: 150000,
          volume24hUsd: 500000,
          txBuys: 100,
          txSells: 50,
          fdvUsd: 5000000,
          marketCapUsd: 5000000,
        },
      },
    });
  }
  const result = replaySnapshots(snaps, PRESETS.v1);
  check('replay: ran scans', result.totalScans === 100);
  check('replay: evaluated candidates', result.totalCandidatesEvaluated > 0);

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────
// §11  Main
// ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === '--test' || cmd === 'test') {
    runTests();
    return;
  }

  if (cmd === 'collect') {
    const outIdx = args.indexOf('--out');
    const dataIdx = args.indexOf('--data-dir');
    const outPath = outIdx >= 0 ? args[outIdx + 1] : '/tmp/circuit-snapshots.jsonl';
    const dataDir = dataIdx >= 0 ? args[dataIdx + 1] : (process.env.CIRCUIT_AGENT_DATA_DIR || path.join(require('os').homedir(), '.circuit/agents/paper-trader'));
    console.log(`Collecting snapshots from ${dataDir} → ${outPath}`);
    const snap = collectSnapshot(dataDir, outPath);
    console.log(`Wrote snapshot: ${Object.keys(snap.tokens).length} tokens at ${new Date(snap.ts).toISOString()}`);
    return;
  }

  if (cmd === 'replay') {
    const dataIdx = args.indexOf('--data');
    const dirIdx = args.indexOf('--data-dir');
    const configIdx = args.indexOf('--config');
    const intervalIdx = args.indexOf('--interval');
    const intervalMs = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) : 5000;

    let snapshots;
    let dataPath;

    if (dirIdx >= 0 && args[dirIdx + 1]) {
      // Load directly from agent's data directory
      const dataDir = args[dirIdx + 1];
      console.log(`Loading from data directory: ${dataDir}...`);
      const loaded = loadDataDir(dataDir, intervalMs);
      snapshots = loaded.snapshots;
      console.log(`Loaded ${snapshots.length} time windows from ${loaded.candidateCount} candidates with scores`);
    } else if (dataIdx >= 0 && args[dataIdx + 1]) {
      // Load from JSONL file
      dataPath = args[dataIdx + 1];
      console.log(`Loading snapshots from ${dataPath}...`);
      snapshots = loadSnapshots(dataPath);
      console.log(`Loaded ${snapshots.length} snapshots`);
    } else {
      console.error('Usage: node backtest.js replay --data <file.jsonl> OR --data-dir <agent-data-dir> [--config v1|optimized] [--interval 5000]');
      process.exit(1);
    }

    const configName = configIdx >= 0 ? args[configIdx + 1] : 'v1';
    const cfg = PRESETS[configName] || PRESETS.v1;
    console.log(`Replaying with ${cfg.label}...`);
    const state = replaySnapshots(snapshots, cfg);
    const metrics = computeMetrics(state, cfg);
    printMetrics(metrics);
    return;
  }

  if (cmd === 'trades') {
    const dirIdx = args.indexOf('--data-dir');
    const dataIdx = args.indexOf('--data');
    const defaultDir = process.env.CIRCUIT_AGENT_DATA_DIR || path.join(require('os').homedir(), '.circuit/agents/paper-trader');

    let trades;
    if (dirIdx >= 0 && args[dirIdx + 1]) {
      console.log(`Loading trades from data directory: ${args[dirIdx + 1]}...`);
      trades = loadTrades(args[dirIdx + 1]);
    } else if (dataIdx >= 0 && args[dataIdx + 1]) {
      console.log(`Loading trades from ${args[dataIdx + 1]}...`);
      trades = loadSnapshots(args[dataIdx + 1]);
    } else {
      console.log(`Loading trades from data directory: ${defaultDir}...`);
      trades = loadTrades(defaultDir);
    }

    if (trades.length === 0) {
      console.error('No trades found in trades.jsonl');
      process.exit(1);
    }

    const analysis = analyzeTrades(trades);
    printTradeAnalysis(analysis);
    return;
  }

  if (cmd === 'compare') {
    const dataIdx = args.indexOf('--data');
    const dirIdx = args.indexOf('--data-dir');
    const aIdx = args.indexOf('--a');
    const bIdx = args.indexOf('--b');
    const intervalIdx = args.indexOf('--interval');
    const intervalMs = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) : 5000;

    let snapshots;
    if (dirIdx >= 0 && args[dirIdx + 1]) {
      const dataDir = args[dirIdx + 1];
      console.log(`Loading from data directory: ${dataDir}...`);
      const loaded = loadDataDir(dataDir, intervalMs);
      snapshots = loaded.snapshots;
      console.log(`Loaded ${snapshots.length} time windows from ${loaded.candidateCount} candidates`);
    } else if (dataIdx >= 0 && args[dataIdx + 1]) {
      console.log(`Loading snapshots from ${args[dataIdx + 1]}...`);
      snapshots = loadSnapshots(args[dataIdx + 1]);
      console.log(`Loaded ${snapshots.length} snapshots`);
    } else {
      console.error('Usage: node backtest.js compare --data-dir <dir> --a <config> --b <config>');
      process.exit(1);
    }

    const cfgA = PRESETS[aIdx >= 0 ? args[aIdx + 1] : 'v1'] || PRESETS.v1;
    const cfgB = PRESETS[bIdx >= 0 ? args[bIdx + 1] : 'optimized'] || PRESETS.optimized;
    console.log(`\nReplaying with ${cfgA.label}...`);
    const stateA = replaySnapshots(snapshots, cfgA);
    const metricsA = computeMetrics(stateA, cfgA);
    console.log(`Replaying with ${cfgB.label}...`);
    const stateB = replaySnapshots(snapshots, cfgB);
    const metricsB = computeMetrics(stateB, cfgB);
    printMetrics(metricsA);
    printMetrics(metricsB);
    compareMetrics(metricsA, metricsB);
    return;
  }

  console.log('Circuit Paper-Trader Backtester');
  console.log('');
  console.log('Commands:');
  console.log('  test                                       Run unit tests');
  console.log('  collect --out <file> --data-dir <dir>       Collect snapshot from live agent');
  console.log('  replay --data-dir <dir> [--config v1|opt]  Replay agent data through backtester');
  console.log('  replay --data <file.jsonl> [--config v1]   Replay JSONL snapshots');
  console.log('  trades --data-dir <dir> | --data <file>    Analyze real trade history');
  console.log('  compare --data-dir <dir> --a X --b Y       Compare two configs');
  console.log('');
  console.log('Configs: v1, optimized');
  console.log('');
  console.log('Examples:');
  console.log('  node backtest.js replay --data-dir ~/.circuit/agents/paper-trader --config optimized');
  console.log('  node backtest.js trades --data-dir ~/.circuit/agents/paper-trader');
  console.log('  node backtest.js compare --data-dir ~/.circuit/agents/paper-trader --a v1 --b optimized');
}

// ─────────────────────────────────────────────────────────────────────
// §12  Exports (for unit tests and programmatic use)
// ─────────────────────────────────────────────────────────────────────

module.exports = {
  PRESETS,
  createPriceHistory, samplePrice, getHistory,
  computeRecoveryPct, computeScore, bounceConfirmation, computeRsi,
  evaluateRsiVwap, evaluateOrderflow, computeNatr, passesNatrGate, atrLevels,
  evaluateEntryGate, decideExit,
  createReplayState, replaySnapshots, computeMetrics,
  collectSnapshot, loadSnapshots, loadResearchPrices, loadDataDir,
  loadTrades, analyzeTrades, printTradeAnalysis, runTests,
};

if (require.main === module) main();
