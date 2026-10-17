#!/usr/bin/env node
/**
 * atlas/research-log.js — Research change log.
 *
 * Every future research modification must record:
 *   timestamp, changeId, reason, hypothesis, modifiedComponent,
 *   oldValue, newValue, expectedEffect, risk, approvalRequired, approved,
 *   evaluationDataset
 *
 * No modification may be silently introduced.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RESEARCH_LOG_FILE = 'atlas-research-log.jsonl';

/**
 * Log a research change.
 * @param db — AtlasDb instance (for persistence)
 * @param entry — { reason, hypothesis, modifiedComponent, oldValue, newValue, expectedEffect, risk, requester }
 * @returns the logged entry
 */
function logChange(db, entry = {}) {
  const record = {
    changeId: 'RC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    reason: entry.reason || 'unspecified',
    hypothesis: entry.hypothesis || null,
    modifiedComponent: entry.modifiedComponent || 'unknown',
    oldValue: entry.oldValue != null ? String(entry.oldValue) : null,
    newValue: entry.newValue != null ? String(entry.newValue) : null,
    expectedEffect: entry.expectedEffect || null,
    risk: entry.risk || 'LOW',
    approvalRequired: entry.approvalRequired !== false,
    approved: false,
    approvedBy: null,
    requester: entry.requester || 'unknown',
    evaluationDataset: entry.evaluationDataset || null,
    _note: 'Research changes must not be silently introduced.'
  };

  // Persist to JSONL
  try {
    const dir = db.dir || process.cwd();
    const f = path.join(dir, RESEARCH_LOG_FILE);
    fs.appendFileSync(f, JSON.stringify(record) + '\n');
  } catch (_) { /* best effort */ }

  return record;
}

/**
 * Get all research log entries.
 */
function getLog(db) {
  try {
    const dir = db.dir || process.cwd();
    const f = path.join(dir, RESEARCH_LOG_FILE);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

/**
 * Get recent entries.
 */
function getRecent(db, n = 10) {
  return getLog(db).slice(-n);
}

module.exports = { logChange, getLog, getRecent, RESEARCH_LOG_FILE };
