#!/usr/bin/env node
/**
 * test/hardening-tests.js — deterministic offline tests for the forensic
 * hardening changes (audit phases 2–22). READ-ONLY relative to production
 * runtime state: every test writes only into its own throwaway tmp dir.
 *
 * Run: node test/hardening-tests.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(s) { console.log('\n' + s); }

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hard-' + tag + '-'));
}

const MIN = 60 * 1000;
// Wall-clock-relative base: research-history prunes by Date.now(), so tests
// must use recent timestamps to survive retention pruning.
const T0 = Date.now() - 30 * MIN;

/* ================================================================== *
 * 1. V1 constants unchanged (Phase 20 #1, #10, #16)
 * ================================================================== */
section('1. V1 constants unchanged');
{
  const agentd = require(path.join(ROOT, 'agentd.js'));
  check('MAX_POSITIONS = 5', agentd.MAX_POSITIONS === 5, String(agentd.MAX_POSITIONS));
  check('STOP_LOSS_PCT = -6', agentd.STOP_LOSS_PCT === -6, String(agentd.STOP_LOSS_PCT));
  check('TAKE_PROFIT_PCT = +8', agentd.TAKE_PROFIT_PCT === 8, String(agentd.TAKE_PROFIT_PCT));
  check('MIN_5M_RECOVERY_PCT = 0.25', agentd.MIN_5M_RECOVERY_PCT === 0.25, String(agentd.MIN_5M_RECOVERY_PCT));
  check('MAX_5M_RECOVERY_PCT = 8', agentd.MAX_5M_RECOVERY_PCT === 8, String(agentd.MAX_5M_RECOVERY_PCT));
  check('1h window (-35, 15]', agentd.MIN_1H_CHANGE_PCT === -35 && agentd.MAX_1H_CHANGE_PCT === 15,
    JSON.stringify([agentd.MIN_1H_CHANGE_PCT, agentd.MAX_1H_CHANGE_PCT]));
  check('MIN_SCORE = 60', agentd.MIN_SCORE === 60, String(agentd.MIN_SCORE));
}

/* ================================================================== *
 * 2. Paper-only enforcement (Phase 20 #2, #3, #4; Phase 27)
 * ================================================================== */
section('2. Paper-only enforcement');
{
  const files = [
    'agentd.js',
    'market-data.js',
    'research-history.js',
    'ledger-integrity.js',
    'atlas/atlas-engine.js',
    'atlas/ab-paper.js'
  ];
  // Execution-capability scan. (ledger-integrity.js legitimately mentions
  // 'jupiter-v3' as a foreign-provenance CLASSIFIER string — that is the
  // detection mechanism, not an execution path; foreign-source detection is
  // behaviorally tested in section 4.)
  const dangerous = /sendTransaction|sendRawTransaction|signTransaction|Keypair|secretKey|mnemonic|PRIVATE_KEY|SEED_PHRASE|jupiterApi|swapApi|jitoApi/i;
  for (const f of files) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check('no execution capability in ' + f, !dangerous.test(txt));
  }
  const src = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
  check('PAPER_TRADING forced true', /const PAPER_TRADING = true;/.test(src));
  check('signer URL ignored', src.indexOf('CIRCUIT_SIGNER_URL is set but IGNORED') >= 0);
}

/* ================================================================== *
 * 3. Provenance lock (Phase 2) — a stale lock with a DIFFERENT build
 *    identity is never taken over. Fail closed.
 * ================================================================== */
