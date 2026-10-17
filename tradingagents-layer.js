#!/usr/bin/env node
/**
 * tradingagents-layer.js — TradingAgents-style MULTI-AGENT RESEARCH layer.
 *
 * ADDITIVE / ADVISORY ONLY. It sits beside the existing Circuit V1 strategy
 * and NEVER changes trading:
 *
 *   MARKET DATA → PRICE INTEGRITY → EXISTING CIRCUIT V1  (authoritative)
 *                                 → TRADINGAGENTS RESEARCH  (advisory)
 *
 * Modes:
 *   OFF      — TradingAgents disabled (no research, no writes).
 *   SHADOW   — (default) research runs, decisions are recorded to
 *              tradingagents-decisions.jsonl, trading behavior unchanged.
 *   ADVISORY — research results appear beside Circuit decisions (dashboard +
 *              candidates.json); deterministic Circuit rules remain
 *              authoritative. No research gate is ever created.
 *
 * The layer consumes the existing price-integrity verdict (never duplicates
 * it): suspicious / PAIR_CHANGED / stale observations make research report
 * dataQuality=suspicious and the Risk Analyst raises price_integrity_warning.
 *
 * No hallucinated data: every agent only reasons over supplied facts and
 * returns "unknown"/neutral when information is missing.
 *
 * Optional LLM: reuses llm-adapter.js (maybeLLMJson) for an advisory narrative
 * on the top candidate of a cycle. Deterministic research never depends on it.
 *
 * Persistence (inside the existing agent data dir):
 *   tradingagents-decisions.jsonl  — append-only research decisions
 *   tradingagents-metrics.json     — prediction-accuracy counters
 * No wallet / keys / signing / broadcast. Paper-only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const llmAdapter = require('./llm-adapter.js');
const technical = require('./agents/technical-analyst.js');
const quant = require('./agents/quant-analyst.js');
const sentiment = require('./agents/sentiment-analyst.js');
const market = require('./agents/market-analyst.js');
const bull = require('./agents/bull-researcher.js');
const bear = require('./agents/bear-researcher.js');
const risk = require('./agents/risk-analyst.js');
const synth = require('./agents/decision-synthesizer.js');

const counterfactualLib = require('./tradingagents-counterfactual.js');

const MODES = ['OFF', 'SHADOW', 'ADVISORY'];
const DEFAULT_MODE = 'SHADOW';
const DEFAULT_MAX_CANDIDATES_PER_CYCLE = 5;
const DEFAULT_MAX_DEBATE_ROUNDS = 2;
const DEFAULT_RESEARCH_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 60000;
const DECISIONS_FILE = 'tradingagents-decisions.jsonl';
const METRICS_FILE = 'tradingagents-metrics.json';
const AGENTS = ['technical', 'quant', 'sentiment', 'market', 'bull-researcher', 'bear-researcher', 'risk', 'decision-synthesizer'];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function nowIso(ts) {
  return new Date(ts).toISOString();
}

function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Read the LAST research decision row for a mint whose ts <= `until`. */
function readLastDecision(decisionsFile, mint, until) {
  try {
    if (!fs.existsSync(decisionsFile)) return null;
    const lines = fs.readFileSync(decisionsFile, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.mint === mint && r.ts != null && r.ts <= until) return r;
      } catch (_) { /* skip corrupt line */ }
    }
  } catch (_) { /* file missing/unreadable */ }
  return null;
}

function emptyBuckets() {
  return { n: 0, correct: 0, incorrect: 0 };
}

function blankMetrics() {
  return {
    version: 1,
    updatedAt: null,
    rowsEvaluated: 0,
    totals: emptyBuckets(),                       // synth (BUY/AVOID) directional predictions
    byRecommendation: { BUY: emptyBuckets(), HOLD: emptyBuckets(), AVOID: emptyBuckets() },
    byDirection: { bullish: emptyBuckets(), bearish: emptyBuckets() },
    byAgent: {
      technical: emptyBuckets(), quant: emptyBuckets(), sentiment: emptyBuckets(),
      market: emptyBuckets(), bull: emptyBuckets()
    },
    lastEvaluatedAt: null
  };
}

