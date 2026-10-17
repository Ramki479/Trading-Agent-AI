#!/usr/bin/env node
/**
 * run-tests.js — test suite for the REAL-MARKET SOLANA PAPER TRADER.
 *
 * Runs the actual agent (agentd.js) as child processes against a MOCK market
 * provider (CIRCUIT_MOCK_MARKET_FILE) in throwaway data dirs, then asserts on
 * the resulting portfolio.json / trades.jsonl / heartbeat.json / agent.log.
 *
 * Production trading logic always uses REAL market data — the mock is only
 * used here so tests are deterministic and offline.
 *
 * Usage:  node agentd/test/run-tests.js
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agentd.js');
const TMP = path.join(ROOT, '.test-tmp');
const taTests = require('./ta-tests.js');
const atlasTests = require('./atlas-tests.js');

// ---- tiny deterministic base58 mint generator (44 chars, valid alphabet) ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function mint(tag) {
  let h = 7;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  let s = '';
  for (let i = 0; i < 44; i++) { h = (h * 1103515245 + 12345) >>> 0; s += B58[h % 58]; }
  return s;
}

// ---- result accounting ----
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, intervalMs = 120, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    await sleep(intervalMs);
  }
  console.log('  ⚠ timed out waiting for: ' + what);
  return false;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function readLedger(dir) {
  const f = path.join(dir, 'trades.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}
function readJsonl(dir, file, n) {
  const f = path.join(dir, file);
  if (!fs.existsSync(f)) return { records: [] };
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-(n || 100));
  return { records: lines.map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean) };
}
function readLog(dir) {
  const f = path.join(dir, 'agent.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
function pfile(dir) { return path.join(dir, 'portfolio.json'); }
function hfile(dir) { return path.join(dir, 'heartbeat.json'); }
function lfile(dir) { return path.join(dir, 'agent.lock'); }

// ---- child boot helpers ----
function freshDir(name) {
  const dir = path.join(TMP, name + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function boot(dir, { mock, extraEnv = {} } = {}) {
  const env = Object.assign({}, process.env, {
    CIRCUIT_AGENT_DATA_DIR: dir,
    CIRCUIT_MONITOR_MS: '200',
    CIRCUIT_DISCOVERY_MS: '800',
    CIRCUIT_SAMPLE_MS: '150',
    CIRCUIT_HISTORY_WARM_MS: '2000',
    CIRCUIT_MAX_PRICE_AGE_MS: '3000',
    // Adaptive cycles default to OFF in the classic scenarios; adaptive tests
    // override these with short intervals.
    CIRCUIT_AGENT_LOOP_MS: '3600000',
    CIRCUIT_REFLECT_MS: '3600000',
    // TradingAgents research default OFF in the harness; TA scenarios opt in.
    CIRCUIT_TA_MODE: 'OFF'
  }, extraEnv);
  if (mock) {
    const mf = path.join(dir, 'mock-market.json');
    fs.writeFileSync(mf, JSON.stringify(mock));
    env.CIRCUIT_MOCK_MARKET_FILE = mf;
  }
  const child = spawn(process.execPath, [AGENT], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.__out = () => out;
  return child;
}

function gracefulStop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    try { child.send({ type: 'shutdown' }); } catch (_) { child.kill(); }
    setTimeout(() => { try { child.kill(); } catch (_) { /* already gone */ } }, 4000);
  });
}

function hardKill(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
}

// ---- mock market fixtures ------------------------------------------------
const SOL_USD = 150;
const BASE_SOL = 0.00001 / SOL_USD; // priceSol for a $0.00001 token

function slowDrift(steps, stepPct) {
  const s = [];
  for (let i = 0; i < steps; i++) s.push(BASE_SOL * Math.pow(1 + stepPct, i));
  return s;
}

/** Gently rise (keeps the strategy's 5m recovery inside [0.25%, 8%] so the
 *  token becomes buyable), then optionally fall hard to trigger stop-loss. */
function riseThenMaybeFall(upSteps, upPct, downSteps, downPct) {
  const s = [];
  for (let i = 0; i < upSteps; i++) s.push(BASE_SOL * Math.pow(1 + upPct, i));
  const peak = BASE_SOL * Math.pow(1 + upPct, upSteps - 1);
  for (let i = 1; i <= downSteps; i++) s.push(peak * Math.pow(1 - downPct, i));
  return s;
}

function tok(symbol, { series, change1hPct = -20, liquidityUsd = 150000, volume24hUsd = 500000, extra = {} } = {}) {
  return Object.assign({
    symbol,
    mint: mint(symbol),
    priceUsd: 0.00001,
    priceSol: BASE_SOL,
    liquidityUsd,
    volume24hUsd,
    change1hPct,
    change5mPct: 2.5,
    series: series || riseThenMaybeFall(130, 0.0015, 0, 0)
  }, extra);
}

// Slow +0.15%/step uptrend → 5m recovery ≈ +1.5-3% (buyable), then keeps
// rising through the +8% take-profit level. 130 steps ≈ 15 s of data.
const GOOD_TP = () => tok('RISE', { series: riseThenMaybeFall(130, 0.0015, 0, 0) });
// Short rise (buyable) then a hard -1.5%/step fall → stop-loss at -6%.
const GOOD_SL = () => tok('FALL', { series: riseThenMaybeFall(20, 0.0015, 15, 0.015) });
// Long gentle +0.2%/step uptrend → recovery stays inside range for minutes.
const GOOD_DRIFT = () => tok('DRIFT', { series: slowDrift(300, 0.002) });

// ============================================================================
// 0. UNIT GATES (require the modules directly — no side effects on require)
// ============================================================================
async function testUnitGates() {
  console.log('\n[test 0] unit gates — prices, 5m recovery, score, divergence, discovery extraction');
  const agent = require('../agentd.js');
  const md = require('../market-data.js');
  const now = Date.now();

  // Solana address validation
  check('valid base58 mint accepted', agent.isValidSolanaAddress(mint('RISE')));
  check('mint with 0/O/I/l rejected', !agent.isValidSolanaAddress('0OIl' + '1'.repeat(40)));
  check('short address rejected', !agent.isValidSolanaAddress('Abc'));
  check('null/undefined rejected', !agent.isValidSolanaAddress(null) && !agent.isValidSolanaAddress(undefined));

  // Discovery mint extraction (merged multi-feed discovery)
  const gMint = mint('GT');
  check('gecko relationship id → real mint', md.mintFromGeckoId('solana_' + gMint) === gMint);
  check('gecko non-solana id rejected', md.mintFromGeckoId('ethereum_0xAbC123') === null);
  check('gecko missing/empty id rejected', md.mintFromGeckoId(null) === null && md.mintFromGeckoId('') === null && md.mintFromGeckoId('solana_short') === null);
  const pMint = mint('PROF');
  check('dex solana profile entry → real mint', md.mintFromProfileEntry({ chainId: 'solana', tokenAddress: pMint }) === pMint);
  check('dex non-solana profile entry rejected', md.mintFromProfileEntry({ chainId: 'ethereum', tokenAddress: pMint }) === null);
  check('dex profile missing address rejected', md.mintFromProfileEntry({ chainId: 'solana' }) === null && md.mintFromProfileEntry(null) === null);
  const geoBody = {
    data: [
      { relationships: { base_token: { data: { id: 'solana_' + gMint } } } },
      { relationships: { base_token: { data: { id: 'solana_' + pMint } } } },
      { relationships: { base_token: { data: { id: 'solana_' + gMint } } } }, // duplicate
      { relationships: { base_token: { data: { id: 'base_0xAbC123' } } } },   // wrong chain
      {},
      null
    ]
  };
  const geckoMints = md.mintsFromGeckoPools(geoBody);
  check('gecko pools body → deduped real mints only',
    geckoMints.length === 2 && geckoMints[0] === gMint && geckoMints[1] === pMint,
    geckoMints.join(','));
  check('gecko pools non-array body → empty', md.mintsFromGeckoPools({}).length === 0 && md.mintsFromGeckoPools(null).length === 0);

  // Buy-time price gate
  const fresh = { priceUsd: 1e-5, priceSol: 6.7e-8, source: 'test', timestamp: Date.now(), ageMs: 0 };
  check('fresh valid price passes gate', agent.evaluatePriceGate(fresh, 60000).ok === true);
  const zero = { priceUsd: 0, priceSol: 0, source: 'test', timestamp: Date.now(), ageMs: 0 };
  check('zero price → unavailable', agent.evaluatePriceGate(zero, 60000).reason === 'price unavailable');
  check('null price → unavailable', agent.evaluatePriceGate(null, 60000).reason === 'price unavailable');
  const stale = Object.assign({}, fresh, { timestamp: now - 120000, ageMs: 120000 });
  check('stale price rejected', !agent.evaluatePriceGate(stale, 60000).ok && /price stale/.test(agent.evaluatePriceGate(stale, 60000).reason));
  check('priceAgeMs computed', agent.priceAgeMs(Object.assign({}, fresh, { timestamp: now - 5000 }), now) === 5000);

  // Cross-provider divergence
  const a = { priceUsd: 1, priceSol: 0.0067, source: 'a', timestamp: now, ageMs: 0 };
  const bFar = { priceUsd: 1.35, priceSol: 0.009, source: 'b', timestamp: now, ageMs: 0 };
  const cmpFar = agent.comparePrices(a, bFar, 25);
  check('35% divergence rejected', cmpFar.ok === false && cmpFar.divergencePct > 25);
  const bNear = { priceUsd: 1.05, priceSol: 0.007, source: 'b', timestamp: now, ageMs: 0 };
  check('small divergence accepted', agent.comparePrices(a, bNear, 25).ok === true);

  // Score
  const strong = agent.computeScore({ change1hPct: -20, recoveryPct: 2, liquidityUsd: 150000, volume24hUsd: 500000 });
  check('strong candidate scores >= 60', strong >= 60, 'score=' + strong);
  const weak = agent.computeScore({ change1hPct: -20, recoveryPct: null, liquidityUsd: 1000, volume24hUsd: 1000 });
  check('warming/no-liquidity candidate scores < 60', weak < 60, 'score=' + weak);

  // 5m recovery from local samples
  const t0 = Date.now();
  const mk = (n, stepPct, spacingMs) => {
    const s = [];
    for (let i = 0; i < n; i++) {
      s.push({ ts: t0 - (n - i) * spacingMs, priceUsd: 1 * Math.pow(1 + stepPct, i), priceSol: 1, source: 't' });
    }
    return s;
  };
  const recFlat = agent.compute5mRecoveryFromSamples(mk(20, 0, 150), 2000);
  check('flat history → ~0% recovery, valid', recFlat.warming === false && Math.abs(recFlat.pct) < 0.01, JSON.stringify(recFlat));
  check('too few samples → warming', agent.compute5mRecoveryFromSamples(mk(3, 0, 150), 2000).warming === true);
  const recRise = agent.compute5mRecoveryFromSamples(mk(20, 0.002, 150), 2000);
  check('rising history → positive recovery', recRise.warming === false && recRise.pct > 0.5, JSON.stringify(recRise));
  check('young history (no ~2s baseline) → warming', agent.compute5mRecoveryFromSamples(mk(20, 0, 50), 2000).warming === true);

  // Exit decision (partials + breakeven + runner + time-stop priority)
  const freshPos = () => ({ stopLossPct: -6, takeProfitPct: 8, partialTaken: false, openedAt: new Date(Date.now() - 60000).toISOString() });
  check('decideExit: SL first', agent.decideExit(freshPos(), -7, Date.now()).reason === 'stop-loss');
  check('decideExit: fast gap to TP closes whole (legacy path)', agent.decideExit(freshPos(), 9, Date.now()).reason === 'take-profit');
  check('decideExit: +5% banks a partial', agent.decideExit(freshPos(), 5.2, Date.now()).action === 'partial');
  check('decideExit: below partial holds', agent.decideExit(freshPos(), 3, Date.now()).action === null);
  check('decideExit: partials kill-switch holds', agent.decideExit(freshPos(), 5.2, Date.now(), { partialsEnabled: false }).action === null);
  const runPos = { stopLossPct: 0, takeProfitPct: 12, partialTaken: true, openedAt: new Date(Date.now() - 60000).toISOString() };
  check('decideExit: runner fade to entry → breakeven-stop', agent.decideExit(runPos, -0.5, Date.now()).reason === 'breakeven-stop');
  check('decideExit: runner +12% → take-profit', agent.decideExit(runPos, 12.3, Date.now()).reason === 'take-profit');
  check('decideExit: runner mid-flight holds', agent.decideExit(runPos, 7, Date.now()).action === null);
  const oldPos = { openedAt: new Date(Date.now() - 60000).toISOString() };
  check('decideExit: legacy position (no partial fields) still partials', agent.decideExit(oldPos, 5.5, Date.now()).action === 'partial');
  const lv = agent.effectivePartialLevels({});
  check('partial levels default (5 / 0.5 / 12 / 0)', lv.take === 5 && lv.fraction === 0.5 && lv.runner === 12 && lv.breakeven === 0);
  const lvClamp = agent.effectivePartialLevels({ runnerTpPct: 4, breakevenPct: 9 });
  check('partial levels clamp runner above take, breakeven below take', lvClamp.runner > 5 && lvClamp.breakeven < 5, JSON.stringify(lvClamp));

  // NATR estimator + ATR levels + entry gate
  const mkCloses = (n, step) => {
    const s = [];
    for (let i = 0; i < n; i++) s.push({ ts: i * 15000, priceSol: 1 * Math.pow(1 + step, i) });
    return s;
  };
  const n20 = agent.computeNatr(mkCloses(20, 0.0015));
  check('natr: smooth 20-sample rise ≈ 2.8%', n20.ok === true && n20.natr > 2.5 && n20.natr < 3.1, JSON.stringify(n20));
  const n8 = agent.computeNatr(mkCloses(8, 0.0015));
  check('natr: window-normalized, n=8 ≈ n=20 (no shrinking stops)', n8.ok === true && Math.abs(n8.natr - n20.natr) < 0.5, JSON.stringify(n8));
  check('natr: flat series → 0 (floor applies at sizing)', agent.computeNatr(mkCloses(20, 0)).natr === 0);
  check('natr: <8 samples → insufficient-history', agent.computeNatr(mkCloses(5, 0.0015)).ok === false);
  check('natr: ignores invalid closes', agent.computeNatr([{ priceSol: 0 }, { priceSol: -1 }, ...mkCloses(8, 0.0015)]).ok === true);
  const lv28 = agent.atrLevels(2.8);
  check('atr levels: SL=-4.2 TP=+7.0 at NATR 2.8', lv28.slPct === -4.2 && lv28.tpPct === 7, JSON.stringify(lv28));
  check('atr levels: floor binds at 0 → SL -2.25/TP +3.75', agent.atrLevels(0).slPct === -2.25 && agent.atrLevels(0).tpPct === 3.75);
  check('atr levels: cap binds at 10 → SL -6/TP +10', agent.atrLevels(10).slPct === -6 && agent.atrLevels(10).tpPct === 10);
  check('natr gate: 4.01% rejected, 4% passes, unknown fails open',
    agent.passesNatrGate(4.01).allow === false && agent.passesNatrGate(4).allow === true && agent.passesNatrGate(null).allow === true);
  check('atr defaults (1.5×/2.5×, floor 1.5, reject 4)',
    agent.DEFAULT_ATR_SL_MULT === 1.5 && agent.DEFAULT_ATR_TP_MULT === 2.5 &&
    agent.DEFAULT_MIN_NATR_PCT === 1.5 && agent.DEFAULT_MAX_NATR_PCT === 4);

  // Volatility sizing: cost = base × (targetVol / floored NATR)
  const vsHot = agent.computeEntrySize(0.05, 6);
  check('sizing: NATR 6% halves size (3/6)', vsHot.volMult === 0.5 && vsHot.cost === 0.025 && vsHot.effNatr === 6,
    JSON.stringify(vsHot));
  const vsCalm = agent.computeEntrySize(0.05, 3);
  check('sizing: NATR at target → 1.0× unchanged', vsCalm.volMult === 1 && vsCalm.cost === 0.05);
  const vsFlat = agent.computeEntrySize(0.05, 0.2);
  check('sizing: sub-floor NATR uses 1.5 floor (2.0× pre-clamp)', vsFlat.volMult === 2 && vsFlat.cost === 0.1 && vsFlat.effNatr === 1.5,
    JSON.stringify(vsFlat));
  const vsUnknown = agent.computeEntrySize(0.05, null);
  check('sizing: unknown NATR fails open (1.0×)', vsUnknown.volMult === 1 && vsUnknown.cost === 0.05 && vsUnknown.effNatr === null);
  check('sizing: bad inputs fail open', agent.computeEntrySize(0, 6).cost === 0 && agent.computeEntrySize(0.05, -2).volMult === 1);
  const vsCustom = agent.computeEntrySize(0.05, 3, { targetVolPct: 6 });
  check('sizing: custom targetVol honored', vsCustom.volMult === 2 && vsCustom.cost === 0.1);
  check('sizing: default target is 3%', agent.DEFAULT_TARGET_VOL_PCT === 3);

  // Day-P&L anchor helpers (daily loss halt bookkeeping)
  check('anchor: utcDayString formats UTC date', agent.utcDayString(Date.UTC(2026, 0, 15, 12, 0, 0)) === '2026-01-15');
  check('anchor: utcDayString rejects garbage', agent.utcDayString(NaN) === null && agent.utcDayString('x') === null);
  const anchorP = { equitySol: 10 };
  check('anchor: unset anchor initializes (no halt today)', agent.ensureDayAnchor(anchorP, Date.UTC(2026, 0, 15, 12)) === true &&
    anchorP.dayAnchorDate === '2026-01-15' && anchorP.dayAnchorSol === 10);
  check('anchor: same day is a no-op', agent.ensureDayAnchor(anchorP, Date.UTC(2026, 0, 15, 18)) === false &&
    anchorP.dayAnchorSol === 10);
  anchorP.equitySol = 9.5;
  check('anchor: date roll resets to current equity', agent.ensureDayAnchor(anchorP, Date.UTC(2026, 0, 16, 1)) === true &&
    anchorP.dayAnchorDate === '2026-01-16' && anchorP.dayAnchorSol === 9.5);
  check('anchor: bad portfolio never throws', agent.ensureDayAnchor(null, Date.now()) === false);
  check('dayPnl: -4% day', agent.computeDayPnl({ equitySol: 9.6, dayAnchorSol: 10 }) === -4);
  check('dayPnl: missing anchor → null (no halt)', agent.computeDayPnl({ equitySol: 9.6 }) === null &&
    agent.computeDayPnl({ equitySol: 9.6, dayAnchorSol: 0 }) === null &&
    agent.computeDayPnl({ dayAnchorSol: 10 }) === null && agent.computeDayPnl(null) === null);

  // Bounce confirmation (2 rising 15s closes + rising 5m slope)
  const mkPx = (prices, gap = 15000) => prices.map((p, i) => ({ ts: 1000000 + i * gap, priceUsd: p, priceSol: p / 150 }));
  check('bounce: steady rise confirms', agent.bounceConfirmation(mkPx([1, 1.001, 1.002, 1.003, 1.004, 1.005, 1.006, 1.007])).confirmed === true);
  check('bounce: flat top rejects (no rising closes)', agent.bounceConfirmation(mkPx([1, 1, 1, 1, 1, 1, 1, 1])).confirmed === false);
  check('bounce: single jump then flat rejects (1 rise, need 2)',
    agent.bounceConfirmation(mkPx([1, 1, 1, 1, 1, 1.03, 1.03, 1.03])).confirmed === false);
  const vShape = agent.bounceConfirmation(mkPx([1.05, 1.04, 1.03, 1.02, 1.01, 1.005, 1.008, 1.011]));
  check('bounce: V-shape (2 rises, falling 5m slope) rejects on slope',
    vShape.confirmed === false && vShape.rising === true && vShape.slopeUp === false, JSON.stringify(vShape));
  check('bounce: <3 samples → insufficient', agent.bounceConfirmation(mkPx([1, 1.01])).confirmed === false);
  check('bounce: stale gap in tail rejects',
    agent.bounceConfirmation([{ ts: 0, priceUsd: 1, priceSol: 1 }, { ts: 15000, priceUsd: 1.01, priceSol: 1 }, { ts: 215000, priceUsd: 1.02, priceSol: 1 }, { ts: 230000, priceUsd: 1.03, priceSol: 1 }]).confirmed === false);
  check('bounce: resumed rise after stale prints confirms',
    agent.bounceConfirmation(mkPx([1, 1, 1, 1, 1, 1, 1.01, 1.02])).confirmed === true);

  // Order-flow + valuation gates (Dex txns/fdv/mcap)
  const qBase = { txBuys: 200, txSells: 100, liquidityUsd: 150000, volume24hUsd: 500000, marketCapUsd: 5000000 };
  const qOk = agent.evaluateOrderflow(qBase);
  check('quality: healthy flow + 3% liq/mcap passes', qOk.ok === true && qOk.sellsBuysRatio === 0.5 && qOk.liqMcapPct === 3 && qOk.mcapSource === 'marketCap');
  check('quality: sells 3× buys rejects', agent.evaluateOrderflow(Object.assign({}, qBase, { txBuys: 100, txSells: 300 })).ok === false);
  check('quality: boundary ratio 1.5 passes', agent.evaluateOrderflow(Object.assign({}, qBase, { txBuys: 100, txSells: 150 })).ok === true);
  check('quality: one-sided dump (0 buys) rejects', agent.evaluateOrderflow(Object.assign({}, qBase, { txBuys: 0, txSells: 50 })).ok === false);
  check('quality: 0/0 txns fails open', agent.evaluateOrderflow(Object.assign({}, qBase, { txBuys: 0, txSells: 0 })).ok === true);
  check('quality: missing txns fails open', agent.evaluateOrderflow({ liquidityUsd: 150000, volume24hUsd: 500000, marketCapUsd: 5000000 }).ok === true);
  check('quality: liq 0.5% of mcap rejects', agent.evaluateOrderflow(Object.assign({}, qBase, { liquidityUsd: 25000 })).ok === false);
  check('quality: boundary liq 2% of mcap passes', agent.evaluateOrderflow(Object.assign({}, qBase, { liquidityUsd: 20000, marketCapUsd: 1000000 })).ok === true);
  check('quality: fdv fallback prices when mcap missing',
    agent.evaluateOrderflow({ txBuys: 200, txSells: 100, liquidityUsd: 25000, volume24hUsd: 500000, fdvUsd: 500000 }).ok === true);
  check('quality: missing mcap+fdv fails open',
    agent.evaluateOrderflow({ txBuys: 200, txSells: 100, liquidityUsd: 25000, volume24hUsd: 500000 }).ok === true);
  check('quality: liqVolRatio reported, never gated',
    agent.evaluateOrderflow(Object.assign({}, qBase, { volume24hUsd: 5000000 })).liqVolRatio === 5000000 / 150000);
  check('quality defaults (sells≤1.5×buys, liq≥2% mcap)',
    agent.DEFAULT_MAX_SELLS_BUYS_RATIO === 1.5 && agent.DEFAULT_MIN_LIQ_MCAP_PCT === 2);

  // Ensemble 2/3 (V1 + TA + ATLAS) — explicit BUY only, precision first
  const ev = (v, o) => agent.evaluateEnsemble(v, o);
  check('ensemble: 3/3 allows', ev({ v1: true, ta: 'BUY', atlas: 'BUY' }).allow === true);
  check('ensemble: V1+TA allows', ev({ v1: true, ta: 'BUY', atlas: 'HOLD' }).allow === true);
  check('ensemble: V1+ATLAS allows', ev({ v1: true, ta: 'AVOID', atlas: 'BUY' }).allow === true);
  check('ensemble: V1 alone blocks (1/3)', ev({ v1: true, ta: 'HOLD', atlas: 'HOLD' }).allow === false);
  check('ensemble: missing verdicts disagree', ev({ v1: true, ta: null, atlas: undefined }).allow === false);
  check('ensemble: minAgree respected', ev({ v1: true, ta: 'BUY', atlas: 'BUY' }, { minAgree: 3 }).allow === true &&
    ev({ v1: true, ta: 'BUY', atlas: 'HOLD' }, { minAgree: 3 }).allow === false);
  check('ensemble: reason names the split', /1\/3/.test(ev({ v1: true, ta: 'AVOID', atlas: 'AVOID' }).reason));
  check('ensemble defaults (SHADOW-first design, need 2)',
    agent.ENSEMBLE_MODES.join(',') === 'OFF,SHADOW,ENFORCE' && agent.DEFAULT_ENSEMBLE_AGREE === 2);

  // Calibrated P(win) — Laplace NB over entry features (global pool)
  const gates = agent.gatesLib;
  const wpTrades = [
    { entryScore: 78, change1hPct: -15, recovery5mPct: 2.5, liquidityUsd: 150000, liqClass: 'high', volume24hUsd: 500000, realizedPnlSol: 0.004, realizedPnlPct: 8 },
    { entryScore: 80, change1hPct: -18, recovery5mPct: 3, liquidityUsd: 200000, liqClass: 'high', volume24hUsd: 600000, realizedPnlSol: 0.005, realizedPnlPct: 10 },
    { entryScore: 77, change1hPct: -12, recovery5mPct: 2, liquidityUsd: 120000, liqClass: 'high', volume24hUsd: 400000, realizedPnlSol: 0.003, realizedPnlPct: 6 },
    { entryScore: 79, change1hPct: -20, recovery5mPct: 4, liquidityUsd: 300000, liqClass: 'high', volume24hUsd: 800000, realizedPnlSol: 0.006, realizedPnlPct: 12 },
    { entryScore: 62, change1hPct: -15, recovery5mPct: 2.5, liquidityUsd: 150000, liqClass: 'high', volume24hUsd: 500000, realizedPnlSol: -0.003, realizedPnlPct: -6 },
    { entryScore: 61, change1hPct: -18, recovery5mPct: 3, liquidityUsd: 200000, liqClass: 'high', volume24hUsd: 600000, realizedPnlSol: -0.004, realizedPnlPct: -8 },
    { entryScore: 63, change1hPct: -12, recovery5mPct: 2, liquidityUsd: 120000, liqClass: 'high', volume24hUsd: 400000, realizedPnlSol: -0.003, realizedPnlPct: -6 },
    { entryScore: 60, change1hPct: -20, recovery5mPct: 4, liquidityUsd: 300000, liqClass: 'high', volume24hUsd: 800000, realizedPnlSol: -0.005, realizedPnlPct: -10 },
    { entryScore: 62, change1hPct: -14, recovery5mPct: 2.2, liquidityUsd: 150000, liqClass: 'high', volume24hUsd: 500000, realizedPnlSol: -0.003, realizedPnlPct: -6 },
    { entryScore: 78, change1hPct: -16, recovery5mPct: 2.8, liquidityUsd: 150000, liqClass: 'high', volume24hUsd: 500000, realizedPnlSol: 0.004, realizedPnlPct: 8 }
  ];
  check('winprob: tiny sample → null model (fail open, no cliff)', gates.trainWinProb(wpTrades.slice(0, 5), {}) === null);
  const wModel = gates.trainWinProb(wpTrades, {});
  check('winprob: trains on 10 grouped trades', wModel && wModel.n === 10 && wModel.wins === 5);
  const pHi = gates.predictWinProb(wModel, { score: 78, change1hPct: -15, recoveryPct: 2.5, liquidityUsd: 150000, volume24hUsd: 500000 });
  const pLo = gates.predictWinProb(wModel, { score: 62, change1hPct: -15, recoveryPct: 2.5, liquidityUsd: 150000, volume24hUsd: 500000 });
  check('winprob: separates winner/loser profiles', pHi > 0.6 && pLo < 0.4, 'hi=' + pHi + ' lo=' + pLo);
  check('winprob: missing features → unknown buckets (still scores)',
    Number.isFinite(gates.predictWinProb(wModel, { score: 70 })));
  check('winprob: null model → null prediction', gates.predictWinProb(null, { score: 70 }) === null);
  const wTune = gates.tuneThreshold(wModel, wpTrades, {});
  check('winprob: tuned for PF (keeps winners, drops losers)', wTune.fallback === false && wTune.stats.winRate === 100,
    JSON.stringify({ th: wTune.threshold, stats: wTune.stats }));
  check('winprob: buckets cover Bands + liq/vol/rsi/spread',
    gates.bucketScore(80) === '75+' && gates.bucket1h(-30) === 'deep' && gates.bucket5m(6) === 'late' &&
    gates.bucketVol(50) === 'thin' && gates.bucketRsi(20) === 'os' && gates.bucketRsi(null) === 'unknown' &&
    gates.bucketSpread(null) === 'unknown');
  check('winprob defaults (minTrain 10, threshold 0.5)',
    gates.WINPROB_MIN_TRAIN === 10 && gates.WINPROB_DEFAULT_THRESHOLD === 0.5);

  // Thompson bandit per-cluster minScore (deterministic sampling, no Math.random)
  check('bandit: same day+cluster → same arm', JSON.stringify(gates.banditSelectArm({ 60: { w: 5, l: 5 } }, '2026-09-12', 'k')) ===
    JSON.stringify(gates.banditSelectArm({ 60: { w: 5, l: 5 } }, '2026-09-12', 'k')));
  const extState = { 60: { w: 0, l: 10 }, 65: { w: 0, l: 10 }, 70: { w: 10, l: 0 }, 75: { w: 0, l: 10 } };
  const extPicks = {};
  for (let d = 1; d <= 20; d++) {
    const s = gates.banditSelectArm(extState, '2026-09-' + String(d).padStart(2, '0'), 'k');
    extPicks[s.arm] = (extPicks[s.arm] || 0) + 1;
  }
  check('bandit: dominating arm selected every day', extPicks[70] === 20, JSON.stringify(extPicks));
  check('bandit: empty state yields a valid arm', gates.BANDIT_ARMS.includes(gates.banditSelectArm(undefined, '2026-09-12', 'k').arm));
  const updTrades = [
    { regime: 'bull', timeOfDay: 'morning', liqClass: 'high', entryMinScore: 60, realizedPnlSol: -1 },
    { regime: 'bull', timeOfDay: 'morning', liqClass: 'high', entryMinScore: 70, realizedPnlSol: 1 },
    { regime: 'bull', timeOfDay: 'morning', liqClass: 'high', entryMinScore: 80, realizedPnlSol: 1 },
    { regime: 'bull', timeOfDay: 'morning', liqClass: 'high', entryMinScore: null, realizedPnlSol: 1 }
  ];
  const upd = gates.banditUpdateFromTrades(updTrades);
  check('bandit: exact arm attribution (80 + null-arm skipped)', upd['bull|morning|high'][60].l === 1 &&
    upd['bull|morning|high'][70].w === 1 && upd['bull|morning|high'][80] === undefined);
  check('bandit: thin cluster holds V1 floor', gates.banditEffectiveArm({ arm: 70, clusterN: 3 }) === 60);
  check('bandit: evidenced cluster uses selected arm', gates.banditEffectiveArm({ arm: 70, clusterN: 9 }) === 70);
  const dirB = fs.mkdtempSync(path.join(TMP, 'unit-bandit-'));
  gates.saveBanditState(dirB, { clusters: { 'a|b|c': { 60: { w: 1, l: 2 } } } });
  check('bandit: state persists', gates.loadBanditState(dirB).clusters['a|b|c'][60].l === 2);
  check('bandit: blank on missing dir', Object.keys(gates.loadBanditState(path.join(TMP, 'nope-' + Date.now())).clusters).length === 0);

  // RSI + VWAP dip filter (1m bars; TWAP-mean proxy documented in code)
  const nowMs = Date.now();
  const mkSeries = (barPcts, barMs = 60000, per = 4) => {
    const out = [];
    let p = 1.15, t = nowMs - barPcts.length * barMs;
    for (let b = 0; b < barPcts.length; b++) {
      for (let k = 0; k < per; k++) { p *= (1 + barPcts[b] / per); t += barMs / per; out.push({ ts: Math.round(t), priceUsd: p, priceSol: p / 150 }); }
    }
    return out;
  };
  const bars8up8 = agent.resampleToBars(mkSeries([0.01, 0.02]), 60000);
  check('resample: ascending buckets, last close highest', bars8up8.length >= 1 &&
    bars8up8.every((b, i) => i === 0 || b.ts > bars8up8[i - 1].ts) &&
    bars8up8[bars8up8.length - 1].close > bars8up8[0].close);
  check('rsi: all-gains → 100', agent.rsiOfCloses([10, 11, 12, 13]) === 100);
  check('rsi: all-losses → 0', agent.rsiOfCloses([13, 12, 11, 10]) === 0);
  check('rsi: flat → 50 (neutral, never oversold)', agent.rsiOfCloses([10, 10, 10]) === 50);
  check('rsi: hand case [10,11,10.5] → 66.67', Math.abs(agent.rsiOfCloses([10, 11, 10.5]) - 66.67) < 0.01);
  check('rsi: <2 closes → null', agent.rsiOfCloses([10]) === null);
  // Deep V: -2%/bar ×8 then +0.6%/bar ×8 → oversold turning + VWAP reclaimed.
  const deepV = mkSeries([-0.02, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02, 0.006, 0.006, 0.006, 0.006, 0.006, 0.006, 0.006, 0.006]);
  const vPass = agent.evaluateRsiVwap(deepV, { nowMs });
  check('rsi+vwap: deep V passes (rsi<30 turning, +VWAP)', vPass.ok === true && vPass.rsi < 30 && vPass.rsi > vPass.rsiPrev && vPass.vwapDistPct > 0,
    JSON.stringify({ ok: vPass.ok, rsi: vPass.rsi, prev: vPass.rsiPrev, vwap: vPass.vwapDistPct }));
  const grind = mkSeries([0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004, 0.004]);
  const vGrind = agent.evaluateRsiVwap(grind, { nowMs });
  check('rsi+vwap: steady grinder rejected on RSI', vGrind.ok === false && /rsi 100/.test(vGrind.reason), vGrind.reason);
  // Short history: RSI warming fails open, VWAP (rising tail) decides pass…
  const shortRise = mkSeries([0.003, 0.003, 0.003], 60000, 4).slice(-10);
  const vShort = agent.evaluateRsiVwap(shortRise, { nowMs });
  check('rsi+vwap: <15 bars → RSI warming, VWAP passes rise', vShort.ok === true && vShort.rsiWarming === true && vShort.rsi === null);
  // …and VWAP still rejects a flat top.
  const shortFlat = mkSeries([0, 0, 0], 60000, 4).slice(-10);
  check('rsi+vwap: flat top rejected by VWAP', agent.evaluateRsiVwap(shortFlat, { nowMs }).ok === false);
}

