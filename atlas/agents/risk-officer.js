#!/usr/bin/env node
/**
 * atlas/agents/risk-officer.js — ATLAS Risk Officer (LLM reasoning).
 *
 * Synthesizes risk from V1 score, ATLAS research, bull/bear theses, liquidity,
 * volatility, regime, manipulation risk, data integrity, agent disagreement, and
 * historical agent reliability. Can recommend REJECT; cannot override mandatory V1
 * safety. Fails safe when the LLM endpoint is unavailable.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const llm = require('../../llm-adapter.js');
const schema = require('../schemas.js');

let promptTemplate = null;
function loadPrompt() {
  if (promptTemplate) return promptTemplate;
  try {
    const p = path.join(__dirname, '..', 'prompts', 'risk-officer.json');
    promptTemplate = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    promptTemplate = defaultPrompt();
  }
  return promptTemplate;
}

function defaultPrompt() {
  return {
    name: 'risk-officer',
    instructions: [
      'You are the ATLAS RISK OFFICER.',
      'Review the candidate and research below and answer: largest risk, what can invalidate, is data trustworthy, are agents overconfident, is this a crowded consensus, is it worth taking under V1, should it be rejected.',
      'Use ONLY supplied facts. Never invent data.',
      'You can recommend REJECT. You cannot override mandatory V1 safety.',
      'If data integrity is suspicious or PAIR_CHANGED, treat the observation as untrustworthy.',
      'Output JSON only.'
    ],
    schema: {
      required: ['agent', 'candidate', 'timestamp', 'direction', 'confidence', 'score', 'riskScore', 'approval', 'primaryRisks', 'invalidatingConditions'],
      agent: { const: 'risk-officer' }
    }
  };
}

function analyze(input = {}) {
  const cand = input.candidate || {};
  const t = input.technical || {};
  const momentum = input.momentum || {};
  const vol = input.volatility || {};
  const liq = input.liquidity || {};
  const regime = input.regime || {};
  const senti = input.sentiment || {};
  const solana = input.solana || {};
  const onchain = input.onchain || {};
  const tokenQ = input.tokenQuality || {};
  const manip = input.manipulation || {};
  const bull = input.bull || {};
  const bear = input.bear || {};
  const m = input.market || {};
  const integrity = input.integrity || {};
  const metrics = input.metrics || {};
  const disagreement = input.disagreement || {};

  const context = contextLines(cand, t, momentum, vol, liq, regime, senti, solana, onchain, tokenQ, manip, bull, bear, m, integrity, metrics, disagreement);

  const llmUrl = input.llm && typeof input.llm === 'object' && input.llm.url ? input.llm.url : null;
  const llmKey = input.llm && typeof input.llm === 'object' && input.llm.key ? input.llm.key : '';
  const llmModel = input.llm && typeof input.llm === 'object' && input.llm.model ? input.llm.model : '';
  const timeoutMs = input.researchTimeoutMs || 10000;

  if (!llmUrl) {
    return unavailable('no LLM endpoint configured');
  }

  const prompt = buildPrompt(loadPrompt(), context);
  const system = 'ATLAS RISK OFFICER. JSON only. Never invent data. Never output fields outside the schema. REJECT allowed; V1 safety overrides any recommendation.';

  const res = llm.maybeLLMJson({
    url: llmUrl,
    key: llmKey,
    model: llmModel,
    system,
    prompt,
    timeoutMs,
    validate: raw => validateRiskOfficer(raw)
  });

  if (!res || !res.ok || !res.json) {
    const reason = res && res.errors ? res.errors.join('; ') : (res ? 'LLM error' : 'LLM unavailable');
    return unavailable(reason);
  }

  const v = schema.validate(res.json, { numFields: ['confidence', 'score', 'riskScore'] });
  if (!v.ok) {
    return unavailable('LLM output invalid: ' + v.errors.join('; '));
  }

  return Object.assign({}, v.value, {
    dataQuality: integrity.dataQuality || 'ok',
    unavailable: false
  });
}

function contextLines(cand, t, momentum, vol, liq, regime, senti, solana, onchain, tokenQ, manip, bull, bear, m, integrity, metrics, disagreement) {
  const lines = [];
  lines.push('Candidate: ' + (cand.symbol || 'unknown'));
  lines.push('  mint: ' + (cand.mint || 'unknown'));
  lines.push('  pairAddress: ' + (cand.pairAddress || 'unknown'));
  lines.push('  dex: ' + (cand.dex || 'unknown'));
  lines.push('  priceSource: ' + (cand.priceSource || 'unknown'));
  lines.push('  priceUsd: ' + (Number.isFinite(cand.priceUsd) ? cand.priceUsd.toFixed(8) : 'n/a'));
  lines.push('  priceSol: ' + (Number.isFinite(cand.priceSol) ? cand.priceSol.toFixed(10) : 'n/a'));
  lines.push('  liquidityUsd: ' + (Number.isFinite(cand.liquidityUsd) ? '$' + cand.liquidityUsd.toLocaleString() : 'n/a'));
  lines.push('  volume24hUsd: ' + (Number.isFinite(cand.volume24hUsd) ? '$' + cand.volume24hUsd.toLocaleString() : 'n/a'));
  lines.push('  change5mPct: ' + (Number.isFinite(cand.change5mPct) ? cand.change5mPct.toFixed(2) : 'n/a') + '%');
  lines.push('  change1hPct: ' + (Number.isFinite(cand.change1hPct) ? cand.change1hPct.toFixed(1) : 'n/a') + '%');
  lines.push('  recoveryPct: ' + (Number.isFinite(cand.recoveryPct) ? cand.recoveryPct.toFixed(2) : 'n/a') + '%');
  lines.push('  V1 score: ' + (Number.isFinite(cand.score) ? cand.score : 'n/a'));
  lines.push('Technical: direction=' + (t.direction || 'n/a') + ', confidence=' + (Number.isFinite(t.confidence) ? t.confidence : 'n/a') + ', score=' + (Number.isFinite(t.score) ? t.score : 'n/a'));
  lines.push('Momentum: direction=' + (momentum.direction || 'n/a') + ', classification=' + (momentum.momentumClass || 'n/a'));
  lines.push('Volatility: class=' + (vol.volatilityClass || 'n/a') + ', realizedVolatility=' + (Number.isFinite(vol.realizedVolatility) ? vol.realizedVolatility : 'n/a') + '%');
  lines.push('Liquidity: score=' + (Number.isFinite(liq.liquidityScore) ? liq.liquidityScore : 'n/a') + ', risk=' + (liq.liquidityRisk || 'n/a') + ', exitability=' + (liq.exitability || 'n/a'));
  lines.push('Regime: ' + (regime.regime || 'n/a') + ', confidence=' + (Number.isFinite(regime.confidence) ? regime.confidence : 'n/a'));
  lines.push('Sentiment: ' + (senti.sentimentStatus || 'n/a') + ', direction=' + (senti.direction || 'n/a') + ', score=' + (Number.isFinite(senti.sentimentScore) ? senti.sentimentScore : 'n/a'));
  lines.push('Solana: status=' + (solana.status || 'n/a') + ', direction=' + (solana.direction || 'n/a'));
  lines.push('On-chain: status=' + (onchain.status || 'n/a') + ', direction=' + (onchain.direction || 'n/a'));
  lines.push('Token-quality: score=' + (Number.isFinite(tokenQ.tokenQualityScore) ? tokenQ.tokenQualityScore : 'n/a') + ', pairStable=' + (tokenQ.pairStable != null ? tokenQ.pairStable : 'n/a') + ', sourcesAgree=' + (tokenQ.sourcesAgree != null ? tokenQ.sourcesAgree : 'n/a'));
  lines.push('Manipulation: risk=' + (manip.manipulationRisk || 'n/a') + ', score=' + (Number.isFinite(manip.manipulationRiskScore) ? manip.manipulationRiskScore : 'n/a'));
  lines.push('Bull: confidence=' + (Number.isFinite(bull.confidence) ? bull.confidence : 'n/a') + ', score=' + (Number.isFinite(bull.score) ? bull.score : 'n/a'));
  lines.push('Bear: riskScore=' + (Number.isFinite(bear.riskScore) ? bear.riskScore : 'n/a') + ', confidence=' + (Number.isFinite(bear.confidence) ? bear.confidence : 'n/a') + ', direction=' + (bear.direction || 'n/a'));
  lines.push('Risk-officer previous (if any): (computed below)');
  lines.push('Market: regime=' + (m.regime || 'n/a') + ', health=' + (Number.isFinite(m.marketHealth) ? m.marketHealth : 'n/a') + (m.healthGate ? ', healthGate=active' : ''));
  if (integrity && integrity.dataQuality) lines.push('Price-integrity: dataQuality=' + integrity.dataQuality);
  if (integrity && integrity.pairStable != null) lines.push('  pairStable=' + integrity.pairStable);
  if (integrity && integrity.sourcesAgree != null) lines.push('  sourcesAgree=' + integrity.sourcesAgree);
  if (integrity && integrity.reasons && integrity.reasons.length) lines.push('  reasons: ' + integrity.reasons.join('; '));
  lines.push('Metrics: lossStreak=' + (Number.isFinite(metrics.lossStreak) ? metrics.lossStreak : 'n/a') + ', maxDrawdownPct=' + (Number.isFinite(metrics.maxDrawdownPct) ? metrics.maxDrawdownPct.toFixed(0) : 'n/a') + '%, winRate=' + (Number.isFinite(metrics.winRate) ? metrics.winRate.toFixed(0) : 'n/a') + '%');
  if (disagreement) {
    lines.push('Disagreement: consensus=' + (disagreement.consensus || 'n/a') + ', dispersion=' + (Number.isFinite(disagreement.dispersion) ? disagreement.dispersion : 'n/a') + ', minorityRisk=' + (Number.isFinite(disagreement.minorityRisk) ? disagreement.minorityRisk : 'n/a') + ', critical=' + (disagreement.criticalDisagreement ? 'yes' : 'no') + ', agreementScore=' + (Number.isFinite(disagreement.agentAgreementScore) ? disagreement.agentAgreementScore : 'n/a'));
    if (disagreement.breakdowns) lines.push('  breakdown: bull=' + (disagreement.breakdowns.bullish != null ? disagreement.breakdowns.bullish : 'n/a') + ' bear=' + (disagreement.breakdowns.bearish != null ? disagreement.breakdowns.bearish : 'n/a') + ' neutral=' + (disagreement.breakdowns.neutral != null ? disagreement.breakdowns.neutral : 'n/a'));
  }
  return lines.join('\n');
}

function buildPrompt(template, context) {
  const instr = Array.isArray(template.instructions) ? template.instructions : [];
  const fewShot = template.few_shot || [];
  let p = instr.join('\n') + '\n\nFacts:\n' + context + '\n\n';
  if (fewShot.length) {
    p += 'Examples (input/output JSON only):\n';
    for (const ex of fewShot.slice(0, 2)) {
      if (ex.input) p += JSON.stringify({ input: ex.input }) + '\n';
      if (ex.output) p += JSON.stringify(ex.output) + '\n';
    }
    p += '\nNow output the JSON for the candidate above:\n';
  } else {
    p += '\nOutput JSON only matching the schema. Never invent data.\n';
  }
  return p;
}

function validateRiskOfficer(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not an object'] };
  if (!raw.agent || raw.agent !== 'risk-officer') errors.push('invalid agent');
  if (!raw.candidate || typeof raw.candidate !== 'string') errors.push('missing candidate');
  if (!Number.isFinite(raw.timestamp)) errors.push('missing timestamp');
  if (!['bullish', 'bearish', 'neutral', 'unknown'].includes(raw.direction)) errors.push('invalid direction');
  if (Number.isFinite(raw.confidence)) raw.confidence = schema.clamp(raw.confidence); else errors.push('missing confidence');
  if (Number.isFinite(raw.score)) raw.score = schema.clamp(raw.score); else raw.score = 0;
  if (Number.isFinite(raw.riskScore)) raw.riskScore = schema.clamp(raw.riskScore); else raw.riskScore = 0;
  if (!['PASS', 'REVIEW', 'REJECT'].includes(raw.approval)) errors.push('invalid approval: ' + (raw.approval || 'missing'));
  if (!Array.isArray(raw.primaryRisks)) errors.push('primaryRisks must be array');
  if (!Array.isArray(raw.invalidatingConditions)) errors.push('invalidatingConditions must be array');
  for (const k of Object.keys(raw)) {
    if (schema.FORBIDDEN.has(k.toLowerCase())) errors.push('forbidden field: ' + k);
  }
  return { ok: errors.length === 0, json: raw, errors };
}

function unavailable(reason) {
  return {
    agent: 'risk-officer',
    candidate: '',
    timestamp: Date.now(),
    direction: 'unknown',
    confidence: 0,
    score: 0,
    riskScore: 0,
    approval: 'PASS',
    primaryRisks: ['LLM unavailable: ' + reason],
    invalidatingConditions: ['LLM unavailable — risk assessment not performed; V1 risk controls remain authoritative'],
    dataQuality: 'ok',
    unavailable: true
  };
}

module.exports = { analyze, loadPrompt };
