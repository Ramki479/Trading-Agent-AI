#!/usr/bin/env node
/**
 * atlas/agents/synthesis.js — ATLAS Research Synthesizer (LLM reasoning).
 *
 * Combines all ATLAS research into a single researchScore (separate from V1),
 * researchRecommendation (BUY/HOLD/AVOID), researchConfidence, consensus, riskLevel,
 * and keeps every component separately visible (technicalScore, quantScore,
 * sentimentScore, marketScore, bullScore, bearRisk).
 *
 * If data-integrity is suspicious or PAIR_CHANGED, caps the recommendation to HOLD
 * and sets dataQuality=suspicious. NEVER outputs BUY on quarantined/invalid
 * observations.
 *
 * Fails safe when the LLM endpoint is unavailable.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const llm = require('../../llm-adapter.js');
const schema = require('../schemas.js');
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

let promptTemplate = null;
function loadPrompt() {
  if (promptTemplate) return promptTemplate;
  try {
    const p = path.join(__dirname, '..', 'prompts', 'synthesis.json');
    promptTemplate = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    promptTemplate = defaultPrompt();
  }
  return promptTemplate;
}

function defaultPrompt() {
  return {
    name: 'synthesis',
    instructions: [
      'You are the ATLAS RESEARCH SYNTHESIZER.',
      'Combine all research into a researchScore (NOT the V1 score), researchRecommendation (BUY/HOLD/AVOID), researchConfidence, consensus, riskLevel.',
      'Keep every component separately visible: technicalScore, quantScore, sentimentScore, marketScore, bullScore, bearRisk.',
      'If data integrity is suspicious or PAIR_CHANGED, cap to HOLD and set dataQuality=suspicious.',
      'Never output BUY on quarantined/invalid observations.',
      'ATLAS is advisory only — it never replaces V1 or authorizes execution.',
      'Output JSON only.'
    ],
    schema: {
      required: ['agent', 'candidate', 'timestamp', 'researchScore', 'researchRecommendation', 'researchConfidence', 'consensus', 'riskLevel', 'dataQuality', 'reasons', 'warnings', 'technicalScore', 'quantScore', 'sentimentScore', 'marketScore', 'bullScore', 'bearRisk'],
      agent: { const: 'decision-synthesizer' }
    }
  };
}

function analyze(input = {}) {
  const cand = input.candidate || {};
  const t = input.technical || {};
  const q = input.quant || {};
  const s = input.sentiment || {};
  const m = input.market || {};
  const bullR = input.bull || {};
  const bearR = input.bear || {};
  const riskR = input.risk || {};
  const integrity = input.integrity || {};
  const v1Score = Number.isFinite(cand.score) ? cand.score : 60;

  // Deterministic component scores (always present, even without LLM)
  const technicalScore = Number.isFinite(t.score) ? t.score : 0;
  const momentumScore = Number.isFinite(input.momentum && input.momentum.score) ? input.momentum.score : 0;
  const volatilityScore = Number.isFinite(input.volatility && input.volatility.score) ? input.volatility.score : 0;
  const liquidityScore = Number.isFinite(input.liquidity && input.liquidity.liquidityScore) ? input.liquidity.liquidityScore : 0;
  const regimeScore = Number.isFinite(input.regime && input.regime.score) ? input.regime.score : 0;
  const sentimentScore = Number.isFinite(s.score) ? s.score : 0;
  const solanaScore = Number.isFinite(input.solana && input.solana.score) ? input.solana.score : 0;
  const onchainScore = Number.isFinite(input.onchain && input.onchain.score) ? input.onchain.score : 0;
  const tokenQualityScore = Number.isFinite(input.tokenQuality && input.tokenQuality.tokenQualityScore) ? input.tokenQuality.tokenQualityScore : 0;
  const manipulationScore = Number.isFinite(input.manipulation && input.manipulation.manipulationRiskScore) ? input.manipulation.manipulationRiskScore : 0;
  const bullScore = Number.isFinite(bullR.score) ? bullR.score : 0;
  const bearRisk = Number.isFinite(bearR.riskScore) ? bearR.riskScore : 0;
  const riskScore = Number.isFinite(riskR.riskScore) ? riskR.riskScore : 0;

  const marketScore = average([regimeScore, solanaScore, regimeScore && solanaScore ? 70 : 0]);
  const quantProxyScore = q.expectedDirection && q.confidence != null ? average([q.confidence, q.setupQuality || 50]) : 0;
  const quantScore = Number.isFinite(q.score) ? q.score : quantProxyScore;

  const lowIntegrity = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' || integrity.dataQuality === 'quarantined';
  const suspiciousReasons = (integrity.reasons || []).slice(0, 6);

  const llmUrl = input.llm && typeof input.llm === 'object' && input.llm.url ? input.llm.url : null;
  const llmKey = input.llm && typeof input.llm === 'object' && input.llm.key ? input.llm.key : '';
  const llmModel = input.llm && typeof input.llm === 'object' && input.llm.model ? input.llm.model : '';
  const timeoutMs = input.researchTimeoutMs || 10000;

  if (!llmUrl) {
    // Deterministic fallback synthesis (always returns a structured result)
    return deterministicSynthesis({
      technicalScore, quantScore, sentimentScore, marketScore,
      bullScore, bearRisk, riskScore, v1Score,
      lowIntegrity, suspiciousReasons, cand, t, q, s, m, bullR, bearR, riskR
    });
  }

  const context = contextLines(cand, t, q, s, m, bullR, bearR, riskR, integrity, technicalScore, quantScore, sentimentScore, marketScore, bullScore, bearRisk, riskScore, v1Score);

  const prompt = buildPrompt(loadPrompt(), context);
  const system = 'ATLAS RESEARCH SYNTHESIZER. JSON only. Never invent data. Never output fields outside the schema. BUY only on clean data; HOLD when data is suspicious; AVOID when research recommends against. ATLAS is advisory only.';

  const res = llm.maybeLLMJson({
    url: llmUrl,
    key: llmKey,
    model: llmModel,
    system,
    prompt,
    timeoutMs,
    validate: raw => validateSynthesis(raw, lowIntegrity)
  });

  if (!res || !res.ok || !res.json) {
    const reason = res && res.errors ? res.errors.join('; ') : (res ? 'LLM error' : 'LLM unavailable');
    return deterministicSynthesis({
      technicalScore, quantScore, sentimentScore, marketScore,
      bullScore, bearRisk, riskScore, v1Score,
      lowIntegrity, suspiciousReasons, cand, t, q, s, m, bullR, bearR, riskR,
      llmFailReason: reason
    });
  }

  const v = schema.validate(res.json, { numFields: ['researchScore', 'researchConfidence', 'technicalScore', 'quantScore', 'sentimentScore', 'marketScore', 'bullScore', 'bearRisk'] });
  if (!v.ok) {
    return deterministicSynthesis({
      technicalScore, quantScore, sentimentScore, marketScore,
      bullScore, bearRisk, riskScore, v1Score,
      lowIntegrity, suspiciousReasons, cand, t, q, s, m, bullR, bearR, riskR,
      llmFailReason: 'LLM output invalid: ' + v.errors.join('; ')
    });
  }

  // Enforce integrity cap even if LLM ignores it
  const out = v.value;
  if (lowIntegrity) {
    out.researchRecommendation = 'HOLD';
    out.dataQuality = 'suspicious';
    if (out.researchScore > 50) out.researchScore = 50;
    out.researchConfidence = Math.min(out.researchConfidence, 50);
  }
  out.technicalScore = Number.isFinite(out.technicalScore) ? out.technicalScore : technicalScore;
  out.quantScore = Number.isFinite(out.quantScore) ? out.quantScore : quantScore;
  out.sentimentScore = Number.isFinite(out.sentimentScore) ? out.sentimentScore : sentimentScore;
  out.marketScore = Number.isFinite(out.marketScore) ? out.marketScore : marketScore;
  out.bullScore = Number.isFinite(out.bullScore) ? out.bullScore : bullScore;
  out.bearRisk = Number.isFinite(out.bearRisk) ? out.bearRisk : bearRisk;
  out.researchScore = Number.isFinite(out.researchScore) ? clamp(out.researchScore) : 0;
  out.researchConfidence = Number.isFinite(out.researchConfidence) ? clamp(out.researchConfidence) : 0;

  return Object.assign({}, out, {
    agent: 'decision-synthesizer',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    dataQuality: lowIntegrity ? 'suspicious' : (out.dataQuality || (integrity.dataQuality || 'ok')),
    unavailable: false
  });
}

function average(arr) {
  if (!arr.length) return 0;
  const nums = arr.filter(n => Number.isFinite(n));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function contextLines(cand, t, q, s, m, bullR, bearR, riskR, integrity, ts, qs, ss, ms, bs, br, rs, v1Score) {
  const lines = [];
  lines.push('V1 score: ' + v1Score);
  lines.push('Technical: score=' + ts + ', direction=' + (t.direction || 'n/a') + ', confidence=' + (Number.isFinite(t.confidence) ? t.confidence : 'n/a'));
  lines.push('Quant: expectedDirection=' + (q.expectedDirection || 'n/a') + ', confidence=' + (Number.isFinite(q.confidence) ? q.confidence : 'n/a') + ', setupQuality=' + (Number.isFinite(q.setupQuality) ? q.setupQuality : 'n/a') + ', score=' + qs);
  lines.push('Sentiment: direction=' + (s.direction || 'n/a') + ', confidence=' + (Number.isFinite(s.confidence) ? s.confidence : 'n/a') + ', score=' + ss);
  lines.push('Market: regime=' + (m.regime || 'n/a') + ', health=' + (Number.isFinite(m.marketHealth) ? m.marketHealth : 'n/a') + ', marketScore=' + ms);
  lines.push('Bull: confidence=' + (Number.isFinite(bullR.confidence) ? bullR.confidence : 'n/a') + ', score=' + bs);
  lines.push('Bear: riskScore=' + br + ', confidence=' + (Number.isFinite(bearR.confidence) ? bearR.confidence : 'n/a') + ', direction=' + (bearR.direction || 'n/a'));
  lines.push('Risk-officer: riskScore=' + rs + ', approval=' + (riskR.approval || 'n/a'));
  if (integrity && integrity.dataQuality) lines.push('Price-integrity: dataQuality=' + integrity.dataQuality);
  if (integrity && integrity.pairStable != null) lines.push('  pairStable=' + integrity.pairStable);
  if (integrity && integrity.sourcesAgree != null) lines.push('  sourcesAgree=' + integrity.sourcesAgree);
  if (integrity && integrity.reasons && integrity.reasons.length) lines.push('  reasons: ' + integrity.reasons.join('; '));
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

function validateSynthesis(raw, lowIntegrity) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not an object'] };
  if (!raw.agent || raw.agent !== 'decision-synthesizer') errors.push('invalid agent');
  if (!raw.candidate || typeof raw.candidate !== 'string') errors.push('missing candidate');
  if (!Number.isFinite(raw.timestamp)) errors.push('missing timestamp');
  if (!['BUY', 'HOLD', 'AVOID'].includes(raw.researchRecommendation)) errors.push('invalid researchRecommendation: ' + (raw.researchRecommendation || 'missing'));
  if (!['strong_bullish', 'bullish', 'mixed', 'bearish', 'strong_bearish'].includes(raw.consensus)) errors.push('invalid consensus: ' + (raw.consensus || 'missing'));
  if (!['low', 'medium', 'high', 'critical'].includes(raw.riskLevel)) errors.push('invalid riskLevel: ' + (raw.riskLevel || 'missing'));
  if (!['ok', 'suspicious', 'fail', 'insufficient_history'].includes(raw.dataQuality)) errors.push('invalid dataQuality: ' + (raw.dataQuality || 'missing'));
  if (Number.isFinite(raw.researchScore)) raw.researchScore = clamp(raw.researchScore); else errors.push('missing researchScore');
  if (Number.isFinite(raw.researchConfidence)) raw.researchConfidence = clamp(raw.researchConfidence); else errors.push('missing researchConfidence');
  // component scores optional but if present must be finite
  for (const f of ['technicalScore', 'quantScore', 'sentimentScore', 'marketScore', 'bullScore', 'bearRisk']) {
    if (raw[f] != null && !Number.isFinite(raw[f])) errors.push(f + ' not finite');
  }
  if (lowIntegrity && raw.researchRecommendation === 'BUY') errors.push('BUY not allowed on suspicious/invalid data');
  if (!Array.isArray(raw.reasons)) errors.push('reasons must be array');
  if (!Array.isArray(raw.warnings)) errors.push('warnings must be array');
  for (const k of Object.keys(raw)) {
    if (schema.FORBIDDEN.has(k.toLowerCase())) errors.push('forbidden field: ' + k);
  }
  return { ok: errors.length === 0, json: raw, errors };
}

function deterministicSynthesis(ctx) {
  const { technicalScore, quantScore, sentimentScore, marketScore, bullScore, bearRisk, riskScore, v1Score, lowIntegrity, suspiciousReasons, cand, t, q, s, m, bullR, bearR, riskR, llmFailReason } = ctx;

  let recommendation = 'HOLD';
  let consensus = 'mixed';
  let researchConfidence = 0;
  let researchScore = 0;
  let riskLevel = 'medium';
  let reasons = [];
  let warnings = [];

  const dataQuality = lowIntegrity ? 'suspicious' : (integrityDataQuality(integrityOrNull()));

  if (lowIntegrity) {
    recommendation = 'HOLD';
    consensus = 'mixed';
    researchConfidence = 10;
    researchScore = 15;
    reasons.push('Data integrity is suspicious/invalid — research is capped to HOLD. Do not trade on this observation.');
    warnings.push('price_integrity_warning');
    if (suspiciousReasons.length) warnings.push.apply(warnings, suspiciousReasons);
  } else {
    // Deterministic research score from components
    const comps = [technicalScore, quantScore, sentimentScore, marketScore, bullScore, Math.max(0, 100 - bearRisk), Math.max(0, 100 - riskScore)];
    const compAvg = comps.filter(n => Number.isFinite(n)).reduce((a, b) => a + b, 0) / Math.max(1, comps.filter(n => Number.isFinite(n)).length);
    researchScore = clamp(Math.round(compAvg));

    const bullStrong = bullScore >= 70;
    const bearLow = bearRisk <= 25;
    const riskLow = riskScore <= 35;
    const riskMed = riskScore <= 60;

    if (bullStrong && bearLow && riskLow && researchScore >= 65) {
      recommendation = 'BUY';
      consensus = 'bullish';
      researchConfidence = clamp(Math.round(50 + (researchScore - 50) * 0.6));
    } else if (bullStrong && riskMed && researchScore >= 55) {
      recommendation = 'BUY';
      consensus = 'mildly_bullish';
      researchConfidence = clamp(Math.round(40 + (researchScore - 40) * 0.6));
    } else if (bearRisk >= 70 || riskScore >= 75 || researchScore <= 25) {
      recommendation = 'AVOID';
      consensus = 'bearish';
      researchConfidence = clamp(Math.round(40 + (100 - researchScore) * 0.5));
    } else if (researchScore >= 45 && researchScore < 65) {
      recommendation = 'HOLD';
      consensus = 'mixed';
      researchConfidence = clamp(Math.round(30 + researchScore * 0.4));
    } else {
      recommendation = 'HOLD';
      consensus = 'mixed';
      researchConfidence = clamp(Math.round(20 + researchScore * 0.4));
    }
    researchScore = clamp(Math.round(researchScore));
    researchConfidence = clamp(Math.round(researchConfidence));

    if (bearRisk >= 60) warnings.push('bear_risk_elevated');
    if (riskScore >= 60) warnings.push('risk_officer_elevated');
    if (riskR.approval === 'REJECT') {
      recommendation = 'AVOID';
      consensus = 'bearish';
      warnings.push('risk_officer_reject');
    }
    if (riskR.approval === 'REVIEW') warnings.push('risk_officer_review');
    if (bearR.warnings && bearR.warnings.length) warnings.push.apply(warnings, bearR.warnings.slice(0, 4));
    if (riskR.primaryRisks && riskR.primaryRisks.length) reasons.push.apply(reasons, riskR.primaryRisks.slice(0, 4));
  }

  // riskLevel
  if (riskScore >= 75) riskLevel = 'critical';
  else if (riskScore >= 55) riskLevel = 'high';
  else if (riskScore >= 30) riskLevel = 'medium';
  else riskLevel = 'low';

  // reasons
  if (!reasons.length) {
    if (recommendation === 'BUY') {
      reasons.push('Research supports the trade: technical, quant, sentiment, market, bull case aligned; bear risk moderate; risk officer PASS.');
    } else if (recommendation === 'AVOID') {
      reasons.push('Research recommends against the trade: bear risk elevated, risk officer REJECT, or research score low.');
    } else {
      reasons.push('Research mixed — holding for clearer signal or better data.');
    }
  }

  return {
    agent: 'decision-synthesizer',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    researchScore,
    researchRecommendation: recommendation,
    researchConfidence,
    consensus,
    riskLevel,
    dataQuality,
    reasons: reasons.slice(0, 12),
    warnings: warnings.slice(0, 12),
    technicalScore,
    quantScore,
    sentimentScore,
    marketScore,
    bullScore,
    bearRisk,
    unavailable: !!llmFailReason,
    llmNote: llmFailReason || null
  };
}

function integrityDataQuality(integrity) {
  if (!integrity) return 'ok';
  if (integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' || integrity.dataQuality === 'quarantined') return 'suspicious';
  return 'ok';
}

function integrityOrNull() {
  try { return require('../integrity-iface.js'); } catch (_) { return null; }
}

module.exports = { analyze, loadPrompt };
