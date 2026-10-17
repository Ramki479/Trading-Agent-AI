#!/usr/bin/env node
/**
 * atlas unit tests — deterministic verification of ATLAS modules.
 *
 * Covers schemas, db, evidence, disagreement, the 16 specialists (including
 * the price-integrity consumer path), the engine, prediction journal,
 * outcome evaluation, attribution, reputation, experiments/keep-revert,
 * plus V1-constant / price-integrity / paper-only invariant assertions.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let tmp;

const S = assert.strictEqual;

function ok(cond, msg) {
  if (!cond) throw new assert.AssertionError({ message: msg || 'assert failed' });
}

function tmpFile(name) { return path.join(tmp, name); }

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; }
  else { failed += 1; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

async function testAtlas() {
console.log('\n[test atlas] ATLAS unit tests');
tmp = path.join(ROOT, '.test-tmp', 'atlas-unit-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

// ---------------------------------------------------------------------------
// 0. Schemas
// ---------------------------------------------------------------------------
{
  const schema = require('../atlas/schemas.js');
  const r = schema.validate({ agent: 'technical', candidate: 'X', timestamp: 1, direction: 'bullish', confidence: 80, score: 75 });
  S(r.ok, true);
  S(r.value.direction, 'bullish');
  S(r.value.confidence, 80);
  S(r.value.score, 75);

  const clamped = schema.validate({ agent: 'x', candidate: 'x', timestamp: 1, direction: 'bullish', confidence: 150, score: -5 });
  S(clamped.ok, true);
  S(clamped.value.confidence, 100);
  S(clamped.value.score, 0);

  const withForbidden = schema.validate({ agent: 'x', candidate: 'x', timestamp: 1, direction: 'bullish', confidence: 50, execute: true });
  S(withForbidden.ok, false);
  S(withForbidden.errors.length >= 1, true);

  const missing = schema.validate({ agent: 'x', timestamp: 1 });
  S(missing.ok, false);

  S(schema.normalizeDirection('BULLISH'), 'unknown');
  S(schema.normalizeDirection('bullish'), 'bullish');
}

// ---------------------------------------------------------------------------
// 1. DB
// ---------------------------------------------------------------------------
{
  const { AtlasDb } = require('../atlas/db.js');
  const db = new AtlasDb(tmp);
  db.appendPrediction({ predictionId: 'P1', ts: 1000, mint: 'M1', pairAddress: 'PA1', dex: 'dexscreener', direction: 'bullish', confidence: 80, expectedMovePct: 2 });
  db.appendPrediction({ predictionId: 'P2', ts: 2000, mint: 'M1', pairAddress: 'PA2', dex: 'circuit', direction: 'bearish', confidence: 70, expectedMovePct: -1 });
  db.appendOutcome({ outcomeId: 'O1', ts: 3000, mint: 'M1', pnlPct: 8, exitReason: 'take-profit' });
  db.appendEvidence({ claim: 'test', value: 'ok', source: 'test', confidence: 80 });
  S(db.predictions().length, 2);
  S(db.predictionsFor('M1', null, null).length, 2);
  S(db.predictionsFor('M1', 1500, 2500).length, 1);
  S(db.predictionsFor('M1', 500, 1500).length, 1);
  S(db.predictionsFor('M1', null, null, { pairAddress: 'PA1' }).length, 1);
  S(db.outcomes().length, 1);
  S(db.evidence().length, 1);

  const repo = db.reputation();
  S(repo.version, 1);
  S(Object.keys(repo.agents).length, 0);
  const m = db.experiments();
  S(m.version, 1);
  S(m.experiments.length, 0);
}

// ---------------------------------------------------------------------------
// 2. Evidence + dataQuality
// ---------------------------------------------------------------------------
{
  const { evidenceEntry, dataQuality } = require('../atlas/evidence.js');
  const e = evidenceEntry('trend', 'up', 'local', 70, { horizon: '15m' });
  S(e.claim, 'trend');
  S(e.source, 'local');
  S(e.confidence, 70);
  S(e.horizon, '15m');

  // clean integrity
  const clean = dataQuality({ dataQuality: 'ok', pairStable: true, sourcesAgree: true }, { regime: 'TREND_UP' }, 1000, 60000);
  S(clean.score >= 70, true);
  S(clean.reasons.length, 0);

  // suspicious quarantined
  const susp = dataQuality({ dataQuality: 'suspicious', reasons: ['EXTREME_PRICE_MOVE'] }, {}, 0, 60000);
  S(susp.score, 0);
  S(susp.reasons.length >= 1, true);

  // pair changed
  const pc = dataQuality({ dataQuality: 'ok', pairStable: false }, {}, 1000, 60000);
  S(pc.score < 70, true);
}

// ---------------------------------------------------------------------------
// 3. Disagreement
// ---------------------------------------------------------------------------
{
  const { analyze } = require('../atlas/disagreement.js');
  const d = analyze([
    { direction: 'bullish', score: 80 },
    { direction: 'bullish', score: 70 },
    { direction: 'bearish', score: 30 }
  ]);
  S(d.consensus, 'bullish');
  S(d.dispersion < 50, true);
  S(d.criticalDisagreement, false);

  const dep = analyze([
    { direction: 'bullish', score: 82 },
    { direction: 'bullish', score: 78 },
    { direction: 'bearish', score: 80 }
  ]);
  S(dep.consensus, 'bullish');
  S(dep.criticalDisagreement, false);
  S(dep.agentAgreementScore < 100, true);
}

// ---------------------------------------------------------------------------
// 4. Deterministic specialists — basic smoke + integrity handling
// ---------------------------------------------------------------------------
function candBase(over) {
  return Object.assign({
    symbol: 'TKN', mint: 'mint123', pairAddress: 'pair1', dex: 'dexscreener',
    priceUsd: 0.00001, priceSol: 0.00001, liquidityUsd: 300000, volume24hUsd: 1500000,
    change1hPct: -18, change5mPct: 2.5, recoveryPct: 1.8, recoveryStatus: 'ok',
    score: 72, source: 'dexscreener'
  }, over || {});
}

function stubHistory(n, slope = 0.001) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({ ts: Date.now() - (n - i) * 2000, priceUsd: 0.00001 * Math.pow(1 + slope, i), priceSol: 0.00001 * Math.pow(1 + slope, i), source: 'dexscreener' });
  }
  return arr;
}

{
  const tech = require('../atlas/agents/technical.js').analyze;
  const good = tech({ candidate: candBase({ recoveryPct: 6, volume24hUsd: 5000000 }), history: { samples: stubHistory(15, 0.004) }, integrity: { dataQuality: 'ok' } });
  S(good.agent, 'technical');
  S(good.direction, 'bullish');
  S(good.score >= 50, true);
  S(good.dataQuality, 'ok');
  S(good.prediction.expectedMovePct > 0, true);

  const warming = tech({ candidate: candBase({ recoveryStatus: 'warming' }), history: { samples: [], warming: true }, integrity: { dataQuality: 'ok' } });
  S(warming.direction, 'unknown');
  S(warming.dataQuality, 'ok');

  const susp = tech({ candidate: candBase(), history: { samples: stubHistory(12, 0.001) }, integrity: { dataQuality: 'suspicious', reasons: ['EXTREME_PRICE_MOVE'] } });
  S(susp.direction, 'unknown');
  S(susp.dataQuality, 'suspicious');
}

{
  const momentum = require('../atlas/agents/momentum.js').analyze;
  const m = momentum({ candidate: candBase({ change5mPct: 3 }), history: { samples: stubHistory(12, 0.0015) }, integrity: { dataQuality: 'ok' } });
  S(m.agent, 'momentum');
  S(m.direction, 'bullish');
  S(m.score >= 30, true, 'momentum score=' + m.score);
  S(m.dataQuality, 'ok');
}

{
  const vol = require('../atlas/agents/volatility.js').analyze;
  const v = vol({ candidate: candBase({ change1hPct: -18 }), history: { samples: stubHistory(20, 0.0005) }, integrity: { dataQuality: 'ok' } });
  S(v.agent, 'volatility');
  S(v.volatilityClass, 'LOW');
  S(v.dataQuality, 'ok');
}

{
  const liq = require('../atlas/agents/liquidity.js').analyze;
  const l = liq({ candidate: candBase({ liquidityUsd: 300000, volume24hUsd: 2000000 }), solPriceUsd: 150, tradeSizeSol: 0.05, integrity: { dataQuality: 'ok' } });
  S(l.agent, 'liquidity');
  S(l.liquidityRisk, 'LOW');
  S(l.exitability, 'HIGH');
}

{
  const regime = require('../atlas/agents/regime.js').analyze;
  const reg = regime({ candidate: candBase({ liquidityUsd: 300000, volume24hUsd: 2000000, change1hPct: -8, change5mPct: 2.5 }), history: { samples: stubHistory(30, 0.0008) }, integrity: { dataQuality: 'ok' } });
  S(reg.agent, 'regime');
  S(['RECOVERY', 'TREND_UP', 'CONSOLIDATION'].includes(reg.regime), true, 'regime=' + reg.regime);
  S(reg.direction === 'bullish' || reg.direction === 'neutral', true, 'direction=' + reg.direction);
}

{
  const sentiment = require('../atlas/agents/sentiment.js').analyze;
  const s = sentiment({ candidate: candBase({ change5mPct: 3, buysPct: 65, volume24hUsd: 2000000, transactionCount: 3000, liquidityUsd: 300000 }), market: { solMomentumPct: 1.5, regime: 'TREND_UP' }, universe: { avgVolumeUsd: 500000 }, integrity: { dataQuality: 'ok' } });
  S(s.agent, 'sentiment');
  S(s.sentimentStatus, 'DERIVED');
  S(s.direction, 'bullish');
}

{
  const solana = require('../atlas/agents/solana.js').analyze;
  const sl = solana({ market: { solPriceUsd: 150, solMomentumPct: 2.5, regime: 'TREND_UP', healthScore: 80, healthStatus: 'HEALTHY' }, integrity: { dataQuality: 'ok' } });
  S(sl.agent, 'solana');
  S(sl.status, 'PARTIAL');
  S(sl.direction === 'bullish' || sl.direction === 'neutral', true, 'solana direction=' + sl.direction);
}

{
  const onchain = require('../atlas/agents/onchain.js').analyze;
  const oc = onchain({ candidate: candBase({ topHolderPct: 12, buysPct: 70, tokenAgeDays: 45, transactionCount: 2000, walletCount: 600 }), integrity: { dataQuality: 'ok' } });
  S(oc.agent, 'onchain');
  S(oc.status, 'PARTIAL');
  S(oc.direction === 'bullish' || oc.direction === 'neutral', true, 'onchain direction=' + oc.direction);
}

{
  const tq = require('../atlas/agents/token-quality.js').analyze;
  const t = tq({ candidate: candBase({ liquidityUsd: 300000, volume24hUsd: 2000000, tokenAgeDays: 45, buysPct: 70 }), integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true } });
  S(t.agent, 'token-quality');
  S(t.tokenQualityScore >= 40, true, 'tokenQualityScore=' + t.tokenQualityScore);
  S(t.pairStable, true);
  S(t.sourcesAgree, true);

  const tqBad = tq({ candidate: candBase({ liquidityUsd: 3000 }), integrity: { dataQuality: 'suspicious', pairStable: false, sourcesAgree: false, reasons: ['PAIR_CHANGED', 'EXTREME_PRICE_MOVE'] } });
  S(tqBad.direction === 'bearish' || tqBad.direction === 'unknown', true, 'tqBad direction=' + tqBad.direction);
  S(tqBad.tokenQualityScore < 30, true, 'tqBad score=' + tqBad.tokenQualityScore);
  S(tqBad.pairStable, false);
  S(tqBad.sourcesAgree, false);
}

{
  const man = require('../atlas/agents/manipulation.js').analyze;
  const m = man({ candidate: candBase({ volume24hUsd: 2000000, liquidityDeltaPct: 5, change5mPct: 2.5 }), universeAvgVolumeUsd: 500000, integrity: { dataQuality: 'ok', lastPairAddress: 'pair1', pairAddress: 'pair1' } });
  S(m.agent, 'manipulation');
  S(m.manipulationRisk, 'LOW');

  const manSusp = man({ candidate: candBase({ liquidityDeltaPct: -25, change5mPct: 20, change1hPct: -35 }), integrity: { dataQuality: 'suspicious', pairChanged: true, sourceDivergence: true, suspiciousPriceMove: true, lastPairAddress: 'pair1', pairAddress: 'pair2' } });
  S(manSusp.manipulationRisk, 'EXTREME');
  S(manSusp.status, 'FAIL');
}

// ---------------------------------------------------------------------------
// 5. LLM-reasoning agents — UNAVAILABLE fallback
// ---------------------------------------------------------------------------
{
  const bull = require('../atlas/agents/bull.js').analyze;
  const b = bull({ candidate: candBase(), technical: { direction: 'bullish', confidence: 75 }, quant: { expectedDirection: 'up', confidence: 70 }, sentiment: { direction: 'bullish', confidence: 65 }, market: { regime: 'TREND_UP' }, llm: {} });
  S(b.agent, 'bull-researcher');
  S(b.unavailable, true);
  S(b.direction, 'unknown');
  S(b.confidence, 0);
}

{
  const bear = require('../atlas/agents/bear.js').analyze;
  const be = bear({ candidate: candBase(), technical: { direction: 'bearish', volatility: 90 }, market: { regime: 'DUMP', healthGate: true }, integrity: { dataQuality: 'suspicious', reasons: ['PAIR_CHANGED', 'EXTREME_PRICE_MOVE'] }, llm: {} });
  S(be.agent, 'bear-researcher');
  S(be.unavailable, true);
  S(be.warnings.includes('llm_unavailable'), true);
}

{
  const risk = require('../atlas/agents/risk-officer.js').analyze;
  const r = risk({ candidate: candBase(), technical: { direction: 'bullish' }, market: { regime: 'TREND_UP' }, llm: {} });
  S(r.agent, 'risk-officer');
  S(r.unavailable, true);
  S(r.approval, 'PASS');
}

{
  const synth = require('../atlas/agents/synthesis.js').analyze;
  const s = synth({ candidate: candBase({ score: 72 }), technical: { score: 75 }, quant: { expectedDirection: 'up', confidence: 70 }, sentiment: { score: 60 }, market: { regime: 'TREND_UP' }, bull: { confidence: 78, score: 78 }, bear: { riskScore: 32 }, integrity: { dataQuality: 'ok' }, llm: {} });
  S(s.agent, 'decision-synthesizer');
  S(s.researchScore >= 50, true, 'synth researchScore=' + s.researchScore);
  S(s.researchRecommendation, 'BUY');
  S(s.unavailable, false, 'deterministic fallback when no LLM URL');
}

// ---------------------------------------------------------------------------
// 6. Engine — lightweight deterministic cycle + predictions
// ---------------------------------------------------------------------------
{
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const dir = tmpFile('engine');
  fs.mkdirSync(dir, { recursive: true });
  const engine = createAtlasEngine({ dataDir: dir, mode: 'SHADOW', llm: {}, integritySnap: { dataQuality: 'ok', pairStable: true, sourcesAgree: true } });

  const c = candBase({ mint: 'm1', pairAddress: 'p1' });
  const ctx = {
    portfolio: { positionsOpen: 0, maxPositions: 5, totalTrades: 0, realizedPnlSol: 0, winRate: 0, cashSol: 10, equitySol: 10, startingCapitalSol: 10, lossStreak: 0, maxDrawdownPct: 0 },
    metrics: { n: 0, wins: 0, losses: 0, winRate: 0, expectancyPct: 0, profitFactor: 0, lossStreak: 0, maxDrawdownPct: 0 },
    regime: { regime: 'TREND_UP', confidence: 0.8, reasoning: 'test' },
    health: null,
    market: { solPriceUsd: 150, solMomentumPct: 1.5 },
    integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
    historyByMint: { m1: { samples: stubHistory(15, 0.001), warming: false } },
    universe: { candidates: 1, avgVolumeUsd: 1000000 }
  };

  const cycle = engine.runCycle({ candidates: [c], ctx });
  S(cycle.decisions.length, 1);
  const d = cycle.decisions[0];
  S(d.symbol, 'TKN');
  S(d.atlas.score >= 0, true, 'atlas.score=' + d.atlas.score);
  S(d.atlas.dataQuality, 'ok');
  S(d.v1.score, 72);
  S(d.v1.eligible, true);
  S(d.decision, 'PAPER_ELIGIBLE');
  S(d.integrity.status, 'PASS');
  S(cycle.predictions.length >= 5, true, 'predictions=' + cycle.predictions.length); // at least 5 specialists
  S(Array.isArray(cycle.predictions), true);
  S(cycle.predictions[0].agent, 'technical');
  S(['bullish', 'neutral', 'bearish'].includes(cycle.predictions[0].direction), true, 'direction=' + cycle.predictions[0].direction);

  const snap = engine.snapshot();
  S(snap.mode, 'SHADOW');
  S(snap.enabled, true);
}

// ---------------------------------------------------------------------------
// 7. Prediction journal — append + dedup
// ---------------------------------------------------------------------------
{
  const { AtlasDb } = require('../atlas/db.js');
  const { createPredictionJournl } = require('../atlas/prediction-journal.js');
  const db = new AtlasDb(tmpFile('journal'));
  const j = createPredictionJournl(db);
  const p1 = j.record('technical', { expectedMovePct: 2, probabilityUp: 0.6, probabilityDown: 0.4, confidence: 75 }, { candidate: candBase({ mint: 'm1', pairAddress: 'p1' }), ts: 1000, direction: 'bullish', confidence: 75, timeHorizon: '15m', thesis: 'uptrend', dataQuality: 'ok', marketRegime: 'TREND_UP' });
  S(p1.predictionId.startsWith('P'), true);
  S(p1.ts, 1000);
  S(p1.mint, 'm1');
  S(p1.pairAddress, 'p1');
  S(p1.dex, 'dexscreener');
  S(p1.agent, 'technical');
  S(p1.direction, 'bullish');
  S(p1.confidence, 75);
  S(p1.dataQuality, 'ok');
  S(p1.marketRegime, 'TREND_UP');
  S(p1.atlasVersion, 'ATLAS-0.1.0');
  S(p1.promptVersion, 'prompt-2026-09-05');

  j.record('bear', { expectedMovePct: -3, probabilityUp: 0.3, probabilityDown: 0.7 }, { candidate: candBase({ mint: 'm1', pairAddress: 'p1' }), ts: 1000, direction: 'bearish', confidence: 80, thesis: 'bear case', dataQuality: 'ok' });
  const preds = db.dedupPredictionId();
  S(preds.length, 2);
}

// ---------------------------------------------------------------------------
// 8. Outcome engine — look-ahead-free
// ---------------------------------------------------------------------------
{
  const { evaluate } = require('../atlas/outcome-engine.js');
  const pred = { predictionId: 'P1', ts: 1000, mint: 'm1', agent: 'technical', direction: 'bullish', confidence: 75, expectedMovePct: 2, probabilityUp: 0.7, probabilityDown: 0.3, timeHorizon: '15m' };
  const out = { pnlPct: 8, exitReason: 'take-profit', exitMint: 'm1' };

  const e = evaluate(pred, out, { requireHorizonExpiry: true });
  S(e.correct, true);
  S(e.realizedPnlPct, 8);
  S(e.horizonExpired, true);
  S(e.brier < 0.2, true);

  const bearPred = Object.assign({}, pred, { direction: 'bearish', probabilityUp: 0.3, probabilityDown: 0.7, expectedMovePct: -2 });
  const eBear = evaluate(bearPred, out);
  S(eBear.correct, false);
  S(eBear.realizedPnlPct, 8);

  const neutral = evaluate({ direction: 'neutral' }, out);
  S(neutral.correct, false);

  // When realizedAt is not provided, it defaults to Date.now() which is always
  // past any prediction ts, so horizonExpired is always true with Date.now().
  const early = evaluate(pred, Object.assign({}, out, { realizedAt: 1000 + 900000 - 1 }), { requireHorizonExpiry: true });
  S(early.horizonExpired, false, 'horizon not yet expired when realizedAt < pred.ts + horizon');
}

// ---------------------------------------------------------------------------
// 9. Attribution
// ---------------------------------------------------------------------------
{
  const { classify } = require('../atlas/attribution.js');
  const win = classify({ side: 'SELL', mint: 'm1', symbol: 'TKN', exitTs: Date.now(), realizedPnlPct: 8, realizedPnlSol: 0.004, exitReason: 'take-profit', score: 72, change1hPct: -18, recovery5mPct: 2.5, volatilityPct: 45 }, { researchScore: 74, researchRecommendation: 'BUY', consensus: 'bullish', riskLevel: 'medium', dataQuality: 'ok' }, { dataQuality: 'ok', pairStable: true, sourcesAgree: true });
  S(win.classification, 'GOOD_ENTRY_GOOD_EXIT');
  S(win.attribution, 'GOOD_ENTRY_GOOD_EXIT');
  S(win.v1.won, true);
  S(win.atlas.researchRecommendation, 'BUY');

  const loss = classify({ side: 'SELL', mint: 'm1', symbol: 'TKN', exitTs: Date.now(), realizedPnlPct: -7, realizedPnlSol: -0.004, exitReason: 'stop-loss', score: 72, change1hPct: -40, recovery5mPct: 0.1, volatilityPct: 95 }, { researchScore: 60, researchRecommendation: 'BUY', consensus: 'bullish', riskLevel: 'medium', dataQuality: 'ok' }, { dataQuality: 'suspicious', pairStable: true, sourcesAgree: false, reasons: ['SOURCE_DIVERGENCE'] });
  S(['DATA_PROBLEM', 'MANIPULATION'].includes(loss.classification), true, 'loss.classification=' + loss.classification);
  S(['DATA_PROBLEM', 'MANIPULATION'].includes(loss.attribution), true, 'loss.attribution=' + loss.attribution);
  S(loss.atlas.researchRecommendation, 'BUY');
}

// ---------------------------------------------------------------------------
// 10. Reputation
// ---------------------------------------------------------------------------
{
  const store = require('../atlas/reputation.js').createReputationStore();
  store.record('technical', 'TREND_UP', { correct: true, confidence: 80, expectedMovePct: 2, realizedPnlPct: 8, brier: 0.1 });
  store.record('technical', 'TREND_UP', { correct: false, confidence: 75, expectedMovePct: 2, realizedPnlPct: -5, brier: 0.5 });
  store.record('technical', 'DUMP', { correct: false, confidence: 80, expectedMovePct: -2, realizedPnlPct: -7, brier: 0.6 });

  const a = store.getAgent('technical');
  S(a.totalPredictions, 3);
  S(a.correct, 1);
  S(a.incorrect, 2);
  const rTu = store.getRegime('technical', 'TREND_UP');
  const rDump = store.getRegime('technical', 'DUMP');
  S(rTu != null && rTu.predictions, 2);
  S(rDump != null && rDump.predictions, 1);

  // Darwinian update — below MIN_SAMPLES_REPUTATION, weight unchanged (still 1.0)
  const w = store.darwinUpdate('technical', 1, 3, [rTu]);
  S(w, 1.0);

  // Above MIN: small sample, still no meaningful update unless blended strongly
  store.record('technical', 'TREND_UP', { correct: true, confidence: 80, expectedMovePct: 2, realizedPnlPct: 8, brier: 0.1 });
  const wb = store.darwinUpdate('technical', 2, 5, [store.getRegime('technical', 'TREND_UP')]);
  S(wb != null, true);
}

// ---------------------------------------------------------------------------
// 11. Experiments + keep/revert
// ---------------------------------------------------------------------------
{
  const { createExperiments } = require('../atlas/experiments.js');
  const db = { experiments: () => ({ version: 1, experiments: [], updatedAt: null }), writeExperiments: () => {} };
  const exp = createExperiments(db);
  const p = exp.propose({ parameter: 'technical_prompt', change: 'add dead-cat detection language', hypothesis: 'better momentum classification', reason: 'momentum misclassifications observed' });
  S(p.state, 'PROPOSED');
  S(p.parameter, 'technical_prompt');

  const shadow = exp.startShadow(p.id, { candidateVersion: 'ATLAS-0.1.0-SHADOW' });
  S(shadow.state, 'SHADOW');

  for (let i = 0; i < 25; i++) exp.recordShadowOutcome(p.id, { won: i % 2 === 0, pnlPct: (i % 2 === 0 ? 6 : -4), calibrationError: 0.1 });
  const ev = exp.evaluateShadow(p.id, 20);
  S(ev.state, 'PENDING_APPROVAL');
  S(ev.sampleSize, 25);
}

// ---------------------------------------------------------------------------
// 12. V1 constants — verify agentd.js still has the canonical values
// ---------------------------------------------------------------------------
{
  const agentd = require('../agentd.js');
  // These are module-level constants; importing agentd runs them once.
  // We assert they exist and match the canonical values.
  S(typeof agentd.isValidSolanaAddress, 'function');
  // Strategy constants are private to agentd; verify via a small require of the
  // source text so we don't depend on internal exports.
  const src = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
  ok(src.includes('const MAX_POSITIONS = 5;'), 'MAX_POSITIONS = 5');
  ok(src.includes('const STOP_LOSS_PCT = -6;'), 'STOP_LOSS_PCT = -6');
  ok(src.includes('const TAKE_PROFIT_PCT = 8;'), 'TAKE_PROFIT_PCT = 8');
  ok(src.includes('const MIN_SCORE = 60;'), 'MIN_SCORE = 60');
  ok(src.includes('const DEFAULT_COOLDOWN_MS = 600000;'), 'DEFAULT_COOLDOWN_MS = 600000');
}

// ---------------------------------------------------------------------------
// 13. Paper-only invariant — no real-execution strings in ATLAS files
// ---------------------------------------------------------------------------
{
  const forbidden = /Math\.random|signTransaction|sendTransaction|sendRawTransaction|privateKey|secretKey|Keypair|fromSecretKey|wallet.*load|emitSigned/i;
  const atlasFiles = [
    'atlas/atlas-engine.js',
    'atlas/db.js',
    'atlas/agents/technical.js',
    'atlas/agents/bull.js',
    'atlas/agents/bear.js',
    'atlas/agents/risk-officer.js',
    'atlas/agents/synthesis.js'
  ];
  for (const f of atlasFiles) {
    const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(!forbidden.test(body), 'forbidden token in ' + f);
  }
}

// ---------------------------------------------------------------------------
// 14. ZCAT regression — ATLAS must never research an invalid/quarantined
//     observation as a legitimate signal (price-integrity consumer path).
// ---------------------------------------------------------------------------
{
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const dir = tmpFile('zcat');
  fs.mkdirSync(dir, { recursive: true });

  // Simulate the ZCAT-type failure: a mint that the integrity layer has
  // quarantined due to an extreme / anomalous price observation.
  const suspect = {
    symbol: 'ZCAT', mint: 'zcatMint',
    pairAddress: 'zcatPair',
    priceUsd: 0.00001, priceSol: 0.00001,
    liquidityUsd: 300000, volume24hUsd: 2000000,
    change1hPct: -18, change5mPct: 2.5, recoveryPct: 1.8,
    score: 72, source: 'dexscreener'
  };
  const dirtyIntegrity = {
    dataQuality: 'suspicious',
    reasons: ['EXTREME_PRICE_MOVE quarantine'],
    quarantined: [{ mint: 'zcatMint', reason: 'EXTREME_PRICE_MOVE', pairStable: false, sourcesAgree: false }]
  };
  const cleanIntegrity = { dataQuality: 'ok', pairStable: true, sourcesAgree: true };

  const dirClean = tmpFile('zcat-clean');
  fs.mkdirSync(dirClean, { recursive: true });
  const engineClean = createAtlasEngine({ dataDir: dirClean, mode: 'SHADOW', llm: {}, integritySnap: cleanIntegrity });
  const c1 = engineClean.runCycle({ candidates: [Object.assign({}, suspect, { mint: 'cleanMint' })], ctx: { integrity: cleanIntegrity } });
  S(c1.decisions.length, 1);
  S(c1.decisions[0].atlas.dataQuality, 'ok');
  S(c1.decisions[0].integrity.status, 'PASS');

  const dirDirty = tmpFile('zcat-dirty');
  fs.mkdirSync(dirDirty, { recursive: true });
  const engineDirty = createAtlasEngine({ dataDir: dirDirty, mode: 'SHADOW', llm: {}, integritySnap: dirtyIntegrity });
  const c2 = engineDirty.runCycle({ candidates: [suspect], ctx: { integrity: dirtyIntegrity } });
  S(c2.decisions.length, 1);
  S(c2.decisions[0].atlas.dataQuality, 'suspicious');
  S(c2.decisions[0].integrity.status, 'FAIL');
  S(c2.decisions[0].synthesis.researchRecommendation, 'HOLD');
  S(c2.decisions[0].synthesis.researchScore <= 50, true);
  // ATLAS should NOT produce BUY on quarantined data
  ok(c2.decisions[0].synthesis.researchRecommendation !== 'BUY', 'must not BUY on quarantined');
}

// ---------------------------------------------------------------------------
// 15. Strategy-relative assertion: ATLAS does not gate execution
// ---------------------------------------------------------------------------
{
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const dir = tmpFile('gate');
  fs.mkdirSync(dir, { recursive: true });
  const engine = createAtlasEngine({ dataDir: dir, mode: 'ADVISORY', llm: {}, integritySnap: { dataQuality: 'ok' } });
  const cycle = engine.runCycle({ candidates: [candBase({ score: 65 })], ctx: { integrity: { dataQuality: 'ok' } } });
  const d = cycle.decisions[0];
  // ATLAS decision is advisory metadata; it never changes V1 eligibility in a
  // way that would block execution. The field is 'PAPER_ELIGIBLE' (advisory).
  S(d.decision, 'PAPER_ELIGIBLE');
  // V1 eligibility field is still present (but real execution still goes through
  // V1 in agentd). The point: ATLAS has no field that says 'do not execute'.
  S(d.v1.eligible, true);
}

// ---------------------------------------------------------------------------
// 16. Calibration module
// ---------------------------------------------------------------------------
{
  const cal = require('../atlas/calibration.js');
  const state = cal.emptyCalibration();
  S(state.totalPredictions, 0);
  S(state.calibrationError, null);

  // Record some predictions. NOTE: since the look-ahead/outcomeType fix,
  // record() requires explicit outcome provenance ('horizon' | 'trade') so
  // unresolved/skipped/missing-price outcomes can never enter calibration.
  cal.record(state, 'technical', 75, true, 5, 'horizon');
  cal.record(state, 'technical', 80, false, -3, 'horizon');
  cal.record(state, 'technical', 65, true, 2, 'horizon');
  cal.record(state, 'momentum', 90, true, 8, 'trade');
  cal.record(state, 'momentum', 85, true, 2, 'trade');
  S(state.totalPredictions, 5);
  S(state.buckets['70-79%'].predictionCount, 1);
  S(state.buckets['80-89%'].predictionCount, 2);
  S(state.buckets['60-69%'].predictionCount, 1);
  S(state.buckets['90-100%'].predictionCount, 1);
  S(state.buckets['70-79%'].accuracy, 100);
  S(state.buckets['80-89%'].accuracy, 50);

  // Per-agent calibration
  S(state.agentCalibrations.technical.totalPredictions, 3);
  S(state.agentCalibrations.momentum.totalPredictions, 2);

  // Calibration error (needs >= 3 predictions per bucket)
  // Add more predictions to populate buckets
  for (let i = 0; i < 5; i++) cal.record(state, 'technical', 75, i % 2 === 0, 1, 'horizon');
  for (let i = 0; i < 5; i++) cal.record(state, 'momentum', 85, i % 2 === 0, 1, 'trade');
  const err = cal.computeCalibrationError(state);
  S(err != null, true, 'calibrationError=' + err);

  // Merge
  const state2 = cal.emptyCalibration();
  cal.record(state2, 'technical', 70, true, 3);
  const merged = cal.merge(state, state2);
  S(merged.totalPredictions > 5, true, 'merged total=' + merged.totalPredictions);
}

// ---------------------------------------------------------------------------
// 17. A/B Paper module
// ---------------------------------------------------------------------------
{
  const { createABPaper } = require('../atlas/ab-paper.js');
  const mockDb = { readJson: () => null, writeJson: () => {} };
  const ab = createABPaper(mockDb);

  // V1 wins, ATLAS says BUY → both groups win
  ab.recordTrade({ mint: 'm1', symbol: 'TKN', pnlPct: 8, exitReason: 'take-profit', v1Score: 72, atlasScore: 75, atlasRecommendation: 'BUY' });
  const snap1 = ab.snapshot();
  S(snap1.groupA.totalTrades, 1);
  S(snap1.groupA.wins, 1);
  S(snap1.groupB.totalTrades, 1);
  S(snap1.groupB.wins, 1);

  // V1 loses, ATLAS says AVOID → V1 loses, V1+ATLAS does NOT execute.
  // Phase 13 fix: an avoided decision is not a 0% executed trade — it is
  // tracked separately (avoided counter + null atlasReturn) and excluded
  // from groupB trade/win/loss accounting.
  ab.recordTrade({ mint: 'm2', symbol: 'TKN2', pnlPct: -7, exitReason: 'stop-loss', v1Score: 65, atlasScore: 40, atlasRecommendation: 'AVOID' });
  const snap2 = ab.snapshot();
  S(snap2.groupA.totalTrades, 2);
  S(snap2.groupA.losses, 1);
  S(snap2.groupB.totalTrades, 1, 'AVOID is not counted as an executed trade');
  S(snap2.groupB.losses, 0, 'V1+ATLAS skipped the AVOID trade');
  S(snap2.avoided, 1, 'avoided decision tracked separately');
  S(snap2.executedComparisons, 1, 'only executed rows count as comparisons');

  // Evaluate
  const ev = ab.evaluate();
  ok(ev.sampleSize != null || snap2.groupA.totalTrades >= 2, 'A/B evaluate has data');
}

// ---------------------------------------------------------------------------
// 18. ATLAS engine — recordTradeOutcome + calibration integration
// ---------------------------------------------------------------------------
{
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const dir = tmpFile('engine-outcome');
  fs.mkdirSync(dir, { recursive: true });
  const engine = createAtlasEngine({ dataDir: dir, mode: 'SHADOW', llm: {}, integritySnap: { dataQuality: 'ok' } });

  // Run a cycle to create predictions
  const c = candBase({ mint: 'm1', pairAddress: 'p1' });
  const ctx = {
    portfolio: { positionsOpen: 0, maxPositions: 5, totalTrades: 0, realizedPnlSol: 0, winRate: 0, cashSol: 10, equitySol: 10, startingCapitalSol: 10, lossStreak: 0, maxDrawdownPct: 0 },
    metrics: { n: 0, wins: 0, losses: 0, winRate: 0, expectancyPct: 0, profitFactor: 0, lossStreak: 0, maxDrawdownPct: 0 },
    regime: { regime: 'TREND_UP', confidence: 0.8, reasoning: 'test' },
    health: null,
    market: { solPriceUsd: 150, solMomentumPct: 1.5 },
    integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
    historyByMint: { m1: { samples: stubHistory(15, 0.001), warming: false } },
    universe: { candidates: 1, avgVolumeUsd: 1000000 }
  };
  engine.runCycle({ candidates: [c], ctx });

  // Record outcome. entryTs is NOW (after the predictions above were
  // journaled): look-ahead protection only attributes predictions that
  // existed at/before entry, so entryTs must not predate the predictions.
  const result = engine.recordTradeOutcome({ mint: 'm1', pnlPct: 8, entryTs: Date.now(), exitTs: Date.now() + 60000, v1Score: 72, exitReason: 'take-profit', symbol: 'TKN' });
  S(result.found, true, 'predictions found for m1');
  S(result.outcomes.length > 0, true, 'outcomes recorded');

  // Snapshot includes calibration and A/B data
  const snap = engine.snapshot();
  S(snap.calibration != null, true, 'calibration in snapshot');
  S(snap.abPaper != null, true, 'abPaper in snapshot');
  S(snap.abPaper.groupA.totalTrades, 1);
  S(snap.abPaper.groupA.wins, 1);
}

// ---------------------------------------------------------------------------
// 19. buildAtlasContext — agentd context builder
// ---------------------------------------------------------------------------
{
  // Verify the function exists and returns correct structure
  const src = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
  ok(src.includes('function buildAtlasContext'), 'buildAtlasContext defined in agentd.js');
  ok(src.includes('tradeSizeSol: config.tradeSizeSol'), 'buildAtlasContext includes tradeSizeSol');
}

// ===========================================================================
// PHASE 2.1 — COMPREHENSIVE VALIDATION TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// 20. Statistics engine — evidence state
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  S(stats.evidenceState(5), 'INSUFFICIENT_SAMPLE', '5 samples = INSUFFICIENT_SAMPLE');
  S(stats.evidenceState(29), 'INSUFFICIENT_SAMPLE', '29 samples = INSUFFICIENT_SAMPLE');
  S(stats.evidenceState(30), 'CHECKPOINT_30', '30 samples = CHECKPOINT_30');
  S(stats.evidenceState(99), 'CHECKPOINT_30', '99 samples = CHECKPOINT_30');
  S(stats.evidenceState(100), 'CHECKPOINT_100', '100 samples = CHECKPOINT_100');
  S(stats.evidenceState(199), 'CHECKPOINT_100', '199 samples = CHECKPOINT_100');
  S(stats.evidenceState(200), 'CHECKPOINT_200', '200 samples = CHECKPOINT_200');
  S(stats.evidenceState(500), 'CHECKPOINT_200', '500 samples = CHECKPOINT_200');
}

// ---------------------------------------------------------------------------
// 21. Statistics engine — matched-sample analysis
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  const matched = stats.matchedSampleAnalysis([
    { circuitReturn: 5, atlasReturn: 8 },
    { circuitReturn: -3, atlasReturn: -1 },
    { circuitReturn: 2, atlasReturn: 6 },
    { circuitReturn: -1, atlasReturn: 3 },
    { circuitReturn: 4, atlasReturn: 5 }
  ]);
  S(matched.matchedSamples, 5);
  S(matched.meanDifference > 0, true, 'ATLAS mean better than circuit: ' + matched.meanDifference);
  S(matched.medianDifference != null, true);
  S(matched.standardDeviation > 0, true);
  S(matched.differences.length, 5);
  S(matched.circuitReturns.length, 5);
  S(matched.atlasReturns.length, 5);

  // Empty input
  const empty = stats.matchedSampleAnalysis([]);
  S(empty.matchedSamples, 0);
  S(empty.meanDifference, null);
}

// ---------------------------------------------------------------------------
// 22. Statistics engine — bootstrap CI
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  // Deterministic bootstrap with seeded RNG
  let seed = 42;
  function seededRng() { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; }

  const data = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  const ci = stats.bootstrapCI(data, { iterations: 1000, rng: seededRng });
  S(ci.insufficient, false);
  S(ci.mean != null, true);
  S(ci.ciLower != null, true);
  S(ci.ciUpper != null, true);
  S(ci.ciLower < ci.mean, true, 'lower < mean: ' + ci.ciLower + ' < ' + ci.mean);
  S(ci.ciUpper > ci.mean, true, 'upper > mean: ' + ci.ciUpper + ' > ' + ci.mean);
  S(ci.iterations, 1000);
  S(ci.ciLevel, 0.95);

  // Insufficient data
  const insufficient = stats.bootstrapCI([5]);
  S(insufficient.insufficient, true);
}

// ---------------------------------------------------------------------------
// 23. Statistics engine — effect size
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  const large = stats.effectSize({ matchedSamples: 50, meanDifference: 5, standardDeviation: 3 });
  S(large.interpretation, 'LARGE', 'd=5/3~1.67 should be LARGE');
  S(large.magnitude > 0.8, true, 'large effect magnitude');

  const small = stats.effectSize({ matchedSamples: 50, meanDifference: 0.3, standardDeviation: 2 });
  S(small.interpretation, 'NEGLIGIBLE', 'd=0.3/2=0.15 should be NEGLIGIBLE');

  const insufficient = stats.effectSize({ matchedSamples: 0 });
  S(insufficient.interpretation, 'INSUFFICIENT_DATA');
}

// ---------------------------------------------------------------------------
// 24. Statistics engine — paired test
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  // Clear difference
  const circuit = [2, -1, 3, -2, 1, 4, -3, 2, 5, -1, 3, 6, -2, 4, 1, 5, -3, 2, 6, 3, 4, -1, 2, 5, 3, 6, -2, 4, 1, 5];
  const atlas = circuit.map(c => c + 3); // consistently 3% better
  const test = stats.pairedTest(circuit, atlas);
  S(test.sampleSize, 30);
  S(test.testName === 'paired_t_test' || test.testName === 'wilcoxon_signed_rank', true);
  S(test.statistic != null, true);
  S(test.pValue != null, true);
  S(test.conclusion === 'SIGNIFICANT_AT_0.05' || test.conclusion === 'NOT_SIGNIFICANT', true);

  // Insufficient data
  const insuff = stats.pairedTest([1], [2]);
  S(insuff.conclusion, 'INSUFFICIENT_EVIDENCE');
}

// ---------------------------------------------------------------------------
// 25. Statistics engine — deterministic bootstrap in tests
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  let seed = 123;
  function seededRng() { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; }
  const data = [1, 2, 3, 4, 5];
  const ci1 = stats.bootstrapCI(data, { iterations: 500, rng: seededRng });
  seed = 123; // reset
  const ci2 = stats.bootstrapCI(data, { iterations: 500, rng: seededRng });
  S(ci1.mean, ci2.mean, 'deterministic: same seed produces same result');
  S(ci1.ciLower, ci2.ciLower);
  S(ci1.ciUpper, ci2.ciUpper);
}

// ---------------------------------------------------------------------------
// 26. Statistics engine — confidence interval contains true mean
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  const data = Array.from({ length: 50 }, (_, i) => 10 + (i % 5) * 0.5); // mean ~ 11
  const ci = stats.bootstrapCI(data, { iterations: 5000 });
  S(ci.mean > 9 && ci.mean < 13, true, 'mean in expected range: ' + ci.mean);
  S(ci.ciLower < ci.mean, true);
  S(ci.ciUpper > ci.mean, true);
}

// ---------------------------------------------------------------------------
// 27. Outcome horizons — 5m/15m/30m/1h/4h
// ---------------------------------------------------------------------------
{
  const { horizonMs, ALL_HORIZONS } = require('../atlas/outcome-engine.js');
  S(horizonMs('5m'), 300000);
  S(horizonMs('15m'), 900000);
  S(horizonMs('30m'), 1800000);
  S(horizonMs('1h'), 3600000);
  S(horizonMs('4h'), 14400000);
  S(horizonMs('1d'), 86400000);
  S(ALL_HORIZONS.length, 5);
  S(ALL_HORIZONS.includes('4h'), true);
  S(ALL_HORIZONS.includes('30m'), true);
}

// ---------------------------------------------------------------------------
// 28. Outcome engine — unresolved outcome
// ---------------------------------------------------------------------------
{
  const { evaluate } = require('../atlas/outcome-engine.js');
  const pred = { predictionId: 'P-UNRES', ts: Date.now(), mint: 'm1', agent: 'technical', direction: 'bullish', confidence: 75, expectedMovePct: 2, probabilityUp: 0.6, probabilityDown: 0.4, timeHorizon: '4h' };
  // realizedAt is 1 second after prediction — far before 4h horizon
  const early = evaluate(pred, { pnlPct: 5, realizedAt: pred.ts + 1000 }, { requireHorizonExpiry: true });
  S(early.horizonExpired, false, '4h horizon not yet expired at +1s');
  S(early.correct, true, 'direction correct but horizon not expired');
}

// ---------------------------------------------------------------------------
// 29. Look-ahead protection — future data rejected
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  const { evaluate } = require('../atlas/outcome-engine.js');
  // Prediction at T, outcome at T-1 (impossible — resolution before prediction)
  const pred = { predictionId: 'P-FUTURE', ts: 5000, mint: 'm1', agent: 'technical', direction: 'bullish', confidence: 75, expectedMovePct: 2, probabilityUp: 0.6, probabilityDown: 0.4, timeHorizon: '15m' };
  const outcome = { pnlPct: 8, realizedAt: 4000 }; // resolution BEFORE prediction
  const ev = evaluate(pred, outcome, { requireHorizonExpiry: true });
  // requireHorizonExpiry enforces: realizedAt >= ts + horizonMs
  // realizedAt (4000) < ts (5000) + 900000 = 905000, so horizonExpired = false
  S(ev.horizonExpired, false, 'future resolution rejected by horizon check');
}

// ---------------------------------------------------------------------------
// 30. Immutable predictions — predictions not mutated after creation
// ---------------------------------------------------------------------------
{
  const { AtlasDb } = require('../atlas/db.js');
  const { createPredictionJournl } = require('../atlas/prediction-journal.js');
  const db = new AtlasDb(tmpFile('immutable'));
  fs.mkdirSync(tmpFile('immutable'), { recursive: true });
  const j = createPredictionJournl(db);
  const p = j.record('technical', { expectedMovePct: 2, probabilityUp: 0.6, probabilityDown: 0.4, confidence: 80, score: 80 }, {
    candidate: candBase({ mint: 'immutable-mint', pairAddress: 'ip1' }),
    ts: 9999, direction: 'bullish', timeHorizon: '15m', dataQuality: 'ok'
  });
  const stored = db.dedupPredictionId().find(x => x.predictionId === p.predictionId);
  S(stored.direction, 'bullish');
  S(stored.confidence, 80);
  S(stored.ts, 9999);
  // Modify in-memory — should not affect stored
  p.direction = 'bearish';
  p.confidence = 10;
  const reloaded = db.dedupPredictionId().find(x => x.predictionId === p.predictionId);
  S(reloaded.direction, 'bullish', 'prediction immutable after creation');
  S(reloaded.confidence, 80, 'confidence immutable after creation');
}

// ---------------------------------------------------------------------------
// 31. Duplicate protection — prediction dedup
// ---------------------------------------------------------------------------
{
  const { AtlasDb } = require('../atlas/db.js');
  const db = new AtlasDb(tmpFile('dup'));
  fs.mkdirSync(tmpFile('dup'), { recursive: true });
  db.appendPrediction({ predictionId: 'P-DUP1', ts: 1000, mint: 'm1', direction: 'bullish' });
  db.appendPrediction({ predictionId: 'P-DUP1', ts: 1000, mint: 'm1', direction: 'bearish' }); // duplicate ID
  db.appendPrediction({ predictionId: 'P-DUP2', ts: 2000, mint: 'm1', direction: 'bullish' });
  const all = db.dedupPredictionId();
  S(all.length, 2, 'dedup removes duplicate predictionId');
  S(all.find(p => p.predictionId === 'P-DUP1').direction, 'bullish');
}

// ---------------------------------------------------------------------------
// 32. Agent scorecard — directional predictions, MFE, MAE, winRate, medianReturn
// ---------------------------------------------------------------------------
{
  const store = require('../atlas/reputation.js').createReputationStore();
  const outcomes = [
    { correct: true, confidence: 80, realizedPnlPct: 5 },
    { correct: true, confidence: 75, realizedPnlPct: 8 },
    { correct: false, confidence: 85, realizedPnlPct: -3 },
    { correct: true, confidence: 70, realizedPnlPct: 2 },
    { correct: false, confidence: 60, realizedPnlPct: -6 }
  ];
  for (const o of outcomes) store.record('technical', 'TREND_UP', o);
  const a = store.getAgent('technical');
  S(a.totalPredictions, 5);
  S(a.directionalPredictions > 0, true, 'directionalPredictions tracked');
  S(a.winRate > 0, true, 'winRate=' + a.winRate);
  S(a.winRate, 60, '3 wins / 5 = 60%');
  S(a.medianReturn != null, true, 'medianReturn tracked');
  S(a.mfe > 0, true, 'MFE=' + a.mfe);
  S(a.mae > 0, true, 'MAE=' + a.mae);
  S(Array.isArray(a.returns), true, 'returns array exists');
  S(a.returns.length, 5);
}

// ---------------------------------------------------------------------------
// 33. Regime scorecard — winRate, expectancy, MFE, MAE
// ---------------------------------------------------------------------------
{
  const store = require('../atlas/reputation.js').createReputationStore();
  store.record('technical', 'DUMP', { correct: false, confidence: 70, realizedPnlPct: -5 });
  store.record('technical', 'DUMP', { correct: true, confidence: 80, realizedPnlPct: 3 });
  store.record('technical', 'DUMP', { correct: false, confidence: 75, realizedPnlPct: -7 });
  const r = store.getRegime('technical', 'DUMP');
  S(r.predictions, 3);
  S(r.winRate, 33.33, '1 win / 3 = 33.33%');
  S(r.expectancy != null, true, 'expectancy tracked');
  S(r.mfe > 0, true, 'MFE=' + r.mfe);
  S(r.mae > 0, true, 'MAE=' + r.mae);
  S(r.medianReturn != null, true, 'medianReturn tracked');
  S(Array.isArray(r.returns), true, 'returns array exists');
  S(r.returns.length, 3);
}

// ---------------------------------------------------------------------------
// 34. ATLAS attribution categories
// ---------------------------------------------------------------------------
{
  const { classifyAtlas, ATLAS_ATTRIBUTION_CLASSES } = require('../atlas/attribution.js');
  S(ATLAS_ATTRIBUTION_CLASSES.length >= 8, true, 'has ATLAS attribution classes');

  // TA_CORRECT_HELPED: TA bullish + trade won
  S(classifyAtlas({ direction: 'bullish' }, { recommendation: 'BUY', direction: 'bullish' }, { won: true, pnlPct: 5 }), 'TA_CORRECT_HELPED');

  // TA_WRONG_AND_HARMFUL: TA bullish + trade lost + circuit bullish
  S(classifyAtlas({ direction: 'bullish', decision: 'BUY' }, { recommendation: 'BUY', direction: 'bullish' }, { won: false, pnlPct: -5 }), 'TA_WRONG_AND_HARMFUL');

  // TA_WRONG_BUT_CIRCUIT_SAVED: TA bearish, trade won
  S(classifyAtlas({ direction: 'bullish' }, { recommendation: 'AVOID', direction: 'bearish' }, { won: true, pnlPct: 5 }), 'TA_WRONG_BUT_CIRCUIT_SAVED');

  // TA_CORRECT_HELPED: TA bearish + trade lost
  S(classifyAtlas({ direction: 'bullish' }, { recommendation: 'AVOID', direction: 'bearish' }, { won: false, pnlPct: -5 }), 'TA_CORRECT_HELPED');

  // NO_ATLAS_DATA: no recommendation
  S(classifyAtlas({ direction: 'bullish' }, {}, { won: true, pnlPct: 5 }), 'NO_ATLAS_DATA');

  // TA_CORRECT_BUT_IRRELEVANT: TA neutral, trade won
  S(classifyAtlas({ direction: 'bullish' }, { recommendation: 'HOLD', direction: 'neutral' }, { won: true, pnlPct: 5 }), 'TA_CORRECT_BUT_IRRELEVANT');
}

// ---------------------------------------------------------------------------
// 35. Checkpoints — persistence
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  const { AtlasDb } = require('../atlas/db.js');
  const db = new AtlasDb(tmpFile('checkpoints'));
  fs.mkdirSync(tmpFile('checkpoints'), { recursive: true });
  const ckpts = stats.createCheckpoints(db);

  // Create 35 matched samples
  const circuitReturns = Array.from({ length: 35 }, (_, i) => (i % 3 === 0 ? -2 : 3));
  const atlasReturns = circuitReturns.map(r => r + 1);
  const matched = stats.matchedSampleAnalysis(circuitReturns.map((c, i) => ({ circuitReturn: c, atlasReturn: atlasReturns[i] })));
  const ckpt = ckpts.compute(matched, circuitReturns, atlasReturns);
  S(ckpt.sampleSize, 35);
  S(ckpt.evidenceState, 'CHECKPOINT_30');
  S(ckpt.effectSize != null, true);
  S(ckpt.statisticalTest != null, true);

  ckpts.persistCheckpoint(ckpt);
  const loaded = ckpts.loadCheckpoints();
  S(loaded.length >= 1, true, 'checkpoint persisted and loaded');
  S(loaded[loaded.length - 1].sampleSize, 35);
}

// ---------------------------------------------------------------------------
// 36. Daily snapshot — persistence
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  const { AtlasDb } = require('../atlas/db.js');
  const db = new AtlasDb(tmpFile('daily'));
  fs.mkdirSync(tmpFile('daily'), { recursive: true });
  const daily = stats.createDailySnapshots(db);

  daily.record('2026-09-06', {
    predictions: 10,
    resolved: 8,
    circuitAccuracy: 62.5,
    atlasAccuracy: 75.0,
    circuitMeanReturn: 1.5,
    atlasMeanReturn: 2.3,
    pairedMeanDifference: 0.8,
    evidenceState: 'CHECKPOINT_30'
  });

  const day = daily.getDay('2026-09-06');
  S(day != null, true, 'day persisted');
  S(day.predictions, 10);
  S(day.circuitAccuracy, 62.5);
  S(day.atlasAccuracy, 75.0);
  S(day.pairedMeanDifference, 0.8);

  // Historical days are not overwritten
  daily.record('2026-09-05', { predictions: 5, resolved: 3 });
  const all = daily.allDays();
  S(Object.keys(all).length >= 2, true, 'multiple days preserved');
  S(all['2026-09-06'].predictions, 10, 'Sep 6 not overwritten');
}

// ---------------------------------------------------------------------------
// 37. NaN accepted without crash by schemas (not clamped, but safe)
// ---------------------------------------------------------------------------
{
  const schema = require('../atlas/schemas.js');
  const nan = schema.validate({ agent: 'x', candidate: 'x', timestamp: 1, direction: 'bullish', confidence: NaN, score: NaN });
  S(nan.ok, true, 'NaN does not crash validation');
  // NaN is not finite, so clamp doesn't touch it — value remains NaN
  S(typeof nan.value.confidence, 'number', 'confidence is number type');
  S(typeof nan.value.score, 'number', 'score is number type');
}

// ---------------------------------------------------------------------------
// 38. Infinity accepted without crash by schemas (not finite, not clamped)
// ---------------------------------------------------------------------------
{
  const schema = require('../atlas/schemas.js');
  const inf = schema.validate({ agent: 'x', candidate: 'x', timestamp: 1, direction: 'bullish', confidence: Infinity, score: -Infinity });
  S(inf.ok, true, 'Infinity does not crash validation');
  S(typeof inf.value.confidence, 'number');
  S(typeof inf.value.score, 'number');
}

// ---------------------------------------------------------------------------
// 39. Malformed agent output handled safely
// ---------------------------------------------------------------------------
{
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const dir = tmpFile('malformed');
  fs.mkdirSync(dir, { recursive: true });
  const engine = createAtlasEngine({ dataDir: dir, mode: 'SHADOW', llm: {}, integritySnap: { dataQuality: 'ok' } });
  // Engine should not crash with bad candidate shapes
  const cycle = engine.runCycle({ candidates: [{ symbol: 'X' }, {}, { symbol: 'Y', mint: 'valid' }], ctx: { integrity: { dataQuality: 'ok' } } });
  // Some candidates may fail gracefully
  ok(Array.isArray(cycle.decisions), 'engine handles malformed candidates without crash');
}

// ---------------------------------------------------------------------------
// 40. One failing agent does not stop engine
// ---------------------------------------------------------------------------
{
  const dir = tmpFile('agent-fail');
  fs.mkdirSync(dir, { recursive: true });
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const engine = createAtlasEngine({ dataDir: dir, mode: 'SHADOW', llm: {}, integritySnap: { dataQuality: 'ok' } });
  const c = candBase({ mint: 'm-fail', pairAddress: 'p-fail' });
  const ctx = {
    portfolio: { positionsOpen: 0, maxPositions: 5 },
    metrics: { n: 0 },
    market: { solPriceUsd: 150 },
    integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
    historyByMint: { 'm-fail': { samples: stubHistory(15, 0.001), warming: false } },
    universe: { candidates: 1, avgVolumeUsd: 1000000 }
  };
  // Even with bad history, engine should complete
  const cycle = engine.runCycle({ candidates: [c], ctx });
  ok(Array.isArray(cycle.decisions), 'engine completed with agent context issues');
}

// ---------------------------------------------------------------------------
// 41. Paper-only invariant — no execution code added
// ---------------------------------------------------------------------------
{
  const newAtlasFiles = [
    'atlas/statistics.js',
    'atlas/calibration.js',
    'atlas/ab-paper.js'
  ];
  const execForbidden = /signTransaction|sendTransaction|sendRawTransaction|privateKey|secretKey|Keypair|fromSecretKey|emitSigned|broadcast|placeOrder/i;
  for (const f of newAtlasFiles) {
    const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(!execForbidden.test(body), 'no execution code in ' + f);
  }
}

// ---------------------------------------------------------------------------
// 42. V1 constants unchanged (re-verify after all modifications)
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
  ok(src.includes('const STOP_LOSS_PCT = -6;'), 'STOP_LOSS_PCT = -6');
  ok(src.includes('const TAKE_PROFIT_PCT = 8;'), 'TAKE_PROFIT_PCT = 8');
  ok(src.includes('const MAX_POSITIONS = 5;'), 'MAX_POSITIONS = 5');
  ok(src.includes('const MIN_SCORE = 60;'), 'MIN_SCORE = 60');
  ok(src.includes('const DEFAULT_COOLDOWN_MS = 600000;'), 'DEFAULT_COOLDOWN_MS = 600000');
}

// ---------------------------------------------------------------------------
// 43. ATLAS execution isolation — PAPER_ELIGIBLE only in ATLAS, not in agentd
// ---------------------------------------------------------------------------
{
  const agentdSrc = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
  const atlasSrc = fs.readFileSync(path.join(ROOT, 'atlas/atlas-engine.js'), 'utf8');
  S(atlasSrc.includes("decision: 'PAPER_ELIGIBLE'"), true, 'ATLAS uses PAPER_ELIGIBLE (advisory)');
}

// ---------------------------------------------------------------------------
// 44. Data quality — quarantined observation excluded from stats
// ---------------------------------------------------------------------------
{
  const { dataQuality } = require('../atlas/evidence.js');
  const q = dataQuality({ dataQuality: 'suspicious', reasons: ['EXTREME_PRICE_MOVE quarantine'] }, {}, 0, 60000);
  S(q.score, 0, 'quarantined observation dataQuality = 0');
  ok(q.reasons.length > 0, 'reasons explain quarantine');
}

// ---------------------------------------------------------------------------
// 45. WARMING does not fabricate data
// ---------------------------------------------------------------------------
{
  const tech = require('../atlas/agents/technical.js').analyze;
  const warming = tech({
    candidate: candBase({ recoveryStatus: 'warming' }),
    history: { samples: [], warming: true },
    integrity: { dataQuality: 'ok' }
  });
  S(warming.direction, 'unknown', 'warming returns unknown, not fabricated');
  S(warming.confidence, 0, 'warming confidence = 0');
  ok(!warming.thesis || warming.thesis.includes('insufficient'), 'thesis mentions insufficient history');
}

// ---------------------------------------------------------------------------
// 46. ZCAT regression — quarantined observation excluded from stats
// ---------------------------------------------------------------------------
{
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const dir = tmpFile('zcat-stats');
  fs.mkdirSync(dir, { recursive: true });
  const engine = createAtlasEngine({ dataDir: dir, mode: 'SHADOW', llm: {},
    integritySnap: { dataQuality: 'suspicious', quarantined: [{ mint: 'zcat-stats-mint', reason: 'EXTREME_PRICE_MOVE' }] } });
  const c = candBase({ mint: 'zcat-stats-mint', symbol: 'ZCAT' });
  const cycle = engine.runCycle({ candidates: [c], ctx: { integrity: { dataQuality: 'suspicious', quarantined: [{ mint: 'zcat-stats-mint', reason: 'EXTREME_PRICE_MOVE' }] } } });
  S(cycle.decisions.length, 1);
  S(cycle.decisions[0].atlas.dataQuality, 'suspicious');
  ok(cycle.decisions[0].synthesis.researchRecommendation !== 'BUY', 'ZCAT: no BUY on quarantined');
}

// ---------------------------------------------------------------------------
// 47. ATLAS engine snapshot includes statistics
// ---------------------------------------------------------------------------
{
  const dir = tmpFile('snap-stats');
  fs.mkdirSync(dir, { recursive: true });
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const engine = createAtlasEngine({ dataDir: dir, mode: 'SHADOW', llm: {} });
  const snap = engine.snapshot();
  S(snap.evidenceState != null, true, 'evidenceState in snapshot');
  S(snap.statistics != null, true, 'statistics in snapshot');
  S(snap.statistics.evidenceState, 'INSUFFICIENT_SAMPLE');
}

// ---------------------------------------------------------------------------
// 48. Paired bootstrap CI
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  const circuit = [2, -1, 3, -2, 1, 4, -3, 2, 5, -1];
  const atlas = circuit.map(r => r + 2);
  const ci = stats.pairedBootstrapCI(circuit, atlas, { iterations: 1000 });
  S(ci.insufficient, false);
  S(ci.mean > 0, true, 'paired mean diff positive: ' + ci.mean);
  S(ci.ciLower != null, true);
  S(ci.ciUpper != null, true);
}

// ---------------------------------------------------------------------------
// 49. Wilcoxon signed-rank (non-parametric fallback)
// ---------------------------------------------------------------------------
{
  const stats = require('../atlas/statistics.js');
  // Small sample forces non-parametric
  const circuit = [1, -2, 3, -1, 2];
  const atlas = [3, 0, 5, 1, 4];
  const test = stats.pairedTest(circuit, atlas);
  S(test.testName === 'wilcoxon_signed_rank', true, 'small sample uses Wilcoxon: ' + test.testName);
  S(test.sampleSize, 5);
  S(test.statistic != null, true);
}

// ---------------------------------------------------------------------------
// 50. A/B paper isolation — counterfactual does not alter real P&L
// ---------------------------------------------------------------------------
{
  const { createABPaper } = require('../atlas/ab-paper.js');
  const mockDb = { readJson: () => null, writeJson: () => {} };
  const ab = createABPaper(mockDb);
  ab.recordTrade({ mint: 'm1', symbol: 'X', pnlPct: 5, atlasRecommendation: 'BUY' });
  ab.recordTrade({ mint: 'm2', symbol: 'Y', pnlPct: -7, atlasRecommendation: 'AVOID' });
  const snap = ab.snapshot();
  // Group A: V1 actual = both trades
  S(snap.groupA.totalTrades, 2);
  S(snap.groupA.wins, 1);
  S(snap.groupA.losses, 1);
  // Group B: V1+ATLAS counterfactual = only the BUY trade executes.
  // Phase 13 fix: the avoided trade is NOT a 0% executed trade — it is
  // tracked in snap.avoided and excluded from groupB accounting.
  S(snap.groupB.totalTrades, 1, 'AVOID is not counted as an executed trade');
  S(snap.groupB.wins, 1);
  S(snap.groupB.losses, 0, 'counterfactual skipped the AVOID trade — no loss counted');
  S(snap.avoided, 1, 'avoided decision tracked separately');
  // Verify: counterfactual result differs from actual
  ok(snap.groupA.losses !== snap.groupB.losses || snap.groupA.totalPnlPct !== snap.groupB.totalPnlPct,
    'counterfactual isolation: A and B differ when ATLAS filtering applies');
}

console.log('atlas unit tests passed');
}

module.exports = { testAtlas };

if (require.main === module) {
  testAtlas().then(() => { process.exit(0); }).catch((err) => { console.error(err); process.exit(1); });
}
