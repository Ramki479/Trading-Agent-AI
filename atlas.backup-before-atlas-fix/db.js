#!/usr/bin/env node
/**
 * atlas/db.js — ATLAS persistence interface.
 *
 * Default implementation: append-only JSONL + JSON snapshots in the agent data
 * directory. This is restart-safe, requires no new runtime dependency, and
 * matches the existing pattern in the repo (trades.jsonl, decisions.jsonl,
 * metrics.json).
 *
 * The interface is intentionally small so a SQLite backend can be swapped in on
 * the server later without touching the rest of ATLAS.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PREDICTIONS_FILE = 'atlas-predictions.jsonl';
const OUTCOMES_FILE = 'atlas-outcomes.jsonl';
const REPUTATION_FILE = 'atlas-reputation.json';
const EXPERIMENTS_FILE = 'atlas-experiments.json';
const EVIDENCE_FILE = 'atlas-evidence.jsonl';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function ensureDir(dir) {
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
}

/** Read JSONL into array of parsed objects. */
function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

/** Append one JSON line, create file/dir if needed. */
function appendJsonl(dir, file, obj) {
  ensureDir(dir);
  const f = path.join(dir, file);
  try {
    fs.appendFileSync(f, JSON.stringify(obj) + '\n');
  } catch (_) { /* best effort */ }
}

/** Read JSON snapshot, or default. */
function readJsonSnapshot(file, defaultObj) {
  if (!file || !fs.existsSync(file)) return defaultObj ? Object.assign({}, defaultObj) : null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return defaultObj ? Object.assign({}, defaultObj) : null; }
}

/** Atomic write JSON snapshot. */
function writeJsonSnapshot(dir, file, obj) {
  ensureDir(dir);
  const f = path.join(dir, file);
  const tmp = f + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, f);
  } catch (_) { /* best effort */ }
}

/**
 * ATLAS DB interface. Kept deliberately small so a SQLite implementation can
 * replace this without changing the rest of ATLAS.
 *
 * ALL entries carry `ts` (ms) and are append-only. Timestamps are the source of
 * truth for look-ahead-free prediction evaluation.
 */
class AtlasDb {
  constructor(dir) {
    this.dir = dir || process.cwd();
    ensureDir(this.dir);
  }

  // ---- predictions ----
  appendPrediction(prediction) {
    appendJsonl(this.dir, PREDICTIONS_FILE, prediction);
  }

  predictions() {
    return readJsonl(path.join(this.dir, PREDICTIONS_FILE));
  }

  predictionsFor(mint, since, until, opts = {}) {
    const list = this.predictions();
    const out = [];
    const seen = new Set();
    for (const p of list) {
      if (p.mint !== mint) continue;
      if (opts.pairAddress != null && p.pairAddress != null && p.pairAddress !== opts.pairAddress) continue;
      if (!Number.isFinite(p.ts)) continue;
      if (since != null && p.ts < since) continue;
      if (until != null && p.ts > until) continue;
      if (seen.has(p.predictionId)) continue;
      seen.add(p.predictionId);
      out.push(p);
    }
    return out;
  }

  dedupPredictionId() {
    const seen = new Set();
    const out = [];
    for (const p of this.predictions()) {
      if (!p.predictionId) continue;
      if (seen.has(p.predictionId)) continue;
      seen.add(p.predictionId);
      out.push(p);
    }
    return out;
  }

  // ---- outcomes ----
  appendOutcome(outcome) {
    appendJsonl(this.dir, OUTCOMES_FILE, outcome);
  }

  outcomes() {
    return readJsonl(path.join(this.dir, OUTCOMES_FILE));
  }

  // ---- evidence ----
  appendEvidence(ev) {
    appendJsonl(this.dir, EVIDENCE_FILE, ev);
  }

  evidence() {
    return readJsonl(path.join(this.dir, EVIDENCE_FILE));
  }

  // ---- reputation ----
  reputation() {
    return readJsonSnapshot(path.join(this.dir, REPUTATION_FILE), emptyReputation());
  }

  writeReputation(repo) {
    writeJsonSnapshot(this.dir, REPUTATION_FILE, repo);
  }

  // ---- experiments ----
  experiments() {
    return readJsonSnapshot(path.join(this.dir, EXPERIMENTS_FILE), emptyExperiments());
  }

  writeExperiments(exps) {
    writeJsonSnapshot(this.dir, EXPERIMENTS_FILE, exps);
  }

  // ---- generic JSON read/write ----
  readJson(filename) {
    return readJsonSnapshot(path.join(this.dir, filename), null);
  }

  writeJson(filename, obj) {
    writeJsonSnapshot(this.dir, filename, obj);
  }
}

function emptyReputation() {
  return {
    version: 1,
    updatedAt: null,
    agents: {},
    regimes: {},
    calibration: {},
    darwinWeights: {}
  };
}

function emptyExperiments() {
  return { version: 1, experiments: [], updatedAt: null };
}

module.exports = { AtlasDb, PREDICTIONS_FILE, OUTCOMES_FILE, REPUTATION_FILE, EXPERIMENTS_FILE, EVIDENCE_FILE, clamp };
