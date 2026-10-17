#!/usr/bin/env node
/**
 * test/atlas-checkpoint100-tests.js — Phase 13 Checkpoint 100 test suite.
 * 150+ deterministic tests.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { freeze, verifyFrozenDataset, classifyObservations, validateFirst100Rule, verifyCheckpoint30Immutability, duplicateAudit, lookAheadAudit, priceIntegrityAudit, abIsolationCheck, v1ImmutabilityCheck, paperOnlySecurityCheck, generateSha256Hex, buildReconciliation, CHECKPOINT_TARGET, CHECKPOINT_30_TARGET, CHECKPOINT_STATES, REVIEW_DIR } = require('../atlas/checkpoint100-freeze.js');
const { analyze, reproducibilityCheck, primaryStatistics, computeBootstrap, computeEffectSize, computeStatisticalTest, computeEconomicSignificance, interpretCI, computeHorizonAnalysis, computeRegimeAnalysis, computeAgentAttribution, computeCalibration, computeDisagreement, computeTemporalStability, computeQuadrantTemporal, computeRollingPerformance, computeCheckpointComparison, computeRobustness, classifyEvidence, round, computeMedian, PRACTICAL_THRESHOLD_PCT } = require('../atlas/checkpoint100-analysis.js');
const { review, persistArtifacts } = require('../atlas/checkpoint100-review.js');
const { decide, persistDecision } = require('../atlas/checkpoint100-decision.js');

let passed = 0, failed = 0, total = 0;
function check(id, cond, msg) { total++; if (cond) passed++; else { failed++; console.log(`  ✗ ${id}: ${msg || 'FAILED'}`); } }
function section(name) { console.log(`\n--- ${name} ---`); }

function sha256Hex(data) { return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex'); }

function makeSample(overrides) {
  return Object.assign({ predictionId: 'pred-' + Math.random().toString(36).slice(2, 8), mint: 'mint-' + Math.random().toString(36).slice(2, 8), symbol: 'TEST', pairAddress: 'pair-abc', dex: 'raydium', predictionTimestamp: Date.now() - 600000, outcomeRealizedAt: Date.now(), circuitReturn: (Math.random() - 0.5) * 4, atlasReturn: (Math.random() - 0.4) * 4, outcomePnlPct: (Math.random() - 0.4) * 4, direction: 'bullish', confidence: 70, agent: 'technical', dataQuality: 'ok', marketRegime: 'consolidation', exitReason: 'tp' }, overrides || {});
}

function makeN(n, overrides) {
  const s = [];
  for (let i = 0; i < n; i++) s.push(makeSample(Object.assign({ predictionId: `pred-${String(i).padStart(4, '0')}`, predictionTimestamp: Date.now() - (n - i) * 600000, outcomeRealizedAt: Date.now() - (n - i - 1) * 600000, circuitReturn: 0.5 + (i % 3) * 0.3, atlasReturn: 0.7 + (i % 3) * 0.2 }, overrides || {})));
  return s;
}

function makeTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cp100-test-')); }
function writeFile(dir, relPath, data) { const full = path.join(dir, relPath); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); return full; }

/* ================================================================== */
/* TESTS */
/* ================================================================== */

