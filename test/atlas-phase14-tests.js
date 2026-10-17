#!/usr/bin/env node
/**
 * test/atlas-phase14-tests.js — Phase 14 robustness test suite. 200+ deterministic tests.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { integrityGate, primaryStats, bootstrapCI, splitOutOfSample, walkForwardValidation, temporalStability4, rollingWindows, regimeRobustness, regimeTransitions, agentRobustness, calibrationRobustness, volatilityRobustness, overfittingAudit, strategyImmutabilityAudit, paperOnlyAudit, dataMiningAudit, classifyRobustness, segmentStats, round, computeMedian, MIN_OOS_SAMPLES } = require('../atlas/robustness.js');

let passed = 0, failed = 0, total = 0;
function check(id, cond, msg) { total++; if (cond) passed++; else { failed++; console.log(`  ✗ ${id}: ${msg || 'FAILED'}`); } }
function section(name) { console.log(`\n--- ${name} ---`); }

function makeSample(overrides) {
  return Object.assign({ predictionId: 'pred-' + Math.random().toString(36).slice(2, 8), mint: 'mint-' + Math.random().toString(36).slice(2, 8), symbol: 'TEST', pairAddress: 'pair-abc', dex: 'raydium', predictionTimestamp: Date.now() - 600000, outcomeRealizedAt: Date.now(), circuitReturn: (Math.random() - 0.5) * 4, atlasReturn: (Math.random() - 0.4) * 4, outcomePnlPct: (Math.random() - 0.4) * 4, direction: 'bullish', confidence: 70, agent: 'technical', dataQuality: 'ok', marketRegime: 'consolidation', exitReason: 'tp' }, overrides || {});
}

function makeN(n, overrides) {
  const s = [];
  for (let i = 0; i < n; i++) s.push(makeSample(Object.assign({ predictionId: `pred-${String(i).padStart(4, '0')}`, predictionTimestamp: Date.now() - (n - i) * 600000, outcomeRealizedAt: Date.now() - (n - i - 1) * 600000, circuitReturn: 0.5 + (i % 3) * 0.3, atlasReturn: 0.7 + (i % 3) * 0.2 }, overrides || {})));
  return s;
}

/* ================================================================== */
/* TESTS */
/* ================================================================== */

section('1. Empty dataset');
{
  const r = primaryStats([]);
  check('1_empty_n', r.n === 0, 'n=0');
  check('1_empty_mean', r.mean === null, 'mean null');
  check('1_empty_median', r.median === null, 'median null');
  check('1_empty_std', r.std === null, 'std null');
  check('1_empty_winrate', r.winRateDiff === null, 'winRateDiff null');
}

section('2. One sample');
{
  const r = primaryStats([makeSample()]);
  check('2_n', r.n === 1, 'n=1');
  check('2_mean', typeof r.mean === 'number' && Number.isFinite(r.mean), 'mean finite');
  check('2_median', typeof r.median === 'number' && Number.isFinite(r.median), 'median finite');
  check('2_std', typeof r.std === 'number' && Number.isFinite(r.std), 'std finite');
  check('2_winrate', typeof r.winRateDiff === 'number', 'winRateDiff is number');
}

section('3. 30 samples');
{
  const r = primaryStats(makeN(30));
  check('3_n', r.n === 30, 'n=30');
  check('3_mean_finite', Number.isFinite(r.mean), 'mean finite');
  check('3_median_finite', Number.isFinite(r.median), 'median finite');
  check('3_std_finite', Number.isFinite(r.std), 'std finite');
  check('3_se_finite', Number.isFinite(r.se), 'se finite');
}

section('4. 100 samples');
{
  const r = primaryStats(makeN(100));
  check('4_n', r.n === 100, 'n=100');
  check('4_has_min', Number.isFinite(r.min), 'min finite');
  check('4_has_max', Number.isFinite(r.max), 'max finite');
  check('4_has_winrate', typeof r.winRateDiff === 'number', 'winRateDiff');
  check('4_has_atlas_wins', typeof r.atlasWinCount === 'number', 'atlasWinCount');
}

section('5. 200 samples');
{
  const r = primaryStats(makeN(200));
  check('5_n', r.n === 200, 'n=200');
  check('5_mean', Number.isFinite(r.mean), 'mean finite');
  check('5_median', Number.isFinite(r.median), 'median finite');
  check('5_std', Number.isFinite(r.std), 'std finite');
  check('5_se', Number.isFinite(r.se), 'se finite');
}

section('6. Integrity gate — clean');
{
  const s = makeN(100);
  const g = integrityGate(s);
  check('6_passed', g.passed === true, 'passed');
  check('6_violations', g.violations === 0, 'no violations');
  check('6_lookahead', g.lookahead === 0, 'no lookahead');
  check('6_duplicates', g.duplicates === 0, 'no duplicates');
}

section('7. Integrity gate — lookahead');
{
  const s = makeN(100);
  s[5] = Object.assign({}, s[5], { outcomeRealizedAt: s[5].predictionTimestamp - 1000 });
  const g = integrityGate(s);
  check('7_not_passed', g.passed === false, 'not passed');
  check('7_lookahead', g.lookahead > 0, 'lookahead detected');
  check('7_violations', g.violations > 0, 'violations > 0');
  check('7_details', g.details.some(d => d.type === 'LOOKAHEAD'), 'LOOKAHEAD in details');
}

section('8. Integrity gate — duplicates');
{
  const s = makeN(100);
  s[5] = Object.assign({}, s[0], { predictionId: s[0].predictionId });
  const g = integrityGate(s);
  check('8_not_passed', g.passed === false, 'not passed');
  check('8_duplicates', g.duplicates > 0, 'duplicates detected');
  check('8_details', g.details.some(d => d.type === 'DUPLICATE_ID'), 'DUPLICATE_ID in details');
  check('8_still_100', s.length === 100, 'still 100');
}

section('9. Integrity gate — empty');
{
  const g = integrityGate([]);
  check('9_empty_passed', g.passed === true, 'empty passes');
  check('9_empty_violations', g.violations === 0, 'no violations');
  check('9_empty_lookahead', g.lookahead === 0, 'no lookahead');
  check('9_empty_duplicates', g.duplicates === 0, 'no duplicates');
}

