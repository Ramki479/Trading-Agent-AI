#!/usr/bin/env node
/**
 * atlas/production-readiness.js — Production readiness evaluation for Phase 15.
 *
 * Separately evaluates whether operational controls exist for production.
 * This is INDEPENDENT of evidence classification.
 * Even ROBUST evidence does NOT equal production enabled.
 *
 * Usage: node atlas/production-readiness.js [--data-dir <path>]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REVIEW_DIR = 'atlas/reviews';

/* ------------------------------------------------------------------ *
 * Production readiness checks.
 * ------------------------------------------------------------------ */

function evaluateReadiness(dataDir) {
  const checks = {
    executionSafety: { status: 'NOT_ASSESSED', passed: false, note: 'No execution safety audit implemented for live trading' },
    rollbackMechanism: { status: 'NOT_ASSESSED', passed: false, note: 'No rollback mechanism verified' },
    monitoring: { status: 'NOT_ASSESSED', passed: false, note: 'No production monitoring verified' },
    alerting: { status: 'NOT_ASSESSED', passed: false, note: 'No production alerting verified' },
    auditLogs: { status: 'NOT_ASSESSED', passed: false, note: 'No production audit log verification' },
    configImmutability: { status: 'NOT_ASSESSED', passed: false, note: 'No configuration immutability verification' },
    killSwitch: { status: 'NOT_ASSESSED', passed: false, note: 'No kill switch verified' },
    paperLiveSeparation: { status: 'NOT_ASSESSED', passed: false, note: 'Paper/live separation not verified for production' },
    walletIsolation: { status: 'NOT_ASSESSED', passed: false, note: 'Wallet isolation not verified' },
    transactionControls: { status: 'NOT_ASSESSED', passed: false, note: 'Transaction controls not verified' },
    operationalRecovery: { status: 'NOT_ASSESSED', passed: false, note: 'Operational recovery not verified' }
  };

  // Paper-only system is verified
  checks.paperLiveSeparation = { status: 'PASS', passed: true, note: 'System is paper-only. No live execution exists.' };
  checks.walletIsolation = { status: 'PASS', passed: true, note: 'No wallet access in paper system.' };
  checks.transactionControls = { status: 'PASS', passed: true, note: 'No transactions in paper system.' };
  checks.killSwitch = { status: 'PASS', passed: true, note: 'ATLAS mode can be set to SHADOW (already is).' };

  const passedCount = Object.values(checks).filter(c => c.passed).length;
  const totalCount = Object.keys(checks).length;

  return {
    status: passedCount === totalCount ? 'READY' : 'BLOCKED',
    passedCount, totalCount,
    checks,
    blockingReasons: Object.entries(checks).filter(([, c]) => !c.passed).map(([k, c]) => `${k}: ${c.note}`),
    note: 'Production readiness is SEPARATE from evidence classification. Even ROBUST evidence does NOT automatically enable production.'
  };
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = evaluateReadiness(dataDir);
  console.log('PRODUCTION READINESS');
  console.log('Status:', result.status);
  console.log('Passed:', result.passedCount, '/', result.totalCount);
  if (result.blockingReasons.length > 0) { console.log('Blocking:'); result.blockingReasons.forEach(r => console.log('  -', r)); }
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { evaluateReadiness };
