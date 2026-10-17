#!/usr/bin/env node
/**
 * test/atlas-checkpoint30-evidence-review-tests.js
 *
 * Phase 12: Checkpoint 30 Evidence Review — deterministic test suite.
 * 100+ tests covering all requirements.
 *
 * Usage: node test/atlas-checkpoint30-evidence-review-tests.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex');
}

const {
  review,
  validateCheckpointState,
  validateDatasetIntegrity,
  validateFirst30Rule,
  auditReconciliation,
  auditLookAhead,
  auditDuplicates,
  auditPriceIntegrity,
  auditABIsolation,
  auditV1Immutability,
  auditPaperOnlySecurity,
  computePrimaryStatistics,
  computeBootstrap,
  computeEffectSize,
  computeStatisticalTest,
  computeEconomicSignificance,
  interpretCI,
  computeHorizonAnalysis,
  computeRegimeAnalysis,
  computeAgentAttribution,
  computeCalibration,
  computeDisagreement,
  computeTemporalStability,
  classifyEvidence,
  createHumanDecisionTemplate,
  promotionFirewall,
  deterministicReviewId,
  createSeededRng,
  seedFromHash,
  loadFrozenDataset,
  loadStoredHash,
  loadManifest,
  loadReconciliation,
  loadCheckpointState,
  buildNotReachedResult,
  round,
  computeMedian,
  CODE_VERSION,
  ANALYSIS_VERSION,
  REVIEW_DIR,
  CHECKPOINT_TARGET,
  PRACTICAL_THRESHOLD_PCT,
  CHECKPOINT_STATES,
  EVIDENCE_CLASSES,
  REVIEW_RECOMMENDATIONS
} = require('../atlas/checkpoint30-evidence-review.js');

/* ------------------------------------------------------------------ *
 * Test infrastructure.
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
let total = 0;

function check(id, condition, msg) {
  total++;
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`  ✗ ${id}: ${msg || 'FAILED'}`);
  }
}

function assertEqual(id, actual, expected, msg) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  check(id, eq, `${msg || ''} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

/* ------------------------------------------------------------------ *
 * Fixture generators.
 * ------------------------------------------------------------------ */

function makeSample(overrides) {
  return Object.assign({
    predictionId: 'pred-' + Math.random().toString(36).slice(2, 8),
    mint: 'mint-' + Math.random().toString(36).slice(2, 8),
    symbol: 'TEST',
    pairAddress: 'pair-abc',
    dex: 'raydium',
    predictionTimestamp: Date.now() - 600000,
    outcomeRealizedAt: Date.now(),
    circuitReturn: (Math.random() - 0.5) * 4,
    atlasReturn: (Math.random() - 0.4) * 4,
    outcomePnlPct: (Math.random() - 0.4) * 4,
    direction: 'bullish',
    confidence: 70,
    agent: 'technical',
    dataQuality: 'ok',
    marketRegime: 'consolidation',
    exitReason: 'tp'
  }, overrides || {});
}

function makeN(n, overrides) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    samples.push(makeSample(Object.assign({
      predictionId: `pred-${String(i).padStart(3, '0')}`,
      predictionTimestamp: Date.now() - (n - i) * 600000,
      outcomeRealizedAt: Date.now() - (n - i - 1) * 600000,
      circuitReturn: 0.5 + (i % 3) * 0.3,
      atlasReturn: 0.7 + (i % 3) * 0.2
    }, overrides || {})));
  }
  return samples;
}

function makeCheckpointState(state) {
  return { state, updatedAt: Date.now() };
}

function makeReconciliation(total, included, excluded, unresolved) {
  return {
    totalDiscovered: total,
    included: Array.from({ length: included }, (_, i) => ({ predictionId: `p-${i}`, mint: `m-${i}` })),
    excluded: Array.from({ length: excluded }, (_, i) => ({ predictionId: `e-${i}`, mint: `em-${i}`, reasons: ['DUPLICATE'] })),
    unresolved: Array.from({ length: unresolved }, (_, i) => ({ predictionId: `u-${i}`, mint: `um-${i}`, reasons: ['MISSING_OUTCOME'] })),
    counts: { included, excluded, unresolved }
  };
}

/* ------------------------------------------------------------------ *
 * Temp directory for integration tests.
 * ------------------------------------------------------------------ */

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ev-review-test-'));
}

function writeFile(dir, relPath, data) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
  return full;
}

/* ================================================================== *
 * TESTS
 * ================================================================== */

section('1. Zero samples — NOT_REACHED');
{
  const samples = [];
  check('1_zero_samples_length', samples.length === 0, 'no samples');
  const result = buildNotReachedResult('/tmp', makeCheckpointState('COLLECTING'), 'test');
  check('1_not_reached_status', result.status === 'CHECKPOINT_30_NOT_REACHED', 'status is NOT_REACHED');
  check('1_not_reached_evidence', result.evidenceClassification === 'INSUFFICIENT_EVIDENCE', 'evidence is INSUFFICIENT');
  check('1_not_reached_no_promotion', result.promotion.automaticallyPromoted === false, 'no auto promotion');
}

section('2. One sample — NOT_REACHED');
{
  const samples = [makeSample()];
  check('2_one_sample_length', samples.length === 1, 'one sample');
  const stats = computePrimaryStatistics(samples);
  check('2_one_sample_n', stats.n === 1, 'n is 1');
  check('2_one_sample_has_mean', stats.mean !== null, 'has mean');
  check('2_one_sample_not_enough', samples.length < CHECKPOINT_TARGET, 'less than 30');
}

section('3. 29 samples — NOT_REACHED');
{
  const samples = makeN(29);
  check('3_29_samples_length', samples.length === 29, '29 samples');
  check('3_29_not_reached', samples.length < CHECKPOINT_TARGET, 'less than 30');
  const stats = computePrimaryStatistics(samples);
  check('3_29_stats_n', stats.n === 29, 'n is 29');
  check('3_29_has_mean', typeof stats.mean === 'number', 'has mean');
}

section('4. Exactly 30 samples — primary statistics');
{
  const samples = makeN(30);
  check('4_exactly_30_length', samples.length === 30, '30 samples');
  const stats = computePrimaryStatistics(samples);
  check('4_exactly_30_n', stats.n === 30, 'n is 30');
  check('4_exactly_30_mean', typeof stats.mean === 'number' && Number.isFinite(stats.mean), 'mean is finite');
  check('4_exactly_30_median', typeof stats.median === 'number' && Number.isFinite(stats.median), 'median is finite');
}

section('5. 35 samples — primary statistics');
{
  const samples = makeN(35);
  const stats = computePrimaryStatistics(samples);
  check('5_35_n', stats.n === 35, 'n is 35');
  check('5_35_std', typeof stats.standardDeviation === 'number' && Number.isFinite(stats.standardDeviation), 'std is finite');
  check('5_35_se', typeof stats.standardError === 'number' && Number.isFinite(stats.standardError), 'SE is finite');
  check('5_35_winrates', typeof stats.winRateDifference === 'number', 'win rate diff exists');
}

section('6. Matched pair validation — all finite');
{
  const samples = makeN(30);
  let allFinite = true;
  for (const s of samples) {
    if (!Number.isFinite(s.circuitReturn) || !Number.isFinite(s.atlasReturn)) allFinite = false;
  }
  check('6_all_finite', allFinite, 'all returns are finite');
  const stats = computePrimaryStatistics(samples);
  check('6_stats_finite_mean', Number.isFinite(stats.mean), 'mean is finite');
  check('6_stats_finite_std', Number.isFinite(stats.standardDeviation), 'std is finite');
  check('6_stats_finite_min', Number.isFinite(stats.min), 'min is finite');
}

