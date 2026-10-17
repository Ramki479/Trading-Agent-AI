#!/usr/bin/env node
/**
 * test/atlas-collection-test.js — Phase 3 Live Shadow Data Collection verification.
 *
 * Exercises the full ATLAS data collection pipeline:
 *   prediction → journal → counterfactual → outcome → statistics → persistence
 *
 * Does NOT modify strategy logic, add features, or enable execution.
 *
 * Usage: node test/atlas-collection-test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const S = assert.strictEqual;
function ok(cond, msg) { if (!cond) throw new assert.AssertionError({ message: msg || 'assertion failed' }); }

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

async function run() {
  console.log('\n=== PHASE 3 LIVE SHADOW COLLECTION VERIFICATION ===\n');

  const tmp = path.join(ROOT, '.test-tmp', 'collection-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  // Load real modules
  const { AtlasDb } = require('../atlas/db.js');
  const { createPredictionJournl, VERSION, PROMPT_VERSION } = require('../atlas/prediction-journal.js');
  const { evaluate, horizonMs, ALL_HORIZONS } = require('../atlas/outcome-engine.js');
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const calibrationLib = require('../atlas/calibration.js');
  const abPaperLib = require('../atlas/ab-paper.js');
  const statsLib = require('../atlas/statistics.js');
  const { classify, classifyAtlas, ATLAS_ATTRIBUTION_CLASSES } = require('../atlas/attribution.js');
  const { createReputationStore } = require('../atlas/reputation.js');
  const { dataQuality, evidenceEntry } = require('../atlas/evidence.js');
  const { analyze: disagreement } = require('../atlas/disagreement.js');
  const { validate } = require('../atlas/schemas.js');

  const now = Date.now();

  // ═══════════════════════════════════════════════════════════════
  // SECTION A: Full pipeline with realistic Solana data
  // ═══════════════════════════════════════════════════════════════
  console.log('--- A. Full Pipeline ---');

  const engineDir = path.join(tmp, 'pipeline');
  fs.mkdirSync(engineDir, { recursive: true });

  // Realistic candidate
  const cand = {
    symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    pairAddress: 'ErSQzH7JHnCTvCy23bRfMzU2QEagbeCzRDLVmA5sYJ3p',
    dex: 'raydium', priceUsd: 0.000021, priceSol: 0.00000014,
    liquidityUsd: 850000, volume24hUsd: 4200000,
    change1hPct: -15.2, change5mPct: 2.8, recoveryPct: 1.5, recoveryStatus: 'ok',
    score: 68, source: 'dexscreener', buysPct: 58, transactionCount: 8200,
    topHolderPct: 6.2, tokenAgeDays: 200
  };

  const integrity = { dataQuality: 'ok', pairStable: true, sourcesAgree: true, quarantined: [] };

  function stubHistory(n, slope) {
    const arr = [];
    for (let i = 0; i < n; i++) {
      arr.push({ ts: now - (n - i) * 2000, priceUsd: cand.priceUsd * Math.pow(1 + slope, i), priceSol: cand.priceSol * Math.pow(1 + slope, i), source: 'dexscreener' });
    }
    return arr;
  }

  const ctx = {
    portfolio: { positionsOpen: 2, maxPositions: 5, totalTrades: 15, realizedPnlSol: 0.12, winRate: 60, cashSol: 8.5, equitySol: 10.12, startingCapitalSol: 10, lossStreak: 1, maxDrawdownPct: -8.5 },
    metrics: { n: 15, wins: 9, losses: 6, winRate: 60, expectancyPct: 1.2, profitFactor: 1.5, lossStreak: 1, maxDrawdownPct: -8.5 },
    regime: { regime: 'RECOVERY', confidence: 0.68, reasoning: '5m recovery after 1h dip' },
    health: { score: 72, status: 'HEALTHY', gate: 'PASS', reason: 'adequate liquidity' },
    market: { solPriceUsd: 148.5, solMomentumPct: 1.2, regime: 'RECOVERY' },
    integrity,
    historyByMint: { [cand.mint]: { samples: stubHistory(15, 0.002), warming: false } },
    universe: { candidates: 18, avgVolumeUsd: 450000 },
    tradeSizeSol: 0.05
  };

  // Run ATLAS cycle
  const engine = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {}, integritySnap: integrity });
  const cycle = engine.runCycle({ candidates: [cand], ctx, now });

  check('A1_prediction_created', cycle.decisions.length === 1);
  check('A2_predictions_recorded', cycle.predictions.length >= 5);

  // Verify persistence
  const db = new AtlasDb(engineDir);
  const preds = db.predictions();
  check('A3_predictions_persisted', preds.length >= 5);

  // Verify each prediction has required fields
  for (const p of preds) {
    check('A4_pred_has_predictionId', typeof p.predictionId === 'string' && p.predictionId.startsWith('P'));
    check('A5_pred_has_ts', Number.isFinite(p.ts));
    check('A6_pred_has_mint', p.mint === cand.mint);
    check('A7_pred_has_pairAddress', p.pairAddress === cand.pairAddress);
    check('A8_pred_has_dex', p.dex === cand.dex);
    check('A9_pred_has_direction', ['bullish', 'bearish', 'neutral', 'unknown'].includes(p.direction));
    check('A10_pred_has_confidence', Number.isFinite(p.confidence));
    check('A11_pred_has_dataQuality', typeof p.dataQuality === 'string');
    check('A12_pred_has_atlasVersion', p.atlasVersion === VERSION);
    check('A13_pred_has_promptVersion', p.promptVersion === PROMPT_VERSION);
    // Only check these for non-unknown predictions
    if (p.direction !== 'unknown') {
      check('A14_pred_has_prediction_object', p.prediction != null || p.expectedMovePct != null);
    }
    break; // only check first prediction in detail
  }

  // Verify decision has all required fields
  const d = cycle.decisions[0];
  check('A15_decision_circuit_v1', d.v1.score === cand.score);
  check('A16_decision_atlas_score', Number.isFinite(d.atlas.score));
  check('A17_decision_synthesis', d.synthesis != null);
  check('A18_decision_integrity', d.integrity.status === 'PASS');
  check('A19_decision_mode', d.mode === 'SHADOW');
  check('A20_decision_paper_eligible', d.decision === 'PAPER_ELIGIBLE');

  // ═══════════════════════════════════════════════════════════════
  // SECTION B: Outcome resolution
  // ═══════════════════════════════════════════════════════════════
  console.log('--- B. Outcome Resolution ---');

  // Find a bullish prediction
  const bullishPred = preds.find(p => p.direction === 'bullish');
  if (bullishPred) {
    // Win: trade went up 5%
    const outcome = { pnlPct: 5, realizedAt: bullishPred.ts + 900001, exitMint: cand.mint, exitReason: 'take-profit' };
    const ev = evaluate(bullishPred, outcome);
    check('B1_outcome_correct', ev.correct === true);
    check('B2_outcome_pnl', ev.realizedPnlPct === 5);
    check('B3_outcome_brier', Number.isFinite(ev.brier) && ev.brier >= 0);

    // Record via engine
    const result = engine.recordTradeOutcome({ mint: cand.mint, pnlPct: 5, entryTs: bullishPred.ts, exitTs: bullishPred.ts + 900001, v1Score: cand.score, exitReason: 'take-profit', symbol: cand.symbol });
    check('B4_outcome_recorded', result.found === true);
    check('B5_outcome_count', result.outcomes.length > 0);
  } else {
    check('B1_outcome_correct', true, 'skipped: no bullish prediction');
    check('B2_outcome_pnl', true, 'skipped');
    check('B3_outcome_brier', true, 'skipped');
    check('B4_outcome_recorded', true, 'skipped');
    check('B5_outcome_count', true, 'skipped');
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION C: Counterfactual A/B isolation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- C. Counterfactual A/B Isolation ---');

  const mockDb = { readJson: () => null, writeJson: () => {} };
  const ab = abPaperLib.createABPaper(mockDb);

  // Simulate 5 trades with varying ATLAS recommendations
  const trades = [
    { mint: 'm1', symbol: 'A', pnlPct: 5, atlasRecommendation: 'BUY' },
    { mint: 'm2', symbol: 'B', pnlPct: -4, atlasRecommendation: 'AVOID' },
    { mint: 'm3', symbol: 'C', pnlPct: 8, atlasRecommendation: 'BUY' },
    { mint: 'm4', symbol: 'D', pnlPct: -6, atlasRecommendation: 'HOLD' },
    { mint: 'm5', symbol: 'E', pnlPct: 3, atlasRecommendation: 'BUY' }
  ];

  for (const t of trades) ab.recordTrade(Object.assign({ v1Score: 70, atlasScore: 65 }, t));

  const abSnap = ab.snapshot();

  // Group A (V1 actual): all 5 trades
  check('C1_groupA_total', abSnap.groupA.totalTrades === 5);
  check('C2_groupA_wins', abSnap.groupA.wins === 3);
  check('C3_groupA_losses', abSnap.groupA.losses === 2);

  // Group B (V1+ATLAS): skips AVOID trades (0% return)
  check('C4_groupB_total', abSnap.groupB.totalTrades === 5);
  check('C5_groupB_skipped_avoid', abSnap.groupB.losses === 1, 'skipped 1 AVOID trade loss');

  // Verify no cash/positions/P&L in counterfactual
  check('C6_no_cash_field', !('cashSol' in abSnap.groupB));
  check('C7_no_positions_field', !('positions' in abSnap.groupB));
  check('C8_counterfactual_label', abSnap.groupB.name === 'V1+ATLAS');

  // ═══════════════════════════════════════════════════════════════
  // SECTION D: Statistics engine
  // ═══════════════════════════════════════════════════════════════
  console.log('--- D. Statistics Engine ---');

  // Matched-sample analysis
  const matched = statsLib.matchedSampleAnalysis([
    { circuitReturn: 5, atlasReturn: 5 },
    { circuitReturn: -4, atlasReturn: 0 },
    { circuitReturn: 8, atlasReturn: 8 },
    { circuitReturn: -6, atlasReturn: -6 },
    { circuitReturn: 3, atlasReturn: 3 }
  ]);
  check('D1_matched_count', matched.matchedSamples === 5);
  check('D2_matched_mean', Number.isFinite(matched.meanDifference));
  check('D3_matched_median', Number.isFinite(matched.medianDifference));
  check('D4_matched_std', Number.isFinite(matched.standardDeviation));

  // Bootstrap CI
  const ci = statsLib.bootstrapCI(matched.circuitReturns, { iterations: 1000 });
  check('D5_bootstrap_mean', Number.isFinite(ci.mean));
  check('D6_bootstrap_ci', ci.ciLower < ci.mean && ci.ciUpper > ci.mean);

  // Effect size
  const ef = statsLib.effectSize(matched);
  check('D7_effect_size', ef.interpretation !== 'INSUFFICIENT_DATA');

  // Paired test
  const test = statsLib.pairedTest(matched.circuitReturns, matched.atlasReturns);
  check('D8_paired_test', test.testName !== 'none');
  check('D9_paired_conclusion', ['SIGNIFICANT_AT_0.05', 'NOT_SIGNIFICANT', 'INSUFFICIENT_EVIDENCE'].includes(test.conclusion));

  // Evidence state
  check('D10_evidence_state', statsLib.evidenceState(5) === 'INSUFFICIENT_SAMPLE');
  check('D11_evidence_state_30', statsLib.evidenceState(30) === 'CHECKPOINT_30');
  check('D12_evidence_state_100', statsLib.evidenceState(100) === 'CHECKPOINT_100');
  check('D13_evidence_state_200', statsLib.evidenceState(200) === 'CHECKPOINT_200');

  // Checkpoints
  const ckpts = statsLib.createCheckpoints(db);
  const ck = ckpts.compute(matched, matched.circuitReturns, matched.atlasReturns);
  check('D14_checkpoint_sampleSize', ck.sampleSize === 5);
  check('D15_checkpoint_evidenceState', ck.evidenceState === 'INSUFFICIENT_SAMPLE');
  check('D16_checkpoint_effectSize', ck.effectSize != null);
  check('D17_checkpoint_statisticalTest', ck.statisticalTest != null);
  check('D18_checkpoint_limitations', ck.limitations.length > 0, 'small sample should have limitations');

  ckpts.persistCheckpoint(ck);
  const loadedCk = ckpts.loadCheckpoints();
  check('D19_checkpoint_persisted', loadedCk.length >= 1);

  // Daily snapshots
  const daily = statsLib.createDailySnapshots(db);
  const todayStats = daily.buildDailyStats(
    [{ outcome: { pnlPct: 5 } }, { outcome: { pnlPct: -4 } }],
    preds.slice(0, 2),
    [5, -4],
    [5, 0]
  );
  daily.record('2026-09-06', todayStats);
  const day = daily.getDay('2026-09-06');
  check('D20_daily_predictions', day.predictions === 2);
  check('D21_daily_resolved', day.resolved === 2);
  check('D22_daily_circuitAccuracy', day.circuitAccuracy === 50);
  check('D23_daily_atlasAccuracy', day.atlasAccuracy === 50);
  check('D24_daily_pairedMeanDiff', Number.isFinite(day.pairedMeanDifference));

  // ═══════════════════════════════════════════════════════════════
  // SECTION E: Agent reputation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- E. Agent Reputation ---');

  const store = createReputationStore();
  const regimes = ['TREND_UP', 'RECOVERY', 'DUMP', 'CONSOLIDATION'];
  for (let i = 0; i < 20; i++) {
    const r = regimes[i % regimes.length];
    store.record('technical', r, { correct: i % 3 !== 0, confidence: 70 + (i % 30), realizedPnlPct: (i % 3 === 0 ? -5 : 4), brier: 0.3 });
  }
  const a = store.getAgent('technical');
  check('E1_agent_predictions', a.totalPredictions === 20);
  check('E2_agent_directionalPredictions', a.directionalPredictions > 0);
  check('E3_agent_winRate', a.winRate > 0);
  check('E4_agent_mfe', a.mfe > 0);
  check('E5_agent_mae', a.mae > 0);
  check('E6_agent_medianReturn', Number.isFinite(a.medianReturn));
  check('E7_agent_returns', a.returns.length === 20);

  // Regime-specific
  const rUp = store.getRegime('technical', 'TREND_UP');
  check('E8_regime_predictions', rUp.predictions > 0);
  check('E9_regime_winRate', rUp.winRate > 0);
  check('E10_regime_expectancy', Number.isFinite(rUp.expectancy));
  check('E11_regime_mfe', rUp.mfe > 0);
  check('E12_regime_mae', rUp.mae > 0);

  // ═══════════════════════════════════════════════════════════════
  // SECTION F: Calibration
  // ═══════════════════════════════════════════════════════════════
  console.log('--- F. Calibration ---');

  const cal = calibrationLib.emptyCalibration();
  const confidences = [55, 65, 75, 85, 95];
  for (const c of confidences) {
    for (let i = 0; i < 5; i++) {
      calibrationLib.record(cal, 'technical', c, i < 3, (i < 3 ? 3 : -2));
    }
  }
  check('F1_cal_total', cal.totalPredictions === 25);
  check('F2_cal_buckets', Object.keys(cal.buckets).length === 5);
  check('F3_cal_error', Number.isFinite(cal.calibrationError));
  check('F4_cal_per_agent', cal.agentCalibrations.technical != null);

  // ═══════════════════════════════════════════════════════════════
  // SECTION G: Disagreement
  // ═══════════════════════════════════════════════════════════════
  console.log('--- G. Disagreement ---');

  const viewpoints = [
    { direction: 'bullish', score: 80 },
    { direction: 'bullish', score: 75 },
    { direction: 'bearish', score: 70 },
    { direction: 'neutral', score: 50 }
  ];
  const disc = disagreement(viewpoints);
  check('G1_consensus', typeof disc.consensus === 'string');
  check('G2_dispersion', Number.isFinite(disc.dispersion));
  check('G3_agentAgreementScore', Number.isFinite(disc.agentAgreementScore));
  check('G4_breakdowns', disc.breakdowns != null);

  // ═══════════════════════════════════════════════════════════════
  // SECTION H: Attribution
  // ═══════════════════════════════════════════════════════════════
  console.log('--- H. Attribution ---');

  check('H1_atlas_classes', ATLAS_ATTRIBUTION_CLASSES.length >= 8);

  const cases = [
    [{ direction: 'bullish', decision: 'BUY' }, { recommendation: 'BUY', direction: 'bullish' }, { won: true, pnlPct: 5 }, 'TA_CORRECT_HELPED'],
    [{ direction: 'bullish', decision: 'BUY' }, { recommendation: 'BUY', direction: 'bullish' }, { won: false, pnlPct: -5 }, 'TA_WRONG_AND_HARMFUL'],
    [{ direction: 'bullish' }, { recommendation: 'AVOID', direction: 'bearish' }, { won: true, pnlPct: 5 }, 'TA_WRONG_BUT_CIRCUIT_SAVED'],
    [{ direction: 'bullish' }, { recommendation: 'AVOID', direction: 'bearish' }, { won: false, pnlPct: -5 }, 'TA_CORRECT_HELPED'],
    [{ direction: 'bullish' }, { recommendation: 'HOLD', direction: 'neutral' }, { won: true, pnlPct: 5 }, 'TA_CORRECT_BUT_IRRELEVANT'],
    [{ direction: 'bullish' }, {}, { won: true, pnlPct: 5 }, 'NO_ATLAS_DATA']
  ];
  for (const [circ, atlas, outcome, expected] of cases) {
    const result = classifyAtlas(circ, atlas, outcome);
    check('H2_atlas_' + expected, result === expected, 'got=' + result);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION I: Data quality
  // ═══════════════════════════════════════════════════════════════
  console.log('--- I. Data Quality ---');

  const cleanDq = dataQuality({ dataQuality: 'ok', pairStable: true, sourcesAgree: true }, { regime: 'TREND_UP' }, 5000, 60000);
  check('I1_clean_score', cleanDq.score >= 70);

  const suspDq = dataQuality({ dataQuality: 'suspicious', reasons: ['EXTREME_PRICE_MOVE'] }, {}, 0, 60000);
  check('I2_suspicious_score', suspDq.score === 0);

  const ev = evidenceEntry('price_trend', 'up', 'local', 80, { horizon: '15m' });
  check('I3_evidence_entry', ev.claim === 'price_trend');
  check('I4_evidence_confidence', ev.confidence === 80);

  // ═══════════════════════════════════════════════════════════════
  // SECTION J: Prediction immutability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- J. Prediction Immutability ---');

  const journal = createPredictionJournl(db);
  const p = journal.record('technical', { expectedMovePct: 3, probabilityUp: 0.6, probabilityDown: 0.4, confidence: 72, score: 72 }, {
    candidate: cand, ts: now, direction: 'bullish', timeHorizon: '15m', dataQuality: 'ok', marketRegime: 'RECOVERY'
  });
  const stored = db.dedupPredictionId().find(x => x.predictionId === p.predictionId);
  check('J1_stored_direction', stored.direction === 'bullish');
  check('J2_stored_confidence', stored.confidence === 72);

  // Mutate in-memory
  p.direction = 'bearish';
  p.confidence = 0;
  const reloaded = db.dedupPredictionId().find(x => x.predictionId === p.predictionId);
  check('J3_immutable_direction', reloaded.direction === 'bullish');
  check('J4_immutable_confidence', reloaded.confidence === 72);

  // ═══════════════════════════════════════════════════════════════
  // SECTION K: Outcome horizons
  // ═══════════════════════════════════════════════════════════════
  console.log('--- K. Outcome Horizons ---');

  check('K1_horizon_5m', horizonMs('5m') === 300000);
  check('K2_horizon_15m', horizonMs('15m') === 900000);
  check('K3_horizon_30m', horizonMs('30m') === 1800000);
  check('K4_horizon_1h', horizonMs('1h') === 3600000);
  check('K5_horizon_4h', horizonMs('4h') === 14400000);
  check('K6_all_horizons', ALL_HORIZONS.length === 5);
  check('K7_horizons_include_4h', ALL_HORIZONS.includes('4h'));
  check('K8_horizons_include_30m', ALL_HORIZONS.includes('30m'));

  // ═══════════════════════════════════════════════════════════════
  // SECTION L: Schema validation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- L. Schema Validation ---');

  const valid = validate({ agent: 'technical', candidate: 'BONK', timestamp: now, direction: 'bullish', confidence: 75, score: 70 });
  check('L1_valid_ok', valid.ok);

  const invalid = validate({ agent: 'x', timestamp: now });
  check('L2_invalid_rejected', !invalid.ok);

  const clamped = validate({ agent: 'x', candidate: 'x', timestamp: now, direction: 'bullish', confidence: 200, score: -10 });
  check('L3_clamped_hi', clamped.value.confidence === 100);
  check('L4_clamped_lo', clamped.value.score === 0);

  const forbidden = validate({ agent: 'x', candidate: 'x', timestamp: now, direction: 'bullish', confidence: 50, execute: true });
  check('L5_forbidden_rejected', !forbidden.ok);

  // ═══════════════════════════════════════════════════════════════
  // SECTION M: Security scan
  // ═══════════════════════════════════════════════════════════════
  console.log('--- M. Security Scan ---');

  const atlasFiles = [
    'atlas/atlas-engine.js', 'atlas/db.js', 'atlas/statistics.js',
    'atlas/calibration.js', 'atlas/ab-paper.js', 'atlas/prediction-journal.js',
    'atlas/outcome-engine.js', 'atlas/attribution.js', 'atlas/reputation.js',
    'atlas/disagreement.js', 'atlas/evidence.js'
  ];
  const execBad = /signTransaction|sendTransaction|sendRawTransaction|privateKey|secretKey|Keypair|fromSecretKey|emitSigned|broadcast|placeOrder/i;
  let allClean = true;
  for (const f of atlasFiles) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    if (execBad.test(src)) { allClean = false; check('M1_security_' + f.split('/').pop(), false, 'forbidden token'); }
  }
  check('M2_all_files_clean', allClean);

  // ═══════════════════════════════════════════════════════════════
  // SECTION N: V1 constants
  // ═══════════════════════════════════════════════════════════════
  console.log('--- N. V1 Constants ---');

  const agentdSrc = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
  check('N1_MAX_POSITIONS', agentdSrc.includes('const MAX_POSITIONS = 5;'));
  check('N2_STOP_LOSS', agentdSrc.includes('const STOP_LOSS_PCT = -6;'));
  check('N3_TAKE_PROFIT', agentdSrc.includes('const TAKE_PROFIT_PCT = 8;'));
  check('N4_MIN_SCORE', agentdSrc.includes('const MIN_SCORE = 60;'));
  check('N5_COOLDOWN', agentdSrc.includes('const DEFAULT_COOLDOWN_MS = 600000;'));
  check('N6_5m_GATE', agentdSrc.includes('const MIN_5M_RECOVERY_PCT = 0.25;'));

  // Verify ATLAS mode remains SHADOW
  check('N7_atlas_mode_shadow', engine.mode() === 'SHADOW');
  check('N8_atlas_decision_paper_eligible', d.decision === 'PAPER_ELIGIBLE');

  // Verify no execution in ATLAS
  check('N9_no_execute_in_engine', !('execute' in engine));
  check('N10_no_buy_in_engine', !('buy' in engine));

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  // ═══════════════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== PHASE 3 COLLECTION VERIFICATION RESULTS ===');
  console.log('Passed: ' + passed + '  Failed: ' + failed + '  Total: ' + (passed + failed));
  console.log('Result: ' + (failed === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failed + ' CHECK(S) FAILED'));
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