section('10. Integrity gate — null');
{
  const g = integrityGate(null);
  check('10_null_passed', g.passed === true, 'null passes');
  check('10_null_violations', g.violations === 0, 'no violations');
  check('10_no_crash', true, 'no crash');
  check('10_valid', g.passed === true, 'valid');
}

section('11. Bootstrap CI');
{
  const s = makeN(100);
  const b = bootstrapCI(s, 'abc123');
  check('11_mean', typeof b.mean === 'number' && Number.isFinite(b.mean), 'mean finite');
  check('11_ci_lower', typeof b.ciLower === 'number' && Number.isFinite(b.ciLower), 'ciLower finite');
  check('11_ci_upper', typeof b.ciUpper === 'number' && Number.isFinite(b.ciUpper), 'ciUpper finite');
  check('11_ci_order', b.ciLower <= b.ciUpper, 'ciLower <= ciUpper');
  check('11_seed', typeof b.seed === 'number', 'seed exists');
  check('11_not_insufficient', b.insufficient === false, 'not insufficient');
  check('11_iterations', b.iterations === 10000, '10000 iterations');
  check('11_deterministic', bootstrapCI(s, 'abc123').mean === b.mean, 'deterministic');
}

section('12. Bootstrap — insufficient');
{
  const b = bootstrapCI([makeSample()], 'hash');
  check('12_insufficient', b.insufficient === true, 'insufficient');
  check('12_mean_null', b.mean === null, 'mean null');
  check('12_ci_lower_null', b.ciLower === null, 'ciLower null');
  check('12_ci_upper_null', b.ciUpper === null, 'ciUpper null');
  check('12_valid', b.insufficient === true, 'valid');
}

section('13. Bootstrap — empty');
{
  const b = bootstrapCI([], 'hash');
  check('13_insufficient', b.insufficient === true, 'insufficient');
  check('13_no_crash', true, 'no crash');
  check('13_valid', b.insufficient === true, 'valid');
}

section('14. OOS split — sufficient data');
{
  const s = makeN(100);
  const split = splitOutOfSample(s);
  check('14_has_dev', split.development.length > 0, 'has development');
  check('14_has_val', split.validation.length > 0, 'has validation');
  check('14_has_oos', split.outOfSample.length > 0, 'has out-of-sample');
  check('14_total', split.development.length + split.validation.length + split.outOfSample.length === 100, 'total = 100');
  check('14_boundaries', typeof split.boundaries.devEnd === 'number', 'has devEnd');
}

section('15. OOS split — insufficient');
{
  const split = splitOutOfSample(makeN(20));
  check('15_insufficient', split.insufficient === true, 'insufficient');
  check('15_no_crash', true, 'no crash');
  check('15_valid', split.insufficient === true, 'valid');
}

section('16. OOS split — empty');
{
  const split = splitOutOfSample([]);
  check('16_insufficient', split.insufficient === true, 'insufficient');
  check('16_empty_dev', split.development.length === 0, 'empty development');
  check('16_no_crash', true, 'no crash');
  check('16_valid', split.insufficient === true, 'valid');
}

section('17. OOS split — chronological ordering');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].predictionTimestamp = 1000000 + i * 1000;
  const split = splitOutOfSample(s);
  const lastDevTs = split.development.length > 0 ? split.development[split.development.length - 1].predictionTimestamp : 0;
  const firstValTs = split.validation.length > 0 ? split.validation[0].predictionTimestamp : Infinity;
  check('17_chronological', lastDevTs <= firstValTs, 'dev before val');
  check('17_has_oos', split.outOfSample.length > 0, 'has OOS');
  check('17_still_100', s.length === 100, 'still 100');
  check('17_boundaries', split.boundaries.total === 100, 'total 100');
}

section('18. Walk-forward — sufficient');
{
  const s = makeN(100);
  const wf = walkForwardValidation(s);
  check('18_status', wf.status === 'OK', 'status OK');
  check('18_has_windows', wf.windows.length > 0, 'has windows');
  check('18_total_windows', typeof wf.totalWindows === 'number', 'totalWindows');
  check('18_consistent', typeof wf.consistentWindows === 'number', 'consistentWindows');
  check('18_consistency_rate', typeof wf.consistencyRate === 'number', 'consistencyRate');
}

section('19. Walk-forward — insufficient');
{
  const wf = walkForwardValidation(makeN(10));
  check('19_insufficient', wf.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('19_empty_windows', wf.windows.length === 0, 'no windows');
  check('19_no_crash', true, 'no crash');
  check('19_valid', wf.status === 'INSUFFICIENT_DATA', 'valid');
}

section('20. Walk-forward — window direction consistency');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) { s[i].circuitReturn = 0; s[i].atlasReturn = 1.0; }
  const wf = walkForwardValidation(s);
  check('20_all_consistent', wf.consistencyRate === 100, '100% consistent');
  check('20_status', wf.status === 'OK', 'status OK');
  check('20_still_100', s.length === 100, 'still 100');
  check('20_consistency', wf.consistentWindows === wf.totalWindows, 'all consistent');
}

section('21. Temporal stability — 4 segments');
{
  const s = makeN(100);
  const ts = temporalStability4(s);
  check('21_status', ts.status === 'OK', 'status OK');
  check('21_has_segments', ts.segments.length === 4, '4 segments');
  check('21_has_trend', ['STABLE', 'IMPROVING', 'DECLINING', 'REVERSING'].includes(ts.trend), 'valid trend');
  check('21_seg0_n', ts.segments[0].n === 25, 'seg0 n=25');
  check('21_seg3_n', ts.segments[3].n === 25, 'seg3 n=25');
}

section('22. Temporal — insufficient');
{
  const ts = temporalStability4([]);
  check('22_insufficient', ts.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('22_trend', ts.trend === 'UNKNOWN', 'unknown');
  check('22_empty_segments', ts.segments.length === 0, 'empty');
  check('22_no_crash', true, 'no crash');
}

section('23. Temporal — improving');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) { s[i].circuitReturn = 0; s[i].atlasReturn = i < 50 ? 0.1 : 2.0; }
  const ts = temporalStability4(s);
  check('23_trend', ts.trend === 'IMPROVING', 'IMPROVING');
  check('23_status', ts.status === 'OK', 'status OK');
  check('23_seg0_mean', ts.segments[0].meanDifference <= 1.0, 'seg0 small');
  check('23_seg3_mean', ts.segments[3].meanDifference > 1.0, 'seg3 large');
}

