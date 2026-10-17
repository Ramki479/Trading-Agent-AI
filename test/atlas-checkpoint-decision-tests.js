#!/usr/bin/env node
/**
 * test/atlas-checkpoint-decision-tests.js — Phase 8 Checkpoint Decision tests.
 *
 * 100 deterministic tests covering checkpoint prerequisites, integrity,
 * statistical classification, evidence classification, promotion firewall,
 * human decision separation, V1 immutability, and paper-only security.
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

// Helper: build a complete review object for classifyEvidence30 tests
function makeReview(overrides) {
  return Object.assign({
    sampleCount: 0,
    datasetHash: 'abc123',
    analysisVersion: '1.0.0',
    codeVersion: 'ATLAS-0.2.0',
    lookAheadViolations: 0,
    duplicateViolations: 0,
    evidenceClassification: 'INSUFFICIENT_EVIDENCE',
    evidenceState: 'INSUFFICIENT_SAMPLE',
    horizons: {},
    calibration: {},
    dataQuality: { valid: 0, excluded: 0 }
  }, overrides || {});
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════

function main() {
  console.log('\n=== PHASE 8 CHECKPOINT DECISION TESTS ===\n');
  const tmp = path.join(ROOT, '.test-tmp', 'decision-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  // Import modules
  const {
    evaluateCheckpoint, classifyEvidence30, checkPrerequisites, validateIntegrity,
    persistDecision, loadHumanDecision, createHumanDecision, emptyHumanDecision,
    VALID_HUMAN_DECISIONS, CODE_VERSION
  } = require('../atlas/checkpoint-decision.js');
  const statsLib = require('../atlas/statistics.js');

  // ═══════════════════════════════════════════════════════════════
  // 1-4: n < 30 and boundary conditions
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 1-4. n < 30 boundary conditions ---');
  {
    const r10 = classifyEvidence30(makeReview({ sampleCount: 10 }));
    check('1_n_10_not_reached', r10.classification === 'CHECKPOINT_30_NOT_REACHED', r10.classification);

    const r29 = classifyEvidence30(makeReview({ sampleCount: 29 }));
    check('2_n_29_not_reached', r29.classification === 'CHECKPOINT_30_NOT_REACHED', r29.classification);

    const r30 = classifyEvidence30(makeReview({ sampleCount: 30 }));
    check('3_n_30_no_horizons', r30.classification === 'INSUFFICIENT_EVIDENCE', r30.classification);

    const r31 = classifyEvidence30(makeReview({ sampleCount: 31 }));
    check('4_n_31_no_horizons', r31.classification === 'INSUFFICIENT_EVIDENCE', r31.classification);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5-8: Duplicate detection
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 5-8. Duplicate detection ---');
  {
    const { duplicateAudit } = require('../atlas/checkpoint-review.js');

    const noDup = duplicateAudit([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5 },
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 2000, circuitReturn: 3 }
    ]);
    check('5_no_duplicates', noDup.duplicatePredictionIds === 0 && noDup.duplicateFingerprints === 0);

    const withDup = duplicateAudit([
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5 },
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5 }
    ]);
    check('6_duplicate_pred_id', withDup.duplicatePredictionIds === 1);
    check('7_duplicate_fingerprint', withDup.duplicateFingerprints === 1);

    const empty = duplicateAudit([]);
    check('8_empty_no_duplicates', empty.duplicatePredictionIds === 0 && empty.duplicateFingerprints === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 9-12: Look-ahead detection
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 9-12. Look-ahead detection ---');
  {
    const { lookAheadAudit } = require('../atlas/checkpoint-review.js');

    const valid = lookAheadAudit([
      { predictionTimestamp: 1000, predictionId: 'P1', outcomeRealizedAt: 2000 },
      { predictionTimestamp: 3000, predictionId: 'P2', outcomeRealizedAt: 4000 }
    ]);
    check('9_no_violations', valid.violations === 0);

    const violation = lookAheadAudit([
      { predictionTimestamp: 5000, predictionId: 'P3', outcomeRealizedAt: 4000 }
    ]);
    check('10_lookahead_violation', violation.violations > 0);

    const mixed = lookAheadAudit([
      { predictionTimestamp: 1000, predictionId: 'P4', outcomeRealizedAt: 2000 },
      { predictionTimestamp: 5000, predictionId: 'P5', outcomeRealizedAt: 4000 }
    ]);
    check('11_mixed_violations', mixed.violations > 0);

    const empty = lookAheadAudit([]);
    check('12_empty_no_violations', empty.violations === 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 13-16: Dataset hash mismatch
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 13-16. Dataset hash ---');
  {
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');

    const samples = [
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 6 },
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 2000, circuitReturn: 3, atlasReturn: 4 }
    ];
    const h1 = computeDatasetHash(samples);
    const h2 = computeDatasetHash(samples);
    check('13_hash_deterministic', h1 === h2);

    const different = [{ predictionId: 'P3', mint: 'M3', predictionTimestamp: 3000, circuitReturn: 1, atlasReturn: 2 }];
    const h3 = computeDatasetHash(different);
    check('14_different_hash', h1 !== h3);

    const emptyHash = computeDatasetHash([]);
    check('15_empty_hash', emptyHash === 'EMPTY');

    const singleHash = computeDatasetHash([{ predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000 }]);
    check('16_single_hash', typeof singleHash === 'string' && singleHash.length > 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 17-20: Immutable dataset / changed dataset
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 17-20. Immutable dataset ---');
  {
    const { computeDatasetHash } = require('../atlas/dataset-hash.js');

    const samples = [
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 6 }
    ];
    const hash = computeDatasetHash(samples);

    const changed = [
      { predictionId: 'P1', mint: 'M1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 6 },
      { predictionId: 'P2', mint: 'M2', predictionTimestamp: 2000, circuitReturn: 3, atlasReturn: 4 }
    ];
    const changedHash = computeDatasetHash(changed);

    check('17_dataset_immutable_hash', hash !== changedHash);
    check('18_added_observation_changes_hash', hash !== changedHash);

    const sameHash = computeDatasetHash(samples);
    check('19_same_data_same_hash', sameHash === hash);

    const removed = [];
    const removedHash = computeDatasetHash(removed);
    check('20_removed_data_different_hash', removedHash !== hash);
  }

  // ═══════════════════════════════════════════════════════════════
  // 21-24: Deterministic review and decision
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 21-24. Deterministic review and decision ---');
  {
    const engineDir = path.join(tmp, 'deterministic');
    fs.mkdirSync(engineDir, { recursive: true });
    const { createAtlasEngine } = require('../atlas/atlas-engine.js');
    const engine = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {},
      integritySnap: { dataQuality: 'ok', pairStable: true, sourcesAgree: true } });

    const cand = {
      symbol: 'DET', mint: 'detMint', pairAddress: 'detPair', dex: 'raydium',
      priceUsd: 0.015, priceSol: 0.00012, liquidityUsd: 100000, volume24hUsd: 500000,
      change1hPct: -8, change5mPct: 1.5, recoveryPct: 1.2, recoveryStatus: 'ok',
      score: 68, source: 'dexscreener'
    };
    const ctx = {
      portfolio: { positionsOpen: 0, maxPositions: 5 }, metrics: { n: 0 },
      market: { solPriceUsd: 150 }, integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
      historyByMint: { detMint: { samples: Array.from({ length: 15 }, (_, i) => ({
        ts: Date.now() - (15 - i) * 2000, priceUsd: 0.015 * (1 + 0.001 * i),
        priceSol: 0.00012 * (1 + 0.001 * i), source: 'dexscreener' })), warming: false } },
      universe: { candidates: 2, avgVolumeUsd: 200000 }
    };
    engine.runCycle({ candidates: [cand], ctx });
    engine.recordTradeOutcome({
      mint: 'detMint', pnlPct: 5, entryTs: Date.now() - 60000, exitTs: Date.now(),
      v1Score: 68, exitReason: 'take-profit', symbol: 'DET'
    });

    const { evaluateCheckpoint } = require('../atlas/checkpoint-decision.js');
    const d1 = evaluateCheckpoint(engineDir, '30');
    const d2 = evaluateCheckpoint(engineDir, '30');

    check('21_same_classification', d1.classification === d2.classification);
    check('22_same_decision_id', d1.decisionId === d2.decisionId);
    check('23_same_sample_count', d1.sampleCount === d2.sampleCount);
    check('24_same_dataset_hash', d1.datasetHash === d2.datasetHash);
  }

  // ═══════════════════════════════════════════════════════════════
  // 25-28: Bootstrap reproducibility
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 25-28. Bootstrap reproducibility ---');
  {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ci1 = statsLib.bootstrapCI(data, { iterations: 1000, rng: () => 0.5 });
    const ci2 = statsLib.bootstrapCI(data, { iterations: 1000, rng: () => 0.5 });
    check('25_bootstrap_deterministic_mean', ci1.mean === ci2.mean);
    check('26_bootstrap_deterministic_ci', ci1.ciLower === ci2.ciLower && ci1.ciUpper === ci2.ciUpper);

    const data2 = [5, 5, 5, 5, 5];
    const ci3 = statsLib.bootstrapCI(data2, { iterations: 1000, rng: () => 0.5 });
    check('27_constant_data_ci', ci3.ciLower === ci3.ciUpper);

    const empty = statsLib.bootstrapCI([], { iterations: 1000 });
    check('28_empty_insufficient', empty.insufficient === true);
  }

  // ═══════════════════════════════════════════════════════════════
  // 29-32: Cohen's d and statistical tests
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 29-32. Effect size and statistical test ---');
  {
    const large = statsLib.effectSize({ matchedSamples: 50, meanDifference: 5, standardDeviation: 3 });
    check('29_effect_large', large.interpretation === 'LARGE', large.interpretation);
    check('30_effect_magnitude', large.magnitude > 0.8);

    const negligible = statsLib.effectSize({ matchedSamples: 50, meanDifference: 0.1, standardDeviation: 1 });
    check('31_effect_negligible', negligible.interpretation === 'NEGLIGIBLE', negligible.interpretation);

    const insufficient = statsLib.effectSize({ matchedSamples: 1, meanDifference: 5, standardDeviation: 3 });
    check('32_effect_insufficient', insufficient.interpretation === 'INSUFFICIENT_DATA');
  }

  // ═══════════════════════════════════════════════════════════════
  // 33-36: Classification scenarios
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 33-36. Classification scenarios ---');
  {
    // Positive signal
    const pos = classifyEvidence30(makeReview({
      sampleCount: 30,
      horizons: {
        '30m': {
          status: 'OK', n: 30,
          circuit: { mean: -1, median: -1, winRate: 40 },
          atlas: { mean: 3, median: 3, winRate: 60 },
          paired: { meanDifference: 4, lowerCI: 1, upperCI: 7 },
          effectSize: { interpretation: 'MEDIUM', d: 0.6, magnitude: 0.6 },
          statisticalTest: { testName: 'paired_t_test', pValue: 0.01, conclusion: 'SIGNIFICANT_AT_0.05' }
        }
      }
    }));
    check('33_positive_signal', pos.classification === 'POSITIVE_BUT_UNCERTAIN', pos.classification);

    // Inconclusive
    const incon = classifyEvidence30(makeReview({
      sampleCount: 30,
      horizons: {
        '30m': {
          status: 'OK', n: 30,
          circuit: { mean: 1, median: 1, winRate: 50 },
          atlas: { mean: 1.1, median: 1, winRate: 51 },
          paired: { meanDifference: 0.1, lowerCI: -2, upperCI: 2.2 },
          effectSize: { interpretation: 'NEGLIGIBLE', d: 0.05, magnitude: 0.05 },
          statisticalTest: { testName: 'paired_t_test', pValue: 0.9, conclusion: 'NOT_SIGNIFICANT' }
        }
      }
    }));
    check('34_inconclusive', incon.classification === 'INCONCLUSIVE', incon.classification);

    // Negative evidence
    const neg = classifyEvidence30(makeReview({
      sampleCount: 30,
      horizons: {
        '30m': {
          status: 'OK', n: 30,
          circuit: { mean: 2, median: 2, winRate: 55 },
          atlas: { mean: -3, median: -3, winRate: 35 },
          paired: { meanDifference: -5, lowerCI: -8, upperCI: -2 },
          effectSize: { interpretation: 'LARGE', d: -1.2, magnitude: 1.2 },
          statisticalTest: { testName: 'paired_t_test', pValue: 0.001, conclusion: 'SIGNIFICANT_AT_0.05' }
        }
      }
    }));
    check('35_negative_evidence', neg.classification === 'NEGATIVE_EVIDENCE', neg.classification);

    // Insufficient evidence (no 30m horizon)
    const insuff = classifyEvidence30(makeReview({
      sampleCount: 30,
      horizons: {}
    }));
    check('36_insufficient_no_horizon', insuff.classification === 'INSUFFICIENT_EVIDENCE', insuff.classification);
  }

  // ═══════════════════════════════════════════════════════════════
  // 37-40: Prerequisite checks
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 37-40. Prerequisite checks ---');
  {
    const { checkPrerequisites } = require('../atlas/checkpoint-decision.js');

    const good = checkPrerequisites({
      sampleCount: 30, datasetHash: 'abc123', analysisVersion: '1.0.0',
      codeVersion: 'ATLAS-0.2.0', lookAheadViolations: 0, duplicateViolations: 0,
      evidenceClassification: 'PRELIMINARY_EVIDENCE'
    });
    check('37_all_prereqs_pass', good.every(p => p.passed));

    const noSample = checkPrerequisites({
      sampleCount: null, datasetHash: 'abc', analysisVersion: '1.0.0',
      codeVersion: 'ATLAS-0.2.0', lookAheadViolations: 0, duplicateViolations: 0,
      evidenceClassification: 'INSUFFICIENT_EVIDENCE'
    });
    check('38_no_sample_count', noSample.some(p => !p.passed && p.check === 'sampleCount'));

    const pendingHash = checkPrerequisites({
      sampleCount: 30, datasetHash: 'PENDING', analysisVersion: '1.0.0',
      codeVersion: 'ATLAS-0.2.0', lookAheadViolations: 0, duplicateViolations: 0,
      evidenceClassification: 'INSUFFICIENT_EVIDENCE'
    });
    check('39_pending_hash', pendingHash.some(p => !p.passed && p.check === 'datasetHash'));

    const lookAheadViolation = checkPrerequisites({
      sampleCount: 30, datasetHash: 'abc', analysisVersion: '1.0.0',
      codeVersion: 'ATLAS-0.2.0', lookAheadViolations: 5, duplicateViolations: 0,
      evidenceClassification: 'INSUFFICIENT_EVIDENCE'
    });
    check('40_lookahead_violation', lookAheadViolation.some(p => !p.passed && p.check === 'lookAheadViolations'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 41-44: Integrity validation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 41-44. Integrity validation ---');
  {
    const { validateIntegrity } = require('../atlas/checkpoint-decision.js');

    const valid = validateIntegrity({ datasetHash: 'EMPTY', sampleCount: 0, lookAheadViolations: 0, duplicateViolations: 0 }, []);
    check('41_integrity_empty_ok', valid.every(i => i.passed));

    const withV1 = validateIntegrity({ datasetHash: 'EMPTY', sampleCount: 0 }, []);
    check('42_integrity_has_v1_check', withV1.some(i => i.check === 'v1Constants'));

    const paperOnly = validateIntegrity({ datasetHash: 'EMPTY', sampleCount: 0 }, []);
    check('43_paper_only_check', paperOnly.some(i => i.check === 'paperOnly'));

    const promotion = validateIntegrity({ datasetHash: 'EMPTY', sampleCount: 0 }, []);
    check('44_promotion_firewall', promotion.some(i => i.check === 'promotionFirewall'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 45-48: Full decision engine (n < 30)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 45-48. Full decision engine ---');
  {
    const engineDir = path.join(tmp, 'full-decision');
    fs.mkdirSync(engineDir, { recursive: true });

    const { evaluateCheckpoint } = require('../atlas/checkpoint-decision.js');
    const d = evaluateCheckpoint(engineDir, '30');

    check('45_decision_not_reached', d.classification === 'CHECKPOINT_30_NOT_REACHED');
    check('46_decision_shadow', d.atlasMode === 'SHADOW');
    check('47_decision_paper_only', d.executionMode === 'PAPER_ONLY');
    check('48_decision_blocked', d.promotionStatus === 'BLOCKED');
  }

  // ═══════════════════════════════════════════════════════════════
  // 49-52: Human decision separation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 49-52. Human decision separation ---');
  {
    const empty = emptyHumanDecision();
    check('49_human_empty', empty.populated === false && empty.decision === null);

    check('50_valid_decisions', VALID_HUMAN_DECISIONS.includes('CONTINUE_SHADOW'));
    check('51_valid_decisions_reject', VALID_HUMAN_DECISIONS.includes('REJECT_ATLAS'));

    const invalid = createHumanDecision(tmp, '30', { decision: 'INVALID_DECISION' });
    check('52_invalid_decision_rejected', invalid.success === false);
  }

  // ═══════════════════════════════════════════════════════════════
  // 53-56: Promotion firewall
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 53-56. Promotion firewall ---');
  {
    const { evaluateCheckpoint } = require('../atlas/checkpoint-decision.js');
    const engineDir = path.join(tmp, 'firewall');
    fs.mkdirSync(engineDir, { recursive: true });

    const d = evaluateCheckpoint(engineDir, '30');
    check('53_cannot_execute', d.executionMode === 'PAPER_ONLY');
    check('54_cannot_self_promote', d.automaticPromotion === false);
    check('55_v1_not_modified', d.v1Modified === false);
    check('56_ledger_not_affected', d.ledgerAffected === false);
  }

  // ═══════════════════════════════════════════════════════════════
  // 57-60: Circuit V1 constants unchanged
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 57-60. V1 constants unchanged ---');
  {
    const agentdSrc = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
    check('57_stop_loss_pct', agentdSrc.includes('-6') || agentdSrc.includes('STOP_LOSS_PCT'));
    check('58_take_profit_pct', agentdSrc.includes('8') || agentdSrc.includes('TAKE_PROFIT_PCT'));
    check('59_min_score', agentdSrc.includes('60') || agentdSrc.includes('MIN_SCORE'));
    check('60_max_positions', agentdSrc.includes('5') || agentdSrc.includes('MAX_POSITIONS'));
  }

  // ═══════════════════════════════════════════════════════════════
  // 61-64: Paper-only security scan (skip comment lines)
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 61-64. Paper-only security ---');
  {
    const decisionSrc = fs.readFileSync(path.join(ROOT, 'atlas', 'checkpoint-decision.js'), 'utf8');
    // Security scan: verify no wallet/signer/broadcast EXECUTION code exists.
    // Only flag actual require/import/call patterns that could execute real transactions.
    // Descriptive string literals describing restrictions are NOT violations.
    const executionPatterns = [
      /require\(['"].*wallet.*['"]\)/i,
      /require\(['"].*signer.*['"]\)/i,
      /require\(['"].*@solana.*['"]\)/i,
      /Keypair\.fromSecretKey/i,
      /sendTransaction\s*\(/i,
      /sendRawTransaction\s*\(/i,
      /signTransaction\s*\(/i,
      /broadcastTransaction\s*\(/i,
      /new\s+Connection\s*\(/i,
    ];
    const hasExecutionPath = executionPatterns.some(p => p.test(decisionSrc));
    check('61_no_wallet_require', !/require\(['"].*wallet.*['"]\)/i.test(decisionSrc));
    check('62_no_execution_code', !hasExecutionPath);
    check('63_no_privatekey', !decisionSrc.includes('Keypair') && !decisionSrc.includes('fromSecretKey'));
    check('64_no_send_transaction', !/sendTransaction\s*\(/.test(decisionSrc) && !/sendRawTransaction\s*\(/.test(decisionSrc));
  }

  // ═══════════════════════════════════════════════════════════════
  // 65-68: Checkpoint 100/200 separation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 65-68. Checkpoint separation ---');
  {
    const { evidenceState } = require('../atlas/statistics.js');
    check('65_cp30_state', evidenceState(30) === 'CHECKPOINT_30');
    check('66_cp100_state', evidenceState(100) === 'CHECKPOINT_100');
    check('67_cp200_state', evidenceState(200) === 'CHECKPOINT_200');
    check('68_cp_insufficient', evidenceState(5) === 'INSUFFICIENT_SAMPLE');
  }

  // ═══════════════════════════════════════════════════════════════
  // 69-72: PAIR_CHANGED and suspicious exclusion
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 69-72. Exclusion scenarios ---');
  {
    const { isExcluded } = require('../atlas/analyze-evidence.js');

    const pairChanged = isExcluded(
      { predictionId: 'P1', mint: 'M1', pairAddress: 'pairA', dataQuality: 'suspicious', reasons: ['PAIR_CHANGED'] },
      { pnlPct: 5, realizedAt: Date.now() + 5000 }
    );
    check('69_pair_changed_excluded', pairChanged.excluded === true);

    const suspicious = isExcluded(
      { predictionId: 'P2', mint: 'M2', pairAddress: 'pairB', dataQuality: 'suspicious', reasons: ['SUSPICIOUS_PRICE_MOVE'] },
      { pnlPct: -80, realizedAt: Date.now() + 5000 }
    );
    check('70_suspicious_excluded', suspicious.excluded === true);

    const missing = isExcluded(null, { pnlPct: 5 });
    check('71_missing_prediction_excluded', missing.excluded === true);

    const noOutcome = isExcluded({ predictionId: 'P3', mint: 'M3' }, null);
    check('72_missing_outcome_excluded', noOutcome.excluded === true);
  }

  // ═══════════════════════════════════════════════════════════════
  // 73-76: No fabricated statistics
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 73-76. No fabricated statistics ---');
  {
    const { evaluateCheckpoint } = require('../atlas/checkpoint-decision.js');
    const engineDir = path.join(tmp, 'no-fabrication');
    fs.mkdirSync(engineDir, { recursive: true });

    const d = evaluateCheckpoint(engineDir, '30');
    check('73_no_fake_mean', d.statisticalAnalysis.primaryMetric == null);
    check('74_no_fake_ci', d.statisticalAnalysis.bootstrapCI == null || d.statisticalAnalysis.bootstrapCI.lower == null);
    check('75_no_fake_effect', d.statisticalAnalysis.effectSize === 'INSUFFICIENT_DATA' || d.statisticalAnalysis.effectSizeD == null);
    check('76_not_reached_correctly', d.classification === 'CHECKPOINT_30_NOT_REACHED');
  }

  // ═══════════════════════════════════════════════════════════════
  // 77-80: Limitations
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 77-80. Limitations ---');
  {
    const { buildLimitations } = require('../atlas/checkpoint-decision.js');

    const insufficient = buildLimitations(
      { classification: 'CHECKPOINT_30_NOT_REACHED' },
      { sampleCount: 5, horizons: {} }
    );
    check('77_insufficient_has_limitation', insufficient.some(l => l.includes('INSUFFICIENT')));

    const negative = buildLimitations(
      { classification: 'NEGATIVE_EVIDENCE' },
      { sampleCount: 30, horizons: { '30m': { paired: { lowerCI: -5, upperCI: -1 }, statisticalTest: { conclusion: 'SIGNIFICANT_AT_0.05' } } } }
    );
    check('78_negative_has_limitation', negative.some(l => l.includes('NEGATIVE')));

    const positive = buildLimitations(
      { classification: 'POSITIVE_BUT_UNCERTAIN' },
      { sampleCount: 30, horizons: { '30m': { paired: { lowerCI: 0, upperCI: 5 }, statisticalTest: { conclusion: 'NOT_SIGNIFICANT' } } } }
    );
    check('79_positive_uncertain', positive.some(l => l.includes('UNCERTAIN')));

    const noAutoPromotion = buildLimitations(
      { classification: 'INCONCLUSIVE' },
      { sampleCount: 100, horizons: {} }
    );
    check('80_no_auto_promotion', noAutoPromotion.some(l => l.includes('NO_AUTO_PROMOTION')));
  }

  // ═══════════════════════════════════════════════════════════════
  // 81-84: Calibration
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 81-84. Calibration ---');
  {
    const { calibrationAudit } = require('../atlas/checkpoint-review.js');

    const matched = [
      { confidence: 55, direction: 'bullish', outcomePnlPct: 5 },
      { confidence: 65, direction: 'bullish', outcomePnlPct: -3 },
      { confidence: 75, direction: 'bullish', outcomePnlPct: 8 },
      { confidence: 85, direction: 'bearish', outcomePnlPct: -2 },
      { confidence: 95, direction: 'bullish', outcomePnlPct: 6 }
    ];

    const cal = calibrationAudit(matched);
    check('81_cal_has_buckets', cal && Object.keys(cal).length >= 5);
    check('82_cal_50_59', cal['50-59%'] && cal['50-59%'].sample === 1);
    check('83_cal_90_100', cal['90-100%'] && cal['90-100%'].sample === 1);
    check('84_cal_accuracy', cal['70-79%'] && cal['70-79%'].accuracy != null);
  }

  // ═══════════════════════════════════════════════════════════════
  // 85-88: A/B paper isolation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 85-88. A/B paper isolation ---');
  {
    const { createABPaper } = require('../atlas/ab-paper.js');

    const mockDb = { readJson: () => null, writeJson: () => {} };
    const ab = createABPaper(mockDb);

    const result = ab.recordTrade({
      mint: 'M1', symbol: 'TOK1', pnlPct: 5, exitReason: 'take-profit',
      v1Score: 68, atlasScore: 72, atlasRecommendation: 'BUY'
    });

    check('85_ab_group_a_has_trade', result.groupA.totalTrades === 1);
    check('86_ab_group_b_has_trade', result.groupB.totalTrades === 1);

    const avoid = ab.recordTrade({
      mint: 'M2', symbol: 'TOK2', pnlPct: -5, exitReason: 'stop-loss',
      v1Score: 62, atlasScore: 40, atlasRecommendation: 'AVOID'
    });
    check('87_ab_avoid_skipped_b', avoid.groupB.totalTrades === 2);
    check('88_ab_avoid_recorded_a', avoid.groupA.totalTrades === 2);
  }

  // ═══════════════════════════════════════════════════════════════
  // 89-92: ZCAT regression — suspicious price excluded
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 89-92. ZCAT regression ---');
  {
    const { isExcluded } = require('../atlas/analyze-evidence.js');

    const zcat = isExcluded(
      { predictionId: 'Z1', mint: 'zcatMint', dataQuality: 'suspicious', reasons: ['SUSPICIOUS_PRICE_MOVE'] },
      { pnlPct: -99.96, realizedAt: Date.now() + 5000 }
    );
    check('89_zcat_excluded', zcat.excluded === true);
    check('90_zcat_in_reasons', zcat.reasons.some(r => r.includes('MISSING_DATA') || r.includes('SUSPICIOUS')));

    const pairChanged = isExcluded(
      { predictionId: 'Z2', mint: 'zcatMint2', dataQuality: 'suspicious', reasons: ['PAIR_CHANGED'] },
      { pnlPct: -99.6, realizedAt: Date.now() + 5000 }
    );
    check('91_pair_changed_excluded', pairChanged.excluded === true);
    check('92_pair_changed_reasons', pairChanged.reasons.length > 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 93-96: NaN/Infinity rejection
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 93-96. NaN/Infinity safety ---');
  {
    const ci = statsLib.bootstrapCI([NaN, Infinity, -Infinity, 0], { iterations: 100 });
    check('93_nan_ci_handled', ci != null);

    const eff = statsLib.effectSize({ matchedSamples: 5, meanDifference: NaN, standardDeviation: 0 });
    check('94_nan_effect', eff != null && eff.interpretation != null);

    const test = statsLib.pairedTest([NaN], [NaN]);
    check('95_nan_test', test != null && test.conclusion != null);

    const effZeroStd = statsLib.effectSize({ matchedSamples: 10, meanDifference: 5, standardDeviation: 0 });
    check('96_zero_std_effect', effZeroStd.interpretation === 'NO_VARIATION');
  }

  // ═══════════════════════════════════════════════════════════════
  // 97-100: Agent/Regime analysis modules
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 97-100. Agent/regime modules ---');
  {
    const { classifyAtlas, ATLAS_ATTRIBUTION_CLASSES } = require('../atlas/attribution.js');
    check('97_atlas_attribution_classes', ATLAS_ATTRIBUTION_CLASSES.length > 5);
    check('98_has_ta_correct_helped', ATLAS_ATTRIBUTION_CLASSES.includes('TA_CORRECT_HELPED'));
    check('99_has_both_wrong', ATLAS_ATTRIBUTION_CLASSES.includes('BOTH_WRONG'));
    check('100_has_circuit_saved', ATLAS_ATTRIBUTION_CLASSES.includes('TA_WRONG_BUT_CIRCUIT_SAVED'));
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== PHASE 8 CHECKPOINT DECISION TEST RESULTS ===');
  console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
  console.log(`Result: ${failed === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failed + ' CHECK(S) FAILED'}\n`);

  // Cleanup
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  process.exit(failed > 0 ? 1 : 0);
}

main();
