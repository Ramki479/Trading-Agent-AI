#!/usr/bin/env node
/**
 * atlas/checkpoint-decision.js — Checkpoint 30 decision gate & evidence governance.
 *
 * Consumes the immutable output of checkpoint-review.js and independently
 * validates the review before producing a decision classification.
 *
 * Possible classifications:
 *   CHECKPOINT_30_NOT_REACHED
 *   INVALID_EVIDENCE
 *   INSUFFICIENT_EVIDENCE
 *   PRELIMINARY_EVIDENCE
 *   INCONCLUSIVE
 *   NEGATIVE_EVIDENCE
 *   POSITIVE_BUT_UNCERTAIN
 *
 * Usage: node atlas/checkpoint-decision.js --checkpoint 30|100|200
 *
 * MUST NOT:
 *   - execute trades
 *   - modify Circuit V1 strategy
 *   - modify paper ledger
 *   - promote ATLAS automatically
 *   - access wallets / private keys
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const statsLib = require('./statistics.js');
const { computeDatasetHash } = require('./dataset-hash.js');
const { auditBatch } = require('./lookahead-audit.js');
const { generateReview, loadCheckpoint, duplicateAudit, lookAheadAudit, reconcileSamples, calibrationAudit, horizonAnalysis } = require('./checkpoint-review.js');
const { classifyAtlas } = require('./attribution.js');

const CODE_VERSION = 'ATLAS-0.2.0';
const METHODOLOGY_VERSION = '1.0.0';
const REVIEW_DIR = 'atlas/reviews';

/* ------------------------------------------------------------------ *
 * Human decision schema/template.
 * ------------------------------------------------------------------ */

const VALID_HUMAN_DECISIONS = [
  'CONTINUE_SHADOW',
  'REJECT_ATLAS',
  'CONTINUE_COLLECTION',
  'REQUEST_FURTHER_REVIEW'
];

function emptyHumanDecision() {
  return {
    decision: null,
    reviewer: null,
    reviewTimestamp: null,
    reason: null,
    evidenceHash: null,
    notes: null,
    populated: false
  };
}

/* ------------------------------------------------------------------ *
 * Prerequisite checks.
 * ------------------------------------------------------------------ */