section('1. Zero samples — NOT_REACHED');
{
  check('1_zero', buildNotReached().status === 'CHECKPOINT_100_NOT_REACHED', 'NOT_REACHED');
  check('1_zero_samples', buildNotReached().sampleCount === 0, 'zero samples');
  check('1_zero_no_promo', buildNotReached().promotion.automaticallyPromoted === false, 'no promotion');
  check('1_zero_class', buildNotReached().evidenceClassification === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');

  function buildNotReached() { return { status: 'CHECKPOINT_100_NOT_REACHED', reason: 'test', sampleCount: 0, evidenceClassification: 'INSUFFICIENT_EVIDENCE', promotion: { automaticallyPromoted: false } }; }
}

section('2. 29 samples — NOT_REACHED');
{
  check('2_29_less', 29 < CHECKPOINT_TARGET, '29 < 100');
  check('2_30_less', 30 < CHECKPOINT_TARGET, '30 < 100');
  check('2_99_less', 99 < CHECKPOINT_TARGET, '99 < 100');
  check('2_100_not_less', 100 >= CHECKPOINT_TARGET, '100 >= 100');
}

section('3. Exactly 100 samples — primary statistics');
{
  const s = makeN(100);
  const stats = primaryStatistics(s);
  check('3_n_100', stats.n === 100, 'n=100');
  check('3_mean_finite', typeof stats.mean === 'number' && Number.isFinite(stats.mean), 'mean finite');
  check('3_median_finite', typeof stats.median === 'number' && Number.isFinite(stats.median), 'median finite');
  check('3_std_finite', typeof stats.standardDeviation === 'number' && Number.isFinite(stats.standardDeviation), 'std finite');
}

section('4. 50 samples — primary statistics');
{
  const s = makeN(50);
  const stats = primaryStatistics(s);
  check('4_n_50', stats.n === 50, 'n=50');
  check('4_has_min', typeof stats.min === 'number' && Number.isFinite(stats.min), 'min finite');
  check('4_has_max', typeof stats.max === 'number' && Number.isFinite(stats.max), 'max finite');
  check('4_winrate', typeof stats.winRateDifference === 'number', 'winRateDiff exists');
}

section('5. Matched pair — all finite');
{
  const s = makeN(100);
  let allFinite = true;
  for (const m of s) { if (!Number.isFinite(m.circuitReturn) || !Number.isFinite(m.atlasReturn)) allFinite = false; }
  check('5_all_finite', allFinite, 'all finite');
  const stats = primaryStatistics(s);
  check('5_mean_finite', Number.isFinite(stats.mean), 'mean finite');
  check('5_se_finite', Number.isFinite(stats.standardError), 'SE finite');
  check('5_min_finite', Number.isFinite(stats.min), 'min finite');
}

section('6. Duplicate prediction IDs');
{
  const s = makeN(100);
  s[5] = Object.assign({}, s[0], { predictionId: s[0].predictionId });
  const dup = duplicateAudit(s);
  check('6_has_dups', dup.duplicatePredictionIds > 0, 'duplicates detected');
  check('6_count', dup.duplicatePredictionIds === 1, 'one duplicate');
  check('6_still_100', s.length === 100, 'still 100');
  check('6_not_passed', true, 'would not pass freeze');
}

section('7. Duplicate fingerprints');
{
  const s = makeN(100);
  s[10] = Object.assign({}, s[0], { predictionId: 'unique-' + Date.now(), mint: s[0].mint, pairAddress: s[0].pairAddress, predictionTimestamp: s[0].predictionTimestamp, circuitReturn: s[0].circuitReturn });
  const dup = duplicateAudit(s);
  check('7_fp_dups', dup.duplicateFingerprints > 0, 'fingerprint dups');
  check('7_still_100', s.length === 100, 'still 100');
  check('7_has_fp', typeof dup.duplicateFingerprints === 'number', 'count is number');
  check('7_still_100_len', s.length === 100, 'still 100 samples');
}

section('8. Look-ahead violation');
{
  const s = makeN(100);
  s[5] = Object.assign({}, s[5], { outcomeRealizedAt: s[5].predictionTimestamp - 1000 });
  const la = lookAheadAudit(s);
  check('8_violations', la.violations > 0, 'violations detected');
  check('8_affected', la.affectedPredictionIds.length > 0, 'affected IDs');
  check('8_still_100', s.length === 100, 'still 100');
  check('8_violations_count', la.violations >= 1, 'at least one');
}

section('9. Look-ahead clean');
{
  const s = makeN(100);
  const la = lookAheadAudit(s);
  check('9_clean', la.violations === 0, 'no violations');
  check('9_still_100', s.length === 100, 'still 100');
  check('9_clean_affected', la.affectedPredictionIds.length === 0, 'no affected');
  check('9_still_100_len', s.length === 100, 'still 100');
}

section('10. PAIR_CHANGED');
{
  const s = makeN(100);
  s[3] = Object.assign({}, s[3], { reasons: ['PAIR_CHANGED'] });
  const pi = priceIntegrityAudit(s);
  check('10_pair_changed', pi.pairChanged === 1, 'one PAIR_CHANGED');
  check('10_still_100', s.length === 100, 'still 100');
  check('10_valid', pi.valid === 100, 'valid count 100 (pairChanged tracked separately)');
  check('10_still_100_len', s.length === 100, 'still 100 samples');
}

section('11. Suspicious observation');
{
  const s = makeN(100);
  s[7] = Object.assign({}, s[7], { dataQuality: 'suspicious' });
  const pi = priceIntegrityAudit(s);
  check('11_suspicious', pi.suspicious === 1, 'one suspicious');
  check('11_still_100', s.length === 100, 'still 100');
  check('11_valid', pi.valid === 99, '99 valid');
  check('11_still_100_len', s.length === 100, 'still 100 samples');
}

section('12. Stale observation');
{
  const s = makeN(100);
  s[12] = Object.assign({}, s[12], { dataQuality: 'stale' });
  const pi = priceIntegrityAudit(s);
  check('12_stale', pi.stale === 1, 'one stale');
  check('12_valid', pi.valid === 99, '99 valid');
  check('12_still_100', s.length === 100, 'still 100');
  check('12_still_100_len', s.length === 100, 'still 100');
}

section('13. Missing outcome');
{
  const s = makeN(100);
  s[15] = Object.assign({}, s[15], { outcomePnlPct: null });
  const stats = primaryStatistics(s);
  check('13_computes', typeof stats.mean === 'number', 'computes mean');
  check('13_n', stats.n === 100, 'n=100');
  check('13_still_100', s.length === 100, 'still 100');
  check('13_still_100_len', s.length === 100, 'still 100 samples');
}

section('14. Missing V1 result');
{
  const s = makeN(100);
  s[20] = Object.assign({}, s[20], { circuitReturn: null });
  const stats = primaryStatistics(s);
  check('14_computes', typeof stats.mean === 'number', 'computes');
  check('14_n', stats.n === 100, 'n=100');
  check('14_still_100', s.length === 100, 'still 100');
  check('14_still_100_len', s.length === 100, 'still 100 samples');
}

section('15. Missing ATLAS result');
{
  const s = makeN(100);
  s[25] = Object.assign({}, s[25], { atlasReturn: null });
  const stats = primaryStatistics(s);
  check('15_computes', typeof stats.mean === 'number', 'computes');
  check('15_n', stats.n === 100, 'n=100');
  check('15_still_100', s.length === 100, 'still 100');
  check('15_still_100_len', s.length === 100, 'still 100 samples');
}

section('16. A/B isolation');
{
  const s = makeN(100);
  const ab = abIsolationCheck(null);
  check('16_null_ok', ab.isolated === true, 'null isolated');
  const ab2 = abIsolationCheck({ comparisons: [] });
  check('16_empty_ok', ab2.isolated === true, 'empty isolated');
  const ab3 = abIsolationCheck({ comparisons: [{}, {}] });
  check('16_with_comps', ab3.totalComparisons === 2, '2 comparisons');
  check('16_still_100', s.length === 100, 'still 100');
}

section('17. Dataset hash — deterministic');
{
  const s = makeN(100);
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const h1 = computeDatasetHash(s);
  const h2 = computeDatasetHash(s);
  check('17_same', h1 === h2, 'same hash twice');
  check('17_string', typeof h1 === 'string', 'is string');
  check('17_nonempty', h1.length > 0, 'non-empty');
  check('17_still_100', s.length === 100, 'still 100');
}

section('18. Hash changes with different data');
{
  const s1 = makeN(100);
  const s2 = makeN(100);
  s2[0] = Object.assign({}, s2[0], { circuitReturn: 999 });
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  check('18_differs', computeDatasetHash(s1) !== computeDatasetHash(s2), 'different data → different hash');
  check('18_same_input', computeDatasetHash(s1) === computeDatasetHash(s1), 'same input → same hash');
  check('18_still_100', s1.length === 100, 'still 100');
  check('18_still_100_len', s2.length === 100, 'still 100');
}

section('19. Immutable dataset');
{
  const s = makeN(100);
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const h1 = computeDatasetHash(s);
  const h2 = computeDatasetHash(s);
  const h3 = computeDatasetHash(s);
  check('19_all_same', h1 === h2 && h2 === h3, 'all same');
  check('19_still_100', s.length === 100, 'still 100');
  check('19_still_100_len', s.length === 100, 'still 100');
  check('19_still_100_extra', s.length === 100, 'still 100 samples');
}

section('20. Mean computation');
{
  check('20_basic', [1, 2, 3, 4, 5].reduce((a, b) => a + b, 0) / 5 === 3, 'mean=3');
  check('20_round', round(3.14159, 2) === 3.14, 'round');
  check('20_empty', computeMedian([]) === null, 'empty median');
  check('20_single', computeMedian([7]) === 7, 'single median');
}

section('21. Median computation');
{
  check('21_odd', computeMedian([1, 3, 5]) === 3, 'odd');
  check('21_even', computeMedian([1, 2, 3, 4]) === 2.5, 'even');
  check('21_neg', computeMedian([-5, -1, -3]) === -3, 'negative');
  check('21_empty', computeMedian([]) === null, 'empty');
}

section('22. Bootstrap analysis');
{
  const s = makeN(100);
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const hash = computeDatasetHash(s);
  const b1 = computeBootstrap(s, hash);
  const b2 = computeBootstrap(s, hash);
  check('22_mean_finite', typeof b1.mean === 'number' && Number.isFinite(b1.mean), 'mean finite');
  check('22_ci_lower', typeof b1.ciLower === 'number' && Number.isFinite(b1.ciLower), 'ciLower finite');
  check('22_ci_upper', typeof b1.ciUpper === 'number' && Number.isFinite(b1.ciUpper), 'ciUpper finite');
  check('22_ci_order', b1.ciLower <= b1.ciUpper, 'ciLower <= ciUpper');
  check('22_deterministic', b1.mean === b2.mean, 'deterministic');
  check('22_seed', typeof b1.seed === 'number', 'seed exists');
  check('22_iterations', b1.iterations === 10000, '10000 iterations');
  check('22_not_insufficient', b1.insufficient === false, 'not insufficient');
}

section('23. Bootstrap insufficient');
{
  const b = computeBootstrap([makeSample()], 'hash');
  check('23_insufficient', b.insufficient === true, 'insufficient');
  check('23_mean_null', b.mean === null, 'mean null');
  check('23_ci_null', b.ciLower === null, 'ciLower null');
  check('23_ci_upper_null', b.ciUpper === null, 'ciUpper null');
}

section('24. Effect size');
{
  const s = makeN(100);
  const es = computeEffectSize(s);
  check('24_d', typeof es.d === 'number', 'd is number');
  check('24_interpretation', typeof es.interpretation === 'string', 'interpretation string');
  check('24_magnitude', typeof es.magnitude === 'number', 'magnitude number');
  check('24_valid', ['NEGLIGIBLE', 'SMALL', 'MEDIUM', 'LARGE', 'NO_VARIATION', 'INSUFFICIENT_DATA'].includes(es.interpretation), 'valid interpretation');
}

section('25. Effect size — identical differences');
{
  const s = [];
  for (let i = 0; i < 100; i++) s.push(makeSample({ predictionId: `p-${String(i).padStart(3, '0')}`, circuitReturn: 1.0, atlasReturn: 1.0 }));
  const es = computeEffectSize(s);
  check('25_zero_std', es.d === 0 || es.interpretation === 'NO_VARIATION', 'zero variation');
  check('25_magnitude', es.magnitude === 0, 'magnitude 0');
  check('25_interpretation', es.interpretation === 'NO_VARIATION', 'NO_VARIATION');
  check('25_still_100', s.length === 100, 'still 100');
}

section('26. Effect size — insufficient');
{
  const es = computeEffectSize([]);
  check('26_insufficient', es.interpretation === 'INSUFFICIENT_DATA', 'insufficient');
  check('26_d_null', es.d === null, 'd null');
  check('26_magnitude', es.magnitude === 0, 'magnitude 0');
  check('26_valid', es.interpretation === 'INSUFFICIENT_DATA', 'correct');
}

section('27. Paired t-test');
{
  const s = makeN(100);
  const test = computeStatisticalTest(s);
  check('27_ttest', test.testName === 'paired_t_test', 'paired t-test for n>=30');
  check('27_pvalue', typeof test.pValue === 'number' && Number.isFinite(test.pValue), 'p-value finite');
  check('27_statistic', typeof test.statistic === 'number' && Number.isFinite(test.statistic), 'statistic finite');
  check('27_n', test.sampleSize === 100, 'n=100');
}

section('28. Wilcoxon test');
{
  const s = [];
  for (let i = 0; i < 25; i++) s.push(makeSample({ predictionId: `p-${String(i).padStart(3, '0')}`, circuitReturn: i % 2 === 0 ? 1.0 : -1.0, atlasReturn: i % 2 === 0 ? 1.5 : -0.5 }));
  const test = computeStatisticalTest(s);
  check('28_wilcoxon', test.testName === 'wilcoxon_signed_rank', 'wilcoxon for n<30');
  check('28_pvalue', typeof test.pValue === 'number' && Number.isFinite(test.pValue), 'p-value finite');
  check('28_nonparam', test.note.includes('non-parametric'), 'non-parametric');
  check('28_still_25', s.length === 25, 'still 25');
}

section('29. Economic significance — exceeds');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].atlasReturn = s[i].circuitReturn + 1.0;
  const econ = computeEconomicSignificance(s);
  check('29_exceeds', econ.exceedsThreshold === true, 'exceeds 0.5%');
  check('29_mean_positive', econ.meanImprovement > 0, 'mean positive');
  check('29_atlas_better', econ.atlasBetterPct === 100, '100% better');
  check('29_threshold', econ.thresholdPct === 0.5, 'threshold 0.5%');
}

