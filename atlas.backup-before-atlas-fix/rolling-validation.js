#!/usr/bin/env node
/**
 * atlas/rolling-validation.js — Rolling window validation for Phase 14.
 *
 * Calculates rolling metrics across 20/30/50/100 observation windows.
 *
 * Usage: node atlas/rolling-validation.js [--data-dir <path>]
 */

'use strict';

const { analyze, rollingWindows } = require('./robustness.js');

function validate(dataDir) {
  const robustness = analyze(dataDir);
  if (robustness.status !== 'ANALYSIS_COMPLETE') return { status: robustness.status, windows: {} };
  return { status: 'OK', windows: robustness.rolling };
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = validate(dataDir);
  console.log('ROLLING VALIDATION');
  console.log('Status:', result.status);
  for (const [w, data] of Object.entries(result.windows)) { console.log(`  ${w}: ${data.status} ${data.status === 'OK' ? `(n=${data.sampleSize}, mean=${data.mean})` : ''}`); }
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { validate };
