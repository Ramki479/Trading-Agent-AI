#!/usr/bin/env node
/**
 * portfolio.js — display the paper-trading portfolio written by agentd.js.
 *
 * Usage:
 *   node portfolio.js          (equivalent: ./paper-portfolio)
 *
 * Reads ${CIRCUIT_AGENT_DATA_DIR}/portfolio.json
 * (default ~/.circuit/agents/paper-trader/portfolio.json).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const dataDir = process.env.CIRCUIT_AGENT_DATA_DIR ||
  path.join(os.homedir(), '.circuit', 'agents', 'paper-trader');
const portfolioFile = path.join(dataDir, 'portfolio.json');

const W = 38; // interior width of the box

const BORDER_TOP = '╔' + '═'.repeat(W) + '╗';
const BORDER_MID = '╠' + '═'.repeat(W) + '╣';
const BORDER_BOT = '╚' + '═'.repeat(W) + '╝';
const EMPTY = '║' + ' '.repeat(W) + '║';

function line(content) {
  return '║' + content.padEnd(W) + '║';
}

/** Row with a left label and a right-aligned value whose LAST character
 *  lands at interior column `endCol` (1-based). */
function valueRow(label, value, endCol) {
  const head = ' ' + label;
  const pad = Math.max(1, endCol - head.length - value.length);
  return line(head + ' '.repeat(pad) + value);
}

function title(text) {
  const left = Math.floor((W - text.length) / 2);
  const right = W - text.length - left;
  return line(' '.repeat(left) + text + ' '.repeat(right));
}

function signedSol(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(5);
}

function render(p) {
  const out = [];
  out.push(BORDER_TOP);
  out.push(title('PAPER TRADING PORTFOLIO'));
  out.push(BORDER_MID);
  out.push(valueRow('Starting Capital', p.startingCapitalSol.toFixed(5) + ' SOL', 32));
  out.push(valueRow('Cash', p.cashSol.toFixed(5) + ' SOL', 32));
  out.push(valueRow('Invested', p.investedSol.toFixed(5) + ' SOL', 32));
  out.push(valueRow('Equity', p.equitySol.toFixed(5) + ' SOL', 32));
  out.push(EMPTY);
  out.push(valueRow('Realized P&L', signedSol(p.realizedPnlSol) + ' SOL', 32));
  out.push(valueRow('Unrealized P&L', signedSol(p.unrealizedPnlSol) + ' SOL', 32));
  out.push(valueRow('Total P&L', signedSol(p.totalPnlSol) + ' SOL', 32));
  out.push(valueRow('Return', (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(2) + '%', 31));
  out.push(EMPTY);
  out.push(valueRow('Trades', String(p.totalTrades), 29));
  out.push(valueRow('Wins', String(p.winningTrades), 29));
  out.push(valueRow('Losses', String(p.losingTrades), 29));
  out.push(valueRow('Win Rate', p.winRate.toFixed(2) + '%', 31));
  out.push(EMPTY);
  out.push(valueRow('Open Positions', String(p.positions.length), 29));
  out.push(BORDER_BOT);
  return out.join('\n');
}

function main() {
  if (!fs.existsSync(portfolioFile)) {
    console.error(`No portfolio found at ${portfolioFile}`);
    console.error('Run the paper-trader agent first:  node agentd.js');
    process.exit(1);
  }

  let p;
  try {
    p = JSON.parse(fs.readFileSync(portfolioFile, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${portfolioFile}: ${err.message}`);
    process.exit(1);
  }

  console.log(render(p));

  if (Array.isArray(p.positions) && p.positions.length > 0) {
    console.log('\nOpen Positions:');
    console.log('  SYMBOL   QTY         ENTRY       CURRENT      UNREALIZED');
    for (const pos of p.positions) {
      const sign = pos.unrealizedPnlSol >= 0 ? '+' : '';
      console.log(
        '  ' + pos.symbol.padEnd(7) +
        pos.quantity.toFixed(4).padStart(10) +
        pos.entryPrice.toFixed(5).padStart(12) +
        pos.currentPrice.toFixed(5).padStart(12) +
        (sign + pos.unrealizedPnlSol.toFixed(5) + ' SOL').padStart(18));
    }
  }

  console.log(`\nportfolio: ${portfolioFile}`);
}

main();