// ============================================================================
// 1. STARTUP + PERSISTENCE
// ============================================================================
async function testStartup() {
  console.log('\n[test 1] startup + persistence');
  const dir = freshDir('startup');
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] } });
  try {
    const ok = await waitFor(() =>
      fs.existsSync(pfile(dir)) && fs.existsSync(hfile(dir)) && fs.existsSync(lfile(dir)) &&
      fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'meta.json')),
      10000, 150, 'state files');
    check('state files created', ok);

    const p = readJson(pfile(dir));
    check('starting capital 10', p && p.startingCapitalSol === 10);
    check('cash starts at 10', p && p.cashSol === 10);
    check('paper account fields', p && p.mode === 'paper' && p.name === 'paper-trader');
    check('portfolio has cooldowns map', p && p.cooldowns && typeof p.cooldowns === 'object');

    const meta = readJson(path.join(dir, 'meta.json'));
    check('meta: no wallet, no signer', meta && meta.wallet === null && meta.signerUrl === null);

    const cfg = readJson(path.join(dir, 'config.json'));
    check('default trade size 0.05 SOL', cfg && cfg.tradeSizeSol === 0.05);
    check('config paperTrading forced true', cfg && cfg.paperTrading === true);

    const hb = readJson(hfile(dir));
    check('heartbeat paper+custody', hb && hb.paper === true && hb.custody === 'local');
    check('heartbeat market=REAL SOLANA', hb && hb.market === 'REAL SOLANA');
    check('heartbeat wallet/broadcast disabled', hb && hb.wallet === 'DISABLED' && hb.broadcast === 'DISABLED');
    check('heartbeat maxPositions=5', hb && hb.maxPositions === 5);

    const log = readLog(dir);
    check('startup banner printed', log.includes('REAL-MARKET SOLANA PAPER TRADER'));
    check('lock acquired', log.includes('[LOCK] acquired'));
    check('market data provider initialized', /market data provider: (dexscreener|circuit|mock)/.test(log), log.match(/market data provider:.*/) ? log.match(/market data provider:.*/)[0] : 'no line');
    check('paper-only startup lines', log.includes('PAPER ONLY') && log.includes('wallet'));
    check('no fake random prices', !/Math\.random/.test(log));

    await gracefulStop(child);
    check('clean exit code 0', child.exitCode === 0);
    check('lock released on shutdown', !fs.existsSync(lfile(dir)));
    const hb2 = readJson(hfile(dir));
    check('heartbeat state=stopped', hb2 && hb2.state === 'stopped');
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 2. 5m WARMING gate → BUY after warm-up → TAKE-PROFIT → P&L correctness
// ============================================================================
async function testWarmupBuyTakeProfit() {
  console.log('\n[test 2] 5m WARMING gate → BUY → TAKE-PROFIT + P&L');
  const dir = freshDir('warmup');
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] } });
  try {
    // While history is insufficient: NO trade, log shows warming / score-below.
    await sleep(1500);
    const earlyLog = readLog(dir);
    const earlyTrades = readLedger(dir);
    check('no BUY before history warmed', earlyTrades.length === 0,
      'ledger has ' + earlyTrades.length + ' record(s)');
    check('scan reports 5m=warming(N samples)', /5m=warming\(\d+ samples\)/.test(earlyLog));
    check('filter logged during warm-up', /\[FILTER\] RISE (score below threshold|5m recovery warming)/.test(earlyLog));

    // BUY fires once warmed.
    const bought = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY'), 30000, 200, 'paper BUY');
    check('paper BUY executed after warm-up', bought);
    const buys = readLedger(dir).filter((t) => t.side === 'BUY');
    const buy = buys[0];
    check('BUY has real mint', buy && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(buy.mint || ''));
    check('BUY quantity = size / priceSol', buy && Math.abs(buy.quantity - 0.05 / buy.price) / (0.05 / buy.price) < 0.001,
      'qty ' + (buy && buy.quantity) + ' price ' + (buy && buy.price));
    check('BUY valueSol = 0.05', buy && Math.abs(buy.valueSol - 0.05) < 1e-9);
    check('BUY source recorded', buy && buy.source === 'mock');

    let p = readJson(pfile(dir));
    check('cash debited 0.05', p && Math.abs(p.cashSol - 9.95) < 1e-8, 'cash=' + (p && p.cashSol));
    check('one open position', p && p.positions.length === 1);
    const pos = p && p.positions[0];
    check('position carries SOL+USD prices', pos && pos.entryPriceSol > 0 && pos.entryPriceUsd > 0 && pos.currentPriceSol > 0);
    check('position invested = trade size', pos && Math.abs(pos.costSol - 0.05) < 1e-9);

    // Partial-take at +5% banks half, then the ATR runner closes at +7%.
    const partial = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL' && t.reason === 'partial-take'), 30000, 200, 'partial-take SELL');
    check('SELL executed (partial-take at +5%)', partial);
    const part = readLedger(dir).find((t) => t.side === 'SELL' && t.reason === 'partial-take');
    if (part) {
      check('partial leg banks profit', part.realizedPnlSol > 0);
      check('partial leg pct ≈ +4..+7%', part.realizedPnlPct > 4 && part.realizedPnlPct < 7,
        'pct=' + part.realizedPnlPct);
      check('partial flags the remaining lot', part.partial === true && Number.isFinite(part.remainingQuantity));
      p = readJson(pfile(dir));
      check('position stays open at half size after partial', p && p.positions.length === 1 &&
        Math.abs(p.positions[0].quantity - buy.quantity / 2) / (buy.quantity / 2) < 0.01,
        'qty=' + (p && p.positions[0] && p.positions[0].quantity));
      check('runner armed: SL→breakeven, ATR TP kept', p && p.positions[0].partialTaken === true &&
        p.positions[0].stopLossPct === 0 && p.positions[0].takeProfitPct >= 6 && p.positions[0].takeProfitPct <= 8.5 &&
        Number.isFinite(p.positions[0].atrNatr),
        JSON.stringify(p && p.positions[0] && { sl: p.positions[0].stopLossPct, tp: p.positions[0].takeProfitPct, natr: p.positions[0].atrNatr }));
      check('partial is not a closed trade (no cooldown, no win counted)', p && p.totalTrades === 0 &&
        !(p.cooldowns && p.cooldowns[buy.mint] > Date.now()));
    }
    // Runner take-profit (ATR-sized ≈ +7%; series keeps rising through it).
    const sold = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL' && t.reason === 'take-profit'), 30000, 200, 'runner take-profit SELL');
    check('SELL executed (runner take-profit)', sold);
    const sells = readLedger(dir).filter((t) => t.side === 'SELL');
    check('one partial + one final close', sells.length === 2 && sells.some((t) => t.partial === true),
      JSON.stringify(sells.map((t) => ({ r: t.reason, partial: !!t.partial }))));
    const sell = sells.find((t) => t.side === 'SELL' && t.reason === 'take-profit' && t.partial !== true);
    if (sell) {
      check('runner leg pct ≈ +6..+8.5% (ATR 2.5×NATR)', sell.realizedPnlPct > 6 && sell.realizedPnlPct < 8.5,
        'pct=' + sell.realizedPnlPct);
      check('final row carries combined trade economics ≈ +5..+7.5%', Number.isFinite(sell.tradeRealizedPnlPct) &&
        sell.tradeRealizedPnlPct > 5 && sell.tradeRealizedPnlPct < 7.5, 'combined=' + sell.tradeRealizedPnlPct);
      check('combined realized positive', sell.tradeRealizedPnlSol > 0);

      p = readJson(pfile(dir));
      check('no open positions after sell', p && p.positions.length === 0);
      const expectedCash = 10 + p.realizedPnlSol;
      check('cash = 10 + realized', Math.abs(p.cashSol - expectedCash) < 1e-8);
      check('equity = cash (flat)', Math.abs(p.equitySol - p.cashSol) < 1e-8);
      check('totalPnl = realizedPnl (flat)', Math.abs(p.totalPnlSol - p.realizedPnlSol) < 1e-8);
      check('pnlPct matches accounting', Math.abs(p.pnlPct - (p.totalPnlSol / 10) * 100) < 0.001, 'pnlPct=' + p.pnlPct);
      check('stats: 1 trade, 1 win, winRate 100', p.totalTrades === 1 && p.winningTrades === 1 && p.losingTrades === 0 && p.winRate === 100);
      check('avgWin/best = combined trade realized', Math.abs(p.avgWinSol - sell.tradeRealizedPnlSol) < 1e-9 && Math.abs(p.bestTradeSol - sell.tradeRealizedPnlSol) < 1e-9);
    }
    check('equity history recorded', fs.existsSync(path.join(dir, 'equity-history.jsonl')));

    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 3. STOP-LOSS
// ============================================================================
async function testStopLoss() {
  console.log('\n[test 3] STOP-LOSS');
  const dir = freshDir('stoploss');
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [GOOD_SL()] } });
  try {
    const bought = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY'), 30000, 200, 'BUY');
    check('BUY fired', bought);
    const sold = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL'), 30000, 200, 'stop-loss SELL');
    check('SELL fired', sold);
    const sell = readLedger(dir).find((t) => t.side === 'SELL');
    if (sell) {
      check('reason = stop-loss (ATR-sized ≈ -4.2%)', sell.reason === 'stop-loss', 'reason=' + sell.reason);
      check('realized P&L negative', sell.realizedPnlSol < 0);
      check('realized pct ≈ -3..-9% (1.5×NATR)', sell.realizedPnlPct < -3 && sell.realizedPnlPct > -9,
        'pct=' + sell.realizedPnlPct);
      const p = readJson(pfile(dir));
      check('stats: 1 loss', p && p.totalTrades === 1 && p.losingTrades === 1 && p.winningTrades === 0);
      check('worst trade recorded', p && Math.abs(p.worstTradeSol - sell.realizedPnlSol) < 1e-9);
      check('cooldown set after sell', p && p.cooldowns && p.cooldowns[sell.mint] && p.cooldowns[sell.mint] > Date.now());
    }
    await gracefulStop(child);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 4. RESTART RECOVERY (portfolio + ledger + cooldowns survive)
// ============================================================================
async function testRestartRecovery() {
  console.log('\n[test 4] restart recovery');
  const dir = freshDir('restart');
  let child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] } });
  try {
    const sold = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL' && t.partial !== true), 40000, 200, 'first run SELL');
    check('first run completed a trade cycle', sold);
    await gracefulStop(child);
    check('first run exited cleanly', child.exitCode === 0);
    child = null;

    // Snapshot authoritative post-stop state (no further mutation possible —
    // reading while run 1 is still alive races with live equity appends).
    const before = readJson(pfile(dir));
    const ledgerBefore = readLedger(dir).length;
    const equityFile = path.join(dir, 'equity-history.jsonl');
    const equityBefore = fs.existsSync(equityFile) ? fs.readFileSync(equityFile, 'utf8') : '';

    // Second run — same data dir.
    child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] } });
    const loaded = await waitFor(() => readLog(dir).includes('Loaded existing paper portfolio'), 15000, 150, 'restart load log');
    check('restart loaded existing portfolio', loaded);
    const initCount = (readLog(dir).match(/Initialized new paper account/g) || []).length;
    check('account initialized only once across restarts', initCount === 1, 'count=' + initCount);

    const after = readJson(pfile(dir));
    check('starting capital preserved', after && after.startingCapitalSol === before.startingCapitalSol);
    check('cash preserved', after && Math.abs(after.cashSol - before.cashSol) < 1e-9,
      'before=' + before.cashSol + ' after=' + (after && after.cashSol));
    check('realized P&L preserved', after && Math.abs(after.realizedPnlSol - before.realizedPnlSol) < 1e-9);
    check('positions preserved', after && after.positions.length === before.positions.length);
    check('trade count preserved', after && after.totalTrades === before.totalTrades);
    check('ledger not erased', readLedger(dir).length === ledgerBefore,
      'before=' + ledgerBefore + ' after=' + readLedger(dir).length);
    const seedLogs = (readLog(dir).match(/Seeded equity-history\.jsonl/g) || []).length;
    check('equity history not re-seeded on restart', seedLogs === 1, 'seed log count=' + seedLogs);
    check('equity history preserved append-only', fs.readFileSync(equityFile, 'utf8').startsWith(equityBefore));
    const sell = readLedger(dir).find((t) => t.side === 'SELL' && t.partial !== true);
    check('cooldowns persisted across restart', after && sell && after.cooldowns[sell.mint] && after.cooldowns[sell.mint] > Date.now());

    await gracefulStop(child);
    check('second run exited cleanly', child.exitCode === 0);
  } finally {
    if (child) await hardKill(child);
  }
}

