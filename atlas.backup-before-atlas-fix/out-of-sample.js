#!/usr/bin/env node
/**
 * atlas/out-of-sample.js — Out-of-sample validation for Phase 14.
 *
 * Chronologically separates observations into development/validation/OOS.
 * Never uses future observations to influence earlier decisions.
 *
 * Usage: node atlas/out-of-sample.js [--data-dir <path>]
 */

'use strict';

const { analyze, splitOutOfSample, primaryStats, bootstrapCI } = require('./robustness.js');

function validate(dataDir) {
  const robustness = analyze(dataDir);
  if (robustness.status !== 'ANALYSIS_COMPLETE') return { status: robustness.status, oos: null };
  const split = splitOutOfSample(robustness.outOfSample ? [] : []);

  // Re-load samples for OOS split
  let samples = [];
  try {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(dataDir, 'atlas/reviews', 'checkpoint-100-dataset.json');
    if (fs.existsSync(f)) { const data = JSON.parse(fs.readFileSync(f, 'utf8')); samples = data.samples || []; }
  } catch (_) {}

  const oosSplit = splitOutOfSample(samples);
  const oosStats = primaryStats(oosSplit.outOfSample);

  return {
    status: 'OK',
    development: primaryStats(oosSplit.development),
    validation: primaryStats(oosSplit.validation),
    outOfSample: oosStats,
    boundaries: oosSplit.boundaries,
    insufficient: oosSplit.insufficient,
    directionConsistent: oosStats.mean !== null && robustness.primary.mean !== null &&
      ((oosStats.mean > 0 && robustness.primary.mean > 0) || (oosStats.mean < 0 && robustness.primary.mean < 0))
  };
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = validate(dataDir);
  console.log('OUT-OF-SAMPLE VALIDATION');
  console.log('Status:', result.status);
  if (result.insufficient) console.log('NOTE: Insufficient OOS observations');
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { validate };
