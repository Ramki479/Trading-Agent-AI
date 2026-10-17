#!/usr/bin/env node
/**
 * atlas/final-review.js — Final review & human decision template for Phase 15.
 *
 * Produces the final evidence report, production readiness assessment,
 * and human decision template.
 *
 * Usage: node atlas/final-review.js [--data-dir <path>]
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { consolidate } = require('./evidence-consolidator.js');
const { decide } = require('./final-decision.js');
const { evaluateReadiness } = require('./production-readiness.js');

const REVIEW_DIR = 'atlas/reviews';

function sha256Hex(data) { return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex'); }
function deterministicReviewId(datasetHash, sampleCount) { return 'FINAL-' + sha256Hex(`hash=${datasetHash}&n=${sampleCount}`).slice(0, 12).toUpperCase(); }

function review(dataDir) {
  const evidence = consolidate(dataDir);
  const decision = decide(dataDir);
  const readiness = evaluateReadiness(dataDir);

  const reviewId = deterministicReviewId(evidence.datasetHash || 'EMPTY', evidence.sampleCount || 0);

  const humanReview = {
    whatWeKnow: evidence.sampleCount > 0
      ? `We have ${evidence.sampleCount} matched observations. Primary delta30 mean=${evidence.primary ? evidence.primary.mean : 'N/A'}. Classification: ${evidence.classification}.`
      : 'No matched observations available.',
    whatWeDontKnow: 'Long-term regime persistence, agent drift across extended periods, calibration stability, production operational readiness.',
    outOfSampleResult: evidence.sampleCount >= 100 ? 'OOS evidence is EXPLORATORY (n>=100).' : 'Insufficient OOS observations.',
    temporalStability: evidence.sampleCount >= 8 ? 'Temporal analysis is EXPLORATORY.' : 'Insufficient temporal data.',
    regimeRobustness: evidence.sampleCount >= 10 ? 'Regime analysis is EXPLORATORY.' : 'Insufficient regime data.',
    agentRobustness: evidence.sampleCount >= 10 ? 'Agent analysis is EXPLORATORY.' : 'Insufficient agent data.',
    calibration: evidence.sampleCount >= 10 ? 'Calibration analysis is EXPLORATORY.' : 'Insufficient calibration data.',
    overfittingRisks: evidence.overfitting ? evidence.overfitting.status : 'NOT_ASSESSED',
    productionReadiness: readiness.status,
    limitations: `n=${evidence.sampleCount || 0}. Statistical significance ≠ trading usefulness. All subgroup findings are EXPLORATORY. Production readiness requires separate operational verification.`,
    recommendation: decision.recommendation,
    evidenceClassification: evidence.classification
  };

  return {
    reviewId, phase: 15,
    evidenceClassification: evidence.classification,
    sampleCount: evidence.sampleCount,
    datasetHash: evidence.datasetHash,
    humanDecisionRequired: true, automaticPromotion: false,
    humanReview, decision, readiness,
    evidence, promotion: { result: 'NOT_READY', automaticallyPromoted: false, note: 'Human review required. ATLAS remains SHADOW.' }
  };
}

function persistArtifacts(dataDir, reviewResult) {
  try {
    const dir = path.join(dataDir, REVIEW_DIR);
    fs.mkdirSync(dir, { recursive: true });

    // Final evidence report (JSON)
    fs.writeFileSync(path.join(dir, 'final-evidence-report.json'), JSON.stringify({
      reviewId: reviewResult.reviewId, phase: 15,
      evidenceClassification: reviewResult.evidenceClassification,
      sampleCount: reviewResult.sampleCount,
      datasetHash: reviewResult.datasetHash,
      evidenceMatrix: reviewResult.evidence ? reviewResult.evidence.evidenceMatrix : null,
      primary: reviewResult.evidence ? reviewResult.evidence.primary : null,
      bootstrap: reviewResult.evidence ? reviewResult.evidence.bootstrap : null,
      effectSize: reviewResult.evidence ? reviewResult.evidence.effectSize : null,
      statisticalTest: reviewResult.evidence ? reviewResult.evidence.statisticalTest : null,
      economic: reviewResult.evidence ? reviewResult.evidence.economic : null,
      timestamp: Date.now()
    }, null, 2) + '\n');

    // Final evidence report (Markdown)
    fs.writeFileSync(path.join(dir, 'final-evidence-report.md'), generateMarkdown(reviewResult));

    // Production readiness
    fs.writeFileSync(path.join(dir, 'final-production-readiness.json'), JSON.stringify(reviewResult.readiness, null, 2) + '\n');

    // Human decision template
    fs.writeFileSync(path.join(dir, 'final-human-decision-template.md'), generateHumanTemplate(reviewResult));

    // Final manifest
    fs.writeFileSync(path.join(dir, 'final-evidence-manifest.json'), JSON.stringify({
      phase: 15, analysisVersion: '1.0.0', codeVersion: 'ATLAS-0.2.0',
      datasetHash: reviewResult.datasetHash, sampleCount: reviewResult.sampleCount,
      evidenceClassification: reviewResult.evidenceClassification,
      generatedAt: Date.now()
    }, null, 2) + '\n');

    return true;
  } catch (_) { return false; }
}

function generateMarkdown(r) {
  let md = `# FINAL EVIDENCE REPORT — PHASE 15\n\n`;
  md += `**Review ID:** ${r.reviewId}\n**Phase:** 15\n**Sample Count:** ${r.sampleCount}\n**Classification:** ${r.evidenceClassification}\n**Dataset Hash:** ${r.datasetHash}\n\n`;
  md += `## EXECUTIVE SUMMARY\n\n${r.humanReview ? r.humanReview.whatWeKnow : 'No data available.'}\n\n`;
  if (r.evidence && r.evidence.primary && r.evidence.primary.n > 0) {
    md += `## PRIMARY METRIC\n- Mean delta30: ${r.evidence.primary.mean}\n- 95% CI: [${r.evidence.bootstrap.ciLower}, ${r.evidence.bootstrap.ciUpper}]\n- Cohen's d: ${r.evidence.effectSize.d} (${r.evidence.effectSize.interpretation})\n- Statistical test: ${r.evidence.statisticalTest.testName} (p=${r.evidence.statisticalTest.pValue})\n- Economic significance: ${r.evidence.economic.exceedsThreshold ? 'EXCEEDS' : 'BELOW'} 0.5% threshold\n\n`;
  }
  if (r.evidence && r.evidence.evidenceMatrix) {
    md += `## EVIDENCE MATRIX\n\n| Item | Status |\n|------|--------|\n`;
    for (const [k, v] of Object.entries(r.evidence.evidenceMatrix)) { md += `| ${k} | ${v} |\n`; }
    md += '\n';
  }
  if (r.humanReview) {
    md += `## LIMITATIONS\n\n${r.humanReview.limitations}\n\n`;
    md += `## RECOMMENDATION\n\n${r.humanReview.recommendation}\n\n`;
  }
  md += `---\n*ATLAS remains SHADOW. Human review required. No automatic promotion.*\n`;
  return md;
}

function generateHumanTemplate(r) {
  return `# HUMAN DECISION TEMPLATE — PHASE 15

**Review ID:** ${r.reviewId}
**Evidence Classification:** ${r.evidenceClassification}
**Sample Count:** ${r.sampleCount}
**Recommendation:** ${r.humanReview ? r.humanReview.recommendation : 'N/A'}

## POSSIBLE DECISIONS

1. **CONTINUE_SHADOW** — Continue real shadow collection
2. **ACCEPT_ATLAS_FOR_FURTHER_REVIEW** — Evidence supports further review
3. **REJECT_ATLAS** — Evidence does not support ATLAS
4. **REQUEST_MORE_DATA** — Need more observations
5. **APPROVE_PRODUCTION_READINESS_REVIEW** — Approve production readiness assessment

## DECISION RECORD

- **decision:** [SELECT ONE ABOVE]
- **reviewer:** [YOUR NAME]
- **reviewTimestamp:** [DATE/TIME]
- **reason:** [YOUR REASONING]
- **notes:** [ADDITIONAL NOTES]

## IMPORTANT

- This decision is advisory only
- Even approval does NOT automatically enable trading
- Production readiness requires separate operational verification
- ATLAS remains SHADOW until explicit human action changes it
`;
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = review(dataDir);
  console.log('FINAL REVIEW');
  console.log('Review ID:', result.reviewId);
  console.log('Classification:', result.evidenceClassification);
  console.log('Recommendation:', result.humanReview.recommendation);
  console.log('Human Required:', result.humanDecisionRequired);
  console.log('Auto Promoted:', result.automaticPromotion);
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
  persistArtifacts(dataDir, result);
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { review, persistArtifacts, generateMarkdown, generateHumanTemplate };