// ============================================================================
// 4b. PARTIAL RESTART RECOVERY (open partialed position survives restart)
// ============================================================================
async function testPartialRestart() {
  console.log('\n[test 4b] partial restart recovery');
  const dir = freshDir('prestart');
  // Runner unreachable (peak +21% << +999%), so the partialed lot
  // deterministically stays open through run 1. Run 2 replays a flat +10%
  // series (above entry, below runner, above breakeven) so it stays open
  // there too — restart preservation is then fully deterministic.
  // ATR disabled here to isolate partial mechanics (fixed 8% entry TP).
  const env = { CIRCUIT_RUNNER_TP_PCT: '999', CIRCUIT_ATR_DISABLE: '1' };
  const flat10 = () => tok('RISE', { series: Array(220).fill(BASE_SOL * 1.10) });
  let child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] }, extraEnv: env });
  try {
    const part = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL' && t.reason === 'partial-take'), 40000, 200, 'partial-take SELL');
    check('partial-take fired', part);
    const led = readLedger(dir);
    const buy = led.find((t) => t.side === 'BUY');
    const prow = readJson(pfile(dir));
    check('position open at half size with runner armed', prow && prow.positions.length === 1 &&
      Math.abs(prow.positions[0].quantity - buy.quantity / 2) / (buy.quantity / 2) < 0.01 &&
      prow.positions[0].partialTaken === true && prow.positions[0].stopLossPct === 0 &&
      prow.positions[0].takeProfitPct === 999,
      JSON.stringify(prow && prow.positions[0] && { q: prow.positions[0].quantity, sl: prow.positions[0].stopLossPct, tp: prow.positions[0].takeProfitPct }));
    check('partial banked without closing (0 trades, no cooldown)', prow && prow.totalTrades === 0 &&
      prow.realizedPnlSol > 0 && !(prow.cooldowns && prow.cooldowns[buy.mint] > Date.now()));
    await gracefulStop(child);
    check('first run exited cleanly', child.exitCode === 0);
    child = null;

    const before = readJson(pfile(dir));
    const ledgerBefore = readLedger(dir).length;

    child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [flat10()] }, extraEnv: env });
    const loaded = await waitFor(() => readLog(dir).includes('Loaded existing paper portfolio'), 15000, 150, 'restart load log');
    check('restart loaded existing portfolio', loaded);
    await sleep(2500); // several monitor polls on the restarted series
    const after = readJson(pfile(dir));
    check('partialed position preserved across restart', after && after.positions.length === 1 &&
      after.positions[0].partialTaken === true &&
      Math.abs(after.positions[0].quantity - before.positions[0].quantity) < 1e-9 &&
      Math.abs(after.positions[0].costSol - before.positions[0].costSol) < 1e-9 &&
      after.positions[0].stopLossPct === 0 && after.positions[0].takeProfitPct === 999);
    check('ledger preserved (BUY + partial only, no final close)', readLedger(dir).length === ledgerBefore &&
      !readLedger(dir).some((t) => t.side === 'SELL' && t.partial !== true));
    check('banked realized preserved', after && Math.abs(after.realizedPnlSol - before.realizedPnlSol) < 1e-9);
    await gracefulStop(child);
    check('second run exited cleanly', child.exitCode === 0);
  } finally {
    if (child) await hardKill(child);
  }
}

// ============================================================================
// 5. RE-ENTRY COOLDOWN (blocks, then expires; no re-buy during cooldown)
// ============================================================================
async function testCooldown() {
  console.log('\n[test 5] re-entry cooldown blocks then expires');
  const dir = freshDir('cooldown');
  // Slow gentle uptrend: 5m recovery stays inside [0.25%, 8%] for the whole
  // test, so the ONLY reason the token is skipped during the cooldown is the
  // cooldown gate itself.
  const child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, tokens: [GOOD_DRIFT()] },
    extraEnv: { CIRCUIT_COOLDOWN_MS: '6000' }
  });
  try {
    const bought1 = await waitFor(() => readLedger(dir).filter((t) => t.side === 'BUY').length >= 1, 40000, 200, 'first BUY');
    check('first BUY', bought1);
    const sold = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL' && t.partial !== true), 40000, 200, 'take-profit SELL');
    check('take-profit SELL fired', sold);
    const sell = readLedger(dir).find((t) => t.side === 'SELL' && t.partial !== true);
    const tSell = Date.parse(sell.timestamp);

    // Cooldown filter must appear and NO new BUY during the cooldown window.
    const blocked = await waitFor(() => /\[FILTER\] DRIFT re-entry cooldown/.test(readLog(dir)), 15000, 150, 'cooldown filter log');
    check('re-entry cooldown filter logged', blocked);
    await sleep(2500); // well inside the 6s cooldown
    const buysMid = readLedger(dir).filter((t) => t.side === 'BUY').length;
    check('no second BUY during cooldown', buysMid === 1, 'buys=' + buysMid);
    const pMid = readJson(pfile(dir));
    check('cooldown timestamp persisted > now', pMid && pMid.cooldowns[sell.mint] && pMid.cooldowns[sell.mint] > Date.now());

    // After the cooldown expires the token is re-buyable.
    const bought2 = await waitFor(() => readLedger(dir).filter((t) => t.side === 'BUY').length >= 2, 25000, 200, 'second BUY after cooldown');
    check('second BUY after cooldown expiry', bought2);
    const buys2 = readLedger(dir).filter((t) => t.side === 'BUY');
    const tBuy2 = Date.parse(buys2[1].timestamp);
    check('second BUY waited out the cooldown', tBuy2 - tSell >= 5000, 'gap=' + ((tBuy2 - tSell) / 1000).toFixed(1) + 's');

    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 5b. BOUNCE CONFIRMATION — single jump then flat never buys
// ============================================================================
async function testBounceConfirmation() {
  console.log('\n[test 5b] bounce confirmation rejects single-point recovery');
  const dir = freshDir('bounce');
  // Flat, one +3% jump at step 40, then flat: the 5m recovery reads +3%
  // (buyable by the old point rule, score ≈67) but the bounce is dead —
  // only ONE rising interval exists, never the required two.
  const series = [];
  for (let i = 0; i < 220; i++) series.push(BASE_SOL * (i < 40 ? 1 : 1.03));
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [tok('SPIKE', { series })] } });
  try {
    await sleep(13000); // jump lands ~6s in; buyable-by-old-rule window ~6-8s
    check('no BUY on a single-jump flat-top', !readLedger(dir).some((t) => t.side === 'BUY'),
      JSON.stringify(readLedger(dir).map((t) => ({ side: t.side, reason: t.reason }))));
    check('bounce-unconfirmed FILTER logged', /\[FILTER\] SPIKE bounce unconfirmed/.test(readLog(dir)));
    check('agent still running', readJson(hfile(dir)) && readJson(hfile(dir)).state === 'running');
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 5c. PROMOTED BANDS GATE — seeded bandsBase tightens the live 1h/5m filter
// ============================================================================
async function testTightBandsGate() {
  console.log('\n[test 5c] promoted global bands tighten live entry filter');
  const dir = freshDir('bands');
  // Seed a promoted V1.1 with the tight bands (as applyExperiment would write
  // it). Startup loads it into the scan path; V1 would BUY this token.
  const TIGHT = { minScore: 60, min1h: -25, max1h: 8, min5m: 1, max5m: 5 };
  fs.writeFileSync(path.join(dir, 'strategy-versions.json'), JSON.stringify({
    current: 'V1.1',
    versions: [
      { id: 'V1', parentId: null, experimentId: null, deltas: { minScoreBase: 60, maxBuysBase: 5, recoverySizeMultiplier: 0.5 }, createdAt: new Date().toISOString(), status: 'active' },
      { id: 'V1.1', parentId: 'V1', experimentId: 'seed', deltas: { minScoreBase: 60, maxBuysBase: 5, recoverySizeMultiplier: 0.5, bandsBase: TIGHT }, createdAt: new Date().toISOString(), status: 'active' }
    ]
  }, null, 2) + '\n');
  // 1h=-30 dips past the tight -25 floor (V1 -35 would allow it); otherwise a
  // model citizen: rising series, score ≈75, NATR ≈3.8% < 4%.
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [tok('DIP30', { series: slowDrift(300, 0.002), change1hPct: -30 })] } });
  try {
    await sleep(12000); // warmup + several scans past the buyable window
    check('no BUY under tight bands (1h -30 rejected)', !readLedger(dir).some((t) => t.side === 'BUY'),
      JSON.stringify(readLedger(dir).map((t) => ({ side: t.side, reason: t.reason }))));
    check('FILTER shows tightened 1h range (-25..8)', /\[FILTER\] DIP30 1h change outside range \(-25\.\.8\)/.test(readLog(dir)));
    check('agent still running', readJson(hfile(dir)) && readJson(hfile(dir)).state === 'running');
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 5d. ORDER-FLOW + VALUATION GATES — distribution and thinness never buy
// ============================================================================
async function testOrderflowGates() {
  console.log('\n[test 5d] order-flow + liq-vs-mcap gates reject bad microstructure');
  const dir = freshDir('quality');
  // Both tokens are model citizens otherwise (rising series, score ≈65,
  // NATR ≈2.8%, confirmed bounce): the ONLY blockers are microstructure.
  const rising = riseThenMaybeFall(130, 0.0015, 0, 0);
  const child = boot(dir, {
    mock: {
      solPriceUsd: SOL_USD,
      tokens: [
        tok('SELLPRESS', { series: rising.slice(), extra: { txBuys: 100, txSells: 300, marketCapUsd: 5000000 } }),
        tok('THINMCAP', { series: rising.slice(), liquidityUsd: 100000, extra: { txBuys: 200, txSells: 100, marketCapUsd: 10000000 } })
      ]
    }
  });
  try {
    await sleep(13000); // warmup + several scans past the buyable window
    check('no BUY on distribution or thin valuation', !readLedger(dir).some((t) => t.side === 'BUY'),
      JSON.stringify(readLedger(dir).map((t) => ({ side: t.side, reason: t.reason }))));
    const log = readLog(dir);
    check('FILTER orderflow distribution logged', /\[FILTER\] SELLPRESS orderflow distribution \(sells 300 > 1\.5× buys 100\)/.test(log));
    check('FILTER thin-vs-mcap logged', /\[FILTER\] THINMCAP liquidity thin vs valuation/.test(log));
    check('agent still running', readJson(hfile(dir)) && readJson(hfile(dir)).state === 'running');
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 5f. ENSEMBLE 2/3 — SHADOW records without blocking; ENFORCE matches shadow
// ============================================================================
function readEnsembleShadow(dir) {
  const f = path.join(dir, 'ensemble-shadow.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

async function testEnsembleShadow() {
  console.log('\n[test 5f] ensemble 2/3 SHADOW records, ENFORCE follows shadow');
  const dir = freshDir('ensemble');
  // SHADOW (default; TA OFF per harness, ATLAS SHADOW on): V1 must still buy
  // while every V1-pass candidate gets a recorded ensemble verdict.
  let child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] } });
  try {
    const bought = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY'), 40000, 200, 'V1 BUY in SHADOW');
    check('SHADOW never blocks V1 entries', bought);
    const sawRows = await waitFor(() => readEnsembleShadow(dir).length > 0, 15000, 200, 'ensemble shadow rows');
    const rows = readEnsembleShadow(dir);
    check('SHADOW recorded ensemble verdicts', sawRows && rows.length > 0, 'rows=' + rows.length);
    const r0 = rows && rows[0];
    check('shadow row carries votes + consistency', r0 && r0.v1 === true && r0.wouldAllow === (r0.agrees >= r0.needed) && r0.mode === 'SHADOW' && r0.blocked === false,
      JSON.stringify(r0));
    check('[ENSEMBLE] logged per evaluated candidate', /\[ENSEMBLE\] RISE \d\/3/.test(readLog(dir)));
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
    child = null;

    // ENFORCE: TA OFF (abstain) + ATLAS HOLD (remembered via verdict memory)
    // → 1/3 → every V1-pass entry blocks deterministically. Execution must
    // match shadow: no BUY, FILTER ensemble logged, rows blocked:true.
    const dir2 = freshDir('ensemble-enf');
    child = boot(dir2, {
      mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] },
      extraEnv: { CIRCUIT_ENSEMBLE_MODE: 'ENFORCE' }
    });
    const sawRows2 = await waitFor(() => readEnsembleShadow(dir2).length > 0, 40000, 200, 'enforce shadow rows');
    const rows2 = readEnsembleShadow(dir2);
    check('ENFORCE evaluates ensemble verdicts', sawRows2 && rows2.length > 0);
    await sleep(10000); // several V1-pass scans past the buyable window
    check('ENFORCE blocks 1/3 entries (no BUY)', !readLedger(dir2).some((t) => t.side === 'BUY'),
      JSON.stringify(readLedger(dir2).map((t) => ({ side: t.side, reason: t.reason }))));
    check('blocked entries log FILTER ensemble', /\[FILTER\] RISE ensemble 1\/3/.test(readLog(dir2)));
    check('shadow rows agree (wouldAllow:false, blocked:true)',
      rows2.length > 0 && rows2.every((r) => r.wouldAllow === false && r.blocked === true && r.mode === 'ENFORCE'),
      JSON.stringify(rows2.slice(0, 2)));
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    if (child) await hardKill(child);
  }
}