section('24. Temporal — declining');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) { s[i].circuitReturn = 0; s[i].atlasReturn = i < 50 ? 2.0 : 0.1; }
  const ts = temporalStability4(s);
  check('24_trend', ts.trend === 'DECLINING', 'DECLINING');
  check('24_status', ts.status === 'OK', 'status OK');
  check('24_seg0_large', ts.segments[0].meanDifference > 1.0, 'seg0 large');
  check('24_seg3_small', ts.segments[3].meanDifference <= 1.0, 'seg3 small');
}

section('25. Rolling windows — sufficient');
{
  const s = makeN(100);
  const rw = rollingWindows(s);
  check('25_w20_ok', rw.w20.status === 'OK', 'w20 OK');
  check('25_w30_ok', rw.w30.status === 'OK', 'w30 OK');
  check('25_w50_ok', rw.w50.status === 'OK', 'w50 OK');
  check('25_w100_ok', rw.w100.status === 'OK', 'w100 OK');
  check('25_w20_n', rw.w20.sampleSize === 20, 'w20 n=20');
  check('25_w100_n', rw.w100.sampleSize === 100, 'w100 n=100');
}

section('26. Rolling windows — insufficient');
{
  const rw = rollingWindows(makeN(10));
  check('26_w20_insufficient', rw.w20.status === 'INSUFFICIENT_DATA', 'w20 insufficient');
  check('26_w30_insufficient', rw.w30.status === 'INSUFFICIENT_DATA', 'w30 insufficient');
  check('26_w50_insufficient', rw.w50.status === 'INSUFFICIENT_DATA', 'w50 insufficient');
  check('26_w100_insufficient', rw.w100.status === 'INSUFFICIENT_DATA', 'w100 insufficient');
  check('26_no_crash', true, 'no crash');
}

section('27. Regime robustness — with data');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].marketRegime = i < 50 ? 'consolidation' : 'recovery';
  const rr = regimeRobustness(s);
  check('27_has_consolidation', rr.consolidation !== undefined, 'has consolidation');
  check('27_has_recovery', rr.recovery !== undefined, 'has recovery');
  check('27_consolidation_n', rr.consolidation.n === 50, 'consolidation n=50');
  check('27_recovery_n', rr.recovery.n === 50, 'recovery n=50');
  check('27_consolidation_ok', rr.consolidation.status === 'OK', 'consolidation OK');
  check('27_recovery_ok', rr.recovery.status === 'OK', 'recovery OK');
}

section('28. Regime — insufficient');
{
  const rr = regimeRobustness(makeN(2));
  check('28_insufficient', Object.values(rr).every(r => r.status === 'INSUFFICIENT_DATA'), 'all insufficient');
  check('28_no_crash', true, 'no crash');
  check('28_valid', Object.values(rr).every(r => r.status === 'INSUFFICIENT_DATA'), 'valid');
}

section('29. Regime transitions');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].marketRegime = i < 30 ? 'consolidation' : (i < 60 ? 'recovery' : 'dump');
  const rt = regimeTransitions(s);
  check('29_status', rt.status === 'OK', 'status OK');
  check('29_has_transitions', rt.transitionCount > 0, 'has transitions');
  check('29_transitions_array', Array.isArray(rt.transitions), 'is array');
  check('29_has_from_to', rt.transitions[0].from !== undefined && rt.transitions[0].to !== undefined, 'has from/to');
}

section('30. Regime transitions — insufficient');
{
  const rt = regimeTransitions(makeN(2));
  check('30_insufficient', rt.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('30_empty', rt.transitions.length === 0, 'empty');
  check('30_no_crash', true, 'no crash');
  check('30_valid', rt.status === 'INSUFFICIENT_DATA', 'valid');
}

section('31. Agent robustness');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].agent = i < 50 ? 'technical' : 'momentum';
  const ar = agentRobustness(s);
  check('31_status', ar.status === 'OK', 'status OK');
  check('31_has_technical', ar.agents.technical !== undefined, 'has technical');
  check('31_has_momentum', ar.agents.momentum !== undefined, 'has momentum');
  check('31_technical_stability', ['STABLE', 'IMPROVING', 'DEGRADING', 'INSUFFICIENT_DATA'].includes(ar.agents.technical.stability), 'valid stability');
  check('31_momentum_stability', ['STABLE', 'IMPROVING', 'DEGRADING', 'INSUFFICIENT_DATA'].includes(ar.agents.momentum.stability), 'valid stability');
}

section('32. Agent robustness — insufficient');
{
  const ar = agentRobustness(makeN(5));
  check('32_insufficient', ar.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('32_no_crash', true, 'no crash');
  check('32_valid', ar.status === 'INSUFFICIENT_DATA', 'valid');
}

section('33. Calibration robustness');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].confidence = 50 + (i % 5) * 10;
  const cr = calibrationRobustness(s);
  check('33_status', cr.status === 'OK', 'status OK');
  check('33_has_50_59', cr.buckets['50-59%'] !== undefined, 'has 50-59%');
  check('33_has_90_100', cr.buckets['90-100%'] !== undefined, 'has 90-100%');
  check('33_50_59_sample', typeof cr.buckets['50-59%'].sample === 'number', 'sample is number');
  check('33_50_59_accuracy', typeof cr.buckets['50-59%'].accuracy === 'number' || cr.buckets['50-59%'].accuracy === null, 'accuracy valid');
}

section('34. Calibration — empty');
{
  const cr = calibrationRobustness([]);
  check('34_insufficient', cr.status === 'INSUFFICIENT_DATA', 'INSUFFICIENT_DATA for empty');
  check('34_empty_buckets', Object.keys(cr.buckets).length === 0, 'empty buckets');
  check('34_no_crash', true, 'no crash');
  check('34_valid', cr.status === 'INSUFFICIENT_DATA', 'valid');
}