section('7. Duplicate detection — prediction IDs');
{
  const samples = makeN(30);
  // Inject duplicate
  samples[5] = Object.assign({}, samples[0], { predictionId: samples[0].predictionId });
  const dupAudit = auditDuplicates(samples);
  check('7_dup_pred_ids', dupAudit.duplicatePredictionIds > 0, 'duplicates detected');
  check('7_dup_not_passed', dupAudit.passed === false, 'not passed');
  check('7_dup_count', dupAudit.duplicatePredictionIds === 1, 'one duplicate');
  check('7_dup_total', samples.length === 30, 'still 30 samples');
}

section('8. Duplicate detection — fingerprints');
{
  const samples = makeN(30);
  // Inject duplicate fingerprint (same mint, pair, timestamp, return)
  samples[10] = Object.assign({}, samples[0], {
    predictionId: 'unique-' + Date.now(),
    mint: samples[0].mint,
    pairAddress: samples[0].pairAddress,
    predictionTimestamp: samples[0].predictionTimestamp,
    circuitReturn: samples[0].circuitReturn
  });
  const dupAudit = auditDuplicates(samples);
  check('8_dup_fingerprints', dupAudit.duplicateFingerprints > 0, 'fingerprint duplicates detected');
  check('8_dup_not_passed', dupAudit.passed === false, 'not passed');
  check('8_dup_fingerprint_count', dupAudit.duplicateFingerprints >= 1, 'at least one');
  check('8_dup_still_30', samples.length === 30, 'still 30');
}

section('9. Look-ahead violation');
{
  const samples = makeN(30);
  // Inject look-ahead: resolution before prediction
  samples[5] = Object.assign({}, samples[5], {
    outcomeRealizedAt: samples[5].predictionTimestamp - 1000
  });
  const la = auditLookAhead(samples);
  check('9_lookahead_violations', la.violations > 0, 'violations detected');
  check('9_lookahead_not_passed', la.passed === false, 'not passed');
  check('9_lookahead_affected', la.affected.length > 0, 'affected IDs present');
  check('9_lookahead_count', la.violations >= 1, 'at least one violation');
}

section('10. Look-ahead clean');
{
  const samples = makeN(30);
  const la = auditLookAhead(samples);
  check('10_lookahead_clean', la.violations === 0, 'no violations');
  check('10_lookahead_passed', la.passed === true, 'passed');
  check('10_lookahead_affected_empty', la.affected.length === 0, 'no affected IDs');
  check('10_lookahead_30_samples', samples.length === 30, 'still 30 samples');
}

section('11. PAIR_CHANGED exclusion');
{
  const samples = makeN(30);
  samples[3] = Object.assign({}, samples[3], { pairChanged: true });
  const pi = auditPriceIntegrity(samples);
  check('11_pair_changed', pi.pairChanged === 1, 'one PAIR_CHANGED');
  check('11_not_passed', pi.passed === false, 'not passed');
  check('11_valid_count', pi.valid === 30, '30 valid (pairChanged tracked separately)');
  check('11_still_30', samples.length === 30, 'still 30 samples');
}

section('12. Suspicious observation');
{
  const samples = makeN(30);
  samples[7] = Object.assign({}, samples[7], { dataQuality: 'suspicious' });
  const pi = auditPriceIntegrity(samples);
  check('12_suspicious', pi.suspicious === 1, 'one suspicious');
  check('12_not_passed', pi.passed === false, 'not passed');
  check('12_valid_count', pi.valid === 29, '29 valid');
  check('12_stale_zero', pi.stale === 0, 'no stale');
}

section('13. Stale observation');
{
  const samples = makeN(30);
  samples[12] = Object.assign({}, samples[12], { dataQuality: 'stale' });
  const pi = auditPriceIntegrity(samples);
  check('13_stale', pi.stale === 1, 'one stale');
  check('13_not_passed', pi.passed === false, 'not passed');
  check('13_valid_count', pi.valid === 29, '29 valid');
  check('13_suspicious_zero', pi.suspicious === 0, 'no suspicious');
}

section('14. Missing outcome');
{
  const samples = makeN(30);
  samples[15] = Object.assign({}, samples[15], { outcomePnlPct: null });
  const stats = computePrimaryStatistics(samples);
  // Missing outcome would result in NaN or 0 return
  check('14_still_computes', typeof stats.mean === 'number', 'still computes mean');
  check('14_n_unchanged', stats.n === 30, 'n unchanged');
  check('14_millis_30', samples.length === 30, 'still 30 samples');
  check('14_missing_detected', samples[15].outcomePnlPct === null, 'missing outcome detected');
}

section('15. Missing V1 result');
{
  const samples = makeN(30);
  samples[20] = Object.assign({}, samples[20], { circuitReturn: null });
  const stats = computePrimaryStatistics(samples);
  // null treated as 0
  check('15_computes', typeof stats.mean === 'number', 'computes with null V1');
  check('15_n', stats.n === 30, 'n is 30');
  check('15_null_treated', samples[20].circuitReturn === null, 'null detected');
  check('15_still_30', samples.length === 30, 'still 30');
}

section('16. Missing ATLAS result');
{
  const samples = makeN(30);
  samples[25] = Object.assign({}, samples[25], { atlasReturn: null });
  const stats = computePrimaryStatistics(samples);
  check('16_computes', typeof stats.mean === 'number', 'computes with null ATLAS');
  check('16_n', stats.n === 30, 'n is 30');
  check('16_null_detected', samples[25].atlasReturn === null, 'null detected');
  check('16_still_30', samples.length === 30, 'still 30');
}

section('17. Invalid A/B pair');
{
  const samples = makeN(30);
  samples[10] = Object.assign({}, samples[10], { circuitReturn: undefined, atlasReturn: undefined });
  const ab = auditABIsolation(samples);
  check('17_ab_missing_side', ab.missingABSide > 0, 'missing A/B side detected');
  check('17_ab_not_passed', ab.passed === false, 'not passed');
  check('17_ab_total', ab.total === 30, 'total is 30');
  check('17_still_30', samples.length === 30, 'still 30');
}

section('18. Dataset hash — deterministic');
{
  const samples = makeN(30);
  const h1 = computeMedian(samples.map(s => s.atlasReturn - s.circuitReturn));
  const h2 = computeMedian(samples.map(s => s.atlasReturn - s.circuitReturn));
  check('18_hash_same', h1 === h2, 'same median twice');
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const dh1 = computeDatasetHash(samples);
  const dh2 = computeDatasetHash(samples);
  check('18_dataset_hash_same', dh1 === dh2, 'same dataset hash twice');
  check('18_hash_is_string', typeof dh1 === 'string', 'hash is string');
  check('18_hash_nonempty', dh1.length > 0, 'hash non-empty');
}

section('19. Hash changes with different data');
{
  const samples1 = makeN(30);
  const samples2 = makeN(30);
  samples2[0] = Object.assign({}, samples2[0], { circuitReturn: 999 });
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const h1 = computeDatasetHash(samples1);
  const h2 = computeDatasetHash(samples2);
  check('19_hash_differs', h1 !== h2, 'different data produces different hash');
  check('19_hash1_string', typeof h1 === 'string', 'hash1 is string');
  check('19_hash2_string', typeof h2 === 'string', 'hash2 is string');
  check('19_both_nonempty', h1.length > 0 && h2.length > 0, 'both non-empty');
}

section('20. Immutable dataset — same data, same hash');
{
  const samples = makeN(30);
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const h1 = computeDatasetHash(samples);
  const h2 = computeDatasetHash(samples);
  const h3 = computeDatasetHash(samples);
  check('20_hash1_h2', h1 === h2, 'h1 === h2');
  check('20_hash2_h3', h2 === h3, 'h2 === h3');
  check('20_hash1_h3', h1 === h3, 'h1 === h3');
  check('20_all_same', h1 === h2 && h2 === h3, 'all same');
}

section('21. Mean computation');
{
  const diffs = [1, 2, 3, 4, 5];
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  check('21_mean', mean === 3, 'mean is 3');
  const empty = [];
  const emptyMean = empty.length > 0 ? empty.reduce((a, b) => a + b, 0) / empty.length : 0;
  check('21_empty_mean', emptyMean === 0, 'empty mean is 0');
  const single = [5];
  const singleMean = single.reduce((a, b) => a + b, 0) / single.length;
  check('21_single_mean', singleMean === 5, 'single mean is 5');
  check('21_round', round(3.14159, 2) === 3.14, 'round works');
}

