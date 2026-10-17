#!/usr/bin/env node
/**
 * atlas/collection-monitor.js — Long-run shadow collection health monitoring.
 *
 * Tracks prediction rate, matched-outcome rate, unresolved count, resolution
 * latency, excluded observations, data-quality rate, look-ahead violations,
 * and detects collection problems.
 *
 * All alerts are advisory only. No automatic actions.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * Collection health metrics.
 * ------------------------------------------------------------------ */

function computeHealth(db, opts = {}) {
  const now = Date.now();
  const windowMs = opts.windowMs || 24 * 60 * 60 * 1000; // 24h default
  const windowStart = now - windowMs;

  const predictions = db.predictions ? db.predictions() : [];
  const outcomes = db.outcomes ? db.outcomes() : [];

  // Time-windowed predictions
  const recentPreds = predictions.filter(p => Number.isFinite(p.ts) && p.ts >= windowStart);
  const totalPreds = predictions.length;

  // Outcome resolution
  const resolved = outcomes.length;
  const unresolved = Math.max(0, totalPreds - resolved);

  // Data quality
  const validPreds = predictions.filter(p => p.dataQuality === 'ok');
  const suspiciousPreds = predictions.filter(p => p.dataQuality === 'suspicious' || p.dataQuality === 'fail');
  const validRate = totalPreds > 0 ? (validPreds.length / totalPreds * 100) : null;

  // Resolution rate
  const resolutionRate = totalPreds > 0 ? (resolved / totalPreds * 100) : null;

  // Prediction rate
  const hours = windowMs / (60 * 60 * 1000);
  const predsPerHour = hours > 0 ? (recentPreds.length / hours) : null;
  const predsPerDay = predsPerHour ? predsPerHour * 24 : null;

  // Resolution latency (time between prediction and outcome)
  const latencies = [];
  for (const o of outcomes) {
    const pred = predictions.find(p => p.predictionId === o.predictionId);
    if (pred && Number.isFinite(pred.ts) && Number.isFinite(o.realizedAt)) {
      latencies.push(o.realizedAt - pred.ts);
    }
  }
  const avgLatencyMs = latencies.length > 0
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : null;

  // Agent availability
  const agentSet = new Set();
  const unavailableAgents = new Set();
  for (const p of predictions) {
    if (p.agent) agentSet.add(p.agent);
    if (p.dataQuality === 'unknown' || p.direction === 'unknown') {
      unavailableAgents.add(p.agent);
    }
  }

  // Duplicate detection
  const predIds = predictions.map(p => p.predictionId).filter(Boolean);
  const uniqueIds = new Set(predIds);
  const duplicateRate = predIds.length > 0
    ? ((predIds.length - uniqueIds.size) / predIds.length * 100)
    : 0;

  return {
    timestamp: now,
    iso: new Date(now).toISOString(),
    windowMs,
    predictions: {
      total: totalPreds,
      recent: recentPreds.length,
      rate: { perHour: round(predsPerHour, 2), perDay: round(predsPerDay, 2) }
    },
    outcomes: {
      resolved,
      unresolved,
      resolutionRate: round(resolutionRate, 2)
    },
    dataQuality: {
      valid: validPreds.length,
      suspicious: suspiciousPreds.length,
      validRate: round(validRate, 2)
    },
    latency: {
      avgMs: avgLatencyMs != null ? Math.round(avgLatencyMs) : null,
      samples: latencies.length
    },
    agents: {
      total: agentSet.size,
      unavailable: unavailableAgents.size,
      names: [...agentSet]
    },
    duplicates: {
      total: predIds.length - uniqueIds.size,
      rate: round(duplicateRate, 2)
    }
  };
}

/* ------------------------------------------------------------------ *
 * Problem detection.
 * ------------------------------------------------------------------ */

function detectProblems(health) {
  const alerts = [];

  if (health.predictions.total === 0) {
    alerts.push({ level: 'WARNING', code: 'NO_NEW_PREDICTIONS', message: 'No predictions recorded' });
  }

  if (health.outcomes.unresolved > 0 && health.outcomes.resolutionRate < 50) {
    alerts.push({ level: 'INFO', code: 'LOW_MATCH_RATE', message: `Resolution rate ${health.outcomes.resolutionRate}% — many unresolved predictions` });
  }

  if (health.dataQuality.validRate != null && health.dataQuality.validRate < 70) {
    alerts.push({ level: 'WARNING', code: 'HIGH_EXCLUSION_RATE', message: `Valid rate ${health.dataQuality.validRate}% — high exclusion rate` });
  }

  if (health.duplicates.rate > 5) {
    alerts.push({ level: 'WARNING', code: 'HIGH_DUPLICATE_RATE', message: `Duplicate rate ${health.duplicates.rate}%` });
  }

  if (health.agents.unavailable > 0) {
    alerts.push({ level: 'INFO', code: 'AGENT_FAILURE', message: `${health.agents.unavailable} agent(s) unavailable` });
  }

  if (health.latency.avgMs != null && health.latency.avgMs > 4 * 60 * 60 * 1000) {
    alerts.push({ level: 'INFO', code: 'STALE_DATA', message: `Average resolution latency ${(health.latency.avgMs / 3600000).toFixed(1)}h` });
  }

  return { alerts, hasProblems: alerts.length > 0, warningCount: alerts.filter(a => a.level === 'WARNING').length };
}

/* ------------------------------------------------------------------ *
 * Persistence.
 * ------------------------------------------------------------------ */

function persistMonitor(db, health, problems) {
  const record = {
    timestamp: health.timestamp,
    iso: health.iso,
    health,
    problems
  };
  try {
    const existing = db.readJson ? db.readJson('atlas-monitor.json') : null;
    const history = (existing && existing.history) ? existing.history : [];
    history.push(record);
    // Keep last 30 days of hourly snapshots (720 max)
    if (history.length > 720) history.splice(0, history.length - 720);
    if (db.writeJson) db.writeJson('atlas-monitor.json', { history, updatedAt: Date.now() });
  } catch (_) { /* best effort */ }
}

function round(n, d) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, d || 0);
  return Math.round(n * f) / f;
}

module.exports = { computeHealth, detectProblems, persistMonitor };