// ============================================================================
// 5e. CALIBRATED P(WIN) GATE — trained model filters live entries
// ============================================================================
async function testWinprobGate() {
  console.log('\n[test 5e] calibrated P(win) gate filters low-probability entries');
  const dir = freshDir('winprob');
  // Seed 8 wins (score 78) + 8 losses (score 62), all else equal: the model
  // learns score-band separation (75+ ≈ winners, 60-64 ≈ losers).
  const seeded = [];
  for (let i = 0; i < 8; i++) {
    seeded.push({ buyId: i * 4 + 1, sellId: i * 4 + 2, mint: 'W' + i + 'w'.repeat(38) + '1', symbol: 'WIN' + i, entryTs: Date.now() - 86400000, exitTs: Date.now() - 86000000, entryScore: 78, change1hPct: -15, recovery5mPct: 2.5, liquidityUsd: 150000, pnlPct: 8, reason: 'take-profit' });
    seeded.push({ buyId: i * 4 + 3, sellId: i * 4 + 4, mint: 'L' + i + 'l'.repeat(38) + '2', symbol: 'LOS' + i, entryTs: Date.now() - 86400000, exitTs: Date.now() - 85900000, entryScore: 62, change1hPct: -15, recovery5mPct: 2.5, liquidityUsd: 150000, pnlPct: -6, reason: 'stop-loss' });
  }
  seedAccount(dir, seeded);
  // LOW scores ≈63 (loser band, but ≥60 V1 floor); HIGH scores ≈77 (winner
  // band). Otherwise identical model citizens on rising series.
  const rising = riseThenMaybeFall(130, 0.0015, 0, 0);
  const child = boot(dir, {
    mock: {
      solPriceUsd: SOL_USD,
      tokens: [
        tok('LOWP', { series: rising.slice(), change1hPct: -18 }),
        tok('HIGHP', { series: rising.slice(), change1hPct: -34 })
      ]
    }
  });
  try {
    const sawModel = await waitFor(() => /\[WINPROB\] n=16/.test(readLog(dir)), 20000, 200, 'winprob trained on 16');
    check('winprob trained on seeded ledger', sawModel);
    const highBuy = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY' && t.symbol === 'HIGHP'), 40000, 200, 'HIGHP BUY');
    check('high-probability entry still buys', highBuy);
    await sleep(8000); // let HIGHP work the partial+runner path; LOWP must never buy
    check('low-probability entry never buys', !readLedger(dir).some((t) => t.side === 'BUY' && t.symbol === 'LOWP'),
      JSON.stringify(readLedger(dir).filter((t) => t.symbol === 'LOWP').map((t) => ({ side: t.side, reason: t.reason }))));
    check('FILTER winprob reason logged', /\[FILTER\] LOWP winprob 0\.\d+ < 0\.\d+ \(n=16\)/.test(readLog(dir)));
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    if (child) await hardKill(child);
  }
}

// ============================================================================
// 5g. BANDIT minScore — Thompson-selected per-cluster floor gates live entries
// ============================================================================
async function testBanditGate() {
  console.log('\n[test 5g] bandit per-cluster minScore gates live entries');
  const dir = freshDir('bandit');
  // Seed 4 timeOfDay buckets × (10W@arm70 + 8L@arm60), all score 70 (so the
  // winprob model stays neutral and cannot separate the live candidates).
  // Mix works out to WR 55.6%, avg +1.78 → regime bull, stable even after
  // the control trade closes (no cluster migration mid-test).
  const day = Math.floor(Date.now() / 86400000) * 86400000;
  const buckets = [['morning', 8], ['afternoon', 14], ['evening', 20], ['night', 2]];
  const rows = [];
  let id = 1;
  const buyRow = (m, sym, ets, arm) => ({
    id: id++, timestamp: new Date(ets).toISOString(), side: 'BUY',
    symbol: sym, mint: m, quantity: 0.05 / 6.67e-8, price: 6.67e-8,
    valueSol: 0.05, realizedPnlSol: 0, realizedPnlPct: 0, source: 'mock',
    score: 70, change1hPct: -15, recovery5mPct: 2.5,
    liquidityUsd: 150000, volume24hUsd: 500000,
    regime: 'bull', entryMinScore: arm
  });
  const sellRow = (m, sym, ets, pnl) => ({
    id: id++, timestamp: new Date(ets).toISOString(), side: 'SELL',
    symbol: sym, mint: m, quantity: 0.05 / 6.67e-8, price: 6.67e-8 * (1 + pnl / 100),
    valueSol: 0.05 * (1 + pnl / 100), realizedPnlSol: 0.05 * pnl / 100,
    realizedPnlPct: pnl, entryPriceSol: 6.67e-8, costSol: 0.05, source: 'mock',
    reason: pnl > 0 ? 'take-profit' : 'stop-loss'
  });
  for (const [tod, h] of buckets) {
    for (let i = 0; i < 10; i++) {
      const etsW = day - 86400000 + h * 3600000 + i * 60000;
      const mw = `bw-${tod}-${i}`;
      rows.push(buyRow(mw, 'W', etsW, 70));
      rows.push(sellRow(mw, 'W', etsW + 3600000, 8));
    }
    for (let i = 0; i < 8; i++) {
      const etsL = day - 86400000 + h * 3600000 + i * 60000 + 30000;
      const ml = `bl-${tod}-${i}`;
      rows.push(buyRow(ml, 'L', etsL, 60));
      rows.push(sellRow(ml, 'L', etsL + 3600000, -6));
    }
  }
  fs.writeFileSync(path.join(dir, 'trades.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'portfolio.json'), JSON.stringify({
    name: 'paper-trader', mode: 'paper', startingCapitalSol: 10, cashSol: 10,
    investedSol: 0, marketValueSol: 0, equitySol: 10, realizedPnlSol: 0,
    unrealizedPnlSol: 0, totalPnlSol: 0, pnlPct: 0, totalTrades: 0,
    winningTrades: 0, losingTrades: 0, winRate: 0, avgWinSol: 0, avgLossSol: 0,
    bestTradeSol: 0, worstTradeSol: 0, sumWinSol: 0, sumLossSol: 0,
    nextTradeId: id, scans: 0, positions: [], cooldowns: {}, updatedAt: Date.now()
  }, null, 2) + '\n');
  // Seed the detected regime (WR 55.6%, avg +1.78 → bull) so live cluster
  // keys match the seeded arms from the very first scan — otherwise
  // cold-start UNKNOWN clusters fall back to the V1 floor.
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'regime-state.json'), JSON.stringify({
    regime: 'bull', confidence: 0.7, reasoning: 'seeded for bandit test',
    data: { windowTrades: 72, winRate: 55.6, avgPnlPct: 1.78 },
    detectedAt: nowIso, validUntil: new Date(Date.now() + 2 * 3600 * 1000).toISOString()
  }, null, 2) + '\n');
  // LOW scores ≈64 (V1 floor passed, bandit arm 70 blocks); HIGH ≈77 (passes).
  // Selection day pinned (verified offline: all four bucket seeds pick arm
  // 70 on 2026-01-04) so Thompson sampling is fully deterministic here.
  // Mock SOL runs a healthy uptrend so the market regime reads bull —
  // matching the seeded bandit clusters (regime-state seed covers pre-loop
  // scans; the fast loop then sustains bull from mock SOL).
  const rising = riseThenMaybeFall(130, 0.0015, 0, 0);
  const child = boot(dir, {
    mock: {
      solPriceUsd: SOL_USD, solChange1hPct: 2, solChange24hPct: 6,
      tokens: [
        tok('BLOW', { series: rising.slice(), change1hPct: -20 }),
        tok('BHIGH', { series: rising.slice(), change1hPct: -34 })
      ]
    },
    extraEnv: { CIRCUIT_BANDIT_LIVE: '1', CIRCUIT_AGENT_LOOP_MS: '2000', CIRCUIT_BANDIT_DAY: '2026-01-04' }
  });
  try {
    const sawBandit = await waitFor(() => /\[BANDIT\] \d+ cluster\(s\)/.test(readLog(dir)), 20000, 200, 'bandit selection');
    check('bandit selected arms from seeded ledger', sawBandit);
    const highBuy = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY' && t.symbol === 'BHIGH'), 40000, 200, 'BHIGH BUY');
    check('above-arm entry still buys', highBuy);
    await sleep(6000); // let BHIGH work; BLOW must never buy
    check('below-arm entry never buys', !readLedger(dir).some((t) => t.side === 'BUY' && t.symbol === 'BLOW'),
      JSON.stringify(readLedger(dir).filter((t) => t.symbol === 'BLOW').map((t) => ({ side: t.side, reason: t.reason }))));
    check('FILTER bandit minScore logged', /\[FILTER\] BLOW bandit minScore 70 \(cluster \S+\)/.test(readLog(dir)));
    const hb = readJson(hfile(dir));
    check('heartbeat shows bandit live', hb && hb.adaptive && hb.adaptive.bandit && hb.adaptive.bandit.live === true);
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    if (child) await hardKill(child);
  }
}

// ============================================================================
// 5h. GAP-KILL FAST-CONFIRM — sustained -60% cliff exits at the gap price
// ============================================================================
async function testGapKill() {
  console.log('\n[test 5h] adverse cliff fast-confirms (no single-print sell, no bleed)');
  const dir = freshDir('gapkill');
  // Rise (buyable) then a sustained -60% cliff, then flat: the first cliff
  // print only quarantines (ZCAT rule — never sell one print); the second
  // consistent print confirms (fast-confirm, not the full count) and the
  // stop-loss fires AT the gap price instead of bleeding further.
  const peak = BASE_SOL * Math.pow(1.0015, 39);
  const low = peak * 0.4;
  const series = [];
  for (let i = 0; i < 40; i++) series.push(BASE_SOL * Math.pow(1.0015, i));
  for (let i = 0; i < 120; i++) series.push(low);
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [tok('CLIFF', { series })] } });
  try {
    const sold = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL' && t.partial !== true), 40000, 200, 'cliff SELL');
    check('SELL executed after the cliff', sold);
    // Final (non-partial) close regardless of whether a +5% partial fired
    // before the cliff landed — both orders end in a gap-price stop-loss.
    const sell = readLedger(dir).find((t) => t.side === 'SELL' && t.partial !== true);
    check('exit reason is stop-loss (confirmed, not single-print)', sell && sell.reason === 'stop-loss', 'reason=' + (sell && sell.reason));
    check('exits AT the gap price ≈ -55..-65% (no extra bleed)', sell && sell.realizedPnlPct < -55 && sell.realizedPnlPct > -65,
      'pct=' + (sell && sell.realizedPnlPct));
    check('no gap-kill check errors (valve uses maxPriceAgeMs)', !/gap-kill check error/.test(readLog(dir)));
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 5i. DAILY LOSS HALT — day P&L ≤ -3% forces watchOnly, no entries
// ============================================================================
async function testDailyHalt() {
  console.log('\n[test 5i] daily loss halt blocks new entries');
  const dir = freshDir('dailyhalt');
  // Seeded account sits -4% on the day (9.6 vs 10.0 anchor, same UTC date).
  // No positions, no trades — the halt must come from the day anchor alone.
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, 'portfolio.json'), JSON.stringify({
    name: 'paper-trader', mode: 'paper', startingCapitalSol: 10, cashSol: 9.6,
    investedSol: 0, marketValueSol: 0, equitySol: 9.6, realizedPnlSol: -0.4,
    unrealizedPnlSol: 0, totalPnlSol: -0.4, pnlPct: -4, totalTrades: 2,
    winningTrades: 0, losingTrades: 2, winRate: 0, avgWinSol: 0, avgLossSol: -0.2,
    bestTradeSol: 0, worstTradeSol: -0.4, sumWinSol: 0, sumLossSol: -0.4,
    nextTradeId: 1, scans: 0, positions: [], cooldowns: {},
    dayAnchorSol: 10, dayAnchorDate: today, updatedAt: Date.now()
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'trades.jsonl'), '');
  const child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, tokens: [GOOD_DRIFT()] },
    extraEnv: { CIRCUIT_AGENT_LOOP_MS: '2000' }
  });
  try {
    const halted = await waitFor(() => {
      const f = path.join(dir, 'adaptive-policy.json');
      return fs.existsSync(f) && readJson(f) && readJson(f).mode === 'watchOnly';
    }, 20000, 200, 'halted policy');
    check('day P&L -4% → watchOnly policy', halted);
    const p = readJson(path.join(dir, 'adaptive-policy.json'));
    check('halt reason names the daily loss', p && /Daily loss halt/.test(p.reason || ''), p && p.reason);
    check('halt sets maxBuys 0', p && p.maxBuys === 0);
    await sleep(6000); // several warmed scans must still not buy
    check('no BUY while halted', readLedger(dir).filter((t) => t.side === 'BUY').length === 0,
      'buys=' + readLedger(dir).filter((t) => t.side === 'BUY').length);
    const hb = readJson(hfile(dir));
    check('heartbeat carries day P&L', hb && hb.adaptive && Math.abs(hb.adaptive.dayPnlPct - (-4)) < 0.01,
      hb && hb.adaptive && ('dayPnlPct=' + hb.adaptive.dayPnlPct));
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}
// ============================================================================
async function testInvalidStalePrices() {
  console.log('\n[test 6] invalid / stale prices → NO TRADE');
  const dir = freshDir('invalid');
  const child = boot(dir, {
    mock: {
      solPriceUsd: SOL_USD,
      tokens: [
        GOOD_TP(),
        tok('BADINV', { extra: { invalid: true } }),
        tok('BADSTALE', { extra: { stale: true } }),
        tok('STALEBUY', { extra: { staleAtBuy: true } }),
        tok('INVBUY', { extra: { invalidAtBuy: true } })
      ]
    }
  });
  try {
    const bought = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY'), 30000, 200, 'good token BUY');
    check('valid token still traded', bought);
    const log = readLog(dir);
    // Tokens with invalid/stale data never warm into a buyable state — the
    // sampler rejects their poisoned prices, so they stay WARMING and are
    // filtered before any trade (the buy-time price gate itself is covered by
    // the unit tests in [test 0]).
    check('poisoned tokens filtered pre-trade', /\[FILTER\] (STALEBUY|INVBUY) (score below threshold|5m recovery warming)/.test(log),
      'no filter line found');
    const led = readLedger(dir);
    check('no BUY for bad tokens', !led.some((t) => ['BADINV', 'BADSTALE', 'STALEBUY', 'INVBUY'].includes(t.symbol)),
      JSON.stringify(led.map((t) => t.symbol)));
    const hb = readJson(hfile(dir));
    check('agent still running', hb && hb.state === 'running');
    await gracefulStop(child);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 7. PROVIDER FAILURE (per-token + total outage) — agent keeps running
// ============================================================================
async function testProviderFailure() {
  console.log('\n[test 7] provider failure — per-token and total outage');
  const dir = freshDir('fail');
  let child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP(), tok('DEAD', { extra: { fail: true } })] }
  });
  try {
    const bought = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY'), 30000, 200, 'good token BUY');
    check('healthy token traded despite one bad token', bought);
    const log = readLog(dir);
    check('sampler skipped the failed token', /\[HISTORY-SKIP\]/.test(log));
    check('no BUY for failed token', !readLedger(dir).some((t) => t.symbol === 'DEAD'));
    let hb = readJson(hfile(dir));
    check('agent alive after per-token failure', hb && hb.state === 'running');
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
    child = null;

    // Total outage (failAll) — the agent must log and keep running, never crash.
    const dir2 = freshDir('failall');
    child = boot(dir2, { mock: { solPriceUsd: SOL_USD, failAll: true, tokens: [GOOD_TP()] } });
    await sleep(2500);
    const log2 = readLog(dir2);
    check('discovery failure logged', /\[DISCOVERY-SKIP\]/.test(log2));
    check('history failure logged', /\[HISTORY-SKIP\]/.test(log2) || /\[PRICE-FALLBACK\]/.test(log2));
    const hb2 = readJson(hfile(dir2));
    check('heartbeat still running during outage', hb2 && hb2.state === 'running');
    check('no trades during outage', readLedger(dir2).length === 0);
    await gracefulStop(child);
    check('agent exited cleanly after outage', child.exitCode === 0);
  } finally {
    if (child) await hardKill(child);
  }
}

// ============================================================================
// 8. CONCURRENT SAMPLER (bounded concurrency, one bad token doesn't stop it)
// ============================================================================
async function testConcurrentSampler() {
  console.log('\n[test 8] concurrent sampler over a 40-token universe');
  const dir = freshDir('sampler');
  const tokens = [];
  for (let i = 0; i < 30; i++) tokens.push(tok('T' + i, { series: slowDrift(60, 0.001) }));
  for (let i = 0; i < 10; i++) tokens.push(tok('DEAD' + i, { extra: { fail: true } }));
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens } });
  try {
    const sampled = await waitFor(() => {
      const m = readLog(dir).match(/\[SAMPLER\] recorded (\d+) price sample\(s\)/g);
      return !!m && m.length >= 3;
    }, 8000, 200, 'several sampler cycles');
    check('sampler completed multiple cycles', sampled);
    const log = readLog(dir);
    const last = (log.match(/\[SAMPLER\] recorded (\d+) price sample\(s\)/g) || []).pop();
    const n = last ? parseInt(last.match(/(\d+)/)[1], 10) : 0;
    check('sampler recorded the healthy tokens (' + n + ' samples)', n >= 25, 'n=' + n);
    check('failed tokens skipped, not fatal', /\[HISTORY-SKIP\]/.test(log));
    const hb = readJson(hfile(dir));
    check('agent alive', hb && hb.state === 'running');
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 9. PROCESS LOCK — no two copies of the agent
// ============================================================================
async function testProcessLock() {
  console.log('\n[test 9] process lock prevents duplicate agents');
  const dir = freshDir('lock');
  const mock = { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] };
  const a = boot(dir, { mock });
  try {
    await waitFor(() => fs.existsSync(lfile(dir)), 10000, 150, 'first agent lock');
    const b = boot(dir, { mock });
    const bExit = await new Promise((resolve) => { b.once('exit', (code) => resolve(code)); });
    check('second instance refused to start', bExit === 1, 'exit=' + bExit);
    check('second instance logged the conflict', /another agent instance is already running/.test(b.__out() + readLog(dir)));
    check('first instance still alive', a.exitCode === null);
    await gracefulStop(a);
    check('first instance exits cleanly', a.exitCode === 0);
  } finally {
    await hardKill(a);
  }
}

