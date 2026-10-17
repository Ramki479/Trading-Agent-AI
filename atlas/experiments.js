#!/usr/bin/env node
/**
 * atlas/experiments.js — ATLAS autoresearch.
 *
 * Conservative autoresearch:
 *   - identifies worst-performing agent OR least useful prompt (one variable only)
 *   - proposes ONE modification
 *   - runs SHADOW test
 *   - compares baseline vs candidate on multiple metrics (not just win rate)
 *   - keep/revert after minimum sample protection (default 100+ paper outcomes; prefer 200+)
 *
 * Every experiment has: experimentId, parentVersion, change, hypothesis, startTime,
 * endTime, sampleSize, baselineMetrics, candidateMetrics, decision, reason.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
const MIN_SAMPLE_NORMAL = 100;
const MIN_SAMPLE_EARLY = 20; // only for explicitly marked EARLY_SIGNAL
const MIN_SAMPLE_PREFERRED = 200;

const EXPERIMENT_STATES = ['PROPOSED', 'SHADOW', 'PENDING_APPROVAL', 'APPROVED', 'PROMOTED', 'REJECTED', 'REVERTED'];

function createExperiments(experimentDb) {
  const raw = experimentDb.experiments() || {};
  let state = Array.isArray(raw.experiments) ? raw.experiments : (Array.isArray(raw) ? raw : []);
  let updatedAt = raw.updatedAt || null;

  function save() {
    const snapshot = { version: 1, experiments: state, updatedAt: Date.now() };
    experimentDb.writeExperiments(snapshot);
    updatedAt = Date.now();
  }

  return {
    list() { return state; },
    get(id) { return state.find(e => e.id === id); },

    /**
     * Propose one experiment.
     */
    propose(opts) {
      const id = opts.id || ('EXP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase());
      const exp = {
        id,
        parentVersion: opts.parentVersion || 'ATLAS-0.1.0',
        type: opts.type || 'prompt',
        parameter: opts.parameter || null,
        change: opts.change || '',
        hypothesis: opts.hypothesis || '',
        startTime: Date.now(),
        sampleSize: 0,
        baselineMetrics: opts.baselineMetrics || null,
        candidateMetrics: opts.candidateMetrics || null,
        state: 'PROPOSED',
        reason: opts.reason || '',
        version: 'ATLAS-0.1.0'
      };
      state = state.concat([exp]);
      save();
      return exp;
    },

    /**
     * Start shadow test for an experiment.
     */
    startShadow(id, opts) {
      const exp = this.get(id);
      if (!exp) return null;
      if (exp.state !== 'PROPOSED') return exp;
      exp.state = 'SHADOW';
      exp.shadowStartTime = Date.now();
      exp.shadowCandidateVersion = opts.candidateVersion || 'ATLAS-0.1.0-SHADOW';
      save();
      return exp;
    },

    /**
     * Record one outcome while in shadow.
     */
    recordShadowOutcome(id, outcome) {
      const exp = this.get(id);
      if (!exp || exp.state !== 'SHADOW') return exp;
      if (!exp.shadowMetrics) exp.shadowMetrics = emptyMetrics();
      const m = exp.shadowMetrics;
      m.n = m.n + 1;
      if (outcome.won) m.wins = m.wins + 1; else m.losses = m.losses + 1;
      m.sumPnl = (m.sumPnl || 0) + (Number.isFinite(outcome.pnlPct) ? outcome.pnlPct : 0);
      m.maxDrawdown = Math.max(m.maxDrawdown || 0, (Number.isFinite(outcome.drawdownPct) ? outcome.drawdownPct : 0));
      m.calibrationErrors = (m.calibrationErrors || 0) + (Number.isFinite(outcome.calibrationError) ? outcome.calibrationError : 0);
      m.calibrationCount = (m.calibrationCount || 0) + (Number.isFinite(outcome.calibrationError) ? 1 : 0);
      m.predictions = (m.predictions || 0) + (Number.isFinite(outcome.predictions) ? outcome.predictions : 1);
      m.correctPredictions = (m.correctPredictions || 0) + (Number.isFinite(outcome.correctPredictions) ? outcome.correctPredictions : (outcome.won ? 1 : 0));
      exp.sampleSize = m.n;
      save();
      return exp;
    },

    /**
     * Evaluate shadow test → PENDING_APPROVAL if enough samples.
     */
    evaluateShadow(id, minSample) {
      const exp = this.get(id);
      if (!exp || exp.state !== 'SHADOW') return exp;
      minSample = minSample || MIN_SAMPLE_EARLY;
      const m = exp.shadowMetrics;
      if (!m || m.n < minSample) return exp;
      exp.state = 'PENDING_APPROVAL';
      exp.candidateMetrics = m;
      save();
      return exp;
    },

    /**
     * Approve → PROMOTED (candidate becomes the new baseline).
     */
    approve(id, opts) {
      const exp = this.get(id);
      if (!exp) return null;
      if (exp.state !== 'PENDING_APPROVAL' && exp.state !== 'SHADOW') return exp;
      exp.state = 'PROMOTED';
      exp.endTime = Date.now();
      exp.decision = 'KEEP';
      exp.reason = opts.reason || 'shadow passed metrics';
      exp.promotedVersion = opts.promotedVersion || exp.shadowCandidateVersion || 'ATLAS-0.1.0-PROMOTED';
      state = state.map(e => e.id === id ? exp : e);
      save();
      return exp;
    },

    /**
     * Reject → REVERTED.
     */
    reject(id, opts) {
      const exp = this.get(id);
      if (!exp) return null;
      exp.state = 'REVERTED';
      exp.endTime = Date.now();
      exp.decision = 'REVERT';
      exp.reason = opts.reason || 'shadow did not improve metrics';
      save();
      return exp;
    },

    /**
     * Compare baseline vs candidate metrics.
     */
    compare(baseline, candidate) {
      if (!baseline || !candidate) return { improved: false, metrics: {} };
      const b = baseline, c = candidate;
      const metrics = {
        expectancy: { baseline: b.expectancyPct, candidate: c.expectancyPct },
        profitFactor: { baseline: b.profitFactor, candidate: c.profitFactor },
        winRate: { baseline: b.winRate, candidate: c.winRate },
        maxDrawdown: { baseline: b.maxDrawdown, candidate: c.maxDrawdown },
        sharpe: { baseline: b.sharpe, candidate: c.sharpe },
        calibration: { baseline: b.calibrationScore || (b.calibrationErrors ? 100 - (b.calibrationErrors / Math.max(1, b.calibrationCount) * 100) : 50), candidate: c.calibrationScore || (c.calibrationErrors ? 100 - (c.calibrationErrors / Math.max(1, c.calibrationCount) * 100) : 50) },
        falsePositiveRate: { baseline: b.falsePositiveRate || 0, candidate: c.falsePositiveRate || 0 },
        sampleSize: { baseline: b.n, candidate: c.n }
      };
      // Candidate must improve expectancy AND profit factor AND not increase max drawdown
      const improved = c.expectancyPct > b.expectancyPct
        && c.profitFactor >= b.profitFactor
        && c.maxDrawdown <= b.maxDrawdown
        && (c.calibrationScore || 0) >= (b.calibrationScore || 0)
        && c.n >= Math.min(b.n, MIN_SAMPLE_PREFERRED || 100);
      return { improved, metrics };
    }
  };
}

function emptyMetrics() {
  return {
    n: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    expectancyPct: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    maxDrawdown: 0,
    sharpe: 0,
    calibrationScore: 0,
    calibrationErrors: 0,
    calibrationCount: 0,
    falsePositiveRate: 0,
    predictions: 0,
    correctPredictions: 0,
    sumPnl: 0,
    sampleSize: 0
  };
}

module.exports = { createExperiments, EXPERIMENT_STATES, MIN_SAMPLE_NORMAL, MIN_SAMPLE_EARLY, MIN_SAMPLE_PREFERRED, emptyMetrics, clamp };
