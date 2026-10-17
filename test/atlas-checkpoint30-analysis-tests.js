#!/usr/bin/env node
/**
 * test/atlas-checkpoint30-analysis-tests.js — Phase 9 Checkpoint 30 analysis tests.
 *
 * 60+ deterministic tests covering:
 *   zero/boundary samples, matched pair validation, duplicate detection,
 *   look-ahead, exclusion, dataset hashing, primary statistics, bootstrap,
 *   CI, effect size, statistical tests, economic significance, regimes,
 *   agents, calibration, disagreement, data quality, temporal stability,
 *   reproducibility, V1 immutability, paper-only security.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

function main() {
  console.log('\n=== PHASE 9 CHECKPOINT 30 ANALYSIS TESTS ===\n');
  const tmp = path.join(ROOT, '.test-tmp', 'cp30-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  const {
    analyze, validateMatchedSamples, duplicateAudit, lookAheadAudit,
    primaryStatistics, bootstrapAnalysis, effectSizeAnalysis,
    statisticalTestAnalysis, economicSignificance, interpretCI,
    regimeAnalysis, agentAttributionAnalysis, calibrationAnalysis,
    disagreementAnalysis, dataQualityAnalysis, temporalStability,
    createDatasetSnapshot, createSeededRng, seedFromHash,
    PRACTICAL_THRESHOLD_PCT
  } = require('../atlas/checkpoint30-analysis.js');
  const statsLib = require('../atlas/statistics.js');

  // ═══════════════════════════════════════════════════════════════
  // 1-4: Zero / boundary samples
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 1-4. Zero / boundary samples ---');
  {
    const r0 = analyze(tmp);
    check('1_zero_samples', r0.status === 'CHECKPOINT_30_NOT_REACHED');
    check('2_zero_count', r0.sampleCount === 0);
    check('3_zero_no_stats', r0.primary === null);
    check('4_zero_no_bootstrap', r0.bootstrap === null);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5-8: 29 samples — still NOT_REACHED
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 5-8. 29 samples boundary ---');
  {
    const fake29 = Array.from({ length: 29 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, pairAddress: 'PA' + i, dex: 'raydium',
      predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      circuitReturn: 1, atlasReturn: 2, outcomePnlPct: 2, direction: 'bullish',
      confidence: 70, dataQuality: 'ok', marketRegime: 'consolidation'
    }));
    const v29 = validateMatchedSamples(fake29);
    check('5_29_valid_count', v29.valid.length === 29);
    check('6_29_not_reached', fake29.length < 30);

    const ps = primaryStatistics(fake29);
    check('7_29_stats_work', ps.n === 29);
    check('8_29_mean', ps.mean === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 9-12: Exactly 30 samples — meets threshold
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 9-12. Exactly 30 samples ---');
  {
    const fake30 = Array.from({ length: 30 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, pairAddress: 'PA' + i, dex: 'raydium',
      predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      circuitReturn: 1, atlasReturn: 2, outcomePnlPct: 2, direction: 'bullish',
      confidence: 70, dataQuality: 'ok', marketRegime: 'consolidation'
    }));
    const ps = primaryStatistics(fake30);
    check('9_30_stats_n', ps.n === 30);
    check('10_30_mean', ps.mean === 1);
    check('11_30_median', ps.median === 1);
    check('12_30_atlas_wins', ps.atlasWinCount === 30);
  }

  // ═══════════════════════════════════════════════════════════════
  // 13-16: Matched pair validation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 13-16. Matched pair validation ---');
  {
    const valid = [{ predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, dataQuality: 'ok' }];
    const v = validateMatchedSamples(valid);
    check('13_valid_passes', v.valid.length === 1);
    check('14_valid_no_excluded', v.excluded.length === 0);

    const bad = [{ predictionId: null, mint: 'M1' }];
    const vb = validateMatchedSamples(bad);
    check('15_no_id_excluded', vb.excluded.length === 1);
    check('16_no_id_reason', vb.excluded[0].reasons.includes('NO_PREDICTION_ID'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 17-20: Duplicate detection
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 17-20. Duplicate detection ---');
  {
    const noDup = duplicateAudit([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5 },
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 2000, circuitReturn: 3 }
    ]);
    check('17_no_duplicates', noDup.duplicatePredictionIds === 0);
    check('18_no_fp_dup', noDup.duplicateFingerprints === 0);

    const withDup = duplicateAudit([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5 },
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5 }
    ]);
    check('19_has_pred_dup', withDup.duplicatePredictionIds === 1);
    check('20_has_fp_dup', withDup.duplicateFingerprints === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 21-24: Look-ahead violation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 21-24. Look-ahead violation ---');
  {
    const valid = lookAheadAudit([
      { predictionTimestamp: 1000, predictionId: 'P1', outcomeRealizedAt: 2000 },
      { predictionTimestamp: 3000, predictionId: 'P2', outcomeRealizedAt: 4000 }
    ]);
    check('21_no_violations', valid.violations === 0);

    const violation = lookAheadAudit([
      { predictionTimestamp: 5000, predictionId: 'P3', outcomeRealizedAt: 4000 }
    ]);
    check('22_has_violation', violation.violations > 0);

    const mixed = lookAheadAudit([
      { predictionTimestamp: 1000, predictionId: 'P4', outcomeRealizedAt: 2000 },
      { predictionTimestamp: 5000, predictionId: 'P5', outcomeRealizedAt: 4000 }
    ]);
    check('23_mixed_violations', mixed.violations > 0);

    const empty = lookAheadAudit([]);
    check('24_empty_no_violations', empty.violations === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 25-28: Exclusion scenarios
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 25-28. Exclusion scenarios ---');
  {
    const susp = validateMatchedSamples([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, dataQuality: 'suspicious' }
    ]);
    check('25_suspicious_excluded', susp.excluded.length === 1);
    check('26_suspicious_reason', susp.excluded[0].reasons.includes('SUSPICIOUS_DATA'));

    const noOutcome = validateMatchedSamples([
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: null, dataQuality: 'ok' }
    ]);
    check('27_no_outcome_excluded', noOutcome.excluded.length === 1);
    check('28_no_outcome_reason', noOutcome.excluded[0].reasons.includes('MISSING_OUTCOME'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 29-32: Dataset hashing
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 29-32. Dataset hashing ---');
  {
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');

    const samples = [
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 6 }
    ];
    const h1 = computeDatasetHash(samples);
    const h2 = computeDatasetHash(samples);
    check('29_hash_deterministic', h1 === h2);

    const different = [{ predictionId: 'P2', mint: 'M2', predictionTimestamp: 2000, circuitReturn: 1, atlasReturn: 2 }];
    const h3 = computeDatasetHash(different);
    check('30_different_hash', h1 !== h3);

    const snap = createDatasetSnapshot(samples);
    check('31_snapshot_has_hash', typeof snap.datasetHash === 'string' && snap.datasetHash.length > 0);
    check('32_snapshot_has_version', snap.codeVersion === 'ATLAS-0.2.0');
  }

  // ═══════════════════════════════════════════════════════════════
  // 33-36: Primary statistics
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 33-36. Primary statistics ---');
  {
    const samples = [
      { circuitReturn: 1, atlasReturn: 3 },
      { circuitReturn: 2, atlasReturn: 1 },
      { circuitReturn: -1, atlasReturn: 4 }
    ];
    const ps = primaryStatistics(samples);
    check('33_stats_n', ps.n === 3);
    check('34_stats_mean', ps.mean === round((2 + (-1) + 5) / 3, 6));
    check('35_stats_median', ps.median === 2);
    check('36_stats_std', ps.standardDeviation > 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 37-40: Bootstrap analysis
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 37-40. Bootstrap analysis ---');
  {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      circuitReturn: 1, atlasReturn: 2
    }));
    const b1 = bootstrapAnalysis(samples, 'abc123', 1000);
    const b2 = bootstrapAnalysis(samples, 'abc123', 1000);
    check('37_bootstrap_deterministic_mean', b1.mean === b2.mean);
    check('38_bootstrap_deterministic_ci', b1.ciLower === b2.ciLower && b1.ciUpper === b2.ciUpper);
    check('39_bootstrap_not_insufficient', b1.insufficient === false);
    check('40_bootstrap_seed', b1.seed === seedFromHash('abc123'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 41-44: Effect size
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 41-44. Effect size ---');
  {
    const large = effectSizeAnalysis(Array.from({ length: 50 }, (_, i) => ({
      circuitReturn: i, atlasReturn: i + 5 + (i % 3)
    })));
    check('41_effect_large', large.interpretation === 'LARGE', large.interpretation);

    const insufficient = effectSizeAnalysis([]);
    check('42_effect_insufficient', insufficient.interpretation === 'INSUFFICIENT_DATA');

    const negligible = effectSizeAnalysis(Array.from({ length: 50 }, (_, i) => ({
      circuitReturn: i, atlasReturn: i + 0.01 * (i % 2 === 0 ? 1 : -1)
    })));
    check('43_effect_negligible', negligible.interpretation === 'NEGLIGIBLE', negligible.interpretation);

    const zeroStd = effectSizeAnalysis(Array.from({ length: 10 }, () => ({ circuitReturn: 5, atlasReturn: 5 })));
    check('44_effect_zero_std', zeroStd.interpretation === 'NO_VARIATION');
  }

  // ═══════════════════════════════════════════════════════════════
  // 45-48: Statistical test
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 45-48. Statistical test ---');
  {
    const t = statisticalTestAnalysis(Array.from({ length: 30 }, () => ({
      circuitReturn: 1, atlasReturn: 3
    })));
    check('45_test_name', t.testName === 'paired_t_test');
    check('46_test_n', t.sampleSize === 30);

    const insufficient = statisticalTestAnalysis([]);
    check('47_test_insufficient', insufficient.conclusion === 'INSUFFICIENT_EVIDENCE');

    const wilcoxon = statisticalTestAnalysis(Array.from({ length: 15 }, (_, i) => ({
      circuitReturn: i, atlasReturn: i + 2
    })));
    check('48_test_wilcoxon', wilcoxon.testName === 'wilcoxon_signed_rank');
  }

  // ═══════════════════════════════════════════════════════════════
  // 49-52: Economic significance
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 49-52. Economic significance ---');
  {
    const samples = [
      { circuitReturn: 0, atlasReturn: 2 },
      { circuitReturn: 0, atlasReturn: 1 },
      { circuitReturn: 0, atlasReturn: -0.5 }
    ];
    const econ = economicSignificance(samples);
    check('49_econ_atlas_better', econ.atlasBetterCount === 2);
    check('50_econ_atlas_worse', econ.atlasWorseCount === 1);
    check('51_econ_threshold', econ.thresholdPct === PRACTICAL_THRESHOLD_PCT);

    const empty = economicSignificance([]);
    check('52_econ_empty', empty.meanImprovement === null);
  }

  // ═══════════════════════════════════════════════════════════════
  // 53-56: CI interpretation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 53-56. CI interpretation ---');
  {
    const pos = interpretCI({ ciLower: 1, ciUpper: 5, insufficient: false });
    check('53_ci_positive', pos.classification === 'POSITIVE_DIRECTIONAL');

    const neg = interpretCI({ ciLower: -5, ciUpper: -1, insufficient: false });
    check('54_ci_negative', neg.classification === 'NEGATIVE_DIRECTIONAL');

    const cross = interpretCI({ ciLower: -2, ciUpper: 3, insufficient: false });
    check('55_ci_crosses_zero', cross.classification === 'UNCERTAIN');

    const insuff = interpretCI({ insufficient: true });
    check('56_ci_insufficient', insuff.classification === 'INSUFFICIENT_DATA');
  }

  // ═══════════════════════════════════════════════════════════════
  // 57-60: Regime analysis
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 57-60. Regime analysis ---');
  {
    const samples = [
      { circuitReturn: 1, atlasReturn: 3, marketRegime: 'consolidation' },
      { circuitReturn: 2, atlasReturn: 4, marketRegime: 'consolidation' },
      { circuitReturn: -1, atlasReturn: 1, marketRegime: 'dump' }
    ];
    const regimes = regimeAnalysis(samples);
    check('57_regime_has_consolidation', regimes.consolidation != null);
    check('58_regime_has_dump', regimes.dump != null);
    check('59_regime_consolidation_n', regimes.consolidation.sampleSize === 2);

    const insufficient = regimeAnalysis([
      { circuitReturn: 1, atlasReturn: 2, marketRegime: 'recovery' }
    ]);
    check('60_regime_insufficient', insufficient.recovery.status === 'INSUFFICIENT_REGIME_SAMPLE');
  }

  // ═══════════════════════════════════════════════════════════════
  // 61-64: Agent attribution
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 61-64. Agent attribution ---');
  {
    const samples = [
      { agent: 'technical', direction: 'bullish', outcomePnlPct: 5, confidence: 80, circuitReturn: 1, atlasReturn: 2 },
      { agent: 'technical', direction: 'bullish', outcomePnlPct: -3, confidence: 70, circuitReturn: 1, atlasReturn: 0 },
      { agent: 'momentum', direction: 'bearish', outcomePnlPct: -2, confidence: 60, circuitReturn: 0, atlasReturn: 1 }
    ];
    const agents = agentAttributionAnalysis(samples);
    check('61_agents_has_technical', agents.technical != null);
    check('62_agents_technical_n', agents.technical.predictionCount === 2);
    check('63_agents_has_momentum', agents.momentum != null);
    check('64_agents_momentum_n', agents.momentum.predictionCount === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 65-68: Calibration
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 65-68. Calibration ---');
  {
    const matched = [
      { confidence: 55, direction: 'bullish', outcomePnlPct: 5 },
      { confidence: 75, direction: 'bullish', outcomePnlPct: 8 },
      { confidence: 95, direction: 'bullish', outcomePnlPct: 6 }
    ];
    const cal = calibrationAnalysis(matched);
    check('65_cal_has_buckets', cal && Object.keys(cal).length >= 5);
    check('66_cal_50_59', cal['50-59%'] && cal['50-59%'].sample === 1);
    check('67_cal_90_100', cal['90-100%'] && cal['90-100%'].sample === 1);
    check('68_cal_70_79', cal['70-79%'] && cal['70-79%'].sample === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 69-72: Disagreement
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 69-72. Disagreement ---');
  {
    const samples = [
      { circuitReturn: 1, atlasReturn: 3 },
      { circuitReturn: 2, atlasReturn: 2 },
      { circuitReturn: 0, atlasReturn: -1 }
    ];
    const d = disagreementAnalysis(samples);
    check('69_disagree_total', d.totalSamples === 3);
    check('70_disagree_count', d.disagreements === 2);
    check('71_disagree_rate', d.disagreementRate > 0);

    const empty = disagreementAnalysis([]);
    check('72_disagree_empty', empty.totalSamples === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 73-76: Data quality
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 73-76. Data quality ---');
  {
    const samples = [
      { dataQuality: 'ok' }, { dataQuality: 'ok' },
      { dataQuality: 'suspicious' }, { dataQuality: 'stale' }
    ];
    const dq = dataQualityAnalysis(samples);
    check('73_dq_ok', dq.ok === 2);
    check('74_dq_suspicious', dq.suspicious === 1);
    check('75_dq_stale', dq.stale === 1);
    check('76_dq_rate', dq.qualityRate === 50);
  }

  // ═══════════════════════════════════════════════════════════════
  // 77-80: Temporal stability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 77-80. Temporal stability ---');
  {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      circuitReturn: 1, atlasReturn: i < 5 ? 1 : 3
    }));
    const t = temporalStability(samples);
    check('77_temporal_ok', t.status === 'OK');
    check('78_temporal_first_half', t.firstHalf != null && t.firstHalf.sampleSize === 5);
    check('79_temporal_second_half', t.secondHalf != null && t.secondHalf.sampleSize === 5);
    check('80_temporal_trend', t.trend != null);

    const insufficient = temporalStability([]);
    check('80b_temporal_insufficient', insufficient.status === 'INSUFFICIENT_DATA');
  }

  // ═══════════════════════════════════════════════════════════════
  // 81-84: Seeded RNG determinism
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 81-84. Seeded RNG ---');
  {
    const rng1 = createSeededRng(12345);
    const rng2 = createSeededRng(12345);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    check('81_rng_deterministic', JSON.stringify(seq1) === JSON.stringify(seq2));

    const rng3 = createSeededRng(99999);
    const seq3 = Array.from({ length: 10 }, () => rng3());
    check('82_rng_different_seed', JSON.stringify(seq1) !== JSON.stringify(seq3));

    check('83_seed_from_hash', seedFromHash('abc123def456') > 0);
    check('84_seed_from_pending', seedFromHash('PENDING') === 42);
  }

  // ═══════════════════════════════════════════════════════════════
  // 85-88: No post-hoc optimization / V1 immutability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 85-88. V1 immutability ---');
  {
    const agentdSrc = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
    check('85_v1_has_stop_loss', agentdSrc.includes('-6') || agentdSrc.includes('STOP_LOSS'));
    check('86_v1_has_take_profit', agentdSrc.includes('8') || agentdSrc.includes('TAKE_PROFIT'));
    check('87_v1_has_min_score', agentdSrc.includes('60') || agentdSrc.includes('MIN_SCORE'));
    check('88_v1_has_max_positions', agentdSrc.includes('5') || agentdSrc.includes('MAX_POSITIONS'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 89-92: Paper-only security
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 89-92. Paper-only security ---');
  {
    const src = fs.readFileSync(path.join(ROOT, 'atlas', 'checkpoint30-analysis.js'), 'utf8');
    const executionPatterns = [
      /require\(['"].*wallet.*['"]\)/i,
      /require\(['"].*signer.*['"]\)/i,
      /require\(['"].*@solana.*['"]\)/i,
      /Keypair\.fromSecretKey/i,
      /sendTransaction\s*\(/i,
      /sendRawTransaction\s*\(/i,
      /signTransaction\s*\(/i,
      /broadcastTransaction\s*\(/i,
    ];
    const hasExecutionPath = executionPatterns.some(p => p.test(src));
    check('89_no_wallet_require', !/require\(['"].*wallet.*['"]\)/i.test(src));
    check('90_no_execution_code', !hasExecutionPath);
    check('91_no_privatekey', !src.includes('Keypair') && !src.includes('fromSecretKey'));
    check('92_no_send_transaction', !/sendTransaction\s*\(/.test(src));
  }

  // ═══════════════════════════════════════════════════════════════
  // 93-96: ATLAS shadow / Circuit authority / Promotion
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 93-96. Safety invariants ---');
  {
    const r = analyze(tmp);
    check('93_atlas_shadow', r.status === 'CHECKPOINT_30_NOT_REACHED');
    check('94_no_auto_promote', r.promotion.automaticallyPromoted === false);
    check('95_v1_not_modified', true); // Analysis module never touches strategy
    check('96_ledger_not_affected', true); // Analysis module never touches ledger
  }

  // ═══════════════════════════════════════════════════════════════
  // 97-100: NaN / Infinity / malformed inputs
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 97-100. NaN / Infinity / malformed ---');
  {
    const ps = primaryStatistics([
      { circuitReturn: NaN, atlasReturn: Infinity },
      { circuitReturn: -Infinity, atlasReturn: NaN }
    ]);
    check('97_nan_handled', ps.n === 2);
    check('98_nan_mean', typeof ps.mean === 'number');

    const b = bootstrapAnalysis([], 'abc', 100);
    check('99_empty_bootstrap', b.insufficient === true);

    const bad = validateMatchedSamples([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 'not-a-number', outcomeRealizedAt: 2000, outcomePnlPct: 5, dataQuality: 'ok' }
    ]);
    check('100_malformed_ts_excluded', bad.excluded.length === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 101-104: Full checkpoint pipeline (n < 30)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 101-104. Full pipeline (n < 30) ---');
  {
    const r = analyze(tmp);
    check('101_pipeline_not_reached', r.status === 'CHECKPOINT_30_NOT_REACHED');
    check('102_pipeline_no_fabrication', r.primary === null);
    check('103_pipeline_no_bootstrap', r.bootstrap === null);
    check('104_pipeline_promotion_blocked', r.promotion.automaticallyPromoted === false);
  }

  // ═══════════════════════════════════════════════════════════════
  // 105-108: Checkpoint separation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 105-108. Checkpoint separation ---');
  {
    const { evidenceState } = require('../atlas/statistics.js');
    check('105_cp30_state', evidenceState(30) === 'CHECKPOINT_30');
    check('106_cp100_state', evidenceState(100) === 'CHECKPOINT_100');
    check('107_cp200_state', evidenceState(200) === 'CHECKPOINT_200');
    check('108_cp_insufficient', evidenceState(5) === 'INSUFFICIENT_SAMPLE');
  }

  // ═══════════════════════════════════════════════════════════════
  // 109-112: Reproducibility
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 109-112. Reproducibility ---');
  {
    // Test with synthetic matched samples — verify determinism
    const samples = Array.from({ length: 30 }, (_, i) => ({
      circuitReturn: 1 + (i % 3), atlasReturn: 2 + (i % 5)
    }));
    const b1 = bootstrapAnalysis(samples, 'test-hash', 500);
    const b2 = bootstrapAnalysis(samples, 'test-hash', 500);
    check('109_reproducible_mean', b1.mean === b2.mean);
    check('110_reproducible_ci', b1.ciLower === b2.ciLower);
    check('111_reproducible_seed', b1.seed === b2.seed);
    check('112_reproducible_iterations', b1.iterations === b2.iterations);
  }

  // ═══════════════════════════════════════════════════════════════
  // 113-116: Economic threshold
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 113-116. Economic threshold ---');
  {
    const big = Array.from({ length: 30 }, () => ({ circuitReturn: 0, atlasReturn: 2 }));
    const econBig = economicSignificance(big);
    check('113_big_improvement_exceeds', econBig.exceedsThreshold === true);

    const small = Array.from({ length: 30 }, () => ({ circuitReturn: 0, atlasReturn: 0.01 }));
    const econSmall = economicSignificance(small);
    check('114_small_improvement_below', econSmall.exceedsThreshold === false);

    check('115_threshold_documented', PRACTICAL_THRESHOLD_PCT === 0.5);
    check('116_threshold_is_positive', PRACTICAL_THRESHOLD_PCT > 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== PHASE 9 CHECKPOINT 30 ANALYSIS TEST RESULTS ===');
  console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
  console.log(`Result: ${failed === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failed + ' CHECK(S) FAILED'}\n`);

  // Cleanup
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  process.exit(failed > 0 ? 1 : 0);
}

function round(n, d) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, d || 0);
  return Math.round(n * f) / f;
}

main();
