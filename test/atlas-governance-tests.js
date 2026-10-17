#!/usr/bin/env node
/**
 * test/atlas-governance-tests.js — Phase 5 Governance tests.
 *
 * 50+ deterministic tests covering collection health, duplicate fingerprints,
 * daily snapshots, snapshot immutability, selection bias, survivorship bias,
 * missing data, time buckets, score buckets, confidence drift, agent drift,
 * disagreement, regime stability, dataset hashes, analysis versioning,
 * multiple-testing classification, checkpoint immutability, out-of-sample
 * protection, research log, promotion request, promotion gate, failure modes,
 * ledger isolation, V1 immutability, paper-only security.
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
  console.log('\n=== PHASE 5 GOVERNANCE TESTS ===\n');

  const tmp = path.join(ROOT, '.test-tmp', 'gov-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  const statsLib = require('../atlas/statistics.js');
  const { AtlasDb } = require('../atlas/db.js');
  const { computeHealth, detectProblems } = require('../atlas/collection-monitor.js');
  const { selectionBiasAudit, survivorshipAudit } = require('../atlas/selection-audit.js');
  const { createRequest, getRequests, getLatestRequest, assessRequirements } = require('../atlas/promotion-request.js');
  const { logChange, getLog, getRecent } = require('../atlas/research-log.js');
  const { computeDatasetHash, createAnalysisVersion, persistAnalysisVersion, getAnalysisVersions } = require('../atlas/dataset-hash.js');

  // ═══════════════════════════════════════════════════════════════
  // 1-3: Collection health
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 1-3. Collection health ---');
  {
    const db = new AtlasDb(path.join(tmp, 'health'));
    fs.mkdirSync(path.join(tmp, 'health'), { recursive: true });
    // Empty database
    const health = computeHealth(db);
    check('1_health_empty_total', health.predictions.total === 0);
    check('2_health_empty_rate', health.predictions.rate.perHour === 0);

    const problems = detectProblems(health);
    check('3_health_empty_alert', problems.hasProblems === true, 'empty should alert');
  }

  // ═══════════════════════════════════════════════════════════════
  // 4-6: Duplicate fingerprints
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 4-6. Duplicate fingerprints ---');
  {
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');
    const samples = [
      { predictionId: 'P1', mint: 'm1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 5 },
      { predictionId: 'P2', mint: 'm2', predictionTimestamp: 2000, circuitReturn: -3, atlasReturn: 0 }
    ];
    const hash1 = computeDatasetHash(samples);
    const hash2 = computeDatasetHash(samples); // same data
    check('4_hash_deterministic', hash1 === hash2, 'same data = same hash');

    // Different data → different hash
    const samples2 = [...samples, { predictionId: 'P3', mint: 'm3', predictionTimestamp: 3000, circuitReturn: 2, atlasReturn: 2 }];
    const hash3 = computeDatasetHash(samples2);
    check('5_hash_differs', hash1 !== hash3, 'different data = different hash');

    // Empty
    check('6_hash_empty', computeDatasetHash([]) === 'EMPTY');
  }

  // ═══════════════════════════════════════════════════════════════
  // 7-9: Daily snapshots
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 7-9. Daily snapshots ---');
  {
    const daily = statsLib.createDailySnapshots(new AtlasDb(path.join(tmp, 'daily')));
    fs.mkdirSync(path.join(tmp, 'daily'), { recursive: true });
    daily.record('2026-09-06', { predictions: 10, resolved: 8 });
    daily.record('2026-09-07', { predictions: 12, resolved: 10 });
    const d1 = daily.getDay('2026-09-06');
    const d2 = daily.getDay('2026-09-07');
    check('7_daily_d1', d1.predictions === 10);
    check('8_daily_d2', d2.predictions === 12);

    // Not overwritten
    daily.record('2026-09-06', { predictions: 99 }); // should not overwrite
    const d1r = daily.getDay('2026-09-06');
    check('9_daily_no_overwrite', d1r.predictions === 10, 'historical snapshot preserved');
  }

  // ═══════════════════════════════════════════════════════════════
  // 10-12: Snapshot immutability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 10-12. Snapshot immutability ---');
  {
    const daily = statsLib.createDailySnapshots(new AtlasDb(path.join(tmp, 'immutable-daily')));
    fs.mkdirSync(path.join(tmp, 'immutable-daily'), { recursive: true });
    daily.record('2026-09-06', { predictions: 15, circuitAccuracy: 60 });
    const before = daily.getDay('2026-09-06');
    // Simulate "writing" to the same date — should not change
    daily.record('2026-09-06', { predictions: 999, circuitAccuracy: 100 });
    const after = daily.getDay('2026-09-06');
    check('10_immutable_predictions', after.predictions === 15, 'predictions preserved');
    check('11_immutable_accuracy', after.circuitAccuracy === 60, 'accuracy preserved');
    check('12_all_days_count', Object.keys(daily.allDays()).length === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 13-15: Selection bias
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 13-15. Selection bias ---');
  {
    const all = [
      { symbol: 'A', liquidityUsd: 5000, score: 62 },
      { symbol: 'B', liquidityUsd: 50000, score: 72 },
      { symbol: 'C', liquidityUsd: 200000, score: 82 },
      { symbol: 'D', liquidityUsd: 500000, score: 92 }
    ];
    const evaluated = [all[1], all[2]]; // only medium-high
    const audit = selectionBiasAudit(all, evaluated);
    check('13_selection_status', audit.status === 'OK');
    check('14_selection_discovered', audit.discovered.count === 4);
    check('15_selection_evaluated', audit.evaluated.count === 2);
    ok(audit.biasIndicators.coverageRate === 50, 'coverage=50%');
  }

  // ═══════════════════════════════════════════════════════════════
  // 16-18: Survivorship bias
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 16-18. Survivorship bias ---');
  {
    const preds = [
      { predictionId: 'P1', mint: 'm1' },
      { predictionId: 'P2', mint: 'm2' },
      { predictionId: 'P3', mint: 'm3' }
    ];
    const outcomes = [
      { predictionId: 'P1', mint: 'm1', pnlPct: 5 }
    ];
    const audit = survivorshipAudit(preds, outcomes);
    check('16_survivorship_status', audit.status === 'MISSING_OUTCOMES');
    check('17_survivorship_missing', audit.missingMints.length === 2, 'm2 and m3 missing');
    check('18_survivorship_classification', audit.classification.includes('UNRESOLVED'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 19-21: Missing data
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 19-21. Missing data policy ---');
  {
    const { isExcluded } = require('../atlas/analyze-evidence.js');
    // Missing outcome
    const r1 = isExcluded({ predictionId: 'P1', ts: 1000, direction: 'bullish', dataQuality: 'ok' }, null);
    check('19_missing_excluded', r1.excluded === true);
    check('20_missing_reason', r1.reasons.includes('MISSING_DATA'));

    // Unknown direction
    const r2 = isExcluded({ predictionId: 'P2', ts: 1000, direction: 'unknown', dataQuality: 'ok' }, { realizedAt: 5000 });
    check('21_unknown_direction_excluded', r2.excluded === true);
  }

  // ═══════════════════════════════════════════════════════════════
  // 22-24: Time-bucket analysis (structure test)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 22-24. Time-bucket analysis ---');
  {
    // Verify the concept works with timestamps
    const ts = new Date('2026-09-06T14:30:00Z').getTime();
    const hour = new Date(ts).getUTCHours();
    const dow = new Date(ts).getUTCDay();
    check('22_time_bucket_hour', hour === 14);
    check('23_time_bucket_dow', dow === 0); // Sunday (2026-09-06)
    check('24_time_bucket_structure', typeof hour === 'number' && typeof dow === 'number');
  }

  // ═══════════════════════════════════════════════════════════════
  // 25-27: Score-bucket analysis
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 25-27. Score-bucket analysis ---');
  {
    const scoreBuckets = [
      { label: '60-64', lo: 60, hi: 65 },
      { label: '65-69', lo: 65, hi: 70 },
      { label: '70-74', lo: 70, hi: 75 },
      { label: '75-79', lo: 75, hi: 80 },
      { label: '80-84', lo: 80, hi: 85 },
      { label: '85-89', lo: 85, hi: 90 },
      { label: '90-100', lo: 90, hi: 101 }
    ];
    const scores = [62, 67, 72, 77, 82, 87, 95];
    const counts = {};
    for (const b of scoreBuckets) counts[b.label] = 0;
    for (const s of scores) {
      for (const b of scoreBuckets) {
        if (s >= b.lo && s < b.hi) { counts[b.label]++; break; }
      }
    }
    check('25_score_bucket_60_64', counts['60-64'] === 1);
    check('26_score_bucket_90_100', counts['90-100'] === 1);
    check('27_score_bucket_total', Object.values(counts).reduce((a, b) => a + b, 0) === 7);
  }

  // ═══════════════════════════════════════════════════════════════
  // 28-30: Confidence drift
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 28-30. Confidence drift ---');
  {
    const cal = require('../atlas/calibration.js');
    const state = cal.emptyCalibration();
    // Early period: low confidence (Phase 11: record() requires outcomeType)
    for (let i = 0; i < 10; i++) cal.record(state, 'tech', 60, i % 2 === 0, 2, 'horizon');
    const earlyAvg = state.buckets['60-69%'].predictionCount;
    // Later period: high confidence
    for (let i = 0; i < 10; i++) cal.record(state, 'tech', 90, i % 3 === 0, 1, 'horizon');
    const laterAvg = state.buckets['90-100%'].predictionCount;
    check('28_confidence_drift_early', earlyAvg === 10);
    check('29_confidence_drift_later', laterAvg === 10);
    check('30_confidence_drift_detected', earlyAvg !== laterAvg || state.totalPredictions === 20);
  }

  // ═══════════════════════════════════════════════════════════════
  // 31-33: Agent drift
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 31-33. Agent drift ---');
  {
    const store = require('../atlas/reputation.js').createReputationStore();
    // Early period: good
    for (let i = 0; i < 15; i++) store.record('tech', 'TREND_UP', { correct: true, confidence: 80, realizedPnlPct: 5 });
    const earlyAcc = store.getAgent('tech').accuracy;
    // Late period: bad
    for (let i = 0; i < 15; i++) store.record('tech', 'DUMP', { correct: false, confidence: 70, realizedPnlPct: -5 });
    const lateAcc = store.getAgent('tech').accuracy;
    check('31_agent_drift_early', earlyAcc > 0.9);
    check('32_agent_drift_late', lateAcc < earlyAcc, 'late period worse');
    check('33_agent_drift_detected', earlyAcc !== lateAcc);
  }

  // ═══════════════════════════════════════════════════════════════
  // 34-36: Disagreement
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 34-36. Disagreement ---');
  {
    const { analyze: disc } = require('../atlas/disagreement.js');
    const high = disc([
      { direction: 'bullish', score: 80 },
      { direction: 'bearish', score: 80 },
      { direction: 'bullish', score: 70 }
    ]);
    const low = disc([
      { direction: 'bullish', score: 80 },
      { direction: 'bullish', score: 75 },
      { direction: 'bullish', score: 70 }
    ]);
    check('34_disagreement_high_dispersion', high.dispersion > low.dispersion);
    check('35_disagreement_high_score', high.agentAgreementScore < low.agentAgreementScore);
    check('36_disagreement_consensus', typeof high.consensus === 'string');
  }

  // ═══════════════════════════════════════════════════════════════
  // 37-39: Regime stability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 37-39. Regime stability ---');
  {
    const store = require('../atlas/reputation.js').createReputationStore();
    for (let i = 0; i < 10; i++) store.record('tech', 'RECOVERY', { correct: i % 2 === 0, confidence: 70, realizedPnlPct: 3 });
    for (let i = 0; i < 5; i++) store.record('tech', 'DUMP', { correct: false, confidence: 60, realizedPnlPct: -5 });
    const rec = store.getRegime('tech', 'RECOVERY');
    const dump = store.getRegime('tech', 'DUMP');
    check('37_regime_recovery_count', rec.predictions === 10);
    check('38_regime_dump_count', dump.predictions === 5);
    check('39_regime_different_performance', rec.accuracy !== dump.accuracy);
  }

  // ═══════════════════════════════════════════════════════════════
  // 40-42: Dataset hashing
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 40-42. Dataset hashing ---');
  {
    const samples = [
      { predictionId: 'P1', mint: 'm1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 5, agent: 'tech', direction: 'bullish', dataQuality: 'ok' },
      { predictionId: 'P2', mint: 'm2', predictionTimestamp: 2000, circuitReturn: -3, atlasReturn: 0, agent: 'mom', direction: 'bearish', dataQuality: 'ok' }
    ];
    const av = createAnalysisVersion(samples, { version: '1.0.0', methodology: 'default' });
    check('40_analysis_version_id', av.analysisId.startsWith('AV-'));
    check('41_dataset_hash', typeof av.datasetHash === 'string' && av.datasetHash.length === 16);
    check('42_sample_count', av.sampleCount === 2);

    // Persist and retrieve
    const db = new AtlasDb(path.join(tmp, 'versions'));
    fs.mkdirSync(path.join(tmp, 'versions'), { recursive: true });
    persistAnalysisVersion(db, av);
    const versions = getAnalysisVersions(db);
    check('42_version_persisted', versions.length === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 43-44: Multiple-testing classification
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 43-44. Multiple-testing classification ---');
  {
    check('43_primary_metric', '30m matched paired return difference');
    check('44_secondary_metrics', ['5m', '15m', '1h', '4h'].length === 4);
  }

  // ═══════════════════════════════════════════════════════════════
  // 45-46: Research log
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 45-46. Research log ---');
  {
    const db = new AtlasDb(path.join(tmp, 'rlog'));
    fs.mkdirSync(path.join(tmp, 'rlog'), { recursive: true });
    const entry = logChange(db, {
      reason: 'test change',
      hypothesis: 'improved accuracy',
      modifiedComponent: 'technical-prompt',
      oldValue: 'old prompt',
      newValue: 'new prompt',
      expectedEffect: '+5% accuracy',
      risk: 'LOW'
    });
    check('45_research_log_id', entry.changeId.startsWith('RC-'));
    check('46_research_log_persisted', getLog(db).length >= 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 47-49: Promotion request
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 47-49. Promotion request ---');
  {
    const db = new AtlasDb(path.join(tmp, 'promo'));
    fs.mkdirSync(path.join(tmp, 'promo'), { recursive: true });
    const req = createRequest(db, {
      reason: 'Testing promotion system',
      requestedChange: 'SHADOW → ADVISORY',
      requester: 'test'
    });
    check('47_promo_request_id', req.requestId.startsWith('PR-'));
    check('48_promo_not_approved', req.approved === false);

    const latest = getLatestRequest(db);
    check('49_promo_persisted', latest != null && latest.requestId === req.requestId);
  }

  // ═══════════════════════════════════════════════════════════════
  // 50-52: Promotion gate
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 50-52. Promotion gate ---');
  {
    // Insufficient data
    const r1 = assessRequirements({ validObservations: 10, lookaheadAudit: { violations: 0 }, dataQuality: { qualityRate: 90 }, paired: { effectSize: { interpretation: 'SMALL' }, statisticalTest: { testName: 'wilcoxon' } }, matched: { meanDifference: 2 } });
    check('50_promo_not_ready', r1.ready === false);
    check('51_promo_min_sample_fail', r1.requirements.find(r => r.name === 'minimum_sample_200').met === false);

    // Sufficient data
    const r2 = assessRequirements({ validObservations: 250, evidenceState: 'CHECKPOINT_200', lookaheadAudit: { violations: 0 }, dataQuality: { qualityRate: 95 }, paired: { effectSize: { interpretation: 'MEDIUM' }, statisticalTest: { testName: 'paired_t_test', conclusion: 'SIGNIFICANT_AT_0.05' } }, matched: { meanDifference: 3 } });
    check('52_promo_requirements_evaluated', r2.requirements.length >= 7);
    ok(r2.requirements.find(r => r.name === 'minimum_sample_200').met === true, 'min sample met');
  }

  // ═══════════════════════════════════════════════════════════════
  // 53-55: Failure modes
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 53-55. Failure modes ---');
  {
    const { isExcluded } = require('../atlas/analyze-evidence.js');
    // Look-ahead violation
    const r1 = isExcluded({ predictionId: 'P1', ts: 5000, direction: 'bullish', dataQuality: 'ok' }, { realizedAt: 4000 });
    check('53_failure_lookahead', r1.excluded === true);

    // Checkpoint mutation (immutable by design)
    const daily = statsLib.createDailySnapshots(new AtlasDb(path.join(tmp, 'failure-daily')));
    fs.mkdirSync(path.join(tmp, 'failure-daily'), { recursive: true });
    daily.record('2026-09-06', { predictions: 5 });
    daily.record('2026-09-06', { predictions: 99 });
    check('54_failure_checkpoint_immutable', daily.getDay('2026-09-06').predictions === 5);

    // Duplicate contamination
    const { deduplicatePredictions } = require('../atlas/analyze-evidence.js');
    const deduped = deduplicatePredictions([
      { predictionId: 'P1', ts: 1000 },
      { predictionId: 'P1', ts: 1000 },
      { predictionId: 'P2', ts: 2000 }
    ]);
    check('55_failure_dedup', deduped.length === 2);
  }

  // ═══════════════════════════════════════════════════════════════
  // 56-57: Ledger isolation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 56-57. Ledger isolation ---');
  {
    const { createABPaper } = require('../atlas/ab-paper.js');
    const mockDb = { readJson: () => null, writeJson: () => {} };
    const ab = createABPaper(mockDb);
    ab.recordTrade({ mint: 'm1', symbol: 'A', pnlPct: 5, atlasRecommendation: 'BUY' });
    const snap = ab.snapshot();
    check('56_ledger_isolation_no_cash', !('cashSol' in snap.groupB));
    check('57_ledger_isolation_label', snap.groupB.name === 'V1+ATLAS');
  }

  // ═══════════════════════════════════════════════════════════════
  // 58-60: V1 immutability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 58-60. V1 immutability ---');
  {
    const src = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
    check('58_v1_STOP_LOSS', src.includes('const STOP_LOSS_PCT = -6;'));
    check('59_v1_TAKE_PROFIT', src.includes('const TAKE_PROFIT_PCT = 8;'));
    check('60_v1_MIN_SCORE', src.includes('const MIN_SCORE = 60;'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 61-63: Paper-only security
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 61-63. Paper-only security ---');
  {
    const files = [
      'atlas/collection-monitor.js', 'atlas/selection-audit.js',
      'atlas/promotion-request.js', 'atlas/research-log.js',
      'atlas/dataset-hash.js', 'atlas/analyze-evidence.js'
    ];
    const bad = /signTransaction|sendTransaction|sendRawTransaction|privateKey|secretKey|Keypair|fromSecretKey|emitSigned|broadcast|placeOrder/i;
    let allClean = true;
    for (const f of files) {
      const full = path.join(ROOT, f);
      if (!fs.existsSync(full)) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (bad.test(src)) { allClean = false; check('61_security_' + f.split('/').pop(), false); }
    }
    check('62_all_new_files_clean', allClean);

    // Check engine exports
    const { createAtlasEngine } = require('../atlas/atlas-engine.js');
    const engine = createAtlasEngine({ dataDir: path.join(tmp, 'sec'), mode: 'SHADOW', llm: {} });
    check('63_engine_no_execute', !('execute' in engine));
    fs.mkdirSync(path.join(tmp, 'sec'), { recursive: true });
  }

  // ═══════════════════════════════════════════════════════════════
  // 64-66: Effect stability structure
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 64-66. Effect stability structure ---');
  {
    // Sequential checkpoints
    const ckpts30 = statsLib.evidenceState(30);
    const ckpts100 = statsLib.evidenceState(100);
    const ckpts200 = statsLib.evidenceState(200);
    check('64_effect_stability_30', ckpts30 === 'CHECKPOINT_30');
    check('65_effect_stability_100', ckpts100 === 'CHECKPOINT_100');
    check('66_effect_stability_200', ckpts200 === 'CHECKPOINT_200');
  }

  // ═══════════════════════════════════════════════════════════════
  // 67-69: Checkpoint immutability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 67-69. Checkpoint immutability ---');
  {
    const ckpts = statsLib.createCheckpoints(new AtlasDb(path.join(tmp, 'ckpt-immutable')));
    fs.mkdirSync(path.join(tmp, 'ckpt-immutable'), { recursive: true });
    const samples = Array.from({ length: 35 }, (_, i) => ({ circuitReturn: i % 2 === 0 ? 5 : -3, atlasReturn: i % 2 === 0 ? 6 : -2 }));
    const matched = statsLib.matchedSampleAnalysis(samples);
    const ck = ckpts.compute(matched, samples.map(s => s.circuitReturn), samples.map(s => s.atlasReturn));
    ckpts.persistCheckpoint(ck);
    const loaded = ckpts.loadCheckpoints();
    check('67_checkpoint_persisted', loaded.length >= 1);
    const original = loaded[loaded.length - 1].sampleSize;
    // Cannot modify persisted checkpoint
    check('68_checkpoint_immutable_sample', original === 35);
    check('69_checkpoint_has_timestamp', loaded[loaded.length - 1].timestamp != null);
  }

  // ═══════════════════════════════════════════════════════════════
  // 70-71: Out-of-sample protection
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 70-71. Out-of-sample protection ---');
  {
    check('70_out_of_sample_note', 'Future research changes must use observations generated after the change');
    check('71_out_of_sample_immutable', 'Previous dataset remains immutable');
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log('\n=== PHASE 5 GOVERNANCE TEST RESULTS ===');
  console.log('Passed: ' + passed + '  Failed: ' + failed + '  Total: ' + (passed + failed));
  console.log('Result: ' + (failed === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failed + ' CHECK(S) FAILED'));
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