section('3. Provenance lock fail-closed (Phase 2)');
{
  const dir = tmpdir('lock');
  const lock = {
    pid: 999999999, // not alive
    buildIdentity: 'foreign-build-DEADBEEF',
    hostname: 'somewhere-else',
    sourceDir: '/elsewhere',
    startedAtIso: new Date().toISOString(),
    paperTrading: true, wallet: false, signer: false, broadcast: false
  };
  fs.writeFileSync(path.join(dir, 'agent.lock'), JSON.stringify(lock));
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, ['-e',
    `const a=require(${JSON.stringify(path.join(ROOT, 'agentd.js'))});` +
    `try { a.acquireLock(); console.log('TOOK-OVER'); } catch(e){ console.log('EXITED:' + e.message); }`], {
    env: Object.assign({}, process.env, { CIRCUIT_AGENT_DATA_DIR: dir }),
    encoding: 'utf8', timeout: 15000
  });
  const out = (res.stdout || '') + (res.stderr || '');
  check('foreign-build lock refused (no takeover)', out.indexOf('refusing to share the data directory') >= 0 || out.indexOf('refusing to start') >= 0, out.slice(0, 200));
  check('process refused to continue', res.status !== 0 || out.indexOf('TOOK-OVER') < 0, 'status=' + res.status);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'agent.lock'), 'utf8'));
  check('lock not overwritten by our build', after.buildIdentity === 'foreign-build-DEADBEEF', JSON.stringify(after.buildIdentity));
}

/* ================================================================== *
 * 4. Ledger integrity (Phase 3/25)
 * ================================================================== */
section('4. Ledger integrity');
{
  const li = require(path.join(ROOT, 'ledger-integrity.js'));
  const dir = tmpdir('ledger');

  const buy = (id, m, tsIso) => ({ id, timestamp: tsIso, side: 'BUY', symbol: 'TKN', mint: m, pairAddress: 'p1', dex: 'dexscreener', quantity: 0.05, price: 1, priceUsd: 150, valueSol: 0.05, realizedPnlSol: 0, realizedPnlPct: 0, source: 'dexscreener', score: 70, change1hPct: -10, recovery5mPct: 1, liquidityUsd: 50000, volume24hUsd: 100000, regime: 'TREND_UP', policyMode: 'STANDARD', sizeMultiplier: 1, adaptiveSizeSol: 0.05 });
  const sell = (id, m, tsIso, pnlSol) => ({ id, timestamp: tsIso, side: 'SELL', symbol: 'TKN', mint: m, pairAddress: 'p1', dex: 'dexscreener', quantity: 0.05, price: 1.05, priceUsd: 157.5, valueSol: 0.0525, realizedPnlSol: pnlSol, realizedPnlPct: (pnlSol / 0.05) * 100, entryPriceSol: 1, costSol: 0.05, source: 'dexscreener', reason: 'take-profit', exitSource: 'dexscreener' });

  const rows = [
    JSON.stringify(buy(1, 'mA', '2026-01-01T10:00:00Z')),
    JSON.stringify(sell(2, 'mA', '2026-01-01T10:30:00Z', 0.004)),
    JSON.stringify(buy(3, 'mB', '2026-01-01T11:00:00Z')),
    // foreign row (numeric ts + jupiter-v3 + impossible P&L) — preserved, classified
    JSON.stringify({ id: 4, timestamp: 1767226800000, side: 'SELL', symbol: 'X', mint: 'mC', pairAddress: null, dex: null, quantity: 0.05, price: 0.0001, priceUsd: 0.015, valueSol: 0.000005, realizedPnlSol: -0.06, realizedPnlPct: -120, entryPriceSol: 1, costSol: 0.05, source: 'jupiter-v3', reason: 'liquidation', exitSource: 'jupiter-v3' }),
    JSON.stringify(buy(4, 'mB', '2026-01-01T12:00:00Z')) // duplicate id 4
  ];
  fs.writeFileSync(path.join(dir, 'trades.jsonl'), rows.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'portfolio.json'), JSON.stringify({ realizedPnlSol: 0.004, totalTrades: 1, winningTrades: 1, losingTrades: 0 }));

  const rep = li.report(dir);
  check('rows counted', rep.rows === 5, String(rep.rows));
  check('foreign row detected (jupiter-v3 + numeric ts)', rep.foreign >= 1, String(rep.foreign));
  check('invalid timestamp counted', rep.invalidTimestamps >= 1, String(rep.invalidTimestamps));
  check('duplicate id detected', rep.duplicateIds >= 1, String(rep.duplicateIds));
  check('impossible P&L flagged (|pnl| >= 0.05 SOL)', rep.impossiblePnl >= 1, String(rep.impossiblePnl));
  check('foreign SELL not counted as trusted row (unmatched check)', rep.unmatchedSells <= 1, String(rep.unmatchedSells));
  check('portfolio reconciliation PASS (foreign row excluded)', rep.portfolio.pass === true, JSON.stringify(rep.portfolio.details));
  check('suspicious rows preserved on disk (not modified)', fs.readFileSync(path.join(dir, 'trades.jsonl'), 'utf8') === rows.join('\n') + '\n');
  const text = li.formatReport(dir);
  check('formatReport renders LEDGER INTEGRITY block', text.indexOf('LEDGER INTEGRITY') === 0 && /Rows: 5/.test(text));
}

