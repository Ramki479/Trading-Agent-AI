#!/usr/bin/env node
/**
 * ledger-integrity.js — READ-ONLY ledger/portfolio reconciliation & integrity.
 *
 * Audit fixes P0-01 / P3-01 / P3-02 (Phase 3 / Phase 25):
 *   - Detects duplicate trade IDs, invalid timestamps, unknown schemas,
 *     foreign exitSource values, impossible P&L, unmatched/duplicate SELLs.
 *   - Reconciles portfolio.json counters against the ledger.
 *   - NEVER modifies any file. Historical (including foreign/untrusted) rows
 *     are classified, reported, and preserved as-is (no silent rewrite, no
 *     deletion — audit evidence is never destroyed).
 *
 * Usage:
 *   node ledger-integrity.js [dataDir]         → human-readable report
 *   require('ledger-integrity.js').report(dir) → programmatic object
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Schema fields written by agentd.js executePaperBuy/executePaperSell/executePaperPartial. */
const KNOWN_BUY_FIELDS = ['id', 'timestamp', 'side', 'symbol', 'mint', 'pairAddress', 'dex', 'quantity', 'price', 'priceUsd', 'valueSol', 'realizedPnlSol', 'realizedPnlPct', 'source', 'score', 'change1hPct', 'recovery5mPct', 'liquidityUsd', 'volume24hUsd', 'regime', 'policyMode', 'sizeMultiplier', 'adaptiveSizeSol', 'natr', 'stopLossPct', 'takeProfitPct', 'txBuys', 'txSells', 'fdvUsd', 'marketCapUsd', 'rsi', 'vwapDistPct', 'pWin', 'ensembleAgrees', 'ensembleVotes', 'entryMinScore'];
const KNOWN_SELL_FIELDS = ['id', 'timestamp', 'side', 'symbol', 'mint', 'pairAddress', 'dex', 'quantity', 'price', 'priceUsd', 'valueSol', 'realizedPnlSol', 'realizedPnlPct', 'entryPriceSol', 'costSol', 'source', 'reason', 'tradeRealizedPnlSol', 'tradeRealizedPnlPct', 'partialTaken', 'partial', 'remainingQuantity', 'remainingCostSol'];
const KNOWN_EXIT_SOURCES = ['dexscreener', 'circuit', 'mock'];

const ROUNDING_TOLERANCE_SOL = 1e-6; // documented reconciliation tolerance

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { rows.push({ line: i + 1, row: JSON.parse(line) }); } catch (_) { rows.push({ line: i + 1, row: null }); }
  }
  return rows;
}

