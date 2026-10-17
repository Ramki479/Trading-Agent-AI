#!/usr/bin/env node
/**
 * performance-analyzer.js — deterministic performance metrics for the paper
 * trader's adaptive intelligence layer.
 *
 * Pure functions over the append-only trades ledger (trades.jsonl). No I/O,
 * no state, no Math.random(). Everything derives from REAL observed trade
 * data. Used by:
 *   - regime-detector.js   (win rate / expectancy / streaks → regime)
 *   - learned-gates.js     (per-cluster outcomes → gate thresholds)
 *   - adaptive-policy.js   (loss streaks, drawdown → session policy)
 *   - reflection-engine.js (grading, lessons, snapshots)
 *   - strategy-experiments.js (backtest + shadow evaluation)
 *
 * Ledger row conventions (written by agentd.js):
 *   BUY : { side, timestamp, mint, symbol, price, valueSol, score,
 *           change1hPct, recovery5mPct, liquidityUsd?, volume24hUsd? }
 *   SELL: { side, timestamp, mint, symbol, price, valueSol,
 *           realizedPnlSol, realizedPnlPct, reason, entryPriceSol, costSol }
 *   Partial SELL (reason 'partial-take', partial: true): a banked fill of an
 *     open lot — aggregated into the trade, never a close by itself. A final
 *     (non-partial) SELL may carry tradeRealizedPnlSol/Pct (combined).
 *
 * A "closed trade" is a BUY followed by the next SELL of the same mint in
 * ledger order. Open positions (BUY without SELL yet) are excluded from
 * outcome metrics but can be inspected separately.
 */

'use strict';

const MS_MIN = 60000;
const MS_DAY = 24 * 3600 * 1000;

function round(n, digits = 6) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function num(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/** Hour-of-day bucket (UTC) used for clustering: morning/afternoon/evening/night. */
function timeOfDayOf(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const h = d.getUTCHours();
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 24) return 'evening';
  return 'night';
}

/** Liquidity class from a USD liquidity value: high/medium/low. */
function liqClassOf(liquidityUsd) {
  const v = num(liquidityUsd);
  if (v == null || v <= 0) return 'medium'; // unknown → neutral default
  if (v >= 100000) return 'high';
  if (v >= 20000) return 'medium';
  return 'low';
}

/**
 * Pair BUY/SELL ledger rows into closed trades.
 * Partial fills (SELL rows with `partial: true`, reason 'partial-take')
 * accumulate into their lot: a closed trade spans BUY → all following SELLs
 * up to and including the first NON-partial SELL (the final close), with
 * combined economics (sum of realized legs over the BUY value). Lots with
 * only partials so far count as open (banked partial noted).
 * Legacy ledgers (no partial flags) pair exactly as before.
 * Returns array of:
  *   { mint, symbol, entryTs, exitTs, heldMs, entryScore, change1hPct,
 *     recovery5mPct, liquidityUsd, volume24hUsd, entryPriceSol, exitPriceSol,
 *     realizedPnlSol, realizedPnlPct, exitReason, timeOfDay, liqClass, won,
 *     partialLegs, rsi, regime, entryMinScore }
 * Sorted by exitTs ascending. BUYs without a following final SELL are returned
 * in `open` (with their entry metadata).
 */