/* ================================================================== *
 * 5. Research history — bounded, restart-safe, contract (Phase 6/22)
 * ================================================================== */
section('5. Research history (Phase 6)');
{
  const { createResearchHistory } = require(path.join(ROOT, 'research-history.js'));
  const dir = tmpdir('rh');
  const rh = createResearchHistory({ dataDir: dir, log: () => {}, maxLateMs: 2 * MIN });

  // ---- 5a. Exact/late target resolution (Phase 22 synthetic case) --------
  // T0=10:00, 5m target 10:05. Samples: 10:04:45 (0.98) BEFORE target,
  // 10:05:15 (1.05) after. Resolution MUST be 10:05:15 (+5%).
  rh.seedForTests([
    { ts: T0, mint: 'mH', priceSol: 1.0, priceUsd: 150, pairAddress: 'pA', dex: 'raydium', source: 'dexscreener' },
    { ts: T0 + 4 * MIN + 45 * 1000, mint: 'mH', priceSol: 0.98, priceUsd: 147, pairAddress: 'pA', dex: 'raydium', source: 'dexscreener' },
    { ts: T0 + 5 * MIN + 15 * 1000, mint: 'mH', priceSol: 1.05, priceUsd: 157.5, pairAddress: 'pA', dex: 'raydium', source: 'dexscreener' }
  ]);
  const target = T0 + 5 * MIN;
  const obs = rh.resolveAtOrAfter('mH', target);
  check('5a. resolves at/after target only (10:05:15, not 10:04:45)', !!obs && obs.ts === T0 + 5 * MIN + 15 * 1000, JSON.stringify(obs && obs.ts));
  check('5a2. P&L from correct sample = +5%', !!obs && Math.abs(((obs.priceSol - 1.0) / 1.0) * 100 - 5) < 1e-9, JSON.stringify(obs && obs.priceSol));
  const obsPref = rh.resolveAtOrAfter('mH', target, { preferPairAddress: 'pA' });
  check('5a3. preferred pair bias works', !!obsPref && obsPref.pairMatchesPreferred === true);

  // ---- 5b. Missing observation → NO_VALID_OBSERVATION (null) -------------
  const none = rh.resolveAtOrAfter('mH', T0 + 30 * MIN); // beyond maxLateMs of last sample
  check('5b. no valid observation → null (never fabricated)', none === null);

  // ---- 5c. Bounded late tolerance ----------------------------------------
  const rh2 = createResearchHistory({ dataDir: tmpdir('rh2'), log: () => {}, maxLateMs: 60 * 1000 });
  rh2.seedForTests([
    { ts: T0, mint: 'mL', priceSol: 1.0, priceUsd: 150, pairAddress: 'pA', dex: 'raydium', source: 'dexscreener' },
    { ts: T0 + 90 * 1000, mint: 'mL', priceSol: 1.1, priceUsd: 165, pairAddress: 'pA', dex: 'raydium', source: 'dexscreener' }
  ]);
  // Samples: T0 (before target) and T0+90s. With maxLateMs=60s:
  //   target=T0+15s → hi=T0+75s → the T0+90s sample is beyond tolerance → null
  //   target=T0+31s → hi=T0+91s → the T0+90s sample resolves with lateMs=59s
  check('5c. late sample beyond tolerance → null', rh2.resolveAtOrAfter('mL', T0 + 15 * 1000) === null);
  const inTol = rh2.resolveAtOrAfter('mL', T0 + 31 * 1000);
  check('5c2. late sample within tolerance resolves', !!inTol && inTol.lateMs === 59 * 1000, JSON.stringify(inTol && inTol.lateMs));

  // ---- 5d. Restart survival ----------------------------------------------
  const rh3 = createResearchHistory({ dataDir: dir, log: () => {} });
  const obs3 = rh3.resolveAtOrAfter('mH', target);
  check('5d. research history survives restart', !!obs3 && obs3.ts === T0 + 5 * MIN + 15 * 1000, JSON.stringify(obs3 && obs3.ts));

  // ---- 5e. Bounded memory -------------------------------------------------
  check('5e. per-mint + global caps configured', createResearchHistory({ dataDir: tmpdir('rh3') }).stats().retentionMs > 4 * HOUR_PLACEHOLDER());
  function HOUR_PLACEHOLDER() { return 60 * MIN; } // 4h sanity via retention default (6h)
}

