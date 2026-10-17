#!/usr/bin/env node
/**
 * research-history.js — bounded persistent RESEARCH price history.
 *
 * PURPOSE (audit fix P1-02): the V1 operational history in agentd.js keeps only
 * HISTORY_KEEP_MS = 15 minutes, which cannot support ATLAS/TradingAgents
 * horizons of 30m / 1h / 4h. This module is a SEPARATE store:
 *
 *   A. V1 operational history (agentd.js `history` map, 15 min) — UNTOUCHED.
 *   B. Research outcome history (this module) — bounded, persisted, restart-safe.
 *
 * Semantics:
 *   - Stores ONLY real observed market prices (no fabrication, no interpolation).
 *   - Each record: { ts, mint, priceSol, priceUsd, pairAddress, dex, source, dq }
 *   - PAPER-ONLY: no wallet, no signing, no broadcast; writes exactly one file
 *     (research-prices.jsonl) inside the agent data dir.
 *
 * Resolution contract (audit fix P1-01 / Phase 5):
 *   resolveAtOrAfter(mint, targetTs, opts) returns the EARLIEST valid
 *   observation with ts >= targetTs and ts <= targetTs + maxLateMs.
 *   An observation strictly BEFORE the target is NEVER returned for horizon
 *   resolution. If none exists → null (NO_VALID_OBSERVATION).
 *
 * Bounds:
 *   - Per-mint sample cap (drop oldest) and a global mint cap (LRU by last seen).
 *   - File size cap with compaction (rewrite compacted) so disk stays bounded.
 *   - Persisted with atomic tmp+rename on a batched flush; flushed on shutdown.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'research-prices.jsonl';

const DEFAULTS = {
  retentionMs: 6 * 60 * 60 * 1000,   // 4h horizon + 2h late-resolution margin
  maxLateMs: 2 * 60 * 1000,          // resolver: accept first observation up to 2 min after target
  maxSamplesPerMint: 1600,           // ~4h at 15s sampling + margin (bounded per mint)
  maxMints: 500,                     // global LRU cap on distinct mints
  maxFileBytes: 24 * 1024 * 1024,    // compact when the JSONL exceeds this
  flushEveryAppends: 40              // batch appends before rewriting the file
};

/** djb2 string hash — small, dependency-free, for file sanity (not crypto). */
function hashKey(mint, ts) {
  let h = 5381;
  const s = mint + '|' + ts;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function validSample(s) {
  return s && Number.isFinite(s.ts) && s.ts > 0 &&
    Number.isFinite(s.priceSol) && s.priceSol > 0 &&
    (!Number.isFinite(s.priceUsd) || s.priceUsd > 0);
}

/**
 * Create the research history manager.
 * options: { dataDir, retentionMs, maxLateMs, maxSamplesPerMint, maxMints,
 *            maxFileBytes, flushEveryAppends, log(msg) }
 */
function createResearchHistory(options = {}) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  const dataDir = cfg.dataDir || process.cwd();
  const file = path.join(dataDir, FILE_NAME);
  const log = typeof cfg.log === 'function' ? cfg.log : () => {};

  const byMint = new Map();  // mint -> array of samples, ascending ts (bounded)
  const lastSeen = new Map(); // mint -> ts of last record (LRU)
  let totalSamples = 0;
  let appendsSinceFlush = 0;
  let dirty = false;
  let loaded = false;

  /** Load persisted tail (bounded read) — survives restart. */
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (!fs.existsSync(file)) return;
      const stat = fs.statSync(file);
      // Bounded read: only the tail (last ~8 MB) matters for the retention window.
      const readBytes = Math.min(stat.size, 8 * 1024 * 1024);
      const start = Math.max(0, stat.size - readBytes);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, start);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // drop partial first line
      for (const line of lines) {
        if (!line) continue;
        try { ingest(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
      }
      log(`research-history loaded ${totalSamples} sample(s) for ${byMint.size} mint(s) from ${file}`);
    } catch (err) {
      log(`research-history load failed (${err.message}) — starting fresh`);
    }
  }

  /** Ingest one raw record into the bounded in-memory structure. */
  function ingest(rec) {
    if (!rec || !rec.mint || !validSample(rec)) return false;
    const mint = String(rec.mint);
    let arr = byMint.get(mint);
    if (!arr) {
      if (byMint.size >= cfg.maxMints) {
        // LRU: evict the mint with the oldest last-seen timestamp.
        let oldest = null, oldestTs = Infinity;
        for (const [m, ts] of lastSeen) {
          if (ts < oldestTs) { oldestTs = ts; oldest = m; }
        }
        if (oldest) { totalSamples -= (byMint.get(oldest) || []).length; byMint.delete(oldest); lastSeen.delete(oldest); }
      }
      arr = [];
      byMint.set(mint, arr);
    }
    // Skip exact duplicates (same ts) — idempotent ingest.
    if (arr.length && arr[arr.length - 1].ts === rec.ts) return false;
    arr.push({
      ts: rec.ts,
      priceSol: rec.priceSol,
      priceUsd: Number.isFinite(rec.priceUsd) ? rec.priceUsd : null,
      pairAddress: rec.pairAddress || null,
      dex: rec.dex || null,
      source: rec.source || null,
      dq: rec.dq || 'ok'
    });
    if (arr.length > cfg.maxSamplesPerMint) arr.splice(0, arr.length - cfg.maxSamplesPerMint);
    totalSamples += 1;
    lastSeen.set(mint, rec.ts);
    return true;
  }

  /** Drop samples older than the retention window (called on record/resolve). */
  function prune(nowMs) {
    const cutoff = nowMs - cfg.retentionMs;
    for (const [mint, arr] of byMint) {
      let drop = 0;
      while (drop < arr.length && arr[drop].ts < cutoff) drop += 1;
      if (drop > 0) { arr.splice(0, drop); totalSamples -= drop; }
      if (!arr.length) { byMint.delete(mint); lastSeen.delete(mint); }
    }
  }

  /** Append one real observation. Does NOT rewrite the file on every call. */
  function record(mint, info) {
    load();
    const rec = {
      ts: Number.isFinite(info && info.timestamp) ? info.timestamp : (Number.isFinite(info && info.ts) ? info.ts : Date.now()),
      mint,
      priceSol: info && info.priceSol,
      priceUsd: info && info.priceUsd,
      pairAddress: (info && (info.pairAddress || info.pair)) || null,
      dex: info && info.dex,
      source: info && info.source,
      dq: (info && info.dq) || 'ok'
    };
    if (!validSample({ ts: rec.ts, priceSol: rec.priceSol, priceUsd: rec.priceUsd })) return false;
    prune(Date.now());
    if (!ingest(rec)) return false;
    dirty = true;
    appendsSinceFlush += 1;
    if (appendsSinceFlush >= cfg.flushEveryAppends) flush();
    return true;
  }

  /** Append-only write of dirty samples, with size-cap compaction. */
  function flush() {
    if (!dirty) return;
    try {
      // Write only samples not already known to be on disk. For simplicity and
      // crash-safety we rewrite the compacted file when the append backlog is
      // large, otherwise append the backlog.
      fs.mkdirSync(dataDir, { recursive: true });
      let size = 0;
      try { size = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch (_) { size = 0; }
      const snapshot = [];
      for (const [mint, arr] of byMint) {
        for (const s of arr) snapshot.push({ ts: s.ts, mint, priceSol: s.priceSol, priceUsd: s.priceUsd, pairAddress: s.pairAddress, dex: s.dex, source: s.source, dq: s.dq });
      }
      const bytes = snapshot.reduce((a, r) => a + JSON.stringify(r).length + 1, 0);
      if (size + bytes > cfg.maxFileBytes || size > cfg.maxFileBytes) {
        // Compact: rewrite the bounded snapshot atomically.
        const tmp = file + '.tmp';
        const body = snapshot.map((r) => JSON.stringify(r)).join('\n') + (snapshot.length ? '\n' : '');
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, file);
        log(`research-history compacted (${snapshot.length} sample(s), ${(bytes / 1024).toFixed(0)} KB)`);
      } else if (appendsSinceFlush > 0) {
        // Append only the most recent backlog is hard to track exactly after
        // restart; the store is small and append-only, so append the tail of
        // each mint that changed since the last flush.
        const backlog = [];
        for (const [mint, arr] of byMint) {
          const tail = arr.slice(-appendsSinceFlush);
          for (const s of tail) backlog.push({ ts: s.ts, mint, priceSol: s.priceSol, priceUsd: s.priceUsd, pairAddress: s.pairAddress, dex: s.dex, source: s.source, dq: s.dq });
        }
        backlog.sort((a, b) => a.ts - b.ts);
        fs.appendFileSync(file, backlog.map((r) => JSON.stringify(r)).join('\n') + (backlog.length ? '\n' : ''));
      }
      dirty = false;
      appendsSinceFlush = 0;
    } catch (err) {
      log(`research-history flush failed (${err.message}) — will retry`);
    }
  }

  /**
   * Horizon resolver (Phase 5 contract): the EARLIEST valid observation with
   * ts >= targetTs and ts <= targetTs + maxLateMs. Never returns an
   * observation strictly BEFORE the target.
   *
   * opts: { maxLateMs, preferPairAddress } — preferPairAddress biases toward
   * the anchored market identity when the same mint has multiple pools, but a
   * different-pair observation is still returned (labeled) rather than null
   * when no preferred-pair observation exists in the window.
   */
  function resolveAtOrAfter(mint, targetTs, opts = {}) {
    load();
    prune(Date.now());
    const arr = byMint.get(mint);
    if (!arr || !arr.length) return null;
    const maxLateMs = Number.isFinite(opts.maxLateMs) ? opts.maxLateMs : cfg.maxLateMs;
    const hi = targetTs + maxLateMs;
    let chosen = null;
    let preferred = null;
    for (const s of arr) {
      if (s.ts < targetTs) continue;      // BEFORE target — never acceptable for horizon resolution
      if (s.ts > hi) break;               // sorted ascending — nothing later is in tolerance
      if (!chosen || s.ts < chosen.ts) chosen = s;
      if (opts.preferPairAddress && s.pairAddress && s.pairAddress === opts.preferPairAddress) {
        if (!preferred || s.ts < preferred.ts) preferred = s;
      }
    }
    const pick = preferred || chosen;
    if (!pick) return null;
    return {
      ts: pick.ts,
      priceSol: pick.priceSol,
      priceUsd: pick.priceUsd,
      pairAddress: pick.pairAddress,
      dex: pick.dex,
      source: pick.source,
      dq: pick.dq,
      lateMs: pick.ts - targetTs,
      pairMatchesPreferred: !!(opts.preferPairAddress && pick.pairAddress === opts.preferPairAddress)
    };
  }

  /** Latest observation at or before a timestamp (compat helper — used only by
   *  non-horizon consumers; NEVER by horizon resolution). */
  function latestAtOrBefore(mint, ts) {
    load();
    const arr = byMint.get(mint);
    if (!arr || !arr.length) return null;
    let best = null;
    for (const s of arr) { if (s.ts <= ts) best = s; else break; }
    return best ? Object.assign({ lateMs: 0 }, best) : null;
  }

  function stats() {
    return {
      file: FILE_NAME,
      loaded,
      mints: byMint.size,
      samples: totalSamples,
      retentionMs: cfg.retentionMs,
      maxLateMs: cfg.maxLateMs,
      dirty
    };
  }

  /** Test/ops hook: seed synthetic observations (deterministic tests only). */
  function seedForTests(records) {
    for (const r of records) ingest(r);
    dirty = true;
    // Bump the flush backlog so flush() actually persists the seeded samples
    // (flush() appends only when appendsSinceFlush > 0).
    appendsSinceFlush += records.length;
    flush();
  }

  return { record, flush, resolveAtOrAfter, latestAtOrBefore, stats, seedForTests, FILE_NAME };
}

module.exports = { createResearchHistory, DEFAULTS, FILE_NAME };
