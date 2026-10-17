#!/usr/bin/env node
/**
 * atlas/reputation.js — agent reputation: global + regime-specific + calibration + Darwinian bounded weights.
 *
 * Each agent gets:
 *   - global performance (predictions, correct, incorrect, accuracy, calibration, Brier if probability predictions exist)
 *   - regime-specific performance (TREND_UP, TREND_DOWN, CONSOLIDATION, RECOVERY, DUMP, HIGH_VOLATILITY, LOW_LIQUIDITY, UNKNOWN)
 *   - confidence calibration (is 80% confidence actually ~80% correct?)
 *   - Darwinian bounded weights (0.3-2.5, symmetric slow updates, minimum samples)
 *
 * No reputation adjustment until N >= 30 predictions; prefer N >= 50 for meaningful updates.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
const MIN_SAMPLES_GLOBAL = 30;
const MIN_SAMPLES_REPUTATION = 50;
const DARWIN_MIN = 0.3;
const DARWIN_MAX = 2.5;
const DARWIN_STEP = 0.05;

function emptyAgentReputation() {
  return {
    agent: null,
    totalPredictions: 0,
    directionalPredictions: 0,
    correct: 0,
    incorrect: 0,
    accuracy: 0,
    winRate: 0,
    avgConfidence: 0,
    confidenceWhenCorrect: 0,
    confidenceWhenWrong: 0,
    calibrationScore: 0, // 100 = perfect, lower = over/underconfident
    brierScore: null,
    sumBrier: 0,
    brierCount: 0,
    avgExpectedReturn: 0,
    avgRealizedReturn: 0,
    medianReturn: 0,
    mfe: 0,  // maximum favorable excursion
    mae: 0,  // maximum adverse excursion
    sumMFE: 0,
    sumMAE: 0,
    profitContribution: 0,
    returns: [], // track returns for median/MFE/MAE
    weights: { global: 1.0 },
    regimes: {},
    updatedAt: null
  };
}

function emptyRegimeReputation() {
  return {
    regime: null,
    predictions: 0,
    correct: 0,
    incorrect: 0,
    accuracy: 0,
    winRate: 0,
    avgConfidence: 0,
    avgRealizedReturn: 0,
    medianReturn: 0,
    mfe: 0,
    mae: 0,
    expectancy: 0,
    returns: [],
    updatedAt: null
  };
}

function createReputationStore() {
  const agents = {}; // agentName -> reputation
  const regimes = {}; // agentName|regime -> regime reputation
  let updatedAt = null;

  return {
    getAgent(name) {
      if (!agents[name]) agents[name] = emptyAgentReputation();
      agents[name].agent = name;
      return agents[name];
    },

    getRegime(name, regime) {
      if (!regime) return null;
      const key = name + '|' + regime;
      if (!regimes[key]) regimes[key] = emptyRegimeReputation();
      regimes[key].agent = name;
      regimes[key].regime = regime;
      return regimes[key];
    },

    allAgents() {
      return agents;
    },

    allRegimes() {
      return regimes;
    },

    /**
     * Record one prediction outcome for an agent.
     * @param name agent name
     * @param regime market regime at prediction time (optional)
     * @param outcome { correct, confidence, expectedMovePct?, realizedPnlPct?, brier? }
     */
    record(name, regime, outcome) {
      if (!name || !outcome) return;
      const a = this.getAgent(name);
      a.totalPredictions = a.totalPredictions + 1;
      a.correct = a.correct + (outcome.correct ? 1 : 0);
      a.incorrect = a.incorrect + (outcome.correct ? 0 : 1);
      a.avgConfidence = (a.avgConfidence * (a.totalPredictions - 1) + (Number.isFinite(outcome.confidence) ? outcome.confidence : 50)) / a.totalPredictions;
      if (outcome.confidence != null) {
        if (outcome.correct) {
          a.confidenceWhenCorrect = (a.confidenceWhenCorrect * (a.correct - 1) + outcome.confidence) / Math.max(1, a.correct);
        } else {
          a.confidenceWhenWrong = (a.confidenceWhenWrong * (a.incorrect - 1) + outcome.confidence) / Math.max(1, a.incorrect);
        }
      }
      if (Number.isFinite(outcome.brier) && outcome.brier >= 0) {
        a.sumBrier = a.sumBrier + outcome.brier;
        a.brierCount = a.brierCount + 1;
        a.brierScore = a.sumBrier / a.brierCount;
      }
      if (Number.isFinite(outcome.expectedMovePct)) {
        a.avgExpectedReturn = (a.avgExpectedReturn * (a.totalPredictions - 1) + outcome.expectedMovePct) / a.totalPredictions;
      }
      if (Number.isFinite(outcome.realizedPnlPct)) {
        a.avgRealizedReturn = (a.avgRealizedReturn * (a.totalPredictions - 1) + outcome.realizedPnlPct) / a.totalPredictions;
        a.profitContribution = a.profitContribution + outcome.realizedPnlPct;
      }
      if (outcome.confidence != null) {
        a.directionalPredictions = (a.directionalPredictions || 0) + 1;
      }
      a.winRate = a.totalPredictions > 0 ? Math.round((a.correct / a.totalPredictions) * 10000) / 100 : 0;
      a.accuracy = a.totalPredictions > 0 ? a.correct / a.totalPredictions : 0;
      // Track returns for median/MFE/MAE
      if (Number.isFinite(outcome.realizedPnlPct)) {
        a.returns = a.returns || [];
        a.returns.push(outcome.realizedPnlPct);
        if (a.returns.length > 500) a.returns = a.returns.slice(-500);
        a.medianReturn = computeMedian(a.returns);
        // MFE = max favorable (positive) excursion; MAE = max adverse (negative)
        if (outcome.realizedPnlPct > 0) {
          a.sumMFE = (a.sumMFE || 0) + outcome.realizedPnlPct;
        }
        if (outcome.realizedPnlPct < 0) {
          a.sumMAE = (a.sumMAE || 0) + Math.abs(outcome.realizedPnlPct);
        }
        const wins = a.returns.filter(r => r > 0);
        const losses = a.returns.filter(r => r < 0);
        a.mfe = wins.length > 0 ? Math.round((wins.reduce((a2, b) => Math.max(a2, b), wins[0])) * 100) / 100 : 0;
        a.mae = losses.length > 0 ? Math.round((losses.reduce((a2, b) => Math.max(a2, Math.abs(b)), 0)) * 100) / 100 : 0;
      }
      a.calibrationScore = computeCalibration(a);
      a.updatedAt = Date.now();

      if (regime) {
        const r = this.getRegime(name, regime);
        r.predictions = r.predictions + 1;
        r.correct = r.correct + (outcome.correct ? 1 : 0);
        r.incorrect = r.incorrect + (outcome.correct ? 0 : 1);
        r.avgConfidence = (r.avgConfidence * (r.predictions - 1) + (Number.isFinite(outcome.confidence) ? outcome.confidence : 50)) / Math.max(1, r.predictions);
        r.accuracy = r.predictions > 0 ? r.correct / r.predictions : 0;
        r.winRate = r.predictions > 0 ? Math.round((r.correct / r.predictions) * 10000) / 100 : 0;
        if (Number.isFinite(outcome.realizedPnlPct)) {
          r.returns = r.returns || [];
          r.returns.push(outcome.realizedPnlPct);
          if (r.returns.length > 500) r.returns = r.returns.slice(-500);
          r.avgRealizedReturn = Math.round((r.returns.reduce((a2, b) => a2 + b, 0) / r.returns.length) * 10000) / 10000;
          r.medianReturn = computeMedian(r.returns);
          r.expectancy = Math.round((r.returns.reduce((a2, b) => a2 + b, 0) / r.returns.length) * 100) / 100;
          const rWins = r.returns.filter(ret => ret > 0);
          const rLosses = r.returns.filter(ret => ret < 0);
          r.mfe = rWins.length > 0 ? Math.round(rWins.reduce((a2, b) => Math.max(a2, b), rWins[0]) * 100) / 100 : 0;
          r.mae = rLosses.length > 0 ? Math.round(rLosses.reduce((a2, b) => Math.max(a2, Math.abs(b)), 0) * 100) / 100 : 0;
        }
        r.updatedAt = Date.now();
      }
      updatedAt = Date.now();
    },

    /**
     * Darwinian weight update for one agent after a batch of outcomes.
     * Called after enough outcomes to matter.
     */
    darwinUpdate(name, correct, total, regimesOutcomes) {
      const a = this.getAgent(name);
      if (total < MIN_SAMPLES_REPUTATION) return a.weights.global;
      const recentAcc = total > 0 ? correct / total : 0;
      const globalAcc = a.totalPredictions > 0 ? a.correct / a.totalPredictions : 0;
      const regimeAcc = regimesOutcomes ? regimesOutcomes.reduce((s, r) => s + (r && r.predictions > 0 ? r.correct / r.predictions : 0), 0) / Math.max(1, regimesOutcomes.filter(r => r && r.predictions > 0).length) : globalAcc;
      const blended = (recentAcc + globalAcc + regimeAcc) / 3;
      const current = a.weights.global;
      let next = current;
      if (blended > 0.55) next = current + DARWIN_STEP;
      else if (blended < 0.45) next = current - DARWIN_STEP;
      next = clamp(next, DARWIN_MIN, DARWIN_MAX);
      a.weights.global = next;
      a.updatedAt = Date.now();
      return next;
    },

    snapshot() {
      return {
        version: 1,
        updatedAt,
        agents: agents,
        regimes: regimes,
        darwinWeights: Object.fromEntries(Object.entries(agents).map(([k, v]) => [k, v.weights.global]))
      };
    }
  };
}

function computeMedian(arr) {
  if (!arr || !arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function computeCalibration(a) {
  if (a.totalPredictions < 10) return 50;
  const ratio = a.totalPredictions > 0 ? a.correct / a.totalPredictions : 0;
  const confidence = a.avgConfidence > 0 ? a.avgConfidence / 100 : 0.5;
  const diff = Math.abs(ratio - confidence);
  // 100 = perfect, penalize linearly
  return clamp(100 - diff * 200);
}

module.exports = {
  createReputationStore,
  emptyAgentReputation,
  emptyRegimeReputation,
  MIN_SAMPLES_GLOBAL,
  MIN_SAMPLES_REPUTATION,
  DARWIN_MIN,
  DARWIN_MAX,
  DARWIN_STEP,
  clamp
};
