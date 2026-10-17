#!/usr/bin/env node
/**
 * agents/market-analyst.js — TradingAgents Market Analyst (deterministic).
 *
 * Reads the BROADER Solana conditions already tracked by the agent: the real
 * SOL/USD price, the existing regime detector, market-health, and liquidity/
 * activity conditions. It REPORTS the market view for research — it does NOT
 * replace regime-detector.js or market-health.js (those remain authoritative
 * for the Circuit/adaptive layers).
 *
 * Output schema:
 *   { agent: 'market', regime: bull|neutral|recovery|dump|unknown,
 *     confidence: 0..100, marketHealth: 0..100, solTrend: 0..100,
 *     reasoning: string[] }
 */
'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param input { market, portfolio? }
 *   market: { regime, regimeConfidence, healthScore, healthStatus, healthGate,
 *             solPriceUsd, solMomentumPct? }
 */
function analyze(input = {}) {
  const market = input.market || {};
  const reasoning = [];
  const regime = market.regime || 'unknown';

  // Reported (never replaced) regime.
  const regimeLabel = ['bull', 'neutral', 'recovery', 'dump', 'unknown'].includes(String(regime).toLowerCase())
    ? String(regime).toLowerCase()
    : 'unknown';
  reasoning.push(`regime from regime-detector: ${regimeLabel} (confidence ${Math.round((market.regimeConfidence || 0) * 100)}%)`);

  // Market health (existing proxy) — 0..100, never invented.
  const healthScore = Number.isFinite(market.healthScore) ? clamp(market.healthScore, 0, 100) : null;
  let marketHealth = 0;
  if (healthScore == null) {
    reasoning.push('market-health not yet computed — marketHealth 0/100');
  } else {
    marketHealth = Math.round(healthScore);
    reasoning.push(`market-health proxy ${marketHealth}/100 (${market.healthStatus || 'unknown'}${market.healthGate ? ', GATED' : ''})`);
  }

  // SOL trend: only from real SOL price momentum when supplied.
  let solTrend = 0;
  if (Number.isFinite(market.solMomentumPct)) {
    solTrend = Math.round(clamp(50 + market.solMomentumPct * 8, 0, 100));
    reasoning.push(`SOL momentum ${market.solMomentumPct >= 0 ? '+' : ''}${market.solMomentumPct.toFixed(2)}% (real) → solTrend ${solTrend}/100`);
  } else if (Number.isFinite(market.solPriceUsd) && market.solPriceUsd > 0) {
    solTrend = 50; // level known, trend unknown — neutral, not fabricated
    reasoning.push('SOL level known but no momentum series — solTrend neutral 50');
  } else {
    reasoning.push('no SOL price data — solTrend 0/100');
  }

  const confidence = Math.round(clamp(healthScore == null ? 30 : marketHealth * 0.55 + solTrend * 0.3 + (regimeLabel === 'bull' ? 15 : 0), 0, 100));

  return {
    agent: 'market',
    regime: regimeLabel,
    confidence,
    marketHealth,
    solTrend,
    reasoning
  };
}

module.exports = { analyze };