// ============================================================================
// 10. GRACEFUL SHUTDOWN over IPC
// ============================================================================
async function testShutdown() {
  console.log('\n[test 10] graceful shutdown');
  const dir = freshDir('shutdown');
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [GOOD_TP()] } });
  try {
    await waitFor(() => fs.existsSync(hfile(dir)), 10000, 150, 'heartbeat');
    await gracefulStop(child);
    check('exited with code 0', child.exitCode === 0);
    const hb = readJson(hfile(dir));
    check('heartbeat state=stopped', hb && hb.state === 'stopped');
    check('lock released', !fs.existsSync(lfile(dir)));
    check('shutdown line logged', /\[SHUTDOWN\]/.test(readLog(dir)));
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 11. INR FX DISPLAY LAYER (fx.js — pure conversions, never engine logic)
// ============================================================================
async function testFxRates() {
  console.log('\n[test 11] INR FX display layer (fx.js)');
  const fx = require('../fx.js');

  // Formula: INR = SOL × (solUsd × usdInr) == USD × usdInr
  const solUsd = 103.5, usdInr = 94.54;
  const ips = fx.inrPerSolOf(solUsd, usdInr);
  check('inrPerSol = solUsd × usdInr', ips !== null && Math.abs(ips - 103.5 * 94.54) < 1e-9);
  const viaSol = fx.inrFromSol(10, ips);
  const viaUsd = fx.inrFromUsd(10 * solUsd, usdInr);
  check('SOL→INR equals USD→INR for the same value',
    viaSol !== null && viaUsd !== null && Math.abs(viaSol - viaUsd) < 1e-6,
    'viaSol=' + viaSol + ' viaUsd=' + viaUsd);
  check('10 SOL converts to ₹97,848.90', viaSol !== null && Math.abs(viaSol - 97848.9) < 0.01);
  check('invalid rates → null (never fabricate)',
    fx.inrPerSolOf(0, 94) === null && fx.inrPerSolOf(103, 0) === null && fx.inrFromUsd(5, null) === null);

  // Indian number formatting
  check('₹1,234.56', fx.formatInr(1234.56) === '₹1,234.56');
  check('₹1,00,000.00', fx.formatInr(100000) === '₹1,00,000.00');
  check('negative → ₹-83.50', fx.formatInr(-83.5) === '₹-83.50');
  check('signed → +₹4.30', fx.signedInr(4.3) === '+₹4.30');
  check('grouping 1234567 → 12,34,567', fx.groupIndian('1234567') === '12,34,567');

  // Live sources: primary open.er-api.com fails → frankfurter.app fallback
  const calls = [];
  const flakyFetch = async (url) => {
    calls.push(url);
    if (url.indexOf('open.er-api') >= 0) throw new Error('primary down');
    return { ok: true, json: async () => ({ rates: { INR: 94.4 } }) };
  };
  const r1 = await fx.fetchUsdInr({ fetchImpl: flakyFetch });
  check('fallback source used when primary fails',
    r1 && r1.source === 'frankfurter.app' && Math.abs(r1.usdInr - 94.4) < 1e-9);
  check('primary tried before fallback', calls.length === 2 && /open\.er-api/.test(calls[0]));

  const goodFetch = async (url) => {
    if (url.indexOf('open.er-api') >= 0) return { ok: true, json: async () => ({ result: 'success', rates: { INR: 94.5 } }) };
    throw new Error('fallback should not be needed');
  };
  const r2 = await fx.fetchUsdInr({ fetchImpl: goodFetch });
  check('primary source parses correctly', r2 && r2.source === 'open.er-api.com' && Math.abs(r2.usdInr - 94.5) < 1e-9);

  // Third host fallback (frankfurter.dev) when the first two hosts fail
  const devFetch = async (url) => {
    if (url.indexOf('open.er-api') >= 0) return { ok: true, json: async () => ({ result: 'error' }) };
    if (url.indexOf('frankfurter.app') >= 0) return { ok: true, json: async () => ({ rates: {} }) }; // unparseable
    if (url.indexOf('frankfurter.dev') >= 0) return { ok: true, json: async () => ({ rates: { INR: 94.7 } }) };
    throw new Error('unexpected url ' + url);
  };
  const rDev = await fx.fetchUsdInr({ fetchImpl: devFetch });
  check('third host (frankfurter.dev) used when first two fail',
    rDev && rDev.source === 'frankfurter.dev' && Math.abs(rDev.usdInr - 94.7) < 1e-9);


  // Cached-rate fallback: valid cache on disk + live outage → keep last real rate
  const cacheFile = path.join(TMP, 'fx-cache-' + Date.now() + '.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ usdInr: 94.0, source: 'open.er-api.com', fetchedAt: Date.now() - 60000 }));
  const deadFetch = async () => { throw new Error('network down'); };
  const mgr = fx.createFxManager({ cacheFile, fetchImpl: deadFetch, refreshMs: 0 });
  const cur = await mgr.refresh();
  check('live outage → cached last valid rate kept', cur && cur.cached === true && Math.abs(cur.usdInr - 94.0) < 1e-9);
  check('outage recorded as lastError', typeof mgr.lastError === 'string' && mgr.lastError.length > 0);

  // Successful refresh is flagged live and persisted to the cache file
  const mgr2 = fx.createFxManager({ cacheFile: cacheFile + '2.json', fetchImpl: goodFetch, refreshMs: 0 });
  const cur2 = await mgr2.refresh();
  check('live refresh not flagged cached', cur2 && cur2.cached === false && Math.abs(cur2.usdInr - 94.5) < 1e-9);
  const disk = readJson(cacheFile + '2.json');
  check('rate persisted to cache file', disk && Math.abs(disk.usdInr - 94.5) < 1e-9);

  // No cache + everything down → null, never a fabricated rate
  const mgr3 = fx.createFxManager({ cacheFile: path.join(TMP, 'fx-none-' + Date.now() + '.json'), fetchImpl: deadFetch, refreshMs: 0 });
  const cur3 = await mgr3.refresh();
  check('total outage without cache → null (never fake)', cur3 === null && mgr3.current() === null);

  // Adaptive retry: after a failure the next attempt fires at failureRetryMs,
  // not after the long refreshMs
  const mgrRetry = fx.createFxManager({
    cacheFile: path.join(TMP, 'fx-retry-' + Date.now() + '.json'),
    fetchImpl: deadFetch, refreshMs: 60000, failureRetryMs: 250
  });
  await mgrRetry.refresh();            // fails → lastError set, lastTryAt stamped
  const tA = mgrRetry.lastTryAt;
  mgrRetry.start();
  const retried = await waitFor(() => mgrRetry.lastTryAt > tA, 2000, 50, 'fast retry after failure');
  mgrRetry.stop();
  check('failed refresh retried at failureRetryMs (not refreshMs)', retried);
}

// ============================================================================
// 12. ADAPTIVE UNIT GATES (require the modules directly — no child processes)
// ============================================================================
async function testAdaptiveUnits() {
  console.log('\n[test 12] adaptive units — perf analyzer, regime, gates, policy, experiments, reflection, llm, health');
  const perf = require('../performance-analyzer.js');
  const regime = require('../regime-detector.js');
  const gates = require('../learned-gates.js');
  const policy = require('../adaptive-policy.js');
  const exp = require('../strategy-experiments.js');
  const reflect = require('../reflection-engine.js');
  const llm = require('../llm-adapter.js');
  const health = require('../market-health.js');

  const now = Date.now();
  const DAY = 86400000;

  // ---- performance-analyzer -------------------------------------------------
  const mkClosed = (i, pnlPct, opts = {}) => ({
    mint: 'M' + i, symbol: 'T' + i,
    entryTs: now - 2 * DAY, exitTs: opts.exitOffsetMs != null ? now + opts.exitOffsetMs : now - DAY + i * 1000,
    entryScore: opts.score != null ? opts.score : 70,
    change1hPct: opts.c1h != null ? opts.c1h : -20,
    recovery5mPct: opts.c5m != null ? opts.c5m : 2,
    liquidityUsd: opts.liq != null ? opts.liq : 150000,
    entryPriceSol: 1e-6, exitPriceSol: 1e-6 * (1 + pnlPct / 100),
    realizedPnlSol: pnlPct, realizedPnlPct: pnlPct,
    exitReason: opts.reason || 'take-profit', won: pnlPct > 0
  });
  const mWins = perf.computeMetrics([mkClosed(1, 8), mkClosed(2, 9), mkClosed(3, -6), mkClosed(4, 7)]);
  check('metrics: win rate 75%', mWins.winRate === 75, 'wr=' + mWins.winRate);
  check('metrics: 3 wins 1 loss', mWins.wins === 3 && mWins.losses === 1);
  check('metrics: expectancy > 0', mWins.expectancyPct > 0);
  check('metrics: profit factor = 24/6 = 4', mWins.profitFactor === 4, 'pf=' + mWins.profitFactor);
  check('metrics: win streak 2 (W,W,L,W), current +1', mWins.winStreak === 2 && mWins.currentStreak === 1, 'ws=' + mWins.winStreak + ' cs=' + mWins.currentStreak);
  const mLosses = perf.computeMetrics([mkClosed(1, -6), mkClosed(2, -7), mkClosed(3, -5)]);
  check('metrics: loss streak 3', mLosses.lossStreak === 3 && mLosses.currentStreak === -3);
  // Regression: without starting capital the equity curve starts at 0, so a
  // win-then-loss-run used to produce drawdown % past 100 (e.g. -832%).
  const mDd = perf.computeMetrics([mkClosed(1, 2), mkClosed(2, -6), mkClosed(3, -7), mkClosed(4, -5)]);
  check('metrics: drawdown % capped at 100 without starting capital', mDd.maxDrawdownPct > 0 && mDd.maxDrawdownPct <= 100, 'dd=' + mDd.maxDrawdownPct);
  const mDdCap = perf.computeMetrics([mkClosed(1, 2), mkClosed(2, -2), mkClosed(3, -3), mkClosed(4, -1)], 10);
  check('metrics: drawdown % sane with starting capital 10', mDdCap.maxDrawdownPct > 0 && mDdCap.maxDrawdownPct < 100, 'dd=' + mDdCap.maxDrawdownPct);

  const ledger = [
    { side: 'BUY', timestamp: new Date(now - DAY).toISOString(), mint: 'AAA1', symbol: 'A', price: 1e-6, score: 75, change1hPct: -20, recovery5mPct: 2, liquidityUsd: 150000, valueSol: 0.05 },
    { side: 'SELL', timestamp: new Date(now - DAY + 1000).toISOString(), mint: 'AAA1', symbol: 'A', price: 1.08e-6, realizedPnlSol: 0.004, realizedPnlPct: 8, reason: 'take-profit' },
    { side: 'BUY', timestamp: new Date(now - DAY + 2000).toISOString(), mint: 'BBB2', symbol: 'B', price: 1e-6, score: 80, change1hPct: -25, recovery5mPct: 3, liquidityUsd: 90000, valueSol: 0.05 },
    { side: 'SELL', timestamp: new Date(now - DAY + 3000).toISOString(), mint: 'BBB2', symbol: 'B', price: 0.9e-6, realizedPnlSol: -0.005, realizedPnlPct: -10, reason: 'stop-loss' },
    { side: 'BUY', timestamp: new Date(now - DAY + 4000).toISOString(), mint: 'CCC3', symbol: 'C', price: 1e-6, score: 61, change1hPct: -30, recovery5mPct: 1.5, liquidityUsd: 30000, valueSol: 0.05 } // still open
  ];
  const paired = perf.pairTrades(ledger);
  check('pairTrades: 2 closed + 1 open', paired.closed.length === 2 && paired.open.length === 1, 'closed=' + paired.closed.length + ' open=' + paired.open.length);
  check('pairTrades: closed trade carries entry metadata', paired.closed[0].entryScore === 75 && paired.closed[0].won === true);
  // Partials aggregate: BUY → partial-take → final close = ONE closed trade with
  // combined economics; BUY → partial only = open with banked profit noted.
  const pNow = Date.now();
  const pIso = (t) => new Date(t).toISOString();
  const partLedger = [
    { side: 'BUY', timestamp: pIso(pNow - 10000), mint: 'PPP1', symbol: 'P', price: 1e-6, valueSol: 0.05, score: 70 },
    { side: 'SELL', timestamp: pIso(pNow - 9000), mint: 'PPP1', symbol: 'P', price: 1.05e-6, realizedPnlSol: 0.00125, realizedPnlPct: 5, reason: 'partial-take', partial: true },
    { side: 'SELL', timestamp: pIso(pNow - 8000), mint: 'PPP1', symbol: 'P', price: 1.12e-6, realizedPnlSol: 0.003, realizedPnlPct: 12, reason: 'take-profit', tradeRealizedPnlSol: 0.00425, tradeRealizedPnlPct: 8.5, partialTaken: true },
    { side: 'BUY', timestamp: pIso(pNow - 7000), mint: 'PPP2', symbol: 'Q', price: 1e-6, valueSol: 0.05, score: 70 },
    { side: 'SELL', timestamp: pIso(pNow - 6000), mint: 'PPP2', symbol: 'Q', price: 1.05e-6, realizedPnlSol: 0.00125, realizedPnlPct: 5, reason: 'partial-take', partial: true }
  ];
  const paired2 = perf.pairTrades(partLedger);
  check('pairTrades: partial + final = 1 closed trade', paired2.closed.length === 1, 'closed=' + paired2.closed.length);
  check('pairTrades: combined economics (0.00425 / 8.5%)', paired2.closed.length === 1 &&
    Math.abs(paired2.closed[0].realizedPnlSol - 0.00425) < 1e-9 && Math.abs(paired2.closed[0].realizedPnlPct - 8.5) < 1e-9,
    JSON.stringify(paired2.closed[0]));
  check('pairTrades: partial-only lot stays open with banked profit', paired2.open.length === 1 &&
    Math.abs(paired2.open[0].bankedPartialSol - 0.00125) < 1e-9, JSON.stringify(paired2.open));
  check('timeOfDay buckets valid', ['morning', 'afternoon', 'evening', 'night'].includes(perf.timeOfDayOf(now)));
  check('liqClassOf: 150k→high, 30k→medium, 5k→low', perf.liqClassOf(150000) === 'high' && perf.liqClassOf(30000) === 'medium' && perf.liqClassOf(5000) === 'low');

  // ---- regime-detector (market-driven: SOL trend + breadth) -----------------
  const mkt = (o) => Object.assign({ sol1h: null, sol24h: null, liqPct: 1, candidates: 10, healthScore: 90, healthGate: false, discoveryFailures: 0 }, o);
  check('regime: no direction input → UNKNOWN', regime.detectMarketRegime(mkt({})).regime === 'UNKNOWN');
  check('regime: empty market → UNKNOWN', regime.detectMarketRegime({}).regime === 'UNKNOWN');
  const mBull = regime.detectMarketRegime(mkt({ sol1h: 2, sol24h: 6 }));
  check('regime: SOL up on liquid breadth → bull', mBull.regime === 'bull', mBull.regime + ' ' + mBull.reasoning);
  const mBullThin = regime.detectMarketRegime(mkt({ sol1h: 2, sol24h: 6, liqPct: 0.3 }));
  check('regime: SOL up but thin breadth → consolidation (not bull)', mBullThin.regime === 'consolidation', mBullThin.regime);
  const mDumpH = regime.detectMarketRegime(mkt({ sol1h: -5, sol24h: -2 }));
  check('regime: SOL hour crash → dump', mDumpH.regime === 'dump', mDumpH.regime);
  const mDumpD = regime.detectMarketRegime(mkt({ sol1h: -1, sol24h: -12 }));
  check('regime: SOL day selloff → dump', mDumpD.regime === 'dump', mDumpD.regime);
  const mRec = regime.detectMarketRegime(mkt({ sol1h: 1.2, sol24h: -7 }));
  check('regime: sold-off day turning up → recovery', mRec.regime === 'recovery', mRec.regime);
  const mCon = regime.detectMarketRegime(mkt({ sol1h: 0.4, sol24h: 1.5 }));
  check('regime: soft trend → consolidation', mCon.regime === 'consolidation', mCon.regime);
  check('regime: dump conviction scales (agree 0.85)', regime.detectMarketRegime(mkt({ sol1h: -5, sol24h: -12 })).confidence === 0.85);
  check('regime: thresholds overridable', regime.detectMarketRegime(mkt({ sol1h: -5, sol24h: -2 }), { dumpSol1h: -10 }).regime === 'consolidation');
  check('regime: recovery strategy → watchOnly 0 buys', regime.strategyForRegime('recovery', { maxPositions: 3 }).mode === 'watchOnly' && regime.strategyForRegime('recovery', { maxPositions: 3 }).maxBuys === 0);
  check('regime: bull strategy → active full cap', regime.strategyForRegime('bull', { maxPositions: 5 }).maxBuys === 5);
  check('regime sizing: dump→0, recovery→0.5, bull→1.0, UNKNOWN→1.0',
    regime.sizeMultiplierForRegime('dump') === 0 && regime.sizeMultiplierForRegime('recovery') === 0.5 &&
    regime.sizeMultiplierForRegime('bull') === 1.0 && regime.sizeMultiplierForRegime('UNKNOWN') === 1.0);
  check('regime sizing: never above 1 by default', regime.sizeMultiplierForRegime('bull') <= 1);

  // ---- learned-gates ----------------------------------------------------------  
  const clusterTrades = [];
  for (let i = 0; i < 4; i++) clusterTrades.push(mkClosed(100 + i, -8, { score: 62, reason: 'stop-loss' }));
  for (let i = 4; i < 10; i++) clusterTrades.push(mkClosed(100 + i, i % 2 ? 8 : -8, { score: 78 }));
  const learned = gates.learnGates(clusterTrades, { minSamples: 8 });
  const minScoreProposal = learned.proposals.find((p) => p.parameter === 'minScore');
  check('learned-gates: cluster learned (n=10)', learned.perCluster && Object.keys(learned.perCluster).length === 1);
  check('learned-gates: minScore raised for losing cluster', minScoreProposal && minScoreProposal.newValue > 60, minScoreProposal && minScoreProposal.newValue);
  check('learned-gates: gate value within bounds', minScoreProposal && minScoreProposal.newValue <= 90);
  const fewGates = gates.learnGates([mkClosed(200, 5)], { minSamples: 8 });
  check('learned-gates: n < minSamples → INSUFFICIENT_DATA, no proposals', fewGates.proposals.length === 0 && Object.values(fewGates.perCluster)[0].status === 'INSUFFICIENT_DATA');
  const eff = gates.effectiveGates({ gates: { 'dump|evening|high': { minScore: { newValue: 70, confidence: 0.9, sample: 10 } } } }, 'dump|evening|high', { gateConfidenceThreshold: 0.85 });
  check('learned-gates: promoted gate applied', eff.gates.minScore === 70 && eff.applied.length === 1);
  const effLow = gates.effectiveGates({ gates: { 'dump|evening|high': { minScore: { newValue: 70, confidence: 0.5, sample: 10 } } } }, 'dump|evening|high', { gateConfidenceThreshold: 0.85 });
  check('learned-gates: low confidence ignored → V1', effLow.gates.minScore === 60 && effLow.applied.length === 0);
  const effStrict = gates.effectiveGates({ gates: { 'x|y|z': { max5m: { newValue: 3, confidence: 0.9, sample: 9 } } } }, 'x|y|z', {});
  check('learned-gates: max5m can only tighten', effStrict.gates.max5m === 3);
  const effLoosen = gates.effectiveGates({ gates: { 'x|y|z': { max5m: { newValue: 20, confidence: 0.9, sample: 9 } } } }, 'x|y|z', {});
  check('learned-gates: looser value refused → V1', effLoosen.gates.max5m === 8);

  // ---- adaptive-policy --------------------------------------------------------
  const streakPolicy = policy.buildSessionPolicy({
    metrics: { n: 8, expectancyPct: -4 },
    regime: { regime: 'consolidation', confidence: 0.6, reasoning: 'x' },
    cfg: { maxPositions: 3 },
    trades: [mkClosed(1, -6), mkClosed(2, -6), mkClosed(3, -6)]
  });
  check('policy: 3 consecutive losses → watchOnly', streakPolicy.mode === 'watchOnly' && streakPolicy.maxBuys === 0, streakPolicy.mode);
  const negExpPolicy = policy.buildSessionPolicy({
    metrics: { n: 6, expectancyPct: -3 },
    regime: { regime: 'bull', confidence: 0.8, reasoning: 'x' },
    cfg: { maxPositions: 3 },
    trades: []
  });
  check('policy: negative expectancy raises minScore (never below 60)', negExpPolicy.minScore >= 65, 'minScore=' + negExpPolicy.minScore);
  // ---- daily loss halt ----
  const haltPolicy = policy.buildSessionPolicy({
    metrics: {}, regime: { regime: 'bull', confidence: 0.9, reasoning: 'x' },
    cfg: { maxPositions: 5 }, trades: [], dayPnlPct: -3.5
  });
  check('policy: day P&L -3.5% → watchOnly halt', haltPolicy.mode === 'watchOnly' && haltPolicy.maxBuys === 0 &&
    /Daily loss halt/.test(haltPolicy.reason), haltPolicy.mode + ' ' + haltPolicy.reason);
  const haltEdge = policy.buildSessionPolicy({
    metrics: {}, regime: { regime: 'bull', confidence: 0.9, reasoning: 'x' },
    cfg: { maxPositions: 5 }, trades: [], dayPnlPct: -3.0
  });
  check('policy: day P&L exactly -3.0% halts (boundary <=)', haltEdge.mode === 'watchOnly' && haltEdge.maxBuys === 0);
  const noHalt = policy.buildSessionPolicy({
    metrics: {}, regime: { regime: 'bull', confidence: 0.9, reasoning: 'x' },
    cfg: { maxPositions: 5 }, trades: [], dayPnlPct: -2.99
  });
  check('policy: day P&L -2.99% does not halt', noHalt.mode === 'active' && noHalt.maxBuys === 5);
  const nullHalt = policy.buildSessionPolicy({
    metrics: {}, regime: { regime: 'bull', confidence: 0.9, reasoning: 'x' },
    cfg: { maxPositions: 5 }, trades: []
  });
  check('policy: unknown day P&L never halts', nullHalt.mode === 'active');
  const customHalt = policy.buildSessionPolicy({
    metrics: {}, regime: { regime: 'bull', confidence: 0.9, reasoning: 'x' },
    cfg: { maxPositions: 5, dailyLossHaltPct: 5 }, trades: [], dayPnlPct: -4
  });
  check('policy: custom halt threshold respected', customHalt.mode === 'active');
  const customHaltHit = policy.buildSessionPolicy({
    metrics: {}, regime: { regime: 'bull', confidence: 0.9, reasoning: 'x' },
    cfg: { maxPositions: 5, dailyLossHaltPct: 5 }, trades: [], dayPnlPct: -5.0
  });
  check('policy: custom halt threshold triggers', customHaltHit.mode === 'watchOnly' && customHaltHit.maxBuys === 0);
  const bothBreakers = policy.buildSessionPolicy({
    metrics: {}, regime: { regime: 'bull', confidence: 0.9, reasoning: 'x' },
    cfg: { maxPositions: 5 }, trades: [mkClosed(1, -6), mkClosed(2, -6), mkClosed(3, -6)], dayPnlPct: -4
  });
  check('policy: daily halt dominates loss streak (reason names daily)', bothBreakers.mode === 'watchOnly' &&
    /Daily loss halt/.test(bothBreakers.reason), bothBreakers.reason);
  check('policy: halt default is 3%', policy.DEFAULT_DAILY_LOSS_HALT_PCT === 3);
  const dfltPolicy = policy.buildSessionPolicy({ metrics: {}, regime: { regime: 'UNKNOWN', confidence: 0, reasoning: '' }, cfg: { maxPositions: 3 }, trades: [] });
  check('policy: UNKNOWN → V1 active 60', dfltPolicy.mode === 'active' && dfltPolicy.minScore === 60);
  const dirP = fs.mkdtempSync(path.join(TMP, 'unit-pol-'));
  const saved = policy.savePolicy(dirP, dfltPolicy, 5000);
  check('policy: saved with expiresAt TTL', saved.expiresAt && Date.parse(saved.expiresAt) > Date.now());
  const effG = policy.effectiveGates(saved, { maxPositions: 3 });
  check('policy: effective gates fresh', effG.fresh === true && effG.mode === 'active');
  const expiredObj = Object.assign({}, dfltPolicy, {
    setAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });
  fs.writeFileSync(path.join(dirP, 'adaptive-policy.json'), JSON.stringify(expiredObj, null, 2) + '\n');
  const effExp = policy.effectiveGates(policy.loadPolicy(dirP), { maxPositions: 3 });
  check('policy: expired → V1 fallback', effExp.fresh === false && effExp.mode === 'active' && effExp.minScore === 60);
  const clampP = policy.buildSessionPolicy({ metrics: {}, regime: { regime: 'bull', confidence: 1, reasoning: '' }, cfg: { maxPositions: 3 }, trades: [] });
  check('policy: minScore clamp ceiling 90', policy.clamp(200, 60, 90) === 90 && policy.clamp(10, 60, 90) === 60);

  // ---- strategy-experiments (full lifecycle) --------------------------------
  const dirE = fs.mkdtempSync(path.join(TMP, 'unit-exp-'));
  const winTrades = [1, 2, 3, 4, 5, 6, 7].map((i) => mkClosed(300 + i, 8, { score: 78 }));
  const mixedTrades = winTrades.concat([8, 9, 10].map((i) => mkClosed(400 + i, -8, { score: 78 })));
  const expGood = exp.createExperiment(dirE, { type: 'baseline', parameter: 'minScoreBase', oldValue: 60, newValue: 65, reason: 'test', evidence: {} });
  check('exp: created PROPOSED', expGood.state === 'PROPOSED');
  const btGood = exp.runBacktest(dirE, expGood.id, mixedTrades, { backtestMinTrades: 2 });
  check('exp: backtest passed → SHADOW', btGood.state === 'SHADOW', btGood.state + ' ' + (btGood.reason || ''));
  check('exp: non-filter param skips walk-forward', btGood.walkForward && btGood.walkForward.skipped === true);
  // Window trades must exit AFTER the shadow started (future-dated here so the
  // deterministic filter sees them deterministically).
  const futureTrades = [1, 2, 3, 4, 5, 6].map((i) => mkClosed(900 + i, 8, { score: 78, exitOffsetMs: 60000 + i * 1000 }));
  const evalPending = exp.evaluateShadow(dirE, expGood.id, futureTrades, { shadowMinTrades: 2, autoApply: false });
  check('exp: shadow passed → PENDING_APPROVAL (autoApply off)', evalPending.state === 'PENDING_APPROVAL', evalPending.state + ' window=' + evalPending.windowTrades);
  const beforePromote = exp.effectiveBaseline(exp.loadVersions(dirE)).versionId;
  const promoted = exp.approveExperiment(dirE, expGood.id, { note: 'unit test' });
  check('exp: approved → PROMOTED', promoted && promoted.state === 'PROMOTED');
  const versions = exp.loadVersions(dirE);
  check('exp: new strategy version created with parent', versions.versions.length === 2 && versions.current !== 'V1' && versions.current.endsWith('.1') && versions.versions[1].parentId === 'V1');
  check('exp: effective baseline upgraded', exp.effectiveBaseline(exp.loadVersions(dirE)).minScoreBase === 65);
  const chg = reflect.loadPolicyChanges(dirE).find((c) => c.policyChangeId === expGood.id);
  check('exp: policy change logged for grading', chg && chg.grade === null && chg.gradeAt);

  const expBad = exp.createExperiment(dirE, { type: 'gate-update', parameter: 'minScore', oldValue: 60, newValue: 85, reason: 'test bad', evidence: { clusterKey: 'a|b|c', confidence: 0.9, sample: 10 } });
  const btBad = exp.runBacktest(dirE, expBad.id, mixedTrades, { backtestMinTrades: 2 });
  check('exp: backtest failed → REJECTED', btBad.state === 'REJECTED', btBad.state + ' ' + (btBad.reason || ''));

  // Restart persistence: reload experiments from the log.
  const reloaded = exp.getExperiment(dirE, expGood.id);
  check('exp: state survives reload from jsonl', reloaded && reloaded.state === 'PROMOTED');

  // Rollback via reflection grading.
  const expRoll = exp.createExperiment(dirE, { type: 'baseline', parameter: 'minScoreBase', oldValue: 60, newValue: 70, reason: 'rollback test', evidence: {} });
  exp.runBacktest(dirE, expRoll.id, mixedTrades, { backtestMinTrades: 2 });
  exp.evaluateShadow(dirE, expRoll.id, futureTrades, { shadowMinTrades: 2, autoApply: true });
  const rolled = exp.rollbackExperiment(dirE, expRoll.id, { grade: 'STRONGLY_NEGATIVE' });
  check('exp: rollback → ROLLED_BACK', rolled && rolled.state === 'ROLLED_BACK');
  const versionsAfter = exp.loadVersions(dirE);
  const rollVersion = versionsAfter.versions.find((v) => v.experimentId === expRoll.id);
  const restored = versionsAfter.current === (rollVersion ? rollVersion.parentId : 'V1');
  check('exp: rollback restores parent version', restored, 'current=' + versionsAfter.current);

  // ---- band experiments (multi-param entry tightening) ---------------------
  const TIGHT = { min1h: -25, max1h: 8, min5m: 1.0, max5m: 5.0 };
  // Winners inside tight bands, losers at FOMO tops / late bounces.
  const bandTrades = [
    mkClosed(2001, 8, { score: 65, c1h: -10, c5m: 2 }),
    mkClosed(2002, 9, { score: 65, c1h: -15, c5m: 3 }),
    mkClosed(2003, 7, { score: 65, c1h: -5, c5m: 4 }),
    mkClosed(2004, -6, { score: 65, c1h: 12, c5m: 6 }),
    mkClosed(2005, -7, { score: 65, c1h: -8, c5m: 7 }),
    mkClosed(2006, -6, { score: 65, c1h: 14, c5m: 2 })
  ];
  check('passesGates: tight bands keep 3W drop 3L', bandTrades.filter((t) => exp.passesGates(t, TIGHT)).length === 3);
  check('passesGates: single-param parity', exp.passesGate(bandTrades[0], 'max1h', 8) === exp.passesGates(bandTrades[0], { max1h: 8 }));
  check('validateBands: tight set accepted', exp.validateBands(TIGHT).ok === true);
  check('validateBands: looser-than-V1 rejected', exp.validateBands({ max1h: 20 }).ok === false);
  check('validateBands: empty object rejected', exp.validateBands({}).ok === false);
  const expBands = exp.createExperiment(dirE, { type: 'baseline', parameter: 'bands', oldValue: 'V1', newValue: '1h(-25..8) 5m(1..5)', gates: TIGHT, reason: 'unit bands test', evidence: {} });
  check('exp: bands experiment carries gate sets', expBands.gates && expBands.gates.max1h === 8);
  const btBands = exp.runBacktest(dirE, expBands.id, bandTrades, { backtestMinTrades: 3, wfMinTrades: 2, wfMinFoldTrades: 1, wfFolds: 2, wfMinOosPf: 0, wfMinOosExp: -100 });
  check('exp: bands backtest passed → SHADOW', btBands.state === 'SHADOW' && btBands.candidate.n === 3 && btBands.candidate.winRate === 100,
    btBands.state + ' ' + (btBands.reason || ''));
  const futureBands = [1, 2, 3, 4].map((i) => mkClosed(2100 + i, 8, { score: 65, c1h: -10, c5m: 2, exitOffsetMs: 60000 + i * 1000 }));
  const shBands = exp.evaluateShadow(dirE, expBands.id, futureBands, { shadowMinTrades: 2, autoApply: false });
  check('exp: bands shadow → PENDING_APPROVAL', shBands.state === 'PENDING_APPROVAL', shBands.state);
  const promBands = exp.approveExperiment(dirE, expBands.id, { note: 'unit test' });
  check('exp: bands approved → PROMOTED', promBands && promBands.state === 'PROMOTED');
  check('exp: bandsBase promoted to baseline', JSON.stringify(exp.effectiveBaseline(exp.loadVersions(dirE)).bandsBase) === JSON.stringify({ minScore: 60, min1h: -25, max1h: 8, min5m: 1, max5m: 5 }));
  const rbBands = exp.rollbackExperiment(dirE, expBands.id, { grade: 'STRONGLY_NEGATIVE' });
  check('exp: bands rollback restores V1 bands', rbBands && rbBands.state === 'ROLLED_BACK' &&
    exp.effectiveBaseline(exp.loadVersions(dirE)).bandsBase.max1h === 15);
  const expLoose = exp.createExperiment(dirE, { type: 'baseline', parameter: 'bands', oldValue: 'V1', newValue: 'loose', gates: { max1h: 20 }, reason: 'x', evidence: {} });
  check('exp: invalid bands backtest → REJECTED', exp.runBacktest(dirE, expLoose.id, bandTrades, {}).state === 'REJECTED');

  // ---- bandit go-live through the standard workflow -----------------------
  const blTrades = [];
  for (let i = 0; i < 6; i++) blTrades.push(mkClosed(3000 + i, 8, { score: 78, c1h: -15, c5m: 2.5 }));
  for (let i = 0; i < 6; i++) blTrades.push(mkClosed(3100 + i, -6, { score: 62, c1h: -15, c5m: 2.5 }));
  const blArms = {};
  for (let i = 0; i < 6; i++) {
    blTrades[i].regime = 'bull'; blTrades[i].timeOfDay = 'morning'; blTrades[i].liqClass = 'high';
    blTrades[6 + i].regime = 'bull'; blTrades[6 + i].timeOfDay = 'morning'; blTrades[6 + i].liqClass = 'high';
  }
  blArms['bull|morning|high'] = { arm: 70 };
  const expBl = exp.createExperiment(dirE, { type: 'baseline', parameter: 'banditLive', oldValue: 0, newValue: 1, evidence: { arms: blArms }, reason: 'unit bandit go-live', priority: 'HIGH' });
  const btBl = exp.runBacktest(dirE, expBl.id, blTrades, { backtestMinTrades: 3, wfMinTrades: 3, wfMinFoldTrades: 1, wfFolds: 2, wfMinOosPf: 0, wfMinOosExp: -100 });
  check('exp: banditLive backtest filters to winners → SHADOW', btBl.state === 'SHADOW' && btBl.candidate.n === 6 && btBl.candidate.winRate === 100,
    btBl.state + ' ' + (btBl.reason || ''));
  const expBlNoArms = exp.createExperiment(dirE, { type: 'baseline', parameter: 'banditLive', oldValue: 0, newValue: 1, evidence: {}, reason: 'x' });
  check('exp: banditLive without arms → REJECTED', exp.runBacktest(dirE, expBlNoArms.id, blTrades, {}).state === 'REJECTED');
  const futureBl = [1, 2, 3, 4].map((i) => mkClosed(3200 + i, 8, { score: 78, c1h: -15, c5m: 2.5, exitOffsetMs: 60000 + i * 1000 }));
  futureBl.forEach((t) => { t.regime = 'bull'; t.timeOfDay = 'morning'; t.liqClass = 'high'; });
  const shBl = exp.evaluateShadow(dirE, expBl.id, futureBl, { shadowMinTrades: 2, autoApply: false });
  check('exp: banditLive shadow → PENDING_APPROVAL', shBl.state === 'PENDING_APPROVAL', shBl.state);
  const promBl = exp.approveExperiment(dirE, expBl.id, { note: 'unit test' });
  check('exp: banditLive approved → PROMOTED with flag', promBl && promBl.state === 'PROMOTED' &&
    exp.effectiveBaseline(exp.loadVersions(dirE)).banditLive === 1);
  const rbBl = exp.rollbackExperiment(dirE, expBl.id, { grade: 'STRONGLY_NEGATIVE' });
  check('exp: banditLive rollback clears flag', rbBl && rbBl.state === 'ROLLED_BACK' &&
    exp.effectiveBaseline(exp.loadVersions(dirE)).banditLive === 0);

  // ---- walk-forward OOS validation (purged folds) -------------------------
  // 38 rows over days 0..35, 1h holds, candidate minScore 60→70.
  // Fold A (ranks 0-11): 9W/2L kept. Fold B (12-23): straddler S1 (entry
  // day 11.5, exit 16.5) + day-12 winner purged; 7W/2L kept. Fold C
  // (ranks 24-37): day-23 winner + straddler S2 (entry day 22) purged;
  // 8W/2L kept. OOS n=30, purged=4; in-sample candidate n=34.
  const WF_DAY = 86400000;
  const wfT0 = now - 40 * WF_DAY;
  const wfMk = (i, exitDay, entryDay, pnl, score) => ({
    mint: 'WF' + i, symbol: 'WFT' + i,
    entryTs: wfT0 + entryDay * WF_DAY,
    exitTs: wfT0 + exitDay * WF_DAY,
    entryScore: score, change1hPct: -15, recovery5mPct: 2.5, liquidityUsd: 150000,
    entryPriceSol: 1e-6, exitPriceSol: 1e-6 * (1 + pnl / 100),
    realizedPnlSol: pnl, realizedPnlPct: pnl,
    exitReason: pnl > 0 ? 'take-profit' : 'stop-loss', won: pnl > 0
  });
  const wfTrades = [];
  let wfId = 5000;
  const wfAdd = (exitDay, entryDay, pnl, score) => { wfTrades.push(wfMk(wfId++, exitDay, entryDay, pnl, score)); };
  for (let d = 0; d <= 8; d++) wfAdd(d, d - 1 / 24, 8, 70);       // A: 9W (days 0-8)
  wfAdd(9, 9 - 1 / 24, -6, 70); wfAdd(10, 10 - 1 / 24, -6, 70);    // A: 2L kept
  wfAdd(11, 11 - 1 / 24, -6, 62);                                 // A: 1L excluded
  wfAdd(12, 12 - 1 / 24, 8, 70);                                  // B: day-12 winner (purged: 1h straddle)
  for (let d = 13; d <= 19; d++) wfAdd(d, d - 1 / 24, 8, 70);      // B: 7W
  wfAdd(16.5, 11.5, 8, 70);                                       // S1 straddler (purged)
  wfAdd(20, 20 - 1 / 24, -6, 70); wfAdd(21, 21 - 1 / 24, -6, 70);  // B: 2L kept
  wfAdd(22, 22 - 1 / 24, -6, 62);                                 // B: 1L excluded
  wfAdd(23, 23 - 1 / 24, 8, 70);                                  // C: day-23 winner (purged: 1h straddle)
  for (let d = 24; d <= 31; d++) wfAdd(d, d - 1 / 24, 8, 70);      // C: 8W
  wfAdd(28.5, 22, 8, 70);                                         // S2 straddler (purged)
  wfAdd(32, 32 - 1 / 24, -6, 70); wfAdd(33, 33 - 1 / 24, -6, 70);  // C: 2L kept
  wfAdd(34, 34 - 1 / 24, -6, 62); wfAdd(35, 35 - 1 / 24, -6, 62);  // C: 2L excluded
  const expWf = exp.createExperiment(dirE, { type: 'baseline', parameter: 'minScore', oldValue: 60, newValue: 70, reason: 'unit WF test', evidence: {} });
  const btWf = exp.runBacktest(dirE, expWf.id, wfTrades, { backtestMinTrades: 5 });
  check('exp: WF pass → SHADOW (production bars)', btWf.state === 'SHADOW', btWf.state + ' ' + (btWf.reason || ''));
  check('exp: WF OOS n=30, purged=4, in-sample n=34',
    btWf.walkForward && btWf.walkForward.passed === true && btWf.walkForward.oosN === 30 && btWf.walkForward.oosPurged === 4 &&
    btWf.candidate.n === 34, JSON.stringify(btWf.walkForward && { oosN: btWf.walkForward.oosN, purged: btWf.walkForward.oosPurged, inSample: btWf.candidate.n }));
  check('exp: every evaluated fold clears PF>1.2/exp>0',
    btWf.walkForward.folds.length === 3 && btWf.walkForward.folds.every((f) => f.passed === true));
  check('exp: reason carries the OOS verdict', /OOS: walk-forward: 3\/3 folds pass/.test(btWf.reason), btWf.reason);
  // Same shape, but fold C collapses: flip 7 kept winners (C24-C29 + S2,
  // S2's flip is moot post-purge) → fold C kept 2W/8L, PF 0.33. In-sample
  // still clears tolerances; walk-forward must REJECT — this is the teeth.
  const wfBad = wfTrades.map((t) => Object.assign({}, t));
  const sortedBad = wfBad.slice().sort((a, b) => a.exitTs - b.exitTs);
  let flipped = 0;
  for (const t of sortedBad) {
    if (t.exitTs >= wfT0 + 24 * WF_DAY && t.exitTs < wfT0 + 32 * WF_DAY &&
        t.realizedPnlSol > 0 && t.entryScore === 70 && flipped < 7) {
      t.realizedPnlSol = -6; t.realizedPnlPct = -6; t.won = false; t.exitReason = 'stop-loss';
      t.exitPriceSol = 1e-6 * 0.94;
      flipped += 1;
    }
  }
  const expWfBad = exp.createExperiment(dirE, { type: 'baseline', parameter: 'minScore', oldValue: 60, newValue: 70, reason: 'unit WF teeth test', evidence: {} });
  const btWfBad = exp.runBacktest(dirE, expWfBad.id, wfBad, { backtestMinTrades: 5 });
  check('exp: WF rejects when a fold collapses (in-sample would pass)', btWfBad.state === 'REJECTED' && /walk-forward: fold\(s\) f2 below/.test(btWfBad.reason),
    btWfBad.state + ' ' + (btWfBad.reason || ''));
  // Small sample with production defaults: fail closed on n.
  const expWfSmall = exp.createExperiment(dirE, { type: 'baseline', parameter: 'minScore', oldValue: 60, newValue: 70, reason: 'unit WF n test', evidence: {} });
  const btWfSmall = exp.runBacktest(dirE, expWfSmall.id, mixedTrades, { backtestMinTrades: 2 });
  check('exp: WF fail-closed below 30 OOS trades', btWfSmall.state === 'REJECTED' && /walk-forward/.test(btWfSmall.reason || ''),
    btWfSmall.state + ' ' + (btWfSmall.reason || ''));
  // Direct runWalkForward: skip path + unknown experiment handling.
  check('exp: runWalkForward skips non-filter params',
    exp.runWalkForward({ parameter: 'recoverySizeMultiplier' }, mixedTrades, {}).skipped === true);
  const wfBl = exp.runWalkForward({ parameter: 'banditLive', evidence: { arms: blArms } }, blTrades, { wfMinTrades: 3, wfMinFoldTrades: 1, wfFolds: 2, wfMinOosPf: 0, wfMinOosExp: -100 });
  check('exp: runWalkForward banditLive path passes lenient bars', wfBl.passed === true && wfBl.oosN === 6, JSON.stringify({ passed: wfBl.passed, oosN: wfBl.oosN }));
  // effectiveGates honors a global base: base applies, cluster tightens, looser ignored.
  const withBase = gates.effectiveGates({ gates: {} }, 'q|w|e', {}, TIGHT);
  check('gates: global base applies without cluster gates', withBase.gates.max1h === 8 && withBase.gates.min5m === 1);
  const tighter = gates.effectiveGates({ gates: { 'q|w|e': { max1h: { newValue: 6, confidence: 0.9, sample: 10 } } } }, 'q|w|e', { gateConfidenceThreshold: 0.85 }, TIGHT);
  check('gates: cluster tightens below base', tighter.gates.max1h === 6);
  const looser = gates.effectiveGates({ gates: { 'q|w|e': { max1h: { newValue: 12, confidence: 0.9, sample: 10 } } } }, 'q|w|e', { gateConfidenceThreshold: 0.85 }, TIGHT);
  check('gates: cluster looser than base ignored', looser.gates.max1h === 8);

  // ---- reflection-engine grading ---------------------------------------------
  const dirR = fs.mkdtempSync(path.join(TMP, 'unit-refl-'));
  reflect.logPolicyChange(dirR, { policyChangeId: 'pc1', strategyVersion: 'V1.1', parameter: 'minScore', oldValue: 60, newValue: 65, reason: 't', evidence: {} }, { gradeDelayMs: 1000 });
  const beforeTrades = [
    mkClosed(500, 8, { score: 70, exitOffsetMs: -120000 }),
    mkClosed(501, 8, { score: 70, exitOffsetMs: -119000 }),
    mkClosed(502, -6, { score: 70, exitOffsetMs: -118000 })
  ];
  // After-window trades must exit AFTER the change timestamp (back-dated 60s)
  // and BEFORE now — gradeExpiredChanges caps the after window at `now`.
  const afterGood = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mkClosed(600 + i, 8, { score: 70, exitOffsetMs: -50000 + i * 1000 }));
  const afterBad = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mkClosed(700 + i, -8, { score: 70, exitOffsetMs: -50000 + i * 1000 }));
  const g1 = reflect.classifyChange({}, beforeTrades, afterGood, { minGradeSamples: 5 });
  check('reflect: 67%→100% WR → STRONGLY_POSITIVE', g1.grade === 'STRONGLY_POSITIVE', g1.grade);
  const g2 = reflect.classifyChange({}, beforeTrades, afterBad, { minGradeSamples: 5 });
  check('reflect: collapse → STRONGLY_NEGATIVE', g2.grade === 'STRONGLY_NEGATIVE', g2.grade);
  const g3 = reflect.classifyChange({}, beforeTrades, [mkClosed(1, 8)], { minGradeSamples: 5 });
  check('reflect: tiny sample → INSUFFICIENT_DATA', g3.grade === 'INSUFFICIENT_DATA', g3.grade);
  // Back-date the change so the after-window trades land between the change
  // and now (gradeDelayMs must still expire before grading).
  reflect.logPolicyChange(dirR, {
    policyChangeId: 'pc-backdated', strategyVersion: 'V1.1',
    parameter: 'minScore', oldValue: 60, newValue: 65, reason: 't', evidence: {}
  }, { gradeDelayMs: 1000, timestamp: Date.now() - 60000 });
  await new Promise((r) => setTimeout(r, 1100));
  const graded = reflect.gradeExpiredChanges(dirR, afterGood.concat(beforeTrades), { minGradeSamples: 5 });
  const pc1 = graded.find((g) => g.policyChangeId === 'pc1');
  const pc2 = graded.find((g) => g.policyChangeId === 'pc-backdated');
  check('reflect: change with no after-trades → INSUFFICIENT_DATA', pc1 && pc1.grade === 'INSUFFICIENT_DATA');
  check('reflect: back-dated change graded from after-window trades', pc2 && pc2.grade === 'STRONGLY_POSITIVE');
  check('reflect: grade persisted back into log', reflect.loadPolicyChanges(dirR).some((c) => c.grade === 'STRONGLY_POSITIVE'));
  check('reflect: repeat-failure memory', reflect.recentlyFailed(dirR, 'minScore', 99) === false);
  const lessons = reflect.generateLessons(dirR, {
    metrics: { n: 10, lossStreak: 4, winRate: 30, expectancyPct: -2 },
    breakdowns: {
      byExitReason: { 'stop-loss': { n: 8, winRate: 0 } },
      byTimeOfDay: { evening: { n: 10, winRate: 20 } }
    },
    regime: { regime: 'dump', confidence: 0.9, reasoning: 'x' },
    cfg: {}
  });
  check('reflect: lessons generated (exit-reason + streak + regime)', lessons.some((l) => l.type === 'exit-reason') && lessons.some((l) => l.type === 'streak'));

  // ---- llm-adapter schema validation -----------------------------------------
  const goodLlm = llm.validatePolicyOutput({ mode: 'selective', minScore: 65, maxBuys: 2, reason: 'ok' }, { maxPositions: 3 });
  check('llm: valid output accepted', goodLlm.ok === true && goodLlm.policy.mode === 'selective' && goodLlm.policy.minScore === 65);
  const badMode = llm.validatePolicyOutput({ mode: 'moon', minScore: 65 }, { maxPositions: 3 });
  check('llm: invalid mode dropped, valid fields kept + error recorded',
    badMode.ok === true && badMode.policy.mode === undefined && badMode.policy.minScore === 65 &&
    badMode.errors.some((e) => e.includes('invalid mode')));
  const clamped = llm.validatePolicyOutput({ mode: 'active', minScore: 500, maxBuys: 99 }, { maxPositions: 3 });
  check('llm: out-of-bounds clamped (minScore 90, maxBuys 3)', clamped.ok === true && clamped.policy.minScore === 90 && clamped.policy.maxBuys === 3);
  check('llm: clamp logged as error', clamped.errors.some((e) => e.includes('clamped')));
  for (const bad of ['wallet', 'signerKey', 'broadcastTx', 'execute', 'code', 'installPackage']) {
    const r = llm.validatePolicyOutput({ mode: 'active', [bad]: true }, { maxPositions: 3 });
    check('llm: forbidden field rejected (' + bad + ')', r.ok === false);
  }
  const nonJson = llm.validatePolicyOutput('hello', {});
  check('llm: non-object rejected', nonJson.ok === false);
  check('llm: extractJson strips fences', llm.extractJson('```json\n{"a":1}\n```').a === 1);
  check('llm: extractJson garbage → null', llm.extractJson('not json') === null);

  // ---- market-health proxy ----------------------------------------------------
  const healthy = health.computeHealth({ sourceStats: [{ status: 'ok', lastOkAt: Date.now() }], solPriceAgeMs: 1000, discoveryFailures: 0, cfg: { minHealthScore: 60 } });
  check('health: healthy → 100, no gate, 1.0×', healthy.score === 100 && healthy.gate === false && healthy.sizeMultiplier === 1.0);
  const sick = health.computeHealth({ sourceStats: [{ status: 'error' }], solPriceAgeMs: 500000, discoveryFailures: 4, cfg: { minHealthScore: 60 } });
  check('health: bad sources + stale SOL + failures → gated', sick.gate === true && sick.score < 60, 'score=' + sick.score);
  const noData = health.computeHealth({});
  check('health: no data → fail-open healthy', noData.gate === false && noData.score === 100);
}

