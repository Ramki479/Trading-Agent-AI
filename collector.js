#!/usr/bin/env node
/**
 * collector.js — Lightweight data collector that runs alongside the live agent.
 *
 * Reads candidates.json (written every scan by the agent) and appends enriched
 * snapshots to a JSONL file for backtesting.  One snapshot per agent scan.
 *
 * Usage:
 *   node collector.js                          # default data dir + output
 *   node collector.js --data-dir /path/to/dir  # custom data dir
 *   node collector.js --out /tmp/snapshots.jsonl
 *   node collector.js --interval 10000         # poll every 10s (default 5s)
 *
 * The collector is designed to be negligible overhead — just one JSON.parse +
 * one JSON.stringify + one appendFileSync per interval.  No network calls,
 * no market data fetching, no scoring.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}

const DATA_DIR = getArg('--data-dir',
  process.env.CIRCUIT_AGENT_DATA_DIR || path.join(os.homedir(), '.circuit/agents/paper-trader'));
const OUT_PATH = getArg('--out', path.join(os.homedir(), '.circuit/agents/paper-trader/backtest-snapshots.jsonl'));
const INTERVAL_MS = Number(getArg('--interval', '5000'));
const MAX_FILE_SIZE_MB = Number(getArg('--max-size-mb', '100'));

// ─── State ───────────────────────────────────────────────────────────

let lastScan = -1;
let totalSnapshots = 0;
let totalCandidates = 0;

// ─── Core ────────────────────────────────────────────────────────────

function readCandidates() {
  const p = path.join(DATA_DIR, 'candidates.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readSOLPrice() {
  const p = path.join(DATA_DIR, 'fx-rate-cache.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const cache = JSON.parse(raw);
    return cache.solPriceUsd || 100;
  } catch (_) {
    return 100;
  }
}

function readPortfolio() {
  const p = path.join(DATA_DIR, 'portfolio.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return {};
  }
}

function buildSnapshot(data) {
  const solPriceUsd = readSOLPrice();
  const portfolio = readPortfolio();
  const now = Date.now();

  const tokens = {};
  if (Array.isArray(data.candidates)) {
    for (const c of data.candidates) {
      if (!c.mint || !(c.priceUsd > 0)) continue;
      tokens[c.mint] = {
        symbol: c.symbol || c.mint.slice(0, 6),
        priceUsd: c.priceUsd,
        priceSol: c.priceSol || (c.priceUsd / solPriceUsd),
        change1hPct: c.change1hPct || 0,
        liquidityUsd: c.liquidityUsd || 0,
        volume24hUsd: c.volume24hUsd || 0,
        txBuys: c.txBuys || 0,
        txSells: c.txSells || 0,
        fdvUsd: c.fdvUsd || 0,
        marketCapUsd: c.marketCapUsd || 0,
        score: c.score || 0,
        recoveryPct: c.recoveryPct,
        recoveryStatus: c.recoveryStatus,
        natr: c.natr,
        bounce: c.bounce,
        rsi: c.rsi,
        quality: c.quality,
        decision: c.decision,
        reason: c.reason,
      };
    }
  }

  // Also include open positions as tracked tokens
  if (portfolio.positions) {
    for (const pos of portfolio.positions) {
      if (!tokens[pos.mint]) {
        tokens[pos.mint] = {
          symbol: pos.symbol,
          priceUsd: pos.currentPriceUsd || pos.entryPriceUsd,
          priceSol: pos.currentPriceSol || pos.entryPriceSol,
          liquidityUsd: pos.entryLiquidityUsd || 0,
          volume24hUsd: pos.entryVolume24hUsd || 0,
          isOpenPosition: true,
        };
      }
    }
  }

  return {
    ts: data.scannedAt || now,
    scan: data.scan || 0,
    solPriceUsd,
    openPositions: portfolio.positions ? portfolio.positions.length : 0,
    cashSol: portfolio.cashSol || 10,
    regime: null, // would need regime-state.json
    tokens,
  };
}

function appendSnapshot(snap) {
  // Rotate file if too large
  try {
    const stat = fs.statSync(OUT_PATH);
    if (stat.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      const rotated = OUT_PATH + '.' + Date.now();
      fs.renameSync(OUT_PATH, rotated);
      console.log(`[COLLECTOR] Rotated snapshot file → ${rotated}`);
    }
  } catch (_) {}

  fs.appendFileSync(OUT_PATH, JSON.stringify(snap) + '\n');
}

function tick() {
  const data = readCandidates();
  if (!data || !data.candidates) return;
  if (data.scan === lastScan) return; // no new scan yet
  lastScan = data.scan;

  const snap = buildSnapshot(data);
  appendSnapshot(snap);

  totalSnapshots++;
  totalCandidates += data.candidates.length;

  const tokenCount = Object.keys(snap.tokens).length;
  if (totalSnapshots % 60 === 0) { // log every ~5 min
    console.log(`[COLLECTOR] ${totalSnapshots} snapshots, ${totalCandidates} candidates, ${tokenCount} tokens in latest scan`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────

console.log('='.repeat(50));
console.log('  Circuit Backtest Collector');
console.log('='.repeat(50));
console.log(`  Data dir:    ${DATA_DIR}`);
console.log(`  Output:      ${OUT_PATH}`);
console.log(`  Interval:    ${INTERVAL_MS}ms`);
console.log(`  Max size:    ${MAX_FILE_SIZE_MB}MB`);
console.log('='.repeat(50));
console.log(`  Reading candidates.json every ${INTERVAL_MS}ms...`);
console.log(`  Press Ctrl+C to stop.\n`);

// Initial read
tick();

// Start polling
const timer = setInterval(tick, INTERVAL_MS);

// Graceful shutdown
process.on('SIGINT', () => {
  clearInterval(timer);
  console.log(`\n[COLLECTOR] Stopped. ${totalSnapshots} snapshots written to ${OUT_PATH}`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