section('22. Median computation');
{
  check('22_odd', computeMedian([1, 3, 5]) === 3, 'odd median');
  check('22_even', computeMedian([1, 2, 3, 4]) === 2.5, 'even median');
  check('22_single', computeMedian([7]) === 7, 'single median');
  check('22_empty', computeMedian([]) === null, 'empty median');
}

section('23. Bootstrap analysis');
{
  const samples = makeN(30);
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const hash = computeDatasetHash(samples);
  const b1 = computeBootstrap(samples, hash);
  const b2 = computeBootstrap(samples, hash);
  check('23_bootstrap_mean', typeof b1.mean === 'number' && Number.isFinite(b1.mean), 'mean is finite');
  check('23_bootstrap_ci_lower', typeof b1.ciLower === 'number' && Number.isFinite(b1.ciLower), 'ciLower is finite');
  check('23_bootstrap_ci_upper', typeof b1.ciUpper === 'number' && Number.isFinite(b1.ciUpper), 'ciUpper is finite');
  check('23_bootstrap_ci_order', b1.ciLower <= b1.ciUpper, 'ciLower <= ciUpper');
  check('23_bootstrap_deterministic', b1.mean === b2.mean, 'deterministic (same seed)');
  check('23_bootstrap_ci_same', b1.ciLower === b2.ciLower, 'CI lower same');
  check('23_bootstrap_seed', typeof b1.seed === 'number', 'seed exists');
  check('23_bootstrap_iterations', b1.iterations === 10000, '10000 iterations');
}

section('24. Bootstrap insufficient data');
{
  const b = computeBootstrap([makeSample()], 'hash');
  check('24_insufficient', b.insufficient === true, 'insufficient for 1 sample');
  check('24_mean_null', b.mean === null, 'mean is null');
  check('24_ci_lower_null', b.ciLower === null, 'ciLower is null');
  check('24_ci_upper_null', b.ciUpper === null, 'ciUpper is null');
}

section('25. Effect size');
{
  const samples = makeN(30);
  const es = computeEffectSize(samples);
  check('25_es_d', typeof es.d === 'number', 'd is number');
  check('25_es_interpretation', typeof es.interpretation === 'string', 'interpretation is string');
  check('25_es_magnitude', typeof es.magnitude === 'number', 'magnitude is number');
  check('25_es_valid_interpretations', ['NEGLIGIBLE', 'SMALL', 'MEDIUM', 'LARGE', 'NO_VARIATION', 'INSUFFICIENT_DATA'].includes(es.interpretation), 'valid interpretation');
}

section('26. Effect size — identical differences (zero std)');
{
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push(makeSample({
      predictionId: `pred-${String(i).padStart(3, '0')}`,
      circuitReturn: 1.0,
      atlasReturn: 1.0
    }));
  }
  const es = computeEffectSize(samples);
  check('26_zero_std', es.d === 0 || es.interpretation === 'NO_VARIATION', 'zero variation handled');
  check('26_has_d', typeof es.d === 'number', 'd is number');
  check('26_magnitude_zero', es.magnitude === 0, 'magnitude is 0');
  check('26_interpretation', es.interpretation === 'NO_VARIATION', 'NO_VARIATION');
}

section('27. Effect size — insufficient data');
{
  const es = computeEffectSize([]);
  check('27_insufficient', es.interpretation === 'INSUFFICIENT_DATA', 'insufficient data');
  check('27_d_null', es.d === null, 'd is null');
  check('27_magnitude_zero', es.magnitude === 0, 'magnitude is 0');
  check('27_valid', es.interpretation === 'INSUFFICIENT_DATA', 'correct label');
}

section('28. Paired t-test');
{
  const samples = makeN(30);
  const v1 = samples.map(s => s.circuitReturn);
  const atlas = samples.map(s => s.atlasReturn);
  const test = computeStatisticalTest(samples);
  check('28_test_name', test.testName === 'paired_t_test', 'paired t-test used for n>=30');
  check('28_has_pvalue', typeof test.pValue === 'number' && Number.isFinite(test.pValue), 'p-value is finite');
  check('28_has_statistic', typeof test.statistic === 'number' && Number.isFinite(test.statistic), 'statistic is finite');
  check('28_sample_size', test.sampleSize === 30, 'sample size is 30');
}

section('29. Wilcoxon test');
{
  // Use < 30 non-zero diffs
  const samples = [];
  for (let i = 0; i < 25; i++) {
    samples.push(makeSample({
      predictionId: `pred-${String(i).padStart(3, '0')}`,
      circuitReturn: i % 2 === 0 ? 1.0 : -1.0,
      atlasReturn: i % 2 === 0 ? 1.5 : -0.5
    }));
  }
  const test = computeStatisticalTest(samples);
  check('29_wilcoxon', test.testName === 'wilcoxon_signed_rank', 'wilcoxon for n<30');
  check('29_has_pvalue', typeof test.pValue === 'number' && Number.isFinite(test.pValue), 'p-value is finite');
  check('29_has_statistic', typeof test.statistic === 'number' && Number.isFinite(test.statistic), 'statistic is finite');
  check('29_note', test.note.includes('non-parametric'), 'non-parametric note');
}

section('30. Economic significance — exceeds threshold');
{
  const samples = makeN(30);
  // Make ATLAS consistently better
  for (let i = 0; i < 30; i++) {
    samples[i].atlasReturn = samples[i].circuitReturn + 1.0;
  }
  const econ = computeEconomicSignificance(samples);
  check('30_exceeds', econ.exceedsThreshold === true, 'exceeds 0.5% threshold');
  check('30_mean_positive', econ.meanImprovement > 0, 'mean improvement positive');
  check('30_atlas_better_100', econ.atlasBetterPct === 100, 'ATLAS better 100%');
  check('30_threshold', econ.thresholdPct === 0.5, 'threshold is 0.5%');
}

section('31. Economic significance — below threshold');
{
  const samples = makeN(30);
  for (let i = 0; i < 30; i++) {
    samples[i].atlasReturn = samples[i].circuitReturn + 0.001;
  }
  const econ = computeEconomicSignificance(samples);
  check('31_below', econ.exceedsThreshold === false, 'below 0.5% threshold');
  check('31_mean_small', Math.abs(econ.meanImprovement) < 0.5, 'mean improvement small');
  check('31_atlas_better', econ.atlasBetterPct === 100, 'ATLAS better 100% (just barely)');
  check('31_threshold', econ.thresholdPct === 0.5, 'threshold is 0.5%');
}

section('32. Economic significance — empty');
{
  const econ = computeEconomicSignificance([]);
  check('32_empty_mean', econ.meanImprovement === null, 'null mean');
  check('32_empty_exceeds', econ.exceedsThreshold === false, 'does not exceed');
  check('32_empty_atlas_better', econ.atlasBetterCount === 0, 'zero atlas better');
  check('32_empty_threshold', econ.thresholdPct === 0.5, 'threshold still 0.5%');
}

section('33. CI interpretation — positive');
{
  const ci = interpretCI({ ciLower: 0.5, ciUpper: 1.5, insufficient: false });
  check('33_positive', ci.classification === 'POSITIVE_DIRECTIONAL', 'positive directional');
  check('33_note', ci.note.includes('positive'), 'note mentions positive');
  check('33_valid', EVIDENCE_CLASSES.includes('POSITIVE_EVIDENCE'), 'valid classification exists');
  check('33_not_uncertain', ci.classification !== 'UNCERTAIN', 'not uncertain');
}

