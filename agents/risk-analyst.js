#!/usr/bin/env node
/**
 * agents/risk-analyst.js — TradingAgents Risk Analyst (deterministic).
 *
 * Aggregates risk across: liquidity, volatility, market health/regime,
 * portfolio exposure/concentration, recent losses, candidate quality and
 * price-integrity state. The Risk Analyst REPORTS risk for research — it does
 * NOT replace the existing deterministic Circuit risk controls (SL/TP,
 * cooldown, max positions, market-health gate, price integrity).
 *
 * Output schema:
 *   { agent: 'risk', riskLevel: low|medium|high|critical, riskScore: 0..100,
 *     warnings: string[], reasoning: string[] }
 */
'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/**
 * @param input { candidate, technical, market, bear, portfolio?, metrics?,
 *                integrity?, exposure? }
 */
function analyze(input = {}) {
  const cand = input.candidate || {};
  const t = input.technical || {};
  const m = input.market || {};
  const bear = input.bear || {};
  const metrics = input.metrics || {};
  const integrity = input.integrity || {};
  const portfolio = input.portfolio || {};
  const exposure = input.exposure || {};
  const warnings = [];
  const reasoning = [];
  let score = 0;

  const liq = Number(cand.liquidityUsd) || 0;
  const volScore = Number(t.volatility) || 0;

  // Price-integrity state is the top risk input (report, never a new rule).
  if (integrity.dataQuality === 'suspicious') {
    score += 25;
    warnings.push('price_integrity_warning: observation under suspicion — treat price with caution');
    reasoning.push('price-integrity flags this observation as suspicious');
  }
  for (const w of (integrity.reasons || [])) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  // Liquidity + volatility of the specific instrument.
  if (liq > 0 && liq < 10000) { score += 15; warnings.push('low_liquidity'); }
  else if (liq > 0 && liq < 50000) score += 6;
  if (volScore >= 85) { score += 12; warnings.push('extreme_volatility'); }
  else if (volScore >= 65) score += 5;

  // Market environment (existing health + regime).
  if (m.healthGate) { score += 12; warnings.push('market_health_gate'); }
  if (m.regime === 'dump') { score += 10; warnings.push('dump_regime'); }
  else if (m.regime === 'recovery') score += 4;
  const health = Number(m.marketHealth) || 0;
  if (health > 0 && health < 60) score += 6;

  // Portfolio exposure + concentration (open positions are ≤ MAX_POSITIONS).
  const open = Number(exposure.openPositions) || (portfolio.positions && portfolio.positions.length) || 0;
  const max = Number(exposure.maxPositions) || 5;
  const conc = max > 0 ? open / max : 0;
  if (conc >= 0.8) { score += 8; warnings.push('portfolio_concentration'); reasoning.push(`${open}/${max} positions open — concentrated`); }
  else if (conc >= 0.5) score += 3;

  // Recent losses / drawdown from the account's own closed trades.
  const streak = Number(metrics.lossStreak) || 0;
  const dd = Number(metrics.maxDrawdownPct) || 0;
  if (streak >= 3) { score += 12; warnings.push('loss_streak'); }
  if (dd >= 15) { score += 8; warnings.push('drawdown_risk'); }

  // Bear researcher view already reflects the candidate-level negatives.
  score += (Number(bear.riskScore) || 0) * 0.35;
  for (const w of (bear.warnings || [])) if (!warnings.includes(w)) warnings.push(w);

  score = Math.round(clamp(score, 0, 100));
  let riskLevel = 'low';
  if (score >= 75) riskLevel = 'critical';
  else if (score >= 55) riskLevel = 'high';
  else if (score >= 30) riskLevel = 'medium';
  reasoning.push(`aggregated risk ${score}/100 → ${riskLevel.toUpperCase()}`);

  return {
    agent: 'risk',
    riskLevel,
    riskScore: score,
    warnings,
    reasoning
  };
}

module.exports = { analyze };