/** Classify one ledger row. Returns array of issue strings (empty = clean). */
function classifyRow(entry, seenIds, buysByMint, sellCountByMint) {
  const r = entry.row;
  const issues = [];
  if (!r || typeof r !== 'object') return ['SCHEMA:unparseable-json'];

  // Timestamp must be an ISO string Date.parse accepts (P3-01: numeric ts found in the wild).
  const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  if (!Number.isFinite(ts) || ts <= 0) issues.push('TIMESTAMP:invalid');

  // Side + id.
  const side = String(r.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') issues.push('SCHEMA:unknown-side');
  if (!Number.isInteger(r.id)) issues.push('SCHEMA:missing-or-noninteger-id');
  else if (seenIds.has(r.id)) issues.push('DUPLICATE_ID:' + r.id);
  else seenIds.add(r.id);

  // Foreign execution provenance (P0-01: exitSource jupiter-v3).
  if (r.exitSource != null && !KNOWN_EXIT_SOURCES.includes(String(r.exitSource))) {
    issues.push('FOREIGN_EXIT_SOURCE:' + r.exitSource);
  }
  if (r.source != null && !KNOWN_EXIT_SOURCES.includes(String(r.source)) && r.side === 'BUY') {
    issues.push('FOREIGN_SOURCE:' + r.source);
  }

  // Field-schema check against what this codebase writes.
  const known = side === 'SELL' ? KNOWN_SELL_FIELDS : KNOWN_BUY_FIELDS;
  const unknownFields = Object.keys(r).filter((k) => !known.includes(k) &&
    !['entryPriceUsd', 'exitPriceSol', 'exitPriceUsd', 'entryCostSol', 'exitValueSol', 'pnlSol', 'pnlPct', 'paper', 'timestampIso', 'holdSeconds', 'exitSource'].includes(k));
  if (unknownFields.length) issues.push('SCHEMA:unknown-fields(' + unknownFields.slice(0, 4).join(',') + ')');

  // P&L sanity.
  if (side === 'SELL') {
    const pnl = Number(r.realizedPnlSol);
    if (Number.isFinite(pnl) && (pnl <= -0.05 || pnl >= 0.05)) {
      // V1 bounds per trade: size 0.05 SOL, SL -6%/TP +8% nominal but discrete
      // fills can overshoot; ±100% of size is far outside any legitimate fill.
      issues.push('PNL_IMPOSSIBLE:' + pnl.toFixed(4));
    }
    if (r.costSol != null && Number.isFinite(Number(r.costSol)) && Number(r.costSol) > 0.05 + 1e-9) {
      issues.push('SIZE_ABOVE_V1_CEILING:' + Number(r.costSol).toFixed(4));
    }
    // Partial fills (partial:true) are banked legs of an open lot, not closes:
    // they never consume a BUY lot and never count as duplicate closes.
    if (r.partial !== true) sellCountByMint.set(r.mint, (sellCountByMint.get(r.mint) || 0) + 1);
  } else if (side === 'BUY') {
    buysByMint.set(r.mint, (buysByMint.get(r.mint) || 0) + 1);
  }
  return issues;
}

/**
 * Full read-only reconciliation. Returns:
 * { rows, valid, foreign, duplicateIds, invalidTimestamps, unmatchedSells,
 *   duplicateSells, impossiblePnl, portfolio: { pass, details[] }, issues[] }
 */
function report(dataDir) {
  const tradesFile = path.join(dataDir, 'trades.jsonl');
  const portfolioFile = path.join(dataDir, 'portfolio.json');
  const entries = readRows(tradesFile);

  const seenIds = new Set();
  const buysByMint = new Map();
  const sellCountByMint = new Map();
  const issues = []; // { line, id, mint, side, issues[] }

  let valid = 0, foreign = 0, invalidTimestamps = 0, impossiblePnl = 0, duplicateIds = 0;

  for (const e of entries) {
    const cls = classifyRow(e, seenIds, buysByMint, sellCountByMint);
    const isForeign = cls.some((c) => c.startsWith('FOREIGN_') || c.startsWith('SCHEMA:'));
    if (cls.length) issues.push({ line: e.line, id: e.row && e.row.id, mint: e.row && e.row.mint, side: e.row && e.row.side, issues: cls });
    if (isForeign || e.row === null) foreign += 1; else valid += 1;
    if (cls.some((c) => c.startsWith('TIMESTAMP:'))) invalidTimestamps += 1;
    if (cls.some((c) => c.startsWith('DUPLICATE_ID:'))) duplicateIds += 1;
    if (cls.some((c) => c.startsWith('PNL_IMPOSSIBLE:'))) impossiblePnl += 1;
  }

  // Unmatched / duplicate SELLs: a (non-partial) SELL is legitimate only if a
  // BUY of the same mint precedes it and SELL count ≤ BUY count for that mint
  // (order-aware). Partial fills never consume a lot.
  let buys = 0;
  const buyTsByMint = new Map();
  const ordered = entries.map((e) => e.row).filter(Boolean);
  ordered.sort((a, b) => {
    const ta = Date.parse(a.timestamp) || (typeof a.timestamp === 'number' ? a.timestamp : 0) || 0;
    const tb = Date.parse(b.timestamp) || (typeof b.timestamp === 'number' ? b.timestamp : 0) || 0;
    return ta - tb;
  });
  let unmatchedSells = 0;
  for (const r of ordered) {
    const side = String(r.side || '').toUpperCase();
    if (side === 'BUY') { buys += 1; buyTsByMint.set(r.mint, (buyTsByMint.get(r.mint) || 0) + 1); }
    else if (side === 'SELL') {
      if (r.partial === true) continue; // banked leg, not a close
      if ((buyTsByMint.get(r.mint) || 0) > 0) buyTsByMint.set(r.mint, buyTsByMint.get(r.mint) - 1);
      else unmatchedSells += 1;
    }
  }
  // Duplicate SELLs: mints whose total SELL rows exceed their total BUY rows.
  let duplicateSells = 0;
  for (const [m, c] of sellCountByMint) if (c > (buysByMint.get(m) || 0)) duplicateSells += 1;

  // Portfolio reconciliation (realized P&L / trade counts) — counts only rows
  // that parse, have valid ISO timestamps and non-foreign provenance, i.e.
  // rows this codebase could have written.
  const portfolio = { pass: false, details: [] };
  try {
    if (fs.existsSync(portfolioFile)) {
      const p = JSON.parse(fs.readFileSync(portfolioFile, 'utf8'));
      let ledgerRealized = 0, ledgerSells = 0, ledgerWins = 0, ledgerLosses = 0;
      // Trade aggregation: partial fills accumulate into their mint's oldest
      // open lot; the first non-partial SELL closes it with combined economics
      // (preferring the recorded trade totals). Legacy ledgers behave as before.
      const lots = new Map(); // mint -> [{ partialSol }]
      for (const r of ordered) {
        const side = String(r.side || '').toUpperCase();
        if (side === 'BUY') {
          if (r.mint != null) {
            if (!lots.get(r.mint)) lots.set(r.mint, []);
            lots.get(r.mint).push({ partialSol: 0 });
          }
          continue;
        }
        if (side !== 'SELL') continue;
        const tsOk = typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp));
        const foreignRow = r.exitSource != null && !KNOWN_EXIT_SOURCES.includes(String(r.exitSource));
        if (!tsOk || foreignRow) continue;
        const pnl = Number(r.realizedPnlSol);
        if (!Number.isFinite(pnl)) continue;
        ledgerRealized += pnl;
        if (r.partial === true) {
          const q = lots.get(r.mint);
          if (q && q.length) q[0].partialSol += pnl;
          continue;
        }
        let combined = pnl;
        const q = lots.get(r.mint);
        if (q && q.length) {
          const lot = q.shift();
          combined = lot.partialSol + pnl;
          const t = Number(r.tradeRealizedPnlSol);
          if (Number.isFinite(t)) combined = t;
        }
        ledgerSells += 1;
        if (combined > 0) ledgerWins += 1; else if (combined < 0) ledgerLosses += 1;
      }
      const dR = Math.abs(ledgerRealized - (Number(p.realizedPnlSol) || 0));
      const dN = Math.abs(ledgerSells - (p.totalTrades || 0));
      const dW = Math.abs(ledgerWins - (p.winningTrades || 0));
      const dL = Math.abs(ledgerLosses - (p.losingTrades || 0));
      portfolio.pass = dR <= ROUNDING_TOLERANCE_SOL && dN === 0 && dW === 0 && dL === 0;
      portfolio.details = [
        `realizedPnlSol ledger(trusted)=${ledgerRealized.toFixed(8)} portfolio=${Number(p.realizedPnlSol).toFixed(8)} Δ=${dR.toFixed(8)}`,
        `sells ledger(trusted)=${ledgerSells} portfolio.totalTrades=${p.totalTrades} Δ=${dN}`,
        `wins ${ledgerWins}/${p.winningTrades} losses ${ledgerLosses}/${p.losingTrades}`,
        `tolerance=${ROUNDING_TOLERANCE_SOL} SOL; foreign/untrusted rows excluded from the trusted set (preserved on disk)`
      ];
    } else {
      portfolio.details.push('portfolio.json not found');
    }
  } catch (err) {
    portfolio.details.push('portfolio reconciliation error: ' + err.message);
  }

  return {
    rows: entries.length,
    valid,
    foreign,
    duplicateIds,
    invalidTimestamps,
    unmatchedSells,
    duplicateSells,
    impossiblePnl,
    issues,
    portfolio
  };
}