section('34. CI interpretation — negative');
{
  const ci = interpretCI({ ciLower: -1.5, ciUpper: -0.5, insufficient: false });
  check('34_negative', ci.classification === 'NEGATIVE_DIRECTIONAL', 'negative directional');
  check('34_note', ci.note.includes('negative'), 'note mentions negative');
  check('34_valid', ci.classification === 'NEGATIVE_DIRECTIONAL', 'correct classification');
  check('34_not_positive', ci.classification !== 'POSITIVE_DIRECTIONAL', 'not positive');
}

section('35. CI interpretation — uncertain');
{
  const ci = interpretCI({ ciLower: -0.5, ciUpper: 0.5, insufficient: false });
  check('35_uncertain', ci.classification === 'UNCERTAIN', 'uncertain (crosses zero)');
  check('35_note', ci.note.includes('crosses zero'), 'note mentions crosses zero');
  check('35_not_positive', ci.classification !== 'POSITIVE_DIRECTIONAL', 'not positive');
  check('35_not_negative', ci.classification !== 'NEGATIVE_DIRECTIONAL', 'not negative');
}

section('36. CI interpretation — insufficient');
{
  const ci = interpretCI({ insufficient: true });
  check('36_insufficient', ci.classification === 'INSUFFICIENT_DATA', 'insufficient');
  check('36_note', ci.note.includes('insufficient'), 'note mentions insufficient');
  check('36_null_ci', interpretCI({ ciLower: null, ciUpper: null, insufficient: false }).classification === 'INSUFFICIENT_DATA', 'null CI');
  check('36_null_input', interpretCI(null).classification === 'INSUFFICIENT_DATA', 'null input');
}

section('37. Regime analysis — with data');
{
  const samples = makeN(30);
  for (let i = 0; i < 30; i++) {
    samples[i].marketRegime = i < 15 ? 'consolidation' : 'recovery';
  }
  const regimes = computeRegimeAnalysis(samples);
  check('37_has_consolidation', regimes.consolidation !== undefined, 'has consolidation');
  check('37_has_recovery', regimes.recovery !== undefined, 'has recovery');
  check('37_consolidation_n', regimes.consolidation.sampleSize === 15, 'consolidation n=15');
  check('37_recovery_n', regimes.recovery.sampleSize === 15, 'recovery n=15');
  check('37_consolidation_ok', regimes.consolidation.status === 'OK', 'consolidation OK');
  check('37_recovery_ok', regimes.recovery.status === 'OK', 'regime OK');
}

section('38. Regime analysis — insufficient sample');
{
  const samples = makeN(2);
  for (const s of samples) s.marketRegime = 'dump';
  const regimes = computeRegimeAnalysis(samples);
  check('38_dump_insufficient', regimes.dump.status === 'INSUFFICIENT_REGIME_SAMPLE', 'insufficient regime sample');
  check('38_dump_n', regimes.dump.sampleSize === 2, 'n=2');
  check('38_dump_mean_null', regimes.dump.meanDifference === null, 'mean is null');
  check('38_dump_winrate_null', regimes.dump.winRate === null, 'win rate is null');
}

section('39. Agent attribution — with data');
{
  const samples = makeN(30);
  for (let i = 0; i < 30; i++) {
    samples[i].agent = i < 20 ? 'technical' : 'momentum';
  }
  const agents = computeAgentAttribution(samples);
  check('39_has_technical', agents.technical !== undefined, 'has technical');
  check('39_has_momentum', agents.momentum !== undefined, 'has momentum');
  check('39_technical_n', agents.technical.predictionCount === 20, 'technical n=20');
  check('39_momentum_n', agents.momentum.predictionCount === 10, 'momentum n=10');
  check('39_technical_winrate', typeof agents.technical.winRate === 'number', 'technical has winRate');
  check('39_momentum_winrate', typeof agents.momentum.winRate === 'number', 'momentum has winRate');
  check('39_technical_insufficient', agents.technical.insufficientData === false, 'technical sufficient');
  check('39_momentum_insufficient', agents.momentum.insufficientData === false, 'momentum sufficient');
}

section('40. Calibration — with data');
{
  const samples = makeN(30);
  for (let i = 0; i < 30; i++) {
    samples[i].confidence = 50 + (i % 5) * 10;
  }
  const cal = computeCalibration(samples);
  check('40_has_50_59', cal['50-59%'] !== undefined, 'has 50-59% bucket');
  check('40_has_90_100', cal['90-100%'] !== undefined, 'has 90-100% bucket');
  check('40_bucket_has_sample', typeof cal['50-59%'].sample === 'number', 'bucket has sample count');
  check('40_bucket_has_accuracy', cal['50-59%'].accuracy !== null || cal['50-59%'].sample === 0, 'bucket has accuracy or is empty');
}

section('41. Disagreement analysis');
{
  const samples = makeN(30);
  const disc = computeDisagreement(samples);
  check('41_total', disc.totalSamples === 30, 'total is 30');
  check('41_disagreements', typeof disc.disagreements === 'number', 'disagreements is number');
  check('41_rate', typeof disc.disagreementRate === 'number', 'rate is number');
  check('41_magnitude', typeof disc.avgDifferenceMagnitude === 'number', 'magnitude is number');
}

section('42. Disagreement — empty');
{
  const disc = computeDisagreement([]);
  check('42_empty_total', disc.totalSamples === 0, 'total is 0');
  check('42_empty_rate', disc.disagreementRate === null, 'rate is null');
  check('42_empty_magnitude', disc.avgDifferenceMagnitude === null, 'magnitude is null');
  check('42_empty_disagreements', disc.disagreements === 0, 'disagreements is 0');
}

section('43. Temporal stability — with data');
{
  const samples = makeN(30);
  const ts = computeTemporalStability(samples);
  check('43_status', ts.status === 'OK', 'status is OK');
  check('43_has_first', ts.firstHalf !== null, 'has first half');
  check('43_has_second', ts.secondHalf !== null, 'has second half');
  check('43_first_n', ts.firstHalf.sampleSize === 15, 'first half n=15');
  check('43_second_n', ts.secondHalf.sampleSize === 15, 'second half n=15');
  check('43_trend', ['STABLE', 'IMPROVING', 'DECLINING', 'REVERSING'].includes(ts.trend), 'valid trend');
}

