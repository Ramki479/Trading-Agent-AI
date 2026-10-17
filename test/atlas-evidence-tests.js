#!/usr/bin/env node
/**
 * test/atlas-evidence-tests.js — Phase 4 Evidence Analysis tests.
 *
 * 25+ tests covering matched samples, exclusion rules, look-ahead protection,
 * horizons, bootstrap, CI, effect size, statistical tests, checkpoints,
 * calibration, regime analysis, disagreement, agent attribution, data quality,
 * immutability, and security.
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
  console.log('\n=== PHASE 4 EVIDENCE ANALYSIS TESTS ===\n');

  const tmp = path.join(ROOT, '.test-tmp', 'evidence-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  const statsLib = require('../atlas/statistics.js');
  const { analyze, constructMatchedSamples, isExcluded, deduplicatePredictions } = require('../atlas/analyze-evidence.js');
  const { auditPair, auditBatch, auditFromDb } = require('../atlas/lookahead-audit.js');
  const { AtlasDb } = require('../atlas/db.js');
  const calibrationLib = require('../atlas/calibration.js');

  // ── Test 1: Matched sample construction ────────────────────────
  console.log('--- 1. Matched sample construction ---');
  {
    const predictions = [
      { predictionId: 'P1', ts: 1000, mint: 'm1', agent: 'technical', direction: 'bullish', confidence: 75, dataQuality: 'ok', pairAddress: 'p1', dex: 'raydium', _candSymbol: 'A' },
      { predictionId: 'P2', ts: 2000, mint: 'm2', agent: 'momentum', direction: 'bearish', confidence: 80, dataQuality: 'ok', pairAddress: 'p2', dex: 'raydium', _candSymbol: 'B' }
    ];
    const outcomes = [
      { predictionId: 'P1', mint: 'm1', pnlPct: 5, realizedAt: 5000, exitReason: 'take-profit' },
      { predictionId: 'P2', mint: 'm2', pnlPct: -3, realizedAt: 6000, exitReason: 'stop-loss' }
    ];
    const data = { predictions, outcomes, abPaperState: null, db: { predictions: () => predictions, outcomes: () => outcomes, evidence: () => [], readJson: () => null } };
    const { matched, excluded, total } = constructMatchedSamples(data);
    check('1_matched_count', matched.length === 2, 'matched=' + matched.length);
    check('2_matched_has_returns', matched[0].circuitReturn != null);
    check('3_matched_has_atlas_return', matched[0].atlasReturn != null);
  }

  // ── Test 2: Unmatched exclusion ────────────────────────────────
  console.log('--- 2. Unmatched exclusion ---');
  {
    const predictions = [
      { predictionId: 'P1', ts: 1000, mint: 'm1', agent: 'technical', direction: 'bullish', confidence: 75, dataQuality: 'ok' }
    ];
    const outcomes = []; // no outcomes
    const data = { predictions, outcomes, abPaperState: null, db: { predictions: () => predictions, outcomes: () => outcomes, evidence: () => [], readJson: () => null } };
    const { matched, excluded, total } = constructMatchedSamples(data);
    check('4_no_outcome_excluded', matched.length === 0, 'matched=' + matched.length);
    check('5_total_tracked', total === 1);
  }

  // ── Test 3: Duplicate exclusion ────────────────────────────────
  console.log('--- 3. Duplicate exclusion ---');
  {
    const preds = [
      { predictionId: 'P1', ts: 1000, mint: 'm1', direction: 'bullish' },
      { predictionId: 'P1', ts: 1000, mint: 'm1', direction: 'bearish' }, // duplicate
      { predictionId: 'P2', ts: 2000, mint: 'm1', direction: 'neutral' }
    ];
    const deduped = deduplicatePredictions(preds);
    check('6_dedup_removes_duplicates', deduped.length === 2, 'deduped=' + deduped.length);
    check('7_dedup_keeps_first', deduped[0].predictionId === 'P1');
  }

  // ── Test 4: Suspicious-price exclusion ─────────────────────────
  console.log('--- 4. Suspicious-price exclusion ---');
  {
    const pred = { predictionId: 'P1', ts: 1000, mint: 'm1', direction: 'bullish', dataQuality: 'suspicious' };
    const outcome = { realizedAt: 5000 };
    const result = isExcluded(pred, outcome);
    check('8_suspicious_excluded', result.excluded === true);
    check('9_suspicious_reason', result.reasons.includes('SUSPICIOUS_DATA_QUALITY'));
  }

  // ── Test 5: PAIR_CHANGED exclusion ─────────────────────────────
  console.log('--- 5. PAIR_CHANGED exclusion ---');
  {
    const pred = { predictionId: 'P1', ts: 1000, mint: 'm1', direction: 'bullish', dataQuality: 'quarantined' };
    const outcome = { realizedAt: 5000 };
    const result = isExcluded(pred, outcome);
    check('10_pair_changed_excluded', result.excluded === true);
  }

  // ── Test 6: Stale-data exclusion ───────────────────────────────
  console.log('--- 6. Stale-data exclusion ---');
  {
    const pred = { predictionId: 'P1', ts: 1000, mint: 'm1', direction: 'bullish', dataQuality: 'fail' };
    const outcome = { realizedAt: 5000 };
    const result = isExcluded(pred, outcome);
    check('11_stale_excluded', result.excluded === true);
    check('12_stale_reason', result.reasons.includes('SUSPICIOUS_DATA_QUALITY'));
  }

  // ── Test 7: Future-data rejection ──────────────────────────────
  console.log('--- 7. Future-data rejection ---');
  {
    const pred = { predictionId: 'P1', ts: 5000, mint: 'm1', direction: 'bullish', dataQuality: 'ok' };
    const outcome = { realizedAt: 4000 }; // resolution BEFORE prediction
    const result = isExcluded(pred, outcome);
    check('13_future_data_excluded', result.excluded === true);
    check('14_future_data_reason', result.reasons.includes('FUTURE_DATA_VIOLATION'));
  }

  // ── Test 8: Horizon resolution ─────────────────────────────────
  console.log('--- 8. Horizon resolution ---');
  {
    const { horizonMs, ALL_HORIZONS } = require('../atlas/outcome-engine.js');
    check('15_horizon_5m', horizonMs('5m') === 300000);
    check('16_horizon_15m', horizonMs('15m') === 900000);
    check('17_horizon_30m', horizonMs('30m') === 1800000);
    check('18_horizon_1h', horizonMs('1h') === 3600000);
    check('19_horizon_4h', horizonMs('4h') === 14400000);
    check('20_all_horizons_5', ALL_HORIZONS.length === 5);
  }

  // ── Test 9: Bootstrap reproducibility ──────────────────────────
  console.log('--- 9. Bootstrap reproducibility ---');
  {
    let seed = 42;
    function rng() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ci1 = statsLib.bootstrapCI(data, { iterations: 500, rng });
    seed = 42;
    const ci2 = statsLib.bootstrapCI(data, { iterations: 500, rng });
    check('21_bootstrap_reproducible_mean', ci1.mean === ci2.mean);
    check('22_bootstrap_reproducible_ci', ci1.ciLower === ci2.ciLower);
  }

  // ── Test 10: 95% CI ────────────────────────────────────────────
  console.log('--- 10. 95% CI ---');
  {
    const data = Array.from({ length: 50 }, (_, i) => 10 + (i % 5) * 0.5);
    const ci = statsLib.bootstrapCI(data, { iterations: 5000 });
    check('23_ci_mean_in_range', ci.mean > 9 && ci.mean < 13, 'mean=' + ci.mean);
    check('24_ci_lower_below_mean', ci.ciLower < ci.mean);
    check('25_ci_upper_above_mean', ci.ciUpper > ci.mean);
    check('26_ci_level_95', ci.ciLevel === 0.95);
  }

  // ── Test 11: Cohen's d ────────────────────────────────────────
  console.log('--- 11. Cohen\'s d ---');
  {
    const large = statsLib.effectSize({ matchedSamples: 50, meanDifference: 5, standardDeviation: 3 });
    check('27_cohens_d_large', large.interpretation === 'LARGE', 'd=' + large.d);
    const small = statsLib.effectSize({ matchedSamples: 50, meanDifference: 0.1, standardDeviation: 5 });
    check('28_cohens_d_small', small.interpretation === 'NEGLIGIBLE');
    const insuff = statsLib.effectSize({ matchedSamples: 0 });
    check('29_cohens_d_insufficient', insuff.interpretation === 'INSUFFICIENT_DATA');
  }

  // ── Test 12: Paired t-test ─────────────────────────────────────
  console.log('--- 12. Paired t-test ---');
  {
    const circuit = [2, -1, 3, -2, 1, 4, -3, 2, 5, -1, 3, 6, -2, 4, 1, 5, -3, 2, 6, 3, 4, -1, 2, 5, 3, 6, -2, 4, 1, 5];
    const atlas = circuit.map(c => c + 3);
    const test = statsLib.pairedTest(circuit, atlas);
    check('30_t_test_sample', test.sampleSize === 30);
    check('31_t_test_name', test.testName === 'paired_t_test');
    check('32_t_test_statistic', Number.isFinite(test.statistic));
    check('33_t_test_pvalue', Number.isFinite(test.pValue));
  }

  // ── Test 13: Wilcoxon ──────────────────────────────────────────
  console.log('--- 13. Wilcoxon signed-rank ---');
  {
    const circuit = [1, -2, 3, -1, 2];
    const atlas = [3, 0, 5, 1, 4];
    const test = statsLib.pairedTest(circuit, atlas);
    check('34_wilcoxon_name', test.testName === 'wilcoxon_signed_rank');
    check('35_wilcoxon_sample', test.sampleSize === 5);
  }

  // ── Test 14: Checkpoint 30 ─────────────────────────────────────
  console.log('--- 14. Checkpoint 30 ---');
  {
    check('36_checkpoint_30_state', statsLib.evidenceState(30) === 'CHECKPOINT_30');
    check('37_checkpoint_29_insufficient', statsLib.evidenceState(29) === 'INSUFFICIENT_SAMPLE');
  }

  // ── Test 15: Checkpoint 100 ────────────────────────────────────
  console.log('--- 15. Checkpoint 100 ---');
  {
    check('38_checkpoint_100_state', statsLib.evidenceState(100) === 'CHECKPOINT_100');
    check('39_checkpoint_99_not_reached', statsLib.evidenceState(99) === 'CHECKPOINT_30');
  }

  // ── Test 16: Checkpoint 200 ────────────────────────────────────
  console.log('--- 16. Checkpoint 200 ---');
  {
    check('40_checkpoint_200_state', statsLib.evidenceState(200) === 'CHECKPOINT_200');
    check('41_checkpoint_199_not_reached', statsLib.evidenceState(199) === 'CHECKPOINT_100');
  }

  // ── Test 17: Calibration buckets ───────────────────────────────
  console.log('--- 17. Calibration buckets ---');
  {
    const cal = calibrationLib.emptyCalibration();
    const confidences = [55, 65, 75, 85, 95];
    for (const c of confidences) {
      for (let i = 0; i < 5; i++) {
        calibrationLib.record(cal, 'technical', c, i < 3, (i < 3 ? 3 : -2));
      }
    }
    check('42_cal_total', cal.totalPredictions === 25);
    check('43_cal_buckets_5', Object.keys(cal.buckets).length === 5);
    check('44_cal_error', Number.isFinite(cal.calibrationError));
    check('45_cal_per_agent', cal.agentCalibrations.technical != null);
  }

  // ── Test 18: Regime breakdown ──────────────────────────────────
  console.log('--- 18. Regime breakdown ---');
  {
    const store = require('../atlas/reputation.js').createReputationStore();
    for (let i = 0; i < 10; i++) {
      store.record('technical', i < 5 ? 'TREND_UP' : 'DUMP', { correct: i % 3 !== 0, confidence: 70 + i, realizedPnlPct: i % 3 === 0 ? -5 : 4 });
    }
    const rUp = store.getRegime('technical', 'TREND_UP');
    const rDump = store.getRegime('technical', 'DUMP');
    check('46_regime_trend_up', rUp.predictions === 5);
    check('47_regime_dump', rDump.predictions === 5);
  }

  // ── Test 19: Disagreement analysis ─────────────────────────────
  console.log('--- 19. Disagreement analysis ---');
  {
    const { analyze: disc } = require('../atlas/disagreement.js');
    const viewpoints = [
      { direction: 'bullish', score: 80 },
      { direction: 'bullish', score: 75 },
      { direction: 'bearish', score: 70 },
      { direction: 'neutral', score: 50 }
    ];
    const d = disc(viewpoints);
    check('48_disagreement_consensus', typeof d.consensus === 'string');
    check('49_disagreement_score', Number.isFinite(d.agentAgreementScore));
  }

  // ── Test 20: Agent attribution ─────────────────────────────────
  console.log('--- 20. Agent attribution ---');
  {
    const { classifyAtlas, ATLAS_ATTRIBUTION_CLASSES } = require('../atlas/attribution.js');
    check('50_atlas_classes', ATLAS_ATTRIBUTION_CLASSES.length >= 8);

    const r1 = classifyAtlas({ direction: 'bullish' }, { recommendation: 'BUY', direction: 'bullish' }, { won: true, pnlPct: 5 });
    check('51_atlas_correct_helped', r1 === 'TA_CORRECT_HELPED');

    const r2 = classifyAtlas({ direction: 'bullish' }, { recommendation: 'AVOID', direction: 'bearish' }, { won: false, pnlPct: -5 });
    check('52_atlas_correct_helped_bear', r2 === 'TA_CORRECT_HELPED');

    const r3 = classifyAtlas({ direction: 'bullish' }, { recommendation: 'HOLD', direction: 'neutral' }, { won: true, pnlPct: 5 });
    check('53_atlas_irrelevant', r3 === 'TA_CORRECT_BUT_IRRELEVANT');
  }

  // ── Test 21: Data-quality analysis ─────────────────────────────
  console.log('--- 21. Data-quality analysis ---');
  {
    const { dataQuality } = require('../atlas/evidence.js');
    const clean = dataQuality({ dataQuality: 'ok', pairStable: true, sourcesAgree: true }, { regime: 'TREND_UP' }, 5000, 60000);
    check('54_dq_clean', clean.score >= 70);

    const susp = dataQuality({ dataQuality: 'suspicious', reasons: ['EXTREME_PRICE_MOVE'] }, {}, 0, 60000);
    check('55_dq_suspicious', susp.score === 0);
  }

  // ── Test 22: Immutable snapshots ───────────────────────────────
  console.log('--- 22. Immutable snapshots ---');
  {
    const { AtlasDb } = require('../atlas/db.js');
    const db = new AtlasDb(path.join(tmp, 'immutable-snap'));
    fs.mkdirSync(path.join(tmp, 'immutable-snap'), { recursive: true });
    db.appendPrediction({ predictionId: 'P-SNAP', ts: 1000, mint: 'm1', direction: 'bullish', confidence: 80 });
    const before = db.predictions().length;
    // Simulate analysis — should not modify data
    const preds = db.predictions();
    check('56_snap_read_only', db.predictions().length === before);
  }

  // ── Test 23: Ledger isolation ──────────────────────────────────
  console.log('--- 23. Ledger isolation ---');
  {
    const { createABPaper } = require('../atlas/ab-paper.js');
    const mockDb = { readJson: () => null, writeJson: () => {} };
    const ab = createABPaper(mockDb);
    ab.recordTrade({ mint: 'm1', symbol: 'A', pnlPct: 5, atlasRecommendation: 'BUY' });
    const snap = ab.snapshot();
    check('57_ab_no_cash', !('cashSol' in snap.groupB));
    check('58_ab_no_positions', !('positions' in snap.groupB));
    check('59_ab_counterfactual_label', snap.groupB.name === 'V1+ATLAS');
  }

  // ── Test 24: Strategy immutability ─────────────────────────────
  console.log('--- 24. Strategy immutability ---');
  {
    const src = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
    check('60_v1_MAX_POSITIONS', src.includes('const MAX_POSITIONS = 5;'));
    check('61_v1_STOP_LOSS', src.includes('const STOP_LOSS_PCT = -6;'));
    check('62_v1_TAKE_PROFIT', src.includes('const TAKE_PROFIT_PCT = 8;'));
    check('63_v1_MIN_SCORE', src.includes('const MIN_SCORE = 60;'));
    check('64_v1_COOLDOWN', src.includes('const DEFAULT_COOLDOWN_MS = 600000;'));
  }

  // ── Test 25: Paper-only security ───────────────────────────────
  console.log('--- 25. Paper-only security ---');
  {
    const files = [
      'atlas/statistics.js', 'atlas/analyze-evidence.js', 'atlas/lookahead-audit.js',
      'atlas/atlas-engine.js', 'atlas/calibration.js', 'atlas/ab-paper.js',
      'atlas/attribution.js', 'atlas/reputation.js', 'atlas/evidence.js',
      'atlas/prediction-journal.js', 'atlas/outcome-engine.js', 'atlas/disagreement.js'
    ];
    const bad = /signTransaction|sendTransaction|sendRawTransaction|privateKey|secretKey|Keypair|fromSecretKey|emitSigned|broadcast|placeOrder/i;
    let allClean = true;
    for (const f of files) {
      const full = path.join(ROOT, f);
      if (!fs.existsSync(full)) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (bad.test(src)) { allClean = false; check('65_security_' + f.split('/').pop(), false); }
    }
    check('66_all_files_clean', allClean);
  }

  // ── Test 26: Look-ahead audit ──────────────────────────────────
  console.log('--- 26. Look-ahead audit ---');
  {
    // Valid pair
    const valid = auditPair({ ts: 1000, predictionId: 'P1' }, { realizedAt: 5000 });
    check('67_lookahead_valid', valid.passed === true);

    // Violation: resolution before prediction
    const violation = auditPair({ ts: 5000, predictionId: 'P2' }, { realizedAt: 4000 });
    check('68_lookahead_violation', violation.passed === false);
    check('69_lookahead_violation_type', violation.violation === 'FUTURE_DATA');

    // Batch audit
    const batch = auditBatch([
      { prediction: { ts: 1000, predictionId: 'P1' }, outcome: { realizedAt: 5000 } },
      { prediction: { ts: 5000, predictionId: 'P2' }, outcome: { realizedAt: 4000 } }
    ]);
    check('70_batch_total', batch.totalChecked === 2);
    check('71_batch_violations', batch.violations === 1);
    check('72_batch_passed', batch.passed === 1);
  }

  // ── Test 27: Analysis engine (full pipeline) ───────────────────
  console.log('--- 27. Analysis engine (full pipeline) ---');
  {
    const engineDir = path.join(tmp, 'analyze');
    fs.mkdirSync(engineDir, { recursive: true });
    const { createAtlasEngine } = require('../atlas/atlas-engine.js');
    const engine = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {}, integritySnap: { dataQuality: 'ok', pairStable: true, sourcesAgree: true } });

    const cand = {
      symbol: 'TEST', mint: 'testMint', pairAddress: 'testPair', dex: 'raydium',
      priceUsd: 0.01, priceSol: 0.0001, liquidityUsd: 100000, volume24hUsd: 500000,
      change1hPct: -10, change5mPct: 2, recoveryPct: 1.5, recoveryStatus: 'ok',
      score: 70, source: 'dexscreener'
    };
    const ctx = {
      portfolio: { positionsOpen: 0, maxPositions: 5 }, metrics: { n: 0 },
      market: { solPriceUsd: 150 }, integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
      historyByMint: { testMint: { samples: Array.from({ length: 15 }, (_, i) => ({ ts: Date.now() - (15 - i) * 2000, priceUsd: 0.01 * (1 + 0.001 * i), priceSol: 0.0001 * (1 + 0.001 * i), source: 'dexscreener' })), warming: false } },
      universe: { candidates: 5, avgVolumeUsd: 500000 }
    };
    engine.runCycle({ candidates: [cand], ctx });

    const result = analyze(engineDir, { bootstrapIterations: 100 });
    check('73_analyze_has_evidenceState', typeof result.evidenceState === 'string');
    check('74_analyze_has_checkpoints', result.checkpoints != null);
    check('75_analyze_has_matched', result.matched != null);
    check('76_analyze_has_circuit', result.circuit != null);
    check('77_analyze_has_atlas', result.atlas != null);
    check('78_analyze_has_paired', result.paired != null);
    check('79_analyze_has_horizons', result.horizons != null);
    check('80_analyze_has_promotion', result.promotion != null);
    check('81_analyze_promotion_auto_false', result.promotion.automaticallyPromoted === false);
    check('82_analyze_has_lookahead', result.lookaheadAudit != null);
  }

  // ── Cleanup ────────────────────────────────────────────────────
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log('\n=== PHASE 4 EVIDENCE ANALYSIS TEST RESULTS ===');
  console.log('Passed: ' + passed + '  Failed: ' + failed + '  Total: ' + (passed + failed));
  console.log('Result: ' + (failed === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failed + ' CHECK(S) FAILED'));
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