function pairTrades(ledgerRows) {
  const closed = [];
  const open = [];
  const pendingByMint = new Map(); // mint -> { buy, partialSol, partialLegs }
  const rows = (Array.isArray(ledgerRows) ? ledgerRows : []).slice();

  // Normalize + sort by timestamp (stable for equal timestamps).
  rows.sort((a, b) => {
    const ta = Date.parse(a.timestamp) || 0;
    const tb = Date.parse(b.timestamp) || 0;
    return ta - tb;
  });

  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const side = String(r.side || '').toUpperCase();
    if (side === 'BUY') {
      // A new BUY for a mint that still has an open BUY means the previous
      // one was never sold (shouldn't happen in practice) — keep only the
      // latest BUY as the open position.
      pendingByMint.set(r.mint, { buy: r, partialSol: 0, partialLegs: 0 });
    } else if (side === 'SELL') {
      const lot = pendingByMint.get(r.mint);
      if (!lot) continue; // SELL without BUY (e.g. legacy) → ignore
      const buy = lot.buy;
      if (r.partial === true) {
        // Banked fill — not a close. Accumulate for the combined outcome.
        const ps = num(r.realizedPnlSol);
        if (ps != null) lot.partialSol += ps;
        lot.partialLegs += 1;
        continue;
      }
      pendingByMint.delete(r.mint);
      const entryTs = Date.parse(buy.timestamp) || 0;
      const exitTs = Date.parse(r.timestamp) || 0;
      const legSol = num(r.realizedPnlSol);
      const legPct = num(r.realizedPnlPct);
      if (legSol == null || legPct == null) continue; // needs a real outcome
      // Combined economics: prefer the agent-recorded trade totals when the
      // final row carries them, else sum banked partials + final leg over the
      // BUY value (identical to the leg for legacy single-fill trades).
      const buyValue = num(buy.valueSol);
      let pnlSol = legSol + lot.partialSol;
      let pnlPct = (buyValue != null && buyValue !== 0)
        ? (pnlSol / buyValue) * 100 : legPct;
      const tSol = num(r.tradeRealizedPnlSol);
      const tPct = num(r.tradeRealizedPnlPct);
      if (tSol != null) pnlSol = tSol;
      if (tPct != null) pnlPct = tPct;
      closed.push({
        mint: buy.mint,
        symbol: buy.symbol || r.symbol,
        entryTs,
        exitTs,
        heldMs: Math.max(0, exitTs - entryTs),
        entryScore: num(buy.score),
        change1hPct: num(buy.change1hPct),
        recovery5mPct: num(buy.recovery5mPct),
        liquidityUsd: num(buy.liquidityUsd),
        volume24hUsd: num(buy.volume24hUsd),
        entryPriceSol: num(buy.price),
        exitPriceSol: num(r.price),
        realizedPnlSol: pnlSol,
        realizedPnlPct: pnlPct,
        exitReason: r.reason || 'unknown',
        timeOfDay: timeOfDayOf(entryTs),
        liqClass: liqClassOf(buy.liquidityUsd),
        won: pnlSol > 0,
        partialLegs: lot.partialLegs,
        rsi: num(buy.rsi),
        regime: (buy.regime != null && buy.regime !== '') ? buy.regime : null,
        entryMinScore: num(buy.entryMinScore)
      });
    }
  }
  for (const lot of pendingByMint.values()) {
    const buy = lot.buy;
    open.push({
      mint: buy.mint,
      symbol: buy.symbol,
      entryTs: Date.parse(buy.timestamp) || 0,
      entryScore: num(buy.score),
      change1hPct: num(buy.change1hPct),
      recovery5mPct: num(buy.recovery5mPct),
      liquidityUsd: num(buy.liquidityUsd),
      volume24hUsd: num(buy.volume24hUsd),
      timeOfDay: timeOfDayOf(Date.parse(buy.timestamp) || 0),
      liqClass: liqClassOf(buy.liquidityUsd),
      bankedPartialSol: lot.partialSol,
      partialLegs: lot.partialLegs
    });
  }
  closed.sort((a, b) => a.exitTs - b.exitTs);
  return { closed, open };
}

/** Keep only trades whose exit is at/after `sinceMs` (default: all). */
function since(trades, sinceMs) {
  if (!sinceMs) return trades;
  return trades.filter((t) => t.exitTs >= sinceMs);
}

/**
 * Core metrics over closed trades.
 * Returns { n, wins, losses, winRate, avgWinSol, avgLossSol, expectancySol,
 *           expectancyPct, profitFactor, bestSol, worstSol, avgHoldMin,
 *           maxDrawdownSol, maxDrawdownPct, lossStreak, winStreak, currentStreak,
 *           totalPnlSol, sumWinSol, sumLossSol }
 * Drawdown is computed from the cumulative realized-equity curve starting at
 * `startingCapital` (0 defaults to the first trade's starting point).
 */