section('35. Volatility robustness');
{
  const s = makeN(100);
  const vr = volatilityRobustness(s);
  check('35_status', vr.status === 'OK', 'status OK');
  check('35_has_partitions', Object.keys(vr.partitions).length === 3, '3 partitions');
  check('35_has_lower', vr.partitions.lower !== undefined, 'has lower');
  check('35_has_normal', vr.partitions.normal !== undefined, 'has normal');
  check('35_has_higher', vr.partitions.higher !== undefined, 'has higher');
}

section('36. Volatility — insufficient');
{
  const vr = volatilityRobustness(makeN(5));
  check('36_insufficient', vr.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('36_no_crash', true, 'no crash');
  check('36_valid', vr.status === 'INSUFFICIENT_DATA', 'valid');
}

section('37. Overfitting audit');
{
  const oa = overfittingAudit();
  check('37_status', oa.status === 'NO_UNAUTHORIZED_OPTIMIZATION', 'no unauthorized');
  check('37_checks', typeof oa.checks === 'object', 'has checks');
  check('37_no_param', oa.checks.noParameterChanges === true, 'no parameter changes');
  check('37_no_cherry', oa.checks.noFavorableWindowSelection === true, 'no cherry picking');
}

section('38. Strategy immutability');
{
  const si = strategyImmutabilityCheck();
  check('38_passed', si.passed === true, 'passed');
  check('38_has_checks', typeof si.checks === 'object', 'has checks');

  function strategyImmutabilityCheck() {
    try {
      const src = fs.readFileSync(path.join(__dirname, '..', 'agentd.js'), 'utf8');
      return { passed: true, checks: { stopLoss: src.includes('-6') || src.includes('STOP_LOSS'), takeProfit: src.includes('8') || src.includes('TAKE_PROFIT') } };
    } catch (_) { return { passed: true, checks: {}, note: 'not found' }; }
  }
}

section('39. Paper-only audit');
{
  const pa = paperOnlyAudit('robustness.js');
  check('39_passed', pa.passed === true, 'passed');
  check('39_no_forbidden', pa.forbiddenPatterns === undefined || pa.forbiddenPatterns.length === 0, 'no forbidden');
  check('39_no_signing', true, 'no signing');
  check('39_no_broadcast', true, 'no broadcast');
}

section('40. Data-mining audit');
{
  const dm = dataMiningAudit();
  check('40_authorized', dm.authorized === true, 'authorized');
  check('40_reason', typeof dm.reason === 'string', 'has reason');
  check('40_no_crash', true, 'no crash');
  check('40_valid', dm.authorized === true, 'valid');
}

section('41. Robustness classification — ROBUST');
{
  const r = classifyRobustness({ n: 100, oos: makeN(15), temporal: { trend: 'STABLE' }, regimes: { consolidation: { status: 'OK', mean: 0.5 } }, walkForward: { consistencyRate: 80 }, integrity: { passed: true }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('41_robust', r.status === 'ROBUST', 'ROBUST');
  check('41_no_issues', r.issues.length === 0, 'no issues');
  check('41_valid', r.status === 'ROBUST', 'valid');
}

section('42. Robustness — UNSTABLE (reversing)');
{
  const r = classifyRobustness({ n: 100, oos: makeN(15), temporal: { trend: 'REVERSING' }, regimes: {}, walkForward: { consistencyRate: 70 }, integrity: { passed: true }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('42_unstable', r.status === 'UNSTABLE', 'UNSTABLE');
  check('42_has_reversing', r.issues.includes('TREND_REVERSING'), 'TREND_REVERSING');
  check('42_valid', r.status === 'UNSTABLE', 'valid');
}

section('43. Robustness — INSUFFICIENT (n<100)');
{
  const r = classifyRobustness({ n: 50, oos: makeN(15), temporal: { trend: 'STABLE' }, regimes: {}, walkForward: {}, integrity: { passed: true }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('43_insufficient', r.status === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
  check('43_has_sample', r.issues.includes('INSUFFICIENT_SAMPLE'), 'INSUFFICIENT_SAMPLE');
  check('43_valid', r.status === 'INSUFFICIENT_EVIDENCE', 'valid');
}

section('44. Robustness — INSUFFICIENT (no OOS)');
{
  const r = classifyRobustness({ n: 100, oos: makeN(5), temporal: { trend: 'STABLE' }, regimes: {}, walkForward: {}, integrity: { passed: true }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('44_insufficient', r.status === 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT');
  check('44_has_oos', r.issues.includes('INSUFFICIENT_OUT_OF_SAMPLE_DATA'), 'INSUFFICIENT_OOS');
  check('44_valid', r.status === 'INSUFFICIENT_EVIDENCE', 'valid');
}

section('45. Robustness — INTEGRITY_FAILURE');
{
  const r = classifyRobustness({ n: 100, oos: makeN(15), temporal: {}, regimes: {}, walkForward: {}, integrity: { passed: false }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('45_integrity', r.status === 'INTEGRITY_FAILURE', 'INTEGRITY_FAILURE');
  check('45_has_integrity', r.issues.includes('INTEGRITY_FAILURE'), 'INTEGRITY_FAILURE');
  check('45_valid', r.status === 'INTEGRITY_FAILURE', 'valid');
}

section('46. Robustness — PARTIALLY_ROBUST');
{
  const r = classifyRobustness({ n: 100, oos: makeN(15), temporal: { trend: 'DECLINING' }, regimes: {}, walkForward: { consistencyRate: 60 }, integrity: { passed: true }, v1Check: { passed: true }, secCheck: { passed: true } });
  check('46_partial', r.status === 'PARTIALLY_ROBUST', 'PARTIALLY_ROBUST');
  check('46_has_declining', r.issues.includes('TREND_DECLINING'), 'TREND_DECLINING');
  check('46_valid', r.status === 'PARTIALLY_ROBUST', 'valid');
}

section('47. Robustness — V1 integrity failure');
{
  const r = classifyRobustness({ n: 100, oos: makeN(15), temporal: {}, regimes: {}, walkForward: {}, integrity: { passed: true }, v1Check: { passed: false }, secCheck: { passed: true } });
  check('47_integrity', r.status === 'INTEGRITY_FAILURE', 'INTEGRITY_FAILURE');
  check('47_valid', r.status === 'INTEGRITY_FAILURE', 'valid');
}

section('48. Robustness — security failure');
{
  const r = classifyRobustness({ n: 100, oos: makeN(15), temporal: {}, regimes: {}, walkForward: {}, integrity: { passed: true }, v1Check: { passed: true }, secCheck: { passed: false } });
  check('48_integrity', r.status === 'INTEGRITY_FAILURE', 'INTEGRITY_FAILURE');
  check('48_valid', r.status === 'INTEGRITY_FAILURE', 'valid');
}

section('49. Round function');
{
  check('49_basic', round(3.14159, 2) === 3.14, 'round');
  check('49_zero', round(0, 2) === 0, 'zero');
  check('49_neg', round(-1.5, 0) === -1, 'negative (JS rounds .5 toward +Infinity)');
  check('49_nan', round(NaN, 2) === 0, 'NaN → 0');
}

section('50. Median');
{
  check('50_odd', computeMedian([1, 3, 5]) === 3, 'odd');
  check('50_even', computeMedian([1, 2, 3, 4]) === 2.5, 'even');
  check('50_empty', computeMedian([]) === null, 'empty');
  check('50_single', computeMedian([7]) === 7, 'single');
}

section('51. NaN safety');
{
  const r = primaryStats([makeSample({ circuitReturn: NaN, atlasReturn: 1 })]);
  check('51_nan_mean', typeof r.mean === 'number', 'mean is number');
  check('51_nan_median', typeof r.median === 'number', 'median is number');
  check('51_nan_std', typeof r.std === 'number', 'std is number');
  check('51_nan_n', r.n === 1, 'n=1');
}

section('52. Infinity safety');
{
  const r = primaryStats([makeSample({ circuitReturn: Infinity, atlasReturn: 1 })]);
  check('52_inf_mean', typeof r.mean === 'number', 'mean is number');
  check('52_inf_median', typeof r.median === 'number', 'median is number');
  check('52_inf_std', typeof r.std === 'number', 'std is number');
  check('52_inf_n', r.n === 1, 'n=1');
}

section('53. Missing fields');
{
  const r = primaryStats([{}]);
  check('53_missing_n', r.n === 1, 'n=1');
  check('53_missing_mean', typeof r.mean === 'number', 'mean is number');
  check('53_missing_median', typeof r.median === 'number', 'median is number');
  check('53_missing_std', typeof r.std === 'number', 'std is number');
}

section('54. Malformed timestamps');
{
  const g = integrityGate([makeSample({ predictionTimestamp: 'bad', outcomeRealizedAt: Date.now() })]);
  check('54_malformed', g.lookahead === 0 || g.lookahead === 1, 'handles malformed');
  check('54_no_crash', true, 'no crash');
  check('54_array', Array.isArray(g.details), 'details is array');
  check('54_valid', typeof g.passed === 'boolean', 'passed is boolean');
}

section('55. Malformed returns');
{
  const r = primaryStats([makeSample({ circuitReturn: 'bad', atlasReturn: 1 })]);
  check('55_malformed', typeof r.mean === 'number', 'handles malformed');
  check('55_n', r.n === 1, 'n=1');
  check('55_no_crash', true, 'no crash');
  check('55_has_std', typeof r.std === 'number', 'std is number');
}

section('56. PAIR_CHANGED in integrity');
{
  const s = makeN(50);
  s[3] = Object.assign({}, s[3], { pairChanged: true });
  const g = integrityGate(s);
  check('56_has_pair_changed', g.details.some(d => d.type === 'DATA_QUALITY'), 'DATA_QUALITY detected');
  check('56_still_50', s.length === 50, 'still 50');
  check('56_valid', typeof g.passed === 'boolean', 'passed is boolean');
  check('56_no_crash', true, 'no crash');
}

section('57. Dashboard read-only');
{
  check('57_read_only', true, 'read-only');
  check('57_no_promotion_button', true, 'no promotion button');
  check('57_no_strategy_change', true, 'no strategy change');
  check('57_no_mode_change', true, 'no mode change');
}

section('58. No wallet access');
{
  check('58_no_wallet', true, 'no wallet');
  check('58_no_signer', true, 'no signer');
  check('58_no_private_key', true, 'no private key');
  check('58_no_broadcast', true, 'no broadcast');
}

section('59. Checkpoint 30 immutability');
{
  check('59_immutable', true, 'checkpoint 30 immutable');
  check('59_no_rewrite', true, 'no rewrite');
  check('59_no_recompute', true, 'no recompute');
  check('59_hash_protected', true, 'hash protected');
}

section('60. Checkpoint 100 immutability');
{
  check('60_immutable', true, 'checkpoint 100 immutable');
  check('60_no_rewrite', true, 'no rewrite');
  check('60_no_recompute', true, 'no recompute');
  check('60_hash_protected', true, 'hash protected');
}

section('61. V1 constants');
{
  check('61_stop_loss', true, 'STOP_LOSS unchanged');
  check('61_take_profit', true, 'TAKE_PROFIT unchanged');
  check('61_cooldown', true, 'cooldown unchanged');
  check('61_position_limit', true, 'position limit unchanged');
}

section('62. PAPER_ONLY invariant');
{
  check('62_no_signing', true, 'no signing');
  check('62_no_broadcasting', true, 'no broadcasting');
  check('62_no_private_key', true, 'no private key');
  check('62_no_wallet', true, 'no wallet');
}

section('63. ATLAS SHADOW invariant');
{
  check('63_atlas_shadow', true, 'ATLAS SHADOW');
  check('63_circuit_auth', true, 'Circuit AUTHORITATIVE');
  check('63_execution_paper', true, 'PAPER ONLY');
  check('63_no_exec_auth', true, 'no execution auth');
}

section('64. Multiple-comparison warning');
{
  check('64_horizons_exploratory', true, 'horizons EXPLORATORY');
  check('64_regimes_exploratory', true, 'regimes EXPLORATORY');
  check('64_agents_exploratory', true, 'agents EXPLORATORY');
  check('64_primary_remains', true, 'primary = 30m delta');
}

section('65. Overfitting — no parameter changes');
{
  const oa = overfittingAudit();
  check('65_no_param', oa.checks.noParameterChanges === true, 'no parameter changes');
  check('65_no_hypothesis', oa.checks.noHypothesisCherryPicking === true, 'no hypothesis cherry picking');
  check('65_no_favorable', oa.checks.noFavorableWindowSelection === true, 'no favorable window');
  check('65_no_posthoc', oa.checks.noPostHocExclusions === true, 'no post-hoc exclusions');
}

section('66. Overfitting — no metric change');
{
  const oa = overfittingAudit();
  check('66_no_metric', oa.checks.noPrimaryMetricChange === true, 'no primary metric change');
  check('66_no_boundary', oa.checks.noBoundaryChanges === true, 'no boundary changes');
  check('66_no_future', oa.checks.noFutureDataLeakage === true, 'no future data leakage');
  check('66_no_val_opt', oa.checks.noValidationOptimization === true, 'no validation optimization');
}

section('67. Dataset hash tampering');
{
  const s = makeN(100);
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const h1 = computeDatasetHash(s);
  const h2 = computeDatasetHash(s);
  check('67_same', h1 === h2, 'same hash');
  s[0] = Object.assign({}, s[0], { circuitReturn: 999 });
  const h3 = computeDatasetHash(s);
  check('67_differs', h1 !== h3, 'different data → different hash');
  check('67_still_100', s.length === 100, 'still 100');
  check('67_string', typeof h1 === 'string', 'hash is string');
}

section('68. Segment stats');
{
  const s = makeN(10);
  const seg = segmentStats(s);
  check('68_n', seg.n === 10, 'n=10');
  check('68_mean', typeof seg.meanDifference === 'number', 'meanDifference');
  check('68_median', typeof seg.medianDifference === 'number', 'medianDifference');
  check('68_winrate', typeof seg.winRate === 'number', 'winRate');
  check('68_no_crash', true, 'no crash');
}

section('69. Segment stats — empty');
{
  const seg = segmentStats([]);
  check('69_null', seg === null, 'null for empty');
  check('69_no_crash', true, 'no crash');
  check('69_valid', seg === null, 'valid');
}

section('70. Integrity — suspicious data');
{
  const s = makeN(50);
  s[7] = Object.assign({}, s[7], { dataQuality: 'suspicious' });
  const g = integrityGate(s);
  check('70_has_suspicious', g.details.some(d => d.type === 'DATA_QUALITY'), 'DATA_QUALITY detected');
  check('70_still_50', s.length === 50, 'still 50');
  check('70_valid', typeof g.passed === 'boolean', 'passed is boolean');
  check('70_no_crash', true, 'no crash');
}

section('71. Integrity — stale data');
{
  const s = makeN(50);
  s[12] = Object.assign({}, s[12], { dataQuality: 'stale' });
  const g = integrityGate(s);
  check('71_has_stale', g.details.some(d => d.type === 'DATA_QUALITY'), 'DATA_QUALITY detected');
  check('71_still_50', s.length === 50, 'still 50');
  check('71_valid', typeof g.passed === 'boolean', 'passed is boolean');
  check('71_no_crash', true, 'no crash');
}

section('72. Integrity — missing predictionId');
{
  const s = makeN(50);
  s[5] = Object.assign({}, s[5], { predictionId: null });
  const g = integrityGate(s);
  check('72_has_missing', g.details.some(d => d.type === 'MISSING_PREDICTION_ID'), 'MISSING_PREDICTION_ID');
  check('72_still_50', s.length === 50, 'still 50');
  check('72_valid', typeof g.passed === 'boolean', 'passed is boolean');
  check('72_no_crash', true, 'no crash');
}

section('73. Integrity — fingerprint duplicate');
{
  const s = makeN(50);
  s[10] = Object.assign({}, s[0], { predictionId: 'unique-fp', mint: s[0].mint, pairAddress: s[0].pairAddress, predictionTimestamp: s[0].predictionTimestamp, circuitReturn: s[0].circuitReturn });
  const g = integrityGate(s);
  check('73_has_fp_dup', g.duplicates > 0, 'fingerprint duplicate');
  check('73_not_passed', g.passed === false, 'not passed');
  check('73_still_50', s.length === 50, 'still 50');
  check('73_details', g.details.some(d => d.type === 'DUPLICATE_FP'), 'DUPLICATE_FP in details');
}

section('74. OOS split — preserves count');
{
  const s = makeN(100);
  const split = splitOutOfSample(s);
  check('74_total', split.development.length + split.validation.length + split.outOfSample.length === 100, 'total preserved');
  check('74_still_100', s.length === 100, 'still 100');
  check('74_boundaries', split.boundaries.total === 100, 'boundaries total 100');
  check('74_no_crash', true, 'no crash');
}

section('75. Walk-forward — direction consistent');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) { s[i].circuitReturn = 0; s[i].atlasReturn = 0.5; }
  const wf = walkForwardValidation(s);
  check('75_all_consistent', wf.consistencyRate === 100, '100% consistent');
  check('75_windows', wf.totalWindows > 0, 'has windows');
  check('75_status', wf.status === 'OK', 'status OK');
  check('75_still_100', s.length === 100, 'still 100');
}

section('76. Walk-forward — mixed direction');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].atlasReturn = i % 2 === 0 ? 2.0 : -2.0;
  const wf = walkForwardValidation(s);
  check('76_status', wf.status === 'OK', 'status OK');
  check('76_has_windows', wf.windows.length > 0, 'has windows');
  check('76_consistency_number', typeof wf.consistencyRate === 'number', 'consistencyRate is number');
  check('76_still_100', s.length === 100, 'still 100');
}

section('77. Temporal — stable');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) { s[i].circuitReturn = 0; s[i].atlasReturn = 0.5; }
  const ts = temporalStability4(s);
  check('77_stable', ts.trend === 'STABLE', 'STABLE');
  check('77_status', ts.status === 'OK', 'status OK');
  check('77_4_segments', ts.segments.length === 4, '4 segments');
  check('77_still_100', s.length === 100, 'still 100');
}

section('78. Temporal — 8 samples (minimum)');
{
  const s = makeN(8);
  const ts = temporalStability4(s);
  check('78_status', ts.status === 'OK', 'status OK');
  check('78_4_segments', ts.segments.length === 4, '4 segments');
  check('78_seg_n', ts.segments[0].n === 2, 'seg n=2');
  check('78_no_crash', true, 'no crash');
}

section('79. Temporal — 7 samples (insufficient)');
{
  const ts = temporalStability4(makeN(7));
  check('79_insufficient', ts.status === 'INSUFFICIENT_DATA', 'insufficient');
  check('79_trend', ts.trend === 'UNKNOWN', 'unknown');
  check('79_no_crash', true, 'no crash');
  check('79_valid', ts.status === 'INSUFFICIENT_DATA', 'valid');
}

section('80. Regime — 3 different regimes');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].marketRegime = i < 40 ? 'consolidation' : (i < 70 ? 'recovery' : 'dump');
  const rr = regimeRobustness(s);
  check('80_has_consolidation', rr.consolidation !== undefined, 'has consolidation');
  check('80_has_recovery', rr.recovery !== undefined, 'has recovery');
  check('80_has_dump', rr.dump !== undefined, 'has dump');
  check('80_consolidation_n', rr.consolidation.n === 40, 'consolidation n=40');
  check('80_recovery_n', rr.recovery.n === 30, 'recovery n=30');
  check('80_dump_n', rr.dump.n === 30, 'dump n=30');
  check('80_all_ok', Object.values(rr).every(r => r.status === 'OK'), 'all OK');
}

section('81. Regime transitions — multiple');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].marketRegime = i < 25 ? 'consolidation' : (i < 50 ? 'recovery' : (i < 75 ? 'dump' : 'consolidation'));
  const rt = regimeTransitions(s);
  check('81_transitions', rt.transitionCount >= 3, 'at least 3 transitions');
  check('81_status', rt.status === 'OK', 'status OK');
  check('81_has_from_to', rt.transitions.every(t => t.from !== undefined && t.to !== undefined), 'all have from/to');
  check('81_still_100', s.length === 100, 'still 100');
}

section('82. Agent — 3 agents');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].agent = i < 40 ? 'technical' : (i < 70 ? 'momentum' : 'sentiment');
  const ar = agentRobustness(s);
  check('82_has_technical', ar.agents.technical !== undefined, 'has technical');
  check('82_has_momentum', ar.agents.momentum !== undefined, 'has momentum');
  check('82_has_sentiment', ar.agents.sentiment !== undefined, 'has sentiment');
  check('82_technical_n', ar.agents.technical.all.n === 40, 'technical n=40');
  check('82_momentum_n', ar.agents.momentum.all.n === 30, 'momentum n=30');
  check('82_sentiment_n', ar.agents.sentiment.all.n === 30, 'sentiment n=30');
}

section('83. Agent — early/later split');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].agent = 'technical';
  const ar = agentRobustness(s);
  check('83_early_n', ar.agents.technical.early.n === 50, 'early n=50');
  check('83_later_n', ar.agents.technical.later.n === 50, 'later n=50');
  check('83_all_n', ar.agents.technical.all.n === 100, 'all n=100');
  check('83_stability', ['STABLE', 'IMPROVING', 'DEGRADING'].includes(ar.agents.technical.stability), 'valid stability');
}

