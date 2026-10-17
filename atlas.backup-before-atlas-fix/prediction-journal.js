#!/usr/bin/env node
/**
 * atlas/prediction-journal.js — append-only prediction journal.
 *
 * Every ATLAS directional/probability prediction is recorded with:
 *   predictionId, ts, mint, pairAddress, dex, agent, direction, confidence,
 *   expectedMovePct, probabilityUp, probabilityDown, timeHorizon, thesis,
 *   evidence, dataQuality, marketRegime, atlasVersion, promptVersion
 *
 * Look-ahead-free: predictions are immutable once written. Outcome evaluation
 * uses only data available after the prediction timestamp.
 */

'use strict';

const { AtlasDb } = require('./db.js');
const { clamp } = require('./schemas.js');

const VERSION = 'ATLAS-0.1.0';
const PROMPT_VERSION = 'prompt-2026-09-05';

function createPredictionJournl(db) {
  return {
    record(agent, prediction, opts = {}) {
      const cand = opts.candidate || {};
      const mint = cand.mint || opts.mint || '';
      const pairAddress = cand.pairAddress || opts.pairAddress || null;
      const dex = cand.dex || opts.dex || null;
      const ts = Number.isFinite(opts.ts) ? opts.ts : Date.now();
      const direction = opts.direction || (prediction.direction || 'unknown');
      const confidence = Number.isFinite(prediction.confidence) ? clamp(prediction.confidence) : (Number.isFinite(prediction.score) ? clamp(prediction.score) : 0);
      const expectedMovePct = Number.isFinite(prediction.expectedMovePct) ? clamp(prediction.expectedMovePct) : 0;
      const probUp = Number.isFinite(prediction.probabilityUp) ? clamp(prediction.probabilityUp) : 0;
      const probDown = Number.isFinite(prediction.probabilityDown) ? clamp(prediction.probabilityDown) : 0;

      const record = {
        predictionId: 'P' + ts + '-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        ts,
        iso: new Date(ts).toISOString(),
        mint,
        pairAddress,
        dex,
        agent: agent || prediction.agent || 'unknown',
        direction,
        confidence,
        expectedMovePct,
        probabilityUp: probUp,
        probabilityDown: probDown,
        timeHorizon: opts.timeHorizon || (prediction.timeHorizon || '15m'),
        thesis: opts.thesis || (prediction.thesis || ''),
        evidence: opts.evidence || (prediction.evidence || []),
        dataQuality: opts.dataQuality || (prediction.dataQuality || 'ok'),
        marketRegime: opts.marketRegime || (opts.market && opts.market.regime) || null,
        atlasVersion: opts.atlasVersion || VERSION,
        promptVersion: opts.promptVersion || PROMPT_VERSION,
        source: opts.source || 'atlas',
        _candSymbol: cand.symbol || opts.symbol || null
      };
      db.appendPrediction(record);
      return record;
    },

    /**
     * Look-ahead-free: returns predictions for a mint whose timestamp <= `until`
     * and (optionally) pairAddress/dex match.
     */
    forMint(mint, since, until, pairAddress, dex) {
      return db.predictionsFor(mint, since, until, {
        pairAddress: pairAddress || null,
        dex: dex || null,
        mintFilter: true
      }).filter(p => p.mint === mint && (!pairAddress || p.pairAddress === pairAddress) && (!dex || p.dex === dex));
    },

    /** All predictions, deduped by predictionId. */
    all() {
      return db.dedupPredictionId();
    }
  };
}

module.exports = { createPredictionJournl, VERSION, PROMPT_VERSION };
