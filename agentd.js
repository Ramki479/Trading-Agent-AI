#!/usr/bin/env node
/**
 * agentd.js — REAL-MARKET SOLANA PAPER TRADER (Circuit paper-trader agent).
 *
 * Self-contained, dependency-free, 100% PAPER trading.
 *
 * Safety invariants (hard-coded — configuration can never override them):
 *   • paperTrading is ALWAYS true. There is no live-trading code path.
 *   • No wallet is created or loaded; no private keys / seed phrases exist.
 *   • No real execution: every trade is simulated locally and is never
 *     signed or broadcast. CIRCUIT_SIGNER_URL (if set) is ignored.
 *   • custody is always "local".
 *   • Wallet / signer / broadcast are DISABLED by design.
 *
 * Market data is REAL Solana market data (DexScreener primary, optional
 * Circuit data API via CIRCUIT_PRICE_API_URL). No Math.random() is ever used
 * for prices, P&L, or signals — every displayed value derives from observed
 * real market data. The strategy (dip-reversal, thresholds below) is fixed —
 * the V1 baseline is preserved exactly. On top of it sits a Circuit-style
 * ADAPTIVE POLICY LAYER (agent-loop every 90 min, reflection every 4h,
 * regime detection, learned gates, market-health gating, bounded session
 * sizing, an approval workflow with shadow testing + rollback). Every
 * adaptive mechanism is deterministic and data-driven; an OPTIONAL async
 * LLM hook (CIRCUIT_LLM_URL) may reinterpret the session policy but is
 * schema-validated, clamped, and never on the scanner hot path. See
 * docs/CIRCUIT_CURRENT_RESEARCH.md and docs/CIRCUIT_TO_PAPER_AGENT_MAPPING.md.
 *
 * Persistent state lives in ${CIRCUIT_AGENT_DATA_DIR} (default
 * ~/.circuit/agents/paper-trader):
 *   portfolio.json      — account + open positions + cooldowns (atomic writes)
 *   trades.jsonl        — append-only ledger of every BUY and SELL
 *   equity-history.jsonl— append-only observed equity samples
 *   heartbeat.json      — machine-readable state + full portfolio summary
 *   candidates.json     — last discovery scan (real candidates + decisions)
 *   config.json         — runtime config (auto-created with defaults)
 *   meta.json           — agent metadata (no wallet, paper only)
 *   agent.lock          — process lock (one agent per data dir)
 *   agent.log           — human-readable log
 *
 * Usage:
 *   node agentd.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const marketDataLib = require('./market-data.js');
const perfLib = require('./performance-analyzer.js');
const regimeLib = require('./regime-detector.js');
const healthLib = require('./market-health.js');
const gatesLib = require('./learned-gates.js');
const adaptivePolicy = require('./adaptive-policy.js');
const experiments = require('./strategy-experiments.js');
const reflectionEngine = require('./reflection-engine.js');
const atlasEngine = require('./atlas/atlas-engine.js');
const llmAdapter = require('./llm-adapter.js');
const integrityLib = require('./price-integrity.js');
const tradingAgentsLib = require('./tradingagents-layer.js');
const researchHistoryLib = require('./research-history.js');

/* ------------------------------------------------------------------ *
 * Hard safety constants — never configurable.
 * ------------------------------------------------------------------ */

const AGENT_NAME = 'paper-trader';
const MODE = 'paper';
const CUSTODY = 'local';
const AGENT_VERSION = 'agentd-2.13.0+risksizing'; // bump on behavioral changes; recorded in agent.lock provenance
const PAPER_TRADING = true; // forced on. Live trading is impossible here.
const WALLET_STATE = 'DISABLED';
const SIGNER_STATE = 'DISABLED';
const BROADCAST_STATE = 'DISABLED';
const MARKET_LABEL = 'REAL SOLANA';
const EXECUTION_LABEL = 'PAPER ONLY';

/* ------------------------------------------------------------------ *
 * STRATEGY — dip/reversal. These thresholds are fixed (do not change
 * unless explicitly requested):
 *   MAX_POSITIONS       = 5          max concurrently open paper positions
 *   TRADE_SIZE_SOL      = 0.05       paper size per BUY (config default)
 *   STOP_LOSS           = -6%        SELL when unrealized <= -6% (fixed fallback)
 *   TAKE_PROFIT         = +8%        SELL when unrealized >= +8% (fixed fallback)
 *   ATR exits           SL=1.5×NATR TP=2.5×NATR (per-position, NATR>4% rejected)
 *   MIN_5M_RECOVERY     = +0.25%     BUY gate on local 5m recovery
 *   MAX_5M_RECOVERY     = +8%
 *   1h change           > -35% and <= +15%
 *   MIN_SCORE           = 60
 *   REENTRY_COOLDOWN    = 600000 ms  (10 min) after a SELL
 *   PARTIAL_TAKE        = +5%  sell 50%, runner SL→breakeven TP→+12%
 * ------------------------------------------------------------------ */

const MAX_POSITIONS = 5;
const SELECTIVE_CANDIDATE_LIMIT = 3; // selective mode evaluates the top-N candidates (was 1; increased to improve entry frequency)
const STOP_LOSS_PCT = -6;
const TAKE_PROFIT_PCT = 8;
const MIN_5M_RECOVERY_PCT = 0.25;
const MAX_5M_RECOVERY_PCT = 8;
const MIN_1H_CHANGE_PCT = -35;
const MAX_1H_CHANGE_PCT = 15;
const MIN_SCORE = 60;

// Entry-quality protection (does not alter V1 signal/exit rules).
// Candidates below either threshold are rejected before BUY.
const MIN_LIQUIDITY_USD = 20000;
const MIN_VOLUME_24H_USD = 50000;

// Gap/slippage kill (RISK exit — complements SL/TP, never replaces validity).
// Two mechanisms: (1) a liquidity pull >= LIQ_DROP_KILL_PCT on a validity-
// passed observation exits IMMEDIATELY (liquidity corroborates — a bad price
// print does not drain the pool); (2) adverse price extremes fast-confirm
// inside price-integrity (GAP_KILL_PCT sets the adverse bar, default 20%:
// one consistent print instead of two). Price gaps NEVER bypass quarantine
// outright — a single anomalous print must hold for confirmation (ZCAT rule).
// Validity still applies: stale/invalid/pair-changed observations NEVER
// trigger a kill (hold as before).
// Env overrides: CIRCUIT_GAP_KILL_PCT, CIRCUIT_LIQ_DROP_PCT.
const DEFAULT_GAP_KILL_PCT = 20;
const DEFAULT_LIQ_DROP_KILL_PCT = 50;

// Time-stop (RISK exit — complements SL/TP, never replaces validity).
// Winners close in 4-50m; losers linger (avgHold 113m, tails >1300m) and pin
// slots. A position held >= TIME_STOP_MS whose unrealized PnL is still below
// TIME_STOP_MIN_PNL_PCT exits at market (`time-stop`). Runs only on
// validity-passed + integrity-accepted observations, after SL/TP (SL wins ties).
// Env overrides: CIRCUIT_TIME_STOP_MS, CIRCUIT_TIME_STOP_MIN_PNL_PCT.
const DEFAULT_TIME_STOP_MS = 60 * 60 * 1000;
const DEFAULT_TIME_STOP_MIN_PNL_PCT = 2;

// Partials + breakeven + runner (RISK exits — complements SL/TP).
// All-or-nothing +8%/-6% (1.33R) needs ~43% WR to break even. Instead: at
// PARTIAL_TAKE_PCT (+5%) sell PARTIAL_FRACTION (50%) of the position, move the
// remaining runner's stop to BREAKEVEN_PCT (entry) and its target to
// RUNNER_TP_PCT (+12%). Blended expectancy ((5+12)/2 = 8.5% win vs 6% loss)
// needs only ~35-41% WR. The partial banks realized P&L immediately without
// counting as a closed trade (no cooldown, no win/loss increment); the final
// close carries combined trade economics. Env overrides below + kill-switch
// CIRCUIT_PARTIALS_DISABLE=1.
const DEFAULT_PARTIAL_TAKE_PCT = 5;
const DEFAULT_PARTIAL_FRACTION = 0.5;
const DEFAULT_RUNNER_TP_PCT = 12;
const DEFAULT_BREAKEVEN_PCT = 0;

// ATR exits (RISK sizing — replaces fixed -6%/+8% per-position stops).
// NATR (%) is the trailing-20-close excursion projected to a full window:
//
//   raw  = (maxClose - minClose) / lastClose * 100   (trailing ≤20 closes, ≥8)
//   NATR = raw * (20 / n)   (uncertainty-scaled; ≈raw in production where
//   entries carry ~20 samples after the 5-min warm-up)
//
// Calibrated on real research-prices history (11k trailing-20 windows):
// p50 excursion ≈ 0.01% (stale prints repeat), p75 ≈ 0.53%, p90 ≈ 1.83%,
// p95 ≈ 4.39%. SL = 1.5×NATR, TP = 2.5×NATR; floor 1.5% keeps stops above
// micro-noise; entries hotter than 4% are rejected (stop would gap).
// A single anomalous print inflates excursion (fail-safe: wider stops /
// entry rejected until it ages out). Env overrides below + kill-switch
// CIRCUIT_ATR_DISABLE=1 (fixed V1 -6%/+8% fallback).
const NATR_WINDOW = 20;
const NATR_MIN_SAMPLES = 8;
const DEFAULT_ATR_SL_MULT = 1.5;
const DEFAULT_ATR_TP_MULT = 2.5;
const DEFAULT_MIN_NATR_PCT = 1.5;
const DEFAULT_MAX_NATR_PCT = 4;

// Entry quality from market microstructure (DexScreener txns/fdv/mcap).
//   • distribution — h24 sells > MAX_SELLS_BUYS_RATIO × buys → someone is
//     unloading into the bounce; skip.
//   • valuation — pool liquidity < MIN_LIQ_MCAP_PCT of market cap (fdv
//     fallback) → too thin to exit at size; skip.
// Missing data fails OPEN (never block blindly, never trade blindly — the
// absolute MIN_LIQUIDITY_USD floor still applies). liqVolRatio (24h volume ÷
// liquidity) is plumbed for transparency/tuning, not gated.
// Env overrides below + kill-switch CIRCUIT_QUALITY_DISABLE=1.
const DEFAULT_MAX_SELLS_BUYS_RATIO = 1.5;
const DEFAULT_MIN_LIQ_MCAP_PCT = 2;
const DEFAULT_TARGET_VOL_PCT = 3.0; // vol-sizing target: size = base * (targetVol / NATR)

// RSI + VWAP dip filter (entry quality on local history — no new feed).
//
//   RSI: RSI(14) < 50 AND turning up (current reading above the previous
//   one). Computed on 1-MINUTE resampled closes (14-minute memory), NOT raw
//   15 s ticks — by construction a short-window recovery>0 implies
//   short-window RSI>50 (telescoping gains), so tick-RSI would reject every
//   entry including textbook V-bottoms (measured: smooth rise → RSI 100,
//   in-window V → RSI 41.7). The 14-minute RSI matches the dip timeframe
//   while the 5-minute recovery gate stays independent. Oversold bar moved
//   30→50 so any non-overbought turning tape qualifies, not just deep dips.
//   Override the bar width with CIRCUIT_RSI_BAR_MS (15000 ≈ raw-tick
//   behavior) and the oversold line with CIRCUIT_RSI_OVERSOLD.
//
//   VWAP: last close back above the trailing-5-minute mean. The sampler
//   stores closes only (no per-sample volume), so this is a time-weighted
//   mean proxy — documented, not a true volume-weighted VWAP. It still
//   captures the "reclaim" semantics: price back above its recent average.
//
// <15 one-minute bars → RSI leg fails OPEN (warming; prod activates after
// ~15 min uptime, fast-test runs never). VWAP needs ≥8 closes (always true
// past the warming gate, which runs first). Kill-switch
// CIRCUIT_RSI_VWAP_DISABLE=1.
const RSI_PERIOD = 14;
const RSI_MIN_BARS = RSI_PERIOD + 1;
const DEFAULT_RSI_BAR_MS = 60000;
const DEFAULT_RSI_OVERSOLD = 50; // was 30 — accept momentum turns below mid, not just deep-oversold
const VWAP_LOOKBACK_MS = 5 * 60 * 1000;
const VWAP_MIN_SAMPLES = 8;

// Non-strategy operational knobs (env overridable — see loadConfig):
//   CIRCUIT_MONITOR_MS, CIRCUIT_DISCOVERY_MS, CIRCUIT_SAMPLE_MS,
//   CIRCUIT_HISTORY_WARM_MS (test warm-up target), CIRCUIT_COOLDOWN_MS,
//   CIRCUIT_MAX_PRICE_AGE_MS, CIRCUIT_MAX_DIVERGENCE_PCT,
//   CIRCUIT_GAP_KILL_PCT (default 20), CIRCUIT_LIQ_DROP_PCT (default 50),
//   CIRCUIT_TIME_STOP_MS (default 3600000), CIRCUIT_TIME_STOP_MIN_PNL_PCT (default 2),
//   CIRCUIT_PARTIAL_TAKE_PCT (5), CIRCUIT_PARTIAL_FRACTION (0.5),
//   CIRCUIT_RUNNER_TP_PCT (12), CIRCUIT_BREAKEVEN_PCT (0), CIRCUIT_PARTIALS_DISABLE=1,
//   CIRCUIT_ATR_SL_MULT (1.5), CIRCUIT_ATR_TP_MULT (2.5),
//   CIRCUIT_MIN_NATR_PCT (1.5), CIRCUIT_MAX_NATR_PCT (4), CIRCUIT_ATR_DISABLE=1,
//   CIRCUIT_CONFIRM_DISABLE=1, CIRCUIT_QUALITY_DISABLE=1,
//   CIRCUIT_RSI_VWAP_DISABLE=1, CIRCUIT_RSI_BAR_MS (60000),
//   CIRCUIT_RSI_OVERSOLD (50),
//   CIRCUIT_WINPROB_MIN_TRADES (10), CIRCUIT_WINPROB_THRESHOLD (tuned PF),
//   CIRCUIT_WINPROB_DISABLE=1, CIRCUIT_ENSEMBLE_MODE (SHADOW),
//   CIRCUIT_BANDIT_LIVE=1, CIRCUIT_BANDIT_DAY (replay, default today),
//   CIRCUIT_MAX_SELLS_BUYS (1.5), CIRCUIT_MIN_LIQ_MCAP_PCT (2),
//   CIRCUIT_TARGET_VOL_PCT (3.0),
//   CIRCUIT_PRICE_API_URL (optional Circuit data API), CIRCUIT_MOCK_MARKET_FILE (tests only).
const DEFAULT_DISCOVERY_MS = 60000;   // token discovery every 60 s
const DEFAULT_MONITOR_MS = 5000;      // monitor open positions every 5 s
const DEFAULT_SAMPLE_MS = 15000;      // sample price history every 15 s
const DEFAULT_HISTORY_TARGET_MS = 120000; // recovery baseline ≈ 2 min old (was 5m — shortened to start trading sooner)
const DEFAULT_COOLDOWN_MS = 600000;   // 10 min re-entry cooldown
const DEFAULT_MAX_PRICE_AGE_MS = 60000;   // refuse prices older than this
const DEFAULT_MAX_DIVERGENCE_PCT = 25;    // reject suspicious cross-source divergence
const HISTORY_KEEP_MS = 15 * 60 * 1000;   // keep ~15 min of per-token history
const MIN_HISTORY_SAMPLES = 5;            // samples required before recovery is valid (was 8)
const SAMPLE_UNIVERSE_CAP = 40;           // bound the sampler universe

const EQUITY_SAMPLE_DELTA = 0.0001;
const EQUITY_SAMPLE_MAX_GAP_MS = 30000;

const BOOT_TIME = Date.now();

/* ------------------------------------------------------------------ *
 * Paths.
 * ------------------------------------------------------------------ */

const dataDir = process.env.CIRCUIT_AGENT_DATA_DIR ||
  path.join(os.homedir(), '.circuit', 'agents', 'paper-trader');

const portfolioFile = path.join(dataDir, 'portfolio.json');
const tradesFile = path.join(dataDir, 'trades.jsonl');
const heartbeatFile = path.join(dataDir, 'heartbeat.json');
const configFile = path.join(dataDir, 'config.json');
const metaFile = path.join(dataDir, 'meta.json');
const logFile = path.join(dataDir, 'agent.log');
const equityHistoryFile = path.join(dataDir, 'equity-history.jsonl');
const candidatesFile = path.join(dataDir, 'candidates.json');
const ensembleShadowFile = path.join(dataDir, 'ensemble-shadow.jsonl');
const lockFile = path.join(dataDir, 'agent.lock');

/* ------------------------------------------------------------------ *
 * Utilities.
 * ------------------------------------------------------------------ */

function round(n, digits = 8) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function nowIso() {
  return new Date().toISOString();
}

function sign(v) {
  return v >= 0 ? '+' : '';
}

