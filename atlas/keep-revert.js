#!/usr/bin/env node
/**
 * atlas/keep-revert.js — keep/revert decision after shadow out-of-sample validation.
 *
 * After an experiment's shadow test completes at least the minimum sample, compare
 * baseline vs candidate on multiple metrics (not just win rate). Keep only if the
 * candidate improves enough metrics with sufficient sample; otherwise revert.
 *
 * Minimum sample protection: never promote after only 5/10/20 trades unless marked
 * EARLY_SIGNAL. Normal promotion requires 100+ paper outcomes; prefer 200+.
 */

'use strict';

const { createExperiments, MIN_SAMPLE_NORMAL, MIN_SAMPLE_PREFERRED, clamp } = require('./experiments.js');

function makeKeepRevert(experimentDb) {
  const experiments = createExperiments(experimentDb);

  /**
   * Decide keep/revert on an experiment that has completed a shadow test.
   */
  function evaluate(id, opts) {
    opts = opts || {};
    const minSample = opts.minSample || MIN_SAMPLE_NORMAL;
    const exp = experiments.evaluateShadow(id, minSample);
    if (!exp || exp.state !== 'PENDING_APPROVAL') return { decision: 'PENDING', reason: 'insufficient shadow sample (' + (exp ? exp.sampleSize : 0) + '/' + minSample + ')', exp };

    const comparison = experiments.compare(exp.baselineMetrics || emptyBaselineMetrics(), exp.candidateMetrics || emptyMetrics());
    const candidateMet = pos(opts.candidateMet) != null ? (opts.candidateMet >= 0 ? true : false) : true;

    if (comparison.improved && comparison.metrics.sampleSize.candidate >= (opts.minSamplePreferred || MIN_SAMPLE_PREFERRED)) {
      const promoted = experiments.approve(id, { reason: 'candidate improved expectancy, profit factor, and did not increase max drawdown; calibration not worse; sample sufficient' });
      return { decision: 'KEEP', reason: 'keep — candidate beat baseline on required metrics with sufficient sample', exp: promoted };
    } else {
      const reverted = experiments.reject(id, { reason: 'candidate did not beat baseline on required metrics or sample insufficient' });
      return { decision: 'REVERT', reason: 'revert — candidate did not improve enough metrics', exp: reverted };
    }
  }

  function emptyBaselineMetrics() {
    return {
      expect: 0,
      profitFactor: 0,
      winRate: 0,
      maxDrawdown: 0,
      sharpe: 0,
      calibrationScore: 50,
      n: 0
    };
  }

  function pos(v) { return Number.isFinite(v) ? v : undefined; }

  return { evaluate, experiments };
}

module.exports = { makeKeepRevert, MIN_SAMPLE_NORMAL, MIN_SAMPLE_PREFERRED };
