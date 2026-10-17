#!/usr/bin/env node
/**
 * agents/bear-researcher.js — TradingAgents Bear Researcher (deterministic).
 *
 * Aggressively challenges the bullish thesis using only real data. It watches
 * for weak liquidity/volume, failed recovery, extreme volatility, regime
 * deterioration, historical losing patterns and — critically — price-integrity
 * problems (suspicious observations, PAIR_CHANGED, stale/invalid prints). It
 * has NO execution authority and creates NO new price-drop rule: it only
 * reports integrity findings that already exist in the price-integrity layer.
 *
 * Output schema:
 *   { agent: 'bear-researcher', confidence: 0..100, riskScore: 0..100,
 *     case: string[], warnings: string[] }
 */
'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/**
 * @param input { candidate, technical, quant, market, metrics?, integrity? }
 *   integrity: { dataQuality, reasons[] }
 */
function analyze(input = {}) {
  const cand = input.candidate || {};
  const t = input.technical || {};
  const q = input.quant || {};
  const m = input.market || {};
  const metrics = input.metrics || {};
  const integrity = input.integrity || {};
  const warnings = [];
  const bearCase = [];
  let riskScore = 0;

  const liq = Number(cand.liquidityUsd) || 0;
  const vol = Number(cand.volume24hUsd) || 0;
  const recovery = Number.isFinite(cand.recoveryPct) ? cand.recoveryPct : null;
  const warming = cand.recoveryStatus === 'warming' || (input.history && input.history.warming);

  // ---- price integrity (report only — never invent a new rule) -------------
  const integritySuspicious = integrity.dataQuality === 'suspicious';
  if (integritySuspicious) {
    riskScore += 30;
    warnings.push('price_integrity_warning: observation data quality is suspicious (quarantined / flagged)');
    bearCase.push('The price observation itself is not trustworthy right now — accounting must not be based on it.');
  }
  if ((integrity.reasons || []).some((r) => /PAIR_CHANGED/i.test(r))) {
    riskScore += 25;
    warnings.push('PAIR_CHANGED: pool identity for this mint has changed — do not trade the new pair price');
  }
  if ((integrity.reasons || []).some((r) => /STALE|invalid/i.test(r))) {
    riskScore += 15;
    warnings.push('stale/invalid price reported by the price-integrity layer');
  }

  // ---- liquidity / volume weakness ------------------------------------------
  if (liq > 0 && liq < 10000) { riskScore += 20; warnings.push('low_liquidity'); bearCase.push(`Liquidity is only $${Math.round(liq).toLocaleString('en-US')} — exits may be unreliable.`); }
  else if (liq > 0 && liq < 50000) { riskScore += 8; warnings.push('moderate_liquidity'); }
  if (vol > 0 && vol < 50000) { riskScore += 12; warnings.push('low_volume'); bearCase.push(`24h volume $${Math.round(vol).toLocaleString('en-US')} is thin — momentum may be unconfirmed.`); }

  // ---- failed / missing recovery --------------------------------------------
  if (warming) {
    warnings.push('insufficient_history (warming) — recovery unproven');
    bearCase.push('Local history is still warming; the recovery claim is not established.');
  } else if (recovery != null && recovery < 0.25) {
    riskScore += 12;
    warnings.push('failed_recovery');
    bearCase.push('Local 5m recovery is below the strategy floor — the dip may not be reversing.');
  }

  // ---- extreme volatility ----------------------------------------------------
  const volScore = Number(t.volatility) || 0;
  if (volScore >= 85) { riskScore += 16; warnings.push('extreme_volatility'); }
  else if (volScore >= 65) { riskScore += 7; warnings.push('high_volatility'); }

  // ---- regime / market deterioration ----------------------------------------
  if (m.regime === 'dump') { riskScore += 16; warnings.push('dump_regime'); }
  else if (m.regime === 'recovery') { riskScore += 6; }
  if (m.healthGate) { riskScore += 10; warnings.push('market_health_gate'); }

  // ---- historical losing patterns -------------------------------------------
  const streak = Number(metrics.lossStreak) || 0;
  const dd = Number(metrics.maxDrawdownPct) || 0;
  if (streak >= 3) { riskScore += 15; warnings.push('loss_streak'); bearCase.push(`The account is on a ${streak}-loss streak — regime risk is real.`); }
  if (dd >= 15) { riskScore += 10; warnings.push('drawdown_risk'); }

  // ---- quant bearish view ----------------------------------------------------
  if (q.expectedDirection === 'down') { riskScore += 10; bearCase.push('Quant view is down (negative expectancy window).'); }

  riskScore = Math.round(clamp(riskScore, 0, 100));
  if (!bearCase.length) bearCase.push('No material bear case found in the observed data.');

  return {
    agent: 'bear-researcher',
    confidence: Math.round(clamp(riskScore, 0, 100)),
    riskScore,
    case: bearCase,
    warnings
  };
}

module.exports = { analyze };
