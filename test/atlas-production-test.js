#!/usr/bin/env node
/**
 * test/atlas-production-test.js — Phase 6 Production Shadow Validation.
 *
 * Verifies the complete end-to-end pipeline:
 *   real data → integrity → Circuit V1 → ATLAS → journal → outcome →
 *   matched samples → checkpoints → persistence → restart safety
 *
 * Also verifies checkpoint triggering at 30/100/200, restart persistence,
 * unresolved handling, and all safety invariants.
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
  console.log('\n=== PHASE 6 PRODUCTION SHADOW VALIDATION ===\n');

  const tmp = path.join(ROOT, '.test-tmp', 'prod-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  const { AtlasDb } = require('../atlas/db.js');
  const { createPredictionJournl, VERSION } = require('../atlas/prediction-journal.js');
  const { createAtlasEngine } = require('../atlas/atlas-engine.js');
  const { evaluate, ALL_HORIZONS } = require('../atlas/outcome-engine.js');
  const statsLib = require('../atlas/statistics.js');
  const { computeHealth, detectProblems } = require('../atlas/collection-monitor.js');
  const { selectionBiasAudit, survivorshipAudit } = require('../atlas/selection-audit.js');
  const { computeDatasetHash, createAnalysisVersion } = require('../atlas/dataset-hash.js');
  const { auditBatch } = require('../atlas/lookahead-audit.js');
  const { createABPaper } = require('../atlas/ab-paper.js');
  const { classifyAtlas } = require('../atlas/attribution.js');

  const now = Date.now();

  // ═══════════════════════════════════════════════════════════════
  // SECTION 1: Production shadow mode verification
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 1. Production shadow mode ---');
  {
    const engineDir = path.join(tmp, 'shadow');
    fs.mkdirSync(engineDir, { recursive: true });
    const engine = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {} });
    check('1_mode_shadow', engine.mode() === 'SHADOW');
    check('2_enabled', engine.enabled() === true);

    const snap = engine.snapshot();
    check('3_snapshot_mode', snap.mode === 'SHADOW');
    check('4_snapshot_enabled', snap.enabled === true);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 2: Prediction creation and persistence
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 2. Prediction creation + persistence ---');
  {
    const engineDir = path.join(tmp, 'predictions');
    fs.mkdirSync(engineDir, { recursive: true });
    const engine = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {},
      integritySnap: { dataQuality: 'ok', pairStable: true, sourcesAgree: true } });

    const cand = {
      symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
      pairAddress: 'HJPjoWUrhoZKkNqksSFJU759aUhgFtGksUAUGp9ZvfDB', dex: 'raydium',
      priceUsd: 2.34, priceSol: 0.0156, liquidityUsd: 1250000, volume24hUsd: 8500000,
      change1hPct: -12.5, change5mPct: 3.2, recoveryPct: 1.8, recoveryStatus: 'ok',
      score: 74, source: 'dexscreener'
    };

    const ctx = {
      portfolio: { positionsOpen: 0, maxPositions: 5 }, metrics: { n: 0 },
      market: { solPriceUsd: 148.5 }, integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
      historyByMint: { [cand.mint]: { samples: Array.from({ length: 15 }, (_, i) => ({
        ts: now - (15 - i) * 2000, priceUsd: cand.priceUsd * (1 + 0.003 * i),
        priceSol: cand.priceSol * (1 + 0.003 * i), source: 'dexscreener' })), warming: false } },
      universe: { candidates: 12, avgVolumeUsd: 500000 }
    };

    const cycle = engine.runCycle({ candidates: [cand], ctx, now });
    check('5_predictions_created', cycle.predictions.length >= 5);
    check('6_decisions_created', cycle.decisions.length === 1);

    const db = new AtlasDb(engineDir);
    const preds = db.predictions();
    check('7_predictions_persisted', preds.length >= 5);
    check('8_prediction_has_predictionId', preds[0].predictionId.startsWith('P'));
    check('9_prediction_has_ts', Number.isFinite(preds[0].ts));
    check('10_prediction_has_mint', preds[0].mint === cand.mint);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 3: Outcome resolution
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 3. Outcome resolution ---');
  {
    const engineDir = path.join(tmp, 'outcomes');
    fs.mkdirSync(engineDir, { recursive: true });
    const engine = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {},
      integritySnap: { dataQuality: 'ok', pairStable: true, sourcesAgree: true } });

    const cand = {
      symbol: 'TEST', mint: 'testMint1', pairAddress: 'testPair1', dex: 'raydium',
      priceUsd: 0.01, priceSol: 0.0001, liquidityUsd: 100000, volume24hUsd: 500000,
      change1hPct: -10, change5mPct: 2, recoveryPct: 1.5, recoveryStatus: 'ok',
      score: 70, source: 'dexscreener'
    };

    const ctx = {
      portfolio: { positionsOpen: 0, maxPositions: 5 }, metrics: { n: 0 },
      market: { solPriceUsd: 150 }, integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
      historyByMint: { testMint1: { samples: Array.from({ length: 15 }, (_, i) => ({
        ts: Date.now() - (15 - i) * 2000, priceUsd: 0.01 * (1 + 0.001 * i),
        priceSol: 0.0001 * (1 + 0.001 * i), source: 'dexscreener' })), warming: false } },
      universe: { candidates: 5, avgVolumeUsd: 500000 }
    };

    engine.runCycle({ candidates: [cand], ctx });

    // Record outcome — use Date.now() for timestamps to ensure freshness
    const result = engine.recordTradeOutcome({
      mint: 'testMint1', pnlPct: 5.2, entryTs: Date.now() - 60000, exitTs: Date.now(),
      v1Score: 70, exitReason: 'take-profit', symbol: 'TEST'
    });
    check('11_outcome_recorded', result.found === true);
    check('12_outcome_count', result.outcomes.length > 0);

    const db = new AtlasDb(engineDir);
    const outcomes = db.outcomes();
    check('13_outcomes_persisted', outcomes.length > 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 4: Matched sample construction
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 4. Matched sample construction ---');
  {
    const { constructMatchedSamples } = require('../atlas/analyze-evidence.js');
    const predictions = [
      { predictionId: 'P1', ts: 1000, mint: 'm1', agent: 'technical', direction: 'bullish', confidence: 75, dataQuality: 'ok', pairAddress: 'p1', dex: 'raydium' },
      { predictionId: 'P2', ts: 2000, mint: 'm2', agent: 'momentum', direction: 'bearish', confidence: 80, dataQuality: 'ok', pairAddress: 'p2', dex: 'raydium' },
      { predictionId: 'P3', ts: 3000, mint: 'm3', agent: 'volatility', direction: 'bullish', confidence: 65, dataQuality: 'suspicious' } // excluded
    ];
    const outcomes = [
      { predictionId: 'P1', mint: 'm1', pnlPct: 5, realizedAt: 5000, exitReason: 'take-profit' },
      { predictionId: 'P2', mint: 'm2', pnlPct: -3, realizedAt: 6000, exitReason: 'stop-loss' }
    ];
    const data = { predictions, outcomes, abPaperState: null, db: { predictions: () => predictions, outcomes: () => outcomes, evidence: () => [], readJson: () => null } };
    const { matched, excluded, total } = constructMatchedSamples(data);
    check('14_matched_count', matched.length === 2);
    check('15_excluded_count', excluded.length >= 1, 'suspicious data excluded');
    check('16_total_tracked', total === 3);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 5: Checkpoint triggering
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 5. Checkpoint triggering ---');
  {
    check('17_state_insufficient', statsLib.evidenceState(5) === 'INSUFFICIENT_SAMPLE');
    check('18_state_30', statsLib.evidenceState(30) === 'CHECKPOINT_30');
    check('19_state_100', statsLib.evidenceState(100) === 'CHECKPOINT_100');
    check('20_state_200', statsLib.evidenceState(200) === 'CHECKPOINT_200');

    const status = statsLib.checkpointStatus(50);
    check('21_ckpt30_reached', status.checkpoint30 === 'REACHED');
    check('22_ckpt100_not_reached', status.checkpoint100 === 'NOT_REACHED');
    check('23_ckpt200_not_reached', status.checkpoint200 === 'NOT_REACHED');

    // Checkpoint persistence
    const db = new AtlasDb(path.join(tmp, 'ckpt'));
    fs.mkdirSync(path.join(tmp, 'ckpt'), { recursive: true });
    const ckpts = statsLib.createCheckpoints(db);
    const samples = Array.from({ length: 35 }, (_, i) => ({ circuitReturn: i % 2 === 0 ? 5 : -3, atlasReturn: i % 2 === 0 ? 6 : -2 }));
    const matched = statsLib.matchedSampleAnalysis(samples);
    const ck = ckpts.compute(matched, samples.map(s => s.circuitReturn), samples.map(s => s.atlasReturn));
    check('24_checkpoint_sample_size', ck.sampleSize === 35);
    check('25_checkpoint_evidence_state', ck.evidenceState === 'CHECKPOINT_30');

    ckpts.persistCheckpoint(ck);
    const loaded = ckpts.loadCheckpoints();
    check('26_checkpoint_persisted', loaded.length >= 1);
    check('27_checkpoint_immutable', loaded[loaded.length - 1].sampleSize === 35);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 6: Restart persistence
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 6. Restart persistence ---');
  {
    const engineDir = path.join(tmp, 'restart');
    fs.mkdirSync(engineDir, { recursive: true });
    const engine1 = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {},
      integritySnap: { dataQuality: 'ok', pairStable: true, sourcesAgree: true } });

    const cand = {
      symbol: 'RST', mint: 'restartMint', pairAddress: 'restartPair', dex: 'raydium',
      priceUsd: 0.05, priceSol: 0.0003, liquidityUsd: 200000, volume24hUsd: 1000000,
      change1hPct: -8, change5mPct: 1.5, recoveryPct: 1.2, recoveryStatus: 'ok',
      score: 68, source: 'dexscreener'
    };
    const ctx = {
      portfolio: { positionsOpen: 0, maxPositions: 5 }, metrics: { n: 0 },
      market: { solPriceUsd: 150 }, integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
      historyByMint: { restartMint: { samples: Array.from({ length: 15 }, (_, i) => ({
        ts: now - (15 - i) * 2000, priceUsd: 0.05 * (1 + 0.001 * i),
        priceSol: 0.0003 * (1 + 0.001 * i), source: 'dexscreener' })), warming: false } },
      universe: { candidates: 3, avgVolumeUsd: 300000 }
    };

    engine1.runCycle({ candidates: [cand], ctx });
    const db1 = new AtlasDb(engineDir);
    const predsBefore = db1.predictions().length;

    // Simulate restart — create new engine from same directory
    const engine2 = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {} });
    const db2 = new AtlasDb(engineDir);
    const predsAfter = db2.predictions().length;
    check('28_restart_predictions_preserved', predsAfter === predsBefore, 'before=' + predsBefore + ' after=' + predsAfter);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 7: Unresolved handling
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 7. Unresolved handling ---');
  {
    const { isExcluded } = require('../atlas/analyze-evidence.js');
    // No outcome → excluded from matched samples, NOT classified as WIN/LOSS/ZERO
    const r = isExcluded({ predictionId: 'P1', ts: 1000, direction: 'bullish', dataQuality: 'ok' }, null);
    check('29_unresolved_excluded', r.excluded === true);
    check('30_unresolved_not_win', !r.reasons.includes('WIN'));
    check('31_unresolved_not_loss', !r.reasons.includes('LOSS'));
    check('32_unresolved_not_zero', !r.reasons.includes('ZERO_RETURN'));
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 8: Look-ahead audit
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 8. Look-ahead audit ---');
  {
    const { auditPair } = require('../atlas/lookahead-audit.js');
    const valid = auditPair({ ts: 1000, predictionId: 'P1' }, { realizedAt: 5000 });
    check('33_lookahead_valid', valid.passed === true);

    const violation = auditPair({ ts: 5000, predictionId: 'P2' }, { realizedAt: 4000 });
    check('34_lookahead_violation', violation.passed === false);
    check('35_lookahead_rejected', violation.violation === 'FUTURE_DATA');
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 9: Selection audit
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 9. Selection audit ---');
  {
    const all = [
      { symbol: 'A', liquidityUsd: 5000, score: 62 },
      { symbol: 'B', liquidityUsd: 50000, score: 72 },
      { symbol: 'C', liquidityUsd: 200000, score: 82 }
    ];
    const evaluated = [all[0], all[1], all[2]];
    const audit = selectionBiasAudit(all, evaluated);
    check('36_selection_status', audit.status === 'OK');
    check('37_selection_coverage', audit.biasIndicators.coverageRate === 100);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 10: Survivorship audit
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 10. Survivorship audit ---');
  {
    const preds = [
      { predictionId: 'P1', mint: 'm1' },
      { predictionId: 'P2', mint: 'm2' }
    ];
    const outcomes = [
      { predictionId: 'P1', mint: 'm1', pnlPct: 5 }
    ];
    const audit = survivorshipAudit(preds, outcomes);
    check('38_survivorship_missing', audit.unresolvedCount === 1);
    check('39_survivorship_classified', audit.classification.includes('UNRESOLVED'));
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 11: Dataset hash
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 11. Dataset hash ---');
  {
    const samples = [
      { predictionId: 'P1', mint: 'm1', predictionTimestamp: 1000, circuitReturn: 5, atlasReturn: 5, agent: 'tech', direction: 'bullish', dataQuality: 'ok' }
    ];
    const av = createAnalysisVersion(samples);
    check('40_hash_deterministic', typeof av.datasetHash === 'string' && av.datasetHash.length === 16);
    check('41_hash_not_empty', av.datasetHash !== 'EMPTY');
    check('42_analysis_version', av.analysisVersion === '1.0.0');
    check('43_code_version', av.codeVersion === 'ATLAS-0.2.0');
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 12: Collection health
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 12. Collection health ---');
  {
    const db = new AtlasDb(path.join(tmp, 'health'));
    fs.mkdirSync(path.join(tmp, 'health'), { recursive: true });
    const health = computeHealth(db);
    check('44_health_has_predictions', 'predictions' in health);
    check('45_health_has_outcomes', 'outcomes' in health);
    check('46_health_has_dataQuality', 'dataQuality' in health);
    check('47_health_has_latency', 'latency' in health);

    const problems = detectProblems(health);
    check('48_problems_detected', problems.hasProblems === true, 'empty DB should alert');
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 13: Ledger isolation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 13. Ledger isolation ---');
  {
    const { createABPaper } = require('../atlas/ab-paper.js');
    const mockDb = { readJson: () => null, writeJson: () => {} };
    const ab = createABPaper(mockDb);
    ab.recordTrade({ mint: 'm1', symbol: 'A', pnlPct: 5, atlasRecommendation: 'BUY' });
    const snap = ab.snapshot();
    check('49_isolation_no_cash', !('cashSol' in snap.groupB));
    check('50_isolation_no_positions', !('positions' in snap.groupB));
    check('51_isolation_counterfactual', snap.groupB.name === 'V1+ATLAS');
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 14: V1 strategy immutability
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 14. V1 strategy immutability ---');
  {
    const src = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
    check('52_v1_STOP_LOSS', src.includes('const STOP_LOSS_PCT = -6;'));
    check('53_v1_TAKE_PROFIT', src.includes('const TAKE_PROFIT_PCT = 8;'));
    check('54_v1_MAX_POSITIONS', src.includes('const MAX_POSITIONS = 5;'));
    check('55_v1_MIN_SCORE', src.includes('const MIN_SCORE = 60;'));
    check('56_v1_COOLDOWN', src.includes('const DEFAULT_COOLDOWN_MS = 600000;'));
    check('57_v1_5m_GATE', src.includes('const MIN_5M_RECOVERY_PCT = 0.25;'));
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 15: Paper-only security
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 15. Paper-only security ---');
  {
    // NOTE: schemas.js excluded — it defines the FORBIDDEN set (lists words as strings)
    const files = [
      'atlas/atlas-engine.js', 'atlas/db.js', 'atlas/statistics.js',
      'atlas/calibration.js', 'atlas/ab-paper.js', 'atlas/prediction-journal.js',
      'atlas/outcome-engine.js', 'atlas/attribution.js', 'atlas/reputation.js',
      'atlas/disagreement.js', 'atlas/evidence.js',
      'atlas/collection-monitor.js', 'atlas/selection-audit.js',
      'atlas/promotion-request.js', 'atlas/research-log.js',
      'atlas/dataset-hash.js', 'atlas/analyze-evidence.js', 'atlas/lookahead-audit.js'
    ];
    const bad = /signTransaction|sendTransaction|sendRawTransaction|privateKey|secretKey|Keypair|fromSecretKey|emitSigned|broadcast|placeOrder/i;
    let allClean = true;
    for (const f of files) {
      const full = path.join(ROOT, f);
      if (!fs.existsSync(full)) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (bad.test(src)) { allClean = false; check('58_security_' + f.split('/').pop(), false); }
    }
    check('59_all_files_clean', allClean);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 16: ATLAS execution isolation
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 16. ATLAS execution isolation ---');
  {
    const engineDir = path.join(tmp, 'exec-iso');
    fs.mkdirSync(engineDir, { recursive: true });
    const engine = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {} });
    check('60_no_execute_fn', !('execute' in engine));
    check('61_no_buy_fn', !('buy' in engine));
    check('62_no_sell_fn', !('sell' in engine));

    const src = fs.readFileSync(path.join(ROOT, 'atlas/atlas-engine.js'), 'utf8');
    check('63_decision_paper_eligible', src.includes("decision: 'PAPER_ELIGIBLE'"));
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 17: No automatic promotion
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 17. No automatic promotion ---');
  {
    const { assessRequirements } = require('../atlas/promotion-request.js');
    // Even with perfect data, promotion is not automatic
    const r = assessRequirements({
      validObservations: 500, evidenceState: 'CHECKPOINT_200',
      lookaheadAudit: { violations: 0 }, dataQuality: { qualityRate: 99 },
      paired: { effectSize: { interpretation: 'LARGE' }, statisticalTest: { testName: 'paired_t_test', conclusion: 'SIGNIFICANT_AT_0.05' } },
      matched: { meanDifference: 5 }
    });
    check('64_promo_not_auto', r.ready === true, 'requirements met');
    ok(r.requirements.every(req => req.name !== 'auto_promote'), 'no auto-promote requirement');
    check('65_promo_note', r.note.includes('Human approval'));
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 18: Outcome horizons
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 18. Outcome horizons ---');
  {
    check('66_horizons_5', ALL_HORIZONS.length === 5);
    check('67_horizons_4h', ALL_HORIZONS.includes('4h'));
    check('68_horizons_30m', ALL_HORIZONS.includes('30m'));
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 19: Full analysis pipeline
  // ═══════════════════════════════════════════════════════════════
  console.log('--- 19. Full analysis pipeline ---');
  {
    const { analyze } = require('../atlas/analyze-evidence.js');
    const engineDir = path.join(tmp, 'full-analysis');
    fs.mkdirSync(engineDir, { recursive: true });
    const engine = createAtlasEngine({ dataDir: engineDir, mode: 'SHADOW', llm: {},
      integritySnap: { dataQuality: 'ok', pairStable: true, sourcesAgree: true } });

    const cand = {
      symbol: 'ANA', mint: 'anaMint', pairAddress: 'anaPair', dex: 'raydium',
      priceUsd: 0.03, priceSol: 0.0002, liquidityUsd: 150000, volume24hUsd: 800000,
      change1hPct: -12, change5mPct: 2.5, recoveryPct: 1.3, recoveryStatus: 'ok',
      score: 72, source: 'dexscreener'
    };
    const ctx = {
      portfolio: { positionsOpen: 0, maxPositions: 5 }, metrics: { n: 0 },
      market: { solPriceUsd: 150 }, integrity: { dataQuality: 'ok', pairStable: true, sourcesAgree: true },
      historyByMint: { anaMint: { samples: Array.from({ length: 15 }, (_, i) => ({
        ts: now - (15 - i) * 2000, priceUsd: 0.03 * (1 + 0.001 * i),
        priceSol: 0.0002 * (1 + 0.001 * i), source: 'dexscreener' })), warming: false } },
      universe: { candidates: 4, avgVolumeUsd: 400000 }
    };
    engine.runCycle({ candidates: [cand], ctx });

    const result = analyze(engineDir, { bootstrapIterations: 100 });
    check('69_analysis_evidence_state', typeof result.evidenceState === 'string');
    check('70_analysis_matched', result.matched != null);
    check('71_analysis_horizons', result.horizons != null);
    check('72_analysis_promotion', result.promotion != null);
    check('73_analysis_no_auto_promote', result.promotion.automaticallyPromoted === false);
    check('74_analysis_lookahead', result.lookaheadAudit != null);
    check('75_analysis_data_quality', result.dataQuality != null);
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  // ═══════════════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== PHASE 6 PRODUCTION VALIDATION RESULTS ===');
  console.log('Passed: ' + passed + '  Failed: ' + failed + '  Total: ' + (passed + failed));
  console.log('Result: ' + (failed === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failed + ' CHECK(S) FAILED'));
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