function mergeMetrics(base) {
  const m = blankMetrics();
  const raw = base && typeof base === 'object' ? base : {};
  const merge = (a, b) => {
    const o = emptyBuckets();
    if (b && typeof b === 'object') {
      o.n = Number(b.n) || 0;
      o.correct = Number(b.correct) || 0;
      o.incorrect = Number(b.incorrect) || 0;
    }
    if (a && typeof a === 'object') return { n: o.n + (Number(a.n) || 0), correct: o.correct + (Number(a.correct) || 0), incorrect: o.incorrect + (Number(a.incorrect) || 0) };
    return o;
  };
  m.updatedAt = raw.updatedAt || null;
  m.rowsEvaluated = Number(raw.rowsEvaluated) || 0;
  m.totals = merge(raw.totals, m.totals);
  for (const k of ['BUY', 'HOLD', 'AVOID']) m.byRecommendation[k] = merge((raw.byRecommendation || {})[k], m.byRecommendation[k]);
  for (const k of ['bullish', 'bearish']) m.byDirection[k] = merge((raw.byDirection || {})[k], m.byDirection[k]);
  for (const k of Object.keys(m.byAgent)) m.byAgent[k] = merge((raw.byAgent || {})[k], m.byAgent[k]);
  m.lastEvaluatedAt = raw.lastEvaluatedAt || null;
  return m;
}

/**
 * Pure prediction evaluator for one research row vs a realized outcome.
 * Returns an array of { bucket, kind, correct } records. Directional calls
 * only count when a real view was expressed (HOLD / flat / unknown / neutral
 * are NOT counted as predictions): a bullish call is correct when the trade
 * won; a bearish call (BUY→…/AVOID/regime-down/…) is correct when it lost.
 */
function evaluatePrediction(row, pnlPct) {
  const out = [];
  if (!row || !Number.isFinite(pnlPct) || pnlPct === 0) return out;
  const won = pnlPct > 0;
  const add = (bucket, kind) => {
    if (!kind) return;
    out.push({ bucket, kind, correct: kind === 'bullish' ? won : !won });
  };
  // Synthesizer (recommendation-level) prediction.
  if (row.researchRecommendation === 'BUY') add('byRecommendation:BUY', 'bullish');
  else if (row.researchRecommendation === 'AVOID') add('byRecommendation:AVOID', 'bearish');
  // Agent-level directional predictions.
  const tech = row.technical || {};
  const qua = row.quant || {};
  const sen = row.sentiment || {};
  const mar = row.market || {};
  const bul = row.bull || {};
  if (tech.direction === 'bullish') add('byAgent:technical', 'bullish');
  else if (tech.direction === 'bearish') add('byAgent:technical', 'bearish');
  if (qua.expectedDirection === 'up') add('byAgent:quant', 'bullish');
  else if (qua.expectedDirection === 'down') add('byAgent:quant', 'bearish');
  if (sen.direction === 'bullish') add('byAgent:sentiment', 'bullish');
  else if (sen.direction === 'bearish') add('byAgent:sentiment', 'bearish');
  if (mar.regime === 'bull') add('byAgent:market', 'bullish');
  else if (mar.regime === 'dump' || mar.regime === 'recovery') add('byAgent:market', 'bearish');
  if (Number(bul.confidence) >= 55) add('byAgent:bull', 'bullish');
  return out;
}

/** Apply evaluated records to a metrics object (in place). */
function applyEvaluations(m, evaluations) {
  for (const ev of evaluations) {
    if (ev.bucket.indexOf('byRecommendation:') === 0) {
      const rec = ev.bucket.split(':')[1];
      const b = (m.byRecommendation[rec] = m.byRecommendation[rec] || emptyBuckets());
      b.n += 1; if (ev.correct) b.correct += 1; else b.incorrect += 1;
      m.byRecommendation[rec] = b;
    } else if (ev.bucket.indexOf('byAgent:') === 0) {
      const agentName = ev.bucket.split(':')[1];
      const b = (m.byAgent[agentName] = m.byAgent[agentName] || emptyBuckets());
      b.n += 1; if (ev.correct) b.correct += 1; else b.incorrect += 1;
      m.byAgent[agentName] = b;
    }
  }
  // totals = synth-level directional (BUY/AVOID) predictions.
  const t = m.totals || emptyBuckets();
  t.n = (m.byRecommendation.BUY.n + m.byRecommendation.AVOID.n) || 0;
  t.correct = (m.byRecommendation.BUY.correct + m.byRecommendation.AVOID.correct) || 0;
  t.incorrect = (m.byRecommendation.BUY.incorrect + m.byRecommendation.AVOID.incorrect) || 0;
  m.totals = t;
  // byDirection mirrors the synth predictions split by direction (display).
  m.byDirection.bullish = Object.assign({}, m.byRecommendation.BUY);
  m.byDirection.bearish = Object.assign({}, m.byRecommendation.AVOID);
  return m;
}