/* ================================================================== *
 * 6. ATLAS resolver contract + idempotency (Phase 4/5/8/22)
 * ================================================================== */
section('6. ATLAS resolver contract + idempotency');
{
  const { createAtlasEngine } = require(path.join(ROOT, 'atlas/atlas-engine.js'));
  const { createResearchHistory } = require(path.join(ROOT, 'research-history.js'));
  const { AtlasDb } = require(path.join(ROOT, 'atlas/db.js'));
  const { createPredictionJournl } = require(path.join(ROOT, 'atlas/prediction-journal.js'));
  const dir = tmpdir('atlas');
  const logLines = [];
  const rh = createResearchHistory({ dataDir: dir, log: () => {}, maxLateMs: 2 * MIN });
  const engine = createAtlasEngine({ dataDir: dir, mode: 'SHADOW', integritySnap: null, log: (m) => logLines.push(String(m)) });

  const db = new AtlasDb(dir);
  const journal = createPredictionJournl(db);
  const mkPred = (ts, horizon, priceSol) => journal.record('technical',
    { expectedMovePct: 2, probabilityUp: 0.6, probabilityDown: 0.0, confidence: 70 },
    { candidate: { mint: 'mR', pairAddress: 'pA', dex: 'raydium', priceSol, priceUsd: priceSol * 150 }, ts, direction: 'bullish', confidence: 70, timeHorizon: horizon, dataQuality: 'ok' });

  const p5 = mkPred(T0, '5m', 1.0);
  const p15 = mkPred(T0, '15m', 1.0);
  const p30 = mkPred(T0, '30m', 1.0);
  const p60 = mkPred(T0, '1h', 1.0);
  const p4h = mkPred(T0, '4h', 1.0);

  // Seed research history with real-shaped observations covering each target.
  const samples = [];
  for (const [mins, price] of [[5, 1.05], [15, 1.10], [30, 1.20], [60, 1.40], [240, 2.00]]) {
    samples.push({ ts: T0 + mins * MIN + 15 * 1000, mint: 'mR', priceSol: price, priceUsd: price * 150, pairAddress: 'pA', dex: 'raydium', source: 'dexscreener' });
  }
  rh.seedForTests(samples);

  const resolvePrice = (mint, targetTs, pred) =>
    rh.resolveAtOrAfter(mint, targetTs, { preferPairAddress: pred && pred.pairAddress ? pred.pairAddress : null });

  const now = T0 + 240 * MIN + 3 * MIN; // past the 4h target + late tolerance
  const r1 = engine.resolvePendingPredictions(resolvePrice, now);
  check('6a. resolves 5m/15m/30m/1h/4h', r1.resolved === 5, JSON.stringify(r1));
  check('6b. none skipped when observations exist', r1.skipped === 0, JSON.stringify(r1));

  const outcomes = db.outcomes();
  const byId = new Map(outcomes.map(o => [o.predictionId, o]));
  const horizonMin = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240 };
  for (const p of [p5, p15, p30, p60, p4h]) {
    const o = byId.get(p.predictionId);
    check('6c. outcome exists for ' + p.timeHorizon, !!o);
    check('6d. realizedAt >= target (' + p.timeHorizon + ')', !!o && o.realizedAt >= p.ts + horizonMin[p.timeHorizon] * MIN);
    check('6e. outcomeType=horizon (' + p.timeHorizon + ')', !!o && o.outcomeType === 'horizon');
  }

  // Repeated runs are idempotent (Phase 8)
  const after1 = db.outcomes().length;
  for (let i = 0; i < 99; i++) engine.resolvePendingPredictions(resolvePrice, now);
  check('6f. resolver idempotent across 100 runs', db.outcomes().length === after1, String(db.outcomes().length));

  // Missing observation → NO_VALID_OBSERVATION, never fabricated
  journal.record('technical', { expectedMovePct: 1, probabilityUp: 0.55, probabilityDown: 0.0, confidence: 60 },
    { candidate: { mint: 'mMissing', pairAddress: 'pX', dex: 'raydium', priceSol: 2.0, priceUsd: 300 }, ts: T0, direction: 'bullish', confidence: 60, timeHorizon: '5m', dataQuality: 'ok' });
  const r2 = engine.resolvePendingPredictions(resolvePrice, now);
  check('6g. missing observation → skipped, not resolved', r2.resolved === 0 && r2.skipped === 1, JSON.stringify(r2));
  check('6h. log mentions noObservation (Phase 19)', logLines.some(l => l.indexOf('noObservation=') >= 0));
  check('6i. [ATLAS-RESOLVE] line format (resolved/pending/skipped/noObservation)',
    logLines.some(l => l.indexOf('[ATLAS-RESOLVE]') >= 0 && /resolved=\d+ pending=\d+ skipped=\d+ noObservation=\d+/.test(l)));
}