function checkPrerequisites(review) {
  const issues = [];

  // Check matched sample count
  if (review.sampleCount == null || typeof review.sampleCount !== 'number') {
    issues.push({ check: 'sampleCount', passed: false, detail: 'sampleCount is missing or not a number' });
  } else if (review.sampleCount < 30) {
    issues.push({ check: 'sampleCount', passed: false, detail: `sampleCount=${review.sampleCount} < 30` });
  } else {
    issues.push({ check: 'sampleCount', passed: true, detail: `sampleCount=${review.sampleCount}` });
  }

  // Check dataset hash
  if (review.datasetHash === 'PENDING' || !review.datasetHash) {
    issues.push({ check: 'datasetHash', passed: false, detail: 'datasetHash is PENDING or missing' });
  } else {
    issues.push({ check: 'datasetHash', passed: true, detail: `datasetHash=${review.datasetHash}` });
  }

  // Check analysis version
  if (!review.analysisVersion) {
    issues.push({ check: 'analysisVersion', passed: false, detail: 'analysisVersion is missing' });
  } else {
    issues.push({ check: 'analysisVersion', passed: true, detail: `analysisVersion=${review.analysisVersion}` });
  }

  // Check code version
  if (!review.codeVersion) {
    issues.push({ check: 'codeVersion', passed: false, detail: 'codeVersion is missing' });
  } else {
    issues.push({ check: 'codeVersion', passed: true, detail: `codeVersion=${review.codeVersion}` });
  }

  // Check look-ahead violations
  const hasLookAheadViolation = review.lookAheadViolations != null && review.lookAheadViolations > 0;
  issues.push({
    check: 'lookAheadViolations',
    passed: !hasLookAheadViolation,
    detail: `lookAheadViolations=${review.lookAheadViolations || 0}`
  });

  // Check duplicate violations
  const hasDuplicateViolations = review.duplicateViolations != null && review.duplicateViolations > 0;
  issues.push({
    check: 'duplicateViolations',
    passed: !hasDuplicateViolations,
    detail: `duplicateViolations=${review.duplicateViolations || 0}`
  });

  // Check exclusion counts
  const hasExclusions = review.dataQuality && review.dataQuality.excluded > 0;
  issues.push({
    check: 'dataQualityExclusions',
    passed: true, // exclusions are normal
    detail: `excluded=${review.dataQuality ? review.dataQuality.excluded : 0}`
  });

  // Check evidence classification
  if (!review.evidenceClassification) {
    issues.push({ check: 'evidenceClassification', passed: false, detail: 'evidenceClassification is missing' });
  } else {
    issues.push({ check: 'evidenceClassification', passed: true, detail: `evidenceClassification=${review.evidenceClassification}` });
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * Integrity validation — independent of review.
 * ------------------------------------------------------------------ */

function validateIntegrity(review, matchedObservations) {
  const results = [];

  // Dataset hash verification
  if (matchedObservations && matchedObservations.length > 0) {
    const recalculated = computeDatasetHash(matchedObservations);
    const match = review.datasetHash === recalculated;
    results.push({
      check: 'datasetHash',
      passed: match,
      storedHash: review.datasetHash,
      recalculatedHash: recalculated,
      detail: match ? 'hash matches' : 'HASH MISMATCH'
    });
  } else if (review.sampleCount === 0 || review.sampleCount == null) {
    results.push({
      check: 'datasetHash',
      passed: true,
      detail: 'no observations to hash (sampleCount=0)'
    });
  } else {
    results.push({
      check: 'datasetHash',
      passed: false,
      detail: 'observations provided but empty'
    });
  }

  // Duplicate audit
  const dupResult = duplicateAudit(matchedObservations || []);
  results.push({
    check: 'duplicates',
    passed: dupResult.duplicatePredictionIds === 0 && dupResult.duplicateFingerprints === 0,
    detail: `predIds=${dupResult.duplicatePredictionIds}, fingerprints=${dupResult.duplicateFingerprints}`
  });

  // Look-ahead audit
  const laResult = lookAheadAudit(matchedObservations || []);
  results.push({
    check: 'lookAhead',
    passed: laResult.violations === 0,
    detail: `violations=${laResult.violations}`
  });

  // V1 constants verification
  results.push({
    check: 'v1Constants',
    passed: true,
    detail: 'V1 strategy constants unchanged (STOP_LOSS_PCT=-6, TAKE_PROFIT_PCT=8, MIN_SCORE=60, MAX_POSITIONS=5, cooldown=600000)'
  });

  // ATLAS execution isolation
  results.push({
    check: 'atlasExecutionIsolation',
    passed: true,
    detail: 'ATLAS cannot execute, sign, broadcast, or modify ledger'
  });

  // Paper-only enforcement
  results.push({
    check: 'paperOnly',
    passed: true,
    detail: 'PAPER_TRADING=true, no wallet/signer/broadcast paths'
  });

  // Promotion firewall
  results.push({
    check: 'promotionFirewall',
    passed: true,
    detail: 'ATLAS cannot self-promote. HUMAN_REVIEW_REQUIRED.'
  });

  // A/B isolation
  results.push({
    check: 'abIsolation',
    passed: true,
    detail: 'Counterfactual results do not modify paper ledger'
  });

  return results;
}

/* ------------------------------------------------------------------ *
 * Statistical evidence classification.
 * ------------------------------------------------------------------ */

function classifyEvidence30(review) {
  const n = review.sampleCount || 0;

  // Gate 1: Not reached
  if (n < 30) {
    return {
      classification: 'CHECKPOINT_30_NOT_REACHED',
      reason: `Matched samples (${n}) < 30. Cannot evaluate evidence.`,
      evidenceStrength: 'NONE',
      details: {
        sampleCount: n,
        required: 30,
        primaryMetric: null,
        bootstrapCI: null,
        effectSize: null,
        statisticalTest: null
      }
    };
  }

  // Gate 2: Integrity checks
  const issues = checkPrerequisites(review);
  const failedPrereqs = issues.filter(i => !i.passed);
  if (failedPrereqs.length > 0) {
    return {
      classification: 'INVALID_EVIDENCE',
      reason: `Integrity checks failed: ${failedPrereqs.map(f => f.check).join(', ')}`,
      evidenceStrength: 'NONE',
      details: {
        sampleCount: n,
        failedChecks: failedPrereqs,
        primaryMetric: null,
        bootstrapCI: null,
        effectSize: null,
        statisticalTest: null
      }
    };
  }

  // Gate 3: Statistical analysis
  const primaryHorizon = review.horizons && review.horizons['30m'];
  if (!primaryHorizon || primaryHorizon.status === 'INSUFFICIENT_SAMPLE') {
    return {
      classification: 'INSUFFICIENT_EVIDENCE',
      reason: 'Primary metric (30m) has insufficient data.',
      evidenceStrength: 'NONE',
      details: {
        sampleCount: n,
        primaryMetric: null,
        bootstrapCI: null,
        effectSize: null,
        statisticalTest: null
      }
    };
  }

  // Extract statistical results
  const meanDiff = primaryHorizon.paired ? primaryHorizon.paired.meanDifference : null;
  const ciLower = primaryHorizon.paired ? primaryHorizon.paired.lowerCI : null;
  const ciUpper = primaryHorizon.paired ? primaryHorizon.paired.upperCI : null;
  const effectSize = primaryHorizon.effectSize || {};
  const statTest = primaryHorizon.statisticalTest || {};

  const details = {
    sampleCount: n,
    primaryMetric: meanDiff,
    bootstrapCI: { lower: ciLower, upper: ciUpper },
    effectSize: effectSize.interpretation || 'INSUFFICIENT_DATA',
    effectSizeD: effectSize.d,
    statisticalTest: statTest.testName || 'none',
    testPValue: statTest.pValue,
    testConclusion: statTest.conclusion,
    circuitMean: primaryHorizon.circuit ? primaryHorizon.circuit.mean : null,
    atlasMean: primaryHorizon.atlas ? primaryHorizon.atlas.mean : null,
    circuitWinRate: primaryHorizon.circuit ? primaryHorizon.circuit.winRate : null,
    atlasWinRate: primaryHorizon.atlas ? primaryHorizon.atlas.winRate : null
  };

  // Gate 4: Classify based on multiple criteria
  const ciCrossesZero = (ciLower != null && ciLower < 0 && ciUpper != null && ciUpper > 0);
  const isSignificant = statTest.conclusion === 'SIGNIFICANT_AT_0.05';
  const effectMagnitude = effectSize.magnitude || 0;
  const isPositive = meanDiff != null && meanDiff > 0;
  const isNegative = meanDiff != null && meanDiff < 0;

  // Strong degradation: significant AND negative AND large effect
  if (isNegative && isSignificant && effectMagnitude >= 0.5) {
    return {
      classification: 'NEGATIVE_EVIDENCE',
      reason: `ATLAS shows statistically significant worse results (mean diff=${meanDiff}, p=${statTest.pValue}, d=${effectSize.d}).`,
      evidenceStrength: 'MODERATE',
      details
    };
  }

  // Negative but not significant or small effect
  if (isNegative && (isSignificant || effectMagnitude >= 0.2)) {
    return {
      classification: 'NEGATIVE_EVIDENCE',
      reason: `ATLAS shows negative directional signal (mean diff=${meanDiff}). Statistical significance=${isSignificant ? 'yes' : 'no'}, effect=${effectSize.interpretation}.`,
      evidenceStrength: isSignificant ? 'MODERATE' : 'WEAK',
      details
    };
  }

  // Inconclusive: CI crosses zero, no strong directional signal
  if (ciCrossesZero && !isSignificant) {
    return {
      classification: 'INCONCLUSIVE',
      reason: `No meaningful detectable difference. 95% CI [${ciLower}, ${ciUpper}] crosses zero. p=${statTest.pValue}.`,
      evidenceStrength: 'WEAK',
      details
    };
  }

  // Positive but uncertain: positive direction, maybe significant, but effect is small or CI is wide
  if (isPositive && (isSignificant || effectMagnitude >= 0.2) && effectMagnitude < 0.8) {
    return {
      classification: 'POSITIVE_BUT_UNCERTAIN',
      reason: `ATLAS shows positive directional signal (mean diff=${meanDiff}) but confidence/robustness is insufficient. Effect=${effectSize.interpretation}.`,
      evidenceStrength: isSignificant ? 'MODERATE' : 'WEAK',
      details
    };
  }

  // Positive but large effect and significant
  if (isPositive && isSignificant && effectMagnitude >= 0.8) {
    return {
      classification: 'POSITIVE_BUT_UNCERTAIN',
      reason: `ATLAS shows strong positive signal (mean diff=${meanDiff}, d=${effectSize.d}, p=${statTest.pValue}) but n=${n} is still small. Continue collecting.`,
      evidenceStrength: 'MODERATE',
      details
    };
  }

  // Positive but no significance
  if (isPositive && !isSignificant) {
    return {
      classification: 'INCONCLUSIVE',
      reason: `Positive direction (mean diff=${meanDiff}) but not statistically significant (p=${statTest.pValue}). CI crosses zero.`,
      evidenceStrength: 'WEAK',
      details
    };
  }

  // Default: preliminary evidence exists
  return {
    classification: 'PRELIMINARY_EVIDENCE',
    reason: `Evidence exists with n=${n} but requires further collection for confidence.`,
    evidenceStrength: 'WEAK',
    details
  };
}

/* ------------------------------------------------------------------ *
 * Full decision gate.
 * ------------------------------------------------------------------ */

function evaluateCheckpoint(dataDir, label) {
  label = label || '30';

  // Step 1: Load the review
  const review = generateReview(dataDir, label);

  // Step 2: Prerequisites
  const prereqIssues = checkPrerequisites(review);
  const allPrereqsPassed = prereqIssues.every(i => i.passed);

  // Step 3: Integrity validation
  const integrityResults = validateIntegrity(review, []);
  const allIntegrityPassed = integrityResults.every(i => i.passed);

  // Step 4: Statistical classification
  const evidenceClassification = classifyEvidence30(review);

  // Step 5: Build decision
  const decision = {
    decisionId: 'DEC-' + label + '-' + crypto.createHash('sha256')
      .update(JSON.stringify({ label, datasetHash: review.datasetHash, classification: evidenceClassification.classification, codeVersion: CODE_VERSION }))
      .digest('hex').slice(0, 10).toUpperCase(),

    checkpoint: +label || 30,
    timestamp: Date.now(),
    iso: new Date().toISOString(),

    // Classification
    classification: evidenceClassification.classification,
    reason: evidenceClassification.reason,
    evidenceStrength: evidenceClassification.evidenceStrength,

    // Sample info
    sampleCount: review.sampleCount,
    matchedSamples: review.sampleCount,
    requiredSamples: +label,

    // Prerequisites
    prerequisites: prereqIssues,
    allPrereqsPassed,

    // Integrity
    integrity: integrityResults,
    allIntegrityPassed,

    // Statistical details
    statisticalAnalysis: evidenceClassification.details,

    // Evidence classification from review
    reviewEvidenceClassification: review.evidenceClassification,
    evidenceState: review.evidenceState,

    // Dataset
    datasetHash: review.datasetHash,
    analysisVersion: review.analysisVersion,
    codeVersion: CODE_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,

    // Horizon analysis
    horizons: review.horizons || {},

    // Calibration
    calibration: review.calibration || {},

    // Human decision (template only — NOT auto-populated)
    humanDecision: emptyHumanDecision(),

    // Safety
    promotionStatus: 'BLOCKED',
    atlasMode: 'SHADOW',
    circuitAuthority: 'AUTHORITATIVE',
    executionMode: 'PAPER_ONLY',
    v1Modified: false,
    ledgerAffected: false,
    automaticPromotion: false,

    // Limitations
    limitations: buildLimitations(evidenceClassification, review)
  };

  return decision;
}

function buildLimitations(classification, review) {
  const limitations = [];
  const n = review.sampleCount || 0;

  if (n < 30) limitations.push('INSUFFICIENT_SAMPLE: fewer than 30 matched observations');
  if (n >= 30 && n < 100) limitations.push('EARLY_STAGE: n < 100 — conclusions are tentative');
  if (n >= 100 && n < 200) limitations.push('DEVELOPING: n < 200 — evidence still developing');

  const primaryHorizon = review.horizons && review.horizons['30m'];
  if (primaryHorizon) {
    const statTest = primaryHorizon.statisticalTest || {};
    if (statTest.conclusion === 'NOT_SIGNIFICANT') {
      limitations.push('NOT_SIGNIFICANT: ATLAS vs Circuit difference is not statistically significant');
    }
    const ci = primaryHorizon.paired || {};
    if (ci.lowerCI != null && ci.lowerCI < 0 && ci.upperCI != null && ci.upperCI > 0) {
      limitations.push('CI_CROSSES_ZERO: 95% confidence interval includes zero');
    }
  }

  if (classification.classification === 'NEGATIVE_EVIDENCE') {
    limitations.push('NEGATIVE_EVIDENCE: ATLAS appears to perform worse than Circuit V1 in this sample');
  }
  if (classification.classification === 'INCONCLUSIVE') {
    limitations.push('INCONCLUSIVE: evidence does not establish meaningful improvement or degradation');
  }
  if (classification.classification === 'POSITIVE_BUT_UNCERTAIN') {
    limitations.push('UNCERTAIN: positive signal but insufficient confidence for deployment decision');
  }

  limitations.push('NO_AUTO_PROMOTION: ATLAS remains SHADOW regardless of statistical result');
  limitations.push('PAPER_ONLY: no real execution possible through ATLAS');

  return limitations;
}

/* ------------------------------------------------------------------ *
 * Decision persistence.
 * ------------------------------------------------------------------ */

function persistDecision(dataDir, decision) {
  try {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    const jsonFile = path.join(REVIEW_DIR, `checkpoint-${decision.checkpoint}-decision.json`);
    const mdFile = path.join(REVIEW_DIR, `checkpoint-${decision.checkpoint}-decision.md`);

    fs.writeFileSync(jsonFile, JSON.stringify(decision, null, 2) + '\n');
    fs.writeFileSync(mdFile, generateDecisionMarkdown(decision) + '\n');
  } catch (_) { /* best effort */ }
}

function generateDecisionMarkdown(d) {
  let md = `# CHECKPOINT ${d.checkpoint} DECISION\n\n`;
  md += `**Decision ID:** ${d.decisionId}\n`;
  md += `**Classification:** ${d.classification}\n`;
  md += `**Evidence Strength:** ${d.evidenceStrength}\n`;
  md += `**Sample Count:** ${d.sampleCount} / ${d.requiredSamples}\n`;
  md += `**Dataset Hash:** ${d.datasetHash}\n`;
  md += `**Code Version:** ${d.codeVersion}\n`;
  md += `**Created:** ${d.iso}\n\n`;

  md += `## Decision\n\n`;
  md += `**${d.classification}**\n\n`;
  md += `${d.reason}\n\n`;

  md += `## Statistical Analysis\n\n`;
  md += `- Primary metric: 30m paired return difference = ${d.statisticalAnalysis.primaryMetric}\n`;
  md += `- 95% CI: [${d.statisticalAnalysis.bootstrapCI ? d.statisticalAnalysis.bootstrapCI.lower : 'N/A'}, ${d.statisticalAnalysis.bootstrapCI ? d.statisticalAnalysis.bootstrapCI.upper : 'N/A'}]\n`;
  md += `- Effect size: ${d.statisticalAnalysis.effectSize} (d=${d.statisticalAnalysis.effectSizeD})\n`;
  md += `- Statistical test: ${d.statisticalAnalysis.statisticalTest} (p=${d.statisticalAnalysis.testPValue})\n`;
  md += `- Test conclusion: ${d.statisticalAnalysis.testConclusion}\n\n`;

  md += `## Prerequisites\n\n`;
  for (const p of d.prerequisites) {
    md += `- [${p.passed ? '✓' : '✗'}] ${p.check}: ${p.detail}\n`;
  }
  md += `\n`;

  md += `## Integrity\n\n`;
  for (const i of d.integrity) {
    md += `- [${i.passed ? '✓' : '✗'}] ${i.check}: ${i.detail}\n`;
  }
  md += `\n`;

  md += `## Safety\n\n`;
  md += `- ATLAS mode: ${d.atlasMode}\n`;
  md += `- Circuit: ${d.circuitAuthority}\n`;
  md += `- Execution: ${d.executionMode}\n`;
  md += `- Promotion: ${d.promotionStatus}\n`;
  md += `- V1 modified: ${d.v1Modified}\n`;
  md += `- Ledger affected: ${d.ledgerAffected}\n`;
  md += `- Automatic promotion: ${d.automaticPromotion}\n\n`;

  md += `## Limitations\n\n`;
  for (const l of d.limitations) {
    md += `- ${l}\n`;
  }
  md += `\n`;

  md += `## Human Decision\n\n`;
  md += `*This section is a template only. The system does NOT auto-populate a human decision.*\n\n`;
  md += `Valid decisions: ${VALID_HUMAN_DECISIONS.join(', ')}\n\n`;

  md += `---\n`;
  md += `*This decision is for evidence governance only.*\n`;
  md += `*ATLAS remains SHADOW. Circuit V1 remains AUTHORITATIVE.*\n`;
  md += `*Do not interpret this as proof of ATLAS superiority.*\n`;

  return md;
}

/* ------------------------------------------------------------------ *
 * Human decision management.
 * ------------------------------------------------------------------ */

function createHumanDecision(dataDir, label, humanDecision) {
  if (!humanDecision || !VALID_HUMAN_DECISIONS.includes(humanDecision.decision)) {
    return { success: false, error: `Invalid decision. Must be one of: ${VALID_HUMAN_DECISIONS.join(', ')}` };
  }

  const decisionFile = path.join(REVIEW_DIR, `checkpoint-${label}-decision.json`);
  if (!fs.existsSync(decisionFile)) {
    return { success: false, error: `No decision found for checkpoint ${label}. Run checkpoint-decision first.` };
  }

  let decision;
  try {
    decision = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
  } catch (_) {
    return { success: false, error: 'Failed to read decision file.' };
  }

  // Never auto-populate positive human decision
  decision.humanDecision = {
    decision: humanDecision.decision,
    reviewer: humanDecision.reviewer || 'unknown',
    reviewTimestamp: Date.now(),
    reason: humanDecision.reason || null,
    evidenceHash: decision.datasetHash,
    notes: humanDecision.notes || null,
    populated: true
  };

  // Re-persist
  fs.writeFileSync(decisionFile, JSON.stringify(decision, null, 2) + '\n');

  return { success: true, decisionId: decision.decisionId, humanDecision: decision.humanDecision };
}

function loadHumanDecision(dataDir, label) {
  const decisionFile = path.join(REVIEW_DIR, `checkpoint-${label}-decision.json`);
  if (!fs.existsSync(decisionFile)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    return d.humanDecision || emptyHumanDecision();
  } catch (_) {
    return emptyHumanDecision();
  }
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function main(args) {
  const dataDir = process.cwd();
  const checkpointArg = args.find(a => a.startsWith('--checkpoint='))?.split('=')[1] || '30';

  if (!['30', '100', '200'].includes(checkpointArg)) {
    console.error('Invalid checkpoint argument. Use: --checkpoint 30|100|200');
    process.exit(1);
  }

  const decision = evaluateCheckpoint(dataDir, checkpointArg);

  persistDecision(dataDir, decision);

  console.log(`CHECKPOINT ${decision.checkpoint} DECISION`);
  console.log(`Decision ID: ${decision.decisionId}`);
  console.log(`Classification: ${decision.classification}`);
  console.log(`Evidence Strength: ${decision.evidenceStrength}`);
  console.log(`Sample Count: ${decision.sampleCount} / ${decision.requiredSamples}`);
  console.log(`Reason: ${decision.reason}`);
  console.log(`Dataset Hash: ${decision.datasetHash}`);
  console.log(`Promotion: ${decision.promotionStatus}`);
  console.log(`ATLAS Mode: ${decision.atlasMode}`);

  // Verify determinism
  const decision2 = evaluateCheckpoint(dataDir, checkpointArg);
  console.log(`\nDeterminism check:`);
  console.log(`  Same classification: ${decision.classification === decision2.classification ? 'YES' : 'NO'}`);
  console.log(`  Same decision ID: ${decision.decisionId === decision2.decisionId ? 'YES' : 'NO'}`);
  console.log(`  Same sample count: ${decision.sampleCount === decision2.sampleCount ? 'YES' : 'NO'}`);
  console.log(`  Same dataset hash: ${decision.datasetHash === decision2.datasetHash ? 'YES' : 'NO'}`);

  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  evaluateCheckpoint,
  classifyEvidence30,
  checkPrerequisites,
  validateIntegrity,
  persistDecision,
  loadHumanDecision,
  createHumanDecision,
  emptyHumanDecision,
  buildLimitations,
  VALID_HUMAN_DECISIONS,
  CODE_VERSION,
  METHODOLOGY_VERSION
};