/** Human-readable report (Phase 3 example format). */
function formatReport(dataDir) {
  const r = report(dataDir);
  const lines = [];
  lines.push('LEDGER INTEGRITY');
  lines.push('----------------');
  lines.push(`Rows: ${r.rows}`);
  lines.push(`Valid: ${r.valid}`);
  lines.push(`Foreign: ${r.foreign}`);
  lines.push(`Duplicate IDs: ${r.duplicateIds}`);
  lines.push(`Invalid timestamps: ${r.invalidTimestamps}`);
  lines.push(`Unmatched SELLs: ${r.unmatchedSells}`);
  lines.push(`Impossible P&L rows: ${r.impossiblePnl}`);
  lines.push(`Portfolio reconciliation: ${r.portfolio.pass ? 'PASS' : 'FAIL'}`);
  for (const d of r.portfolio.details) lines.push('  ' + d);
  if (r.issues.length) {
    lines.push('Flagged rows (preserved on disk, not modified):');
    for (const it of r.issues.slice(0, 20)) {
      lines.push(`  line ${it.line} id=${it.id} side=${it.side} → ${it.issues.join('; ')}`);
    }
    if (r.issues.length > 20) lines.push(`  … ${r.issues.length - 20} more`);
  }
  return lines.join('\n');
}

module.exports = {
  report,
  formatReport,
  KNOWN_EXIT_SOURCES,
  ROUNDING_TOLERANCE_SOL
};
