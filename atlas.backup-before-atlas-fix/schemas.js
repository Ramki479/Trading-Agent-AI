#!/usr/bin/env node
/**
 * atlas/schemas.js — ATLAS output contracts, validation, and numeric clamping.
 *
 * Every ATLAS agent must return a typed JSON object. This module:
 *   1. validates structure and required fields
 *   2. clamps numeric confidence/score values into [0, 100]
 *   3. rejects forbidden/execution fields (never trust arbitrary LLM text as logic)
 *   4. normalizes direction enums
 *
 * Shared contract is intentionally lightweight — modular agents can extend it
 * with their own optional fields, but nothing unwrapable or executable leaks in.
 */

'use strict';

/** Clamp a number into [lo, hi]; non-finite -> 0. */
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/** Canonical direction. */
const DIRECTIONS = new Set(['bullish', 'bearish', 'neutral', 'unknown']);
const normalizeDirection = (d) => DIRECTIONS.has(String(d)) ? String(d) : 'unknown';

/** Required agent output envelope. */
const ENVELOPE = ['agent', 'candidate', 'timestamp', 'direction', 'confidence', 'score'];

const FORBIDDEN = new Set([
  'execute', 'executeTrade', 'placeOrder', 'sendTransaction', 'signTransaction',
  'signRawTransaction', 'broadcast', 'sendRawTransaction', 'privateKey', 'secretKey',
  'seedPhrase', 'mnemonic', 'wallet', 'keypair', 'fromSecretKey', 'commit', 'balance',
  'modifyBalance', 'modifyPosition', 'modifyLedger', 'modifyTrade', 'modifyPortfolio',
  'override', 'authorize', 'trade', 'buy', 'sell', 'amountToBuy', 'amountToSell'
]);

/**
 * Validate an agent result. Returns { ok, value, errors }.
 * Numeric confidence/score/prediction fields are clamped into [0, 100].
 */
function validate(result, opts = {}) {
  const errors = [];
  if (!result || typeof result !== 'object') return { ok: false, value: null, errors: ['not an object'] };
  const raw = Object.assign({}, result);
  if (!raw.agent || typeof raw.agent !== 'string') errors.push('missing or invalid agent');
  if (!raw.candidate || typeof raw.candidate !== 'string') errors.push('missing or invalid candidate');
  if (!Number.isFinite(raw.timestamp)) errors.push('missing or invalid timestamp');

  // direction
  if (raw.direction != null) raw.direction = normalizeDirection(raw.direction);
  else errors.push('missing direction');

  // clamp numeric fields
  const numFields = opts.numFields || ['confidence', 'score'];
  for (const f of numFields) {
    if (Number.isFinite(raw[f])) raw[f] = clamp(raw[f]);
  }

  // optional prediction object
  if (raw.prediction && typeof raw.prediction === 'object') {
    const p = Object.assign({}, raw.prediction);
    if (Number.isFinite(p.expectedMovePct)) p.expectedMovePct = clamp(p.expectedMovePct);
    if (Number.isFinite(p.probabilityUp)) p.probabilityUp = clamp(p.probabilityUp);
    if (Number.isFinite(p.probabilityDown)) p.probabilityDown = clamp(p.probabilityDown);
    raw.prediction = p;
  }

  // forbidden fields
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.has(k.toLowerCase())) errors.push('forbidden field: ' + k);
  }

  return {
    ok: errors.length === 0,
    value: errors.length === 0 ? raw : null,
    errors
  };
}

module.exports = { clamp, normalizeDirection, DIRECTIONS, validate, ENVELOPE, FORBIDDEN };