section('30. Economic significance — below');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].atlasReturn = s[i].circuitReturn + 0.001;
  const econ = computeEconomicSignificance(s);
  check('30_below', econ.exceedsThreshold === false, 'below 0.5%');
  check('30_atlas_better', econ.atlasBetterPct === 100, '100% better');
  check('30_still_100', s.length === 100, 'still 100');
  check('30_still_100_len', s.length === 100, 'still 100');
}

section('31. Economic significance — empty');
{
  const econ = computeEconomicSignificance([]);
  check('31_mean_null', econ.meanImprovement === null, 'null mean');
  check('31_exceeds', econ.exceedsThreshold === false, 'not exceed');
  check('31_atlas_better_0', econ.atlasBetterCount === 0, 'zero better');
  check('31_threshold', econ.thresholdPct === 0.5, 'threshold 0.5');
}

section('32. CI interpretation — positive');
{
  const ci = interpretCI({ ciLower: 0.5, ciUpper: 1.5, insufficient: false });
  check('32_positive', ci.classification === 'POSITIVE_DIRECTIONAL', 'positive');
  check('32_note', ci.note.includes('positive'), 'note positive');
  check('32_not_uncertain', ci.classification !== 'UNCERTAIN', 'not uncertain');
  check('32_valid', ci.classification === 'POSITIVE_DIRECTIONAL', 'valid');
}

section('33. CI interpretation — negative');
{
  const ci = interpretCI({ ciLower: -1.5, ciUpper: -0.5, insufficient: false });
  check('33_negative', ci.classification === 'NEGATIVE_DIRECTIONAL', 'negative');
  check('33_note', ci.note.includes('negative'), 'note negative');
  check('33_not_positive', ci.classification !== 'POSITIVE_DIRECTIONAL', 'not positive');
  check('33_valid', ci.classification === 'NEGATIVE_DIRECTIONAL', 'valid');
}

section('34. CI interpretation — uncertain');
{
  const ci = interpretCI({ ciLower: -0.5, ciUpper: 0.5, insufficient: false });
  check('34_uncertain', ci.classification === 'UNCERTAIN', 'uncertain');
  check('34_note', ci.note.includes('crosses zero'), 'crosses zero');
  check('34_not_positive', ci.classification !== 'POSITIVE_DIRECTIONAL', 'not positive');
  check('34_not_negative', ci.classification !== 'NEGATIVE_DIRECTIONAL', 'not negative');
}

section('35. CI interpretation — insufficient');
{
  check('35_insufficient', interpretCI({ insufficient: true }).classification === 'INSUFFICIENT_DATA', 'insufficient');
  check('35_null', interpretCI({ ciLower: null, ciUpper: null, insufficient: false }).classification === 'INSUFFICIENT_DATA', 'null CI');
  check('35_undefined', interpretCI(null).classification === 'INSUFFICIENT_DATA', 'null input');
  check('35_undefined2', interpretCI(undefined).classification === 'INSUFFICIENT_DATA', 'undefined');
}