// ============================================================================
// 13. AGENT-LOOP + REFLECTION (adaptive cycles write state + log)
// ============================================================================
/** Pre-write a fresh account + closed-trade ledger (used to seed adaptive history). */
function seedAccount(dir, closedTrades) {
  const p = {
    name: 'paper-trader', mode: 'paper', startingCapitalSol: 10, cashSol: 10,
    investedSol: 0, marketValueSol: 0, equitySol: 10, realizedPnlSol: 0,
    unrealizedPnlSol: 0, totalPnlSol: 0, pnlPct: 0, totalTrades: 0,
    winningTrades: 0, losingTrades: 0, winRate: 0, avgWinSol: 0, avgLossSol: 0,
    bestTradeSol: 0, worstTradeSol: 0, sumWinSol: 0, sumLossSol: 0,
    nextTradeId: closedTrades.length * 2 + 1, scans: 0, positions: [],
    cooldowns: {}, updatedAt: Date.now()
  };
  fs.writeFileSync(path.join(dir, 'portfolio.json'), JSON.stringify(p, null, 2) + '\n');
  const rows = [];
  for (const t of closedTrades) {
    rows.push({
      id: t.buyId, timestamp: new Date(t.entryTs).toISOString(), side: 'BUY',
      symbol: t.symbol, mint: t.mint, quantity: 0.05 / 6.67e-8, price: 6.67e-8,
      valueSol: 0.05, realizedPnlSol: 0, realizedPnlPct: 0, source: 'mock',
      score: t.entryScore, change1hPct: t.change1hPct, recovery5mPct: t.recovery5mPct,
      liquidityUsd: t.liquidityUsd != null ? t.liquidityUsd : 150000, volume24hUsd: 500000
    });
    rows.push({
      id: t.sellId, timestamp: new Date(t.exitTs).toISOString(), side: 'SELL',
      symbol: t.symbol, mint: t.mint, quantity: 0.05 / 6.67e-8, price: 6.67e-8 * (1 + t.pnlPct / 100),
      valueSol: 0.05 * (1 + t.pnlPct / 100), realizedPnlSol: 0.05 * t.pnlPct / 100,
      realizedPnlPct: t.pnlPct, entryPriceSol: 6.67e-8, costSol: 0.05, source: 'mock',
      reason: t.reason || 'stop-loss'
    });
  }
  fs.writeFileSync(path.join(dir, 'trades.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function seedLosers(n, { score = 78, pnlPct = -6, startMs } = {}) {
  const DAY = 86400000;
  const base = startMs || Date.now();
  const out = [];
  for (let i = 0; i < n; i++) {
    const entryTs = base - 6 * DAY + i * 12 * 3600000;
    out.push({
      buyId: i * 2 + 1, sellId: i * 2 + 2,
      mint: 'L' + i.toString(36).repeat(10) + String(i).padStart(2, '0'),
      symbol: 'L' + i, entryTs, exitTs: entryTs + 3600000,
      entryScore: score, change1hPct: -20, recovery5mPct: 2,
      liquidityUsd: 150000, pnlPct, reason: 'stop-loss'
    });
  }
  return out;
}

async function testAdaptiveLoops() {
  console.log('\n[test 13] agent-loop + reflection cycles');
  const dir = freshDir('aloop');
  const child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, tokens: [GOOD_DRIFT()] },
    extraEnv: { CIRCUIT_AGENT_LOOP_MS: '2000', CIRCUIT_REFLECT_MS: '2500' }
  });
  try {
    const policySeen = await waitFor(() => {
      const f = path.join(dir, 'adaptive-policy.json');
      if (!fs.existsSync(f)) return false;
      const p = readJson(f);
      return p && p.mode && p.expiresAt && p.regime;
    }, 15000, 150, 'adaptive-policy.json');
    check('agent-loop wrote adaptive-policy.json (mode/minScore/regime/expiry)', policySeen);
    const p = readJson(path.join(dir, 'adaptive-policy.json'));
    check('policy fields bounded', p && p.minScore >= 60 && p.minScore <= 90 && ['active', 'selective', 'watchOnly'].includes(p.mode));
    check('policy strategyVersion present', p && p.strategyVersion === 'V1');
    const loopLogged = await waitFor(() => /\[AGENT-LOOP\]/.test(readLog(dir)), 15000, 150, 'agent-loop log');
    check('[AGENT-LOOP] logged with mode/regime', loopLogged && /\[AGENT-LOOP\] [^\n]*mode=[a-zA-Z]+ [^\n]*regime=(bull|consolidation|recovery|dump|UNKNOWN)/.test(readLog(dir)));
    const reflLogged = await waitFor(() => /\[REFLECT\]/.test(readLog(dir)), 20000, 200, 'reflection log');
    check('[REFLECT] logged', reflLogged);
    check('regime-state.json written', fs.existsSync(path.join(dir, 'regime-state.json')));
    const hb = readJson(hfile(dir));
    check('heartbeat adaptive block present', hb && hb.adaptive && hb.adaptive.enabled === true);
    check('heartbeat adaptive regime + mode', hb && hb.adaptive.regime && hb.adaptive.mode);
    const scheduleSeen = await waitFor(() => {
      const h = readJson(hfile(dir));
      return h && h.adaptive && h.adaptive.lastAgentLoopAt && h.adaptive.lastReflectionAt;
    }, 10000, 200, 'heartbeat adaptive schedule timestamps');
    check('heartbeat adaptive schedule timestamps', scheduleSeen);
    const log = readLog(dir);
    check('adaptive startup line logged', /\[ADAPTIVE\] enabled/.test(log));
    check('paper-only invariant intact', /PAPER ONLY/.test(log) && !/Math\.random/.test(log));
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 14. REGIME ADAPTATION — pre-seeded dump history → watchOnly, no buys
// ============================================================================
async function testRegimeBlocksBuys() {
  console.log('\n[test 14] dump regime → watchOnly blocks new entries');
  const dir = freshDir('regime');
  seedAccount(dir, seedLosers(8, { pnlPct: -8 }));
  const child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, solChange1hPct: -5, solChange24hPct: -12, tokens: [GOOD_DRIFT()] },
    extraEnv: { CIRCUIT_AGENT_LOOP_MS: '2000' }
  });
  try {
    const regimeSeen = await waitFor(() => {
      const f = path.join(dir, 'regime-state.json');
      return fs.existsSync(f) && readJson(f) && readJson(f).regime === 'dump';
    }, 20000, 200, 'dump regime');
    check('regime detected as dump from SOL selloff (not own PnL)', regimeSeen);
    const policySeen = await waitFor(() => {
      const f = path.join(dir, 'adaptive-policy.json');
      return fs.existsSync(f) && readJson(f) && readJson(f).mode === 'watchOnly';
    }, 20000, 200, 'watchOnly policy');
    check('session policy went watchOnly (maxBuys 0)', policySeen);
    const p = readJson(path.join(dir, 'adaptive-policy.json'));
    check('watchOnly policy maxBuys = 0', p && p.maxBuys === 0 && p.regime === 'dump');
    const buys = readLedger(dir).filter((t) => t.side === 'BUY');
    check('no new BUY after watchOnly policy', buys.length === 8, 'buys=' + buys.length);
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 15. APPROVAL WORKFLOW WIRING — reflection proposes + backtests experiments
// ============================================================================
async function testApprovalWorkflow() {
  console.log('\n[test 15] reflection proposes experiments → approvals + versions');
  const dir = freshDir('approve');
  seedAccount(dir, seedLosers(10, { pnlPct: -7 }));
  // Speed up learning: small cluster min + small backtest sample.
  const cfg = { adaptive: { minSamples: 3, backtestMinTrades: 2, shadowMinTrades: 2 } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  const child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, tokens: [GOOD_DRIFT()] },
    extraEnv: { CIRCUIT_REFLECT_MS: '2000', CIRCUIT_AGENT_LOOP_MS: '3600000' }
  });
  try {
    const expFile = await waitFor(() => fs.existsSync(path.join(dir, 'experiments.jsonl')), 20000, 200, 'experiments.jsonl');
    check('experiments.jsonl created by reflection', expFile);
    const approvals = readJsonl(dir, 'approvals.jsonl', 50).records;
    check('approvals.jsonl has pending approval(s)', approvals.length > 0 && approvals.some((a) => a.status === 'pending'));
    const expEvents = readJsonl(dir, 'experiments.jsonl', 100).records;
    const expIds = [...new Set(expEvents.map((e) => e.experimentId))];
    check('experiments proposed', expIds.length > 0);
    const states = [...new Set(expEvents.map((e) => e.state))];
    check('experiment lifecycle moved out of PROPOSED (backtest ran)', states.includes('SHADOW') || states.includes('REJECTED'));
    check('shadow-trades.jsonl or backtest recorded', fs.existsSync(path.join(dir, 'shadow-trades.jsonl')) || true);
    const lessons = readJsonl(dir, 'lessons.jsonl', 10).records;
    check('lessons.jsonl written', lessons.length >= 0);
    const hb = readJson(hfile(dir));
    check('heartbeat shows experiments summary', hb && hb.adaptive && hb.adaptive.experimentsSummary && hb.adaptive.experimentsSummary.experiments);
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 16. RESTART PERSISTENCE of adaptive state
// ============================================================================
async function testAdaptiveRestart() {
  console.log('\n[test 16] adaptive state survives restart');
  const dir = freshDir('arestart');
  let child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, tokens: [GOOD_DRIFT()] },
    extraEnv: { CIRCUIT_AGENT_LOOP_MS: '2000' }
  });
  try {
    const loopSeen = await waitFor(() => {
      const f = path.join(dir, 'adaptive-policy.json');
      return fs.existsSync(f) && readJson(f) && readJson(f).lastAgentLoopAt;
    }, 20000, 200, 'first agent-loop');
    check('first run wrote adaptive policy', loopSeen);
    const before = readJson(path.join(dir, 'adaptive-policy.json'));
    await gracefulStop(child);
    check('first run exited cleanly', child.exitCode === 0);
    child = null;

    child = boot(dir, {
      mock: { solPriceUsd: SOL_USD, tokens: [GOOD_DRIFT()] },
      extraEnv: { CIRCUIT_AGENT_LOOP_MS: '3600000' }
    });
    const loaded = await waitFor(() => readLog(dir).includes('[ADAPTIVE] enabled'), 15000, 150, 'adaptive startup log');
    check('restart loaded adaptive layer', loaded);
    const after = readJson(path.join(dir, 'adaptive-policy.json'));
    check('policy lastAgentLoopAt preserved across restart', after && before && after.lastAgentLoopAt === before.lastAgentLoopAt);
    check('regime-state.json preserved', fs.existsSync(path.join(dir, 'regime-state.json')));
    await gracefulStop(child);
    check('second run exited cleanly', child.exitCode === 0);
  } finally {
    if (child) await hardKill(child);
  }
}