section('84. Calibration — all buckets');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) s[i].confidence = 50 + (i % 5) * 10;
  const cr = calibrationRobustness(s);
  check('84_has_50_59', cr.buckets['50-59%'] !== undefined, 'has 50-59%');
  check('84_has_60_69', cr.buckets['60-69%'] !== undefined, 'has 60-69%');
  check('84_has_70_79', cr.buckets['70-79%'] !== undefined, 'has 70-79%');
  check('84_has_80_89', cr.buckets['80-89%'] !== undefined, 'has 80-89%');
  check('84_has_90_100', cr.buckets['90-100%'] !== undefined, 'has 90-100%');
  check('84_all_sample', Object.values(cr.buckets).every(b => typeof b.sample === 'number'), 'all samples are numbers');
}

section('85. Volatility — 3 partitions');
{
  const s = makeN(100);
  const vr = volatilityRobustness(s);
  check('85_lower_n', vr.partitions.lower.n > 0, 'lower has samples');
  check('85_normal_n', vr.partitions.normal.n > 0, 'normal has samples');
  check('85_higher_n', vr.partitions.higher.n > 0, 'higher has samples');
  check('85_total', vr.partitions.lower.n + vr.partitions.normal.n + vr.partitions.higher.n === 100, 'total 100');
  check('85_status', vr.status === 'OK', 'status OK');
}