function computeMetrics(trades, startingCapital = 0) {
  const t = Array.isArray(trades) ? trades : [];
  if (!t.length) {
    return {
      n: 0, wins: 0, losses: 0, winRate: 0, avgWinSol: 0, avgLossSol: 0,
      expectancySol: 0, expectancyPct: 0, profitFactor: 0, bestSol: 0,
      worstSol: 0, avgHoldMin: 0, maxDrawdownSol: 0, maxDrawdownPct: 0,
      lossStreak: 0, winStreak: 0, currentStreak: 0, totalPnlSol: 0,
      sumWinSol: 0, sumLossSol: 0
    };
  }

  let wins = 0, losses = 0, sumWin = 0, sumLoss = 0, holdMs = 0;
  let best = -Infinity, worst = Infinity;
  let lossStreak = 0, winStreak = 0, curLoss = 0, curWin = 0;
  let equity = startingCapital || 0;
  let peak = equity;
  let maxDd = 0;
  let maxDdPct = 0;

  for (const tr of t) {
    const pnl = num(tr.realizedPnlSol) || 0;
    const pct = num(tr.realizedPnlPct) || 0;
    if (pnl > 0) { wins += 1; sumWin += pnl; curWin += 1; curLoss = 0; }
    else { losses += 1; sumLoss += pnl; curLoss += 1; curWin = 0; }
    lossStreak = Math.max(lossStreak, curLoss);
    winStreak = Math.max(winStreak, curWin);
    best = Math.max(best, pnl);
    worst = Math.min(worst, pnl);
    holdMs += tr.heldMs || 0;

    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0) {
      // Drawdown % is relative to the running peak. Cap at 100: when no
      // starting capital is passed the equity curve starts at 0, so a
      // deep loss run pushes equity negative and (peak-equity)/peak can
      // explode to absurd values (e.g. -832%). 100% is the display max.
      const ddPct = Math.min(100, ((peak - equity) / peak) * 100);
      if (ddPct > maxDdPct) maxDdPct = ddPct;
    }
  }

  const n = t.length;
  const winRate = n ? (wins / n) * 100 : 0;
  const avgWinSol = wins ? sumWin / wins : 0;
  const avgLossSol = losses ? sumLoss / losses : 0;
  const expectancySol = n ? (sumWin + sumLoss) / n : 0;
  const expectancyPct = n ? t.reduce((s, tr) => s + (num(tr.realizedPnlPct) || 0), 0) / n : 0;
  const profitFactor = sumLoss !== 0 ? sumWin / Math.abs(sumLoss) : (sumWin > 0 ? Infinity : 0);

  return {
    n,
    wins,
    losses,
    winRate: round(winRate, 2),
    avgWinSol: round(avgWinSol, 8),
    avgLossSol: round(avgLossSol, 8),
    expectancySol: round(expectancySol, 8),
    expectancyPct: round(expectancyPct, 4),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 4) : (profitFactor === Infinity ? Infinity : 0),
    bestSol: round(best === -Infinity ? 0 : best, 8),
    worstSol: round(worst === Infinity ? 0 : worst, 8),
    avgHoldMin: round(n ? holdMs / n / MS_MIN : 0, 1),
    maxDrawdownSol: round(maxDd, 8),
    maxDrawdownPct: round(maxDdPct, 4),
    lossStreak,
    winStreak,
    currentStreak: curLoss > curWin ? -curLoss : curWin,
    totalPnlSol: round(sumWin + sumLoss, 8),
    sumWinSol: round(sumWin, 8),
    sumLossSol: round(sumLoss, 8)
  };
}

/** Group closed trades by a key function → per-group metrics + sample counts. */
function breakdownBy(trades, keyFn) {
  const groups = new Map();
  for (const tr of (Array.isArray(trades) ? trades : [])) {
    const key = keyFn(tr);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tr);
  }
  const out = {};
  for (const [key, group] of groups) {
    const m = computeMetrics(group);
    out[key] = {
      n: m.n,
      winRate: m.winRate,
      avgPnlPct: m.expectancyPct,
      totalPnlSol: m.totalPnlSol,
      expectancySol: m.expectancySol,
      profitFactor: m.profitFactor,
      wins: m.wins,
      losses: m.losses
    };
  }
  return out;
}

/** Convenience breakdowns: by exit reason, time-of-day, liquidity class. */
function standardBreakdowns(trades) {
  return {
    byExitReason: breakdownBy(trades, (t) => t.exitReason || 'unknown'),
    byTimeOfDay: breakdownBy(trades, (t) => t.timeOfDay || 'unknown'),
    byLiquidity: breakdownBy(trades, (t) => t.liqClass || 'medium'),
    byScoreBand: breakdownBy(trades, (t) => {
      const s = num(t.entryScore);
      if (s == null) return 'unknown';
      if (s >= 75) return '75+';
      if (s >= 65) return '65-74';
      return '60-64';
    })
  };
}

/** Read the ledger file and return raw rows (robust to corrupt lines). */
function readLedgerFile(ledgerFile) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(ledgerFile)) return [];
    const lines = fs.readFileSync(ledgerFile, 'utf8').split('\n');
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
    }
    return rows;
  } catch (_) {
    return [];
  }
}

module.exports = {
  round,
  num,
  MS_MIN,
  MS_DAY,
  timeOfDayOf,
  liqClassOf,
  pairTrades,
  since,
  computeMetrics,
  breakdownBy,
  standardBreakdowns,
  readLedgerFile
};