#!/usr/bin/env node
/**
 * ta-tests.js — TradingAgents research-layer tests (self-contained).
 *
 * Registered by run-tests.js. Covers: every analyst/researcher/synthesizer,
 * OFF/SHADOW/ADVISORY modes, LLM schema/timeout/forbidden handling, analyst
 * failure isolation, missing data (no hallucination), price-integrity
 * consumption, prediction accuracy, persistence, plus an agent-level SHADOW
 * smoke run proving the Circuit BUY/SELL path is unchanged.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, intervalMs = 120, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    await sleep(intervalMs);
  }
  console.log('  ⚠ timed out waiting for: ' + what);
  return false;
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function readLedger(dir) {
  const f = path.join(dir, 'trades.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

const TMP = path.join(ROOT, '.test-tmp');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function mint(tag) {
  let h = 7;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  let s = '';
  for (let i = 0; i < 44; i++) { h = (h * 1103515245 + 12345) >>> 0; s += B58[h % 58]; }
  return s;
}

const SOL_USD = 150;
const BASE_SOL = 0.00001 / SOL_USD;
const NOW = Date.now();

function historySamples(sols, spacingMs = 15000) {
  return sols.map((sol, i) => ({
    ts: NOW - (sols.length - i) * spacingMs, priceUsd: sol * 150, priceSol: sol, source: 'mock'
  }));
}
const steadySeries = Array.from({ length: 20 }, (_, i) => BASE_SOL * Math.pow(1.0015, i));
const wildSeries = Array.from({ length: 20 }, (_, i) => (i % 2 ? BASE_SOL : BASE_SOL * 5));

const pairA = mint('TAPA');
const pairB = mint('TAPB');
function cand(over) {
  return Object.assign({
    symbol: 'TKN', mint: mint('TKN'), pairAddress: pairA, dex: 'mock',
    priceUsd: 1e-5, priceSol: BASE_SOL,
    liquidityUsd: 150000, volume24hUsd: 500000,
    change1hPct: -20, change5mPct: 2.5,
    recoveryPct: 2, recoveryStatus: 'ok', recoverySamples: 12,
    score: 70, source: 'mock'
  }, over || {});
}

const emptyIntegrity = { quarantined: [], lastWarning: null };
const metrics8 = {
  n: 8, wins: 6, losses: 2, winRate: 75, expectancyPct: 6, profitFactor: 3,
  maxDrawdownPct: 4, lossStreak: 1, winStreak: 3, avgWinSol: 0.004, avgLossSol: -0.003,
  totalPnlSol: 0.02, sumWinSol: 0.024, sumLossSol: -0.006
};
const ctx = (over) => Object.assign({
  portfolio: { positionsOpen: 0, maxPositions: 5, totalTrades: 10, realizedPnlSol: 0.02, winRate: 70, cashSol: 10, equitySol: 10.02, startingCapitalSol: 10, lossStreak: 1, maxDrawdownPct: 4 },
  metrics: metrics8,
  regime: { regime: 'bull', confidence: 0.8, reasoning: 'test' },
  health: { score: 90, status: 'healthy', gate: false },
  market: { solPriceUsd: 150, solMomentumPct: 0.1 },
  integrity: emptyIntegrity,
  historyByMint: {},
  universe: { candidates: 1, avgVolumeUsd: 100000 }
}, over || {});

// ---------------------------------------------------------------------------
async function testTradingAgents() {
  console.log('\n[test 21] TradingAgents — analysts, modes, LLM safety, prediction accuracy');
  const ta = require('../tradingagents-layer.js');
  const tech = require('../agents/technical-analyst.js');
  const quant = require('../agents/quant-analyst.js');
  const senti = require('../agents/sentiment-analyst.js');
  const mkt = require('../agents/market-analyst.js');
  const bullR = require('../agents/bull-researcher.js');
  const bearR = require('../agents/bear-researcher.js');
  const riskA = require('../agents/risk-analyst.js');
  const synthD = require('../agents/decision-synthesizer.js');
  const llm = require('../llm-adapter.js');

  // ---- technical analyst ----------------------------------------------------
  {
    const strong = tech.analyze({ candidate: cand({ recoveryPct: 5, volume24hUsd: 2000000 }), history: { samples: historySamples(steadySeries), warming: false } });
    check('technical: steady recovery → bullish with confidence', strong.direction === 'bullish' && strong.confidence > 0 && strong.momentum > 0 && strong.volatility < 40, strong.direction + ' conf=' + strong.confidence);
    check('technical: schema fields + dataQuality ok', strong.agent === 'technical' && Array.isArray(strong.reasoning) && strong.dataQuality === 'ok');
    const warm = tech.analyze({ candidate: cand({ recoveryPct: null, recoveryStatus: 'warming' }), history: { samples: [], warming: true } });
    check('technical: WARMING → neutral, withheld, insufficient_history', warm.direction === 'neutral' && warm.confidence === 0 && warm.dataQuality === 'insufficient_history');
    const wild = tech.analyze({ candidate: cand({ recoveryPct: -1 }), history: { samples: historySamples(wildSeries), warming: false } });
    check('technical: wild volatility + negative recovery → bearish', wild.direction === 'bearish' && wild.volatility >= 90, wild.direction + ' vol=' + wild.volatility);
    check('technical: no hallucinated numbers (all finite 0..100)', ['confidence', 'momentum', 'recoveryStrength', 'volatility', 'volumeConfirmation'].every((k) => Number.isFinite(strong[k]) && strong[k] >= 0 && strong[k] <= 100));
  }

  // ---- quant analyst --------------------------------------------------------
  {
    const q = quant.analyze({ candidate: cand(), metrics: metrics8, regime: { regime: 'bull' } });
    check('quant: positive history → expectedDirection up', q.expectedDirection === 'up' && q.setupQuality > 0 && q.dataQuality === 'ok');
    const cold = quant.analyze({ candidate: cand(), metrics: {}, regime: {} });
    check('quant: <5 trades → insufficient_history, flat, confidence 0', cold.dataQuality === 'insufficient_history' && cold.expectedDirection === 'flat' && cold.confidence === 0);
    const losing = quant.analyze({ candidate: cand(), metrics: Object.assign({}, metrics8, { expectancyPct: -4, lossStreak: 4 }), regime: { regime: 'dump' } });
    check('quant: losing window → expectedDirection down', losing.expectedDirection === 'down' && losing.riskScore > 0);
  }

  // ---- sentiment analyst (never fabricates) --------------------------------
  {
    const s = senti.analyze({ candidate: cand({ recoveryPct: 1.5 }), history: { samples: historySamples(steadySeries), warming: false }, market: { regime: 'bull', healthScore: 90 }, universe: { avgVolumeUsd: 100000 } });
    check('sentiment: real activity signals → bullish', s.direction === 'bullish' && s.confidence > 0 && s.volumeAcceleration > 0, s.direction + ' conf=' + s.confidence);
    const warm = senti.analyze({ candidate: cand({ recoveryStatus: 'warming', recoverySamples: 2 }), history: { samples: [], warming: true }, market: { regime: 'bull', healthScore: 90 }, universe: { avgVolumeUsd: 100000 } });
    check('sentiment: warming → unknown, confidence 0 (no fabrication)', warm.direction === 'unknown' && warm.confidence === 0);
    const noVol = senti.analyze({ candidate: cand({ liquidityUsd: 0, volume24hUsd: 0 }), history: { samples: historySamples(steadySeries), warming: false }, market: { regime: 'bull', healthScore: 90 }, universe: {} });
    check('sentiment: no activity data → unknown', noVol.direction === 'unknown' && noVol.confidence === 0);
    check('sentiment: reasoning admits no news/social source', s.reasoning.some((r) => /news|social/.test(r)));
  }

  // ---- market analyst (reports regime-detector, never replaces it) ---------
  {
    const m = mkt.analyze({ market: { regime: 'dump', regimeConfidence: 0.9, healthScore: 20, healthStatus: 'GATED', healthGate: true }, portfolio: {} });
    check('market: dump regime reported with low health', m.regime === 'dump' && m.marketHealth === 20);
    const none = mkt.analyze({ market: {} });
    check('market: no data → unknown, health 0 (never invented)', none.regime === 'unknown' && none.marketHealth === 0);
  }

  // ---- bull researcher ------------------------------------------------------
  {
    const b = bullR.analyze({ candidate: cand(), technical: { direction: 'bullish', confidence: 80, recoveryStrength: 70, volumeConfirmation: 60 }, quant: { expectedDirection: 'up', confidence: 75, setupQuality: 90 }, sentiment: { direction: 'bullish', confidence: 70, volumeAcceleration: 80 }, market: { regime: 'bull', marketHealth: 90, confidence: 80 } });
    check('bull: strong supportive inputs → case + confidence', b.case.length > 0 && b.confidence > 0);
    const empty = bullR.analyze({ candidate: cand({ score: null }), technical: {}, quant: {}, sentiment: {}, market: {} });
    check('bull: no evidence → confidence 0, case not fabricated', empty.confidence === 0 && empty.case.length === 1 && /not fabricated/.test(empty.case[0]));
  }

  // ---- bear researcher ------------------------------------------------------
  {
    const integritySusp = { dataQuality: 'suspicious', reasons: ['suspicious:EXTREME_PRICE_MOVE quarantine', 'PAIR_CHANGED'] };
    const b = bearR.analyze({
      candidate: cand({ liquidityUsd: 5000, volume24hUsd: 20000 }),
      technical: { volatility: 95 }, market: { regime: 'dump', healthGate: true },
      metrics: { lossStreak: 4, maxDrawdownPct: 22 }, integrity: integritySusp
    });
    check('bear: integrity + liquidity + regime risks → warnings + high riskScore', b.warnings.some((w) => w.indexOf('price_integrity_warning') === 0) && b.warnings.some((w) => w.indexOf('PAIR_CHANGED') === 0) && b.riskScore >= 55, 'risk=' + b.riskScore);
    check('bear: riskScore bounded 0..100', b.riskScore >= 0 && b.riskScore <= 100);
    const calm = bearR.analyze({ candidate: cand(), technical: { volatility: 5 }, market: { regime: 'bull' }, integrity: { dataQuality: 'ok' } });
    check('bear: benign candidate → low risk', calm.riskScore < 30);
  }

  // ---- risk analyst ---------------------------------------------------------
  {
    const r = riskA.analyze({
      candidate: cand({ liquidityUsd: 8000 }),
      technical: { volatility: 90 }, market: { regime: 'dump', marketHealth: 20, healthGate: true },
      bear: { riskScore: 90, warnings: ['PAIR_CHANGED'] },
      metrics: { lossStreak: 5, maxDrawdownPct: 25 },
      integrity: { dataQuality: 'suspicious', reasons: ['PAIR_CHANGED'] },
      exposure: { openPositions: 5, maxPositions: 5 }
    });
    check('risk: critical when everything is bad', (r.riskLevel === 'critical' || r.riskLevel === 'high') && r.warnings.some((w) => w.indexOf('price_integrity_warning') === 0), r.riskLevel);
    const low = riskA.analyze({ candidate: cand(), technical: { volatility: 10 }, market: { regime: 'bull', marketHealth: 90 }, bear: { riskScore: 10 }, integrity: { dataQuality: 'ok' }, metrics: {}, exposure: { openPositions: 1, maxPositions: 5 } });
    check('risk: benign → low', low.riskLevel === 'low');
  }

  // ---- decision synthesizer (research score is SEPARATE from Circuit) -------
  {
    const d = synthD.synthesize({
      symbol: 'TKN', mint: cand().mint, pairAddress: pairA,
      candidate: cand({ score: 67 }),
      technical: { direction: 'bullish', confidence: 80 },
      quant: { expectedDirection: 'up', confidence: 75 },
      sentiment: { direction: 'bullish', confidence: 70 },
      market: { regime: 'bull', confidence: 60 },
      bull: { confidence: 80 }, bear: { riskScore: 10 }, risk: { riskLevel: 'low', riskScore: 15 },
      integrity: { dataQuality: 'ok' }, circuitScore: 67
    });
    check('synth: strong research → BUY, researchScore >= 70', d.researchRecommendation === 'BUY' && d.researchScore >= 70, d.researchRecommendation + ' score=' + d.researchScore);
    check('synth: researchScore separate from circuitScore (67 untouched)', d.circuitScore === 67 && d.researchScore !== 67);
    const bearish = synthD.synthesize({
      candidate: cand({ score: 71 }),
      technical: { direction: 'bearish', confidence: 70 },
      quant: { expectedDirection: 'down', confidence: 70 },
      sentiment: { direction: 'unknown', confidence: 0 },
      market: { regime: 'dump', confidence: 70 },
      bull: { confidence: 0 }, bear: { riskScore: 90 }, risk: { riskLevel: 'critical', riskScore: 92 },
      integrity: { dataQuality: 'ok' }, circuitScore: 71
    });
    check('synth: heavy bear risk → AVOID even with circuit score 71', bearish.researchRecommendation === 'AVOID' && bearish.riskLevel === 'critical');
    const sus = synthD.synthesize({
      candidate: cand({ score: 78 }),
      technical: { direction: 'bullish', confidence: 90 },
      quant: { expectedDirection: 'up', confidence: 85 },
      sentiment: { direction: 'bullish', confidence: 80 },
      market: { regime: 'bull', confidence: 80 },
      bull: { confidence: 90 }, bear: { riskScore: 10 }, risk: { riskLevel: 'low', riskScore: 10 },
      integrity: { dataQuality: 'suspicious' }, circuitScore: 78
    });
    check('synth: integrity suspicious → capped HOLD, no BUY', sus.researchRecommendation === 'HOLD' && sus.dataQuality === 'suspicious' && sus.warnings.length > 0);
    check('synth: component scores present (technical/quant/sentiment/market/bull/bearRisk)', d.technicalScore != null && d.quantScore != null && d.sentimentScore != null && d.marketScore != null && d.bullScore != null && d.bearRisk != null);
  }

  // ---- evaluatePrediction: directional correctness --------------------------
  {
    const ev = (rec, pnl) => ta.evaluatePrediction({ researchRecommendation: rec, technical: {}, quant: {}, sentiment: {}, market: {}, bull: {} }, pnl);
    check('prediction: BUY + win → correct', ev('BUY', 8.1).length === 1 && ev('BUY', 8.1)[0].correct === true);
    check('prediction: AVOID + loss → correct', ev('AVOID', -7.5).length === 1 && ev('AVOID', -7.5)[0].correct === true);
    check('prediction: AVOID + win → incorrect (bearish wrong when market rises)', ev('AVOID', 8.1)[0].correct === false);
    check('prediction: HOLD expresses no direction → not counted', ev('HOLD', 8.1).length === 0);
    const multi = ta.evaluatePrediction({
      researchRecommendation: 'BUY',
      technical: { direction: 'bearish' },
      quant: { expectedDirection: 'up' },
      sentiment: { direction: 'neutral' },
      market: { regime: 'bull' },
      bull: { confidence: 60 }
    }, -6);
    // Directional calls: BUY rec + technical(bearish) + quant(up) + market(bull) + bull(conf 60)
    // = 5. Sentiment is neutral → expresses no view → not counted.
    check('prediction: agent-level calls evaluated independently', multi.length === 5, 'n=' + multi.length);
    check('prediction: mixed agents on a loss → some correct (bearish/regime) some incorrect (bullish)', multi.some((e) => e.correct) && multi.some((e) => !e.correct));
  }

  // ---- layer: modes + runCycle + commit + persistence ------------------------
  const dirT = fs.mkdtempSync(path.join(TMP, 'ta-unit-'));
  const logs = [];
  const mgr = ta.createTradingAgents({ dataDir: dirT, mode: 'SHADOW', llm: { url: '', key: '', model: '' }, log: (m) => logs.push(m) });
  check('layer: SHADOW enabled', mgr.enabled() === true && mgr.mode() === 'SHADOW');
  const c = cand();
  const cctx = ctx({
    historyByMint: { [c.mint]: { samples: historySamples(steadySeries), warming: false } }
  });
  const cycle = mgr.runCycle({ candidates: [c], positions: [], ctx: cctx });
  check('layer: runCycle produced a candidate row', cycle.rows.length === 1 && cycle.rows[0].type === 'candidate' && cycle.rows[0].mint === c.mint);
  const row = cycle.rows[0];
  check('layer: row carries all agent outputs + research score + integrity dataQuality', row.technical && row.quant && row.sentiment && row.market && row.bull && row.bear && row.risk && row.researchScore != null && row.dataQuality === 'ok');
  check('layer: no NaN/Infinity anywhere in the research row', !/NaN|Infinity/.test(JSON.stringify(row)));
  mgr.commit([row]);
  const decFile = path.join(dirT, ta.DECISIONS_FILE);
  check('layer: commit wrote tradingagents-decisions.jsonl', fs.existsSync(decFile));
  const dec = readJsonLines(decFile);
  check('layer: decision row persisted with circuit/final decision', dec.length === 1 && dec[0].finalDecision === 'FILTER' && dec[0].circuitDecision === 'FILTER' && dec[0].mode === 'SHADOW');
  check('layer: snapshot exposes latest + counters', mgr.snapshot().latest && mgr.snapshot().latest.symbol === 'TKN' && mgr.snapshot().counters.decisionsLogged === 1);
  check('layer: cache suppresses repeat research within TTL', mgr.runCycle({ candidates: [c], positions: [], ctx: cctx }).rows.length === 0);

  // ---- prediction tracking through the layer --------------------------------
  const dirP = fs.mkdtempSync(path.join(TMP, 'ta-pred-'));
  const mgrP = ta.createTradingAgents({ dataDir: dirP, mode: 'SHADOW', llm: {}, log: () => {} });
  mgrP.commit([{ type: 'candidate', ts: Date.now(), mint: pairB, symbol: 'WIN', researchRecommendation: 'BUY', technical: { direction: 'bullish' }, quant: { expectedDirection: 'up' }, sentiment: {}, market: {}, bull: {} }]);
  const r1 = mgrP.recordTradeOutcome({ mint: pairB, pnlPct: 8.5, entryTs: Date.now(), sellTs: Date.now() + 10 });
  check('prediction: BUY + win recorded as correct', r1.found && r1.evaluations.length === 3);
  const snapP = mgrP.snapshot();
  check('prediction: totals 1 correct / accuracy 100%', snapP.accuracy.n === 1 && snapP.accuracy.correct === 1 && snapP.accuracy.incorrect === 0 && snapP.accuracy.pct === 100, JSON.stringify(snapP.accuracy));
  mgrP.commit([{ type: 'candidate', ts: Date.now(), mint: pairB + 'X', symbol: 'LOSE', researchRecommendation: 'AVOID', technical: { direction: 'bearish' }, quant: {}, sentiment: {}, market: {}, bull: {} }]);
  mgrP.recordTradeOutcome({ mint: pairB + 'X', pnlPct: 8.2, entryTs: Date.now(), sellTs: Date.now() + 10 });
  const snapP2 = mgrP.snapshot();
  check('prediction: AVOID + win recorded as incorrect (bearish wrong)', snapP2.accuracy.n === 2 && snapP2.accuracy.correct === 1 && snapP2.accuracy.incorrect === 1 && snapP2.accuracy.pct === 50);
  check('prediction: per-agent technical accuracy tracked (2 calls: 1 right, 1 wrong)', snapP2.accuracy.byAgent.technical.n === 2 && snapP2.accuracy.byAgent.technical.correct === 1 && snapP2.accuracy.byAgent.technical.incorrect === 1, JSON.stringify(snapP2.accuracy.byAgent.technical));
  // metrics survive a reload (restart-safe)
  const mgrP2 = ta.createTradingAgents({ dataDir: dirP, mode: 'SHADOW', llm: {}, log: () => {} });
  check('prediction: accuracy persists across restart', mgrP2.snapshot().accuracy.n === 2 && mgrP2.snapshot().accuracy.correct === 1);

  // ---- OFF / ADVISORY modes -------------------------------------------------
  const dirO = fs.mkdtempSync(path.join(TMP, 'ta-off-'));
  const mgrOff = ta.createTradingAgents({ dataDir: dirO, mode: 'OFF', llm: {}, log: () => {} });
  check('layer: OFF disabled', mgrOff.enabled() === false);
  const offCycle = mgrOff.runCycle({ candidates: [cand()], positions: [], ctx: ctx() });
  check('layer: OFF runCycle returns nothing', offCycle.rows.length === 0);
  mgrOff.commit(offCycle.rows);
  check('layer: OFF writes no decisions file', !fs.existsSync(path.join(dirO, ta.DECISIONS_FILE)));
  check('layer: OFF recordTradeOutcome is a no-op', mgrOff.recordTradeOutcome({ mint: pairA, pnlPct: 5, entryTs: Date.now() }).found === false);
  const mgrAdv = ta.createTradingAgents({ dataDir: fs.mkdtempSync(path.join(TMP, 'ta-adv-')), mode: 'ADVISORY', llm: {}, log: () => {} });
  check('layer: ADVISORY mode accepted', mgrAdv.mode() === 'ADVISORY' && mgrAdv.enabled());

  // ---- failure isolation (one/all analysts fail) ----------------------------
  const dirF = fs.mkdtempSync(path.join(TMP, 'ta-fail-'));
  const throwing = () => { throw new Error('boom'); };
  const mgrF = ta.createTradingAgents({
    dataDir: dirF, mode: 'SHADOW', llm: {}, log: () => {},
    agents: { technical: { analyze: throwing }, sentiment: { analyze: throwing } }
  });
  const fCycle = mgrF.runCycle({ candidates: [cand()], positions: [], ctx: ctx({ historyByMint: {} }) });
  check('layer: analyst failure isolated (other agents continue, no crash)', fCycle.rows.length === 1 && fCycle.rows[0].technical && fCycle.rows[0].technical.unavailable === true && fCycle.rows[0].quant && !fCycle.rows[0].quant.unavailable);
  const dirG = fs.mkdtempSync(path.join(TMP, 'ta-failall-'));
  const allBad = {};
  for (const a of ta.AGENTS) allBad[a] = { analyze: throwing, synthesize: throwing };
  const mgrAll = ta.createTradingAgents({ dataDir: dirG, mode: 'SHADOW', llm: {}, log: () => {}, agents: allBad });
  const gCycle = mgrAll.runCycle({ candidates: [cand()], positions: [], ctx: ctx() });
  check('layer: all analysts failing → safe fallback row, no throw', gCycle.rows.length === 1 && gCycle.rows[0].researchScore == null);
  check('layer: failed-agent counter incremented', mgrF.snapshot().counters.failedAgents >= 2);

  // ---- price-integrity consumption -------------------------------------------
  {
    const dirI = fs.mkdtempSync(path.join(TMP, 'ta-int-'));
    const mgrI = ta.createTradingAgents({ dataDir: dirI, mode: 'SHADOW', llm: {}, log: () => {} });
    const quarantinedCand = cand({ mint: pairB });
    const intSnap = { quarantined: [{ mint: pairB, symbol: 'TKN', reason: 'EXTREME_PRICE_MOVE' }], lastWarning: { mint: pairB, reason: 'EXTREME_PRICE_MOVE', detail: 'previous=.. observed=..' } };
    const iRow = mgrI.runCycle({ candidates: [quarantinedCand], positions: [], ctx: ctx({ integrity: intSnap }) }).rows[0];
    check('integrity: research reports dataQuality suspicious for a quarantined mint', iRow && iRow.dataQuality === 'suspicious');
    check('integrity: research recommendation capped (no BUY on suspicious data)', iRow && iRow.researchRecommendation === 'HOLD');
    const bearWarn = bearR.analyze({ candidate: quarantinedCand, technical: { volatility: 10 }, market: { regime: 'bull' }, metrics: {}, integrity: { dataQuality: 'suspicious', reasons: ['PAIR_CHANGED'] } });
    check('integrity: bear researcher raises price_integrity_warning + PAIR_CHANGED', bearWarn.warnings.some((w) => w.indexOf('price_integrity_warning') === 0) && bearWarn.warnings.some((w) => w.indexOf('PAIR_CHANGED') === 0));
  }

  // ---- missing data (no hallucination through the full pipeline) -------------
  {
    const dirN = fs.mkdtempSync(path.join(TMP, 'ta-nodata-'));
    const mgrN = ta.createTradingAgents({ dataDir: dirN, mode: 'SHADOW', llm: {}, log: () => {} });
    const nRow = mgrN.runCycle({ candidates: [{ symbol: 'GHOST', mint: pairA, pairAddress: null, score: null }], positions: [], ctx: { portfolio: {}, metrics: {}, regime: {}, market: {}, integrity: emptyIntegrity, historyByMint: { [pairA]: { samples: [], warming: true } }, universe: {} } }).rows[0];
    check('nodata: row produced with neutral/unknowns (nothing invented)', nRow && !/NaN|Infinity/.test(JSON.stringify(nRow)) && nRow.dataQuality === 'ok');
    check('nodata: synthesizer holds (HOLD/AVOID) on missing evidence', nRow && (nRow.researchRecommendation === 'HOLD' || nRow.researchRecommendation === 'AVOID'));
  }

  // ---- LLM boundary (parse/schema/forbidden/timeout/fail-safe) ---------------
  {
    const chatFetch = (body) => async (url, opts) => ({ ok: true, json: async () => ({ choices: [{ message: { content: body } }] }) });
    const okRes = await llm.maybeLLMJson({ url: 'http://x', fetchImpl: chatFetch('{"narrative":"fine","concern":null}'), validate: (raw) => ({ ok: true, json: raw, errors: [] }) });
    check('llm: valid JSON accepted', okRes && okRes.ok && okRes.json.narrative === 'fine');
    const badRes = await llm.maybeLLMJson({ url: 'http://x', fetchImpl: chatFetch('not json at all'), validate: () => ({ ok: true }) });
    check('llm: malformed JSON rejected', badRes && badRes.ok === false && /not parseable/.test(badRes.errors[0]));
    const forbidRes = await llm.maybeLLMJson({ url: 'http://x', fetchImpl: chatFetch('{"narrative":"ok","execute":"rm -rf"}'), validate: () => ({ ok: true }) });
    check('llm: forbidden field rejected', forbidRes && forbidRes.ok === false && /unsafe field/.test(forbidRes.errors[0]));
    const schemaRes = await llm.maybeLLMJson({ url: 'http://x', fetchImpl: chatFetch('{"narrative":123}'), validate: (raw) => ({ ok: false, errors: ['narrative must be string'] }) });
    check('llm: schema validation enforced', schemaRes && schemaRes.ok === false && schemaRes.errors[0].indexOf('narrative') >= 0);
    const abortFetch = () => (_url, opts) => new Promise((_res, rej) => {
      const t = setTimeout(() => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), 5000);
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
    const timeoutRes = await llm.maybeLLMJson({ url: 'http://x', timeoutMs: 150, fetchImpl: abortFetch(), validate: () => ({ ok: true }) });
    check('llm: timeout fails safely', timeoutRes && timeoutRes.ok === false && /timeout/.test(timeoutRes.errors[0]));
    const netRes = await llm.maybeLLMJson({ url: 'http://x', fetchImpl: async () => { throw new Error('network down'); }, validate: () => ({ ok: true }) });
    check('llm: transport failure fails safely (never crashes)', netRes && netRes.ok === false);
    check('llm: no URL → null', (await llm.maybeLLMJson({ fetchImpl: chatFetch('{}') })) === null);

    // Layer-level: LLM unavailable → deterministic research continues.
    const dirL = fs.mkdtempSync(path.join(TMP, 'ta-llm-'));
    const mgrL = ta.createTradingAgents({ dataDir: dirL, mode: 'SHADOW', llm: { url: 'http://127.0.0.1:1', key: '', model: '' }, log: () => {} });
    const lRows = mgrL.runCycle({ candidates: [cand()], positions: [], ctx: ctx() }).rows;
    const note = await mgrL.enrichTopRow(lRows);
    check('layer: LLM dead → narrative null, research intact', note === null && lRows.length === 1 && lRows[0].researchScore != null);
  }

  // ---- missing prices / stale handled upstream, still reported --------------
  check('agents: technical/quant/sentiment/bear all export analyze', typeof tech.analyze === 'function' && typeof quant.analyze === 'function' && typeof senti.analyze === 'function' && typeof bearR.analyze === 'function');
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 22. AGENT-LEVEL SHADOW SMOKE — research records decisions; Circuit path unchanged.
// ---------------------------------------------------------------------------
async function testTradingAgentsAgent() {
  console.log('\n[test 22] TradingAgents SHADOW — agent smoke (Circuit execution unchanged)');
  const AGENT = path.join(ROOT, 'agentd.js');
  const dir = path.join(TMP, 'ta-agent-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });

  const series = [];
  for (let i = 0; i < 220; i++) series.push(BASE_SOL * Math.pow(1 + 0.0015, i));
  const mf = path.join(dir, 'mock.json');
  fs.writeFileSync(mf, JSON.stringify({ solPriceUsd: SOL_USD, tokens: [{ symbol: 'TAX', mint: mint('TAX'), priceUsd: 0.00001, priceSol: BASE_SOL, liquidityUsd: 150000, volume24hUsd: 500000, change1hPct: -20, change5mPct: 2.5, series }] }));

  const env = Object.assign({}, process.env, {
    CIRCUIT_AGENT_DATA_DIR: dir,
    CIRCUIT_MOCK_MARKET_FILE: mf,
    CIRCUIT_MONITOR_MS: '200',
    CIRCUIT_DISCOVERY_MS: '800',
    CIRCUIT_SAMPLE_MS: '150',
    CIRCUIT_HISTORY_WARM_MS: '2000',
    CIRCUIT_MAX_PRICE_AGE_MS: '3000',
    CIRCUIT_AGENT_LOOP_MS: '3600000',
    CIRCUIT_REFLECT_MS: '3600000',
    CIRCUIT_TA_MODE: 'SHADOW'
  });
  const child = spawn(process.execPath, [AGENT], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const stop = () => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    try { child.send({ type: 'shutdown' }); } catch (_) { child.kill(); }
    setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } }, 4000);
  });
  try {
    const bought = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY'), 40000, 200, 'BUY');
    check('agent: BUY still executes in SHADOW', bought);
    const decision = await waitFor(() => {
      const f = path.join(dir, 'tradingagents-decisions.jsonl');
      if (!fs.existsSync(f)) return false;
      return readJsonLines(f).some((r) => r && r.type === 'candidate');
    }, 30000, 200, 'candidate research decision');
    check('agent: candidate research decision logged', decision);
    const hbSeen = await waitFor(() => {
      const h = readJson(path.join(dir, 'heartbeat.json'));
      return h && h.tradingAgents && h.tradingAgents.enabled === true;
    }, 15000, 200, 'heartbeat tradingAgents block');
    check('agent: heartbeat reports TradingAgents enabled (SHADOW)', hbSeen);
    const hb = readJson(path.join(dir, 'heartbeat.json'));
    const rows = readJsonLines(path.join(dir, 'tradingagents-decisions.jsonl'));
    const candRow = rows.find((r) => r.type === 'candidate');
    check('agent: decision has researchScore + circuitScore + mode SHADOW', candRow && Number.isFinite(candRow.researchScore) && Number.isFinite(candRow.circuitScore) && candRow.mode === 'SHADOW');
    check('agent: research is separate — decision row never gates (finalDecision attached)', candRow && (candRow.finalDecision === 'BUY' || candRow.finalDecision === 'FILTER'));
    const sold = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL' && t.partial !== true), 50000, 200, 'take-profit SELL');
    check('agent: take-profit SELL still fires unchanged', sold);
    const sells = readLedger(dir).filter((t) => t.side === 'SELL');
    const sell = sells.find((t) => t.reason === 'take-profit' && t.partial !== true);
    check('agent: runner P&L ≈ +6..+8.5% with combined +5..+7.5% (ATR intact)', sell && sell.realizedPnlPct > 6 && sell.realizedPnlPct < 8.5 && sell.tradeRealizedPnlPct > 5 && sell.tradeRealizedPnlPct < 7.5);
    check('agent: ledger has one BUY + partial + final (no research side-effects)', readLedger(dir).filter((t) => t.side === 'BUY').length === 1 && sells.length === 2 && sells.some((t) => t.reason === 'partial-take'));
    const p = readJson(path.join(dir, 'portfolio.json'));
    check('agent: paper account intact (1 round trip)', p && p.totalTrades === 1 && p.winningTrades === 1);
    check('agent: no forbidden execution strings in new TA files', !/signTransaction|sendTransaction|sendRawTransaction|privateKey|secretKey|Math\.random/.test(fs.readFileSync(path.join(ROOT, 'tradingagents-layer.js'), 'utf8')) && !/signTransaction|sendTransaction|privateKey|secretKey|Math\.random/.test(fs.readFileSync(path.join(ROOT, 'agents', 'decision-synthesizer.js'), 'utf8')));
    check('agent: paper-only invariants in heartbeat', hb && hb.paper === true && hb.wallet === 'DISABLED' && hb.broadcast === 'DISABLED');
    await stop();
    check('agent: clean exit', child.exitCode === 0);
  } finally {
    try { child.kill(); } catch (_) { /* gone */ }
  }
}

/** Running totals so run-tests.js can fold these assertions into the suite result. */
function totals() {
  return { passed, failed };
}

module.exports = { testTradingAgents, testTradingAgentsAgent, totals };