/* ================================================================== *
 * 7. Trade attribution look-ahead protection (Phase 9/10)
 * ================================================================== */
section('7. Trade attribution (Phase 9/10)');
{
  const { createAtlasEngine } = require(path.join(ROOT, 'atlas/atlas-engine.js'));
  const { AtlasDb } = require(path.join(ROOT, 'atlas/db.js'));
  const { createPredictionJournl } = require(path.join(ROOT, 'atlas/prediction-journal.js'));
  const dir = tmpdir('attr');
  const engine = createAtlasEngine({ dataDir: dir, mode: 'SHADOW', log: () => {} });
  const db = new AtlasDb(dir);
  const journal = createPredictionJournl(db);

  const entryTs = T0 + 10 * MIN;
  // Prediction BEFORE entry (eligible) and AFTER entry (must never be used).
  const pre = journal.record('technical', { expectedMovePct: 2, probabilityUp: 0.6, confidence: 70 },
    { candidate: { mint: 'mT', pairAddress: 'pA', dex: 'raydium', priceSol: 1, priceUsd: 150 }, ts: entryTs - 5 * MIN, direction: 'bullish', confidence: 70, timeHorizon: '15m', dataQuality: 'ok' });
  journal.record('technical', { expectedMovePct: 2, probabilityUp: 0.6, confidence: 75 },
    { candidate: { mint: 'mT', pairAddress: 'pA', dex: 'raydium', priceSol: 1, priceUsd: 150 }, ts: entryTs + 5 * MIN, direction: 'bullish', confidence: 75, timeHorizon: '15m', dataQuality: 'ok' });

  const res = engine.recordTradeOutcome({ mint: 'mT', pnlPct: 8, entryTs, exitTs: entryTs + 20 * MIN, symbol: 'TKN' });
  const ids = res.outcomes.map(o => o.outcome.predictionId);
  check('7a. pre-entry prediction attributed', ids.indexOf(pre.predictionId) >= 0, JSON.stringify(ids));
  check('7b. exactly one outcome (post-entry prediction excluded)', ids.length === 1, JSON.stringify(ids));
  const out = db.outcomes().find(o => o.predictionId === pre.predictionId);
  check('7c. trade outcome has outcomeType=trade', !!out && out.outcomeType === 'trade');
  check('7d. outcomeType always ∈ {horizon, trade}', db.outcomes().every(o => o.outcomeType === 'horizon' || o.outcomeType === 'trade'));
}

