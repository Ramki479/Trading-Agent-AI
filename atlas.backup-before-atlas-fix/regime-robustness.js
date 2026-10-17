#!/usr/bin/env node
/**
 * atlas/regime-robustness.js — Regime-specific robustness for Phase 14.
 *
 * Evaluates ATLAS performance under different market regimes.
 *
 * Usage: node atlas/regime-robustness.js [--data-dir <path>]
 */

'use strict';

const { analyze, regimeRobustness, regimeTransitions } = require('./robustness.js');

function validate(dataDir) {
  const robustness = analyze(dataDir);
  if (robustness.status !== 'ANALYSIS_COMPLETE') return { status: robustness.status, regimes: {}, transitions: {} };
  return { status: 'OK', regimes: robustness.regimes, transitions: robustness.transitions };
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = validate(dataDir);
  console.log('REGIME ROBUSTNESS');
  console.log('Status:', result.status);
  for (const [r, data] of Object.entries(result.regimes)) { console.log(`  ${r}: n=${data.n}, status=${data.status}`); }
  console.log('Transitions:', result.transitions.transitionCount || 0);
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { validate };