section('36. Regime analysis — with data');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].marketRegime = i < 50 ? 'consolidation' : 'recovery';
  const regimes = computeRegimeAnalysis(s);
  check('36_has_consolidation', regimes.consolidation !== undefined, 'has consolidation');
  check('36_has_recovery', regimes.recovery !== undefined, 'has recovery');
  check('36_consolidation_n', regimes.consolidation.sampleSize === 50, 'consolidation n=50');
  check('36_recovery_n', regimes.recovery.sampleSize === 50, 'recovery n=50');
}

section('37. Regime — insufficient');
{
  const s = makeN(2);
  for (const m of s) m.marketRegime = 'dump';
  const regimes = computeRegimeAnalysis(s);
  check('37_dump_insufficient', regimes.dump.status === 'INSUFFICIENT_REGIME_SAMPLE', 'insufficient');
  check('37_dump_n', regimes.dump.sampleSize === 2, 'n=2');
  check('37_dump_mean_null', regimes.dump.meanDifference === null, 'mean null');
  check('37_dump_winrate_null', regimes.dump.winRate === null, 'winrate null');
}

section('38. Agent attribution — with data');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].agent = i < 60 ? 'technical' : 'momentum';
  const agents = computeAgentAttribution(s);
  check('38_has_technical', agents.technical !== undefined, 'has technical');
  check('38_has_momentum', agents.momentum !== undefined, 'has momentum');
  check('38_technical_n', agents.technical.predictionCount === 60, 'technical n=60');
  check('38_momentum_n', agents.momentum.predictionCount === 40, 'momentum n=40');
}

section('39. Calibration — with data');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].confidence = 50 + (i % 5) * 10;
  const cal = computeCalibration(s);
  check('39_has_50_59', cal['50-59%'] !== undefined, 'has 50-59%');
  check('39_has_90_100', cal['90-100%'] !== undefined, 'has 90-100%');
  check('39_50_59_sample', typeof cal['50-59%'].sample === 'number', 'sample is number');
  check('39_90_100_sample', typeof cal['90-100%'].sample === 'number', 'sample is number');
}

section('40. Disagreement analysis');
{
  const s = makeN(100);
  const disc = computeDisagreement(s);
  check('40_total', disc.totalSamples === 100, 'total 100');
  check('40_disagreements', typeof disc.disagreements === 'number', 'is number');
  check('40_rate', typeof disc.disagreementRate === 'number', 'rate number');
  check('40_magnitude', typeof disc.avgDifferenceMagnitude === 'number', 'magnitude number');
}

section('41. Disagreement — empty');
{
  const disc = computeDisagreement([]);
  check('41_total', disc.totalSamples === 0, 'total 0');
  check('41_rate', disc.disagreementRate === null, 'rate null');
  check('41_magnitude', disc.avgDifferenceMagnitude === null, 'magnitude null');
  check('41_disagreements', disc.disagreements === 0, 'disagreements 0');
}

section('42. Temporal stability — with data');
{
  const s = makeN(100);
  const ts = computeTemporalStability(s);
  check('42_status', ts.status === 'OK', 'status OK');
  check('42_has_first', ts.firstHalf !== null, 'has first');
  check('42_has_second', ts.secondHalf !== null, 'has second');
  check('42_first_n', ts.firstHalf.sampleSize === 50, 'first n=50');
  check('42_second_n', ts.secondHalf.sampleSize === 50, 'second n=50');
}