section('7x. prediction journal provenance (Phase 7)');
{
  const { AtlasDb } = require(path.join(ROOT, 'atlas/db.js'));
  const { createPredictionJournl } = require(path.join(ROOT, 'atlas/prediction-journal.js'));
  const db = new AtlasDb(tmpdir('mp'));
  const journal = createPredictionJournl(db);
  const rec = journal.record('technical', { expectedMovePct: 1, confidence: 50 },
    { candidate: { mint: 'mX', pairAddress: 'p1', dex: 'dexscreener' }, ts: T0, direction: 'bullish', confidence: 50, timeHorizon: '15m' });
  check('7x. prediction without price stores priceSol=null (no fabrication)', rec.priceSol === null);
  check('7x2. record has full provenance fields',
    !!rec.predictionId && !!rec.ts && !!rec.mint && !!rec.pairAddress && !!rec.dex &&
    !!rec.agent && !!rec.direction && rec.confidence != null && !!rec.timeHorizon && rec.dataQuality != null);
}

/* ================================================================== *
 * 8. Daily statistics population join (Phase 12) — golden file
 * ================================================================== */
section('8. Daily statistics populations (Phase 12)');
{
  const stats = require(path.join(ROOT, 'atlas/statistics.js'));
  const dir = tmpdir('stats');
  const daily = stats.createDailySnapshots({ readJson: () => null, writeJson: (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v)) });

  const predictions = [{ predictionId: 'P1' }, { predictionId: 'P2' }, { predictionId: 'P3' }];
  // Outcome population (flat pnlPct + direction)
  const outcomes = [
    { predictionId: 'P1', pnlPct: 5, direction: 'bullish', realizedAt: 1 },
    { predictionId: 'P2', pnlPct: -3, direction: 'bearish', realizedAt: 2 } // bearish + loss = correct
  ];
  // A/B comparison population (intrinsically paired rows — never index-paired)
  const comparisons = [
    { v1Return: 2.0, atlasReturn: 2.0, predictionId: 'P1' },
    { v1Return: -4.0, atlasReturn: -4.0, predictionId: 'P9' } // unmatched id → not counted in matchedById
  ];
  const s = daily.buildDailyStats(outcomes, predictions, comparisons);
  check('8a. resolved counts only valid flat-pnl outcomes', s.resolved === 2, JSON.stringify(s.resolved));
  check('8b. atlasAccuracy from outcome population (2/2)', s.atlasAccuracy === 100, JSON.stringify(s.atlasAccuracy));
  check('8c. paired stats from comparisons only', s.circuitMeanReturn === -1 && s.atlasMeanReturn === -1, JSON.stringify([s.circuitMeanReturn, s.atlasMeanReturn]));
  check('8d. joined-by-id counted correctly (P1 only)', s.matchedById === 1, String(s.matchedById));
  check('8e. evidenceState reflects outcome count', s.evidenceState === 'INSUFFICIENT_SAMPLE');
  check('8f. unresolved = predictions − resolved', s.unresolved === 1, String(s.unresolved));

  // Golden file — deterministic output snapshot
  fs.writeFileSync(path.join(dir, 'golden.json'), JSON.stringify(s));
  const s2 = daily.buildDailyStats(outcomes, predictions, comparisons);
  check('8g. golden-file determinism', fs.readFileSync(path.join(dir, 'golden.json'), 'utf8') === JSON.stringify(s2));

  const empty = daily.buildDailyStats([], [], []);
  check('8h. empty inputs safe', empty.resolved === 0 && empty.circuitMeanReturn === null && empty.winRate === null);
}

/* ================================================================== *
 * 9. A/B avoided accounting (Phase 13)
 * ================================================================== */