/** Safe fallback for a failed analyst (failure isolation — one never crashes the cycle). */
function safeAgent(agentName, fn) {
  try {
    const r = fn();
    return r && typeof r === 'object' ? r : { agent: agentName, unavailable: true, reasoning: ['empty analyst output'] };
  } catch (err) {
    return { agent: agentName, unavailable: true, error: String(err && err.message || err), reasoning: ['analyst unavailable: ' + String(err && err.message || err)] };
  }
}

/** Per-mint price-integrity facts consumed by research (report only). */
function integrityFor(snapshot, mint) {
  const snap = snapshot || {};
  const quarantined = Array.isArray(snap.quarantined) ? snap.quarantined : [];
  const q = quarantined.find((x) => x && x.mint === mint);
  const reasons = [];
  if (q) reasons.push('suspicious:EXTREME_PRICE_MOVE quarantine');
  const lw = snap.lastWarning;
  if (lw && lw.mint === mint && lw.reason) reasons.push(String(lw.reason));
  const dataQuality = (q || (lw && lw.mint === mint)) ? 'suspicious' : 'ok';
  return { dataQuality, reasons, quarantined: !!q };
}

/** Normalize a position into analyst-friendly facts (honest unknowns where data is absent). */
function positionToCandidate(pos) {
  return {
    symbol: pos.symbol,
    mint: pos.mint,
    pairAddress: pos.pairAddress || null,
    dex: pos.dex || null,
    priceUsd: Number.isFinite(pos.currentPriceUsd) ? pos.currentPriceUsd : null,
    priceSol: Number.isFinite(pos.currentPriceSol) ? pos.currentPriceSol : null,
    // Unknowns are reported as missing (never invented):
    liquidityUsd: null,
    volume24hUsd: null,
    change1hPct: null,
    change5mPct: null,
    recoveryPct: null,
    recoveryStatus: 'unknown',
    score: Number.isFinite(pos.entryScore) ? pos.entryScore : null
  };
}

/* ------------------------------------------------------------------ *
 * createTradingAgents
 * ------------------------------------------------------------------ */

/**
 * options:
 *   dataDir, mode, maxCandidatesPerCycle, maxDebateRounds,
 *   researchTimeoutMs, cacheTtlMs, llm: {url,key,model} (reuses the adaptive
 *   LLM endpoint — optional), log(msg)
 */
const DEFAULT_AGENT_IMPLS = {
  technical, quant, sentiment, market,
  'bull-researcher': bull, 'bear-researcher': bear, risk,
  'decision-synthesizer': synth
};