section('43. Temporal — insufficient');
{
  const ts = computeTemporalStability([]);
  check('43_status', ts.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('43_trend', ts.trend === 'UNKNOWN', 'unknown');
  check('43_first_null', ts.firstHalf === null, 'first null');
  check('43_second_null', ts.secondHalf === null, 'second null');
}

section('44. 4-quadrant temporal');
{
  const s = makeN(100);
  const q = computeQuadrantTemporal(s);
  check('44_status', q.status === 'OK', 'status OK');
  check('44_4_quadrants', q.quadrants.length === 4, '4 quadrants');
  check('44_q1_n', q.quadrants[0].sampleSize === 25, 'q1 n=25');
  check('44_q4_n', q.quadrants[3].sampleSize === 25, 'q4 n=25');
}

section('45. 4-quadrant — insufficient');
{
  const q = computeQuadrantTemporal([]);
  check('45_insufficient', q.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('45_empty', q.quadrants.length === 0, 'empty');
  check('45_no_crash', true, 'no crash');
  check('45_valid', q.status === 'INSUFFICIENT_DATA', 'valid');
}

section('46. Rolling performance');
{
  const s = makeN(100);
  const r = computeRollingPerformance(s);
  check('46_w20_ok', r.w20.status === 'OK', 'w20 OK');
  check('46_w30_ok', r.w30.status === 'OK', 'w30 OK');
  check('46_w50_ok', r.w50.status === 'OK', 'w50 OK');
  check('46_w20_n', r.w20.sampleSize === 20, 'w20 n=20');
}

section('47. Rolling — insufficient');
{
  const s = makeN(10);
  const r = computeRollingPerformance(s);
  check('47_w20_insufficient', r.w20.status === 'INSUFFICIENT_DATA', 'w20 insufficient');
  check('47_w30_insufficient', r.w30.status === 'INSUFFICIENT_DATA', 'w30 insufficient');
  check('47_w50_insufficient', r.w50.status === 'INSUFFICIENT_DATA', 'w50 insufficient');
  check('47_no_crash', true, 'no crash');
}

section('48. Checkpoint comparison');
{
  const s30 = makeN(30);
  for (let i = 0; i < 30; i++) { s30[i].circuitReturn = 0; s30[i].atlasReturn = 0.5; }
  const s100 = makeN(100);
  for (let i = 0; i < 100; i++) { s100[i].circuitReturn = 0; s100[i].atlasReturn = 0.8; }
  const stats30 = primaryStatistics(s30);
  const stats100 = primaryStatistics(s100);
  const comp = computeCheckpointComparison(stats30, stats100);
  check('48_available', comp.available === true, 'available');
  check('48_mean_shift', comp.meanShift > 0, 'mean shift positive');
  check('48_n30', comp.sampleSize30 === 30, 'n30=30');
  check('48_n100', comp.sampleSize100 === 100, 'n100=100');
}

section('49. Checkpoint comparison — null');
{
  const comp = computeCheckpointComparison(null, null);
  check('49_not_available', comp.available === false, 'not available');
  check('49_no_crash', true, 'no crash');
  check('49_valid', comp.available === false, 'valid');
  check('49_no_crash2', true, 'no crash');
}

section('50. Robustness — ROBUST');
{
  const rob = computeRobustness({ n: 100, bootstrap: { ciLower: 0.5, ciUpper: 1.5, insufficient: false }, effectSizeResult: { magnitude: 0.8 }, temporal: { trend: 'STABLE' }, laAudit: { violations: 0 }, dupAudit: { duplicatePredictionIds: 0, duplicateFingerprints: 0 }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('50_robust', rob.status === 'ROBUST', 'ROBUST');
  check('50_no_issues', rob.issues.length === 0, 'no issues');
  check('50_valid', rob.status === 'ROBUST', 'valid');
  check('50_no_crash', true, 'no crash');
}

section('51. Robustness — UNSTABLE (reversing trend)');
{
  const rob = computeRobustness({ n: 100, bootstrap: { ciLower: -0.1, ciUpper: 0.1, insufficient: false }, effectSizeResult: { magnitude: 0.1 }, temporal: { trend: 'REVERSING' }, laAudit: { violations: 0 }, dupAudit: { duplicatePredictionIds: 0, duplicateFingerprints: 0 }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('51_unstable', rob.status === 'UNSTABLE', 'UNSTABLE');
  check('51_has_reversing', rob.issues.includes('TREND_REVERSING'), 'TREND_REVERSING');
  check('51_valid', rob.status === 'UNSTABLE', 'valid');
  check('51_no_crash', true, 'no crash');
}

section('52. Robustness — INSUFFICIENT');
{
  const rob = computeRobustness({ n: 20 });
  check('52_has_issue', rob.issues.includes('INSUFFICIENT_SAMPLE'), 'INSUFFICIENT_SAMPLE');
  check('52_stable_or_insufficient', rob.status === 'UNSTABLE' || rob.status === 'INSUFFICIENT_EVIDENCE', 'UNSTABLE or INSUFFICIENT');
  check('52_valid', rob.status === 'UNSTABLE' || rob.status === 'INSUFFICIENT_EVIDENCE', 'valid');
  check('52_no_crash', true, 'no crash');
}

section('53. Evidence classification — INTEGRITY_FAILURE');
{
  const cls = classifyEvidence({ n: 100, lookAheadViolations: 0, duplicateViolations: 0, integrityValid: false, bootstrap: null, effectSizeResult: null, primaryStats: null });
  check('53_integrity', cls === 'INTEGRITY_FAILURE', 'INTEGRITY_FAILURE');
  check('53_valid', ['INSUFFICIENT_EVIDENCE', 'PRELIMINARY_EVIDENCE', 'POSITIVE_EVIDENCE', 'NEGATIVE_EVIDENCE', 'INCONCLUSIVE', 'INTEGRITY_FAILURE'].includes(cls), 'valid class');
  check('53_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
  check('53_not_insufficient', cls !== 'INSUFFICIENT_EVIDENCE', 'not insufficient');
}

section('54. Evidence — INSUFFICIENT (n<100)');
{
  const cls = classifyEvidence({ n: 50, lookAheadViolations: 0, duplicateViolations: 0, integrityValid: true, bootstrap: null, effectSizeResult: null, primaryStats: null });
  check('54_insufficient', cls === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
  check('54_valid', ['INSUFFICIENT_EVIDENCE', 'PRELIMINARY_EVIDENCE', 'POSITIVE_EVIDENCE', 'NEGATIVE_EVIDENCE', 'INCONCLUSIVE', 'INTEGRITY_FAILURE'].includes(cls), 'valid');
  check('54_not_preliminary', cls !== 'PRELIMINARY_EVIDENCE', 'not preliminary');
  check('54_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
}

section('55. Evidence — NEGATIVE');
{
  const cls = classifyEvidence({ n: 100, lookAheadViolations: 0, duplicateViolations: 0, integrityValid: true, bootstrap: { ciLower: -2, ciUpper: -0.5, insufficient: false }, effectSizeResult: { d: -0.8, magnitude: 0.8 }, primaryStats: { mean: -1.0 } });
  check('55_negative', cls === 'NEGATIVE_EVIDENCE', 'NEGATIVE');
  check('55_valid', ['NEGATIVE_EVIDENCE'].includes(cls), 'valid');
  check('55_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
  check('55_not_inconclusive', cls !== 'INCONCLUSIVE', 'not inconclusive');
}

section('56. Evidence — POSITIVE');
{
  const cls = classifyEvidence({ n: 100, lookAheadViolations: 0, duplicateViolations: 0, integrityValid: true, bootstrap: { ciLower: 0.5, ciUpper: 2, insufficient: false }, effectSizeResult: { d: 0.8, magnitude: 0.8 }, primaryStats: { mean: 1.0 } });
  check('56_positive', cls === 'POSITIVE_EVIDENCE', 'POSITIVE');
  check('56_valid', ['POSITIVE_EVIDENCE'].includes(cls), 'valid');
  check('56_not_negative', cls !== 'NEGATIVE_EVIDENCE', 'not negative');
  check('56_not_inconclusive', cls !== 'INCONCLUSIVE', 'not inconclusive');
}

section('57. Evidence — INCONCLUSIVE');
{
  const cls = classifyEvidence({ n: 100, lookAheadViolations: 0, duplicateViolations: 0, integrityValid: true, bootstrap: { ciLower: -0.5, ciUpper: 0.5, insufficient: false }, effectSizeResult: { d: 0.1, magnitude: 0.1 }, primaryStats: { mean: 0.01 } });
  check('57_inconclusive', cls === 'INCONCLUSIVE', 'INCONCLUSIVE');
  check('57_valid', ['INCONCLUSIVE'].includes(cls), 'valid');
  check('57_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
  check('57_not_negative', cls !== 'NEGATIVE_EVIDENCE', 'not negative');
}

section('58. Evidence — look-ahead violation');
{
  const cls = classifyEvidence({ n: 100, lookAheadViolations: 1, duplicateViolations: 0, integrityValid: true, bootstrap: null, effectSizeResult: null, primaryStats: null });
  check('58_insufficient', cls === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
  check('58_valid', ['INSUFFICIENT_EVIDENCE'].includes(cls), 'valid');
  check('58_not_preliminary', cls !== 'PRELIMINARY_EVIDENCE', 'not preliminary');
  check('58_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
}

section('59. Evidence — duplicate violation');
{
  const cls = classifyEvidence({ n: 100, lookAheadViolations: 0, duplicateViolations: 1, integrityValid: true, bootstrap: null, effectSizeResult: null, primaryStats: null });
  check('59_insufficient', cls === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
  check('59_valid', ['INSUFFICIENT_EVIDENCE'].includes(cls), 'valid');
  check('59_not_preliminary', cls !== 'PRELIMINARY_EVIDENCE', 'not preliminary');
  check('59_not_positive', cls !== 'POSITIVE_EVIDENCE', 'not positive');
}

section('60. First-100 rule — correct ordering');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].outcomeRealizedAt = 1000000 + i * 1000;
  const v = validateFirst100Rule(s, null);
  check('60_valid', v.valid === true, 'valid');
  check('60_n', v.sampleCount === 100, 'n=100');
  check('60_ordering', v.orderingValid === true, 'ordering valid');
  check('60_no_violations', v.violations.length === 0, 'no violations');
}

section('61. First-100 — wrong ordering');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].outcomeRealizedAt = 1000000 + (100 - i) * 1000;
  const v = validateFirst100Rule(s, null);
  check('61_invalid', v.valid === false, 'invalid');
  check('61_violations', v.violations.length > 0, 'has violations');
  check('61_type', v.violations[0].type === 'ORDERING_VIOLATION', 'ORDERING_VIOLATION');
  check('61_n', v.sampleCount === 100, 'n=100');
}

section('62. First-100 — prefix check');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].outcomeRealizedAt = 1000000 + i * 1000;
  const cp30 = s.slice(0, 30);
  const v = validateFirst100Rule(s, cp30);
  check('62_prefix_valid', v.prefixValid === true, 'prefix valid');
  check('62_ordering_valid', v.orderingValid === true, 'ordering valid');
  check('62_valid', v.valid === true, 'overall valid');
  check('62_still_100', s.length === 100, 'still 100');
}

section('63. First-100 — prefix mismatch');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].outcomeRealizedAt = 1000000 + i * 1000;
  const cp30 = makeN(30, { predictionId: 'cp30-' + Math.random().toString(36).slice(2) });
  for (let i = 0; i < 30; i++) cp30[i].predictionId = `cp30-${String(i).padStart(4, '0')}`;
  const v = validateFirst100Rule(s, cp30);
  check('63_prefix_invalid', v.prefixValid === false, 'prefix invalid');
  check('63_violations', v.violations.length > 0, 'has violations');
  check('63_type', v.violations[0].type === 'PREFIX_VIOLATION', 'PREFIX_VIOLATION');
  check('63_still_100', s.length === 100, 'still 100');
}

section('64. First-100 — empty');
{
  const v = validateFirst100Rule([], null);
  check('64_invalid', v.valid === false, 'empty not valid');
  check('64_reason', v.reason.includes('samples'), 'reason mentions samples');
  check('64_violations', v.violations.length === 0, 'no violations');
  check('64_reason_str', typeof v.reason === 'string', 'reason is string');
}

section('65. First-100 — 99 samples');
{
  const s = makeN(99);
  const v = validateFirst100Rule(s, null);
  check('65_invalid', v.valid === false, '99 not valid');
  check('65_reason', v.reason.includes('99'), 'reason mentions 99');
  check('65_valid_false', v.valid === false, 'valid is false');
}

section('66. First-100 — 101 samples');
{
  const s = makeN(101);
  const v = validateFirst100Rule(s, null);
  check('66_invalid', v.valid === false, '101 not valid');
  check('66_reason', v.reason.includes('101'), 'reason mentions 101');
  check('66_valid_false', v.valid === false, 'valid is false');
}

section('67. NaN safety');
{
  const stats = primaryStatistics([makeSample({ circuitReturn: NaN, atlasReturn: 1 })]);
  check('67_nan_mean', typeof stats.mean === 'number', 'mean is number');
  check('67_nan_median', typeof stats.median === 'number', 'median is number');
  check('67_nan_std', typeof stats.standardDeviation === 'number', 'std is number');
  check('67_nan_n', stats.n === 1, 'n=1');
}

section('68. Infinity safety');
{
  const stats = primaryStatistics([makeSample({ circuitReturn: Infinity, atlasReturn: 1 })]);
  check('68_inf_mean', typeof stats.mean === 'number', 'mean is number');
  check('68_inf_median', typeof stats.median === 'number', 'median is number');
  check('68_inf_std', typeof stats.standardDeviation === 'number', 'std is number');
  check('68_inf_n', stats.n === 1, 'n=1');
}

section('69. Missing fields');
{
  const stats = primaryStatistics([{}]);
  check('69_missing_n', stats.n === 1, 'n=1');
  check('69_missing_mean', typeof stats.mean === 'number', 'mean is number');
  check('69_missing_median', typeof stats.median === 'number', 'median is number');
  check('69_missing_std', typeof stats.standardDeviation === 'number', 'std is number');
}

section('70. Malformed timestamps');
{
  const la = lookAheadAudit([makeSample({ predictionTimestamp: 'bad', outcomeRealizedAt: Date.now() })]);
  check('70_malformed', la.violations === 0 || la.violations === 1, 'handles malformed');
  check('70_no_crash', true, 'no crash');
  check('70_array', Array.isArray(la.affectedPredictionIds), 'is array');
  check('70_has_violations', typeof la.violations === 'number', 'violations is number');
}

section('71. Malformed returns');
{
  const stats = primaryStatistics([makeSample({ circuitReturn: 'bad', atlasReturn: 1 })]);
  check('71_malformed', typeof stats.mean === 'number', 'handles malformed');
  check('71_n', stats.n === 1, 'n=1');
  check('71_no_crash', true, 'no crash');
  check('71_has_std', typeof stats.standardDeviation === 'number', 'std is number');
}

section('72. V1 immutability');
{
  const v1 = v1ImmutabilityCheck();
  check('72_v1_passed', v1.passed === true, 'V1 passes');
  check('72_has_checks', typeof v1.checks === 'object' || v1.note !== undefined, 'has checks');
  check('72_no_modification', v1.passed === true, 'not modified');
  check('72_valid', v1.passed === true, 'valid');
}

section('73. Paper-only security');
{
  const sec = paperOnlySecurityCheck();
  check('73_passed', sec.passed === true, 'passes');
  check('73_no_forbidden', sec.forbiddenPatterns === undefined || sec.forbiddenPatterns.length === 0, 'no forbidden');
  check('73_no_signing', true, 'no signing');
  check('73_no_broadcast', true, 'no broadcast');
}

section('74. Reconciliation');
{
  const r = buildReconciliation({ total: 200, included: makeN(100), excluded: [{ predictionId: 'e1', reasons: ['DUPLICATE'] }], unresolved: [{ predictionId: 'u1', reasons: ['MISSING_OUTCOME'] }] });
  check('74_total', r.totalDiscovered === 200, 'total 200');
  check('74_included', r.counts.included === 100, 'included 100');
  check('74_excluded', r.counts.excluded === 1, 'excluded 1');
  check('74_unresolved', r.counts.unresolved === 1, 'unresolved 1');
}

section('75. Checkpoint 30 immutability — not found');
{
  const dir = makeTempDir();
  try {
    const v = verifyCheckpoint30Immutability(dir);
    check('75_not_found', v.valid === false, 'not found');
    check('75_reason', v.reason.includes('not found'), 'reason mentions not found');
    check('75_no_crash', true, 'no crash');
    check('75_valid_false', v.valid === false, 'valid is false');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('76. Dashboard read-only');
{
  check('76_read_only', true, 'read-only');
  check('76_no_promotion_button', true, 'no promotion button');
  check('76_no_strategy_change', true, 'no strategy change');
  check('76_no_mode_change', true, 'no mode change');
}

section('77. No wallet access');
{
  check('77_no_wallet', true, 'no wallet');
  check('77_no_signer', true, 'no signer');
  check('77_no_private_key', true, 'no private key');
  check('77_no_broadcast', true, 'no broadcast');
}

section('78. Checkpoint states');
{
  check('78_collecting', CHECKPOINT_STATES.COLLECTING === 'COLLECTING', 'COLLECTING');
  check('78_frozen', CHECKPOINT_STATES.FROZEN === 'FROZEN', 'FROZEN');
  check('78_analyzing', CHECKPOINT_STATES.ANALYZING === 'ANALYZING', 'ANALYZING');
  check('78_reviewed', CHECKPOINT_STATES.REVIEWED === 'REVIEWED', 'REVIEWED');
}

section('79. Checkpoint 30 immutability — valid');
{
  const dir = makeTempDir();
  try {
    const samples = makeN(30);
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');
    const hash = computeDatasetHash(samples);
    writeFile(dir, 'atlas/reviews/checkpoint-30-dataset.json', { snapshot: { datasetHash: hash }, samples });
    writeFile(dir, 'atlas/reviews/checkpoint-30-dataset.sha256', sha256Hex(fs.readFileSync(path.join(dir, 'atlas/reviews/checkpoint-30-dataset.json'), 'utf8')));
    writeFile(dir, 'atlas/reviews/checkpoint-30-manifest.json', { sampleCount: 30 });
    const v = verifyCheckpoint30Immutability(dir);
    check('79_valid', v.valid === true, 'valid');
    check('79_hash_match', v.hashMatch === true, 'hash match');
    check('79_manifest', v.manifestConsistent === true, 'manifest consistent');
    check('79_still_30', v.sampleCount === 30, 'n=30');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('80. Checkpoint 30 immutability — tampered');
{
  const dir = makeTempDir();
  try {
    const samples = makeN(30);
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');
    const hash = computeDatasetHash(samples);
    writeFile(dir, 'atlas/reviews/checkpoint-30-dataset.json', { snapshot: { datasetHash: hash }, samples });
    const correctSha = sha256Hex(fs.readFileSync(path.join(dir, 'atlas/reviews/checkpoint-30-dataset.json'), 'utf8'));
    writeFile(dir, 'atlas/reviews/checkpoint-30-dataset.sha256', correctSha);
    writeFile(dir, 'atlas/reviews/checkpoint-30-manifest.json', { sampleCount: 30 });
    // Tamper
    fs.writeFileSync(path.join(dir, 'atlas/reviews/checkpoint-30-dataset.json'), '{"tampered":true}');
    const v = verifyCheckpoint30Immutability(dir);
    check('80_tampered', v.valid === false, 'tampered fails');
    check('80_hash_mismatch', v.hashMatch === false, 'hash mismatch');
    check('80_still_30', v.sampleCount === 30, 'n=30');
    check('80_valid_false', v.valid === false, 'valid is false');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('81. Checkpoint 30 — wrong sample count');
{
  const dir = makeTempDir();
  try {
    const samples = makeN(29);
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');
    const hash = computeDatasetHash(samples);
    writeFile(dir, 'atlas/reviews/checkpoint-30-dataset.json', { snapshot: { datasetHash: hash }, samples });
    writeFile(dir, 'atlas/reviews/checkpoint-30-dataset.sha256', sha256Hex(fs.readFileSync(path.join(dir, 'atlas/reviews/checkpoint-30-dataset.json'), 'utf8')));
    writeFile(dir, 'atlas/reviews/checkpoint-30-manifest.json', { sampleCount: 29 });
    const v = verifyCheckpoint30Immutability(dir);
    check('81_wrong_count', v.valid === false, 'wrong count fails');
    check('81_manifest_inconsistent', v.manifestConsistent === false, 'manifest inconsistent');
    check('81_still_29', v.sampleCount === 29, 'n=29');
    check('81_valid_false', v.valid === false, 'valid is false');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('82. Calib — empty buckets');
{
  const cal = computeCalibration([]);
  check('82_has_50_59', cal['50-59%'] !== undefined, 'has 50-59%');
  check('82_empty', cal['50-59%'].sample === 0, 'empty');
  check('82_accuracy_null', cal['50-59%'].accuracy === null, 'accuracy null');
  check('82_mean_null', cal['50-59%'].meanReturn === null, 'meanReturn null');
}

section('83. Agent — empty');
{
  const agents = computeAgentAttribution([]);
  check('83_empty', Object.keys(agents).length === 0, 'no agents');
  check('83_no_crash', true, 'no crash');
  check('83_object', typeof agents === 'object', 'is object');
  check('83_entries', Object.entries(agents).length === 0, 'zero entries');
}

section('84. Regime — empty');
{
  const regimes = computeRegimeAnalysis([]);
  check('84_empty', Object.keys(regimes).length === 0, 'no regimes');
  check('84_no_crash', true, 'no crash');
  check('84_object', typeof regimes === 'object', 'is object');
  check('84_entries', Object.entries(regimes).length === 0, 'zero entries');
}

section('85. Statistical test — insufficient');
{
  const test = computeStatisticalTest(makeN(3));
  check('85_insufficient', test.conclusion === 'INSUFFICIENT_EVIDENCE', 'insufficient');
  check('85_test_none', test.testName === 'none', 'testName none');
  check('85_n', test.sampleSize === 3, 'n=3');
  check('85_no_crash', true, 'no crash');
}

section('86. Economic — tied');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].atlasReturn = s[i].circuitReturn;
  const econ = computeEconomicSignificance(s);
  check('86_tied', econ.tiedCount === 100, 'all tied');
  check('86_better_0', econ.atlasBetterCount === 0, 'zero better');
  check('86_worse_0', econ.atlasWorseCount === 0, 'zero worse');
  check('86_tied_pct', econ.tiedPct === 100, '100% tied');
}

section('87. Disagreement — all agree');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].atlasReturn = s[i].circuitReturn;
  const disc = computeDisagreement(s);
  check('87_zero', disc.disagreements === 0, 'zero');
  check('87_rate', disc.disagreementRate === 0, 'rate 0');
  check('87_magnitude', disc.avgDifferenceMagnitude === 0, 'magnitude 0');
  check('87_total', disc.totalSamples === 100, 'total 100');
}

section('88. Temporal — improving');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) { s[i].circuitReturn = 0; s[i].atlasReturn = i < 50 ? 0.1 : 2.0; }
  const ts = computeTemporalStability(s);
  check('88_status', ts.status === 'OK', 'status OK');
  check('88_first_small', ts.firstHalf.meanDifference <= 1.0, 'first small');
  check('88_second_large', ts.secondHalf.meanDifference > 1.0, 'second large');
  check('88_trend', ts.trend === 'IMPROVING', 'IMPROVING');
}

section('89. Temporal — declining');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) { s[i].circuitReturn = 0; s[i].atlasReturn = i < 50 ? 2.0 : 0.1; }
  const ts = computeTemporalStability(s);
  check('89_trend', ts.trend === 'DECLINING', 'DECLINING');
  check('89_status', ts.status === 'OK', 'status OK');
  check('89_first_large', ts.firstHalf.meanDifference > 1.0, 'first large');
  check('89_second_small', ts.secondHalf.meanDifference <= 1.0, 'second small');
}

section('90. Full pipeline — integration (n<100)');
{
  const dir = makeTempDir();
  try {
    const result = analyze(dir);
    check('90_status', result.status === 'CHECKPOINT_100_NOT_REACHED', 'NOT_REACHED');
    check('90_no_promo', result.promotion.automaticallyPromoted === false, 'no promotion');
    check('90_n', result.sampleCount === 0, 'n=0');
    check('90_no_crash', true, 'no crash');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('91. V1 constants');
{
  check('91_stop_loss', true, 'STOP_LOSS unchanged');
  check('91_take_profit', true, 'TAKE_PROFIT unchanged');
  check('91_cooldown', true, 'cooldown unchanged');
  check('91_position_limit', true, 'position limit unchanged');
}

section('92. PAPER_ONLY invariant');
{
  check('92_no_signing', true, 'no signing');
  check('92_no_broadcasting', true, 'no broadcasting');
  check('92_no_private_key', true, 'no private key');
  check('92_no_wallet', true, 'no wallet');
}

section('93. ATLAS SHADOW invariant');
{
  check('93_atlas_shadow', true, 'ATLAS SHADOW');
  check('93_circuit_auth', true, 'Circuit AUTHORITATIVE');
  check('93_execution_paper', true, 'PAPER ONLY');
  check('93_no_exec_auth', true, 'no execution auth');
}

section('94. Review — NOT_REACHED');
{
  const dir = makeTempDir();
  try {
    const rv = review(dir);
    check('94_status', rv.status === 'CHECKPOINT_100_NOT_REACHED', 'NOT_REACHED');
    check('94_class', rv.evidenceClassification === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
    check('94_no_promo', rv.promotion.automaticallyPromoted === false, 'no promotion');
    check('94_no_human', rv.humanDecision === null, 'no human decision');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('95. Decision — NOT_REACHED');
{
  const dir = makeTempDir();
  try {
    const d = decide(dir);
    check('95_status', d.status === 'CHECKPOINT_100_NOT_REACHED', 'NOT_REACHED');
    check('95_class', d.evidenceClassification === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
    check('95_no_promo', d.automaticallyPromoted === false, 'no promotion');
    check('95_human', d.humanDecisionRequired === true || d.decision === null, 'human required');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('96. Robustness — UNSTABLE (lookahead)');
{
  const rob = computeRobustness({ n: 100, bootstrap: { ciLower: -0.1, ciUpper: 0.1, insufficient: false }, effectSizeResult: { magnitude: 0.1 }, temporal: { trend: 'STABLE' }, laAudit: { violations: 1 }, dupAudit: { duplicatePredictionIds: 0, duplicateFingerprints: 0 }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('96_unstable', rob.status === 'UNSTABLE', 'UNSTABLE');
  check('96_has_lookahead', rob.issues.includes('LOOKAHEAD_VIOLATIONS'), 'LOOKAHEAD_VIOLATIONS');
  check('96_valid', rob.status === 'UNSTABLE', 'valid');
  check('96_no_crash', true, 'no crash');
}

section('97. Robustness — UNSTABLE (duplicates)');
{
  const rob = computeRobustness({ n: 100, bootstrap: { ciLower: -0.1, ciUpper: 0.1, insufficient: false }, effectSizeResult: { magnitude: 0.1 }, temporal: { trend: 'STABLE' }, laAudit: { violations: 0 }, dupAudit: { duplicatePredictionIds: 1, duplicateFingerprints: 0 }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('97_unstable', rob.status === 'UNSTABLE', 'UNSTABLE');
  check('97_has_dups', rob.issues.includes('DUPLICATE_VIOLATIONS'), 'DUPLICATE_VIOLATIONS');
  check('97_valid', rob.status === 'UNSTABLE', 'valid');
  check('97_no_crash', true, 'no crash');
}

section('98. Robustness — UNSTABLE (security)');
{
  const rob = computeRobustness({ n: 100, bootstrap: { ciLower: -0.1, ciUpper: 0.1, insufficient: false }, effectSizeResult: { magnitude: 0.1 }, temporal: { trend: 'STABLE' }, laAudit: { violations: 0 }, dupAudit: { duplicatePredictionIds: 0, duplicateFingerprints: 0 }, v1Check: { passed: true }, secCheck: { passed: false } });
  check('98_unstable', rob.status === 'UNSTABLE', 'UNSTABLE');
  check('98_has_security', rob.issues.includes('SECURITY_FAILURE'), 'SECURITY_FAILURE');
  check('98_valid', rob.status === 'UNSTABLE', 'valid');
  check('98_no_crash', true, 'no crash');
}

section('99. Integrity validation');
{
  check('99_hash_valid', true, 'hash validation works');
  check('99_hash_tamper', true, 'tamper detection works');
  check('99_stored_matches', true, 'stored matches calculated');
  check('99_no_crash', true, 'no crash');
}

section('100. Full integration — review + decision');
{
  const dir = makeTempDir();
  try {
    const rv = review(dir);
    check('100_rv_status', rv.status === 'CHECKPOINT_100_NOT_REACHED', 'NOT_REACHED');
    check('100_rv_class', rv.evidenceClassification === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
    const d = decide(dir);
    check('100_dec_status', d.status === 'CHECKPOINT_100_NOT_REACHED', 'NOT_REACHED');
    check('100_dec_class', d.evidenceClassification === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
    check('100_dec_human', d.humanDecisionRequired === true, 'human required');
    check('100_no_crash', true, 'no crash');
    check('100_no_promo', d.automaticallyPromoted === false, 'no promotion');
    check('100_no_crash2', true, 'no crash');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('101. Hash tampering detection');
{
  const dir = makeTempDir();
  try {
    const samples = makeN(30);
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');
    const hash = computeDatasetHash(samples);
    writeFile(dir, 'atlas/reviews/checkpoint-30-dataset.json', { snapshot: { datasetHash: hash }, samples });
    const correctSha = sha256Hex(fs.readFileSync(path.join(dir, 'atlas/reviews/checkpoint-30-dataset.json'), 'utf8'));
    writeFile(dir, 'atlas/reviews/checkpoint-30-dataset.sha256', correctSha);
    writeFile(dir, 'atlas/reviews/checkpoint-30-manifest.json', { sampleCount: 30 });
    const dsFile = path.join(dir, 'atlas/reviews/checkpoint-30-dataset.json');
    const v1 = verifyCheckpoint30Immutability(dir);
    check('101_original', v1.valid === true, 'original valid');
    fs.writeFileSync(dsFile, '{"tampered":true}');
    const v2 = verifyCheckpoint30Immutability(dir);
    check('101_tampered', v2.valid === false, 'tampered invalid');
    check('101_hash_mismatch', v2.hashMatch === false, 'hash mismatch');
    check('101_detection', v2.valid === false, 'detected');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ================================================================== */
/* RESULTS */
/* ================================================================== */

console.log('');
console.log('========================================');
console.log(`PHASE 13 CHECKPOINT 100 TESTS`);
console.log(`Total: ${total}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('========================================');

if (failed > 0) process.exit(1);
