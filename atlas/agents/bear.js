#!/usr/bin/env node
/**
 * atlas/agents/bear.js — ATLAS Bear Agent (LLM reasoning).
 *
 * Constructs the strongest possible case AGAINST the trade using ONLY supplied facts.
 * Be adversarial, not pessimistic. Fails safe when the LLM endpoint is unavailable.
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
    const p = path.join(__dirname, '..', 'prompts', 'bear.json');
    promptTemplate = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    promptTemplate = defaultPrompt();
  }
  return promptTemplate;
}

function defaultPrompt() {
  return {
    name: 'bear',
    instructions: [
      'You are the ATLAS BEAR agent. Construct the strongest possible case AGAINST the trade.',
      'Be adversarial, not pessimistic.',
      'Use ONLY the facts provided. Never invent data.',
      'Search for: failed recovery, liquidity traps, momentum exhaustion, manipulation, weak volume, pair instability, regime mismatch.',
      'Output JSON only.'
    ],
    schema: {
      required: ['agent', 'candidate', 'timestamp', 'direction', 'confidence', 'score', 'riskScore', 'case', 'warnings'],
      agent: { const: 'bear-researcher' }
    }
  };
}

function analyze(input = {}) {
  const cand = input.candidate || {};
  const t = input.technical || {};
  const q = input.quant || {};
  const m = input.market || {};
  const metrics = input.metrics || {};
  const integrity = input.integrity || {};

  const context = contextLines(cand, t, q, m, metrics, integrity);

  const llmUrl = input.llm && typeof input.llm === 'object' && input.llm.url ? input.llm.url : null;
  const llmKey = input.llm && typeof input.llm === 'object' && input.llm.key ? input.llm.key : '';
  const llmModel = input.llm && typeof input.llm === 'object' && input.llm.model ? input.llm.model : '';
  const timeoutMs = input.researchTimeoutMs || 10000;

  if (!llmUrl) {
    return unavailable('no LLM endpoint configured');
  }

  const prompt = buildPrompt(loadPrompt(), context);
  const system = 'ATLAS BEAR agent. JSON only. Never invent data. Never output fields outside the schema.';

  const res = llm.maybeLLMJson({
    url: llmUrl,
    key: llmKey,
    model: llmModel,
    system,
    prompt,
    timeoutMs,
    validate: raw => validateBear(raw)
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

function contextLines(cand, t, q, m, metrics, integrity) {
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
  lines.push('  score: ' + (Number.isFinite(cand.score) ? cand.score : 'n/a'));
  lines.push('  buysPct: ' + (Number.isFinite(cand.buysPct) ? cand.buysPct.toFixed(0) : 'n/a') + '%');
  lines.push('  topHolderPct: ' + (Number.isFinite(cand.topHolderPct) ? cand.topHolderPct.toFixed(0) : 'n/a') + '%');
  lines.push('  tokenAgeDays: ' + (Number.isFinite(cand.tokenAgeDays) ? cand.tokenAgeDays.toFixed(0) : 'n/a'));
  lines.push('Technical: direction=' + (t.direction || 'n/a') + ', volatility=' + (Number.isFinite(t.volatility) ? t.volatility : 'n/a'));
  lines.push('Quant: expectedDirection=' + (q.expectedDirection || 'n/a') + ', confidence=' + (Number.isFinite(q.confidence) ? q.confidence : 'n/a'));
  lines.push('Quant: lossStreak=' + (Number.isFinite(metrics.lossStreak) ? metrics.lossStreak : 'n/a') + ', maxDrawdownPct=' + (Number.isFinite(metrics.maxDrawdownPct) ? metrics.maxDrawdownPct.toFixed(0) : 'n/a') + '%');
  lines.push('Market: regime=' + (m.regime || 'n/a') + ', health=' + (Number.isFinite(m.marketHealth) ? m.marketHealth : 'n/a') + (m.healthGate ? ', gate=active' : ''));
  if (integrity && integrity.dataQuality) lines.push('Price-integrity: dataQuality=' + integrity.dataQuality);
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

function validateBear(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not an object'] };
  if (!raw.agent || raw.agent !== 'bear-researcher') errors.push('invalid agent');
  if (!raw.candidate || typeof raw.candidate !== 'string') errors.push('missing candidate');
  if (!Number.isFinite(raw.timestamp)) errors.push('missing timestamp');
  if (!['bullish', 'bearish', 'neutral', 'unknown'].includes(raw.direction)) errors.push('invalid direction');
  if (Number.isFinite(raw.confidence)) raw.confidence = schema.clamp(raw.confidence); else errors.push('missing confidence');
  if (Number.isFinite(raw.score)) raw.score = schema.clamp(raw.score); else raw.score = 0;
  if (Number.isFinite(raw.riskScore)) raw.riskScore = schema.clamp(raw.riskScore); else raw.riskScore = 0;
  if (!Array.isArray(raw.case)) errors.push('case must be array');
  if (!Array.isArray(raw.warnings)) errors.push('warnings must be array');
  for (const k of Object.keys(raw)) {
    if (schema.FORBIDDEN.has(k.toLowerCase())) errors.push('forbidden field: ' + k);
  }
  return { ok: errors.length === 0, json: raw, errors };
}

function unavailable(reason) {
  return {
    agent: 'bear-researcher',
    candidate: '',
    timestamp: Date.now(),
    direction: 'unknown',
    confidence: 0,
    score: 0,
    riskScore: 0,
    case: ['No LLM reasoning available — bear case not constructed.'],
    warnings: ['llm_unavailable'],
    dataQuality: 'ok',
    unavailable: true
  };
}

module.exports = { analyze, loadPrompt };