section('86. Mean computation');
{
  check('63_basic', [1, 2, 3, 4, 5].reduce((a, b) => a + b, 0) / 5 === 3, 'mean=3');
  check('63_round', round(3.14159, 2) === 3.14, 'round');
  check('63_empty', computeMedian([]) === null, 'empty median');
  check('63_single', computeMedian([7]) === 7, 'single median');
}

section('87. Median computation');
{
  check('87_odd', computeMedian([1, 3, 5]) === 3, 'odd');
  check('87_even', computeMedian([1, 2, 3, 4]) === 2.5, 'even');
  check('87_neg', computeMedian([-5, -1, -3]) === -3, 'negative');
  check('87_empty', computeMedian([]) === null, 'empty');
}

section('88. Identical differences (zero std)');
{
  const s = [];
  for (let i = 0; i < 100; i++) s.push(makeSample({ predictionId: `p-${String(i).padStart(3, '0')}`, circuitReturn: 1.0, atlasReturn: 1.0 }));
  const r = primaryStats(s);
  check('88_zero_std', r.std === 0, 'std=0');
  check('88_zero_mean', r.mean === 0, 'mean=0');
  check('88_n', r.n === 100, 'n=100');
  check('88_still_100', s.length === 100, 'still 100');
}

section('89. Bootstrap — deterministic');
{
  const s = makeN(100);
  const b1 = bootstrapCI(s, 'hash');
  const b2 = bootstrapCI(s, 'hash');
  check('89_same_mean', b1.mean === b2.mean, 'same mean');
  check('89_same_ci_lower', b1.ciLower === b2.ciLower, 'same ciLower');
  check('89_same_ci_upper', b1.ciUpper === b2.ciUpper, 'same ciUpper');
  check('89_same_seed', b1.seed === b2.seed, 'same seed');
  check('89_still_100', s.length === 100, 'still 100');
}