function fmtUsd(n) {
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function fmtCompact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function log(msg) {
  const line = `[${nowIso()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch (_) { /* best effort */ }
}

function logBlock(text) {
  console.log(text);
  try { fs.appendFileSync(logFile, text + '\n'); } catch (_) { /* best effort */ }
}

/** Atomic write: write to <file>.tmp then rename over <file>. */
function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function appendLedger(trade) {
  fs.appendFileSync(tradesFile, JSON.stringify(trade) + '\n');
}

/* ------------------------------------------------------------------ *
 * Last-errors ring buffer (surfaced in heartbeat + dashboard).
 * ------------------------------------------------------------------ */

const lastErrors = [];
function pushError(tag, msg) {
  lastErrors.push({ ts: Date.now(), iso: nowIso(), tag, msg: String(msg).slice(0, 300) });
  if (lastErrors.length > 10) lastErrors.shift();
  log(`[${tag}] ${msg}`);
}

/* ------------------------------------------------------------------ *
 * Equity history (append-only, read by the dashboard API).
 * ------------------------------------------------------------------ */

let lastEquitySample = null;
let portfolio = null; // set in main()

function equityRecord() {
  return {
    ts: Date.now(),
    equitySol: portfolio.equitySol,
    cashSol: portfolio.cashSol,
    totalPnlSol: portfolio.totalPnlSol,
    pnlPct: portfolio.pnlPct
  };
}

function shouldSampleEquity() {
  if (!lastEquitySample) return true;
  const deltaEq = Math.abs(portfolio.equitySol - lastEquitySample.equitySol);
  const deltaTs = Date.now() - lastEquitySample.ts;
  return deltaEq >= EQUITY_SAMPLE_DELTA || deltaTs >= EQUITY_SAMPLE_MAX_GAP_MS;
}

function recordEquityHistory() {
  try {
    if (!shouldSampleEquity()) return;
    const rec = equityRecord();
    fs.appendFileSync(equityHistoryFile, JSON.stringify(rec) + '\n');
    lastEquitySample = rec;
  } catch (err) {
    log(`WARN could not append equity history (${err.message})`);
  }
}

/** Seed equity-history.jsonl once, only from real observed data. */
function backfillEquityHistory() {
  try {
    if (fs.existsSync(equityHistoryFile)) return;

    const rows = [];
    if (fs.existsSync(tradesFile)) {
      const lines = fs.readFileSync(tradesFile, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
      }
    }

    const seed = [];
    seed.push({
      ts: rows.length ? Date.parse(rows[0].timestamp) - 60000 : portfolio.updatedAt || Date.now(),
      equitySol: portfolio.startingCapitalSol,
      cashSol: portfolio.startingCapitalSol,
      totalPnlSol: 0,
      pnlPct: 0
    });

    let cash = portfolio.startingCapitalSol;
    let realized = 0;
    for (const t of rows) {
      if (t.side === 'BUY') cash = round(cash - t.valueSol, 8);
      else if (t.side === 'SELL') {
        cash = round(cash + t.valueSol, 8);
        realized = round(realized + (t.realizedPnlSol || 0), 8);
      } else continue;
      const ts = Date.parse(t.timestamp) || Date.now();
      seed.push({
        ts,
        equitySol: round(cash + realized, 8),
        cashSol: round(cash, 8),
        totalPnlSol: round(realized, 8),
        pnlPct: round((realized / portfolio.startingCapitalSol) * 100, 4)
      });
    }

    const now = Date.now();
    for (const rec of seed) {
      const ts = Math.min(rec.ts, now);
      fs.appendFileSync(equityHistoryFile,
        JSON.stringify({ ts, equitySol: rec.equitySol, cashSol: rec.cashSol, totalPnlSol: rec.totalPnlSol, pnlPct: rec.pnlPct }) + '\n');
    }
    log(`Seeded equity-history.jsonl from portfolio + ${rows.length} ledger record(s) (${seed.length} snapshot(s))`);
  } catch (err) {
    log(`WARN could not seed equity history (${err.message})`);
  }
}

/* ------------------------------------------------------------------ *
 * Configuration.
 * ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  scanIntervalMs: DEFAULT_MONITOR_MS,      // monitor open positions
  discoveryIntervalMs: DEFAULT_DISCOVERY_MS,
  sampleIntervalMs: DEFAULT_SAMPLE_MS,
  paperTrading: true,
  strategy: 'dip-reversal',
  tradeSizeSol: 0.05,
  startingCapitalSol: 10.0,
  // Circuit-style adaptive layer (see docs/CIRCUIT_TO_PAPER_AGENT_MAPPING.md).
  // Deterministic + data-driven. The LLM hook (llm.url) is OPTIONAL, async,
  // schema-validated and never on the scanner hot path.
  adaptive: {
    enabled: true,
    agentLoopIntervalMs: 90 * 60 * 1000,   // session policy every 90 min (upstream-verified)
    reflectIntervalMs: 4 * 3600 * 1000,    // reflection every 4h (upstream-verified)
    policyTtlMs: 90 * 60 * 1000,           // session policy TTL
    autoApply: false,                      // persistent changes require operator approval until validated
    minSamples: 8,                         // learned-gate cluster minimum (else INSUFFICIENT_DATA → V1)
    gateConfidenceThreshold: 0.85,         // only apply learned gates at this confidence (upstream default)
    minGradeSamples: 5,                    // reflection grading minimum sample
    backtestMinTrades: 5,                  // backtest minimum candidate sample
    shadowMinTrades: 5,                    // shadow evaluation minimum window sample
    wfFolds: 3,                            // walk-forward OOS folds
    wfMinTrades: 30,                       // walk-forward total purged-OOS sample to promote
    wfMinFoldTrades: 5,                    // a fold with fewer kept trades is skipped
    wfMinOosPf: 1.2,                       // every evaluated OOS fold: PF strictly above this
    wfMinOosExp: 0,                        // every evaluated OOS fold: expectancy% strictly above this
    lossBreakerThreshold: 3,               // 3 consecutive losses → watchOnly window (upstream breaker)
    dailyLossHaltPct: 3,                   // day P&L ≤ -3% vs day anchor → watchOnly rest of UTC day
    sizing: { bull: 1.0, consolidation: 1.0, recovery: 0.5, dump: 0.0 }, // NEVER > 1.0 in paper
    minTradeSizeSol: 0.0125,               // adaptive range floor
    maxTradeSizeSol: 0.05,                 // hard ceiling — original maximum, never exceeded
    minHealthScore: 60,                    // market-health gate threshold (0-100)
    llm: { url: '', key: '', model: '' }   // optional OpenAI-compatible endpoint
  },
  // TradingAgents-style multi-agent RESEARCH layer (additive + advisory).
  // OFF / SHADOW (default) / ADVISORY. It never gates or alters the Circuit
  // V1 BUY/SELL path; it records research decisions and prediction accuracy.
  tradingAgents: {
    mode: 'SHADOW',
    maxCandidatesPerCycle: 5,
    maxDebateRounds: 2,
    researchTimeoutMs: 10000,
    cacheTtlMs: 60000
  },
  // ATLAS-style multi-agent INTELLIGENCE layer (parallel, advisory, research-grade).
  // Runs beside TradingAgents and V1. Default SHADOW. ATLAS is advisory only —
  // it never authorizes execution; V1 remains authoritative. ATLAS consumes the
  // existing price-integrity verdict (never duplicates it).
  atlas: {
    mode: 'SHADOW',
    maxCandidatesPerCycle: 3,
    researchTimeoutMs: 10000,
    cacheTtlMs: 60000
  },
  // Ensemble gate over V1 + TradingAgents + ATLAS (precision over recall).
  // OFF = V1 decides alone. SHADOW (default) = evaluate 2/3 agreement on
  // every V1-pass candidate, record to ensemble-shadow.jsonl, never block.
  // ENFORCE = block entries below minAgree. Missing research verdicts count
  // as disagree (precision-first); if NEITHER research layer yields a verdict
  // scan-wide the gate degrades to V1-only (liveness over strictness).
  ensemble: {
    mode: 'SHADOW',
    minAgree: 2
  }
};

function envInt(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// Phase 18 (security hardening): JSON.parse creates an OWN property named
// `__proto__`, and Object.assign re-exposes it through the Object.prototype
// accessor ([[Set]] semantics) — a crafted config.json could otherwise
// replace cfg's prototype. Strip the danger keys before merging.
const UNSAFE_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function sanitizedConfigMerge(target, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return target;
  for (const key of Object.keys(raw)) {
    if (UNSAFE_CONFIG_KEYS.has(key)) {
      log(`WARN config key "${key}" ignored (unsafe key)`);
      continue;
    }
    const val = raw[key];
    if (val && typeof val === 'object' && !Array.isArray(val) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      sanitizedConfigMerge(target[key], val); // one nested level of defense per object
    } else {
      target[key] = val;
    }
  }
  return target;
}

function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);

  if (fs.existsSync(configFile)) {
    try {
      sanitizedConfigMerge(cfg, JSON.parse(fs.readFileSync(configFile, 'utf8')));
    } catch (err) {
      log(`WARN config.json unreadable (${err.message}) — using defaults`);
    }
  } else {
    fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    log(`Created default config at ${configFile}`);
  }

  // Safety: configuration can never switch this agent to live trading.
  if (cfg.paperTrading !== true) {
    log('WARN config has paperTrading != true — forcing paperTrading=true (live trading is disabled by design)');
  }
  cfg.paperTrading = PAPER_TRADING;

  cfg.scanIntervalMs = envInt('CIRCUIT_MONITOR_MS', Math.max(250, parseInt(cfg.scanIntervalMs, 10) || DEFAULT_MONITOR_MS));
  cfg.discoveryIntervalMs = envInt('CIRCUIT_DISCOVERY_MS', Math.max(1000, parseInt(cfg.discoveryIntervalMs, 10) || DEFAULT_DISCOVERY_MS));
  cfg.sampleIntervalMs = envInt('CIRCUIT_SAMPLE_MS', Math.max(200, parseInt(cfg.sampleIntervalMs, 10) || DEFAULT_SAMPLE_MS));

  const ts = parseFloat(cfg.tradeSizeSol);
  cfg.tradeSizeSol = Number.isFinite(ts) && ts > 0 ? round(ts, 8) : 0.05;

  const sc = parseFloat(cfg.startingCapitalSol);
  cfg.startingCapitalSol = Number.isFinite(sc) && sc > 0 ? round(sc, 8) : 10.0;

  if (cfg.strategy !== 'dip-reversal') {
    log(`WARN unknown strategy "${cfg.strategy}" — falling back to "dip-reversal"`);
    cfg.strategy = 'dip-reversal';
  }

  // ---- Adaptive layer config (deterministic; env knobs override) ----------
  const defAdapt = DEFAULT_CONFIG.adaptive;
  const ad = Object.assign({}, defAdapt, cfg.adaptive && typeof cfg.adaptive === 'object' ? cfg.adaptive : {});
  ad.enabled = process.env.CIRCUIT_ADAPTIVE_DISABLE === '1' ? false : ad.enabled !== false;
  ad.agentLoopIntervalMs = envInt('CIRCUIT_AGENT_LOOP_MS', Math.max(2000, parseInt(ad.agentLoopIntervalMs, 10) || defAdapt.agentLoopIntervalMs));
  ad.reflectIntervalMs = envInt('CIRCUIT_REFLECT_MS', Math.max(2000, parseInt(ad.reflectIntervalMs, 10) || defAdapt.reflectIntervalMs));
  ad.policyTtlMs = envInt('CIRCUIT_POLICY_TTL_MS', Math.max(2000, parseInt(ad.policyTtlMs, 10) || defAdapt.policyTtlMs));
  ad.autoApply = ad.autoApply === true;
  ad.minSamples = Math.max(3, parseInt(ad.minSamples, 10) || defAdapt.minSamples);
  ad.gateConfidenceThreshold = Math.max(0, Math.min(1, parseFloat(ad.gateConfidenceThreshold) || defAdapt.gateConfidenceThreshold));
  ad.minGradeSamples = Math.max(2, parseInt(ad.minGradeSamples, 10) || defAdapt.minGradeSamples);
  ad.backtestMinTrades = Math.max(2, parseInt(ad.backtestMinTrades, 10) || defAdapt.backtestMinTrades);
  ad.shadowMinTrades = Math.max(2, parseInt(ad.shadowMinTrades, 10) || defAdapt.shadowMinTrades);
  ad.wfFolds = Math.max(2, Math.min(5, parseInt(ad.wfFolds, 10) || defAdapt.wfFolds));
  ad.wfMinTrades = Math.max(2, parseInt(ad.wfMinTrades, 10) || defAdapt.wfMinTrades);
  ad.wfMinFoldTrades = Math.max(1, parseInt(ad.wfMinFoldTrades, 10) || defAdapt.wfMinFoldTrades);
  ad.wfMinOosPf = Number.isFinite(parseFloat(ad.wfMinOosPf)) ? Math.max(0, parseFloat(ad.wfMinOosPf)) : defAdapt.wfMinOosPf;
  ad.wfMinOosExp = Number.isFinite(parseFloat(ad.wfMinOosExp)) ? parseFloat(ad.wfMinOosExp) : defAdapt.wfMinOosExp;
  ad.lossBreakerThreshold = Math.max(2, parseInt(ad.lossBreakerThreshold, 10) || defAdapt.lossBreakerThreshold);
  const sizing = ad.sizing && typeof ad.sizing === 'object' ? ad.sizing : {};
  ad.sizing = {
    bull: Math.max(0, Math.min(1, parseFloat(sizing.bull) || defAdapt.sizing.bull)),
    consolidation: Math.max(0, Math.min(1, parseFloat(sizing.consolidation) || defAdapt.sizing.consolidation)),
    recovery: Math.max(0, Math.min(1, parseFloat(sizing.recovery) || defAdapt.sizing.recovery)),
    dump: Math.max(0, Math.min(1, parseFloat(sizing.dump) || defAdapt.sizing.dump))
  };
  const minSize = parseFloat(ad.minTradeSizeSol);
  ad.minTradeSizeSol = Number.isFinite(minSize) && minSize > 0 ? Math.min(minSize, 0.05) : defAdapt.minTradeSizeSol;
  const maxSize = parseFloat(ad.maxTradeSizeSol);
  ad.maxTradeSizeSol = Number.isFinite(maxSize) && maxSize > 0 ? Math.min(maxSize, 0.05) : defAdapt.maxTradeSizeSol; // hard ceiling 0.05
  if (ad.maxTradeSizeSol < ad.minTradeSizeSol) ad.minTradeSizeSol = ad.maxTradeSizeSol;
  ad.minHealthScore = Math.max(0, Math.min(100, parseInt(ad.minHealthScore, 10) || defAdapt.minHealthScore));
  ad.dailyLossHaltPct = Number.isFinite(parseFloat(ad.dailyLossHaltPct)) ? Math.max(0, parseFloat(ad.dailyLossHaltPct)) : defAdapt.dailyLossHaltPct;
  ad.llm = Object.assign({ url: '', key: '', model: '' }, ad.llm && typeof ad.llm === 'object' ? ad.llm : {}, {
    url: process.env.CIRCUIT_LLM_URL || (ad.llm && ad.llm.url) || '',
    key: process.env.CIRCUIT_LLM_KEY || (ad.llm && ad.llm.key) || '',
    model: process.env.CIRCUIT_LLM_MODEL || (ad.llm && ad.llm.model) || ''
  });
  cfg.adaptive = ad;

  // ---- TradingAgents research layer config (advisory; default SHADOW) ------
  const defTA = DEFAULT_CONFIG.tradingAgents;
  const taCfg = Object.assign({}, defTA,
    cfg.tradingAgents && typeof cfg.tradingAgents === 'object' ? cfg.tradingAgents : {});
  const TA_MODES = ['OFF', 'SHADOW', 'ADVISORY'];
  const envTaMode = String(process.env.CIRCUIT_TA_MODE || '').toUpperCase();
  taCfg.mode = TA_MODES.includes(envTaMode) ? envTaMode
    : (TA_MODES.includes(String(taCfg.mode).toUpperCase()) ? String(taCfg.mode).toUpperCase() : 'SHADOW');
  taCfg.maxCandidatesPerCycle = Math.min(20, envInt('CIRCUIT_TA_MAX_CANDIDATES', Math.max(1, parseInt(taCfg.maxCandidatesPerCycle, 10) || defTA.maxCandidatesPerCycle)));
  taCfg.maxDebateRounds = Math.min(10, envInt('CIRCUIT_TA_DEBATE_ROUNDS', Math.max(0, parseInt(taCfg.maxDebateRounds, 10) || defTA.maxDebateRounds)));
  taCfg.researchTimeoutMs = envInt('CIRCUIT_TA_TIMEOUT_MS', Math.max(1000, parseInt(taCfg.researchTimeoutMs, 10) || defTA.researchTimeoutMs));
  taCfg.cacheTtlMs = envInt('CIRCUIT_TA_CACHE_TTL_MS', Math.max(0, parseInt(taCfg.cacheTtlMs, 10) || defTA.cacheTtlMs));
  cfg.tradingAgents = taCfg;

  // ---- ATLAS intelligence layer config (parallel, advisory; default SHADOW) ----
  const defAtlas = DEFAULT_CONFIG.atlas || {};
  const atlasCfg = Object.assign({}, defAtlas,
    cfg.atlas && typeof cfg.atlas === 'object' ? cfg.atlas : {});
  const ATLAS_MODES = ['OFF', 'SHADOW', 'ADVISORY'];
  const envAtlasMode = String(process.env.CIRCUIT_ATLAS_MODE || '').toUpperCase();
  atlasCfg.mode = ATLAS_MODES.includes(envAtlasMode) ? envAtlasMode
    : (ATLAS_MODES.includes(String(atlasCfg.mode).toUpperCase()) ? String(atlasCfg.mode).toUpperCase() : 'SHADOW');
  atlasCfg.maxCandidatesPerCycle = Math.min(10, envInt('CIRCUIT_ATLAS_MAX_CANDIDATES', Math.max(1, parseInt(atlasCfg.maxCandidatesPerCycle, 10) || defAtlas.maxCandidatesPerCycle || 3)));
  atlasCfg.researchTimeoutMs = envInt('CIRCUIT_ATLAS_TIMEOUT_MS', Math.max(1000, parseInt(atlasCfg.researchTimeoutMs, 10) || defAtlas.researchTimeoutMs || 10000));
  atlasCfg.cacheTtlMs = envInt('CIRCUIT_ATLAS_CACHE_TTL_MS', Math.max(0, parseInt(atlasCfg.cacheTtlMs, 10) || defAtlas.cacheTtlMs || 60000));
  cfg.atlas = atlasCfg;

  // ---- Ensemble gate config (default SHADOW: record, never block) ---------
  const defEns = DEFAULT_CONFIG.ensemble || { mode: 'SHADOW', minAgree: 2 };
  const ensCfg = Object.assign({}, defEns,
    cfg.ensemble && typeof cfg.ensemble === 'object' ? cfg.ensemble : {});
  const ENS_MODES = ['OFF', 'SHADOW', 'ENFORCE'];
  const envEnsMode = String(process.env.CIRCUIT_ENSEMBLE_MODE || '').toUpperCase();
  ensCfg.mode = ENS_MODES.includes(envEnsMode) ? envEnsMode
    : (ENS_MODES.includes(String(ensCfg.mode).toUpperCase()) ? String(ensCfg.mode).toUpperCase() : 'SHADOW');
  const ensAgree = parseInt(ensCfg.minAgree, 10);
  ensCfg.minAgree = Number.isFinite(ensAgree) ? Math.max(1, Math.min(3, ensAgree)) : 2;
  cfg.ensemble = ensCfg;

  return cfg;
}

/* ------------------------------------------------------------------ *
 * Portfolio persistence + restart recovery.
 * ------------------------------------------------------------------ */

function newPortfolio(startingCapitalSol) {
  return {
    name: AGENT_NAME,
    mode: MODE,
    startingCapitalSol,
    cashSol: startingCapitalSol,
    investedSol: 0,
    marketValueSol: 0,
    equitySol: startingCapitalSol,
    realizedPnlSol: 0,
    unrealizedPnlSol: 0,
    totalPnlSol: 0,
    pnlPct: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    avgWinSol: 0,
    avgLossSol: 0,
    bestTradeSol: 0,
    worstTradeSol: 0,
    sumWinSol: 0,
    sumLossSol: 0,
    nextTradeId: 1,
    scans: 0,
    lastScanAt: null,
    positions: [],
    cooldowns: {},      // mint -> timestamp until which re-entry is blocked
    dayAnchorSol: startingCapitalSol, // equity at first sighting of the current UTC day
    dayAnchorDate: null,               // 'YYYY-MM-DD'; reset rolls the anchor (daily halt lifts)
    updatedAt: Date.now()
  };
}

/** Close any legacy position that has no real mint (e.g. old simulated
 *  TKN positions). Realizes its last known value and frees capacity. */
function migrateLegacyPositions(p) {
  const legacy = p.positions.filter((pos) => !marketDataLib.isValidSolanaAddress(pos.mint));
  if (!legacy.length) return;
  for (const pos of legacy) {
    const exitPrice = pos.currentPriceSol || pos.currentPrice || 0;
    p.cashSol = round(p.cashSol + (pos.quantity || 0) * exitPrice, 8);
    p.positions = p.positions.filter((x) => x !== pos);
    log(`[PORTFOLIO] closed legacy position ${pos.symbol} (no real mint) at ${exitPrice} — realized into cash`);
  }
  log(`[PORTFOLIO] migrated ${legacy.length} legacy position(s) — account continues with ${p.positions.length} real position(s)`);
}

/** Backfill partial/breakeven/runner fields on pre-partials positions
 *  (restart-safe: V1 behavior preserved — full SL/TP, no partial taken). */
function migratePartialFields(p) {
  if (!p || !Array.isArray(p.positions)) return;
  for (const pos of p.positions) {
    if (!pos || typeof pos !== 'object') continue;
    if (pos.partialTaken === undefined) pos.partialTaken = false;
    if (!Number.isFinite(pos.stopLossPct)) pos.stopLossPct = STOP_LOSS_PCT;
    if (!Number.isFinite(pos.takeProfitPct)) pos.takeProfitPct = TAKE_PROFIT_PCT;
    if (!(pos.atrNatr == null || Number.isFinite(pos.atrNatr))) pos.atrNatr = null;
    if (pos.atrNatr === undefined) pos.atrNatr = null;
    if (!Number.isFinite(pos.entryCostSol)) pos.entryCostSol = Number.isFinite(pos.costSol) ? pos.costSol : 0;
    if (!Number.isFinite(pos.realizedPartialSol)) pos.realizedPartialSol = 0;
  }
}

function loadPortfolio() {
  if (fs.existsSync(portfolioFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(portfolioFile, 'utf8'));
      if (!p || typeof p !== 'object' ||
          !Number.isFinite(p.cashSol) || !Number.isFinite(p.startingCapitalSol)) {
        throw new Error('invalid portfolio.json');
      }
      const base = newPortfolio(p.startingCapitalSol);
      for (const key of Object.keys(base)) {
        if (p[key] === undefined) p[key] = base[key];
      }
      p.positions = Array.isArray(p.positions) ? p.positions : [];
      p.cooldowns = p.cooldowns && typeof p.cooldowns === 'object' ? p.cooldowns : {};
      migrateLegacyPositions(p);
      migratePartialFields(p);
      log(`Loaded existing paper portfolio: cash=${p.cashSol} SOL, ${p.positions.length} open position(s), ` +
        `realized P&L=${p.realizedPnlSol} SOL, total P&L=${p.totalPnlSol} SOL`);
      return p;
    } catch (err) {
      const backup = portfolioFile + '.corrupt-' + Date.now();
      try { fs.renameSync(portfolioFile, backup); } catch (_) { /* ignore */ }
      log(`ERROR portfolio.json unreadable (${err.message}) — backed up to ${backup} and re-initializing`);
    }
  }
  const p = newPortfolio(config.startingCapitalSol);
  log(`Initialized new paper account: starting capital ${p.startingCapitalSol} SOL`);
  return p;
}

/* ------------------------------------------------------------------ *
 * Accounting.
 * ------------------------------------------------------------------ */

function recalculate(p) {
  let invested = 0;
  let marketValue = 0;
  for (const pos of p.positions) {
    pos.marketValueSol = round(pos.quantity * pos.currentPriceSol, 8);
    pos.unrealizedPnlSol = round(pos.marketValueSol - pos.costSol, 8);
    pos.unrealizedPnlPct = pos.costSol > 0
      ? round(((pos.marketValueSol - pos.costSol) / pos.costSol) * 100, 4)
      : 0;
    invested += pos.costSol;
    marketValue += pos.marketValueSol;
  }
  p.investedSol = round(invested, 8);
  p.marketValueSol = round(marketValue, 8);
  p.cashSol = round(p.cashSol, 8);
  p.equitySol = round(p.cashSol + p.marketValueSol, 8);
  p.totalPnlSol = round(p.equitySol - p.startingCapitalSol, 8);
  p.pnlPct = p.startingCapitalSol > 0 ? round((p.totalPnlSol / p.startingCapitalSol) * 100, 4) : 0;
  p.unrealizedPnlSol = round(p.marketValueSol - p.investedSol, 8);
  p.winRate = p.totalTrades > 0 ? round((p.winningTrades / p.totalTrades) * 100, 2) : 0;
  p.avgWinSol = p.winningTrades > 0 ? round(p.sumWinSol / p.winningTrades, 8) : 0;
  p.avgLossSol = p.losingTrades > 0 ? round(p.sumLossSol / p.losingTrades, 8) : 0;
  p.updatedAt = Date.now();
}

function persist() {
  atomicWriteJson(portfolioFile, portfolio);
}

function writeHeartbeat(state) {
  const priceSources = (market && typeof market.priceSources === 'function')
    ? market.priceSources().map((s) => ({
        name: s.name,
        role: s.role || 'primary',
        status: s.lastError ? 'error' : (s.lastOkAt ? 'ok' : 'unknown'),
        lastOkAt: s.lastOkAt || null,
        lastError: s.lastError || null
      }))
    : [];
  atomicWriteJson(heartbeatFile, {
    state,
    name: AGENT_NAME,
    paper: PAPER_TRADING,
    custody: CUSTODY,
    startedAt: BOOT_TIME,
    startedAtIso: new Date(BOOT_TIME).toISOString(),
    uptimeSec: Math.max(0, Math.round((Date.now() - BOOT_TIME) / 1000)),
    lastScanAt: portfolio.lastScanAt || null,
    scans: portfolio.scans,
    market: MARKET_LABEL,
    execution: EXECUTION_LABEL,
    wallet: WALLET_STATE,
    signer: SIGNER_STATE,
    broadcast: BROADCAST_STATE,
    maxPositions: MAX_POSITIONS,
    openPositions: portfolio.positions.length,
    solPriceUsd: lastSolPriceUsd,
    priceSources,
    lastErrors: lastErrors.slice(-5),
    startingCapitalSol: portfolio.startingCapitalSol,
    cashSol: portfolio.cashSol,
    investedSol: portfolio.investedSol,
    equitySol: portfolio.equitySol,
    realizedPnlSol: portfolio.realizedPnlSol,
    unrealizedPnlSol: portfolio.unrealizedPnlSol,
    totalPnlSol: portfolio.totalPnlSol,
    pnlPct: portfolio.pnlPct,
    totalTrades: portfolio.totalTrades,
    winningTrades: portfolio.winningTrades,
    losingTrades: portfolio.losingTrades,
    winRate: portfolio.winRate,
    positions: portfolio.positions.map((pos) => ({
      symbol: pos.symbol,
      mint: pos.mint,
      quantity: pos.quantity,
      entryPriceSol: pos.entryPriceSol,
      entryPriceUsd: pos.entryPriceUsd,
      currentPriceSol: pos.currentPriceSol,
      currentPriceUsd: pos.currentPriceUsd,
      costSol: pos.costSol,
      marketValueSol: pos.marketValueSol,
      unrealizedPnlSol: pos.unrealizedPnlSol,
      unrealizedPnlPct: pos.unrealizedPnlPct,
      priceSource: pos.priceSource,
      pairAddress: pos.pairAddress || null,
      dex: pos.dex || null,
      openedAt: pos.openedAt,
      partialTaken: !!pos.partialTaken,
      stopLossPct: Number.isFinite(pos.stopLossPct) ? pos.stopLossPct : STOP_LOSS_PCT,
      takeProfitPct: Number.isFinite(pos.takeProfitPct) ? pos.takeProfitPct : TAKE_PROFIT_PCT,
      atrNatr: Number.isFinite(pos.atrNatr) ? pos.atrNatr : null
    })),
    integrity: priceIntegrity ? integrityHeartbeatBlock() : null,
    tradingAgents: tradingAgents ? tradingAgentsHeartbeatBlock() : null,
    tradingAgentsValidation: tradingAgents ? tradingAgentsValidationHeartbeatBlock() : null,
    atlas: atlas ? atlasHeartbeatBlock() : null,
    adaptive: adaptiveState && config.adaptive && config.adaptive.enabled ? adaptiveHeartbeatBlock() : {
      enabled: false
    },
    updatedAt: portfolio.updatedAt
  });
}

/** Price-integrity summary embedded in the heartbeat (dashboard reads it). */
function integrityHeartbeatBlock() {
  try {
    return priceIntegrity ? priceIntegrity.snapshot() : null;
  } catch (err) {
    log(`WARN integrity heartbeat block failed (${err.message})`);
    return null;
  }
}

/** TradingAgents summary embedded in the heartbeat (dashboard reads it). */
function tradingAgentsHeartbeatBlock() {
  try {
    return tradingAgents ? tradingAgents.snapshot() : null;
  } catch (err) {
    log(`WARN tradingAgents heartbeat block failed (${err.message})`);
    return null;
  }
}

/** TradingAgents validation summary embedded in the heartbeat (dashboard reads it). */
function tradingAgentsValidationHeartbeatBlock() {
  try {
    if (!tradingAgents) return null;
    const cf = tradingAgents.getCounterfactual();
    if (!cf || typeof cf.snapshot !== 'function') return null;
    return cf.snapshot();
  } catch (err) {
    log(`WARN tradingAgentsValidation heartbeat block failed (${err.message})`);
    return null;
  }
}

/** ATLAS summary embedded in the heartbeat (dashboard reads it). */
function atlasHeartbeatBlock() {
  try {
    return atlas ? atlas.snapshot() : null;
  } catch (err) {
    log(`WARN atlas heartbeat block failed (${err.message})`);
    return null;
  }
}

/** Adaptive summary embedded in the heartbeat (dashboard reads it). */
function adaptiveHeartbeatBlock() {
  const p = adaptiveState.policy;
  const regime = currentRegime();
  const versions = experiments.loadVersions(dataDir, { maxPositions: MAX_POSITIONS });
  const gates = gatesLib.gateSummary(adaptiveState.gates);
  return {
    enabled: true,
    strategyVersion: p ? p.strategyVersion : 'V1',
    mode: p ? p.mode : 'active',
    minScore: p ? p.minScore : 60,
    maxBuys: p ? p.maxBuys : MAX_POSITIONS,
    buysThisSession: p ? p.buysThisSession || 0 : 0,
    dayPnlPct: computeDayPnl(portfolio),
    dayAnchorDate: portfolio ? portfolio.dayAnchorDate || null : null,
    regime: regime.regime,
    regimeConfidence: regime.confidence || 0,
    regimeReasoning: regime.reasoning || '',
    reason: p ? p.reason : '',
    sizeMultiplier: p && p.sizeMultiplier != null ? p.sizeMultiplier : 1.0,
    source: p ? p.source : 'deterministic',
    expiresAt: p ? p.expiresAt : null,
    lastAgentLoopAt: adaptiveState.lastAgentLoopAt,
    nextAgentLoopAt: adaptiveState.lastAgentLoopAt ? adaptiveState.lastAgentLoopAt + config.adaptive.agentLoopIntervalMs : null,
    lastReflectionAt: adaptiveState.lastReflectionAt,
    nextReflectionAt: adaptiveState.lastReflectionAt ? adaptiveState.lastReflectionAt + config.adaptive.reflectIntervalMs : null,
    marketHealth: adaptiveState.health ? {
      score: adaptiveState.health.score,
      status: adaptiveState.health.status,
      gate: adaptiveState.health.gate,
      reason: adaptiveState.health.reason
    } : null,
    gates: gates,
    versions: { current: versions.current },
    bandit: banditHeartbeatBlock(),
    experimentsSummary: experiments.summary(dataDir, { maxPositions: MAX_POSITIONS })
  };
}

/** Bandit summary embedded in the heartbeat (dashboard reads it). */
function banditHeartbeatBlock() {
  try {
    const arms = adaptiveState.banditArms || {};
    const keys = Object.keys(arms);
    const list = keys.slice(0, 20).map((k) => ({ cluster: k, arm: arms[k] && arms[k].arm, n: arms[k] && arms[k].clusterN }));
    return {
      live: banditLiveActive(),
      clusters: keys.length,
      truncated: keys.length > list.length,
      arms: list
    };
  } catch (_) {
    return { live: false, clusters: 0, truncated: false, arms: [] };
  }
}

function writeMeta() {
  let createdAt = nowIso();
  if (fs.existsSync(metaFile)) {
    try {
      createdAt = JSON.parse(fs.readFileSync(metaFile, 'utf8')).createdAt || createdAt;
    } catch (_) { /* keep now */ }
  }
  atomicWriteJson(metaFile, {
    name: AGENT_NAME,
    mode: MODE,
    paper: PAPER_TRADING,
    custody: CUSTODY,
    createdAt,
    signerUrl: null, // never used — this agent never signs anything
    wallet: null     // never created — nothing to fund
  });
}

/* ------------------------------------------------------------------ *
 * Process lock — one agent per data dir.
 * ------------------------------------------------------------------ */

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // exists but not ours to signal
  }
}

function agentProvenance() {
  let gitCommit = null;
  try {
    gitCommit = require('child_process')
      .execSync('git rev-parse --short HEAD 2>/dev/null', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
      .toString().trim() || null;
  } catch (_) { gitCommit = null; } // not a git checkout — fine
  return {
    pid: process.pid,
    hostname: os.hostname(),
    processStartMs: Date.now() - Math.round(process.uptime() * 1000),
    sourceDir: __dirname,
    agentVersion: AGENT_VERSION,
    strategyVersion: 'V1',
    gitCommit,
    nodeVersion: process.version,
    startedAt: Date.now(),
    startedAtIso: nowIso(),
    paperTrading: PAPER_TRADING === true,
    wallet: false,
    signer: false,
    broadcast: false
  };
}

/**
 * Stable build identity — two DIFFERENT builds must never share a data dir.
 * Source directory + version + (git commit when available) is sufficient:
 * an older/parallel build in another directory cannot reproduce it.
 */
function buildIdentity() {
  const p = agentProvenance();
  return `${p.sourceDir}|${p.agentVersion}|${p.gitCommit || 'nogit'}`;
}

function acquireLock() {
  const myIdentity = buildIdentity();
  if (fs.existsSync(lockFile)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock && pidAlive(lock.pid)) {
        log(`ERROR another agent instance is already running (pid ${lock.pid}, started ${new Date(lock.startedAt).toISOString()}) — exiting`);
        console.error(`agent.lock held by pid ${lock.pid} — refusing to start a second copy`);
        process.exit(1);
      }
      // Fail-closed provenance check: a live process with a DIFFERENT build
      // identity (e.g. an older/parallel build in another directory) also owns
      // this data dir via its own pidfile/lease. Verify against every known
      // provenance artifact before taking over.
      if (lock && lock.buildIdentity && lock.buildIdentity !== myIdentity) {
        log(`ERROR agent.lock belongs to a DIFFERENT build (identity=${String(lock.buildIdentity).slice(0, 120)}) — refusing to share the data directory`);
        console.error('agent.lock: foreign build identity — refusing to start (two incompatible builds must never write the same data dir)');
        process.exit(1);
      }
      const pidFile = path.join(dataDir, 'agent.pid');
      if (fs.existsSync(pidFile)) {
        try {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
          if (Number.isInteger(pid) && pidAlive(pid) && pid !== process.pid) {
            log(`ERROR live agent.pid ${pid} exists but does not match agent.lock — a foreign/legacy build may be writing this data directory — exiting`);
            console.error(`agent.pid ${pid} is live — refusing to start (provenance conflict)`);
            process.exit(1);
          }
        } catch (_) { /* unreadable pid file → ignore */ }
      }
      log(`Stale agent.lock (pid ${lock && lock.pid} not running) — taking over`);
    } catch (_) { /* corrupt lock → take over */ }
  }
  const provenance = agentProvenance();
  atomicWriteJson(lockFile, Object.assign({}, provenance, { buildIdentity: myIdentity }));
  try { fs.writeFileSync(path.join(dataDir, 'agent.pid'), String(process.pid)); } catch (_) { /* best effort */ }
  log(`[LOCK] provenance: pid=${provenance.pid} host=${provenance.hostname} src=${provenance.sourceDir} version=${provenance.agentVersion}` +
    ` git=${provenance.gitCommit || 'nogit'} node=${provenance.nodeVersion} paper=${provenance.paperTrading} wallet/signer/broadcast=false/false/false`);
}

function releaseLock() {
  try {
    if (fs.existsSync(lockFile)) {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock && lock.pid === process.pid) fs.unlinkSync(lockFile);
    }
  } catch (_) { /* best effort */ }
  try {
    const pidFile = path.join(dataDir, 'agent.pid');
    if (fs.existsSync(pidFile) && parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) === process.pid) fs.unlinkSync(pidFile);
  } catch (_) { /* best effort */ }
}

/* ------------------------------------------------------------------ *
 * Trade execution (PAPER ONLY — no wallet, no signer, no broadcast).
 * ------------------------------------------------------------------ */

function executePaperBuy(cand, priceInfo) {
  if (portfolio.positions.length >= MAX_POSITIONS) return false;
  // Adaptive paper size: base × regime multiplier × market-health multiplier
  // × volatility multiplier, clamped to the hard range
  // [adaptive.minTradeSizeSol, adaptive.maxTradeSizeSol].
  // maxTradeSizeSol is a hard ceiling (default 0.05 SOL) — never exceeded. In
  // V1/default conditions all multipliers are 1.0, so the size is unchanged,
  // and with the adaptive layer disabled the V1 size is used exactly.
  // Volatility sizing: size = base × (targetVol / NATR) — calm markets keep
  // full size, hot markets shrink. Unknown NATR fails open (1.0×).
  const baseSize = round(config.tradeSizeSol, 8);
  let cost;
  let regimeMult = 1.0;
  let healthMult = 1.0;
  let volMult = 1.0;
  if (!adaptiveEnabled()) {
    cost = baseSize;
  } else {
    regimeMult = adaptiveState.policy && adaptiveState.policy.sizeMultiplier != null
      ? adaptiveState.policy.sizeMultiplier : 1.0;
    healthMult = adaptiveState.health && adaptiveState.health.sizeMultiplier != null
      ? adaptiveState.health.sizeMultiplier : 1.0;
    volMult = computeEntrySize(1, cand.natr).volMult;
    const rawSize = baseSize * regimeMult * healthMult * volMult;
    cost = round(
      Math.min(config.adaptive.maxTradeSizeSol, Math.max(config.adaptive.minTradeSizeSol, rawSize)), 8);
  }
  if (portfolio.cashSol < cost) {
    log(`[FILTER] ${cand.symbol} insufficient cash (${portfolio.cashSol.toFixed(4)} SOL)`);
    return false;
  }
  const quantity = round(cost / priceInfo.priceSol, 8);
  if (!(quantity > 0)) {
    log(`[FILTER] ${cand.symbol} quantity <= 0 (price ${priceInfo.priceSol}) — skipping`);
    return false;
  }

  portfolio.cashSol = round(portfolio.cashSol - cost, 8);

  // Exit levels: ATR-sized from the candidate's trailing NATR when available
  // (SL=1.5×NATR, TP=2.5×NATR), else fixed V1 -6%/+8%. The monitor reads these
  // per-position fields, so no per-poll recompute (stops never wiggle).
  let armedSL = STOP_LOSS_PCT;
  let armedTP = TAKE_PROFIT_PCT;
  let armedNatr = null;
  if (atrEnabled && Number.isFinite(cand.natr)) {
    const lv = atrLevels(cand.natr);
    armedSL = lv.slPct;
    armedTP = lv.tpPct;
    armedNatr = round(cand.natr, 2);
  }

  const position = {
    symbol: cand.symbol,
    mint: cand.mint,
    quantity,
    entryPriceSol: round(priceInfo.priceSol, 12),
    entryPriceUsd: round(priceInfo.priceUsd, 12),
    currentPriceSol: round(priceInfo.priceSol, 12),
    currentPriceUsd: round(priceInfo.priceUsd, 12),
    costSol: cost,
    marketValueSol: cost,
    unrealizedPnlSol: 0,
    unrealizedPnlPct: 0,
    priceSource: priceInfo.source,
    // Price identity preserved from entry (see price-integrity.js) — the
    // position keeps the exact pool/source/prices it was opened on.
    pairAddress: priceInfo.pairAddress || null,
    dex: priceInfo.dex || null,
    fetchedAt: priceInfo.timestamp || null,
    priceAgeMs: Number.isFinite(priceInfo.ageMs) ? priceInfo.ageMs : null,
    openedAt: nowIso(),
    entryScore: cand.score,
    entryChange1hPct: cand.change1hPct,
    entry5mRecoveryPct: cand.recoveryPct,
    // Pool-depth baseline for the liquidity-rug kill (gap-kill skips the liq
    // leg when either side is missing — price gap still applies).
    entryLiquidityUsd: Number.isFinite(Number(cand.liquidityUsd)) ? Number(cand.liquidityUsd) : null,
    entryVolume24hUsd: Number.isFinite(Number(cand.volume24hUsd)) ? Number(cand.volume24hUsd) : null,
    // Partial/breakeven/runner state (per-position SL/TP start at the armed
    // ATR or V1 levels; the partial leg raises SL→breakeven and, on the fixed
    // path only, TP→runner — ATR runners keep their sized 2.5×NATR target).
    partialTaken: false,
    stopLossPct: armedSL,
    takeProfitPct: armedTP,
    atrNatr: armedNatr,
    entryCostSol: cost,
    realizedPartialSol: 0
  };
  portfolio.positions.push(position);

  // Anchor the entry identity (pair/source/prices) in the integrity layer so
  // monitoring compares every later observation against the entry baseline.
  if (priceIntegrity) {
    try { priceIntegrity.notePositionOpened(position); } catch (_) { /* diagnostics never block a trade */ }
  }

  recalculate(portfolio);
  // Durability order matters: the portfolio (source of truth) is persisted
  // BEFORE the ledger row is appended, so a crash mid-trade can never leave a
  // position in the ledger that is not in the portfolio (which would let a
  // sold position resurrect on restart). The worst case is a lost ledger row,
  // never corrupted accounting.
  persist();

  appendLedger({
    id: portfolio.nextTradeId++,
    timestamp: nowIso(),
    side: 'BUY',
    symbol: cand.symbol,
    mint: cand.mint,
    pairAddress: priceInfo.pairAddress || null,
    dex: priceInfo.dex || null,
    quantity,
    price: round(priceInfo.priceSol, 12),
    priceUsd: round(priceInfo.priceUsd, 12),
    valueSol: cost,
    realizedPnlSol: 0,
    realizedPnlPct: 0,
    source: priceInfo.source,
    score: cand.score,
    change1hPct: cand.change1hPct,
    recovery5mPct: cand.recoveryPct,
    liquidityUsd: cand.liquidityUsd,
    volume24hUsd: cand.volume24hUsd,
    natr: armedNatr,
    stopLossPct: armedSL,
    takeProfitPct: armedTP,
    txBuys: Number.isFinite(Number(cand.txBuys)) ? Number(cand.txBuys) : null,
    txSells: Number.isFinite(Number(cand.txSells)) ? Number(cand.txSells) : null,
    fdvUsd: Number.isFinite(Number(cand.fdvUsd)) ? Number(cand.fdvUsd) : null,
    marketCapUsd: Number.isFinite(Number(cand.marketCapUsd)) ? Number(cand.marketCapUsd) : null,
    rsi: cand.rsi && cand.rsi.rsi != null ? cand.rsi.rsi : null,
    vwapDistPct: cand.rsi && cand.rsi.vwapDistPct != null ? cand.rsi.vwapDistPct : null,
    pWin: Number.isFinite(Number(cand.pWin)) ? Number(cand.pWin) : null,
    ensembleAgrees: cand.ensemble && Number.isFinite(cand.ensemble.agrees) ? cand.ensemble.agrees : null,
    ensembleVotes: cand.ensemble && Array.isArray(cand.ensemble.votes) ? cand.ensemble.votes.join('+') : null,
    entryMinScore: Number.isFinite(Number(cand.banditArm)) ? Number(cand.banditArm) : null,
    regime: adaptiveState.regimeState ? adaptiveState.regimeState.regime : null,
    policyMode: adaptiveState.policy ? adaptiveState.policy.mode : null,
    sizeMultiplier: regimeMult,
    adaptiveSizeSol: cost
  });

  // Session buy counter (durable, in-memory atomic — upstream agent-loop pattern).
  try { adaptivePolicy.incrementSessionBuy(dataDir); } catch (_) { /* best effort */ }

  logBlock(
`[PAPER BUY] ${cand.symbol}
Mint: ${cand.mint}
Price: ${fmtUsd(priceInfo.priceUsd)}
Price SOL: ${priceInfo.priceSol.toFixed(12)}
Size: ${cost.toFixed(5)} SOL${volMult !== 1 ? ` (vol×${volMult})` : ''}
Source: ${priceInfo.source}
1h Change: ${sign(cand.change1hPct)}${cand.change1hPct.toFixed(2)}%
5m Recovery: ${sign(cand.recoveryPct)}${cand.recoveryPct.toFixed(2)}%
Score: ${cand.score}
Stops: SL ${armedSL}% / TP +${armedTP}%${armedNatr != null ? ` (ATR NATR ${armedNatr}%)` : ' (fixed V1)'}
Cash: ${portfolio.cashSol.toFixed(5)} SOL
Equity: ${portfolio.equitySol.toFixed(5)} SOL`);
  return true;
}

function executePaperSell(position, priceInfo, reason) {
  const exitValue = round(position.quantity * priceInfo.priceSol, 8);
  const legRealized = round(exitValue - position.costSol, 8);
  const legRealizedPct = position.costSol > 0 ? round((legRealized / position.costSol) * 100, 4) : 0;
  // Combined trade economics: banked partial profit + this closing leg, over
  // the ORIGINAL entry cost. Without partials this is identical to the leg.
  const banked = Number.isFinite(position.realizedPartialSol) ? position.realizedPartialSol : 0;
  const origCost = Number.isFinite(position.entryCostSol) && position.entryCostSol > 0
    ? position.entryCostSol : position.costSol;
  const tradeRealized = round(banked + legRealized, 8);
  const tradeRealizedPct = origCost > 0 ? round((tradeRealized / origCost) * 100, 4) : 0;

  portfolio.cashSol = round(portfolio.cashSol + exitValue, 8);
  portfolio.realizedPnlSol = round(portfolio.realizedPnlSol + legRealized, 8);
  portfolio.totalTrades += 1;

  if (tradeRealized > 0) {
    portfolio.winningTrades += 1;
    portfolio.sumWinSol = round(portfolio.sumWinSol + tradeRealized, 8);
  } else if (tradeRealized < 0) {
    portfolio.losingTrades += 1;
    portfolio.sumLossSol = round(portfolio.sumLossSol + tradeRealized, 8);
  }
  portfolio.bestTradeSol = Math.max(portfolio.bestTradeSol, tradeRealized);
  portfolio.worstTradeSol = Math.min(portfolio.worstTradeSol, tradeRealized);

  // Re-entry cooldown (persisted with the portfolio — survives restarts).
  portfolio.cooldowns[position.mint] = Date.now() + cooldownMs;

  portfolio.positions = portfolio.positions.filter((p) => p !== position);

  recalculate(portfolio);
  // Persist the portfolio BEFORE the ledger row (see executePaperBuy). The
  // portfolio is the source of truth; the ledger must never lead it.
  persist();

  appendLedger({
    id: portfolio.nextTradeId++,
    timestamp: nowIso(),
    side: 'SELL',
    symbol: position.symbol,
    mint: position.mint,
    pairAddress: position.pairAddress || null,
    dex: position.dex || null,
    quantity: position.quantity,
    price: round(priceInfo.priceSol, 12),
    priceUsd: round(priceInfo.priceUsd, 12),
    valueSol: exitValue,
    realizedPnlSol: legRealized,
    realizedPnlPct: legRealizedPct,
    entryPriceSol: position.entryPriceSol,
    costSol: position.costSol,
    source: priceInfo.source,
    reason,
    // Combined trade economics (leg + any banked partial). Ledger-integrity
    // and performance-analyzer aggregate partial fills into one trade.
    tradeRealizedPnlSol: tradeRealized,
    tradeRealizedPnlPct: tradeRealizedPct,
    partialTaken: !!position.partialTaken
  });

  logBlock(
`[PAPER SELL] ${position.symbol} (${reason})
P&L: ${sign(tradeRealized)}${tradeRealized.toFixed(5)} SOL (${sign(tradeRealizedPct)}${tradeRealizedPct.toFixed(2)}%)${position.partialTaken ? ' [combined w/ partial]' : ''}
Realized P&L: ${sign(portfolio.realizedPnlSol)}${portfolio.realizedPnlSol.toFixed(5)} SOL
Total P&L: ${sign(portfolio.totalPnlSol)}${portfolio.totalPnlSol.toFixed(5)} SOL
Equity: ${portfolio.equitySol.toFixed(5)} SOL`);

  // Position closed → drop its live integrity anchor/quarantine.
  if (priceIntegrity) {
    try { priceIntegrity.notePositionClosed(position.mint); } catch (_) { /* best effort */ }
  }

  // TradingAgents prediction tracking (advisory only — never tunes strategy).
  if (tradingAgents) {
    try {
      const entryTs = Date.parse(position.openedAt || '') || Date.now();
      tradingAgents.recordTradeOutcome({
        mint: position.mint,
        pnlPct: tradeRealizedPct,
        entryTs,
        sellTs: Date.now()
      });
    } catch (_) { /* best effort */ }
  }
  // ATLAS outcome tracking — look-ahead-free evaluation of any ATLAS
  // predictions made before this trade's entry timestamp.
  if (atlas && typeof atlas.recordTradeOutcome === 'function') {
    try {
      const entryTs = Date.parse(position.openedAt || '') || Date.now();
      const atlasOutcome = atlas.recordTradeOutcome({
        mint: position.mint,
        pnlPct: tradeRealizedPct,
        entryTs,
        sellTs: Date.now()
      });
      if (atlasOutcome && atlasOutcome.found) {
        log(`[ATLAS-OUTCOME] resolved ${atlasOutcome.outcomes.length} prediction(s) for ${position.symbol} pnl=${tradeRealizedPct.toFixed(2)}%`);
      }
    } catch (_) { /* best effort — never affects execution */ }
  }
  return true;
}

/** Partial profit-take: sell PARTIAL_FRACTION of the position at market once
 *  PARTIAL_TAKE_PCT is reached, then arm breakeven SL + runner TP on the rest.
 *  Banks realized P&L immediately but is NOT a closed trade: no win/loss
 *  increment, no cooldown (the mint stays held, so no re-buy), integrity
 *  anchor untouched (position identity unchanged). Persist-then-append, same
 *  durability ordering as BUY/SELL. Returns true on a partial fill. */
function executePaperPartial(position, priceInfo, opts = {}) {
  const lv = effectivePartialLevels(opts);
  if (position.partialTaken) return false;
  if (!(position.quantity > 0) || !(priceInfo.priceSol > 0)) return false;
  const sellQty = round(position.quantity * lv.fraction, 8);
  const remainingQty = round(position.quantity - sellQty, 8);
  if (!(sellQty > 0) || !(remainingQty > 0)) return false;
  const qtyRatio = sellQty / position.quantity;
  const basisSold = round(position.costSol * qtyRatio, 8);
  if (!(basisSold > 0)) return false;
  const proceeds = round(sellQty * priceInfo.priceSol, 8);
  const realized = round(proceeds - basisSold, 8);
  const realizedPct = basisSold > 0 ? round((realized / basisSold) * 100, 4) : 0;

  portfolio.cashSol = round(portfolio.cashSol + proceeds, 8);
  portfolio.realizedPnlSol = round(portfolio.realizedPnlSol + realized, 8);
  position.quantity = remainingQty;
  position.costSol = round(position.costSol - basisSold, 8);
  position.realizedPartialSol = round((Number.isFinite(position.realizedPartialSol) ? position.realizedPartialSol : 0) + realized, 8);
  position.partialTaken = true;
  position.stopLossPct = lv.breakeven;
  // Fixed-path runners extend to +12%; ATR runners keep their sized 2.5×NATR
  // target (inflating it would undo the volatility sizing).
  if (position.atrNatr == null) position.takeProfitPct = lv.runner;

  recalculate(portfolio);
  persist();

  appendLedger({
    id: portfolio.nextTradeId++,
    timestamp: nowIso(),
    side: 'SELL',
    symbol: position.symbol,
    mint: position.mint,
    pairAddress: position.pairAddress || null,
    dex: position.dex || null,
    quantity: sellQty,
    price: round(priceInfo.priceSol, 12),
    priceUsd: round(priceInfo.priceUsd, 12),
    valueSol: proceeds,
    realizedPnlSol: realized,
    realizedPnlPct: realizedPct,
    entryPriceSol: position.entryPriceSol,
    costSol: basisSold,
    source: priceInfo.source,
    reason: 'partial-take',
    partial: true,
    remainingQuantity: remainingQty,
    remainingCostSol: position.costSol
  });

  logBlock(
`[PARTIAL-TAKE] ${position.symbol} +${realizedPct.toFixed(2)}% leg → banked ${sign(realized)}${realized.toFixed(5)} SOL (${(lv.fraction * 100).toFixed(0)}% of position)
Runner: SL→${lv.breakeven}% (breakeven) TP→${lv.runner}% — remaining ${remainingQty} @ cost ${position.costSol.toFixed(5)} SOL`);
  return true;
}

/* ------------------------------------------------------------------ *
 * Local price history + 5-minute recovery.
 *
 * The 5m recovery used for trading is computed ONLY from local real-time
 * samples (~every 15 s, ~15 min kept). It is never taken from the discovery
 * API's reported 5m value. While history is insufficient, 5m = WARMING and
 * the token cannot be traded.
 * ------------------------------------------------------------------ */

const history = new Map(); // mint -> { samples: [{ts, priceUsd, priceSol, source}] }

const historyTargetMs = envInt('CIRCUIT_HISTORY_WARM_MS', DEFAULT_HISTORY_TARGET_MS);
const cooldownMs = envInt('CIRCUIT_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
const maxPriceAgeMs = envInt('CIRCUIT_MAX_PRICE_AGE_MS', DEFAULT_MAX_PRICE_AGE_MS);
const maxDivergencePct = envInt('CIRCUIT_MAX_DIVERGENCE_PCT', DEFAULT_MAX_DIVERGENCE_PCT);
function envFloat(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const gapKillPct = envFloat('CIRCUIT_GAP_KILL_PCT', DEFAULT_GAP_KILL_PCT);
const liqDropKillPct = envFloat('CIRCUIT_LIQ_DROP_PCT', DEFAULT_LIQ_DROP_KILL_PCT);
const timeStopMs = envInt('CIRCUIT_TIME_STOP_MS', DEFAULT_TIME_STOP_MS);
const timeStopMinPnlPct = envFloat('CIRCUIT_TIME_STOP_MIN_PNL_PCT', DEFAULT_TIME_STOP_MIN_PNL_PCT);
const partialsEnabled = process.env.CIRCUIT_PARTIALS_DISABLE !== '1';
const partialTakePct = envFloat('CIRCUIT_PARTIAL_TAKE_PCT', DEFAULT_PARTIAL_TAKE_PCT);
const partialFraction = (() => {
  const v = parseFloat(process.env.CIRCUIT_PARTIAL_FRACTION);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : DEFAULT_PARTIAL_FRACTION;
})();
const runnerTpPct = envFloat('CIRCUIT_RUNNER_TP_PCT', DEFAULT_RUNNER_TP_PCT);
const breakevenPct = (() => {
  const v = parseFloat(process.env.CIRCUIT_BREAKEVEN_PCT);
  return Number.isFinite(v) ? v : DEFAULT_BREAKEVEN_PCT;
})();
const atrEnabled = process.env.CIRCUIT_ATR_DISABLE !== '1';
const confirmEnabled = process.env.CIRCUIT_CONFIRM_DISABLE !== '1';
const qualityEnabled = process.env.CIRCUIT_QUALITY_DISABLE !== '1';
const rsiVwapEnabled = process.env.CIRCUIT_RSI_VWAP_DISABLE !== '1';
const atrSlMult = envFloat('CIRCUIT_ATR_SL_MULT', DEFAULT_ATR_SL_MULT);
const atrTpMult = envFloat('CIRCUIT_ATR_TP_MULT', DEFAULT_ATR_TP_MULT);
const minNatrPct = envFloat('CIRCUIT_MIN_NATR_PCT', DEFAULT_MIN_NATR_PCT);
const maxNatrPct = envFloat('CIRCUIT_MAX_NATR_PCT', DEFAULT_MAX_NATR_PCT);
const maxSellsBuysRatio = envFloat('CIRCUIT_MAX_SELLS_BUYS', DEFAULT_MAX_SELLS_BUYS_RATIO);
const minLiqMcapPct = envFloat('CIRCUIT_MIN_LIQ_MCAP_PCT', DEFAULT_MIN_LIQ_MCAP_PCT);
const targetVolPct = envFloat('CIRCUIT_TARGET_VOL_PCT', DEFAULT_TARGET_VOL_PCT);
const rsiBarMs = envInt('CIRCUIT_RSI_BAR_MS', DEFAULT_RSI_BAR_MS);
const rsiOversold = envFloat('CIRCUIT_RSI_OVERSOLD', DEFAULT_RSI_OVERSOLD);
const winprobEnabled = process.env.CIRCUIT_WINPROB_DISABLE !== '1';
const winprobMinTrades = envInt('CIRCUIT_WINPROB_MIN_TRADES', 10);
const winprobFixedThreshold = (() => {
  const v = parseFloat(process.env.CIRCUIT_WINPROB_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : null;
})();

/** Effective partial levels with fail-safe clamps (pure, unit-testable via opts).
 *  Runner must clear the partial trigger (else instant re-trigger); breakeven
 *  must sit below the partial trigger and never below the hard SL floor. */
function effectivePartialLevels(opts = {}) {
  const take = opts.partialTakePct != null ? opts.partialTakePct
    : (typeof partialTakePct !== 'undefined' ? partialTakePct : DEFAULT_PARTIAL_TAKE_PCT);
  const frac = opts.partialFraction != null ? opts.partialFraction
    : (typeof partialFraction !== 'undefined' ? partialFraction : DEFAULT_PARTIAL_FRACTION);
  const runner = opts.runnerTpPct != null ? opts.runnerTpPct
    : (typeof runnerTpPct !== 'undefined' ? runnerTpPct : DEFAULT_RUNNER_TP_PCT);
  const be = opts.breakevenPct != null ? opts.breakevenPct
    : (typeof breakevenPct !== 'undefined' ? breakevenPct : DEFAULT_BREAKEVEN_PCT);
  return {
    take,
    fraction: (Number.isFinite(frac) && frac > 0 && frac < 1) ? frac : DEFAULT_PARTIAL_FRACTION,
    runner: Math.max(Number.isFinite(runner) ? runner : DEFAULT_RUNNER_TP_PCT, take + 1),
    breakeven: Math.max(STOP_LOSS_PCT, Math.min(Number.isFinite(be) ? be : DEFAULT_BREAKEVEN_PCT, take - 0.5))
  };
}

/**
 * Compute 5m recovery from local samples. Returns
 *   { warming: false, pct, baselineAgeMs, samples } or
 *   { warming: true, samples, reason }
 * The baseline must be approximately historyTargetMs old (within 25%).
 */
function compute5mRecoveryFromSamples(samples, targetMs) {
  const n = samples.length;
  if (!n) return { warming: true, samples: 0, reason: 'no samples yet' };
  if (n < MIN_HISTORY_SAMPLES) return { warming: true, samples: n, reason: 'warming' };
  const now = Date.now();
  let best = null;
  let bestDiff = Infinity;
  for (const s of samples) {
    const diff = Math.abs((now - s.ts) - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  if (!best || bestDiff > targetMs * 0.25) {
    return { warming: true, samples: n, reason: 'baseline not ~5m old yet' };
  }
  const cur = samples[n - 1];
  const pct = cur.priceUsd > 0 && best.priceUsd > 0
    ? ((cur.priceUsd / best.priceUsd) - 1) * 100
    : 0;
  return { warming: false, pct: round(pct, 2), baselineAgeMs: Math.round((now - best.ts) / 1000), samples: n };
}

function compute5mRecovery(mint) {
  const h = history.get(mint);
  if (!h) return { warming: true, samples: 0, reason: 'no history' };
  return compute5mRecoveryFromSamples(h.samples, historyTargetMs);
}

function addSample(mint, info) {
  let h = history.get(mint);
  if (!h) { h = { samples: [] }; history.set(mint, h); }
  h.samples.push({
    ts: info.timestamp || Date.now(),
    priceUsd: info.priceUsd,
    priceSol: info.priceSol,
    source: info.source
  });
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  while (h.samples.length && h.samples[0].ts < cutoff) h.samples.shift();
}

/* ------------------------------------------------------------------ *
 * Bounce confirmation (entry quality — complements the 5m-recovery gate).
 *
 * The 5m recovery compares two endpoints (baseline vs last): a single
 * anomalous or stale print can fake a buyable bounce, and a stalled bounce
 * (one early jump, then flat) still reads "recovered". Confirmation requires
 * the bounce to be ALIVE right now:
 *
 *   1. rising — the last CONFIRM_RISES (1) 15 s interval closed up (2
 *      consecutive rising closes, strictly, with sane inter-sample gaps).
 *      Loosened from 2 intervals: at 15 s ticks a live bounce very often
 *      prints one up tick then one flat requote, so a strict rising pair
 *      rejected genuine V-bottoms. One rising tick + a positive trailing
 *      slope is still a decisive live-bounce signal.
 *   2. slopeUp — least-squares slope over the trailing ≤20 closes is > 0
 *      (the 5-minute drift is up, not just the endpoints).
 *
 * Feed requotes: the price API re-serves the same cached print for ~60 s
 * while the sampler polls every 15 s, so most consecutive samples are
 * bit-identical requotes — not market closes. "Rising" is therefore evaluated
 * on consecutive DISTINCT prints only (a flat market still never confirms).
 * Stale/repeated prints (delta 0) and gappy history never confirm — NO TRADE
 * on uncertain data, same fail-safe as the warming gate. Pure + deterministic.
 * ------------------------------------------------------------------ */

const CONFIRM_RISES = 2;
const CONFIRM_SLOPE_WINDOW = 20;
const CONFIRM_MAX_GAP_MS = 120000;

/** Bounce confirmation over trailing sampler closes (pure, exported).
 *  Returns { confirmed, rising, slopeUp, gapsOk, slopePctPerMin, n, reason }. */
function bounceConfirmation(samples, opts = {}) {
  const needRises = opts.needRises != null ? opts.needRises : CONFIRM_RISES;
  const slopeWindow = opts.slopeWindow != null ? opts.slopeWindow : CONFIRM_SLOPE_WINDOW;
  const maxGapMs = opts.maxGapMs != null ? opts.maxGapMs : CONFIRM_MAX_GAP_MS;
  const raw = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(s.priceUsd) && s.priceUsd > 0 && Number.isFinite(s.ts))
    .sort((a, b) => a.ts - b.ts)
    .slice(-Math.max(slopeWindow, needRises + 1));
  // Collapse consecutive bit-identical prints: a cached feed requote is not
  // a market close, so strict-rise and slope are evaluated on the distinct
  // print sequence only. A genuinely flat market collapses to one point and
  // still (correctly) reports insufficient-samples below.
  const pts = [];
  for (const s of raw) {
    if (!pts.length || s.priceUsd !== pts[pts.length - 1].priceUsd) pts.push(s);
  }
  const n = pts.length;
  const base = { confirmed: false, rising: false, slopeUp: false, gapsOk: false, slopePctPerMin: 0, n, reason: null };
  if (n < needRises + 1) return Object.assign(base, { reason: `insufficient-samples (${n}/${needRises + 1})` });
  const tail = pts.slice(-(needRises + 1));
  let gapsOk = true;
  for (let i = 1; i < tail.length; i++) {
    const gap = tail[i].ts - tail[i - 1].ts;
    if (!(gap > 0 && gap <= maxGapMs)) gapsOk = false;
  }
  if (!gapsOk) return Object.assign(base, { rising: false, reason: 'stale-gap in recent closes' });
  // Net-rise check: last price strictly above the price from needRises
  // intervals ago (at least one tick of progress) instead of requiring
  // EVERY 15 s interval to be strictly increasing — a real V-bottom often
  // has one flat requote tick during the ascent, which the old strict-rising
  // rule rejected.
  const rising = tail[tail.length - 1].priceUsd > tail[0].priceUsd;
  // Least-squares slope over the trailing window (t in seconds from first).
  const w = pts.slice(-slopeWindow);
  const K = w.length;
  const t0 = w[0].ts;
  let st = 0, sp = 0, stt = 0, stp = 0;
  for (const s of w) {
    const t = (s.ts - t0) / 1000;
    st += t; sp += s.priceUsd; stt += t * t; stp += t * s.priceUsd;
  }
  const den = K * stt - st * st;
  const slope = den !== 0 ? (K * stp - st * sp) / den : 0;
  const lastP = w[K - 1].priceUsd;
  const slopePctPerMin = lastP > 0 && Number.isFinite(slope) ? (slope / lastP) * 100 * 60 : 0;
  const slopeUp = slope > 0;
  if (!rising) {
    return Object.assign(base, {
      rising, gapsOk, slopeUp, slopePctPerMin: round(slopePctPerMin, 4),
      reason: `no net rise over last ${needRises + 1} distinct closes`
    });
  }
  if (!slopeUp) {
    return Object.assign(base, {
      rising, gapsOk, slopeUp, slopePctPerMin: round(slopePctPerMin, 4),
      reason: `5m slope not up (${round(slopePctPerMin, 2).toFixed(2)}%/min)`
    });
  }
  return { confirmed: true, rising: true, slopeUp: true, gapsOk: true, slopePctPerMin: round(slopePctPerMin, 4), n, reason: null };
}

/** Live-history wrapper: RSI+VWAP verdict stashed on the candidate. */
function evaluateRsiVwapFor(c) {
  const h = history.get(c.mint);
  const rv = evaluateRsiVwap(h ? h.samples : []);
  c.rsi = rv.ok
    ? { ok: true, rsi: rv.rsi, rsiWarming: rv.rsiWarming, vwapDistPct: rv.vwapDistPct, bars: rv.bars }
    : { ok: false, reason: rv.reason, rsi: rv.rsi, rsiWarming: rv.rsiWarming, vwapDistPct: rv.vwapDistPct, bars: rv.bars };
  return rv;
}

/** Live-history wrapper: confirm + stash the verdict on the candidate. */
function confirmBounceFor(c) {
  const h = history.get(c.mint);
  const bc = bounceConfirmation(h ? h.samples : []);
  c.bounce = bc.confirmed ? { confirmed: true, slopePctPerMin: bc.slopePctPerMin, n: bc.n }
    : { confirmed: false, reason: bc.reason, rising: bc.rising, slopeUp: bc.slopeUp, n: bc.n };
  return bc;
}

/** Resample closes into barMs buckets (bar close = last close in bucket).
 *  Pure, ascending [{ ts: barStart, close }]. */
function resampleToBars(samples, barMs) {
  const ms = Number.isFinite(barMs) && barMs > 0 ? barMs : DEFAULT_RSI_BAR_MS;
  const buckets = new Map();
  for (const s of (Array.isArray(samples) ? samples : [])) {
    if (!s || !Number.isFinite(s.priceUsd) || s.priceUsd <= 0 || !Number.isFinite(s.ts)) continue;
    const start = Math.floor(s.ts / ms) * ms;
    const prev = buckets.get(start);
    if (!prev || s.ts >= prev.ts) buckets.set(start, { ts: s.ts, start, close: s.priceUsd });
  }
  return Array.from(buckets.keys()).sort((a, b) => a - b)
    .map((k) => ({ ts: k, close: buckets.get(k).close }));
}

/** Simple-mean RSI over a close array (all deltas equally weighted — the
 *  Wilder seed form). Returns 100/0 on one-sided moves, 50 on flat, null
 *  with fewer than 2 closes. Pure. */
function rsiOfCloses(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  let g = 0, l = 0, n = 0;
  for (let i = 1; i < closes.length; i++) {
    const a = Number(closes[i - 1]);
    const b = Number(closes[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    const d = b - a;
    if (d > 0) g += d; else l -= d;
    n += 1;
  }
  if (!n) return null;
  g /= n; l /= n;
  if (l === 0) return g === 0 ? 50 : 100;
  if (g === 0) return 0;
  return 100 - 100 / (1 + g / l);
}

/** RSI + VWAP dip filter over local sampler history (pure, exported).
 *  RSI leg: needs ≥ minBars one-minute closes else fails OPEN (warming).
 *  VWAP leg: last close vs trailing-lookback mean, needs ≥ vwapMin closes.
 *  Returns { ok, reason, rsi, rsiPrev, rsiWarming, bars, vwap, vwapDistPct }. */
function evaluateRsiVwap(samples, opts = {}) {
  const barMs = opts.barMs != null ? opts.barMs
    : (typeof rsiBarMs !== 'undefined' ? rsiBarMs : DEFAULT_RSI_BAR_MS);
  const period = opts.rsiPeriod != null ? opts.rsiPeriod : RSI_PERIOD;
  const minBars = opts.minBars != null ? opts.minBars : RSI_MIN_BARS;
  const oversold = opts.oversold != null ? opts.oversold
    : (typeof rsiOversold !== 'undefined' ? rsiOversold : DEFAULT_RSI_OVERSOLD);
  const lookback = opts.vwapLookbackMs != null ? opts.vwapLookbackMs : VWAP_LOOKBACK_MS;
  const vwapMin = opts.vwapMin != null ? opts.vwapMin : VWAP_MIN_SAMPLES;
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const out = { ok: true, reason: null, rsi: null, rsiPrev: null, rsiWarming: true, bars: 0, vwap: null, vwapDistPct: null };

  const bars = resampleToBars(samples, barMs);
  out.bars = bars.length;
  if (bars.length >= minBars) {
    const closes = bars.slice(-minBars).map((b) => b.close);
    const r = rsiOfCloses(closes);
    const rPrev = rsiOfCloses(closes.slice(0, -1));
    out.rsi = r == null ? null : round(r, 2);
    out.rsiPrev = rPrev == null ? null : round(rPrev, 2);
    out.rsiWarming = false;
    if (r == null || rPrev == null || !(r < oversold && r > rPrev)) {
      out.ok = false;
      out.reason = r == null ? 'rsi unavailable'
        : `rsi ${r.toFixed(1)} not oversold-turning (<${oversold} and rising, prev ${rPrev == null ? 'n/a' : rPrev.toFixed(1)})`;
      return out;
    }
  }

  const closes = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(s.priceUsd) && s.priceUsd > 0 && Number.isFinite(s.ts) && s.ts >= now - lookback)
    .sort((a, b) => a.ts - b.ts);
  if (closes.length < vwapMin) {
    out.ok = false;
    out.reason = `vwap unavailable (${closes.length}/${vwapMin} closes in 5m)`;
    return out;
  }
  let sum = 0;
  for (const s of closes) sum += s.priceUsd;
  const mean = sum / closes.length;
  const last = closes[closes.length - 1].priceUsd;
  out.vwap = mean;
  out.vwapDistPct = mean > 0 ? round(((last / mean) - 1) * 100, 2) : null;
  if (!(last > mean)) {
    out.ok = false;
    out.reason = `below 5m VWAP (${out.vwapDistPct}% vs mean)`;
    return out;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Strategy scoring (deterministic, from REAL market data only).
 *
 *   0..35  deeper 1h dip (within the allowed -35%..+15% band) scores higher
 *   0..30  stronger local 5m recovery (0.25%..8%) scores higher
 *   0..20  liquidity (log scale, $2k..$100k+)
 *   0..15  volume (log scale, $10k..$250k+)
 * ------------------------------------------------------------------ */

function computeScore({ change1hPct, recoveryPct, liquidityUsd, volume24hUsd }) {
  let s = 0;
  const dip = Math.min(1, Math.max(0, (0 - change1hPct) / 35));
  s += 5 + 30 * dip;
  const rec = recoveryPct == null ? 0 : Math.min(1, Math.max(0, (recoveryPct - MIN_5M_RECOVERY_PCT) / (MAX_5M_RECOVERY_PCT - MIN_5M_RECOVERY_PCT)));
  s += 30 * rec;
  const liq = liquidityUsd || 0;
  s += liq >= 100000 ? 20 : liq >= 50000 ? 16 : liq >= 20000 ? 12 : liq >= 10000 ? 8 : liq >= 5000 ? 5 : liq >= 2000 ? 2 : 0;
  const vol = volume24hUsd || 0;
  s += vol >= 250000 ? 15 : vol >= 100000 ? 12 : vol >= 50000 ? 8 : vol >= 20000 ? 5 : vol >= 10000 ? 3 : 0;
  return Math.round(s);
}

/* ------------------------------------------------------------------ *
 * Loops: sampler (history), monitor (open positions), discovery (scans).
 * ------------------------------------------------------------------ */

let samplingActive = false;
let monitoringActive = false;
let discoveringActive = false;
let sampleUniverse = new Set();
let market = null;
let lastSolPriceUsd = null;
let priceIntegrity = null; // market-price integrity layer (created in main)
let tradingAgents = null;  // TradingAgents research layer (created in main)
let atlas = null;          // ATLAS intelligence layer (parallel, advisory, research-grade)
let researchHistory = null; // bounded persistent RESEARCH price history (separate from V1's 15-min operational history)

// ---- Adaptive layer state ------------------------------------------------
let adaptiveState = {
  policy: null,          // session policy (adaptive-policy.json)
  regimeState: null,     // regime state (regime-state.json)
  gates: null,           // promoted learned gates (learned-gates.json)
  bandsBase: null,       // promoted GLOBAL entry bands (strategy-versions.json bandsBase; null = V1)
  bandsVersion: 'V1',    // strategy version that set bandsBase (for logging)
  bandit: null,          // bandit posteriors (bandit-state.json, rebuilt per loop)
  banditArms: {},        // selected minScore per clusterKey (daily, deterministic)
  banditLive: false,     // arms gate entries only when live (promoted + approved)
  health: null,          // market-health proxy (per-scan)
  solTrend: null,        // { change1hPct, change24hPct, at } from the SOL feed
  discoveryFailures: 0,  // consecutive discovery failures
  lastSolFetchAt: null,  // last real SOL/USD fetch time
  lastScanQuality: null, // { candidates, withLiquidity } from last scan
  lastAgentLoopAt: null,
  lastReflectionAt: null
};

/** Refresh bandit posteriors + daily arm selection (deterministic).
 *  Rebuilds from the full closed-trade ledger (idempotent, restart-safe),
 *  selects arms per known cluster for today (UTC; CIRCUIT_BANDIT_DAY pins a
 *  date for replay/testing), persists state. Runs at startup and per
 *  agent-loop; the per-scan gate only READS the selection. */
function refreshBandit() {
  try {
    const closed = closedTrades();
    const clusters = gatesLib.banditUpdateFromTrades(closed);
    const day = process.env.CIRCUIT_BANDIT_DAY || new Date().toISOString().slice(0, 10);
    const arms = gatesLib.selectBanditArms({ clusters }, Object.keys(clusters), day);
    gatesLib.saveBanditState(dataDir, { clusters, arms, lastSelectionDay: day });
    adaptiveState.bandit = { clusters };
    adaptiveState.banditArms = arms;
    const keys = Object.keys(arms);
    const strict = keys.filter((k) => arms[k] && arms[k].arm > 60);
    log(`[BANDIT] ${keys.length} cluster(s), ${strict.length} above V1 floor${strict.length ? ': ' + strict.slice(0, 6).map((k) => `${k}=${arms[k].arm}`).join(', ') + (strict.length > 6 ? ', …' : '') : ''} — ${banditLiveActive() ? 'LIVE gating' : 'SHADOW only'}`);
  } catch (err) {
    pushError('BANDIT', `bandit refresh failed (${err.message}) — V1 minScore applies`);
  }
}

/** Is bandit arm gating live? Promoted baseline flag OR operator override. */
function banditLiveActive() {
  if (process.env.CIRCUIT_BANDIT_LIVE === '1') return true;
  return !!adaptiveState.banditLive;
}

/** Refresh the global entry-band baseline from the strategy version chain.
 *  Null (V1) when disabled, missing, or unreadable — the scanner then gates
 *  on V1 exactly as before. */
function refreshBandsBase() {
  try {
    if (!adaptiveEnabled()) { adaptiveState.bandsBase = null; adaptiveState.bandsVersion = 'V1'; return; }
    const versions = experiments.loadVersions(dataDir, { maxPositions: MAX_POSITIONS });
    const baseline = experiments.effectiveBaseline(versions, { maxPositions: MAX_POSITIONS });
    adaptiveState.bandsBase = baseline.bandsBase;
    adaptiveState.bandsVersion = baseline.versionId || 'V1';
  } catch (_) {
    adaptiveState.bandsBase = null;
    adaptiveState.bandsVersion = 'V1';
  }
}

function adaptiveEnabled() {
  return config && config.adaptive && config.adaptive.enabled;
}

async function refreshSolPrice() {
  try {
    const sol = await market.getSolPriceUsd();
    if (sol && sol.priceUsd > 0) {
      lastSolPriceUsd = round(sol.priceUsd, 4);
      adaptiveState.lastSolFetchAt = Date.now();
      // SOL trend travels with the price (regime input; null = unknown —
      // never coerce missing to 0, a flat-market claim needs real data).
      const finiteOrNull = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
      adaptiveState.solTrend = {
        change1hPct: finiteOrNull(sol.change1hPct),
        change24hPct: finiteOrNull(sol.change24hPct),
        at: Date.now()
      };
    }
  } catch (err) {
    pushError('PRICE-FALLBACK', `SOL price fetch failed (${err.message})`);
  }
}

/** Market-health inputs collected from real observable agent state (paper-only proxy). */
function computeMarketHealth() {
  const sources = (market && typeof market.priceSources === 'function') ? market.priceSources() : [];
  const health = healthLib.computeHealth({
    sourceStats: sources.map((s) => ({
      name: s.name, status: s.lastError ? 'error' : (s.lastOkAt ? 'ok' : 'unknown'),
      lastOkAt: s.lastOkAt, lastError: s.lastError
    })),
    solPriceAgeMs: adaptiveState.lastSolFetchAt ? Date.now() - adaptiveState.lastSolFetchAt : null,
    solPriceMaxAgeMs: config.adaptive.solPriceMaxAgeMs || Math.max(120000, maxPriceAgeMs * 2),
    discoveryFailures: adaptiveState.discoveryFailures,
    lastScanQuality: adaptiveState.lastScanQuality,
    cfg: { minHealthScore: config.adaptive.minHealthScore }
  });
  adaptiveState.health = health;
  return health;
}

/** Current regime (cached state if fresh, else live detect without persisting). */
function currentRegime() {
  if (adaptiveState.regimeState && adaptiveState.regimeState.validUntil &&
      Date.now() < new Date(adaptiveState.regimeState.validUntil).getTime()) {
    return adaptiveState.regimeState;
  }
  return { regime: 'UNKNOWN', confidence: 0, reasoning: 'stale or undetected — V1 baseline' };
}

/** Closed trades from the ledger (used by agent-loop / reflection). */
function closedTrades() {
  return perfLib.pairTrades(perfLib.readLedgerFile(tradesFile)).closed;
}

async function sampleOnce() {
  if (samplingActive) return; // never overlap cycles
  samplingActive = true;
  const mints = Array.from(sampleUniverse).slice(0, SAMPLE_UNIVERSE_CAP);
  if (!mints.length) { samplingActive = false; return; }
  try {
    const prices = await market.fetchTokenPrices(mints);
    let ok = 0;
    for (const [mint, info] of prices) {
      if (!marketDataLib.isValidPrice(info)) continue;
      addSample(mint, info);
      ok += 1;
    }
    const missing = mints.length - prices.size;
    if (missing > 0) log(`[HISTORY-SKIP] ${missing}/${mints.length} token(s) had no usable price this cycle`);
    if (ok > 0) log(`[SAMPLER] recorded ${ok} price sample(s)`);
    // Mirror every real observation into the bounded RESEARCH history (P1-02).
    // V1's operational history below is untouched — this is a parallel store.
    if (researchHistory) {
      try {
        for (const [mint, info] of prices) {
          if (!marketDataLib.isValidPrice(info)) continue;
          researchHistory.record(mint, info);
        }
      } catch (err) { pushError('HISTORY-SKIP', `research-history record failed: ${err.message}`); }
    }
  } catch (err) {
    pushError('HISTORY-SKIP', `sampler error: ${err.message}`);
  } finally {
    samplingActive = false;
  }
}

async function monitorOnce() {
  if (monitoringActive) return;
  monitoringActive = true;
  const hadPositions = portfolio.positions.length > 0;
  try {
    if (!hadPositions) return;
    const mints = portfolio.positions.map((p) => p.mint);
    // Phase 15 (STONK): prefer each open position's ENTRY pair when pricing it,
    // so monitoring stays anchored to the market identity that produced the
    // entry price. If the entry pair disappears from the response, the
    // best-liquidity pair is still returned and price-integrity's PAIR_CHANGED
    // gate remains the authority that rejects it — no silent switching.
    const preferredPairs = new Map();
    for (const p of portfolio.positions) {
      if (p && p.mint && typeof p.pairAddress === 'string' && p.pairAddress) preferredPairs.set(p.mint, p.pairAddress);
    }
    const prices = await market.fetchTokenPrices(mints, { preferredPairs });
    for (const position of portfolio.positions.slice()) {
      const info = prices.get(position.mint);
      if (!info || !marketDataLib.isValidPrice(info)) {
        pushError('PRICE', `no fresh price for open position ${position.symbol} — holding at last price`);
        continue; // NEVER assume a price. NO TRADE on missing data.
      }
      if (marketDataLib.priceAgeMs(info) > maxPriceAgeMs) {
        pushError('PRICE', `stale price for open position ${position.symbol} (age ${marketDataLib.priceAgeMs(info)}ms) — holding`);
        continue;
      }
      // LIQUIDITY-RUG KILL (risk exit): a validity-passed observation whose
      // pool drained >= liqDropKillPct exits IMMEDIATELY at market. Liquidity
      // is an independent corroborating signal (a bad price print does not
      // drain the pool), so this bypasses quarantine confirmation.
      // NOTE: price gaps NEVER bypass — not even -99%: a single anomalous
      // print must hold for confirmation (ZCAT rule). Adverse extremes
      // instead fast-confirm inside price-integrity (1 print, not 2).
      if (priceIntegrity) {
        try {
          const obsForValve = Object.assign({}, info, { mint: position.mint });
          const anchorPair = (() => {
            try {
              const st = priceIntegrity.state().mints[position.mint];
              return (st && st.pairAddress) || position.pairAddress;
            } catch (_) { return position.pairAddress; }
          })();
          const valve = integrityLib.validatePositionPrice({
            position: Object.assign({}, position, { pairAddress: anchorPair }),
            observation: obsForValve,
            opts: { maxAgeMs: maxPriceAgeMs, now: Date.now(), maxDivergencePct }
          });
          if (valve.ok) {
            const kill = evaluateGapKill(position, info);
            if (kill.kill && kill.reason === 'liquidity-kill') {
              try { priceIntegrity.forceAccept(position.mint, info, kill.reason); } catch (_) { /* best effort */ }
              position.currentPriceSol = round(info.priceSol, 12);
              position.currentPriceUsd = round(info.priceUsd, 12);
              position.priceSource = info.source;
              log(`[GAP-KILL] ${position.symbol} ${kill.reason} liqDrop=${kill.liqDropPct == null ? 'n/a' : kill.liqDropPct.toFixed(1) + '%'} — closing at market (liquidity corroborated)`);
              executePaperSell(position, info, kill.reason);
              continue;
            }
          }
        } catch (err) {
          pushError('GAP-KILL', `liquidity-rug check error for ${position.symbol}: ${err.message} — falling through to integrity path`);
        }
      }
      // PRICE INTEGRITY — accounting trust gate (BELOW the strategy; never a
      // strategy rule). A rejected/suspicious observation may NOT move the
      // position price and may NOT trigger SL/TP: we keep the last valid
      // price and wait for confirmation. Only 'accepted'/'confirmed'
      // observations reach the existing strategy monitor below, so SL/TP and
      // recovery logic behave exactly as before on trustworthy prices.
      if (priceIntegrity) {
        try {
          const verdict = priceIntegrity.checkPositionObservation({
            position,
            observation: info,
            now: Date.now()
          });
          if (verdict.status !== 'accepted' && verdict.status !== 'confirmed') {
            continue; // rejected / suspicious / awaiting confirmation — hold, NO SELL
          }
        } catch (err) {
          pushError('PRICE-INTEGRITY', `integrity check error for ${position.symbol}: ${err.message} — holding at last valid price`);
          continue;
        }
      }
      position.currentPriceSol = round(info.priceSol, 12);
      position.currentPriceUsd = round(info.priceUsd, 12);
      position.priceSource = info.source;
      const pnlPct = position.entryPriceSol > 0
        ? ((position.currentPriceSol - position.entryPriceSol) / position.entryPriceSol) * 100
        : 0;
log(
  `[POSITION-OBS] ${position.symbol} ` +
  `entrySol=${position.entryPriceSol} ` +
  `priceSol=${position.currentPriceSol} ` +
  `priceUsd=${position.currentPriceUsd} ` +
  `pnl=${pnlPct.toFixed(4)}% ` +
  `ageMs=${marketDataLib.priceAgeMs(info)} ` +
  `pair=${info.pairAddress || '-'} ` +
  `dex=${info.dex || '-'} ` +
  `source=${info.source || '-'}`
);

      let decision = null;
      try {
        decision = decideExit(position, pnlPct, Date.now());
      } catch (err) {
        pushError('EXIT-DECIDE', `exit decision error for ${position.symbol}: ${err.message} — holding`);
      }
      if (decision && decision.action === 'close') {
        log(`[${decision.reason.toUpperCase()}] ${position.symbol} unrealized ${pnlPct.toFixed(2)}% — closing paper position`);
        executePaperSell(position, info, decision.reason);
      } else if (decision && decision.action === 'partial') {
        executePaperPartial(position, info);
      }
    }
  } catch (err) {
    pushError('MONITOR-ERROR', `monitor cycle failed: ${err.message}`);
  } finally {
    // Persist immediately after a monitor cycle so a stop-loss/take-profit
    // close lands on disk without waiting for the next discovery scan — a
    // sold position must never reappear after a restart.
    if (hadPositions) {
      try {
        recalculate(portfolio);
        persist();
        if (priceIntegrity) priceIntegrity.persist();
        recordEquityHistory();
        writeHeartbeat('running');
      } catch (err) {
        pushError('MONITOR-ERROR', `persist after monitor failed: ${err.message}`);
      }
    }
    monitoringActive = false;
  }
}

function inCooldown(mint) {
  const until = portfolio.cooldowns[mint];
  return until ? Math.max(0, until - Date.now()) : 0;
}

/** Buy-time price gate — NO TRADE on missing, invalid, or stale prices.
 *  Pure and exported so the branches are unit-testable. */
function evaluatePriceGate(info, maxAge) {
  if (!marketDataLib.isValidPrice(info)) {
    return { ok: false, reason: 'price unavailable' };
  }
  if (marketDataLib.priceAgeMs(info) > maxAge) {
    return { ok: false, reason: `price stale (age ${Math.round(marketDataLib.priceAgeMs(info) / 1000)}s)` };
  }
  return { ok: true };
}

/** Gap-kill scoring: last VALID price anchor, else live mark, else entry.
 *  Pure and exported so the branches are unit-testable. NOTE (ZCAT rule):
 *  the monitor acts on 'liquidity-kill' verdicts ONLY — price legs are
 *  scored for visibility while adverse extremes fast-confirm inside
 *  price-integrity instead of bypassing quarantine. */
function evaluateGapKill(position, info, opts = {}) {
  const gPct = opts.gapKillPct != null ? opts.gapKillPct : (typeof gapKillPct !== 'undefined' ? gapKillPct : DEFAULT_GAP_KILL_PCT);
  const lPct = opts.liqDropKillPct != null ? opts.liqDropKillPct : (typeof liqDropKillPct !== 'undefined' ? liqDropKillPct : DEFAULT_LIQ_DROP_KILL_PCT);
  let lastValid = null;
  try {
    if (priceIntegrity && typeof priceIntegrity.lastValidPrice === 'function') {
      const lv = priceIntegrity.lastValidPrice(position.mint);
      if (lv && Number.isFinite(lv.priceSol) && lv.priceSol > 0) lastValid = lv.priceSol;
    }
  } catch (_) { /* fallback below */ }
  if (!(lastValid > 0)) {
    if (Number.isFinite(position.currentPriceSol) && position.currentPriceSol > 0) lastValid = position.currentPriceSol;
    else if (Number.isFinite(position.entryPriceSol) && position.entryPriceSol > 0) lastValid = position.entryPriceSol;
  }
  const singleStepPct = (lastValid > 0 && Number.isFinite(info.priceSol) && info.priceSol > 0)
    ? ((info.priceSol / lastValid) - 1) * 100 : null;
  const absPnlPct = (Number.isFinite(position.entryPriceSol) && position.entryPriceSol > 0 && Number.isFinite(info.priceSol))
    ? ((info.priceSol / position.entryPriceSol) - 1) * 100 : null;
  const entryLiq = Number(position.entryLiquidityUsd);
  const obsLiq = Number(info.liquidityUsd);
  const liqDropPct = (Number.isFinite(entryLiq) && entryLiq > 0 && Number.isFinite(obsLiq))
    ? ((entryLiq - obsLiq) / entryLiq) * 100 : null;
  if (integrityLib.detectGapKill) {
    return integrityLib.detectGapKill(
      { singleStepPct, absPnlPct, liqDropPct },
      { gapKillPct: gPct, liqDropPct: lPct });
  }
  // Fallback if integrity lib is unavailable (same thresholds).
  if ((singleStepPct != null && singleStepPct <= -Math.abs(gPct)) ||
      (absPnlPct != null && absPnlPct <= -Math.abs(gPct))) {
    return { kill: true, reason: 'gap-kill', singleStepPct, absPnlPct, liqDropPct };
  }
  if (liqDropPct != null && liqDropPct >= Math.abs(lPct)) {
    return { kill: true, reason: 'liquidity-kill', singleStepPct, absPnlPct, liqDropPct };
  }
  return { kill: false, reason: null, singleStepPct, absPnlPct, liqDropPct };
}

/** NATR (%) over trailing closes (pure, exported for tests).
 *  excursion = (hi-lo)/last*100 over the trailing ≤NATR_WINDOW closes (≥
// NATR_MIN_SAMPLES required), projected to a full window (×WINDOW/n). */
function computeNatr(samples, opts = {}) {
  const window = Number.isFinite(opts.window) && opts.window > 0 ? Math.floor(opts.window) : NATR_WINDOW;
  const minSamples = Number.isFinite(opts.minSamples) && opts.minSamples > 0 ? Math.floor(opts.minSamples) : NATR_MIN_SAMPLES;
  const closes = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(s.priceSol) && s.priceSol > 0)
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
    .slice(-window)
    .map((s) => s.priceSol);
  const n = closes.length;
  if (n < minSamples) return { ok: false, reason: 'insufficient-history', n };
  const last = closes[n - 1];
  if (!(last > 0)) return { ok: false, reason: 'invalid-last-price', n };
  let hi = -Infinity, lo = Infinity;
  for (const p of closes) {
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  const raw = ((hi - lo) / last) * 100;
  if (!Number.isFinite(raw) || raw < 0) return { ok: false, reason: 'invalid-excursion', n };
  return { ok: true, natr: raw * (window / n), raw, n };
}

/** ATR exit levels for a measured NATR (pure, exported for tests).
 *  Returns { slPct (negative), tpPct (positive), effNatr }. */
function atrLevels(natr, opts = {}) {
  const slMult = opts.slMult != null ? opts.slMult
    : (typeof atrSlMult !== 'undefined' ? atrSlMult : DEFAULT_ATR_SL_MULT);
  const tpMult = opts.tpMult != null ? opts.tpMult
    : (typeof atrTpMult !== 'undefined' ? atrTpMult : DEFAULT_ATR_TP_MULT);
  const minN = opts.minNatr != null ? opts.minNatr
    : (typeof minNatrPct !== 'undefined' ? minNatrPct : DEFAULT_MIN_NATR_PCT);
  const maxN = opts.maxNatr != null ? opts.maxNatr
    : (typeof maxNatrPct !== 'undefined' ? maxNatrPct : DEFAULT_MAX_NATR_PCT);
  const mult = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const eff = Math.max(mult(minN, DEFAULT_MIN_NATR_PCT),
    Math.min(Number.isFinite(natr) ? natr : mult(minN, DEFAULT_MIN_NATR_PCT), mult(maxN, DEFAULT_MAX_NATR_PCT)));
  return { slPct: round(-mult(slMult, DEFAULT_ATR_SL_MULT) * eff, 2), tpPct: round(mult(tpMult, DEFAULT_ATR_TP_MULT) * eff, 2), effNatr: round(eff, 2) };
}

/** NATR entry gate (pure, exported for tests). Unknown NATR fails open —
 *  the BUY then falls back to fixed V1 stops. */
function passesNatrGate(natr, opts = {}) {
  const max = opts.maxNatr != null ? opts.maxNatr
    : (typeof maxNatrPct !== 'undefined' ? maxNatrPct : DEFAULT_MAX_NATR_PCT);
  if (!Number.isFinite(natr)) return { allow: true, reason: 'unknown-natr-fail-open' };
  if (natr > max) return { allow: false, reason: `NATR ${round(natr, 2).toFixed(2)}% above maximum ${max}% — stop would gap` };
  return { allow: true, reason: null };
}

/** Volatility-sized entry cost (pure, exported for tests).
 *  cost = baseSize × (targetVolPct / effNatr), where effNatr floors NATR at
 *  the ATR floor (same floor as exits — never divide by ~0 on flat prints).
 *  Unknown/invalid NATR fails open (multiplier 1.0). The caller clamps to
 *  [minSize, maxSize] (0.05 hard ceiling enforced there).
 *  Returns { cost, volMult, effNatr }. */
function computeEntrySize(baseSize, natr, opts = {}) {
  const base = Number(baseSize) > 0 ? Number(baseSize) : 0;
  const target = opts.targetVolPct != null ? opts.targetVolPct
    : (typeof targetVolPct !== 'undefined' ? targetVolPct : DEFAULT_TARGET_VOL_PCT);
  const floor = opts.minNatr != null ? opts.minNatr
    : (typeof minNatrPct !== 'undefined' ? minNatrPct : DEFAULT_MIN_NATR_PCT);
  const t = Number.isFinite(target) && target > 0 ? target : DEFAULT_TARGET_VOL_PCT;
  const f = Number.isFinite(floor) && floor > 0 ? floor : DEFAULT_MIN_NATR_PCT;
  if (!(base > 0) || !Number.isFinite(natr) || !(natr > 0)) {
    return { cost: round(base, 8), volMult: 1.0, effNatr: null };
  }
  const effNatr = Math.max(natr, f);
  const volMult = t / effNatr;
  return { cost: round(base * volMult, 8), volMult: round(volMult, 4), effNatr: round(effNatr, 2) };
}

/** UTC calendar day 'YYYY-MM-DD' (pure, exported for tests). */
function utcDayString(ts) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Roll the portfolio's day-P&L anchor on UTC date change (mutates p, no I/O).
 *  Anchor = equity at the first sighting of a new day (restart-safe: a
 *  persisted anchor survives restarts, so the halt can't be dodged by
 *  restarting). Returns true when the anchor was (re)set. */
function ensureDayAnchor(p, now) {
  if (!p || typeof p !== 'object') return false;
  const today = utcDayString(now == null ? Date.now() : now);
  if (today == null) return false;
  if (p.dayAnchorDate === today && Number.isFinite(p.dayAnchorSol)) return false;
  p.dayAnchorDate = today;
  p.dayAnchorSol = Number.isFinite(p.equitySol) ? p.equitySol : p.dayAnchorSol;
  if (!Number.isFinite(p.dayAnchorSol)) p.dayAnchorSol = null;
  return true;
}

/** Day-to-date account P&L % vs the day anchor (pure, exported for tests).
 *  Null when unknown (no/invalid anchor) → no halt. Includes unrealized. */
function computeDayPnl(p) {
  if (!p || typeof p !== 'object') return null;
  const anchor = Number(p.dayAnchorSol);
  const equity = Number(p.equitySol);
  if (!(anchor > 0) || !Number.isFinite(equity)) return null;
  return round(((equity - anchor) / anchor) * 100, 4);
}

/** Entry quality from order-flow + valuation (pure, exported for tests).
 *  Checks, in order: (1) h24 sells vs buys — distribution into strength
 *  rejects; (2) pool liquidity vs market cap (fdv fallback) — unexitable
 *  thinness rejects. Any leg with missing/non-positive inputs is SKIPPED
 *  (fail open); liqVolRatio is reported for transparency only, never gated.
 *  Returns { ok, reason, sellsBuysRatio, liqMcapPct, liqVolRatio,
 *            mcapSource }. */
function evaluateOrderflow(c, opts = {}) {
  const maxRatio = opts.maxSellsBuys != null ? opts.maxSellsBuys
    : (typeof maxSellsBuysRatio !== 'undefined' ? maxSellsBuysRatio : DEFAULT_MAX_SELLS_BUYS_RATIO);
  const minPct = opts.minLiqMcapPct != null ? opts.minLiqMcapPct
    : (typeof minLiqMcapPct !== 'undefined' ? minLiqMcapPct : DEFAULT_MIN_LIQ_MCAP_PCT);
  const out = { ok: true, reason: null, sellsBuysRatio: null, liqMcapPct: null, liqVolRatio: null, mcapSource: null };

  const buys = Number(c.txBuys);
  const sells = Number(c.txSells);
  if (Number.isFinite(buys) && Number.isFinite(sells) && (buys > 0 || sells > 0)) {
    if (!(buys > 0)) {
      // Zero buys with real sells = pure one-sided distribution.
      out.ok = false;
      out.reason = `orderflow distribution (sells ${sells} with no buys — one-sided dump)`;
      return out;
    }
    out.sellsBuysRatio = sells / buys;
    if (out.sellsBuysRatio > maxRatio) {
      out.ok = false;
      out.reason = `orderflow distribution (sells ${sells} > ${maxRatio}× buys ${buys})`;
      return out;
    }
  }

  const liq = Number(c.liquidityUsd);
  const mcapRaw = Number(c.marketCapUsd);
  const fdvRaw = Number(c.fdvUsd);
  const mcap = Number.isFinite(mcapRaw) && mcapRaw > 0 ? mcapRaw
    : (Number.isFinite(fdvRaw) && fdvRaw > 0 ? fdvRaw : NaN);
  out.mcapSource = Number.isFinite(mcapRaw) && mcapRaw > 0 ? 'marketCap'
    : (Number.isFinite(fdvRaw) && fdvRaw > 0 ? 'fdv' : null);
  if (Number.isFinite(liq) && liq > 0 && Number.isFinite(mcap)) {
    out.liqMcapPct = (liq / mcap) * 100;
    if (out.liqMcapPct < minPct) {
      out.ok = false;
      out.reason = `liquidity thin vs valuation (liq $${Math.round(liq).toLocaleString()} < ${minPct}% of ${out.mcapSource} $${Math.round(mcap).toLocaleString()})`;
      return out;
    }
  }

  const vol = Number(c.volume24hUsd);
  if (Number.isFinite(vol) && Number.isFinite(liq) && liq > 0) out.liqVolRatio = vol / liq;
  return out;
}

/** Time-stop: held >= maxAgeMs with PnL still below minPnlPct → exit at market.
 *  Pure and exported so the branches are unit-testable. Unknown/unparseable
 *  openedAt never exits (fail-open hold). */
function evaluateTimeStop(position, pnlPct, nowMs, opts = {}) {
  const maxAge = opts.timeStopMs != null ? opts.timeStopMs
    : (typeof timeStopMs !== 'undefined' ? timeStopMs : DEFAULT_TIME_STOP_MS);
  const minPnl = opts.timeStopMinPnlPct != null ? opts.timeStopMinPnlPct
    : (typeof timeStopMinPnlPct !== 'undefined' ? timeStopMinPnlPct : DEFAULT_TIME_STOP_MIN_PNL_PCT);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const entryTs = Date.parse(position.openedAt || '') || 0;
  if (!entryTs) return { exit: false, reason: null, ageMs: null };
  const ageMs = now - entryTs;
  if (!(ageMs >= maxAge)) return { exit: false, reason: null, ageMs };
  if (!(Number.isFinite(pnlPct) && pnlPct < minPnl)) return { exit: false, reason: null, ageMs };
  return { exit: true, reason: 'time-stop', ageMs };
}

/** Unified exit decision for an integrity-accepted observation (pure, exported).
 *  Priority: per-position SL → per-position TP → partial-take → time-stop.
 *  SL uses the position's armed level (V1 -6%, ATR-sized, or breakeven after a
 *  partial — reported as 'breakeven-stop'); TP likewise (V1 +8%, ATR-sized, or
 *  runner +12%). Gap-kill is NOT here (it bypasses integrity upstream). */
function decideExit(position, pnlPct, nowMs, opts = {}) {
  const sl = Number.isFinite(position.stopLossPct) ? position.stopLossPct : STOP_LOSS_PCT;
  const tp = Number.isFinite(position.takeProfitPct) ? position.takeProfitPct : TAKE_PROFIT_PCT;
  if (Number.isFinite(pnlPct) && pnlPct <= sl) {
    // Post-partial stops report as breakeven-stop (the stop was raised to
    // entry after banking profit); all other stops are stop-loss — including
    // ATR-sized stops tighter than the V1 -6% floor.
    return { action: 'close', reason: position.partialTaken ? 'breakeven-stop' : 'stop-loss' };
  }
  if (Number.isFinite(pnlPct) && pnlPct >= tp) {
    return { action: 'close', reason: 'take-profit' };
  }
  const on = opts.partialsEnabled != null ? opts.partialsEnabled
    : (typeof partialsEnabled !== 'undefined' ? partialsEnabled : true);
  if (on && !position.partialTaken && Number.isFinite(pnlPct)) {
    const lv = effectivePartialLevels(opts);
    if (pnlPct >= lv.take && lv.take < tp) {
      return { action: 'partial', reason: 'partial-take' };
    }
  }
  try {
    const ts = evaluateTimeStop(position, pnlPct, nowMs, opts);
    if (ts.exit) return { action: 'close', reason: ts.reason };
  } catch (_) { /* never block SL/TP/partial on time-stop errors */ }
  return { action: null, reason: null };
}

/* ------------------------------------------------------------------ *
 * Ensemble 2/3 gate (V1 + TradingAgents + ATLAS — precision over recall).
 *
 * A vote agrees ONLY on an explicit BUY (HOLD / AVOID / missing / disabled
 * never agree). allow = agrees >= minAgree (default 2). Pure + exported.
 * ------------------------------------------------------------------ */

const ENSEMBLE_MODES = ['OFF', 'SHADOW', 'ENFORCE'];
const DEFAULT_ENSEMBLE_AGREE = 2;

/** Normalize one vote to boolean agree (explicit BUY only). */
function ensembleVote(v) {
  return v === true || v === 'BUY';
}

/** Combine V1 + TA + ATLAS votes. votes: { v1, ta, atlas } (bool | rec str).
 *  Returns { allow, agrees, needed, who: ['V1','TA','ATLAS'] }. */
function evaluateEnsemble(votes = {}, opts = {}) {
  const need = Number.isFinite(opts.minAgree) ? Math.max(1, Math.min(3, Math.floor(opts.minAgree))) : DEFAULT_ENSEMBLE_AGREE;
  const v1 = ensembleVote(votes.v1);
  const ta = ensembleVote(votes.ta);
  const atlas = ensembleVote(votes.atlas);
  const who = [];
  if (v1) who.push('V1');
  if (ta) who.push('TA');
  if (atlas) who.push('ATLAS');
  const agrees = who.length;
  const allow = agrees >= need;
  return {
    allow,
    agrees,
    needed: need,
    votes: { v1, ta, atlas },
    who,
    reason: allow ? null : `ensemble ${agrees}/3 — needs ${need}/3 (V1+TA+ATLAS, explicit BUY only)`
  };
}

/** Append one ensemble shadow row (V1-pass candidates only — bounded by
 *  entry rarity, like shadow-trades.jsonl). Best effort, never throws. */
function recordEnsembleShadow(row) {
  try {
    fs.appendFileSync(ensembleShadowFile, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, row)) + '\n');
  } catch (_) { /* diagnostics must never block a trade */ }
}

/* ------------------------------------------------------------------ *
 * Ensemble verdict memory (in-memory only, never persisted).
 *
 * Research layers serve cached rows for cacheTtlMs (60 s default) while
 * discovery scans run far more often — most scans carry NO fresh verdict.
 * Without memory the gate would degrade to V1-only almost always (and
 * ENFORCE would be inert). Memory replays the latest verdict per mint while
 * younger than that layer's own cache TTL — exactly what the layers
 * themselves serve (tradingAgents.lastResultFor) — and prunes anything older.
 * Stale-sourced votes are flagged on the shadow row and in the log.
 * ------------------------------------------------------------------ */

const ENSEMBLE_MEM_TA = new Map();    // mint -> { rec, ts }
const ENSEMBLE_MEM_ATLAS = new Map(); // mint -> { rec, ts }
const ENSEMBLE_MEM_PRUNE_N = 500;

function ensembleMemRemember(map, mint, rec, now) {
  if (!mint || rec == null) return;
  map.set(mint, { rec: String(rec), ts: now });
  if (map.size > ENSEMBLE_MEM_PRUNE_N) {
    const oldest = Array.from(map.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) map.delete(oldest[0]);
  }
}

function ensembleMemPrune(map, maxAgeMs, now) {
  for (const [mint, e] of map) {
    if (!e || !(e.ts > now - maxAgeMs)) map.delete(mint);
  }
}

/** Resolve one layer's vote: fresh verdict wins, else remembered verdict
 *  within ttlMs (stale:true), else null. Returns { rec, stale }. */
function ensembleResolveVote(freshRec, mem, mint, ttlMs, now) {
  if (freshRec != null) return { rec: String(freshRec), stale: false };
  const m = mem.get(mint);
  if (m && m.rec != null && now - m.ts <= ttlMs) return { rec: m.rec, stale: true };
  return { rec: null, stale: false };
}

/**
 * TradingAgents research context — REAL observed state only. The research
 * layer consumes the same regime/health/integrity verdicts as the strategy
 * (it never replaces them) and never receives any data it could fabricate.
 */
function buildTradingAgentsContext(valid) {
  const now = Date.now();
  const closed = closedTrades();
  const week = closed.filter((t) => t.exitTs >= now - 7 * perfLib.MS_DAY);
  const metrics = perfLib.computeMetrics(week, portfolio.startingCapitalSol);
  const reg = currentRegime();
  const health = adaptiveState.health; // may be null when adaptive is disabled
  const vols = valid.map((c) => Number(c.volume24hUsd) || 0).filter((v) => v > 0);
  const avgVolumeUsd = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const historyByMint = {};
  for (const c of valid) {
    const h = history.get(c.mint);
    historyByMint[c.mint] = { samples: h ? h.samples.slice(-40) : [], warming: c.recoveryStatus === 'warming' };
  }
  for (const pos of portfolio.positions) {
    const h = history.get(pos.mint);
    if (!historyByMint[pos.mint]) historyByMint[pos.mint] = { samples: h ? h.samples.slice(-40) : [], warming: false };
  }
  return {
    portfolio: {
      positionsOpen: portfolio.positions.length,
      maxPositions: MAX_POSITIONS,
      totalTrades: portfolio.totalTrades,
      realizedPnlSol: portfolio.realizedPnlSol,
      winRate: portfolio.winRate,
      cashSol: portfolio.cashSol,
      equitySol: portfolio.equitySol,
      startingCapitalSol: portfolio.startingCapitalSol,
      lossStreak: metrics.lossStreak,
      maxDrawdownPct: metrics.maxDrawdownPct
    },
    metrics,
    regime: { regime: reg.regime, confidence: reg.confidence, reasoning: reg.reasoning },
    health: health ? { score: health.score, status: health.status, gate: health.gate, reason: health.reason } : null,
    market: { solPriceUsd: lastSolPriceUsd, solMomentumPct: null },
    integrity: priceIntegrity ? priceIntegrity.snapshot() : null,
    historyByMint,
    universe: { candidates: valid.length, avgVolumeUsd }
  };
}

/**
 * ATLAS research context — same facts as TradingAgents but structured for the
 * ATLAS staged pipeline. ATLAS consumes the existing price-integrity verdict
 * (never duplicates it). No future data is used.
 */
function buildAtlasContext(valid) {
  const now = Date.now();
  const closed = closedTrades();
  const week = closed.filter((t) => t.exitTs >= now - 7 * perfLib.MS_DAY);
  const metrics = perfLib.computeMetrics(week, portfolio.startingCapitalSol);
  const reg = currentRegime();
  const health = adaptiveState.health;
  const vols = valid.map((c) => Number(c.volume24hUsd) || 0).filter((v) => v > 0);
  const avgVolumeUsd = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const historyByMint = {};
  for (const c of valid) {
    const h = history.get(c.mint);
    historyByMint[c.mint] = { samples: h ? h.samples.slice(-40) : [], warming: c.recoveryStatus === 'warming' };
  }
  for (const pos of portfolio.positions) {
    const h = history.get(pos.mint);
    if (!historyByMint[pos.mint]) historyByMint[pos.mint] = { samples: h ? h.samples.slice(-40) : [], warming: false };
  }
  return {
    portfolio: {
      positionsOpen: portfolio.positions.length,
      maxPositions: MAX_POSITIONS,
      totalTrades: portfolio.totalTrades,
      realizedPnlSol: portfolio.realizedPnlSol,
      winRate: portfolio.winRate,
      cashSol: portfolio.cashSol,
      equitySol: portfolio.equitySol,
      startingCapitalSol: portfolio.startingCapitalSol,
      lossStreak: metrics.lossStreak,
      maxDrawdownPct: metrics.maxDrawdownPct
    },
    metrics,
    regime: { regime: reg.regime, confidence: reg.confidence, reasoning: reg.reasoning },
    health: health ? { score: health.score, status: health.status, gate: health.gate, reason: health.reason } : null,
    market: { solPriceUsd: lastSolPriceUsd, solMomentumPct: null },
    integrity: priceIntegrity ? priceIntegrity.snapshot() : null,
    historyByMint,
    universe: { candidates: valid.length, avgVolumeUsd },
    tradeSizeSol: config.tradeSizeSol
  };
}

async function discoveryOnce() {
  if (discoveringActive) return;
  discoveringActive = true;
  try {
    portfolio.scans += 1;
    portfolio.lastScanAt = Date.now();

    let candidates = [];
    try {
      candidates = await market.discoverCandidates();
    } catch (err) {
      pushError('DISCOVERY-SKIP', `discovery failed: ${err.message}`);
      adaptiveState.discoveryFailures = (adaptiveState.discoveryFailures || 0) + 1;
      writeCandidatesFile([]);
      recalculate(portfolio);
      persist();
      writeHeartbeat('running');
      return;
    }

    // Keep only real, valid Solana mints.
    const valid = candidates.filter((c) =>
      marketDataLib.isValidSolanaAddress(c.mint) &&
      Number.isFinite(c.priceUsd) && c.priceUsd > 0 &&
      Number.isFinite(c.priceSol) && c.priceSol > 0 &&
      Number.isFinite(c.change1hPct) && Number.isFinite(c.change5mPct));

    // Healthy discovery → reset the failure counter + record scan quality for
    // the market-health proxy.
    adaptiveState.discoveryFailures = 0;
    adaptiveState.lastScanQuality = {
      candidates: valid.length,
      withLiquidity: valid.filter((c) => Number.isFinite(c.liquidityUsd) && c.liquidityUsd > 0).length
    };

    // Sampling universe = this scan's candidates + open positions.
    sampleUniverse = new Set(valid.map((c) => c.mint));
    for (const pos of portfolio.positions) sampleUniverse.add(pos.mint);

    // Calibrated P(win) — Laplace NB retrained per scan from ALL closed
    // trades (global pool, no cluster split). Below minTrain the model is
    // null and the gate fails open. Threshold tuned for PROFIT FACTOR per
    // scan (fixed override via CIRCUIT_WINPROB_THRESHOLD).
    let winprobModel = null;
    let winprobThreshold = 0.5;
    try {
      if (!winprobEnabled) {
        log('[WINPROB] disabled (CIRCUIT_WINPROB_DISABLE=1) — gate open');
      } else {
        const wClosed = closedTrades();
        winprobModel = gatesLib.trainWinProb(wClosed, { minTrain: winprobMinTrades });
        if (winprobModel) {
          if (winprobFixedThreshold != null) {
            winprobThreshold = winprobFixedThreshold;
            log(`[WINPROB] n=${winprobModel.n} th=${winprobThreshold.toFixed(2)} (fixed) prior=${winprobModel.priorW.toFixed(2)}`);
          } else {
            const tuned = gatesLib.tuneThreshold(winprobModel, wClosed, {});
            winprobThreshold = tuned.threshold;
            log(`[WINPROB] n=${winprobModel.n} th=${winprobThreshold.toFixed(2)}${tuned.fallback ? ' (default)' : ` (tuned PF ${tuned.stats.profitFactor})`} prior=${winprobModel.priorW.toFixed(2)}`);
          }
        } else {
          log(`[WINPROB] warming (${wClosed.length}/${winprobMinTrades} closed trades) — gate open`);
        }
      }
    } catch (err) {
      pushError('WINPROB', `model train/tune failed (${err.message}) — gate open`);
      winprobModel = null;
    }

    // Local 5m recovery (never the discovery API's value) + score + NATR.
    for (const c of valid) {
      const rec = compute5mRecovery(c.mint);
      c.recoveryPct = rec.warming ? null : rec.pct;
      c.recoveryStatus = rec.warming ? 'warming' : 'ok';
      c.recoverySamples = rec.samples;
      const nr = computeNatr(history.get(c.mint) ? history.get(c.mint).samples : []);
      c.natr = nr.ok ? round(nr.natr, 2) : null;
      c.natrN = nr.ok ? nr.n : (nr.n || 0);
      c.natrReject = null;
      if (c.natr != null) {
        const ng = passesNatrGate(c.natr);
        if (!ng.allow) c.natrReject = ng.reason;
      }
      // Order-flow / valuation snapshot (pure on discovery fields — no
      // staleness concern; the BUY gate reads c.quality directly).
      c.quality = evaluateOrderflow(c);
      // Bounce snapshot for the scan log (recomputed fresh at the BUY gate —
      // the sampler appends concurrently while research runs).
      confirmBounceFor(c);
      evaluateRsiVwapFor(c);
      c.score = computeScore({
        change1hPct: c.change1hPct,
        recoveryPct: c.recoveryPct,
        liquidityUsd: c.liquidityUsd,
        volume24hUsd: c.volume24hUsd
      });
      // Calibrated P(win) for the scan log + BUY row (null while warming).
      // AFTER computeScore: the model reads c.score.
      c.pWin = null;
      if (winprobModel) {
        try {
          const p = gatesLib.predictWinProb(winprobModel, c);
          c.pWin = Number.isFinite(p) ? round(p, 4) : null;
        } catch (_) { c.pWin = null; }
      }
    }

    log(`[SCAN #${portfolio.scans}] ${valid.length} real candidate(s)`);
    for (const c of valid) {
      const rec5 = c.recoveryStatus === 'warming'
        ? `warming(${c.recoverySamples} samples)`
        : `${sign(c.recoveryPct)}${c.recoveryPct.toFixed(2)}%`;
      const natrS = c.natr != null ? ` natr=${c.natr.toFixed(2)}%` : '';
      const confS = c.bounce && c.bounce.confirmed ? ' conf=ok' : ' conf=no';
      const qS = c.quality && c.quality.sellsBuysRatio != null
        ? ` s/b=${c.quality.sellsBuysRatio.toFixed(2)} lm=${c.quality.liqMcapPct != null ? c.quality.liqMcapPct.toFixed(1) + '%' : 'n/a'}`
        : '';
      const rsiS = c.rsi && c.rsi.rsi != null ? ` rsi=${c.rsi.rsi.toFixed(1)}` : (c.rsi && c.rsi.rsiWarming ? ' rsi=warming' : '');
      const pS = c.pWin != null ? ` p=${c.pWin.toFixed(2)}` : '';
      log(`  ${c.symbol} score=${c.score} 1h=${sign(c.change1hPct)}${c.change1hPct.toFixed(2)}% ` +
        `5m=${rec5}${natrS}${confS}${qS}${rsiS}${pS} price=${fmtUsd(c.priceUsd)} priceSOL=${c.priceSol.toFixed(12)} ` +
        `liq=${fmtCompact(c.liquidityUsd)} vol=${fmtCompact(c.volume24hUsd)} src=${c.source}`);
    }

    // BUY pass — every gate must pass; NO TRADE on missing/uncertain data.
    const ranked = valid.slice().sort((a, b) =>
      (b.score - a.score) || ((b.recoveryPct || 0) - (a.recoveryPct || 0)));

    // ---- Adaptive session policy + market-health gate (deterministic) -----
    // V1 baseline when the policy is missing/expired: active, minScore 60,
    // full position cap. Learned gates may only TIGHTEN (never loosen V1).
    let eff = { mode: 'active', minScore: MIN_SCORE, maxBuys: MAX_POSITIONS, fresh: false, reason: 'adaptive disabled — V1 baseline' };
    let health = null;
    let buysThisSession = 0;
    if (adaptiveEnabled()) {
      eff = adaptivePolicy.effectiveGates(adaptiveState.policy, { maxPositions: MAX_POSITIONS });
      health = computeMarketHealth();
      buysThisSession = (adaptiveState.policy && adaptiveState.policy.buysThisSession) || 0;
      const sz = (adaptiveState.policy && adaptiveState.policy.sizeMultiplier) != null ? adaptiveState.policy.sizeMultiplier : 1.0;
      log(`[POLICY] mode=${eff.mode} minScore=${eff.minScore} maxBuys=${eff.maxBuys} regime=${currentRegime().regime} size=${sz}x health=${health.score}/100 (${health.status})${eff.fresh ? '' : ' — V1 fallback'}`);
      // Stale watchOnly override: if the persisted policy is watchOnly but the
      // current (freshly-detected) regime recommends entries, and the block is
      // NOT from a legitimate halt (daily loss / circuit breaker), fall back to
      // the regime-appropriate strategy. This prevents a stale policy from an
      // old recovery/dump regime blocking the entire next 90-min window.
      if (eff.mode === 'watchOnly') {
        const curRegime = currentRegime();
        const regimeRec = regimeLib.strategyForRegime(curRegime.regime, { maxPositions: MAX_POSITIONS });
        const isLegitHalt = /daily loss halt|circuit breaker/i.test(String(eff.reason || ''));
        if (!isLegitHalt && regimeRec.mode !== 'watchOnly') {
          const oldReason = eff.reason;
          eff = {
            mode: regimeRec.mode,
            minScore: Math.max(eff.minScore || MIN_SCORE, regimeRec.minScore || MIN_SCORE),
            maxBuys: regimeRec.maxBuys,
            fresh: true,
            reason: `stale watchOnly overridden by current regime (${curRegime.regime})`
          };
          log(`[POLICY] stale watchOnly overridden → mode=${eff.mode} maxBuys=${eff.maxBuys} (was: ${oldReason})`);
        }
      }
    }
    // Promoted global entry bands (non-V1 baseline) — one line per scan so
    // the active tightening is always visible next to FILTER reasons.
    if (adaptiveEnabled() && adaptiveState.bandsBase) {
      const bb = adaptiveState.bandsBase;
      const isV1 = bb.min1h === gatesLib.V1.min1h && bb.max1h === gatesLib.V1.max1h && bb.min5m === gatesLib.V1.min5m && bb.max5m === gatesLib.V1.max5m;
      if (!isV1) log(`[BASELINE] entry bands 1h (${bb.min1h}..${bb.max1h}) 5m (${bb.min5m}..${bb.max5m}) — ${adaptiveState.bandsVersion}`);
    }
    const policyBlocked = eff.mode === 'watchOnly';
    const healthBlocked = !!(health && health.gate);
    if (healthBlocked) log(`[MARKET-HEALTH] gate active: ${health.reason} — blocking new entries this scan`);
    const regimeNow = currentRegime().regime;

    // ---- TradingAgents RESEARCH (advisory — see tradingagents-layer.js). ----
    // Runs BEFORE the BUY pass so every candidate that may be bought already
    // has a recorded research decision. It never gates, alters, or blocks the
    // Circuit BUY pass; a research failure is isolated and ignored.
    let taRows = [];
    let taResearchByMint = null;
    if (tradingAgents && tradingAgents.enabled() && (ranked.length || portfolio.positions.length)) {
      try {
        tradingAgents.tickCycleStart();
        const taCtx = buildTradingAgentsContext(valid);
        const cycle = tradingAgents.runCycle({
          candidates: ranked.slice(0, config.tradingAgents.maxCandidatesPerCycle),
          positions: portfolio.positions,
          ctx: taCtx
        });
        taRows = cycle.rows || [];
      } catch (err) {
        pushError('TA', `research cycle failed: ${err.message}`);
        taRows = [];
      }
    }
    const taByMint = new Map();
    for (const row of taRows) {
      if (row && row.type === 'candidate' && row.mint && !taByMint.has(row.mint)) taByMint.set(row.mint, row);
    }
    const nowScan = Date.now();
    for (const [mint, row] of taByMint) ensembleMemRemember(ENSEMBLE_MEM_TA, mint, row.researchRecommendation, nowScan);

    // ---- ATLAS INTELLIGENCE RESEARCH (parallel, advisory; default SHADOW) ----
    // Runs BEFORE the BUY pass so the ensemble gate can read ATLAS verdicts
    // alongside TradingAgents rows. Inputs are pre-decision candidate facts
    // only (score/history/market — never c.decision), so verdicts carry no
    // look-ahead; integrity snapshot is consumed (never duplicated).
    let atlasCycle = null;
    const atlasByMint = new Map();
    if (atlas && atlas.enabled() && ranked.length) {
      try {
        const atlasCtx = buildAtlasContext(valid);
        atlasCycle = atlas.runCycle({
          candidates: ranked.slice(0, config.atlas.maxCandidatesPerCycle),
          ctx: atlasCtx
        });
        if (atlasCycle.decisions && atlasCycle.decisions.length) {
          for (const d of atlasCycle.decisions) {
            if (d && d.type === 'candidate' && d.mint && !atlasByMint.has(d.mint)) atlasByMint.set(d.mint, d);
          }
          for (const [mint, d] of atlasByMint) {
            ensembleMemRemember(ENSEMBLE_MEM_ATLAS, mint, d && d.synthesis ? d.synthesis.researchRecommendation : null, nowScan);
          }
          const top = atlasCycle.decisions.find((r) => r.type === 'candidate');
          if (top) {
            log(`[ATLAS] ${top.symbol} research=${top.atlas.score} rec=${top.synthesis.researchRecommendation} consensus=${top.atlas.consensus} risk=${top.atlas.riskLevel} dataQuality=${top.atlas.dataQuality} V1=${top.v1.score} (mode=${config.atlas.mode})`);
          }
          // Log prediction lifecycle for each prediction created
          for (const pred of atlasCycle.predictions) {
            if (pred && pred.predictionId) {
              log(`[ATLAS-PRED] id=${pred.predictionId} agent=${pred.agent} dir=${pred.direction} conf=${pred.confidence} mint=${pred.mint} ts=${pred.ts}`);
            }
          }
        }
        // ---- ATLAS horizon-based outcome resolution -------------------------
        // Resolve ATLAS predictions independently of V1 trades.
        // Uses only real local market-history observations at the prediction's
        // declared horizon. This keeps ATLAS shadow evaluation independent of
        // V1 execution and avoids selection/look-ahead bias.
        if (typeof atlas.resolvePendingPredictions === 'function') {
          try {
            // Horizon resolution contract (P1-01 / Phase 5): resolve each
            // matured prediction with the EARLIEST real observation at or
            // AFTER its target timestamp, within a bounded late tolerance.
            // Pre-target observations are never used; no price is fabricated.
            const resolvePrice = (mint, targetTs, pred) => {
              if (!researchHistory) return null;
              const preferPair = pred && typeof pred.pairAddress === 'string' ? pred.pairAddress : null;
              return researchHistory.resolveAtOrAfter(mint, targetTs, { preferPairAddress: preferPair });
            };

            const atlasResolution = atlas.resolvePendingPredictions(
              resolvePrice,
              Date.now()
            );

            if (atlasResolution) {
              log(
                `[ATLAS-RESOLVE] resolved=${atlasResolution.resolved} ` +
                `pending=${atlasResolution.pending} ` +
                `skipped=${atlasResolution.skipped}`
              );
            }
          } catch (err) {
            pushError(
              'ATLAS-RESOLVE',
              `prediction resolution failed: ${err.message}`
            );
          }
        }

        // Persist checkpoints + daily snapshots after each ATLAS cycle
        if (typeof atlas.persistCheckpoint === 'function') {
          try { atlas.persistCheckpoint(); } catch (_) { /* best effort */ }
        }
      } catch (err) {
        pushError('ATLAS', `research cycle failed: ${err.message}`);
      }
    }
    // Verdict memory bounds: each layer's own cache TTL caps how long a
    // remembered vote may gate (fresh verdicts always win). Pruned per scan.
    const taTtlMs = Math.max(0, Number(config.tradingAgents.cacheTtlMs) || 60000);
    const atlasTtlMs = Math.max(0, Number(config.atlas.cacheTtlMs) || 60000);
    ensembleMemPrune(ENSEMBLE_MEM_TA, Math.max(taTtlMs, 1000), Date.now());
    ensembleMemPrune(ENSEMBLE_MEM_ATLAS, Math.max(atlasTtlMs, 1000), Date.now());

    const tryCandidate = async (c) => {
      c.decision = 'FILTER';
      // Funnel visibility: true once the candidate clears the full
      // entry-quality stack (score→bands→bounce→RSI→liq/vol→quality→NATR).
      // Log-only signal, returned to the caller; never gates anything.
      let stackPassed = false;
      if (portfolio.positions.length >= MAX_POSITIONS) {
        c.reason = 'max positions reached';
      } else if (healthBlocked) {
        c.reason = 'market health gate';
      } else if (eff.maxBuys != null && buysThisSession >= eff.maxBuys) {
        c.reason = 'session buy cap reached';
      } else {
        // Learned gates per cluster (regime|timeOfDay|liquidityClass) — global
        // baseline bands (promoted bandsBase, else V1) tightened further by
        // any PROMOTED per-cluster gate.
        const clusterKey = gatesLib.clusterKeyOf({
          regime: regimeNow,
          timeOfDay: perfLib.timeOfDayOf(c.fetchedAt || Date.now()),
          liqClass: perfLib.liqClassOf(c.liquidityUsd)
        });
        const learned = gatesLib.effectiveGates(adaptiveState.gates, clusterKey, { gateConfidenceThreshold: config.adaptive.gateConfidenceThreshold }, adaptiveState.bandsBase);
        c.adaptiveGates = learned.applied;
        c.adaptiveMinScore = Math.max(eff.minScore, learned.gates.minScore);
        const { min1h, max1h, min5m, max5m } = learned.gates;
        // Thompson bandit arm for this cluster (live only after workflow
        // approval; default 60 = V1 floor on thin/unknown clusters).
        c.banditArm = null;
        if (banditLiveActive()) {
          c.banditArm = gatesLib.banditEffectiveArm((adaptiveState.banditArms || {})[clusterKey]);
        }
        if (c.score < c.adaptiveMinScore) { c.reason = `score below threshold (min ${c.adaptiveMinScore})`; }
        else if (c.banditArm != null && c.score < c.banditArm) {
          // Per-cluster Thompson-selected floor — stricter than (never
          // looser than) the V1/adaptive floor above.
          c.reason = `bandit minScore ${c.banditArm} (cluster ${clusterKey})`;
        }
        else if (winprobModel && c.pWin != null && c.pWin < winprobThreshold) {
          // Calibrated P(win) — Laplace NB over entry features, threshold
          // tuned for profit factor. Reject-only: never loosens any V1 gate.
          c.reason = `winprob ${c.pWin.toFixed(2)} < ${winprobThreshold.toFixed(2)} (n=${winprobModel.n})`;
        }
        else if (c.change1hPct <= min1h || c.change1hPct > max1h) { c.reason = `1h change outside range (${min1h}..${max1h})`; }
        else if (c.recoveryStatus === 'warming') { c.reason = `5m recovery warming (${c.recoverySamples} samples)`; }
        else if (c.recoveryPct < min5m || c.recoveryPct > max5m) { c.reason = `5m recovery outside range (${min5m}..${max5m})`; }
        else if (confirmEnabled && !confirmBounceFor(c).confirmed) {
          // Bounce must be alive NOW: 2 consecutive rising 15 s closes plus
          // a rising 5-minute slope — a single-point print or a stalled
          // bounce never buys, even inside the 5m-recovery band.
          c.reason = `bounce unconfirmed (${c.bounce.reason})`;
        }
        else if (rsiVwapEnabled && !evaluateRsiVwapFor(c).ok) {
          // Dip-only: 14-minute RSI oversold-turning plus reclaim of the
          // trailing-5-minute mean. RSI warms up (~15 min); VWAP always
          // decides once 5m history exists.
          c.reason = c.rsi.reason;
        }
        else if (!(Number.isFinite(c.liquidityUsd) && c.liquidityUsd >= MIN_LIQUIDITY_USD)) {
          c.reason = `liquidity below minimum ($${MIN_LIQUIDITY_USD.toLocaleString()})`;
        }
        else if (!(Number.isFinite(c.volume24hUsd) && c.volume24hUsd >= MIN_VOLUME_24H_USD)) {
          c.reason = `24h volume below minimum ($${MIN_VOLUME_24H_USD.toLocaleString()})`;
        }
        else if (qualityEnabled && c.quality && !c.quality.ok) {
          // Order-flow / valuation: distribution into strength and
          // unexitable thinness reject. Missing txns/mcap fail open (the
          // absolute liquidity floor above still applies).
          c.reason = c.quality.reason;
        }
        else if (atrEnabled && c.natrReject) {
          // Volatility reject: the trailing excursion is so wide that a
          // fixed-style stop would gap — skip instead of sizing a stop that
          // cannot hold. Unknown NATR fails open (fixed V1 stops at BUY).
          c.reason = c.natrReject;
        }
        else if (portfolio.positions.some((p) => p.mint === c.mint)) { c.reason = 'already holding'; }
        else {
          stackPassed = true;
          const cd = inCooldown(c.mint);
          if (cd > 0) { c.reason = `re-entry cooldown (${Math.round(cd / 1000)}s remaining)`; }
          else if (portfolio.cashSol < (adaptiveEnabled() ? config.adaptive.maxTradeSizeSol : config.tradeSizeSol)) { c.reason = 'insufficient cash'; }
          else {
            // Ensemble 2/3 (V1 + TradingAgents + ATLAS) — precision over recall.
            // V1 has passed everything above (v1 vote = agree). Votes prefer
            // fresh verdicts, else remembered ones within each layer's cache
            // TTL (stale:true); absent everywhere counts as disagree. SHADOW
            // records and never blocks; ENFORCE FILTERs below minAgree. No
            // verdict anywhere for this mint degrades to V1-only (liveness).
            const ensMode = (config.ensemble && config.ensemble.mode) || 'SHADOW';
            const ensNeed = (config.ensemble && config.ensemble.minAgree) || 2;
            if (ensMode !== 'OFF') {
              const nowEns = Date.now();
              const taFresh = taByMint.has(c.mint) ? taByMint.get(c.mint).researchRecommendation : null;
              const aDec = atlasByMint.has(c.mint) ? atlasByMint.get(c.mint) : null;
              const atlasFresh = aDec && aDec.synthesis ? aDec.synthesis.researchRecommendation : null;
              const taV = ensembleResolveVote(taFresh, ENSEMBLE_MEM_TA, c.mint, taTtlMs, nowEns);
              const atlasV = ensembleResolveVote(atlasFresh, ENSEMBLE_MEM_ATLAS, c.mint, atlasTtlMs, nowEns);
              const ens = evaluateEnsemble({ v1: true, ta: taV.rec, atlas: atlasV.rec }, { minAgree: ensNeed });
              const degraded = taV.rec == null && atlasV.rec == null;
              c.ensemble = { agrees: ens.agrees, needed: ens.needed, wouldAllow: ens.allow, votes: ens.who, degraded };
              const blocked = ensMode === 'ENFORCE' && !ens.allow && !degraded;
              const staleS = [taV.stale ? 'TA' : null, atlasV.stale ? 'ATLAS' : null].filter(Boolean).join('+');
              recordEnsembleShadow({
                scan: portfolio.scans, mint: c.mint, symbol: c.symbol,
                v1: true, ta: taV.rec, atlas: atlasV.rec,
                taStale: taV.stale, atlasStale: atlasV.stale, degraded,
                agrees: ens.agrees, needed: ens.needed, wouldAllow: ens.allow,
                mode: ensMode, blocked
              });
              log(`[ENSEMBLE] ${c.symbol} ${ens.agrees}/3 (${ens.who.join('+') || 'none'}) → ${ens.allow ? 'allow' : 'would-block'} [${ensMode}]${staleS ? ' stale=' + staleS : ''}${degraded ? ' degraded-V1-only' : ''}`);
              if (blocked) {
                c.reason = `ensemble ${ens.agrees}/3 — needs ${ens.needed}/3 (V1+TA+ATLAS, explicit BUY only)`;
                log(`[FILTER] ${c.symbol} ${c.reason}`);
                return stackPassed;
              }
            }
            // Fresh price at decision time — valid, fresh, real.
            let info = null;
            try {
              const prices = await market.fetchTokenPrices([c.mint]);
              info = prices.get(c.mint);
            } catch (err) {
              pushError('PRICE-FALLBACK', `price fetch failed for ${c.symbol}: ${err.message}`);
            }
            if (!info) {
              c.reason = 'price unavailable';
            } else {
              const gate = evaluatePriceGate(info, maxPriceAgeMs);
              if (!gate.ok) {
                c.reason = gate.reason;
              } else if (executePaperBuy(c, info)) {
                c.decision = 'BUY';
                c.reason = null;
                buysThisSession += 1;
              } else {
                c.reason = 'buy rejected (accounting)';
              }
            }
          }
        }
      }
      if (c.decision === 'FILTER') log(`[FILTER] ${c.symbol} ${c.reason}`);
      return stackPassed;
    };

    if (policyBlocked) {
      log('[POLICY] watchOnly mode — scanning only, no entries this window');
      for (const c of ranked) {
        c.decision = 'FILTER';
        c.reason = 'watchOnly mode — session policy blocks entries';
      }
    } else {
      for (const c of ranked) {
        if (eff.mode === 'selective' && ranked.indexOf(c) >= SELECTIVE_CANDIDATE_LIMIT) {
          c.decision = 'FILTER';
          c.reason = `selective mode — top ${SELECTIVE_CANDIDATE_LIMIT} candidates only`;
          log(`[FILTER] ${c.symbol} ${c.reason}`);
          continue;
        }
        const stackPassed = await tryCandidate(c);
        // Funnel visibility (log-only, never gates): the full entry-quality
        // stack passed but no BUY followed (situational block: selective rank,
        // cooldown, ensemble, fresh-price gate, accounting…).
        if (stackPassed && c.decision !== 'BUY') {
          const rsiV = c.rsi && Number.isFinite(c.rsi.rsi) ? c.rsi.rsi.toFixed(1) : 'n/a';
          log(`[STACK-PASS] ${c.symbol} top=${c === ranked[0]} score=${c.score} ` +
            `rsi=${rsiV} natr=${c.natr != null ? Number(c.natr).toFixed(2) + '%' : 'n/a'} → ${c.reason}`);
        }
      }
    }

    // Commit the research decisions now that the Circuit BUY pass is done —
    // each row records researchScore vs the real circuitDecision. Advisory
    // warnings are logged beside decisions; they never gate anything.
    if (taRows.length && tradingAgents) {
      try {
        for (const row of taRows) {
          if (row.type !== 'candidate' || !row._cand) continue;
          const d = row._cand.decision || 'FILTER';
          row.circuitDecision = d === 'BUY' ? 'BUY' : 'FILTER';
        }
        tradingAgents.commit(taRows);
        const topRow = taRows.find((r) => r.type === 'candidate');
        if (topRow) {
          log(`[TA] ${topRow.symbol} research=${topRow.researchScore} rec=${topRow.researchRecommendation} consensus=${topRow.consensus} risk=${topRow.riskLevel} dataQuality=${topRow.dataQuality} circuit=${topRow.circuitDecision} (mode=${config.tradingAgents.mode})`);
        }
        if (config.tradingAgents.mode === 'ADVISORY') {
          for (const row of taRows) {
            for (const w of (row.warnings || [])) log(`[TA] ${row.symbol} warning: ${w}`);
          }
        }
        // Optional async LLM narrative on the top candidate (never blocking,
        // never required — deterministic research stands on any failure).
        const llmCfg = (config.adaptive && config.adaptive.llm) || {};
        if (llmCfg.url && taRows.some((r) => r.type === 'candidate')) {
          tradingAgents.enrichTopRow(taRows).catch(() => {});
        }
        // ADVISORY: attach research beside Circuit decisions in candidates.json.
        if (config.tradingAgents.mode === 'ADVISORY') {
          taResearchByMint = new Map();
          for (const row of taRows) {
            if (row.type !== 'candidate') continue;
            const last = tradingAgents.lastResultFor(row.mint);
            if (last) taResearchByMint.set(row.mint, last);
          }
        }
      } catch (err) {
        pushError('TA', `research commit failed: ${err.message}`);
      }
    }

    // ---- Counterfactual outcome resolution (§5) -------------------------
    // Attempt to resolve any previously recorded predictions whose
    // time horizon has elapsed. Uses real market data only.
    if (tradingAgents && tradingAgents.enabled()) {
      try {
        const cf = tradingAgents.getCounterfactual();
        if (cf && typeof cf.resolveAll === 'function') {
          const resolvePrice = (mint, targetTs) => {
            /* Horizon contract (P1-01/Phase 5): the research resolver returns
             * the earliest REAL observation at or AFTER the target. A sample
             * before the target would leak pre-horizon information, so it is
             * never acceptable here. Null → NO_VALID_OBSERVATION. */
            if (!researchHistory) return null;
            const obs = researchHistory.resolveAtOrAfter(mint, targetTs);
            return obs ? obs.priceSol : null;
          };
          cf.resolveAll(resolvePrice, Date.now());
        }
      } catch (_) { /* best effort — resolution failure never blocks the scan */ }
    }

    writeCandidatesFile(valid, taResearchByMint);
  } catch (err) {
    pushError('SCAN ERROR', `discovery scan failed: ${err.message}`);
  } finally {
    recalculate(portfolio);
    persist();
    recordEquityHistory();
    writeHeartbeat('running');
    discoveringActive = false;
  }
}

function writeCandidatesFile(candidates, researchByMint) {
  try {
    atomicWriteJson(candidatesFile, {
      scannedAt: Date.now(),
      scan: portfolio.scans,
      count: candidates.length,
      openPositions: portfolio.positions.length,
      maxPositions: MAX_POSITIONS,
      candidates: candidates.map((c) => {
        const research = researchByMint ? researchByMint.get(c.mint) : null;
        return {
          symbol: c.symbol,
          mint: c.mint,
          score: c.score,
          change1hPct: c.change1hPct,
          recoveryPct: c.recoveryPct,
          recoveryStatus: c.recoveryStatus,
          recoverySamples: c.recoverySamples,
          natr: c.natr,
          natrN: c.natrN,
          bounce: c.bounce || null,
          txBuys: c.txBuys,
          txSells: c.txSells,
          fdvUsd: c.fdvUsd,
          marketCapUsd: c.marketCapUsd,
          quality: c.quality && !c.quality.ok ? c.quality.reason : null,
          rsi: c.rsi || null,
          pWin: c.pWin,
          ensemble: c.ensemble || null,
          priceUsd: c.priceUsd,
          priceSol: c.priceSol,
          liquidityUsd: c.liquidityUsd,
          volume24hUsd: c.volume24hUsd,
          source: c.source,
          decision: c.decision,
          reason: c.reason || null,
          adaptiveMinScore: c.adaptiveMinScore != null ? c.adaptiveMinScore : null,
          adaptiveGates: c.adaptiveGates && c.adaptiveGates.length ? c.adaptiveGates : null,
          // ADVISORY mode only: research results beside the Circuit decision.
          research: research ? {
            score: research.researchScore,
            recommendation: research.researchRecommendation,
            consensus: research.consensus,
            riskLevel: research.riskLevel,
            dataQuality: research.dataQuality,
            ts: research.ts
          } : undefined
        };
      })
    });
  } catch (err) {
    log(`WARN could not write candidates.json (${err.message})`);
  }
}

/* ------------------------------------------------------------------ *
 * Adaptive loops — agent-loop (session policy, ~90 min) + reflection
 * (learning, ~4h). Both deterministic; the LLM hook is async + advisory.
 * ------------------------------------------------------------------ */

let agentLoopActive = false;
let reflectionActive = false;

function buildAgentLoopBrief({ metrics, regime, closed }) {
  const lines = [];
  lines.push(`Regime: ${regime.regime} (confidence ${Math.round((regime.confidence || 0) * 100)}%)`);
  lines.push(`Reasoning: ${regime.reasoning}`);
  lines.push(`7d trades: ${metrics.n}, win rate ${metrics.winRate}%, expectancy ${metrics.expectancyPct}%`);
  lines.push(`Loss streak: ${metrics.lossStreak}, max drawdown ${metrics.maxDrawdownPct}%`);
  lines.push(`Open positions: ${portfolio.positions.length}/${MAX_POSITIONS}`);
  lines.push(`Session buys: ${(adaptiveState.policy && adaptiveState.policy.buysThisSession) || 0}`);
  lines.push('PAPER ONLY — wallet/signer/broadcast disabled. Reply with JSON: mode (active|selective|watchOnly), minScore (60-90), maxBuys (0-3), reason.');
  return lines.join('\n');
}

/** Evaluate any experiments currently in SHADOW (hypothetical replay). */
function evaluateShadowExperiments(closed) {
  const results = [];
  const list = experiments.loadExperiments(dataDir);
  for (const exp of list) {
    if (exp.state !== 'SHADOW') continue;
    try {
      const r = experiments.evaluateShadow(dataDir, exp, closed, {
        shadowMinTrades: config.adaptive.shadowMinTrades,
        autoApply: config.adaptive.autoApply,
        tolerances: {}
      });
      results.push({ id: exp.id, state: r.state });
    } catch (err) {
      pushError('SHADOW', `shadow evaluation failed for ${exp.id}: ${err.message}`);
    }
  }
  return results;
}

async function agentLoopTick() {
  if (!adaptiveEnabled()) return;
  if (agentLoopActive) return;
  agentLoopActive = true;
  try {
    const now = Date.now();
    const closed = closedTrades();
    const weekTrades = closed.filter((t) => t.exitTs >= now - 7 * perfLib.MS_DAY);
    const metrics = perfLib.computeMetrics(weekTrades);

    // 1. Market health first (regime breadth reads it fresh below).
    computeMarketHealth();

    // 2. Regime detection from MARKET (SOL trend + discovery breadth),
    // persisted with TTL. Never own-PnL-driven (reflexive/laggy).
    const q = adaptiveState.lastScanQuality || {};
    const regime = regimeLib.detectAndSave(dataDir, {
      sol1h: adaptiveState.solTrend ? adaptiveState.solTrend.change1hPct : null,
      sol24h: adaptiveState.solTrend ? adaptiveState.solTrend.change24hPct : null,
      liqPct: (Number.isFinite(q.withLiquidity) && Number.isFinite(q.candidates) && q.candidates > 0)
        ? q.withLiquidity / q.candidates : null,
      candidates: q.candidates || 0,
      healthScore: adaptiveState.health ? adaptiveState.health.score : null,
      healthGate: !!(adaptiveState.health && adaptiveState.health.gate),
      discoveryFailures: adaptiveState.discoveryFailures || 0
    }, config.adaptive, { nowMs: now });
    adaptiveState.regimeState = Object.assign({}, regime, { validUntil: regime.validUntil, detectedAt: regime.detectedAt });

    // 3. Deterministic session policy (regime + metrics + streak breaker +
    // daily loss halt). Day anchor rolls on UTC date change (persisted, so a
    // restart cannot dodge an active halt).
    const current = adaptivePolicy.loadPolicy(dataDir);
    const versions = experiments.loadVersions(dataDir, { maxPositions: MAX_POSITIONS });
    const baseline = experiments.effectiveBaseline(versions, { maxPositions: MAX_POSITIONS });
    adaptiveState.bandsBase = baseline.bandsBase;
    adaptiveState.bandsVersion = baseline.versionId || 'V1';
    adaptiveState.banditLive = baseline.banditLive === 1;
    refreshBandit();
    if (ensureDayAnchor(portfolio, now)) persist();
    const dayPnlPct = computeDayPnl(portfolio);
    let policy = adaptivePolicy.buildSessionPolicy({
      metrics,
      regime,
      current,
      cfg: {
        maxPositions: MAX_POSITIONS,
        strategyVersion: baseline.versionId,
        sizing: config.adaptive.sizing,
        lossBreakerThreshold: config.adaptive.lossBreakerThreshold,
        dailyLossHaltPct: config.adaptive.dailyLossHaltPct
      },
      trades: closed,
      dayPnlPct
    });

    // 4. Optional async LLM hook — schema-validated, clamped, advisory only.
    const llmCfg = config.adaptive.llm || {};
    if (llmCfg.url) {
      const brief = buildAgentLoopBrief({ metrics, regime, closed });
      const llmOut = await llmAdapter.maybeLLMPolicy({
        url: llmCfg.url,
        key: llmCfg.key,
        model: llmCfg.model,
        brief,
        timeoutMs: parseInt(process.env.CIRCUIT_LLM_TIMEOUT_MS, 10) || 30000
      });
      if (llmOut && llmOut.policy) {
        policy = Object.assign({}, policy, llmOut.policy, { source: 'llm' });
        log(`[AGENT-LOOP] LLM policy override accepted (${llmOut.errors && llmOut.errors.length ? llmOut.errors.join('; ') : 'validated'})`);
      } else {
        log('[AGENT-LOOP] LLM unavailable or invalid output — using deterministic policy');
      }
    }

    policy.lastAgentLoopAt = now;
    policy.lastReflectionAt = current.lastReflectionAt || adaptiveState.lastReflectionAt;
    const changed = adaptivePolicy.policyChanged(current, policy);
    adaptiveState.policy = adaptivePolicy.savePolicy(dataDir, policy, config.adaptive.policyTtlMs);
    adaptiveState.lastAgentLoopAt = now;

    // 5. Evaluate shadow experiments against real closed trades.
    const shadowResults = evaluateShadowExperiments(closed);

    log(`[AGENT-LOOP] ${changed ? 'new session policy' : 'refreshed'} mode=${adaptiveState.policy.mode} minScore=${adaptiveState.policy.minScore} maxBuys=${adaptiveState.policy.maxBuys} regime=${regime.regime} (conf ${Math.round((regime.confidence || 0) * 100)}%) source=${adaptiveState.policy.source}` +
      (shadowResults.length ? ' · shadow: ' + shadowResults.map((s) => `${s.id}=${s.state}`).join(',') : ''));
  } catch (err) {
    pushError('AGENT-LOOP', `agent loop failed: ${err.message}`);
  } finally {
    agentLoopActive = false;
  }
}

async function reflectionTick() {
  if (!adaptiveEnabled()) return;
  if (reflectionActive) return;
  reflectionActive = true;
  try {
    const now = Date.now();
    const closed = closedTrades();
    const report = reflectionEngine.runReflection({
      dataDir,
      ledgerRows: perfLib.readLedgerFile(tradesFile),
      cfg: {
        maxPositions: MAX_POSITIONS,
        startingCapitalSol: portfolio.startingCapitalSol,
        minGradeSamples: config.adaptive.minGradeSamples,
        backtestMinTrades: config.adaptive.backtestMinTrades,
        shadowMinTrades: config.adaptive.shadowMinTrades,
        wfFolds: config.adaptive.wfFolds,
        wfMinTrades: config.adaptive.wfMinTrades,
        wfMinFoldTrades: config.adaptive.wfMinFoldTrades,
        wfMinOosPf: config.adaptive.wfMinOosPf,
        wfMinOosExp: config.adaptive.wfMinOosExp,
        gateClusterMinN: config.adaptive.minSamples,
        autoApply: config.adaptive.autoApply
      },
      nowMs: now,
      regime: currentRegime()
    });
    adaptiveState.lastReflectionAt = now;
    try {
      const p = adaptivePolicy.loadPolicy(dataDir);
      adaptivePolicy.savePolicy(dataDir, Object.assign({}, p, { lastReflectionAt: now }), config.adaptive.policyTtlMs);
    } catch (_) { /* best effort */ }
    reflectionEngine.prune(dataDir, 30);

    const shadowResults = evaluateShadowExperiments(closed);

    log(`[REFLECT] graded=${report.graded.length} lessons=${report.lessons.length} recs=${report.recommendations.length} experiments=${report.experiments.length} rolledBack=${report.rolledBack.length} closed=${report.closedTradeCount}` +
      (shadowResults.length ? ' · shadow: ' + shadowResults.map((s) => `${s.id}=${s.state}`).join(',') : ''));
    for (const g of report.graded) {
      log(`[REFLECT] grade ${g.parameter} ${g.oldValue}→${g.newValue} = ${g.grade} (n=${g.tradeSample}, ΔWR ${g.deltaWinRatePts}pts)`);
    }
    for (const rb of report.rolledBack) {
      log(`[REFLECT][ROLLBACK] ${rb.id} → ${rb.state} (${rb.rollbackGrade})`);
    }
  } catch (err) {
    pushError('REFLECT', `reflection failed: ${err.message}`);
  } finally {
    reflectionActive = false;
  }
}

async function runAgentLoop() {
  try { await agentLoopTick(); } catch (err) { pushError('AGENT-LOOP', String(err.message)); }
}
async function runReflection() {
  try { await reflectionTick(); } catch (err) { pushError('REFLECT', String(err.message)); }
}

/* ------------------------------------------------------------------ *
 * Main.
 * ------------------------------------------------------------------ */

function printBanner() {
  logBlock(
`================================================
 REAL-MARKET SOLANA PAPER TRADER
================================================
Data directory : ${dataDir}
Starting SOL   : ${config.startingCapitalSol}
Trade size     : ${config.tradeSizeSol} SOL
Max positions  : ${MAX_POSITIONS}
Discovery      : ${config.discoveryIntervalMs} ms
Monitor        : ${config.scanIntervalMs} ms
5m recovery    : >= ${MIN_5M_RECOVERY_PCT}%
Re-entry cool. : ${cooldownMs} ms
Wallet         : ${WALLET_STATE}
Signer         : ${SIGNER_STATE}
Broadcast      : ${BROADCAST_STATE}
Market         : ${MARKET_LABEL}
Execution      : ${EXECUTION_LABEL}
Adaptive loop  : ${config.adaptive.enabled ? 'every ' + Math.round(config.adaptive.agentLoopIntervalMs / 60000) + ' min (mode/minScore/maxBuys)' : 'DISABLED (pure V1)'}
Reflection     : ${config.adaptive.enabled ? 'every ' + (config.adaptive.reflectIntervalMs / 3600000) + ' h (learning + approvals)' : 'DISABLED'}
Adaptive size  : ${config.adaptive.enabled ? config.adaptive.minTradeSizeSol + '..' + config.adaptive.maxTradeSizeSol + ' SOL (auto)' : 'fixed ' + config.tradeSizeSol + ' SOL'}
TradingAgents  : ${config.tradingAgents.mode} (advisory research)
================================================`);
}

function main() {
  fs.mkdirSync(dataDir, { recursive: true });

  log('==========================================');
  log(`${AGENT_NAME} agent starting (mode=${MODE}, paper=${PAPER_TRADING}, custody=${CUSTODY})`);
  log('[STARTUP] real-market Solana paper trader — paper only, wallet/signer/broadcast disabled');
  if (process.env.CIRCUIT_SIGNER_URL) {
    log('CIRCUIT_SIGNER_URL is set but IGNORED — this agent never signs or executes real trades');
  } else {
    log('CIRCUIT_SIGNER_URL not set — trades remain paper (no signer, no broadcast)');
  }

  config = loadConfig();

  printBanner();

  acquireLock();
  log(`[LOCK] acquired agent.lock (pid ${process.pid})`);

  // Market data: real by default; optional Circuit API primary; mock only for tests.
  market = marketDataLib.createMarketData({
    circuitApiUrl: process.env.CIRCUIT_PRICE_API_URL || null,
    mockFile: process.env.CIRCUIT_MOCK_MARKET_FILE || null,
    maxPriceAgeMs,
    solPriceCacheMs: 30000,
    onEvent: (tag, msg) => {
      log(`[${tag}] ${msg}`);
      // Count source-divergence rejections reported by the market-data layer
      // (existing Circuit/Dex divergence protection) in the integrity state.
      if (tag === 'FILTER' && typeof msg === 'string' && msg.indexOf('price divergence') >= 0) {
        try { if (priceIntegrity) priceIntegrity.noteSourceDivergence(msg); } catch (_) { /* best effort */ }
      }
    }
  });
  log(`[STARTUP] market data provider: ${market.primarySource}${market.fallbackSource ? ` (fallback: ${market.fallbackSource})` : ''} (mode=${market.mode})`);
  log(`[STARTUP] data dir: ${dataDir}`);

  portfolio = loadPortfolio();
  recalculate(portfolio);
  persist();
  writeMeta();
  backfillEquityHistory();
  writeHeartbeat('starting');

  refreshSolPrice().then(() => {
    if (lastSolPriceUsd) log(`[STARTUP] real SOL price: $${lastSolPriceUsd}`);
  });

  // Price-integrity layer (below the strategy — see price-integrity.js).
  // Loads persisted state (last valid price/pair/source, quarantines,
  // counters) and re-anchors any positions that are still open.
  priceIntegrity = integrityLib.createPriceIntegrity({
    dataDir,
    maxAgeMs: maxPriceAgeMs,
    maxDivergencePct,
    gapKillPct,
    log: (msg) => log(`[PRICE-INTEGRITY] ${msg}`)
  });
  for (const pos of portfolio.positions) {
    try { priceIntegrity.notePositionOpened(pos, { preserve: true }); } catch (_) { /* best effort */ }
  }
  log(`[STARTUP] price integrity enabled — ${Object.keys(priceIntegrity.state().mints).length} open position(s) anchored`);

  // Research price history — bounded, persistent, RESTART-SAFE (P1-02). It
  // stores ONLY real observed prices for research horizon outcomes (5m..4h).
  // It never feeds V1's 5m recovery, scoring, or SL/TP logic.
  researchHistory = researchHistoryLib.createResearchHistory({
    dataDir,
    log: (msg) => log(`[RESEARCH-HISTORY] ${msg}`)
  });

  // TradingAgents RESEARCH layer — additive + advisory (default SHADOW). It
  // reuses the same optional LLM endpoint as the adaptive layer and never
  // gates the Circuit V1 execution path.
  tradingAgents = tradingAgentsLib.createTradingAgents({
    dataDir,
    mode: config.tradingAgents.mode,
    maxCandidatesPerCycle: config.tradingAgents.maxCandidatesPerCycle,
    maxDebateRounds: config.tradingAgents.maxDebateRounds,
    researchTimeoutMs: config.tradingAgents.researchTimeoutMs,
    cacheTtlMs: config.tradingAgents.cacheTtlMs,
    llm: (config.adaptive && config.adaptive.llm) || {},
    log: (msg) => log(`[TA] ${msg}`)
  });
  log(`[STARTUP] TradingAgents research layer mode=${tradingAgents.mode()} (${tradingAgents.enabled() ? 'research active — Circuit V1 execution unchanged' : 'disabled'})`);

  // ATLAS INTELLIGENCE LAYER — parallel, advisory, research-grade (default SHADOW).
  // Consumes the existing price-integrity snapshot so it never receives
  // quarantined/invalid observations. Fails safe when the LLM endpoint is down;
  // deterministic specialists still run and LLM agents report UNAVAILABLE.
  try {
    atlas = require('./atlas/atlas-engine.js').createAtlasEngine({
      dataDir,
      mode: config.atlas.mode,
      maxCandidatesPerCycle: config.atlas.maxCandidatesPerCycle,
      researchTimeoutMs: config.atlas.researchTimeoutMs,
      cacheTtlMs: config.atlas.cacheTtlMs,
      llm: (config.adaptive && config.adaptive.llm) || {},
      integritySnap: priceIntegrity ? priceIntegrity.snapshot() : null,
      log: (msg) => log(`[ATLAS] ${msg}`)
    });
    log(`[STARTUP] ATLAS intelligence layer mode=${atlas.mode()} (${atlas.enabled() ? 'research active — V1 execution unchanged' : 'disabled'})`);
  } catch (err) {
    pushError('ATLAS', `atlas engine init failed: ${err.message}`);
    atlas = null;
    log(`[STARTUP] ATLAS disabled — init failed (${err.message})`);
  }

  // Adaptive layer startup: load persisted policy / regime / gates + schedule
  // the agent-loop (~90 min) and reflection (~4h) cycles.
  const adaptiveTimers = [];
  if (adaptiveEnabled()) {
    adaptiveState.policy = adaptivePolicy.loadPolicy(dataDir);
    adaptiveState.regimeState = regimeLib.loadRegimeState(dataDir);
    adaptiveState.gates = gatesLib.loadGates(dataDir);
    refreshBandsBase();
    try {
      const versions = experiments.loadVersions(dataDir, { maxPositions: MAX_POSITIONS });
      adaptiveState.banditLive = experiments.effectiveBaseline(versions, { maxPositions: MAX_POSITIONS }).banditLive === 1;
    } catch (_) { adaptiveState.banditLive = false; }
    refreshBandit();
    adaptiveState.lastAgentLoopAt = (adaptiveState.policy && adaptiveState.policy.lastAgentLoopAt) || null;
    adaptiveState.lastReflectionAt = (adaptiveState.policy && adaptiveState.policy.lastReflectionAt) || null;

    const loopMs = config.adaptive.agentLoopIntervalMs;
    const reflectMs = config.adaptive.reflectIntervalMs;
    // First agent-loop run: ~5 min before the policy expires (or soon if it is
    // overdue — mirrors upstream's startup recovery scheduling).
    let firstLoopMs;
    if (adaptiveState.policy && adaptiveState.policy.expiresAt &&
        Date.now() < new Date(adaptiveState.policy.expiresAt).getTime()) {
      firstLoopMs = Math.max(2000, Math.min(loopMs,
        new Date(adaptiveState.policy.expiresAt).getTime() - Date.now() - 5 * 60 * 1000));
    } else {
      firstLoopMs = Math.min(5000, Math.max(1000, Math.round(loopMs / 4)));
    }
    // First reflection run: resume from the last one (skip a full cycle if it
    // completed within the last half-interval — upstream behavior).
    let firstReflectMs;
    if (adaptiveState.lastReflectionAt && Date.now() - adaptiveState.lastReflectionAt < reflectMs / 2) {
      firstReflectMs = Math.max(5000, reflectMs - (Date.now() - adaptiveState.lastReflectionAt));
    } else {
      firstReflectMs = Math.min(10000, Math.max(2000, Math.round(reflectMs / 4)));
    }
    adaptiveTimers.push(setTimeout(() => {
      runAgentLoop().then(() => {
        adaptiveTimers.push(setInterval(() => { runAgentLoop(); }, loopMs));
      });
    }, firstLoopMs));
    adaptiveTimers.push(setTimeout(() => {
      runReflection().then(() => {
        adaptiveTimers.push(setInterval(() => { runReflection(); }, reflectMs));
      });
    }, firstReflectMs));
    log(`[ADAPTIVE] enabled — agent-loop every ${Math.round(loopMs / 60000)} min (first in ${Math.round(firstLoopMs / 1000)}s), reflection every ${(reflectMs / 3600000).toFixed(1)} h (first in ${Math.round(firstReflectMs / 1000)}s), autoApply=${config.adaptive.autoApply}`);
  } else {
    log('[ADAPTIVE] disabled (CIRCUIT_ADAPTIVE_DISABLE=1) — pure V1 baseline');
  }

  // Loops: discovery (scans) → sampling (history) → monitoring (positions).
  const tDiscovery = setTimeout(runDiscovery, 1000);
  const iDiscovery = setInterval(runDiscovery, config.discoveryIntervalMs);
  const iSample = setInterval(() => { sampleOnce().catch(() => {}); }, config.sampleIntervalMs);
  const iMonitor = setInterval(() => { monitorOnce().catch(() => {}); }, config.scanIntervalMs);
  const iHeartbeat = setInterval(() => writeHeartbeat('running'), Math.min(config.scanIntervalMs, 10000));

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[SHUTDOWN] ${signal} received — persisting state and stopping`);
    try {
      clearTimeout(tDiscovery);
      clearInterval(iDiscovery);
      clearInterval(iSample);
      clearInterval(iMonitor);
      clearInterval(iHeartbeat);
      for (const t of adaptiveTimers) { try { clearTimeout(t); clearInterval(t); } catch (_) { /* ignore */ } }
      recalculate(portfolio);
      persist();
      if (priceIntegrity) priceIntegrity.persist();
      if (researchHistory) { try { researchHistory.flush(); } catch (_) { /* best effort */ } }
      if (tradingAgents) tradingAgents.persistMetrics();
      try {
        if (tradingAgents) {
          const cf = tradingAgents.getCounterfactual();
          if (cf && typeof cf.resolveAll === 'function') {
            const resolvePrice = (mint, targetTs) => {
              const h = history.get(mint);
              if (!h || !h.samples || !h.samples.length) return null;
              let best = null;
              for (const s of h.samples) {
                if (s.ts <= targetTs && (!best || s.ts > best.ts)) best = s;
              }
              return best ? best.priceSol : null;
            };
            cf.resolveAll(resolvePrice, Date.now());
          }
        }
      } catch (_) { /* best effort on shutdown */ }
      writeHeartbeat('stopped');
      releaseLock();
      log('[SHUTDOWN] portfolio persisted, heartbeat=stopped, lock released — bye');
    } catch (err) {
      log(`ERROR during shutdown: ${err.message}`);
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Graceful stop over IPC (used by the test harness / ops):
  process.on('message', (m) => {
    if (m && m.type === 'shutdown') shutdown('IPC-SHUTDOWN');
  });
  process.on('exit', () => releaseLock());
}

async function runDiscovery() {
  try { await discoveryOnce(); } catch (err) { pushError('SCAN ERROR', String(err.message)); }
}

// Config/state are module-level so the accounting helpers stay simple; they
// are only initialized inside main(). Running `node agentd.js` calls main().
let config = null;

if (require.main === module) {
  main();
}

module.exports = {
  AGENT_NAME,
  MAX_POSITIONS,
  STOP_LOSS_PCT,
  TAKE_PROFIT_PCT,
  MIN_5M_RECOVERY_PCT,
  MAX_5M_RECOVERY_PCT,
  MIN_1H_CHANGE_PCT,
  MAX_1H_CHANGE_PCT,
  MIN_SCORE,
  DEFAULT_GAP_KILL_PCT,
  DEFAULT_LIQ_DROP_KILL_PCT,
  DEFAULT_TIME_STOP_MS,
  DEFAULT_TIME_STOP_MIN_PNL_PCT,
  DEFAULT_PARTIAL_TAKE_PCT,
  DEFAULT_PARTIAL_FRACTION,
  DEFAULT_RUNNER_TP_PCT,
  DEFAULT_BREAKEVEN_PCT,
  NATR_WINDOW,
  NATR_MIN_SAMPLES,
  DEFAULT_ATR_SL_MULT,
  DEFAULT_ATR_TP_MULT,
  DEFAULT_MIN_NATR_PCT,
  DEFAULT_MAX_NATR_PCT,
  DEFAULT_MAX_SELLS_BUYS_RATIO,
  DEFAULT_MIN_LIQ_MCAP_PCT,
  DEFAULT_TARGET_VOL_PCT,
  newPortfolio,
  recalculate,
  computeScore,
  compute5mRecoveryFromSamples,
  evaluatePriceGate,
  evaluateGapKill,
  evaluateTimeStop,
  effectivePartialLevels,
  decideExit,
  computeNatr,
  atrLevels,
  passesNatrGate,
  computeEntrySize,
  utcDayString,
  ensureDayAnchor,
  computeDayPnl,
  bounceConfirmation,
  evaluateOrderflow,
  resampleToBars,
  rsiOfCloses,
  evaluateRsiVwap,
  evaluateEnsemble,
  ensembleVote,
  recordEnsembleShadow,
  ENSEMBLE_MODES,
  DEFAULT_ENSEMBLE_AGREE,
  loadConfig,
  isValidSolanaAddress: marketDataLib.isValidSolanaAddress,
  isValidPrice: marketDataLib.isValidPrice,
  priceAgeMs: marketDataLib.priceAgeMs,
  comparePrices: marketDataLib.comparePrices,
  // Adaptive layer (exposed for tests):
  adaptivePolicy,
  regimeLib,
  gatesLib,
  perfLib,
  experiments,
  reflectionEngine,
  llmAdapter,
  healthLib,
  agentLoopTick,
  reflectionTick,
  computeMarketHealth,
  closedTrades,
  // Exposed for tests/ops tooling (fail-closed provenance lock, Phase 2):
  acquireLock,
  releaseLock
};