function createTradingAgents(options = {}) {
  const dataDir = options.dataDir || process.cwd();
  // Injectable per-agent implementations (tests simulate analyst failures).
  const agentImpls = Object.assign({}, DEFAULT_AGENT_IMPLS, options.agents || {});
  const decisionsFile = path.join(dataDir, DECISIONS_FILE);
  const metricsFile = path.join(dataDir, METRICS_FILE);
  const rawMode = String(options.mode != null ? options.mode : DEFAULT_MODE).toUpperCase();
  const mode = MODES.includes(rawMode) ? rawMode : DEFAULT_MODE;
  const maxCandidatesPerCycle = Math.max(1, parseInt(options.maxCandidatesPerCycle, 10) || DEFAULT_MAX_CANDIDATES_PER_CYCLE);
  const maxDebateRounds = Math.max(0, parseInt(options.maxDebateRounds, 10) || DEFAULT_MAX_DEBATE_ROUNDS);
  const researchTimeoutMs = Math.max(1000, parseInt(options.researchTimeoutMs, 10) || DEFAULT_RESEARCH_TIMEOUT_MS);
  const cacheTtlMs = Math.max(0, parseInt(options.cacheTtlMs, 10) || DEFAULT_CACHE_TTL_MS);
  const llm = (options.llm && typeof options.llm === 'object') ? options.llm : {};
  const log = typeof options.log === 'function' ? options.log : () => {};

  const cache = new Map();   // `${type}|${mint}` -> { ts, row }
  let lastResults = new Map(); // mint -> row (most recent committed)
  let metrics = mergeMetrics(loadMetrics());
  let metricsDirty = false;

  /* ---- Counterfactual journal (§4-§21 validation layer). -------------- */
  let counterfactual = null;
  try {
    counterfactual = counterfactualLib.createCounterfactualJournal({
      dataDir,
      log
    });
  } catch (_) { /* best effort — journal failure never blocks research */ }

  const state = {
    mode,
    enabled: mode !== 'OFF',
    lastRunAt: null,
    lastCommitAt: null,
    cycles: 0,
    counters: { candidatesResearched: 0, positionsResearched: 0, decisionsLogged: 0, failedAgents: 0, llmNotes: 0 },
    latest: null,       // most recent committed candidate row (summary)
    lastPositionAssessments: [], // recent position assessments (summaries)
    lastErrors: []
  };

  function loadMetrics() {
    try {
      if (fs.existsSync(metricsFile)) return JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
    } catch (_) { /* corrupt → fresh */ }
    return null;
  }

  function persistMetrics() {
    if (!metricsDirty) return;
    metricsDirty = false;
    metrics.updatedAt = Date.now();
    try { atomicWriteJson(metricsFile, metrics); } catch (_) { /* best effort */ }
  }

  function appendLine(obj) {
    fs.appendFileSync(decisionsFile, JSON.stringify(obj) + '\n');
  }

  function pushError(msg) {
    state.lastErrors.push({ ts: Date.now(), msg: String(msg).slice(0, 300) });
    if (state.lastErrors.length > 8) state.lastErrors.shift();
  }

  /**
   * Run the tiered research pipeline for the top candidates + open positions.
   * Pure compute — rows are committed (logged) separately via commit() so the
   * caller can attach the real Circuit decision first.
   * ctx = { portfolio, metrics, regime, health, market, integrity,
   *         historyByMint, universe }
   */
  function runCycle({ candidates = [], positions = [], ctx = {}, now } = {}) {
    if (mode === 'OFF') return { rows: [], summary: null };
    const ts = now != null ? now : Date.now();
    state.lastRunAt = ts;

    const targets = [];
    for (const cand of (Array.isArray(candidates) ? candidates : []).slice(0, maxCandidatesPerCycle)) {
      if (cache.get('candidate|' + cand.mint) && ts - cache.get('candidate|' + cand.mint).ts < cacheTtlMs) continue;
      targets.push({ type: 'candidate', cand });
    }
    for (const pos of (Array.isArray(positions) ? positions : [])) {
      if (cache.get('position|' + pos.mint) && ts - cache.get('position|' + pos.mint).ts < cacheTtlMs) continue;
      targets.push({ type: 'position', pos });
    }
    if (!targets.length) return { rows: [], summary: null };

    const rows = [];
    const integritySnap = ctx.integrity || {};
    const historyByMint = ctx.historyByMint || {};
    const base = {
      portfolio: ctx.portfolio || {},
      metrics: ctx.metrics || {},
      regime: ctx.regime || {},
      health: ctx.health || null,
      market: ctx.market || {},
      universe: ctx.universe || {}
    };

    for (const target of targets) {
      const isCandidate = target.type === 'candidate';
      const cand = isCandidate ? target.cand : positionToCandidate(target.pos);
      if (!cand || !cand.mint) continue;
      const hist = historyByMint[cand.mint] || { samples: [], warming: isCandidate ? cand.recoveryStatus === 'warming' : true };
      const integrity = integrityFor(integritySnap, cand.mint);
      const inputs = Object.assign({}, base, {
        candidate: cand,
        history: hist,
        integrity
      });

      const t = safeAgent('technical', () => agentImpls.technical.analyze(inputs));
      const q = safeAgent('quant', () => agentImpls.quant.analyze(inputs));
      const s = safeAgent('sentiment', () => agentImpls.sentiment.analyze(Object.assign({}, inputs, { market: base.market })));
      const m = safeAgent('market', () => agentImpls.market.analyze(Object.assign({}, inputs, { market: base.market, portfolio: base.portfolio })));
      // Bull then Bear (Bear sees the Bull case + integrity) — deterministic debate.
      const b = safeAgent('bull-researcher', () => agentImpls['bull-researcher'].analyze(Object.assign({}, inputs, { technical: t, quant: q, sentiment: s, market: m })));
      const be = safeAgent('bear-researcher', () => agentImpls['bear-researcher'].analyze(Object.assign({}, inputs, {
        technical: t, quant: q, market: m, metrics: base.metrics, integrity
      })));
      const rk = safeAgent('risk', () => agentImpls.risk.analyze(Object.assign({}, inputs, {
        technical: t, market: m, bear: be, metrics: base.metrics,
        integrity,
        exposure: { openPositions: isCandidate ? (base.portfolio.positionsOpen || 0) : 1, maxPositions: base.portfolio.maxPositions || 5 }
      })));
      const dc = safeAgent('decision-synthesizer', () => agentImpls['decision-synthesizer'].synthesize(Object.assign({}, inputs, {
        symbol: cand.symbol, mint: cand.mint, pairAddress: cand.pairAddress || null,
        technical: t, quant: q, sentiment: s, market: m, bull: b, bear: be, risk: rk, integrity,
        circuitScore: cand.score != null ? cand.score : null
      })));

      const failedAgents = [t, q, s, m, b, be, rk, dc].filter((x) => x.unavailable).length;
      state.counters.failedAgents += failedAgents;
      const row = {
        type: isCandidate ? 'candidate' : 'position',
        ts,
        iso: nowIso(ts),
        symbol: dc.symbol || cand.symbol || null,
        mint: cand.mint,
        pairAddress: cand.pairAddress || null,
        dex: cand.dex || null,
        mode,
        circuitScore: dc.circuitScore != null ? dc.circuitScore : null,
        researchScore: dc.researchScore != null ? dc.researchScore : null,
        researchRecommendation: isCandidate ? dc.researchRecommendation : 'HOLD',
        researchConfidence: dc.researchConfidence != null ? dc.researchConfidence : null,
        consensus: dc.consensus || 'mixed',
        riskLevel: dc.riskLevel || 'medium',
        dataQuality: integrity.dataQuality,
        // Synthesizer component scores (research only — Circuit score untouched):
        technicalScore: dc.technicalScore != null ? dc.technicalScore : null,
        quantScore: dc.quantScore != null ? dc.quantScore : null,
        sentimentScore: dc.sentimentScore != null ? dc.sentimentScore : null,
        marketScore: dc.marketScore != null ? dc.marketScore : null,
        bullScore: dc.bullScore != null ? dc.bullScore : null,
        bearRisk: dc.bearRisk != null ? dc.bearRisk : null,
        technical: t, quant: q, sentiment: s, market: m,
        bull: b, bear: be, risk: rk,
        positionAssessment: !isCandidate ? assessPosition(dc, rk, be, integrity) : null,
        reasons: (dc.reasons || []).slice(0, 12),
        warnings: (dc.warnings || []).slice(0, 12),
        circuitDecision: null, // patched by the caller after the BUY pass
        finalDecision: null,
        _cand: isCandidate ? cand : null // internal reference — stripped on commit
      };
      rows.push(row);
      if (isCandidate) state.counters.candidatesResearched += 1;
      else state.counters.positionsResearched += 1;
    }
    return { rows, summary: { rows: rows.length, ts } };
  }

  /** Position assessment for open positions (research has NO sell authority). */
  function assessPosition(decision, riskOut, bearOut, integrity) {
    const riskScore = Number((riskOut && riskOut.riskScore) || 0);
    const bearRisk = Number((bearOut && bearOut.riskScore) || 0);
    const researchScore = Number(decision && decision.researchScore) || 0;
    let assessment = 'hold';
    if (integrity.dataQuality === 'suspicious') assessment = 'high_risk';
    else if (riskScore >= 75 || bearRisk >= 75) assessment = 'high_risk';
    else if (riskScore >= 55 || bearRisk >= 55) assessment = 'caution';
    else if (researchScore < 40) assessment = 'caution';
    return {
      positionAssessment: assessment,
      confidence: Math.round(clamp(researchScore, 0, 100)),
      reasons: [
        `risk ${riskScore}/100 (${(riskOut && riskOut.riskLevel) || 'medium'})`,
        integrity.dataQuality !== 'ok' ? 'price-integrity suspicious — hold at last valid price' : 'price-integrity ok'
      ]
    };
  }

  /**
   * Append computed rows to tradingagents-decisions.jsonl. Call AFTER the BUY
   * pass so each row carries the real Circuit decision.
   */
  function commit(rows = []) {
    if (mode === 'OFF') return rows.length;
    const ts = Date.now();
    let logged = 0;
    for (const row of rows) {
      if (!row || !row.mint) continue;
      row.ts = row.ts || ts;
      row.iso = row.iso || nowIso(row.ts);
      row.circuitDecision = row.circuitDecision || (row.type === 'position' ? 'HOLD' : 'FILTER');
      row.finalDecision = row.circuitDecision; // deterministic execution stays authoritative
      if (row.researchRecommendation === null || row.researchRecommendation === undefined) {
        row.researchRecommendation = row.type === 'position' ? 'HOLD' : 'HOLD';
      }
      const clean = Object.assign({}, row);
      delete clean._cand;
      try { appendLine(clean); logged += 1; } catch (err) { pushError('append failed: ' + err.message); }
      const cacheKey = (row.type || 'candidate') + '|' + row.mint;
      cache.set(cacheKey, { ts: row.ts, row });
      lastResults.set(row.mint, clean);
      if (row.type === 'position') {
        state.lastPositionAssessments = state.lastPositionAssessments.slice(-9).concat({
          ts: row.ts, symbol: row.symbol, mint: row.mint,
          assessment: row.positionAssessment, riskLevel: row.riskLevel, dataQuality: row.dataQuality
        });
      }
    }
    if (logged) {
      state.counters.decisionsLogged += logged;
      state.lastCommitAt = Date.now();
      // `latest` must always be a CANDIDATE research row (position rows are
      // assessments and must not replace the latest candidate consensus).
      const topCandidate = rows.find((r) => r.type === 'candidate');
      if (topCandidate) {
        state.latest = {
          ts: topCandidate.ts,
          symbol: topCandidate.symbol,
          mint: topCandidate.mint,
          researchScore: topCandidate.researchScore,
          circuitScore: topCandidate.circuitScore,
          recommendation: topCandidate.researchRecommendation,
          consensus: topCandidate.consensus,
          riskLevel: topCandidate.riskLevel,
          dataQuality: topCandidate.dataQuality,
          circuitDecision: topCandidate.circuitDecision,
          technicalScore: topCandidate.technicalScore != null ? topCandidate.technicalScore : null,
          quantScore: topCandidate.quantScore != null ? topCandidate.quantScore : null,
          sentimentScore: topCandidate.sentimentScore != null ? topCandidate.sentimentScore : null,
          marketScore: topCandidate.marketScore != null ? topCandidate.marketScore : null,
          bullScore: topCandidate.bullScore != null ? topCandidate.bullScore : null,
          bearRisk: topCandidate.bearRisk != null ? topCandidate.bearRisk : null,
          researchMode: topCandidate.mode
        };
      }
    }
    /* Record counterfactual predictions for BUY candidates (§4). */
    try {
      recordCounterfactualPredictions(rows);
    } catch (_) { /* best effort — never blocks commit */ }

    return logged;
  }

  /** Optional LLM narrative for the top research row (async, advisory only). */
  async function enrichTopRow(rows = []) {
    if (mode === 'OFF' || !llm.url) return null;
    const row = rows.find((r) => r.type === 'candidate') || rows[0];
    if (!row) return null;
    const brief = [
      `Token: ${row.symbol} (${row.mint})`,
      `Research: score ${row.researchScore}, recommendation ${row.researchRecommendation}, consensus ${row.consensus}`,
      `Technical ${row.technical && row.technical.direction}/${row.technical && row.technical.confidence}, ` +
        `quant ${row.quant && row.quant.expectedDirection}, sentiment ${row.sentiment && row.sentiment.direction}, ` +
        `market ${row.market && row.market.regime}`,
      `Bull ${row.bull && row.bull.confidence}, bear risk ${row.bear && row.bear.riskScore}, risk ${row.risk && row.risk.riskLevel}`,
      row.warnings && row.warnings.length ? 'Warnings: ' + row.warnings.join('; ') : 'No warnings.',
      'You may ONLY reason from these facts. Reply JSON: {"narrative": "1-2 sentence summary", "concern": "short concern or null"}.'
    ].join('\n');
    try {
      const res = await llmAdapter.maybeLLMJson({
        url: llm.url, key: llm.key, model: llm.model,
        system: 'Advisory research narrator for a PAPER-ONLY Solana agent. JSON only, no execution fields, no invented data.',
        prompt: brief,
        timeoutMs: researchTimeoutMs,
        validate: (raw) => {
          const errors = [];
          let narrative = null;
          let concern = null;
          if (typeof raw.narrative === 'string') narrative = String(raw.narrative).slice(0, 600);
          else errors.push('narrative missing');
          if (raw.concern == null) concern = null;
          else if (typeof raw.concern === 'string') concern = String(raw.concern).slice(0, 300);
          else errors.push('concern must be a string or null');
          return errors.length && !narrative ? { ok: false, errors } : { ok: true, json: { narrative, concern }, errors };
        }
      });
      if (res && res.ok && res.json) {
        const note = { type: 'llm-note', ts: Date.now(), iso: nowIso(Date.now()), symbol: row.symbol, mint: row.mint, note: res.json };
        try { appendLine(note); state.counters.llmNotes += 1; return note; } catch (err) { pushError('llm note append failed'); }
      }
      return null;
    } catch (_) {
      return null; // LLM failure never affects research or trading
    }
  }

  /**
   * Evaluate a closed trade against the research recorded for that mint.
   * Returns { found, evaluations, row }.
   */
  function recordTradeOutcome({ mint, pnlPct, entryTs, sellTs } = {}) {
    if (mode === 'OFF' || !mint || !Number.isFinite(pnlPct)) return { found: false, evaluations: [] };
    const row = readLastDecision(decisionsFile, mint, entryTs || sellTs || Date.now());
    if (!row) return { found: false, evaluations: [] };
    const evaluations = evaluatePrediction(row, pnlPct);
    if (evaluations.length) {
      metrics = applyEvaluations(metrics, evaluations);
      metrics.rowsEvaluated += 1;
      metrics.lastEvaluatedAt = Date.now();
      metricsDirty = true;
      persistMetrics();
    }
    return { found: true, evaluations, row };
  }

  /**
   * Record counterfactual predictions for every candidate row that
   * passed the BUY filter (circuitDecision === 'BUY'). Called after commit.
   * §4: snapshot MUST NOT contain future information.
   */
  function recordCounterfactualPredictions(rows) {
    if (!counterfactual || mode === 'OFF') return;
    for (const row of rows) {
      if (!row || row.type !== 'candidate' || !row._cand) continue;
      const cand = row._cand;
      /* Only record predictions for candidates that actually pass the BUY
       * filter — this is the counterfactual "what if we followed TA?" */
      if (row.circuitDecision !== 'BUY' && row.circuitDecision !== 'FILTER') continue;
      if (row.circuitDecision !== 'BUY') continue; // §4: only BUY candidates

      const ta = row.researchRecommendation || 'HOLD';
      const confidence = row.researchConfidence != null ? row.researchConfidence
        : (row.researchScore != null ? row.researchScore : null);

      /* Map agent outputs into the flat agents object expected by the journal. */
      const agents = {
        technical: row.technical || null,
        quant: row.quant || null,
        sentiment: row.sentiment || null,
        market: row.market || null,
        bull: row.bull || null,
        bear: row.bear || null,
        risk: row.risk || null
      };

      const snapshot = {
        timestamp: row.ts || Date.now(),
        mint: row.mint,
        symbol: row.symbol,

        marketObservation: {
          price: cand.priceUsd || null,
          priceSol: cand.priceSol || null,
          pairAddress: cand.pairAddress || null,
          dex: cand.dex || null,
          priceAgeMs: null,
          integrityStatus: row.dataQuality || 'ok'
        },

        circuitDecision: {
          decision: row.circuitDecision || 'FILTER',
          score: row.circuitScore != null ? row.circuitScore : null,
          minScore: null,
          recovery5m: cand.recoveryPct != null ? cand.recoveryPct : null,
          change1h: cand.change1hPct != null ? cand.change1hPct : null
        },

        tradingAgents: {
          mode,
          recommendation: ta,
          confidence,
          researchScore: row.researchScore != null ? row.researchScore : null,
          riskLevel: row.riskLevel || 'medium',
          consensus: row.consensus || 'mixed'
        },

        agents,

        counterfactual: {
          hypotheticalEntryPrice: cand.priceSol || null,
          hypotheticalEntryTime: row.ts || Date.now(),
          hypotheticalSize: null,
          hypotheticalDecision: ta
        }
      };

      try {
        if (row.dataQuality !== 'ok' && row.dataQuality !== undefined) {
          counterfactual.recordPredictionWithIntegrity(snapshot);
        } else {
          counterfactual.recordPrediction(snapshot);
        }
      } catch (_) { /* journal failure never blocks research */ }
    }
  }

  /** Live summary for heartbeat / dashboard. */
  function snapshot() {
    const t = metrics.totals || emptyBuckets();
    const acc = t.n ? Math.round((t.correct / t.n) * 1000) / 10 : null;
    return {
      enabled: state.enabled,
      mode,
      agents: AGENTS,
      lastRunAt: state.lastRunAt,
      lastCommitAt: state.lastCommitAt,
      cycles: state.cycles,
      counters: Object.assign({}, state.counters),
      accuracy: {
        n: t.n, correct: t.correct, incorrect: t.incorrect,
        pct: acc,
        byRecommendation: metrics.byRecommendation,
        byAgent: metrics.byAgent,
        rowsEvaluated: metrics.rowsEvaluated,
        lastEvaluatedAt: metrics.lastEvaluatedAt
      },
      latest: state.latest,
      lastPositionAssessments: state.lastPositionAssessments.slice(-5),
      lastErrors: state.lastErrors.slice(-3)
    };
  }

  /** Return the counterfactual journal (for resolution + dashboard). */
  function getCounterfactual() {
    return counterfactual;
  }

  function lastResultFor(mint) {
    return mint ? lastResults.get(mint) || null : null;
  }

  /** Called at the start of each discovery cycle that may produce research. */
  function tickCycleStart() {
    state.cycles += 1;
    if (state.cycles % 100 === 0 && mode !== 'OFF') log(`cycles=${state.cycles} researched=${state.counters.candidatesResearched} decisions=${state.counters.decisionsLogged} accuracy=${(snapshot().accuracy.pct == null ? 'n/a' : snapshot().accuracy.pct + '%')}`);
  }

  return {
    mode: () => mode,
    enabled: () => state.enabled,
    runCycle,
    commit,
    enrichTopRow,
    recordTradeOutcome,
    snapshot,
    getCounterfactual,
    recordCounterfactualPredictions,
    lastResultFor,
    persistMetrics,
    tickCycleStart,
    resetCache: () => cache.clear(),
    state: () => state
  };
}

module.exports = {
  createTradingAgents,
  evaluatePrediction,
  applyEvaluations,
  blankMetrics,
  readLastDecision,
  integrityFor,
  counterfactualLib,
  MODES,
  DEFAULT_MODE,
  DEFAULT_MAX_CANDIDATES_PER_CYCLE,
  DEFAULT_MAX_DEBATE_ROUNDS,
  DEFAULT_RESEARCH_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_MS,
  DECISIONS_FILE,
  METRICS_FILE,
  AGENTS
};