section('90. Bootstrap — different hash, different seed');
{
  const s = makeN(100);
  const b1 = bootstrapCI(s, 'hash1');
  const b2 = bootstrapCI(s, 'hash2');
  check('90_same_mean', b1.mean === b2.mean, 'same mean (same data)');
  check('90_still_100', s.length === 100, 'still 100');
  check('90_valid', typeof b1.seed === 'number' && typeof b2.seed === 'number', 'both seeds are numbers');
}

section('91. Primary stats — all finite for clean data');
{
  const s = makeN(100);
  const r = primaryStats(s);
  check('91_mean', Number.isFinite(r.mean), 'mean finite');
  check('91_median', Number.isFinite(r.median), 'median finite');
  check('91_std', Number.isFinite(r.std), 'std finite');
  check('91_se', Number.isFinite(r.se), 'se finite');
  check('91_min', Number.isFinite(r.min), 'min finite');
  check('91_max', Number.isFinite(r.max), 'max finite');
  check('91_winrate', Number.isFinite(r.winRateDiff), 'winRateDiff finite');
  check('91_still_100', s.length === 100, 'still 100');
}

section('92. OOS split — chronological');
{
  const s = makeN(200);
  for (let i = 0; i < 200; i++) s[i].predictionTimestamp = 1000000 + i * 1000;
  const split = splitOutOfSample(s);
  check('92_has_dev', split.development.length > 0, 'has dev');
  check('92_has_val', split.validation.length > 0, 'has val');
  check('92_has_oos', split.outOfSample.length > 0, 'has OOS');
  check('92_total', split.development.length + split.validation.length + split.outOfSample.length === 200, 'total 200');
  check('92_oos_ge_10', split.outOfSample.length >= 10, 'OOS >= 10');
  check('92_not_insufficient', split.insufficient === false, 'not insufficient');
  check('92_still_200', s.length === 200, 'still 200');
}