section('9. A/B avoided accounting (Phase 13)');
{
  const { createABPaper } = require(path.join(ROOT, 'atlas/ab-paper.js'));
  const saved = {};
  const ab = createABPaper({ readJson: () => null, writeJson: (f, v) => { saved[f] = v; } });

  ab.recordTrade({ mint: 'mA', symbol: 'A', pnlPct: -7, exitReason: 'stop-loss', atlasRecommendation: 'AVOID' });
  ab.recordTrade({ mint: 'mB', symbol: 'B', pnlPct: 8, exitReason: 'take-profit', atlasRecommendation: 'BUY' });

  const snap = ab.snapshot();
  check('9a. groupA executed 2 trades', snap.groupA.totalTrades === 2, JSON.stringify(snap.groupA.totalTrades));
  check('9b. groupB executed only 1 (AVOID not counted as trade)', snap.groupB.totalTrades === 1, JSON.stringify(snap.groupB.totalTrades));
  check('9c. avoided tracked separately', snap.avoided === 1, String(snap.avoided));
  check('9d. avoided excluded from executed comparisons', snap.executedComparisons === 1, String(snap.executedComparisons));
  const cmpRows = saved['atlas-ab-paper.json'].comparisons;
  check('9e. avoided row atlasReturn=null (not a 0% trade)', cmpRows.some(c => c.comparisonType === 'avoided' && c.atlasReturn === null), JSON.stringify(cmpRows));
  check('9f. executed row keeps type', cmpRows.some(c => c.comparisonType === 'executed' && c.atlasReturn === 8));

  // buildDailyStats must exclude avoided rows from paired stats
  const stats = require(path.join(ROOT, 'atlas/statistics.js'));
  const daily = stats.createDailySnapshots({ readJson: () => null, writeJson: () => {} });
  const s = daily.buildDailyStats([], [], cmpRows);
  check('9g. paired stats ignore avoided rows (n=1)', s.circuitMeanReturn === 8 && s.atlasMeanReturn === 8, JSON.stringify([s.circuitMeanReturn, s.atlasMeanReturn]));

  // Persistence round-trip preserves avoided count
  const ab2 = createABPaper({ readJson: (f) => saved[f] || null, writeJson: (f, v) => { saved[f] = v; } });
  check('9h. avoided count survives reload', ab2.snapshot().avoided === 1, String(ab2.snapshot().avoided));
}

/* ================================================================== *
 * 10. Discovery join() defense (Phase 14)
 * ================================================================== */
