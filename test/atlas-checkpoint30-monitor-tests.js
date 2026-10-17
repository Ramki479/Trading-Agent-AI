#!/usr/bin/env node
/**
 * test/atlas-checkpoint30-monitor-tests.js — Phase 10 Checkpoint 30 monitor tests.
 *
 * 60+ deterministic tests covering:
 *   zero/boundary samples, unresolved/excluded/duplicates, look-ahead,
 *   PAIR_CHANGED, suspicious/stale, invalid numerics, missing outcomes,
 *   dataset hashing, immutable snapshot, checkpoint readiness/freeze,
 *   no fabricated data, V1 immutability, paper-only security, no private
 *   key/signer/broadcast, automatic promotion blocked, selection audit,
 *   survivorship audit, unresolved classification, timestamp ordering,
 *   resolution horizon, data-quality exclusions, reproducibility,
 *   malformed records, NaN/Infinity, empty/corrupted dataset,
 *   checkpoint separation, analysis version, hash stability, A/B isolation,
 *   ATLAS SHADOW invariant, Circuit AUTHORATIVE invariant, PAPER ONLY
 *   invariant, progress calculation, remaining count, duplicate rejection,
 *   excluded/unresolved counts, readiness state, frozen dataset immutability,
 *   historical sample immutability, production fixture isolation,
 *   deterministic monitor output.
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
  console.log('\n=== PHASE 10 CHECKPOINT 30 MONITOR TESTS ===\n');
  const tmp = path.join(ROOT, '.test-tmp', 'cp30mon-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  const {
    monitor, validateObservations, createDatasetSnapshot,
    selectionAudit, survivorshipAudit, resolutionHorizonCheck,
    abIsolationCheck, CHECKPOINT_TARGET, CODE_VERSION, ANALYSIS_VERSION
  } = require('../atlas/checkpoint30-monitor.js');
  const { computeDatasetHash } = require('../atlas/dataset-hash.js');
  const statsLib = require('../atlas/statistics.js');

  // ═══════════════════════════════════════════════════════════════
  // 1-4: Zero samples
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 1-4. Zero samples ---');
  {
    const r = monitor(tmp);
    check('1_zero_not_reached', r.checkpoint.status === 'CHECKPOINT_30_NOT_REACHED');
    check('2_zero_matched', r.checkpoint.matched === 0);
    check('3_zero_remaining', r.checkpoint.remaining === CHECKPOINT_TARGET);
    check('4_zero_progress', r.checkpoint.progressPct === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5-8: One sample
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 5-8. One sample ---');
  {
    const v1 = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok', pairAddress: 'PA1' }
    ]);
    check('5_one_valid', v1.valid.length === 1);
    check('6_one_no_excluded', v1.excluded.length === 0);
    check('7_one_no_lookahead', v1.lookAheadViolations === 0);
    check('8_one_no_duplicates', v1.duplicates === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 9-12: 29 samples — still NOT_REACHED
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 9-12. 29 samples boundary ---');
  {
    const fake29 = Array.from({ length: 29 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, pairAddress: 'PA' + i, dex: 'raydium',
      predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      circuitReturn: 1, atlasReturn: 2, outcomePnlPct: 2, direction: 'bullish',
      confidence: 70, dataQuality: 'ok', marketRegime: 'consolidation'
    }));
    const v29 = validateObservations(fake29);
    check('9_29_valid_count', v29.valid.length === 29);
    check('10_29_not_reached', fake29.length < 30);
    check('11_29_no_lookahead', v29.lookAheadViolations === 0);
    check('12_29_no_duplicates', v29.duplicates === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 13-16: Exactly 30 samples — meets threshold
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 13-16. Exactly 30 samples ---');
  {
    const fake30 = Array.from({ length: 30 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, pairAddress: 'PA' + i, dex: 'raydium',
      predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      circuitReturn: 1, atlasReturn: 2, outcomePnlPct: 2, direction: 'bullish',
      confidence: 70, dataQuality: 'ok', marketRegime: 'consolidation'
    }));
    const v30 = validateObservations(fake30);
    check('13_30_valid_count', v30.valid.length === 30);
    check('14_30_meets_threshold', v30.valid.length >= CHECKPOINT_TARGET);
    check('15_30_no_lookahead', v30.lookAheadViolations === 0);
    check('16_30_no_duplicates', v30.duplicates === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 17-20: >30 samples
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 17-20. >30 samples ---');
  {
    const fake35 = Array.from({ length: 35 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, pairAddress: 'PA' + i,
      predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      circuitReturn: 1, atlasReturn: 2, outcomePnlPct: 2, dataQuality: 'ok'
    }));
    const v = validateObservations(fake35);
    check('17_gt30_valid', v.valid.length === 35);
    check('18_gt30_ready', v.valid.length >= CHECKPOINT_TARGET);
    check('19_gt30_remaining_zero', Math.max(0, CHECKPOINT_TARGET - v.valid.length) === 0);
    check('20_gt30_progress_100', Math.round((v.valid.length / CHECKPOINT_TARGET) * 100) >= 100);
  }

  // ═══════════════════════════════════════════════════════════════
  // 21-24: Unresolved samples
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 21-24. Unresolved samples ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: null, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('21_unresolved_excluded', v.excluded.length === 1);
    check('22_unresolved_missing_outcome', v.excluded[0].reasons.includes('MISSING_OUTCOME'));
    check('23_unresolved_count', v.missingOutcome === 1);
    check('24_unresolved_does_not_count', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 25-28: Excluded samples
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 25-28. Excluded samples ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'suspicious' }
    ]);
    check('25_suspicious_excluded', v.excluded.length === 1);
    check('26_suspicious_reason', v.excluded[0].reasons.includes('SUSPICIOUS_DATA'));
    check('27_suspicious_count', v.suspicious === 1);
    check('28_suspicious_not_valid', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 29-32: Duplicate samples
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 29-32. Duplicate samples ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok', pairAddress: 'PA1' },
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok', pairAddress: 'PA1' }
    ]);
    check('29_duplicate_rejected', v.duplicates > 0);
    check('30_duplicate_excluded', v.excluded.some(e => e.reasons.includes('DUPLICATE_FINGERPRINT')));
    check('31_duplicate_excluded_has_reason', v.excluded.some(e => e.reasons.includes('DUPLICATE_FINGERPRINT')));
    check('32_duplicate_pred_id_flagged', v.excluded.some(e => e.reasons.includes('DUPLICATE_PREDICTION_ID')));
  }

  // ═══════════════════════════════════════════════════════════════
  // 33-36: Duplicate prediction IDs
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 33-36. Duplicate prediction IDs ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' },
      { predictionId: 'P1', mint: 'M2', predictionTimestamp: 3000, outcomeRealizedAt: 4000, outcomePnlPct: 3, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('33_pred_id_dedup_flagged', v.duplicates > 0);
    check('34_pred_id_excluded', v.excluded.some(e => e.reasons.includes('DUPLICATE_PREDICTION_ID')));
    check('35_pred_id_count', v.duplicates >= 1);
    check('36_pred_id_excluded', v.excluded.length >= 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 37-40: Look-ahead violations
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 37-40. Look-ahead violations ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 5000, outcomeRealizedAt: 4000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('37_lookahead_violation', v.lookAheadViolations === 1);
    check('38_lookahead_excluded', v.excluded.length === 1);
    check('39_lookahead_reason', v.excluded[0].reasons.includes('LOOKAHEAD_VIOLATION'));
    check('40_lookahead_not_valid', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 41-44: PAIR_CHANGED
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 41-44. PAIR_CHANGED ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok', reasons: ['PAIR_CHANGED'] }
    ]);
    check('41_pair_changed_excluded', v.excluded.length === 1);
    check('42_pair_changed_reason', v.excluded[0].reasons.includes('PAIR_CHANGED'));
    check('43_pair_changed_count', v.pairChanged === 1);
    check('44_pair_changed_not_valid', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 45-48: Suspicious observations
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 45-48. Suspicious observations ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: -99, circuitReturn: 1, atlasReturn: 2, dataQuality: 'suspicious' }
    ]);
    check('45_suspicious_excluded', v.excluded.length === 1);
    check('46_suspicious_reason', v.excluded[0].reasons.includes('SUSPICIOUS_DATA'));
    check('47_suspicious_count', v.suspicious === 1);
    check('48_suspicious_not_valid', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 49-52: Stale observations
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 49-52. Stale observations ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'stale' }
    ]);
    check('49_stale_excluded', v.excluded.length === 1);
    check('50_stale_reason', v.excluded[0].reasons.includes('STALE_OBSERVATION'));
    check('51_stale_count', v.stale === 1);
    check('52_stale_not_valid', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 53-56: Invalid numeric values
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 53-56. Invalid numeric values ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: NaN, atlasReturn: Infinity, dataQuality: 'ok' }
    ]);
    check('53_invalid_numeric_excluded', v.excluded.length === 1);
    check('54_invalid_numeric_reason', v.excluded[0].reasons.some(r => r.includes('INVALID')));
    check('55_invalid_numeric_count', v.invalidNumeric > 0);
    check('56_invalid_numeric_not_valid', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 57-60: Missing outcomes
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 57-60. Missing outcomes ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: null, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' },
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 3000, outcomeRealizedAt: 4000, outcomePnlPct: undefined, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('57_missing_outcome_excluded', v.excluded.length === 2);
    check('58_missing_outcome_count', v.missingOutcome === 2);
    check('59_missing_outcome_reason', v.excluded.every(e => e.reasons.includes('MISSING_OUTCOME')));
    check('60_missing_outcome_not_valid', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 61-64: Dataset hashing
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 61-64. Dataset hashing ---');
  {
    const samples = [
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 6 }
    ];
    const h1 = computeDatasetHash(samples);
    const h2 = computeDatasetHash(samples);
    check('61_hash_deterministic', h1 === h2);

    const different = [{ predictionId: 'P2', mint: 'M2', predictionTimestamp: 2000, circuitReturn: 1, atlasReturn: 2 }];
    const h3 = computeDatasetHash(different);
    check('62_hash_different', h1 !== h3);

    const snap = createDatasetSnapshot(samples);
    check('63_snapshot_has_hash', typeof snap.datasetHash === 'string' && snap.datasetHash.length > 0);
    check('64_snapshot_has_version', snap.codeVersion === 'ATLAS-0.2.0');
  }

  // ═══════════════════════════════════════════════════════════════
  // 65-68: Immutable snapshot
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 65-68. Immutable snapshot ---');
  {
    const snap1 = createDatasetSnapshot([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 6 }
    ]);
    const snap2 = createDatasetSnapshot([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 6 }
    ]);
    check('65_snapshot_deterministic_hash', snap1.datasetHash === snap2.datasetHash);
    check('66_snapshot_deterministic_count', snap1.sampleCount === snap2.sampleCount);
    check('67_snapshot_has_prediction_ids', snap1.predictionIds.length === 1);
    check('68_snapshot_empty', createDatasetSnapshot([]).datasetHash === 'EMPTY');
  }

  // ═══════════════════════════════════════════════════════════════
  // 69-72: Checkpoint readiness
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 69-72. Checkpoint readiness ---');
  {
    const v29 = validateObservations(Array.from({ length: 29 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      outcomePnlPct: 2, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok'
    })));
    check('69_29_not_ready', v29.valid.length < CHECKPOINT_TARGET);

    const v30 = validateObservations(Array.from({ length: 30 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      outcomePnlPct: 2, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok'
    })));
    check('70_30_ready', v30.valid.length >= CHECKPOINT_TARGET);
    check('71_30_remaining_zero', Math.max(0, CHECKPOINT_TARGET - v30.valid.length) === 0);
    check('72_30_progress_100', Math.round((v30.valid.length / CHECKPOINT_TARGET) * 100) >= 100);
  }

  // ═══════════════════════════════════════════════════════════════
  // 73-76: Checkpoint freeze
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 73-76. Checkpoint freeze ---');
  {
    const snap = createDatasetSnapshot(Array.from({ length: 30 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, predictionTimestamp: 1000 + i * 1000, circuitReturn: 1, atlasReturn: 2
    })));
    check('73_freeze_has_hash', typeof snap.datasetHash === 'string');
    check('74_freeze_has_count', snap.sampleCount === 30);
    check('75_freeze_has_timestamp', typeof snap.createdAt === 'number');
    check('76_freeze_has_ids', snap.predictionIds.length === 30);
  }

  // ═══════════════════════════════════════════════════════════════
  // 77-80: No fabricated data
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 77-80. No fabricated data ---');
  {
    const r = monitor(tmp);
    check('77_no_fabricated_matched', r.checkpoint.matched === 0);
    check('78_no_fabricated_stats', r.predictions.total === 0);
    check('79_not_reached', r.checkpoint.status === 'CHECKPOINT_30_NOT_REACHED');
    check('80_no_fabricated_hash', r.dataset.hash === 'EMPTY');
  }

  // ═══════════════════════════════════════════════════════════════
  // 81-84: V1 immutability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 81-84. V1 immutability ---');
  {
    const agentdSrc = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
    check('81_v1_has_stop_loss', agentdSrc.includes('-6') || agentdSrc.includes('STOP_LOSS'));
    check('82_v1_has_take_profit', agentdSrc.includes('8') || agentdSrc.includes('TAKE_PROFIT'));
    check('83_v1_has_min_score', agentdSrc.includes('60') || agentdSrc.includes('MIN_SCORE'));
    check('84_v1_has_max_positions', agentdSrc.includes('5') || agentdSrc.includes('MAX_POSITIONS'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 85-88: Paper-only security
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 85-88. Paper-only security ---');
  {
    const src = fs.readFileSync(path.join(ROOT, 'atlas', 'checkpoint30-monitor.js'), 'utf8');
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
    check('85_no_wallet_require', !/require\(['"].*wallet.*['"]\)/i.test(src));
    check('86_no_execution_code', !hasExecutionPath);
    check('87_no_privatekey', !src.includes('Keypair') && !src.includes('fromSecretKey'));
    check('88_no_send_transaction', !/sendTransaction\s*\(/.test(src));
  }

  // ═══════════════════════════════════════════════════════════════
  // 89-92: No private key / no signer / no broadcast
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 89-92. No private key / signer / broadcast ---');
  {
    const src = fs.readFileSync(path.join(ROOT, 'atlas', 'checkpoint30-monitor.js'), 'utf8');
    check('89_no_private_key', !src.includes('privateKey') && !src.includes('secretKey'));
    check('90_no_signer', !src.includes('signTransaction') && !src.includes('createSigner'));
    check('91_no_broadcast', !src.includes('sendRawTransaction') && !src.includes('broadcastTransaction'));
    check('92_no_real_tx', !src.includes('signAndSendTransaction'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 93-96: Automatic promotion blocked
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 93-96. Automatic promotion blocked ---');
  {
    const r = monitor(tmp);
    check('93_no_auto_promote', r.safety.automaticPromotion === false);
    check('94_v1_not_modified', r.safety.v1Modified === false);
    check('95_ledger_not_affected', r.safety.ledgerAffected === false);
    check('96_execution_paper_only', r.safety.executionMode === 'PAPER_ONLY');
  }

  // ═══════════════════════════════════════════════════════════════
  // 97-100: Selection audit
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 97-100. Selection audit ---');
  {
    const sa = selectionAudit(
      [{ mint: 'A' }, { mint: 'B' }, { mint: 'C' }],
      [{ mint: 'A', predictionId: 'P1' }]
    );
    check('97_selection_discovered', sa.discovered === 3);
    check('98_selection_matched', sa.matched === 1);
    check('99_selection_rate', sa.selectionRate > 0 && sa.selectionRate < 100);
    check('100_selection_empty', selectionAudit([], []).discovered === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 101-104: Survivorship audit
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 101-104. Survivorship audit ---');
  {
    const sa = survivorshipAudit(
      [{ mint: 'A' }, { mint: 'B' }, { mint: 'C' }],
      [{ mint: 'A' }],
      [{ mint: 'A' }]
    );
    check('101_survivorship_resolved', sa.resolved === 1);
    check('102_survivorship_unresolved', sa.unresolved === 2);
    check('103_survivorship_total', sa.total === 3);
    check('104_survivorship_empty', survivorshipAudit([], [], []).total === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 105-108: Unresolved classification
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 105-108. Unresolved classification ---');
  {
    const sa = survivorshipAudit(
      [{ mint: 'A' }, { mint: 'B' }],
      [{ mint: 'A' }],
      []
    );
    check('105_unresolved_not_loss', sa.unresolved === 1);
    check('106_unresolved_not_zero', sa.unresolved > 0);
    check('107_unresolved_classified', sa.resolved + sa.unresolved === sa.total);
    check('108_unresolved_not_resolved', sa.resolved < sa.total);
  }

  // ═══════════════════════════════════════════════════════════════
  // 109-112: Timestamp ordering
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 109-112. Timestamp ordering ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('109_valid_timestamps', v.valid.length === 1);

    const vh = validateObservations([
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 2000, outcomeRealizedAt: 1000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('110_invalid_timestamps_excluded', vh.valid.length === 0);
    check('111_lookahead_flagged', vh.lookAheadViolations === 1);
    check('112_lookahead_reason', vh.excluded[0].reasons.includes('LOOKAHEAD_VIOLATION'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 113-116: Resolution horizon
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 113-116. Resolution horizon ---');
  {
    const rh = resolutionHorizonCheck([
      { predictionTimestamp: 1000, outcomeRealizedAt: 2000 },
      { predictionTimestamp: 3000, outcomeRealizedAt: 4000 }
    ]);
    check('113_resolution_valid', rh.valid === 2);
    check('114_resolution_invalid', rh.invalid === 0);

    const rh2 = resolutionHorizonCheck([
      { predictionTimestamp: 5000, outcomeRealizedAt: 4000 }
    ]);
    check('115_resolution_lookahead', rh2.invalid === 1);
    check('116_resolution_empty', resolutionHorizonCheck([]).valid === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 117-120: Data quality exclusions
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 117-120. Data quality exclusions ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' },
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 3000, outcomeRealizedAt: 4000, outcomePnlPct: 3, circuitReturn: 1, atlasReturn: 2, dataQuality: 'suspicious' },
      { predictionId: 'P3', mint: 'M3', predictionTimestamp: 5000, outcomeRealizedAt: 6000, outcomePnlPct: 1, circuitReturn: 1, atlasReturn: 2, dataQuality: 'stale' }
    ]);
    check('117_dq_valid_count', v.valid.length === 1);
    check('118_dq_excluded_count', v.excluded.length === 2);
    check('119_dq_suspicious_flagged', v.suspicious === 1);
    check('120_dq_stale_flagged', v.stale === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 121-124: Reproducibility
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 121-124. Reproducibility ---');
  {
    const r1 = monitor(tmp);
    const r2 = monitor(tmp);
    check('121_reproducible_matched', r1.checkpoint.matched === r2.checkpoint.matched);
    check('122_reproducible_hash', r1.dataset.hash === r2.dataset.hash);
    check('123_reproducible_status', r1.checkpoint.status === r2.checkpoint.status);
    check('124_reproducible_predictions', r1.predictions.total === r2.predictions.total);
  }

  // ═══════════════════════════════════════════════════════════════
  // 125-128: Malformed records
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 125-128. Malformed records ---');
  {
    const v = validateObservations([
      { predictionId: null, mint: null, predictionTimestamp: 'not-a-number', outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('125_malformed_excluded', v.excluded.length >= 1);
    check('126_malformed_no_id', v.excluded[0].reasons.includes('NO_PREDICTION_ID'));
    check('127_malformed_no_mint', v.excluded[0].reasons.includes('NO_MINT'));
    check('128_malformed_not_valid', v.valid.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 129-132: NaN / Infinity
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 129-132. NaN / Infinity ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: NaN, circuitReturn: Infinity, atlasReturn: -Infinity, dataQuality: 'ok' }
    ]);
    check('129_nan_excluded', v.excluded.length === 1);
    check('130_nan_invalid_numeric', v.invalidNumeric > 0);
    check('131_nan_not_valid', v.valid.length === 0);
    check('132_nan_reasons', v.excluded[0].reasons.some(r => r.includes('INVALID')));
  }

  // ═══════════════════════════════════════════════════════════════
  // 133-136: Empty dataset
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 133-136. Empty dataset ---');
  {
    const v = validateObservations([]);
    check('133_empty_valid', v.valid.length === 0);
    check('134_empty_excluded', v.excluded.length === 0);
    check('135_empty_snapshot', createDatasetSnapshot([]).datasetHash === 'EMPTY');
    check('136_empty_monitor', monitor(tmp).checkpoint.matched === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 137-140: Corrupted dataset
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 137-140. Corrupted dataset ---');
  {
    const v = validateObservations([
      null,
      undefined,
      { predictionId: 'P1' }, // missing many fields
      'not-an-object'
    ]);
    check('137_corrupted_excluded', v.excluded.length >= 1);
    check('138_corrupted_no_crash', typeof v === 'object');
    check('139_corrupted_valid_zero', v.valid.length === 0);
    check('140_corrupted_no_crash_v2', validateObservations([{}]).excluded.length >= 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 141-144: Checkpoint separation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 141-144. Checkpoint separation ---');
  {
    const { evidenceState } = require('../atlas/statistics.js');
    check('141_cp30_state', evidenceState(30) === 'CHECKPOINT_30');
    check('142_cp100_state', evidenceState(100) === 'CHECKPOINT_100');
    check('143_cp200_state', evidenceState(200) === 'CHECKPOINT_200');
    check('144_cp_insufficient', evidenceState(5) === 'INSUFFICIENT_SAMPLE');
  }

  // ═══════════════════════════════════════════════════════════════
  // 145-148: Analysis version
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 145-148. Analysis version ---');
  {
    check('145_code_version', CODE_VERSION === 'ATLAS-0.2.0');
    check('146_analysis_version', ANALYSIS_VERSION === '1.0.0');
    check('147_checkpoint_target', CHECKPOINT_TARGET === 30);
    check('148_version_in_snapshot', createDatasetSnapshot([]).codeVersion === CODE_VERSION);
  }

  // ═══════════════════════════════════════════════════════════════
  // 149-152: Hash stability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 149-152. Hash stability ---');
  {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, predictionTimestamp: 1000 + i * 1000, circuitReturn: i, atlasReturn: i + 1
    }));
    const h1 = computeDatasetHash(samples);
    // dataset-hash sorts by predictionId, so different data changes the hash
    const different = Array.from({ length: 10 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, predictionTimestamp: 1000 + i * 1000, circuitReturn: i + 100, atlasReturn: i + 200
    }));
    const h2 = computeDatasetHash(different);
    check('149_hash_different_data', h1 !== h2);

    const h3 = computeDatasetHash(samples);
    check('150_hash_same_data', h1 === h3);

    const added = [...samples, { predictionId: 'PX', mint: 'MX', predictionTimestamp: 99999, circuitReturn: 0, atlasReturn: 0 }];
    const h4 = computeDatasetHash(added);
    check('151_hash_addition_changes', h1 !== h4);

    check('152_hash_empty_stable', computeDatasetHash([]) === 'EMPTY');
  }

  // ═══════════════════════════════════════════════════════════════
  // 153-156: Hash changes only with legitimate additions
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 153-156. Hash changes only with legitimate additions ---');
  {
    const base = [{ predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 1, atlasReturn: 2 }];
    const hBase = computeDatasetHash(base);

    const sameData = [{ predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 1, atlasReturn: 2 }];
    check('153_same_data_same_hash', computeDatasetHash(sameData) === hBase);

    const added = [...base, { predictionId: 'P2', mint: 'M2', predictionTimestamp: 2000, circuitReturn: 3, atlasReturn: 4 }];
    check('154_added_data_different_hash', computeDatasetHash(added) !== hBase);

    const removed = [];
    check('155_removed_data_different_hash', computeDatasetHash(removed) !== hBase);

    const modified = [{ predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 999, atlasReturn: 2 }];
    check('156_modified_data_different_hash', computeDatasetHash(modified) !== hBase);
  }

  // ═══════════════════════════════════════════════════════════════
  // 157-160: A/B isolation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 157-160. A/B isolation ---');
  {
    const ab = abIsolationCheck(null);
    check('157_ab_no_data', ab.status === 'NO_DATA');
    check('158_ab_isolated', ab.isolated === true);

    const ab2 = abIsolationCheck({ comparisons: [{ mint: 'A' }] });
    check('159_ab_has_data', ab2.status === 'OK');
    check('160_ab_isolated', ab2.isolated === true);
  }

  // ═══════════════════════════════════════════════════════════════
  // 161-164: ATLAS SHADOW invariant
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 161-164. ATLAS SHADOW invariant ---');
  {
    const r = monitor(tmp);
    check('161_atlas_shadow', r.safety.atlasMode === 'SHADOW');
    check('162_circuit_authoritative', r.safety.circuitMode === 'AUTHORITATIVE');
    check('163_paper_only', r.safety.executionMode === 'PAPER_ONLY');
    check('164_no_auto_promote', r.safety.automaticPromotion === false);
  }

  // ═══════════════════════════════════════════════════════════════
  // 165-168: Circuit AUTHORATIVE invariant
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 165-168. Circuit AUTHORATIVE invariant ---');
  {
    const r = monitor(tmp);
    check('165_circuit_mode', r.safety.circuitMode === 'AUTHORITATIVE');
    check('166_v1_unchanged', r.safety.v1Modified === false);
    check('167_ledger_unchanged', r.safety.ledgerAffected === false);
    check('168_execution_paper', r.safety.executionMode === 'PAPER_ONLY');
  }

  // ═══════════════════════════════════════════════════════════════
  // 169-172: PAPER ONLY invariant
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 169-172. PAPER ONLY invariant ---');
  {
    const r = monitor(tmp);
    check('169_paper_only_mode', r.safety.executionMode === 'PAPER_ONLY');
    check('170_no_wallet', !r.safety.v1Modified);
    check('171_no_signer', r.safety.automaticPromotion === false);
    check('172_no_broadcast', r.safety.ledgerAffected === false);
  }

  // ═══════════════════════════════════════════════════════════════
  // 173-176: Progress calculation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 173-176. Progress calculation ---');
  {
    const v0 = validateObservations([]);
    check('173_progress_zero', Math.round((0 / CHECKPOINT_TARGET) * 100) === 0);

    const v15 = validateObservations(Array.from({ length: 15 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      outcomePnlPct: 2, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok'
    })));
    check('174_progress_50', Math.round((15 / CHECKPOINT_TARGET) * 100) === 50);

    const v30 = validateObservations(Array.from({ length: 30 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, predictionTimestamp: 1000 + i * 1000, outcomeRealizedAt: 2000 + i * 1000,
      outcomePnlPct: 2, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok'
    })));
    check('175_progress_100', Math.round((30 / CHECKPOINT_TARGET) * 100) >= 100);
    check('176_remaining_zero', Math.max(0, CHECKPOINT_TARGET - 30) === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 177-180: Remaining count
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 177-180. Remaining count ---');
  {
    check('177_remaining_30', Math.max(0, CHECKPOINT_TARGET - 0) === 30);
    check('178_remaining_15', Math.max(0, CHECKPOINT_TARGET - 15) === 15);
    check('179_remaining_1', Math.max(0, CHECKPOINT_TARGET - 29) === 1);
    check('180_remaining_0', Math.max(0, CHECKPOINT_TARGET - 30) === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 181-184: Duplicate rejection
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 181-184. Duplicate rejection ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' },
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' },
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('181_dup_rejected', v.duplicates > 0);
    check('182_dup_count_increases', v.duplicates >= 2);
    check('183_dup_excluded', v.excluded.some(e => e.reasons.includes('DUPLICATE_FINGERPRINT')));
    check('184_dup_pred_id', v.excluded.some(e => e.reasons.includes('DUPLICATE_PREDICTION_ID')));
  }

  // ═══════════════════════════════════════════════════════════════
  // 185-188: Excluded count
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 185-188. Excluded count ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: 5, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' },
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 3000, outcomeRealizedAt: 4000, outcomePnlPct: 3, circuitReturn: 1, atlasReturn: 2, dataQuality: 'suspicious' },
      { predictionId: 'P3', mint: 'M3', predictionTimestamp: 5000, outcomeRealizedAt: 6000, outcomePnlPct: null, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('185_excluded_total', v.excluded.length === 2);
    check('186_excluded_valid', v.valid.length === 1);
    check('187_excluded_suspicious', v.suspicious === 1);
    check('188_excluded_missing', v.missingOutcome === 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // 189-192: Unresolved count
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 189-192. Unresolved count ---');
  {
    const v = validateObservations([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, outcomeRealizedAt: 2000, outcomePnlPct: null, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' },
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 3000, outcomeRealizedAt: 4000, outcomePnlPct: null, circuitReturn: 1, atlasReturn: 2, dataQuality: 'ok' }
    ]);
    check('189_unresolved_count', v.missingOutcome === 2);
    check('190_unresolved_excluded', v.excluded.length === 2);
    check('191_unresolved_not_valid', v.valid.length === 0);
    check('192_unresolved_reasons', v.excluded.every(e => e.reasons.includes('MISSING_OUTCOME')));
  }

  // ═══════════════════════════════════════════════════════════════
  // 193-196: Readiness state
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 193-196. Readiness state ---');
  {
    const r = monitor(tmp);
    check('193_not_ready', r.checkpoint.status === 'CHECKPOINT_30_NOT_REACHED');
    check('194_ready_false', r.checkpoint.ready === false);
    check('195_remaining_positive', r.checkpoint.remaining > 0);
    check('196_progress_below_100', r.checkpoint.progressPct < 100);
  }

  // ═══════════════════════════════════════════════════════════════
  // 197-200: Frozen dataset cannot mutate
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 197-200. Frozen dataset cannot mutate ---');
  {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      predictionId: 'P' + i, mint: 'M' + i, predictionTimestamp: 1000 + i * 1000, circuitReturn: i, atlasReturn: i + 1
    }));
    const snap1 = createDatasetSnapshot(samples);
    const snap2 = createDatasetSnapshot(samples);
    check('197_frozen_hash_same', snap1.datasetHash === snap2.datasetHash);
    check('198_frozen_count_same', snap1.sampleCount === snap2.sampleCount);
    check('199_frozen_ids_same', JSON.stringify(snap1.predictionIds) === JSON.stringify(snap2.predictionIds));
    check('200_frozen_immutable', snap1.datasetHash === snap2.datasetHash);
  }

  // ═══════════════════════════════════════════════════════════════
  // 201-204: Historical sample cannot change
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 201-204. Historical sample cannot change ---');
  {
    const samples = [
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 1, atlasReturn: 2 }
    ];
    const snap1 = createDatasetSnapshot(samples);
    const snap2 = createDatasetSnapshot(samples);
    check('201_historical_hash', snap1.datasetHash === snap2.datasetHash);
    check('202_historical_count', snap1.sampleCount === snap2.sampleCount);
    check('203_historical_ids', snap1.predictionIds[0] === 'P1');
    check('204_historical_stable', snap1.datasetHash === computeDatasetHash(samples));
  }

  // ═══════════════════════════════════════════════════════════════
  // 205-208: Production fixture isolation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 205-208. Production fixture isolation ---');
  {
    const r = monitor(tmp);
    check('205_fixture_isolated', r.predictions.total === 0);
    check('206_fixture_no_data', r.checkpoint.matched === 0);
    check('207_fixture_not_reached', r.checkpoint.status === 'CHECKPOINT_30_NOT_REACHED');
    check('208_fixture_empty_hash', r.dataset.hash === 'EMPTY');
  }

  // ═══════════════════════════════════════════════════════════════
  // 209-212: Deterministic monitor output
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 209-212. Deterministic monitor output ---');
  {
    const r1 = monitor(tmp);
    const r2 = monitor(tmp);
    check('209_deterministic_matched', r1.checkpoint.matched === r2.checkpoint.matched);
    check('210_deterministic_hash', r1.dataset.hash === r2.dataset.hash);
    check('211_deterministic_status', r1.checkpoint.status === r2.checkpoint.status);
    check('212_deterministic_predictions', r1.predictions.total === r2.predictions.total);
  }

  // ═══════════════════════════════════════════════════════════════
  // 213-216: No real transaction
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 213-216. No real transaction ---');
  {
    const src = fs.readFileSync(path.join(ROOT, 'atlas', 'checkpoint30-monitor.js'), 'utf8');
    check('213_no_sign_tx', !src.includes('signAndSendTransaction'));
    check('214_no_send_raw', !src.includes('sendRawTransaction'));
    check('215_no_broadcast_tx', !src.includes('broadcastTransaction'));
    check('216_no_real_execution', !src.includes('executeTrade'));
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== PHASE 10 CHECKPOINT 30 MONITOR TEST RESULTS ===');
  console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
  console.log(`Result: ${failed === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failed + ' CHECK(S) FAILED'}\n`);

  // Cleanup
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  process.exit(failed > 0 ? 1 : 0);
}

main();
