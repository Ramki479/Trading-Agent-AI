#!/usr/bin/env node
/**
 * atlas/agents/bull.js — ATLAS Bull Agent (LLM reasoning).
 *
 * Constructs the strongest possible case FOR the trade using ONLY supplied facts.
 * Fails safe (UNAVAILABLE) when the LLM endpoint is unavailable; deterministic
 * fallback returns confidence 0 with an honest "no LLM available" note.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const llm = require('../../llm-adapter.js'); // reuse existing adapter (optional)
const schema = require('../schemas.js');

let promptTemplate = null;
function loadPrompt() {
  if (promptTemplate) return promptTemplate;
  try {
    const p = path.join(__dirname, '..', 'prompts', 'bull.json');
    promptTemplate = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    promptTemplate = defaultPrompt();
  }
  return promptTemplate;
}

function defaultPrompt() {
  return {
    name: 'bull',
    instructions: [
      'You are the ATLAS BULL agent. Construct the strongest possible case FOR the trade using ONLY the facts provided.',
      'Never invent prices, volumes, liquidity, market cap, transaction counts, news, social posts, or token announcements.',
      'If a fact is missing, say NO_DATA.',
      'Output JSON only.'
    ],
    schema: {
      required: ['agent', 'candidate', 'timestamp', 'direction', 'confidence', 'score', 'thesis', 'case', 'supportingEvidence'],
      agent: { const: 'bull-researcher' }
    }
  };
}

function analyze(input = {}) {
  const cand = input.candidate || {};
  const t = input.technical || {};
  const q = input.quant || {};
  const s = input.sentiment || {};
  const m = input.market || {};

  // Build a fact-only context — never invent numbers
  const context = contextLines(cand, t, q, s, m, input.integrity);

  const llmUrl = input.llm && typeof input.llm === 'object' && input.llm.url ? input.llm.url : null;
  const llmKey = input.llm && typeof input.llm === 'object' && input.llm.key ? input.llm.key : '';
  const llmModel = input.llm && typeof input.llm === 'object' && input.llm.model ? input.llm.model : '';
  const timeoutMs = input.researchTimeoutMs || 10000;

  if (!llmUrl) {
    return unavailable('no LLM endpoint configured');
  }

  const prompt = buildPrompt(loadPrompt(), context);
  const system = 'ATLAS BULL agent. JSON only. Never invent data. Never output fields outside the schema.';

  const res = llm.maybeLLMJson({
    url: llmUrl,
    key: llmKey,
    model: llmModel,
    system,
    prompt,
    timeoutMs,
    validate: raw => validateBull(raw)
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
    dataQuality: input.integrity && input.integrity.dataQuality ? input.integrity.dataQuality : 'ok',
    unavailable: false
  });
}

function contextLines(cand, t, q, s, m, integrity) {
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
  lines.push('Technical: direction=' + (t.direction || 'n/a') + ', confidence=' + (Number.isFinite(t.confidence) ? t.confidence : 'n/a'));
  lines.push('Quant: expectedDirection=' + (q.expectedDirection || 'n/a') + ', confidence=' + (Number.isFinite(q.confidence) ? q.confidence : 'n/a') + ', setupQuality=' + (Number.isFinite(q.setupQuality) ? q.setupQuality : 'n/a'));
  lines.push('Sentiment: direction=' + (s.direction || 'n/a') + ', confidence=' + (Number.isFinite(s.confidence) ? s.confidence : 'n/a'));
  lines.push('Market: regime=' + (m.regime || 'n/a') + ', health=' + (Number.isFinite(m.marketHealth) ? m.marketHealth : 'n/a'));
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

function validateBull(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not an object'] };
  if (!raw.agent || raw.agent !== 'bull-researcher') errors.push('invalid agent');
  if (!raw.candidate || typeof raw.candidate !== 'string') errors.push('missing candidate');
  if (!Number.isFinite(raw.timestamp)) errors.push('missing timestamp');
  if (!['bullish', 'bearish', 'neutral', 'unknown'].includes(raw.direction)) errors.push('invalid direction');
  if (Number.isFinite(raw.confidence)) raw.confidence = schema.clamp(raw.confidence); else errors.push('missing confidence');
  if (Number.isFinite(raw.score)) raw.score = schema.clamp(raw.score); else raw.score = 0;
  if (!Array.isArray(raw.case)) errors.push('case must be array');
  if (!Array.isArray(raw.supportingEvidence)) errors.push('supportingEvidence must be array');
  // forbidden fields
  for (const k of Object.keys(raw)) {
    if (schema.FORBIDDEN.has(k.toLowerCase())) errors.push('forbidden field: ' + k);
  }
  return { ok: errors.length === 0, json: raw, errors };
}

function unavailable(reason) {
  return {
    agent: 'bull-researcher',
    candidate: '',
    timestamp: Date.now(),
    direction: 'unknown',
    confidence: 0,
    score: 0,
    thesis: 'LLM unavailable: ' + reason,
    case: ['No LLM reasoning available — bullish case not constructed.'],
    supportingEvidence: [],
    riskScore: 0,
    warnings: ['llm_unavailable'],
    dataQuality: 'ok',
    unavailable: true
  };
}

module.exports = { analyze, loadPrompt };