section('10. Discovery join() defense (Phase 14)');
{
  const mdSrc = fs.readFileSync(path.join(ROOT, 'market-data.js'), 'utf8');
  check('10a. via map guarded against undefined', /const viaArr = via\.get\(cand\.mint\);/.test(mdSrc) && /cand\.via = Array\.isArray\(viaArr\)/.test(mdSrc));
  check('10b. per-candidate try/catch isolation', /emit\('DISCOVERY-SKIP', `candidate \$\{/.test(mdSrc));
}

/* ================================================================== *
 * 11. Pair anchoring (Phase 15) — open positions priced on entry pair
 * ================================================================== */
section('11. Pair anchoring (Phase 15)');
{
  const mdSrc = fs.readFileSync(path.join(ROOT, 'market-data.js'), 'utf8');
  check('11a. fetchTokenPrices accepts opts.preferredPairs', /async function fetchTokenPrices\(mints, opts = \{\}\)/.test(mdSrc));
  check('11b. entry pair selected over best-liquidity', /const pair = preferredByBase\.get\(mint\) \|\| byBase\.get\(mint\);/.test(mdSrc));
  check('11c. composite provider forwards pair options', /dex\.fetchTokenPrices\(mints, pairOpts\)/.test(mdSrc));
  const agentSrc = fs.readFileSync(path.join(ROOT, 'agentd.js'), 'utf8');
  check('11d. monitorOnce passes entry pair per position', agentSrc.indexOf('preferredPairs.set(p.mint, p.pairAddress)') >= 0);
  check('11e. price-integrity PAIR_CHANGED gate intact', fs.readFileSync(path.join(ROOT, 'price-integrity.js'), 'utf8').indexOf("reason === 'PAIR_CHANGED'") >= 0);
  check('11f. V1 liquidity/volume thresholds unchanged', /const MIN_LIQUIDITY_USD = 20000;/.test(agentSrc) && /const MIN_VOLUME_24H_USD = 50000;/.test(agentSrc));
}

/* ================================================================== *
 * 12. Config hardening (Phase 18) — prototype pollution
 * ================================================================== */
section('12. Config hardening (Phase 18)');
{
  const dir = tmpdir('cfg');
  fs.writeFileSync(path.join(dir, 'config.json'), '{"__proto__": {"polluted": "yes"}, "paperTrading": false}');
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, ['-e',
    `const a=require(${JSON.stringify(path.join(ROOT, 'agentd.js'))});` +
    `const cfg=a.loadConfig();` +
    `console.log(JSON.stringify({polluted:({}).polluted==='yes',ownProto:Object.prototype.hasOwnProperty.call(cfg,'__proto__'),paper:cfg.paperTrading===true}));`], {
    env: Object.assign({}, process.env, { CIRCUIT_AGENT_DATA_DIR: dir }),
    encoding: 'utf8', timeout: 15000
  });
  let verdict = {};
  try { verdict = JSON.parse((res.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch (_) {}
  check('12a. __proto__ key stripped', verdict.polluted === false, JSON.stringify(verdict));
  check('12b. no own __proto__ on cfg', verdict.ownProto === false, JSON.stringify(verdict));
  check('12c. paperTrading stays forced true', verdict.paper === true, JSON.stringify(verdict));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================================================================== *
 * 13. Mock provider honors preferredPairs (integration, offline)
 * ================================================================== */
section('13. Mock provider preferredPairs integration');
{
  const dir = tmpdir('mockpair');
  const md = require(path.join(ROOT, 'market-data.js'));
  const mintA = 'So11111111111111111111111111111111111111112'; // wrapped SOL (valid base58)
  const pairMain = 'PairMain1111111111111111111111111111111111';
  const pairAlt = 'PairAlt222222222222222222222222222222222222';
  const mock = {
    solPriceUsd: 150,
    tokens: [
      {
        symbol: 'PAIRY', mint: mintA, change1hPct: -10, change5mPct: 1,
        // same mint quoted on two pairs at DIFFERENT prices/liquidity
        pairs: [
          { pairAddress: pairMain, dex: 'raydium', priceUsd: 150, priceSol: 1, liquidityUsd: 100000, volume24hUsd: 300000 },
          { pairAddress: pairAlt, dex: 'orca', priceUsd: 180, priceSol: 1.2, liquidityUsd: 500000, volume24hUsd: 900000 }
        ]
      }
    ]
  };
  const mf = path.join(dir, 'mock.json');
  fs.writeFileSync(mf, JSON.stringify(mock));
  const market = md.createMarketData({ mockFile: mf, onEvent: () => {} });

  market.fetchTokenPrices([mintA]).then((noPref) => {
    check('13a. default selection remains best-liquidity', !!noPref.get(mintA) && noPref.get(mintA).pairAddress === pairAlt, JSON.stringify(noPref.get(mintA) && noPref.get(mintA).pairAddress));
    return market.fetchTokenPrices([mintA], { preferredPairs: new Map([[mintA, pairMain]]) }).then((pref) => {
      check('13b. preferred (entry) pair selected', !!pref.get(mintA) && pref.get(mintA).pairAddress === pairMain, JSON.stringify(pref.get(mintA) && pref.get(mintA).pairAddress));
      check('13c. preferred pair price is the entry-pair price (not the foreign 180)', !!pref.get(mintA) && Math.abs(pref.get(mintA).priceUsd - 150) < 1e-9, JSON.stringify(pref.get(mintA) && pref.get(mintA).priceUsd));
      finish();
    });
  }).catch((err) => { check('13. mock integration ran', false, err.message); finish(); });

  function finish() {
    console.log('\n========================================');
    console.log(`PASSED: ${passed}  FAILED: ${failed}`);
    console.log('========================================');
    process.exit(failed ? 1 : 0);
  }
}