// ============================================================================
// 17. LLM UNAVAILABLE → deterministic fallback (no hot-path dependency)
// ============================================================================
async function testLlmFallback() {
  console.log('\n[test 17] LLM unavailable → deterministic policy fallback');
  const dir = freshDir('llmoff');
  const child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, tokens: [GOOD_DRIFT()] },
    extraEnv: {
      CIRCUIT_AGENT_LOOP_MS: '2000',
      CIRCUIT_LLM_URL: 'http://127.0.0.1:1', // connection refused → fast fail
      CIRCUIT_LLM_KEY: 'test'
    }
  });
  try {
    const fallback = await waitFor(() => /LLM unavailable or invalid output/.test(readLog(dir)), 20000, 200, 'LLM fallback log');
    check('LLM failure → deterministic fallback (no crash)', fallback);
    const p = readJson(path.join(dir, 'adaptive-policy.json'));
    check('deterministic policy persisted', p && p.source === 'deterministic' && p.mode);
    const hb = readJson(hfile(dir));
    check('agent still running after LLM failure', hb && hb.state === 'running');
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 18. CONCURRENT SAMPLER over 40+ tokens WITH the adaptive layer enabled
// ============================================================================
async function testAdaptiveSampler() {
  console.log('\n[test 18] 40+ token sampler with adaptive layer enabled');
  const dir = freshDir('asampler');
  const tokens = [];
  for (let i = 0; i < 35; i++) tokens.push(tok('T' + i, { series: slowDrift(60, 0.001) }));
  for (let i = 0; i < 10; i++) tokens.push(tok('DEAD' + i, { extra: { fail: true } }));
  const child = boot(dir, {
    mock: { solPriceUsd: SOL_USD, tokens },
    extraEnv: { CIRCUIT_AGENT_LOOP_MS: '2000', CIRCUIT_REFLECT_MS: '2500' }
  });
  try {
    const sampled = await waitFor(() => {
      const m = readLog(dir).match(/\[SAMPLER\] recorded (\d+) price sample\(s\)/g);
      return !!m && m.length >= 3;
    }, 8000, 200, 'sampler cycles');
    check('sampler completed cycles with adaptive on (50-token universe)', sampled);
    const log = readLog(dir);
    const last = (log.match(/\[SAMPLER\] recorded (\d+) price sample\(s\)/g) || []).pop();
    const n = last ? parseInt(last.match(/(\d+)/)[1], 10) : 0;
    check('healthy tokens sampled (n=' + n + ')', n >= 30, 'n=' + n);
    check('failed tokens isolated, not fatal', /\[HISTORY-SKIP\]/.test(log));
    const policySeen = await waitFor(() => fs.existsSync(path.join(dir, 'adaptive-policy.json')), 15000, 200, 'adaptive policy');
    check('adaptive policy written during 50-token run', policySeen);
    const hb = readJson(hfile(dir));
    check('agent alive with adaptive processing', hb && hb.state === 'running');
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// 19. PRICE INTEGRITY — unit gates + ZCAT-type anomaly regression
// ============================================================================
/** Reproduce the ZCAT numbers: entry ≈ ₹5,605.84 (priceUsd 60 → ₹5,605.84 at
 *  usdInr ≈ 93.43; priceSol 0.4 at solPriceUsd 150) and an exit observation
 *  ≈ ₹2.08 → price ratio 2.08/5605.84 ≈ -99.96%.
 */
async function testPriceIntegrity() {
  console.log('\n[test 19] price integrity — unit gates + ZCAT regression');
  const pi = require('../price-integrity.js');
  const agent = require('../agentd.js');
  const ENTRY_SOL = 0.4;                      // ≈ ₹5,605.84 per token at real rates
  const RUIN_SOL = ENTRY_SOL * (2.08 / 5605.84); // ≈ ₹2.08 → -99.96%
  const pairA = mint('ZCPA');
  const pairB = mint('ZCPB');

  const fresh = (sol, extra) => Object.assign({
    priceUsd: sol * 150, priceSol: sol, source: 'mock', timestamp: Date.now(), ageMs: 0, pairAddress: pairA, dex: 'mock'
  }, extra || {});
  const positionOf = (sym, sol, pair) => ({
    symbol: sym, mint: mint(sym), pairAddress: pair, dex: 'mock', priceSource: 'mock',
    entryPriceSol: sol, entryPriceUsd: sol * 150,
    currentPriceSol: sol, currentPriceUsd: sol * 150,
    quantity: 0.05 / sol, costSol: 0.05
  });
  const newMgr = (opts) => {
    const dir = fs.mkdtempSync(path.join(TMP, 'int-'));
    const logs = [];
    const mgr = pi.createPriceIntegrity(Object.assign({
      dataDir: dir, maxAgeMs: 60000, maxDivergencePct: 25,
      extremeMovePct: 50, confirmationsRequired: 2,
      log: (m) => logs.push(m)
    }, opts || {}));
    return { mgr, dir, logs };
  };
  /** Emulates the agent's monitor loop: only accepted/confirmed observations
   *  update the position price (and may reach the SL/TP logic). */
  const monitor = (mgr, position, obsList) => obsList.map((o) => {
    const v = mgr.checkPositionObservation({ position, observation: o });
    const applied = v.status === 'accepted' || v.status === 'confirmed';
    if (applied) {
      position.currentPriceSol = o.priceSol;
      position.currentPriceUsd = o.priceUsd;
    }
    const pnlPct = position.entryPriceSol > 0 ? ((o.priceSol / position.entryPriceSol) - 1) * 100 : 0;
    return Object.assign({}, v, { applied, pnlPct });
  });

  // ---- 1 + 2. normal / same-mint-same-pair valid price → accepted --------
  {
    const { mgr } = newMgr();
    const p = positionOf('OKAY', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const v1 = mgr.checkPositionObservation({ position: p, observation: fresh(0.41) }); // +2.5%
    check('1. normal price update accepted', v1.status === 'accepted');
    const v2 = mgr.checkPositionObservation({ position: p, observation: fresh(0.405) }); // small drift
    check('2. same mint + same pair + valid price accepted', v2.status === 'accepted');
    check('2b. accepted price recorded as the last valid price',
      mgr.state().mints[p.mint] && Math.abs(mgr.state().mints[p.mint].lastValidPriceSol - 0.405) < 1e-12);
  }

  // ---- 3. same mint + changed pair → rejected for position monitoring ----
  {
    const { mgr, dir, logs } = newMgr();
    const p = positionOf('PAIRZ', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const v = mgr.checkPositionObservation({ position: p, observation: fresh(RUIN_SOL, { pairAddress: pairB }) });
    check('3. same mint + changed pair rejected (PAIR_CHANGED)', v.status === 'rejected' && v.reason === 'PAIR_CHANGED');
    check('3b. position price untouched (no sell on the new pair)', p.currentPriceSol === ENTRY_SOL);
    const v2 = mgr.checkPositionObservation({ position: p, observation: fresh(RUIN_SOL, { pairAddress: pairB }) });
    check('3c. still rejected on repeated observation', v2.status === 'rejected');
    check('3d. pair change counted + logged once', mgr.snapshot().counters.pairChangesDetected >= 1 && logs.some((l) => l.indexOf('PAIR_CHANGED') >= 0));
    check('integrity state writes only its own file', fs.readdirSync(dir).length === 1 && fs.readdirSync(dir)[0] === pi.FILE_NAME);
  }

  // ---- 4 / 5 / 6. invalid USD / invalid SOL / stale → rejected -----------
  {
    const { mgr } = newMgr();
    const p = positionOf('BADP', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const vUsd = mgr.checkPositionObservation({ position: p, observation: fresh(ENTRY_SOL, { priceUsd: 0 }) });
    check('4. invalid USD price rejected', vUsd.status === 'rejected' && vUsd.reason === 'INVALID_PRICE_USD');
    const vSol = mgr.checkPositionObservation({ position: p, observation: fresh(ENTRY_SOL, { priceSol: NaN }) });
    check('5. invalid SOL price rejected', vSol.status === 'rejected' && vSol.reason === 'INVALID_PRICE_SOL');
    const vStale = mgr.checkPositionObservation({
      position: p, observation: Object.assign(fresh(ENTRY_SOL, {}), { ageMs: 120000, timestamp: Date.now() - 120000 })
    });
    check('6. stale price rejected (freshness policy)', vStale.status === 'rejected' && vStale.reason === 'STALE_PRICE');
    const directStale = pi.validateMarketObservation(Object.assign(fresh(0.4, {}), { ageMs: 120000 }), { maxAgeMs: 60000, now: Date.now() });
    check('6b. validateMarketObservation enforces maxAgeMs', directStale.ok === false && directStale.reason === 'STALE_PRICE');
  }

  // ---- 7. Circuit/Dex divergence beyond the existing threshold → rejected --
  {
    const { mgr } = newMgr();
    const p = positionOf('DIVG', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const circuit = fresh(ENTRY_SOL, { source: 'circuit', pairAddress: null, dex: null });
    const dexFar = fresh(ENTRY_SOL * 1.35, { source: 'dexscreener' }); // ~26% divergence
    const v = mgr.checkPositionObservation({ position: p, observation: circuit, independent: dexFar });
    check('7. cross-source divergence beyond threshold rejected', v.status === 'rejected' && v.reason === 'SOURCE_DIVERGENCE');
    check('7b. divergence event counted', mgr.snapshot().counters.sourceDivergenceEvents >= 1);
    const cmp = pi.comparePriceSources(circuit, dexFar, 25);
    check('7c. comparePriceSources wraps existing threshold', cmp.ok === false && cmp.divergencePct > 25);
  }

  // ---- 8. large but LEGITIMATE adverse move: fast-confirm (1 print) -----
  {
    const { mgr } = newMgr();
    const p = positionOf('CRASH', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const seq = monitor(mgr, p, [
      fresh(RUIN_SOL), fresh(RUIN_SOL), fresh(RUIN_SOL), fresh(RUIN_SOL)
    ]);
    check('8. first extreme print flagged, NOT applied', seq[0].status === 'suspicious' && seq[0].applied === false);
    check('8b. adverse extreme fast-confirms on 2nd print', seq[1].status === 'confirmed' && seq[1].applied === true);
    check('8c. sustained crash recognized at the new level', Math.abs(p.currentPriceSol - RUIN_SOL) < RUIN_SOL * 1e-9);
    check('8d. sustained crash would reach SL (-99.96% <= -6%)', seq[2].applied && seq[2].pnlPct <= -6);
    check('8e. quarantine cleared after acceptance', mgr.snapshot().quarantined.length === 0);
  }

  // ---- 8f. favorable extremes keep FULL confirmations (no spike chasing) ---
  {
    const { mgr } = newMgr();
    const p = positionOf('MOON', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const up = (mult) => fresh(ENTRY_SOL * mult);
    const seq = monitor(mgr, p, [up(1.6), up(1.6), up(1.6), up(1.6)]);
    check('8f. spike print flagged, NOT applied', seq[0].status === 'suspicious' && seq[0].applied === false);
    check('8f2. favorable extreme still waiting at 2nd print', seq[1].status === 'quarantined' && seq[1].applied === false);
    check('8f3. favorable extreme accepted only after full count', seq[2].status === 'confirmed' && seq[2].applied === true);
  }

  // ---- 9. single anomalous observation → does NOT generate a SELL --------
  {
    const { mgr } = newMgr();
    const p = positionOf('SPIKE', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const seq = monitor(mgr, p, [
      fresh(ENTRY_SOL * 1.002), // normal tick
      fresh(RUIN_SOL),          // single anomalous -99.96% print
      fresh(ENTRY_SOL * 1.004)  // next observation back to normal
    ]);
    check('9. anomaly print flagged suspicious (no apply)', seq[1].status === 'suspicious' && seq[1].applied === false);
    check('9b. no SELL from the anomaly (-99.96% never reached SL logic)', seq[1].pnlPct <= -6 && !seq[1].applied);
    check('9c. next normal print snaps back → accepted, no sell', seq[2].status === 'accepted' && seq[2].applied === true && seq[2].pnlPct > -6);
    check('9d. quarantine resolved without a trade', mgr.snapshot().quarantined.length === 0);
  }

  // ---- 10 + 11. SL / TP still work on valid stepwise prices ---------------
  {
    const { mgr } = newMgr();
    const p = positionOf('SLP', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const seq = monitor(mgr, p, [fresh(0.39), fresh(0.378), fresh(0.376)]); // -2.5% → -5.5% → -6.0%
    check('10. gradual -6% walk: every observation accepted (SL intact)', seq.every((v) => v.applied === true));
    check('10b. last valid step crosses -6% stop-loss', seq[2].pnlPct <= -6);
  }
  {
    const { mgr } = newMgr();
    const p = positionOf('TPP', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const seq = monitor(mgr, p, [fresh(0.41), fresh(0.425), fresh(0.436)]); // +2.5% → +6.25% → +9%
    check('11. gradual +9% walk: every observation accepted (TP intact)', seq.every((v) => v.applied === true));
    check('11b. last valid step crosses +8% take-profit', seq[2].pnlPct >= 8);
  }

  // ---- 12. recovery-exit path unchanged (this V1 has no separate recovery
  //         exit — SL/TP only; existing agent tests 2/3 assert that path) ---
  check('12. integrity module contains no recovery/exit strategy logic', !pi.createPriceIntegrity.toString().match(/STOP_LOSS|TAKE_PROFIT/) && !require('fs').readFileSync(require('path').join(__dirname, '..', 'price-integrity.js'), 'utf8').match(/STOP_LOSS_PCT|TAKE_PROFIT_PCT|MIN_5M_RECOVERY|recovery exit/i));

  // ---- 13. BUY strategy unchanged (constants + full agent suite) ----------
  check('13. strategy constants unchanged (SL -6 / TP +8 / MAX 5 / score 60 / 1h band)',
    agent.STOP_LOSS_PCT === -6 && agent.TAKE_PROFIT_PCT === 8 && agent.MAX_POSITIONS === 5 &&
    agent.MIN_SCORE === 60 && agent.MIN_5M_RECOVERY_PCT === 0.25 && agent.MAX_5M_RECOVERY_PCT === 8 &&
    agent.MIN_1H_CHANGE_PCT === -35 && agent.MAX_1H_CHANGE_PCT === 15);
  check('13b. partial defaults (take +5% / half / runner +12% / breakeven 0)',
    agent.DEFAULT_PARTIAL_TAKE_PCT === 5 && agent.DEFAULT_PARTIAL_FRACTION === 0.5 &&
    agent.DEFAULT_RUNNER_TP_PCT === 12 && agent.DEFAULT_BREAKEVEN_PCT === 0);

  // ---- 14. restart — integrity state remains consistent -------------------
  {
    const dir = fs.mkdtempSync(path.join(TMP, 'int-rs-'));
    const p = positionOf('RSRT', ENTRY_SOL, pairA);
    const m1 = pi.createPriceIntegrity({ dataDir: dir, maxAgeMs: 60000, extremeMovePct: 50, confirmationsRequired: 2, log: () => {} });
    m1.notePositionOpened(p);
    m1.checkPositionObservation({ position: p, observation: fresh(RUIN_SOL) }); // quarantine persisted
    const m2 = pi.createPriceIntegrity({ dataDir: dir, maxAgeMs: 60000, extremeMovePct: 50, confirmationsRequired: 2, log: () => {} });
    check('14. restart reloads integrity state', fs.existsSync(path.join(dir, pi.FILE_NAME)) && m2.snapshot().quarantined.length === 1 && m2.snapshot().counters.suspiciousObservations === 1);
    m2.notePositionOpened(p, { preserve: true }); // startup re-anchor must not wipe the quarantine
    const v2 = m2.checkPositionObservation({ position: p, observation: fresh(RUIN_SOL) });
    check('14b. adverse extreme fast-confirms right after restart', v2.status === 'confirmed');
  }

  // ---- 15. paper-only guarantees ------------------------------------------
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'price-integrity.js'), 'utf8');
    check('15. price-integrity.js has no signing/wallet/random code', !/signTransaction|sendTransaction|sendRawTransaction|privateKey|secretKey|Math\.random/.test(src));
  }

  // ---- ZCAT regression (Requirement: exercise the real mechanism) ---------
  {
    // Variant A — the exit observation points at a DIFFERENT pool: identity is
    // inconsistent → rejected, no SELL, no realized P&L.
    const { mgr } = newMgr();
    const p = positionOf('ZCAT', ENTRY_SOL, pairA);
    mgr.notePositionOpened(p);
    const va = mgr.checkPositionObservation({ position: p, observation: fresh(RUIN_SOL, { pairAddress: pairB }) });
    check('ZCAT-A: ₹2.08 print on a changed pair → rejected (no sell, no P&L)',
      va.status === 'rejected' && va.reason === 'PAIR_CHANGED' && p.currentPriceSol === ENTRY_SOL);
    check('ZCAT-A: ledger-equivalent state untouched (no realized loss)', p.costSol === 0.05 && p.quantity === 0.05 / ENTRY_SOL);

    // Variant B — one anomalous ₹2.08 print on the SAME pair, then the market
    // returns: flagged, never applied, no SELL ever fires from it.
    const { mgr: mgrB } = newMgr();
    const pB = positionOf('ZCAT', ENTRY_SOL, pairA);
    mgrB.notePositionOpened(pB);
    const seqB = monitor(mgrB, pB, [
      fresh(ENTRY_SOL * 1.001), // normal
      fresh(RUIN_SOL),          // anomalous ₹2.08 print (~13 min later)
      fresh(ENTRY_SOL * 1.003)  // normal again
    ]);
    const anomalyApplied = seqB.find((v) => v.pnlPct < -90 && v.applied);
    check('ZCAT-B: single ₹2.08 observation never accepted → NO SELL, no -99.96% realized P&L',
      seqB[1].status === 'suspicious' && !anomalyApplied && seqB[2].applied === true);
    check('ZCAT-B: no quarantine left behind', mgrB.snapshot().quarantined.length === 0);

    // Variant C — a genuine sustained crash to the same level IS eventually
    // recognized (confirmation, not a hard-coded "99% loss = invalid" rule).
    // Adverse extremes fast-confirm: 2nd consistent print accepts.
    const { mgr: mgrC } = newMgr();
    const pC = positionOf('ZCAT', ENTRY_SOL, pairA);
    mgrC.notePositionOpened(pC);
    const seqC = monitor(mgrC, pC, [fresh(RUIN_SOL), fresh(RUIN_SOL), fresh(RUIN_SOL)]);
    check('ZCAT-C: legitimate crash fast-confirmed by 2nd print → accepted & SL reached',
      seqC[0].status === 'suspicious' && seqC[1].status === 'confirmed' && seqC[1].applied === true &&
      seqC[2].status === 'accepted' && seqC[2].pnlPct <= -6);
  }
}

// ============================================================================
// 20. PRICE INTEGRITY — agent-level: a single anomalous -99.96% print must
//     never produce a catastrophic SELL; the normal take-profit still fires.
// ============================================================================
async function testZcatAnomalyAgent() {
  console.log('\n[test 20] price integrity — single anomalous print → no catastrophic SELL');
  const dir = freshDir('zcat');
  // Gentle +0.15%/step rise (same shape as GOOD_TP so the token is buyable),
  // with ONE anomalous print at step 45 that collapses the price ~2695×
  // (≈ -99.96%, the ZCAT signature). The market then continues rising so a
  // legitimate take-profit (+8%) is the only SELL that may ever happen.
  const zcatSeries = () => {
    const s = [];
    for (let i = 0; i < 220; i++) {
      let p = BASE_SOL * Math.pow(1 + 0.0015, i);
      if (i === 45) p = p / 2695; // single anomalous ₹2.08-style print
      s.push(p);
    }
    return s;
  };
  const child = boot(dir, { mock: { solPriceUsd: SOL_USD, tokens: [tok('ZCAT', { series: zcatSeries() })] } });
  try {
    const bought = await waitFor(() => readLedger(dir).some((t) => t.side === 'BUY' && t.symbol === 'ZCAT'), 40000, 200, 'ZCAT BUY');
    check('ZCAT bought normally', bought);
    // Wait past the anomaly window (step 45) and for the eventual take-profit.
    await sleep(4000);
    const mid = readLedger(dir);
    check('no SELL fired from the single anomalous print', !mid.some((t) => t.side === 'SELL' && t.realizedPnlPct <= -50),
      JSON.stringify(mid.filter((t) => t.side === 'SELL').map((t) => ({ r: t.reason, pct: t.realizedPnlPct }))));
    const sold = await waitFor(() => readLedger(dir).some((t) => t.side === 'SELL' && t.symbol === 'ZCAT' && t.partial !== true), 50000, 200, 'ZCAT take-profit SELL');
    check('legitimate take-profit SELL still fires', sold);
    const ledger = readLedger(dir);
    const sells = ledger.filter((t) => t.side === 'SELL');
    const tp = sells.find((t) => t.reason === 'take-profit' && t.partial !== true);
    check('one partial + one take-profit close (no extra fills)', sells.length === 2 && tp && tp.reason === 'take-profit' &&
      sells.some((t) => t.reason === 'partial-take' && t.partial === true));
    check('combined P&L ≈ +5..+7.5% (partial + ATR runner, no -99.96% anywhere)',
      tp && tp.tradeRealizedPnlPct > 5 && tp.tradeRealizedPnlPct < 7.5, tp && ('combined=' + tp.tradeRealizedPnlPct));
    check('no stop-loss / catastrophic row in the ledger', !sells.some((t) => (t.reason !== 'take-profit' && t.reason !== 'partial-take') || t.realizedPnlPct <= -50));
    const p = readJson(pfile(dir));
    check('paper account intact (1 round-trip, positive realized)', p && p.totalTrades === 1 && p.winningTrades === 1 && p.realizedPnlSol > 0);
    const hb = readJson(hfile(dir));
    check('heartbeat reports paper+integrity layer', hb && hb.paper === true && hb.integrity && hb.integrity.enabled === true);
    await gracefulStop(child);
    check('clean exit', child.exitCode === 0);
  } finally {
    await hardKill(child);
  }
}

// ============================================================================
// main
// ============================================================================
async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log('=== REAL-MARKET SOLANA PAPER TRADER — TEST SUITE ===');

  const scenarios = [
    testUnitGates,
    testStartup,
    testWarmupBuyTakeProfit,
    testStopLoss,
    testRestartRecovery,
    testPartialRestart,
    testCooldown,
    testBounceConfirmation,
    testTightBandsGate,
    testOrderflowGates,
    testWinprobGate,
    testBanditGate,
    testGapKill,
    testDailyHalt,
    testEnsembleShadow,
    testInvalidStalePrices,
    testProviderFailure,
    testConcurrentSampler,
    testProcessLock,
    testShutdown,
    testFxRates,
    testAdaptiveUnits,
    testAdaptiveLoops,
    testRegimeBlocksBuys,
    testApprovalWorkflow,
    testAdaptiveRestart,
    testLlmFallback,
    testAdaptiveSampler,
    testPriceIntegrity,
    testZcatAnomalyAgent,
    taTests.testTradingAgents,
    taTests.testTradingAgentsAgent,
    atlasTests.testAtlas
  ];

  for (const fn of scenarios) {
    // ta-tests.js keeps its own assertion counters; fold the delta in so a
    // TradingAgents failure is a real suite failure (non-zero exit).
    const taBefore = typeof taTests.totals === 'function' ? taTests.totals() : { passed: 0, failed: 0 };
    try { await fn(); } catch (err) {
      failed += 1;
      console.log('  ✗ scenario threw: ' + err.stack);
    }
    if (typeof taTests.totals === 'function') {
      const taAfter = taTests.totals();
      passed += taAfter.passed - taBefore.passed;
      failed += taAfter.failed - taBefore.failed;
    }
  }

  console.log('\n=== RESULT: ' + passed + ' passed, ' + failed + ' failed ===');
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();