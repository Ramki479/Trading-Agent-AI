#!/usr/bin/env node
/**
 * dev-fixture.js — generate a LOCAL-ONLY test data directory so the
 * dashboard API and UI can be exercised on the dev machine without
 * touching the real paper account.
 *
 * The generator replays the same dip-reversal strategy the agent uses
 * (random-walk prices, take-profit / stop-loss / time exits) and writes
 * the real files the API reads:
 *   portfolio.json  trades.jsonl  heartbeat.json  equity-history.jsonl
 *   config.json     meta.json
 *
 * It is purely a development/testing tool. Everything it writes goes under
 * the data dir given on the command line — NEVER under
 * ~/.circuit/agents/paper-trader.
 *
 * Usage:
 *   node agentd/dev-fixture.js <data-dir> [starting-capital] [minutes]
 *
 * Example:
 *   node agentd/dev-fixture.js .dev-test-data 10 90
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.argv[2];
if (!DATA_DIR) {
  console.error('usage: node dev-fixture.js <data-dir> [startingCapital] [simMinutes]');
  process.exit(1);
}
const STARTING = parseFloat(process.argv[3]) || 10;
const MINUTES = parseInt(process.argv[4], 10) || 90;

const SCAN_INTERVAL_MS = 5000;   // like the agent default
const SCANS = Math.round((MINUTES * 60000) / SCAN_INTERVAL_MS);
const MAX_POSITIONS = 5;
const TAKE_PROFIT_PCT = 0.02;
const STOP_LOSS_PCT = -0.03;
const TIME_EXIT_SCANS = 60;
const DIP_PCT = 0.015;
const PRICE_VOL = 0.012;
const PRICE_DRIFT = 0.0003;
const TRADE_SIZE = 0.01;

const round = (n, d = 8) => { const f = Math.pow(10, d); return Math.round(n * f) / f; };
const now = Date.now();

// Tickers as in agentd.js
const TICKERS = [];
for (let i = 1; i <= 12; i++) {
  TICKERS.push({ symbol: 'TKN' + i, base: round(0.006 + (i - 1) * 0.0015, 8) });
}
const market = new Map(TICKERS.map((t) => [t.symbol, { price: t.base, history: [] }]));

const portfolio = {
  name: 'paper-trader',
  mode: 'paper',
  startingCapitalSol: STARTING,
  cashSol: STARTING,
  investedSol: 0,
  marketValueSol: 0,
  equitySol: STARTING,
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
  positions: [],
  updatedAt: 0
};

const trades = [];
const equity = [];

function recalc() {
  let invested = 0, mv = 0;
  for (const pos of portfolio.positions) {
    pos.marketValueSol = round(pos.quantity * pos.currentPrice, 8);
    pos.unrealizedPnlSol = round(pos.marketValueSol - pos.costSol, 8);
    pos.unrealizedPnlPct = pos.costSol > 0 ? round(((pos.marketValueSol - pos.costSol) / pos.costSol) * 100, 4) : 0;
    invested += pos.costSol;
    mv += pos.marketValueSol;
  }
  portfolio.investedSol = round(invested, 8);
  portfolio.marketValueSol = round(mv, 8);
  portfolio.cashSol = round(portfolio.cashSol, 8);
  portfolio.equitySol = round(portfolio.cashSol + portfolio.marketValueSol, 8);
  portfolio.totalPnlSol = round(portfolio.equitySol - STARTING, 8);
  portfolio.pnlPct = STARTING > 0 ? round((portfolio.totalPnlSol / STARTING) * 100, 4) : 0;
  portfolio.unrealizedPnlSol = round(mv - invested, 8);
  portfolio.winRate = portfolio.totalTrades > 0 ? round((portfolio.winningTrades / portfolio.totalTrades) * 100, 2) : 0;
  portfolio.avgWinSol = portfolio.winningTrades > 0 ? round(portfolio.sumWinSol / portfolio.winningTrades, 8) : 0;
  portfolio.avgLossSol = portfolio.losingTrades > 0 ? round(portfolio.sumLossSol / portfolio.losingTrades, 8) : 0;
  portfolio.updatedAt = now;
}

function buy(symbol, price, ts) {
  if (portfolio.positions.length >= MAX_POSITIONS || portfolio.cashSol < TRADE_SIZE) return false;
  const cost = round(TRADE_SIZE, 8);
  const quantity = round(cost / price, 8);
  if (quantity <= 0) return false;
  portfolio.cashSol = round(portfolio.cashSol - cost, 8);
  portfolio.positions.push({
    symbol, quantity,
    entryPrice: round(price, 8), currentPrice: round(price, 8),
    costSol: cost, marketValueSol: cost, unrealizedPnlSol: 0, unrealizedPnlPct: 0,
    openedAt: new Date(ts).toISOString()
  });
  trades.push({ id: portfolio.nextTradeId++, timestamp: new Date(ts).toISOString(), side: 'BUY', symbol, quantity, price: round(price, 8), valueSol: cost, realizedPnlSol: 0, realizedPnlPct: 0 });
  return true;
}

function sell(position, price, ts) {
  const exitValue = round(position.quantity * price, 8);
  const realized = round(exitValue - position.costSol, 8);
  const pct = position.costSol > 0 ? round((realized / position.costSol) * 100, 4) : 0;
  portfolio.cashSol = round(portfolio.cashSol + exitValue, 8);
  portfolio.realizedPnlSol = round(portfolio.realizedPnlSol + realized, 8);
  portfolio.totalTrades += 1;
  if (realized > 0) { portfolio.winningTrades += 1; portfolio.sumWinSol = round(portfolio.sumWinSol + realized, 8); }
  else if (realized < 0) { portfolio.losingTrades += 1; portfolio.sumLossSol = round(portfolio.sumLossSol + realized, 8); }
  portfolio.bestTradeSol = Math.max(portfolio.bestTradeSol, realized);
  portfolio.worstTradeSol = Math.min(portfolio.worstTradeSol, realized);
  portfolio.positions = portfolio.positions.filter((p) => p !== position);
  trades.push({ id: portfolio.nextTradeId++, timestamp: new Date(ts).toISOString(), side: 'SELL', symbol: position.symbol, quantity: position.quantity, price: round(price, 8), valueSol: exitValue, realizedPnlSol: realized, realizedPnlPct: pct, entryPrice: position.entryPrice, costSol: position.costSol });
}

function stepMarket() {
  for (const t of TICKERS) {
    const m = market.get(t.symbol);
    const shock = (Math.random() * 2 - 1) * PRICE_VOL + PRICE_DRIFT;
    m.price = Math.max(0.0005, m.price * (1 + shock));
    m.history.push(m.price);
    if (m.history.length > 30) m.history.shift();
  }
}

const recentHigh = (s) => {
  const m = market.get(s);
  return m.history.length ? Math.max.apply(null, m.history) : m.price;
};

// ---- run the simulation ----------------------------------------------
let firstTs = 0;
let lastEquitySample = null;

for (let s = 1; s <= SCANS; s++) {
  portfolio.scans = s;
  const ts = now - (SCANS - s) * SCAN_INTERVAL_MS;
  if (!firstTs) firstTs = ts;
  stepMarket();

  for (const position of portfolio.positions.slice()) {
    const price = market.get(position.symbol).price;
    const pnl = position.entryPrice > 0 ? (price - position.entryPrice) / position.entryPrice : 0;
    position.scansHeld = (position.scansHeld || 0) + 1;
    let reason = null;
    if (pnl >= TAKE_PROFIT_PCT) reason = 'take-profit';
    else if (pnl <= STOP_LOSS_PCT) reason = 'stop-loss';
    else if (position.scansHeld >= TIME_EXIT_SCANS) reason = 'time-exit';
    position.currentPrice = round(price, 8);
    if (reason) sell(position, price, ts);
  }

  const candidates = TICKERS
    .filter((t) => !portfolio.positions.find((p) => p.symbol === t.symbol))
    .filter((t) => market.get(t.symbol).history.length >= 10)
    .filter((t) => market.get(t.symbol).price <= recentHigh(t.symbol) * (1 - DIP_PCT))
    .sort((a, b) => (market.get(a.symbol).price / a.base) - (market.get(b.symbol).price / b.base));

  for (const t of candidates) {
    if (portfolio.positions.length >= MAX_POSITIONS || portfolio.cashSol < TRADE_SIZE) break;
    buy(t.symbol, market.get(t.symbol).price, ts);
  }

  recalc();

  // equity sampling (same rule as agentd.js)
  if (!lastEquitySample ||
      Math.abs(portfolio.equitySol - lastEquitySample.equitySol) >= 0.0001 ||
      ts - lastEquitySample.ts >= 30000) {
    equity.push({ ts, equitySol: portfolio.equitySol, cashSol: portfolio.cashSol, totalPnlSol: portfolio.totalPnlSol, pnlPct: portfolio.pnlPct });
    lastEquitySample = equity[equity.length - 1];
  }
}

portfolio.updatedAt = now;

// ---- write the files --------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(DATA_DIR, name), data);
write('portfolio.json', JSON.stringify(portfolio, null, 2) + '\n');
write('trades.jsonl', trades.map((t) => JSON.stringify(t)).join('\n') + '\n');
write('equity-history.jsonl', equity.map((e) => JSON.stringify(e)).join('\n') + '\n');
write('heartbeat.json', JSON.stringify({
  state: 'running', name: 'paper-trader', paper: true, custody: 'local',
  startedAt: firstTs, startedAtIso: new Date(firstTs).toISOString(),
  uptimeSec: Math.round((now - firstTs) / 1000), lastScanAt: now,
  scans: portfolio.scans, startingCapitalSol: STARTING,
  cashSol: portfolio.cashSol, investedSol: portfolio.investedSol,
  marketValueSol: portfolio.marketValueSol, equitySol: portfolio.equitySol,
  realizedPnlSol: portfolio.realizedPnlSol, unrealizedPnlSol: portfolio.unrealizedPnlSol,
  totalPnlSol: portfolio.totalPnlSol, pnlPct: portfolio.pnlPct,
  totalTrades: portfolio.totalTrades, winningTrades: portfolio.winningTrades,
  losingTrades: portfolio.losingTrades, winRate: portfolio.winRate,
  positions: portfolio.positions.map((p) => ({
    symbol: p.symbol, quantity: p.quantity, entryPrice: p.entryPrice,
    currentPrice: p.currentPrice, costSol: p.costSol, marketValueSol: p.marketValueSol,
    unrealizedPnlSol: p.unrealizedPnlSol, unrealizedPnlPct: p.unrealizedPnlPct,
    openedAt: p.openedAt
  })),
  updatedAt: now
}, null, 2) + '\n');
write('config.json', JSON.stringify({
  scanIntervalMs: SCAN_INTERVAL_MS, paperTrading: true,
  strategy: 'dip-reversal', tradeSizeSol: TRADE_SIZE, startingCapitalSol: STARTING
}, null, 2) + '\n');
write('meta.json', JSON.stringify({
  name: 'paper-trader', mode: 'paper', paper: true, custody: 'local',
  createdAt: new Date(firstTs).toISOString(), signerUrl: null, wallet: null
}, null, 2) + '\n');
write('agent.log', '');

console.log(`Dev fixture written to ${DATA_DIR}`);
console.log(`  simulated ${SCANS} scans over ${MINUTES} min`);
console.log(`  trades: ${trades.length}  |  open positions: ${portfolio.positions.length}`);
console.log(`  equity: ${portfolio.equitySol.toFixed(5)} SOL  |  total P&L: ${portfolio.totalPnlSol >= 0 ? '+' : ''}${portfolio.totalPnlSol.toFixed(5)} SOL (${portfolio.pnlPct >= 0 ? '+' : ''}${portfolio.pnlPct.toFixed(2)}%)`);
