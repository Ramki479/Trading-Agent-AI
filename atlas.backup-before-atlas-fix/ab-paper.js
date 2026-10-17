#!/usr/bin/env node
/**
 * atlas/ab-paper.js — A/B Paper Mode.
 *
 * Compares V1 actual decisions vs V1+ATLAS hypothetical decisions.
 * Both receive identical market data, position sizing, SL/TP, cooldown.
 * Only ATLAS filtering differs.
 *
 * Metrics: win rate, expectancy, profit factor, max drawdown, Sharpe,
 * average win, average loss, catastrophic losses, calibration.
 *
 * All calculations are deterministic and look-ahead-free.
 * No mutation of production trading logic.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

const AB_FILE = 'atlas-ab-paper.json';

/**
 * Create an A/B paper tracker.
 */
function createABPaper(db) {
  let state = loadState(db);

  function loadState(d) {
    try {
      const raw = d.readJson ? d.readJson(AB_FILE) : null;
      if (raw && typeof raw === 'object') return raw;
    } catch (_) {}
    return emptyState();
  }

  function emptyState() {
    return {
      version: 1,
      updatedAt: null,
      groupA: emptyGroup('V1'),
      groupB: emptyGroup('V1+ATLAS'),
      comparisons: []
    };
  }

  function emptyGroup(name) {
    return {
      name,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlPct: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      maxDrawdownPct: 0,
      profitFactor: 0,
      sharpe: 0,
      catastrophicLosses: 0, // losses > 10%
      sumWinPct: 0,
      sumLossPct: 0,
      returns: [] // keep last N for Sharpe calculation
    };
  }

  function save() {
    state.updatedAt = Date.now();
    if (db.writeJson) db.writeJson(AB_FILE, state);
  }

  /**
   * Record one trade outcome for both groups.
   * @param {object} trade { mint, symbol, pnlPct, exitReason, v1Score, atlasScore, atlasRecommendation }
   *
   * Group A (V1): always takes the trade (same as production).
   * Group B (V1+ATLAS): takes the trade only if ATLAS recommendation is BUY or HOLD.
   *   If ATLAS says AVOID, Group B skips (0% return).
   */
  function recordTrade(trade) {
    if (!trade || !Number.isFinite(trade.pnlPct)) return;

    const pnlPct = trade.pnlPct;
    const atlasRec = (trade.atlasRecommendation || 'HOLD').toUpperCase();

    // Group A: V1 always takes the trade
    updateGroup(state.groupA, pnlPct);

    // Group B: V1+ATLAS skips AVOID trades
    if (atlasRec === 'AVOID') {
      updateGroup(state.groupB, 0); // skipped trade = 0% return
    } else {
      updateGroup(state.groupB, pnlPct);
    }

    // Record comparison
    state.comparisons.push({
      ts: Date.now(),
      mint: trade.mint,
      symbol: trade.symbol,
      pnlPct,
      v1Return: pnlPct,
      atlasReturn: atlasRec === 'AVOID' ? 0 : pnlPct,
      atlasRecommendation: atlasRec,
      atlasScore: trade.atlasScore || null,
      v1Score: trade.v1Score || null,
      exitReason: trade.exitReason || null
    });

    // Keep only last 500 comparisons
    if (state.comparisons.length > 500) {
      state.comparisons = state.comparisons.slice(-500);
    }

    save();
    return { groupA: Object.assign({}, state.groupA), groupB: Object.assign({}, state.groupB) };
  }

  function updateGroup(group, pnlPct) {
    group.totalTrades += 1;
    if (pnlPct > 0) {
      group.wins += 1;
      group.sumWinPct += pnlPct;
    } else if (pnlPct < 0) {
      group.losses += 1;
      group.sumLossPct += Math.abs(pnlPct);
      if (pnlPct < -10) group.catastrophicLosses += 1;
    }
    group.totalPnlPct += pnlPct;
    group.winRate = group.totalTrades > 0
      ? Math.round((group.wins / group.totalTrades) * 10000) / 100
      : 0;
    group.avgWinPct = group.wins > 0
      ? Math.round((group.sumWinPct / group.wins) * 100) / 100
      : 0;
    group.avgLossPct = group.losses > 0
      ? Math.round((group.sumLossPct / group.losses) * 100) / 100
      : 0;
    group.profitFactor = group.sumLossPct > 0
      ? Math.round((group.sumWinPct / group.sumLossPct) * 100) / 100
      : (group.sumWinPct > 0 ? Infinity : 0);

    // Track returns for Sharpe
    group.returns.push(pnlPct);
    if (group.returns.length > 200) group.returns = group.returns.slice(-200);
    group.sharpe = computeSharpe(group.returns);

    // Max drawdown
    let peak = 0, cum = 0, maxDd = 0;
    for (const r of group.returns) {
      cum += r;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDd) maxDd = dd;
    }
    group.maxDrawdownPct = Math.round(maxDd * 100) / 100;
  }

  function computeSharpe(returns) {
    if (returns.length < 3) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    return std > 0 ? Math.round((mean / std) * 100) / 100 : 0;
  }

  /**
   * Get the current A/B comparison snapshot.
   */
  function snapshot() {
    const a = state.groupA;
    const b = state.groupB;
    const expectancyA = a.totalTrades > 0 ? Math.round((a.totalPnlPct / a.totalTrades) * 100) / 100 : 0;
    const expectancyB = b.totalTrades > 0 ? Math.round((b.totalPnlPct / b.totalTrades) * 100) / 100 : 0;

    return {
      groupA: Object.assign({}, a, { expectancyPct: expectancyA }),
      groupB: Object.assign({}, b, { expectancyPct: expectancyB }),
      totalComparisons: state.comparisons.length,
      lastComparison: state.comparisons.length > 0 ? state.comparisons[state.comparisons.length - 1] : null,
      updatedAt: state.updatedAt
    };
  }

  /**
   * Determine if ATLAS filtering improves outcomes.
   * Returns { improved, metrics } with a conservative assessment.
   */
  function evaluate() {
    const snap = snapshot();
    const a = snap.groupA;
    const b = snap.groupB;

    if (a.totalTrades < 10) {
      return { improved: null, reason: 'INSUFFICIENT_SAMPLE', sampleSize: a.totalTrades, snap };
    }

    const improved = b.expectancyPct > a.expectancyPct
      && b.profitFactor >= a.profitFactor
      && b.maxDrawdownPct <= a.maxDrawdownPct
      && b.catastrophicLosses <= a.catastrophicLosses;

    return {
      improved,
      reason: improved ? 'ATLAS filtering improved risk-adjusted returns' : 'ATLAS filtering did not improve enough metrics',
      metrics: {
        expectancy: { v1: a.expectancyPct, v1atlas: b.expectancyPct },
        winRate: { v1: a.winRate, v1atlas: b.winRate },
        profitFactor: { v1: a.profitFactor, v1atlas: b.profitFactor },
        maxDrawdown: { v1: a.maxDrawdownPct, v1atlas: b.maxDrawdownPct },
        sharpe: { v1: a.sharpe, v1atlas: b.sharpe },
        catastrophicLosses: { v1: a.catastrophicLosses, v1atlas: b.catastrophicLosses }
      },
      snap
    };
  }

  return {
    recordTrade,
    snapshot,
    evaluate,
    state: () => state
  };
}

module.exports = { createABPaper, AB_FILE };