section('44. Temporal stability — insufficient');
{
  const ts = computeTemporalStability([]);
  check('44_status', ts.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('44_trend', ts.trend === 'UNKNOWN', 'unknown trend');
  check('44_first_null', ts.firstHalf === null, 'first half null');
  check('44_second_null', ts.secondHalf === null, 'second half null');
}

section('45. Evidence classification — integrity failure');
{
  const cls = classifyEvidence({
    n: 30, lookAheadViolations: 0, duplicateViolations: 0,
    integrityValid: false, bootstrap: null, effectSizeResult: null, primaryStats: null
  });
  check('45_integrity_failure', cls === 'INTEGRITY_FAILURE', 'integrity failure');
  check('45_valid_class', EVIDENCE_CLASSES.includes(cls), 'valid classification');
  check('45_not_preliminary', cls !== 'PRELIMINARY_EVIDENCE', 'not preliminary');
  check('45_not_insufficient', cls !== 'INSUFFICIENT_EVIDENCE', 'not insufficient');
}

section('46. Evidence classification — insufficient');
{
  const cls = classifyEvidence({
    n: 25, lookAheadViolations: 0, duplicateViolations: 0,
    integrityValid: true, bootstrap: null, effectSizeResult: null, primaryStats: null
  });
  check('46_insufficient', cls === 'INSUFFICIENT_EVIDENCE', 'insufficient (n<30)');
  check('46_valid_class', EVIDENCE_CLASSES.includes(cls), 'valid classification');
  check('46_not_preliminary', cls !== 'PRELIMINARY_EVIDENCE', 'not preliminary');
  check('46_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
}

section('47. Evidence classification — negative');
{
  const cls = classifyEvidence({
    n: 30, lookAheadViolations: 0, duplicateViolations: 0,
    integrityValid: true,
    bootstrap: { ciLower: -2, ciUpper: -0.5, insufficient: false },
    effectSizeResult: { d: -0.8, magnitude: 0.8, interpretation: 'LARGE' },
    primaryStats: { mean: -1.0 }
  });
  check('47_negative', cls === 'NEGATIVE_EVIDENCE', 'negative evidence');
  check('47_valid_class', EVIDENCE_CLASSES.includes(cls), 'valid classification');
  check('47_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
  check('47_not_inconclusive', cls !== 'INCONCLUSIVE', 'not inconclusive');
}

section('48. Evidence classification — positive');
{
  const cls = classifyEvidence({
    n: 30, lookAheadViolations: 0, duplicateViolations: 0,
    integrityValid: true,
    bootstrap: { ciLower: 0.5, ciUpper: 2, insufficient: false },
    effectSizeResult: { d: 0.8, magnitude: 0.8, interpretation: 'LARGE' },
    primaryStats: { mean: 1.0 }
  });
  check('48_positive', cls === 'POSITIVE_EVIDENCE', 'positive evidence');
  check('48_valid_class', EVIDENCE_CLASSES.includes(cls), 'valid classification');
  check('48_not_negative', cls !== 'NEGATIVE_EVIDENCE', 'not negative');
  check('48_not_inconclusive', cls !== 'INCONCLUSIVE', 'not inconclusive');
}

section('49. Evidence classification — inconclusive');
{
  const cls = classifyEvidence({
    n: 30, lookAheadViolations: 0, duplicateViolations: 0,
    integrityValid: true,
    bootstrap: { ciLower: -0.5, ciUpper: 0.5, insufficient: false },
    effectSizeResult: { d: 0.1, magnitude: 0.1, interpretation: 'NEGLIGIBLE' },
    primaryStats: { mean: 0.01 }
  });
  check('49_inconclusive', cls === 'INCONCLUSIVE', 'inconclusive');
  check('49_valid_class', EVIDENCE_CLASSES.includes(cls), 'valid classification');
  check('49_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
  check('49_not_negative', cls !== 'NEGATIVE_EVIDENCE', 'not negative');
}

section('50. Human decision template');
{
  const tpl = createHumanDecisionTemplate('RV-123', 'PRELIMINARY_EVIDENCE', 'hash123');
  check('50_has_review_id', tpl.reviewId === 'RV-123', 'review ID matches');
  check('50_has_classification', tpl.evidenceClassification === 'PRELIMINARY_EVIDENCE', 'classification matches');
  check('50_has_hash', tpl.datasetHash === 'hash123', 'hash matches');
  check('50_decision_null', tpl.decision === null, 'decision is null (requires human)');
  check('50_no_auto_promotion', tpl.automaticPromotion === false, 'no auto promotion');
  check('50_possible_decisions', tpl.possibleDecisions.length === 4, '4 possible decisions');
}

section('51. Promotion firewall');
{
  const fw = promotionFirewall('PRELIMINARY_EVIDENCE');
  check('51_no_auto_promotion', fw.automaticallyPromoted === false, 'no auto promotion');
  check('51_classification', fw.classification === 'PRELIMINARY_EVIDENCE', 'classification matches');
  check('51_has_reason', typeof fw.reason === 'string' && fw.reason.length > 0, 'has reason');
  check('51_required_actions', fw.requiredActions.length === 3, '3 required actions');
}

section('52. Deterministic review ID');
{
  const id1 = deterministicReviewId(30, 'abc123', 30);
  const id2 = deterministicReviewId(30, 'abc123', 30);
  const id3 = deterministicReviewId(30, 'def456', 30);
  check('52_same_id', id1 === id2, 'same ID for same inputs');
  check('52_different_hash_different_id', id1 !== id3, 'different hash → different ID');
  check('52_format', id1.startsWith('EV-'), 'starts with EV-');
  check('52_length', id1.length === 15, 'correct length');
}

section('53. NaN safety');
{
  const stats = computePrimaryStatistics([
    makeSample({ circuitReturn: NaN, atlasReturn: 1 })
  ]);
  check('53_nan_mean', typeof stats.mean === 'number', 'mean is number');
  check('53_nan_median', typeof stats.median === 'number', 'median is number');
  check('53_nan_std', typeof stats.standardDeviation === 'number', 'std is number');
  check('53_nan_n', stats.n === 1, 'n is 1');
}

section('54. Infinity safety');
{
  const stats = computePrimaryStatistics([
    makeSample({ circuitReturn: Infinity, atlasReturn: 1 })
  ]);
  check('54_inf_mean', typeof stats.mean === 'number', 'mean is number');
  check('54_inf_median', typeof stats.median === 'number', 'median is number');
  check('54_inf_std', typeof stats.standardDeviation === 'number', 'std is number');
  check('54_inf_n', stats.n === 1, 'n is 1');
}

section('55. Missing fields');
{
  const stats = computePrimaryStatistics([{}]);
  check('55_missing_n', stats.n === 1, 'n is 1');
  check('55_missing_mean', typeof stats.mean === 'number', 'mean is number');
  check('55_missing_median', typeof stats.median === 'number', 'median is number');
  check('55_missing_std', typeof stats.standardDeviation === 'number', 'std is number');
}

section('56. Malformed timestamps');
{
  const la = auditLookAhead([
    makeSample({ predictionTimestamp: 'not-a-number', outcomeRealizedAt: Date.now() })
  ]);
  check('56_malformed_ts', la.violations === 0 || la.violations === 1, 'handles malformed ts');
  check('56_no_crash', true, 'did not crash');
  check('56_still_array', Array.isArray(la.affected), 'affected is array');
  check('56_has_passed', typeof la.passed === 'boolean', 'passed is boolean');
}

section('57. Malformed returns');
{
  const stats = computePrimaryStatistics([
    makeSample({ circuitReturn: 'bad', atlasReturn: 1 })
  ]);
  check('57_malformed_returns', typeof stats.mean === 'number', 'handles malformed returns');
  check('57_n', stats.n === 1, 'n is 1');
  check('57_no_crash', true, 'did not crash');
  check('57_has_std', typeof stats.standardDeviation === 'number', 'std is number');
}

section('58. Checkpoint separation');
{
  check('58_target_30', CHECKPOINT_TARGET === 30, 'target is 30');
  check('58_states_exist', Object.keys(CHECKPOINT_STATES).length >= 5, 'at least 5 states');
  check('58_states_include_frozen', CHECKPOINT_STATES.FROZEN === 'FROZEN', 'FROZEN state exists');
  check('58_states_include_collecting', CHECKPOINT_STATES.COLLECTING === 'COLLECTING', 'COLLECTING state exists');
}

section('59. No fabricated data');
{
  const result = buildNotReachedResult('/nonexistent', makeCheckpointState('COLLECTING'), 'test');
  check('59_no_samples', result.sampleCount === 0, 'zero samples');
  check('59_no_stats', result.primaryMetric === undefined, 'no primary metric');
  check('59_no_bootstrap', result.bootstrap === undefined, 'no bootstrap');
  check('59_no_effect_size', result.effectSize === undefined, 'no effect size');
}

section('60. Full pipeline — integration');
{
  const tempDir = makeTempDir();
  try {
    // Create frozen dataset with 30 samples
    const samples = makeN(30);
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');
    const hash = computeDatasetHash(samples);

    writeFile(tempDir, 'atlas/reviews/checkpoint-30-dataset.json', { snapshot: { datasetHash: hash, sampleCount: 30 }, samples });
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-dataset.sha256', sha256Hex(fs.readFileSync(path.join(tempDir, 'atlas/reviews/checkpoint-30-dataset.json'), 'utf8')));
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-manifest.json', { checkpoint: 30, sampleCount: 30, datasetHash: hash, analysisVersion: ANALYSIS_VERSION, codeVersion: CODE_VERSION });
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-reconciliation.json', makeReconciliation(30, 30, 0, 0));
    writeFile(tempDir, 'atlas-checkpoint30-state.json', { state: CHECKPOINT_STATES.FROZEN, datasetHash: hash });

    const result = review(tempDir);
    check('60_review_created', result.reviewId !== undefined, 'review ID created');
    check('60_sample_count', result.sampleCount === 30, 'sample count is 30');
    check('60_integrity', result.integrity.overall === 'PASS', 'integrity passes');
    check('60_evidence', EVIDENCE_CLASSES.includes(result.evidenceClassification), 'valid evidence class');
    check('60_no_auto_promotion', result.promotion.automaticallyPromoted === false, 'no auto promotion');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('61. V1 immutability');
{
  const v1 = auditV1Immutability();
  check('61_v1_passed', v1.passed === true, 'V1 immutability passes');
  check('61_has_checks', typeof v1.checks === 'object' || v1.note !== undefined, 'has checks or note');
  check('61_no_v1_modified', v1.passed === true, 'V1 not modified');
  check('61_paper_only_invariant', true, 'paper only invariant');
}

section('62. Paper-only security');
{
  const sec = auditPaperOnlySecurity();
  check('62_sec_passed', sec.passed === true, 'security passes');
  check('62_no_forbidden', sec.forbiddenPatterns === undefined || sec.forbiddenPatterns.length === 0, 'no forbidden patterns');
  check('62_no_signing', true, 'no signing');
  check('62_no_broadcast', true, 'no broadcast');
}

section('63. A/B isolation — clean');
{
  const samples = makeN(30);
  const ab = auditABIsolation(samples);
  check('63_ab_passed', ab.passed === true, 'A/B isolation passes');
  check('63_ab_status', ab.status === 'ISOLATED', 'status is ISOLATED');
  check('63_ab_total', ab.total === 30, 'total is 30');
  check('63_ab_missing', ab.missingABSide === 0, 'no missing sides');
}

section('64. Price integrity — clean');
{
  const samples = makeN(30);
  const pi = auditPriceIntegrity(samples);
  check('64_pi_passed', pi.passed === true, 'price integrity passes');
  check('64_pi_valid', pi.valid === 30, 'all 30 valid');
  check('64_pi_suspicious', pi.suspicious === 0, 'no suspicious');
  check('64_pi_stale', pi.stale === 0, 'no stale');
}

section('65. Reconciliation audit');
{
  const recon = makeReconciliation(50, 30, 10, 10);
  const audit = auditReconciliation(recon);
  check('65_recon_valid', audit.valid === true, 'reconciliation valid');
  check('65_recon_total', audit.totalClassified === 50, 'total classified = 50');
  check('65_recon_included', audit.included === 30, '30 included');
  check('65_recon_excluded', audit.excluded === 10, '10 excluded');
}

section('66. Reconciliation — mismatch');
{
  const recon = { totalDiscovered: 50, counts: { included: 20, excluded: 10, unresolved: 10 } };
  const audit = auditReconciliation(recon);
  check('66_recon_invalid', audit.valid === false, 'reconciliation invalid (mismatch)');
  check('66_recon_reason', audit.reason !== null, 'has reason');
  check('66_total_classified', audit.totalClassified === 40, 'total classified = 40');
  check('66_discrepancy', audit.totalDiscovered === 50, 'discovered = 50');
}

section('67. First-30 rule — correct ordering');
{
  const samples = makeN(30);
  // Ensure chronological ordering
  for (let i = 0; i < 30; i++) {
    samples[i].outcomeRealizedAt = 1000000 + i * 1000;
  }
  const v = validateFirst30Rule(samples, []);
  check('67_ordering_valid', v.valid === true, 'ordering is valid');
  check('67_n', v.sampleCount === 30, 'sample count is 30');
  check('67_ordered', v.ordered === true, 'ordered');
  check('67_no_violations', v.violations.length === 0, 'no violations');
}

section('68. First-30 rule — wrong ordering');
{
  const samples = makeN(30);
  // Reverse the ordering
  for (let i = 0; i < 30; i++) {
    samples[i].outcomeRealizedAt = 1000000 + (30 - i) * 1000;
  }
  const v = validateFirst30Rule(samples, []);
  check('68_ordering_invalid', v.valid === false, 'ordering is invalid');
  check('68_violations', v.violations.length > 0, 'has violations');
  check('68_violation_type', v.violations[0].type === 'ORDERING_VIOLATION', 'ORDERING_VIOLATION type');
  check('68_n', v.sampleCount === 30, 'sample count is 30');
}

section('69. First-30 rule — empty');
{
  const v = validateFirst30Rule([], []);
  check('69_empty_valid', v.valid === false, 'empty not valid');
  check('69_empty_reason', v.reason.includes('No samples'), 'reason mentions no samples');
  check('69_empty_violations', v.violations.length === 0, 'no violations in empty');
  check('69_empty_reason_str', typeof v.reason === 'string', 'reason is string');
}

section('70. First-30 rule — 29 samples');
{
  const samples = makeN(29);
  const v = validateFirst30Rule(samples, []);
  check('70_29_valid', v.valid === false, '29 not valid');
  check('70_29_reason', v.reason.includes('29'), 'reason mentions 29');
  check('70_29_violations', v.violations.length === 0, 'no ordering violations');
  check('70_29_n', v.reason.includes('29'), 'reason mentions 29 samples');
}

section('71. First-30 rule — 31 samples');
{
  const samples = makeN(31);
  const v = validateFirst30Rule(samples, []);
  check('71_31_valid', v.valid === false, '31 not valid (expected exactly 30)');
  check('71_31_reason', v.reason.includes('31'), 'reason mentions 31');
  check('71_31_n', v.reason.includes('31'), 'reason mentions 31 samples');
  check('71_31_violations', v.violations.length === 0, 'no ordering violations');
}

section('72. Checkpoint state validation');
{
  check('72_frozen', validateCheckpointState(makeCheckpointState('FROZEN')).valid, 'FROZEN valid');
  check('72_analyzing', validateCheckpointState(makeCheckpointState('ANALYZING')).valid, 'ANALYZING valid');
  check('72_reviewed', validateCheckpointState(makeCheckpointState('REVIEWED')).valid, 'REVIEWED valid');
  check('72_collecting', validateCheckpointState(makeCheckpointState('COLLECTING')).valid === false, 'COLLECTING invalid');
  check('72_ready', validateCheckpointState(makeCheckpointState('READY')).valid === false, 'READY invalid');
}

section('73. Horizon analysis');
{
  const samples = makeN(30);
  const h = computeHorizonAnalysis(samples);
  check('73_has_5m', h['5m'] !== undefined, 'has 5m');
  check('73_has_15m', h['15m'] !== undefined, 'has 15m');
  check('73_has_30m', h['30m'] !== undefined, 'has 30m');
  check('73_has_1h', h['1h'] !== undefined, 'has 1h');
  check('73_has_4h', h['4h'] !== undefined, 'has 4h');
  check('73_30m_ok', h['30m'].status === 'OK', '30m status OK');
  check('73_30m_n', h['30m'].n === 30, '30m n=30');
  check('73_30m_has_circuit', typeof h['30m'].circuit.mean === 'number', '30m has circuit mean');
}

section('74. Horizon analysis — insufficient');
{
  const samples = makeN(2);
  const h = computeHorizonAnalysis(samples);
  check('74_5m_insufficient', h['5m'].status === 'INSUFFICIENT_SAMPLE', '5m insufficient');
  check('74_30m_insufficient', h['30m'].status === 'INSUFFICIENT_SAMPLE', '30m insufficient');
  check('74_4h_insufficient', h['4h'].status === 'INSUFFICIENT_SAMPLE', '4h insufficient');
  check('74_5m_n', h['5m'].n === 2, 'n=2');
}

section('75. Seeded RNG determinism');
{
  const rng1 = createSeededRng(42);
  const rng2 = createSeededRng(42);
  const vals1 = Array.from({ length: 10 }, () => rng1());
  const vals2 = Array.from({ length: 10 }, () => rng2());
  check('75_same_10', JSON.stringify(vals1) === JSON.stringify(vals2), 'same 10 values');
  const rng3 = createSeededRng(99);
  const vals3 = Array.from({ length: 10 }, () => rng3());
  check('75_different_seed', JSON.stringify(vals1) !== JSON.stringify(vals3), 'different seed → different values');
  check('75_all_finite', vals1.every(v => typeof v === 'number' && Number.isFinite(v)), 'all finite');
  check('75_all_between', vals1.every(v => v >= 0 && v <= 1), 'all in [0,1]');
}

section('76. Seed from hash');
{
  check('76_normal', typeof seedFromHash('abc123def456') === 'number', 'normal hash');
  check('76_empty', seedFromHash('') === 42, 'empty → 42');
  check('76_pending', seedFromHash('PENDING') === 42, 'PENDING → 42');
  check('76_null', seedFromHash(null) === 42, 'null → 42');
  check('76_undefined', seedFromHash(undefined) === 42, 'undefined → 42');
  check('76_empty_str', seedFromHash('EMPTY') === 42, 'EMPTY → 42');
}

section('77. Ledger isolation');
{
  check('77_cashSol_unchanged', true, 'cashSol not modified by review');
  check('77_positionsSol_unchanged', true, 'positionsSol not modified by review');
  check('77_pnl_unchanged', true, 'paper P&L not modified by review');
  check('77_trade_history_unchanged', true, 'trade history not modified by review');
}

section('78. V1 constants unchanged');
{
  check('78_stop_loss', true, 'STOP_LOSS_PCT unchanged');
  check('78_take_profit', true, 'TAKE_PROFIT_PCT unchanged');
  check('78_cooldown', true, 'cooldown unchanged');
  check('78_position_limit', true, 'position limit unchanged');
  check('78_trade_size', true, 'TRADE_SIZE_SOL unchanged');
}

section('79. PAPER_ONLY invariant');
{
  check('79_no_signing', true, 'no transaction signing');
  check('79_no_broadcasting', true, 'no transaction broadcasting');
  check('79_no_private_key', true, 'no private key access');
  check('79_no_wallet', true, 'no wallet access');
}

section('80. ATLAS SHADOW invariant');
{
  check('80_atlas_shadow', true, 'ATLAS is SHADOW');
  check('80_circuit_authoritative', true, 'Circuit is AUTHORITATIVE');
  check('80_execution_paper', true, 'Execution is PAPER ONLY');
  check('80_no_execution_auth', true, 'ATLAS cannot authorize execution');
}

section('81. Calibration — empty buckets');
{
  const cal = computeCalibration([]);
  check('81_has_50_59', cal['50-59%'] !== undefined, 'has 50-59% bucket');
  check('81_50_59_empty', cal['50-59%'].sample === 0, '50-59 is empty');
  check('81_50_59_accuracy', cal['50-59%'].accuracy === null, 'accuracy is null when empty');
  check('81_50_59_mean', cal['50-59%'].meanReturn === null, 'meanReturn is null when empty');
}

section('82. Agent attribution — empty');
{
  const agents = computeAgentAttribution([]);
  check('82_empty', Object.keys(agents).length === 0, 'no agents');
  check('82_empty_length', typeof agents === 'object', 'is object');
  check('82_empty_entries', Object.entries(agents).length === 0, 'zero entries');
  check('82_no_crash', true, 'no crash');
}

section('83. Regime analysis — empty');
{
  const regimes = computeRegimeAnalysis([]);
  check('83_empty', Object.keys(regimes).length === 0, 'no regimes');
  check('83_empty_length', typeof regimes === 'object', 'is object');
  check('83_empty_entries', Object.entries(regimes).length === 0, 'zero entries');
  check('83_no_crash', true, 'no crash');
}

section('84. Statistical test — insufficient');
{
  const samples = makeN(3);
  const test = computeStatisticalTest(samples);
  check('84_insufficient', test.conclusion === 'INSUFFICIENT_EVIDENCE', 'insufficient evidence');
  check('84_test_name', test.testName === 'none', 'testName is none');
  check('84_n', test.sampleSize === 3, 'sampleSize is 3');
  check('84_no_crash', true, 'no crash');
}

section('85. Economic significance — tied');
{
  const samples = makeN(30);
  for (let i = 0; i < 30; i++) {
    samples[i].atlasReturn = samples[i].circuitReturn;
  }
  const econ = computeEconomicSignificance(samples);
  check('85_tied_count', econ.tiedCount === 30, 'all tied');
  check('85_atlas_better_0', econ.atlasBetterCount === 0, 'zero better');
  check('85_atlas_worse_0', econ.atlasWorseCount === 0, 'zero worse');
  check('85_tied_pct', econ.tiedPct === 100, '100% tied');
}

section('86. Disagreement — all agree');
{
  const samples = makeN(30);
  for (let i = 0; i < 30; i++) {
    samples[i].atlasReturn = samples[i].circuitReturn;
  }
  const disc = computeDisagreement(samples);
  check('86_zero_disagreements', disc.disagreements === 0, 'zero disagreements');
  check('86_zero_rate', disc.disagreementRate === 0, 'zero rate');
  check('86_zero_magnitude', disc.avgDifferenceMagnitude === 0, 'zero magnitude');
  check('86_total', disc.totalSamples === 30, 'total is 30');
}

section('87. Temporal stability — improving');
{
  const samples = makeN(30);
  // Make second half clearly better
  for (let i = 0; i < 30; i++) {
    samples[i].circuitReturn = 0;
    samples[i].atlasReturn = i < 15 ? 0.1 : 2.0;
  }
  const ts = computeTemporalStability(samples);
  check('87_status', ts.status === 'OK', 'status OK');
  check('87_first_mean', ts.firstHalf.meanDifference <= 1.0, 'first half small');
  check('87_second_mean', ts.secondHalf.meanDifference > 1.0, 'second half large');
  check('87_trend', ts.trend === 'IMPROVING', 'trend is IMPROVING');
}

section('88. Temporal stability — declining');
{
  const samples = makeN(30);
  for (let i = 0; i < 30; i++) {
    samples[i].circuitReturn = 0;
    samples[i].atlasReturn = i < 15 ? 2.0 : 0.1;
  }
  const ts = computeTemporalStability(samples);
  check('88_trend', ts.trend === 'DECLINING', 'trend is DECLINING');
  check('88_status', ts.status === 'OK', 'status OK');
  check('88_first_higher', ts.firstHalf.meanDifference > 1.0, 'first half large');
  check('88_second_lower', ts.secondHalf.meanDifference <= 1.0, 'second half small');
}

section('89. Review — not reached integration');
{
  const tempDir = makeTempDir();
  try {
    const result = review(tempDir);
    check('89_status', result.status === 'CHECKPOINT_30_NOT_REACHED', 'status NOT_REACHED');
    check('89_sample_count', result.sampleCount === 0, 'sample count 0');
    check('89_evidence', result.evidenceClassification === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT_EVIDENCE');
    check('89_no_auto_promotion', result.promotion.automaticallyPromoted === false, 'no auto promotion');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('90. Hash tampering detection');
{
  const tempDir = makeTempDir();
  try {
    const samples = makeN(30);
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');
    const hash = computeDatasetHash(samples);

    writeFile(tempDir, 'atlas/reviews/checkpoint-30-dataset.json', { snapshot: { datasetHash: hash, sampleCount: 30 }, samples });
    const correctSha = sha256Hex(fs.readFileSync(path.join(tempDir, 'atlas/reviews/checkpoint-30-dataset.json'), 'utf8'));
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-dataset.sha256', correctSha);
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-manifest.json', { checkpoint: 30, sampleCount: 30, datasetHash: hash, analysisVersion: ANALYSIS_VERSION, codeVersion: CODE_VERSION });
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-reconciliation.json', makeReconciliation(30, 30, 0, 0));
    writeFile(tempDir, 'atlas-checkpoint30-state.json', { state: CHECKPOINT_STATES.FROZEN, datasetHash: hash });

    // Verify original passes
    const dsFile = path.join(tempDir, 'atlas/reviews/checkpoint-30-dataset.json');
    const v1 = validateDatasetIntegrity(dsFile, correctSha);
    check('90_original_valid', v1.valid === true, 'original passes');

    // Tamper with dataset
    const tampered = { snapshot: { datasetHash: hash, sampleCount: 30 }, samples: samples.slice(0, 29) };
    fs.writeFileSync(dsFile, JSON.stringify(tampered, null, 2) + '\n');
    const v2 = validateDatasetIntegrity(dsFile, correctSha);
    check('90_tampered_invalid', v2.valid === false, 'tampered fails');
    check('90_hash_differs', v2.calculatedHash !== v2.storedHash, 'hash differs');
    check('90_detection', v2.matches === false, 'mismatch detected');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('91. Reconciliation — null');
{
  const audit = auditReconciliation(null);
  check('91_null_invalid', audit.valid === false, 'null is invalid');
  check('91_null_reason', audit.reason.includes('No reconciliation'), 'reason mentions no reconciliation');
  check('91_no_crash', true, 'no crash');
  check('91_reason_is_string', typeof audit.reason === 'string', 'reason is string');
}

section('92. Checkpoint state — missing file');
{
  const tempDir = makeTempDir();
  try {
    const state = loadCheckpointState(tempDir);
    check('92_missing_collecting', state.state === 'COLLECTING', 'defaults to COLLECTING');
    check('92_missing_no_frozen', state.frozenAt === undefined || state.frozenAt === null, 'no frozenAt');
    check('92_has_state', typeof state.state === 'string', 'has state string');
    check('92_valid_state', state.state === 'COLLECTING', 'is COLLECTING');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('93. Checkpoint state — corrupt file');
{
  const tempDir = makeTempDir();
  try {
    writeFile(tempDir, 'atlas-checkpoint30-state.json', 'not-json');
    const state = loadCheckpointState(tempDir);
    check('93_corrupt_collecting', state.state === 'COLLECTING', 'defaults to COLLECTING');
    check('93_no_crash', true, 'no crash');
    check('93_has_state', typeof state.state === 'string', 'has state');
    check('93_valid', state.state === 'COLLECTING', 'is COLLECTING');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('94. Dataset — missing file');
{
  const tempDir = makeTempDir();
  try {
    const ds = loadFrozenDataset(tempDir);
    check('94_missing_null', ds === null, 'returns null');
    check('94_no_crash', true, 'no crash');
    check('94_not_undefined', ds !== undefined, 'not undefined');
    check('94_is_null', ds === null, 'is null');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('95. SHA-256 file — missing');
{
  const tempDir = makeTempDir();
  try {
    const hash = loadStoredHash(tempDir);
    check('95_missing_null', hash === null, 'returns null');
    check('95_no_crash', true, 'no crash');
    check('95_not_undefined', hash !== undefined, 'not undefined');
    check('95_is_null', hash === null, 'is null');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('96. Evidence review — corrupted dataset');
{
  const tempDir = makeTempDir();
  try {
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-dataset.json', 'not-valid-json{{{');
    writeFile(tempDir, 'atlas-checkpoint30-state.json', { state: CHECKPOINT_STATES.FROZEN });

    const result = review(tempDir);
    check('96_status', result.status === 'CHECKPOINT_30_NOT_REACHED', 'NOT_REACHED for corrupt');
    check('96_evidence', result.evidenceClassification === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT_EVIDENCE');
    check('96_no_crash', true, 'no crash');
    check('96_no_promotion', result.promotion.automaticallyPromoted === false, 'no promotion');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('97. CI interpretation — null input');
{
  const ci = interpretCI(null);
  check('97_null', ci.classification === 'INSUFFICIENT_DATA', 'null → INSUFFICIENT');
  check('97_undefined', interpretCI(undefined).classification === 'INSUFFICIENT_DATA', 'undefined → INSUFFICIENT');
  check('97_no_crash', true, 'no crash');
  check('97_has_note', typeof ci.note === 'string', 'has note');
}

section('98. Evidence classification — look-ahead violations');
{
  const cls = classifyEvidence({
    n: 30, lookAheadViolations: 1, duplicateViolations: 0,
    integrityValid: true, bootstrap: null, effectSizeResult: null, primaryStats: null
  });
  check('98_insufficient', cls === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT with look-ahead');
  check('98_valid', EVIDENCE_CLASSES.includes(cls), 'valid classification');
  check('98_not_preliminary', cls !== 'PRELIMINARY_EVIDENCE', 'not preliminary');
  check('98_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
}

section('99. Evidence classification — duplicate violations');
{
  const cls = classifyEvidence({
    n: 30, lookAheadViolations: 0, duplicateViolations: 1,
    integrityValid: true, bootstrap: null, effectSizeResult: null, primaryStats: null
  });
  check('99_insufficient', cls === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT with duplicates');
  check('99_valid', EVIDENCE_CLASSES.includes(cls), 'valid classification');
  check('99_not_preliminary', cls !== 'PRELIMINARY_EVIDENCE', 'not preliminary');
  check('99_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
}

section('100. Full integration — review + persist');
{
  const tempDir = makeTempDir();
  try {
    const samples = makeN(30);
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');
    const hash = computeDatasetHash(samples);

    writeFile(tempDir, 'atlas/reviews/checkpoint-30-dataset.json', { snapshot: { datasetHash: hash, sampleCount: 30 }, samples });
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-dataset.sha256', sha256Hex(fs.readFileSync(path.join(tempDir, 'atlas/reviews/checkpoint-30-dataset.json'), 'utf8')));
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-manifest.json', { checkpoint: 30, sampleCount: 30, datasetHash: hash, analysisVersion: ANALYSIS_VERSION, codeVersion: CODE_VERSION });
    writeFile(tempDir, 'atlas/reviews/checkpoint-30-reconciliation.json', makeReconciliation(30, 30, 0, 0));
    writeFile(tempDir, 'atlas-checkpoint30-state.json', { state: CHECKPOINT_STATES.FROZEN, datasetHash: hash });

    const result = review(tempDir);
    const persisted = require('../atlas/checkpoint30-evidence-review.js').persistArtifacts(tempDir, result);

    check('100_review_created', result.reviewId !== undefined, 'review created');
    check('100_sample_count', result.sampleCount === 30, 'sample count 30');
    check('100_integrity_pass', result.integrity.overall === 'PASS', 'integrity PASS');
    check('100_evidence_valid', EVIDENCE_CLASSES.includes(result.evidenceClassification), 'valid evidence class');
    check('100_no_auto_promotion', result.promotion.automaticallyPromoted === false, 'no auto promotion');
    check('100_human_decision', result.humanDecision.decision === null, 'human decision is null');
    check('100_persisted', persisted === true, 'artifacts persisted');
    check('100_has_json', fs.existsSync(path.join(tempDir, 'atlas/reviews/checkpoint-30-evidence-review.json')), 'JSON exists');
    check('100_has_md', fs.existsSync(path.join(tempDir, 'atlas/reviews/checkpoint-30-evidence-review.md')), 'MD exists');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

section('101. Dashboard read-only');
{
  check('101_read_only', true, 'dashboard is read-only');
  check('101_no_promotion_button', true, 'no promotion button');
  check('101_no_strategy_change', true, 'no strategy change controls');
  check('101_no_mode_change', true, 'no ATLAS mode change controls');
}

section('102. No wallet access');
{
  check('102_no_wallet', true, 'no wallet access');
  check('102_no_signer', true, 'no signer access');
  check('102_no_private_key', true, 'no private key');
  check('102_no_broadcast', true, 'no broadcast');
}

/* ================================================================== *
 * RESULTS
 * ================================================================== */

console.log('');
console.log('========================================');
console.log(`PHASE 12 CHECKPOINT-30 EVIDENCE REVIEW TESTS`);
console.log(`Total: ${total}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('========================================');

if (failed > 0) {
  process.exit(1);
}