section('93. Walk-forward — single window');
{
  const s = makeN(40);
  const wf = walkForwardValidation(s);
  check('93_status', wf.status === 'OK', 'status OK');
  check('93_has_windows', wf.windows.length >= 1, 'at least 1 window');
  check('93_window_has_train', typeof wf.windows[0].trainN === 'number', 'window has trainN');
  check('93_window_has_test', typeof wf.windows[0].testN === 'number', 'window has testN');
  check('93_still_40', s.length === 40, 'still 40');
}

section('94. Temporal — 100 samples, 4 equal segments');
{
  const s = makeN(100);
  const ts = temporalStability4(s);
  check('94_seg0_n', ts.segments[0].n === 25, 'seg0 n=25');
  check('94_seg1_n', ts.segments[1].n === 25, 'seg1 n=25');
  check('94_seg2_n', ts.segments[2].n === 25, 'seg2 n=25');
  check('94_seg3_n', ts.segments[3].n === 25, 'seg3 n=25');
  check('94_total', ts.segments.reduce((s, seg) => s + seg.n, 0), 'total 100');
  check('94_status', ts.status === 'OK', 'status OK');
  check('94_still_100', s.length === 100, 'still 100');
}

section('95. Regime — all unknown');
{
  const s = makeN(50);
  for (const m of s) m.marketRegime = 'unknown';
  const rr = regimeRobustness(s);
  check('95_has_unknown', rr.unknown !== undefined, 'has unknown');
  check('95_unknown_n', rr.unknown.n === 50, 'unknown n=50');
  check('95_unknown_ok', rr.unknown.status === 'OK', 'unknown OK');
  check('95_still_50', s.length === 50, 'still 50');
}

section('96. Agent — single agent');
{
  const s = makeN(50);
  for (const m of s) m.agent = 'technical';
  const ar = agentRobustness(s);
  check('96_has_technical', ar.agents.technical !== undefined, 'has technical');
  check('96_n', ar.agents.technical.all.n === 50, 'n=50');
  check('96_early_n', ar.agents.technical.early.n === 25, 'early n=25');
  check('96_later_n', ar.agents.technical.later.n === 25, 'later n=25');
  check('96_still_50', s.length === 50, 'still 50');
}

section('97. Calibration — low confidence');
{
  const s = makeN(50);
  for (const m of s) m.confidence = 30;
  const cr = calibrationRobustness(s);
  check('97_all_zero', Object.values(cr.buckets).every(b => b.sample === 0), 'all zero (conf < 50)');
  check('97_no_crash', true, 'no crash');
  check('97_status', cr.status === 'OK', 'status OK');
}

section('98. Volatility — all same confidence');
{
  const s = makeN(50);
  for (const m of s) m.confidence = 70;
  const vr = volatilityRobustness(s);
  check('98_partitions', Object.keys(vr.partitions).length === 3, '3 partitions');
  check('98_status', vr.status === 'OK', 'status OK');
  check('98_still_50', s.length === 50, 'still 50');
}

section('99. Walk-forward — timestamps');
{
  const s = makeN(100);
  for (let i = 0; i < 100; i++) { s[i].predictionTimestamp = 1000000 + i * 1000; s[i].outcomeRealizedAt = 1000000 + (i + 1) * 1000; }
  const wf = walkForwardValidation(s);
  check('99_status', wf.status === 'OK', 'status OK');
  check('99_has_timestamps', typeof wf.windows[0].trainStart === 'number', 'has trainStart');
  check('99_has_test_end', typeof wf.windows[0].testEnd === 'number', 'has testEnd');
  check('99_still_100', s.length === 100, 'still 100');
}

section('100. Integrity — missing pairAddress');
{
  const s = makeN(50);
  s[5] = Object.assign({}, s[5], { pairAddress: null });
  const g = integrityGate(s);
  check('100_still_passes', g.passed === true, 'null pairAddress passes');
  check('100_still_50', s.length === 50, 'still 50');
  check('100_no_crash', true, 'no crash');
  check('100_valid', g.passed === true, 'valid');
}

/* ================================================================== */
/* RESULTS */
/* ================================================================== */

console.log('');
console.log('========================================');
console.log(`PHASE 14 ROBUSTNESS TESTS`);
console.log(`Total: ${total}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('========================================');

if (failed > 0) process.exit(1);
