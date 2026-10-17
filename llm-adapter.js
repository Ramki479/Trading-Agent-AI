#!/usr/bin/env node
/**
 * llm-adapter.js — OPTIONAL async LLM hook for the paper agent's adaptive
 * layer (Stage 16 LLM boundary).
 *
 * The deterministic engine is the default and never requires an LLM. When
 * configured (CIRCUIT_LLM_URL + CIRCUIT_LLM_KEY), the agent-loop MAY ask an
 * OpenAI-compatible chat endpoint to reinterpret the same session-policy
 * brief. All LLM output is:
 *
 *   - schema-validated   (mode / minScore / maxBuys / reason only)
 *   - clamped            (minScore 60..90, maxBuys 0..maxPositions)
 *   - async              (never blocks the scanner — no hot-path LLM)
 *   - advisory           (falls back to the deterministic policy on any
 *                         failure, timeout, or invalid output)
 *
 * The LLM may NOT: edit source, execute JS/shell, install packages, enable
 * wallet/signer/broadcast, or change safety limits. Any output containing
 * such fields is rejected outright (flagged, then the deterministic policy
 * stands).
 */

'use strict';

const MODES = ['active', 'selective', 'watchOnly'];

/** Fields the LLM is allowed to influence. Anything else → flagged + dropped. */
const ALLOWED_FIELDS = new Set(['mode', 'minScore', 'maxBuys', 'reason', 'reasoning', 'sessionGoal']);
const FORBIDDEN_FIELDS = ['wallet', 'signer', 'broadcast', 'execute', 'code', 'script', 'install', 'privateKey', 'seed', 'mint'];

/**
 * Validate + clamp raw LLM output against the session-policy schema.
 * @param {*} raw parsed JSON (object) from the LLM
 * @param {object} cfg { maxPositions }
 * @returns {{ ok, policy|null, errors: string[] }}
 */
function validatePolicyOutput(raw, cfg = {}) {
  const errors = [];
  const maxPositions = cfg.maxPositions || 3;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, policy: null, errors: ['LLM output is not a JSON object'] };
  }

  // 1. Forbidden content — reject the whole output.
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_FIELDS.some((f) => key.toLowerCase().includes(f))) {
      errors.push(`unsafe field "${key}" present — output rejected`);
      return { ok: false, policy: null, errors };
    }
  }

  const policy = {};
  // 2. mode — must be one of the three upstream modes.
  if (raw.mode !== undefined && raw.mode !== null) {
    if (MODES.includes(raw.mode)) policy.mode = raw.mode;
    else errors.push(`invalid mode "${raw.mode}" (must be ${MODES.join('/')}) — keeping deterministic mode`);
  }
  // 3. minScore — numeric, clamped 60..90, integer.
  if (raw.minScore !== undefined && raw.minScore !== null) {
    const v = Number(raw.minScore);
    if (Number.isFinite(v)) {
      policy.minScore = Math.max(60, Math.min(90, Math.round(v)));
      if (policy.minScore !== v) errors.push(`minScore clamped ${v} → ${policy.minScore} (bounds 60..90)`);
    } else {
      errors.push(`invalid minScore "${raw.minScore}" — keeping deterministic minScore`);
    }
  }
  // 4. maxBuys — numeric, clamped 0..maxPositions.
  if (raw.maxBuys !== undefined && raw.maxBuys !== null) {
    const v = Number(raw.maxBuys);
    if (Number.isFinite(v)) {
      policy.maxBuys = Math.max(0, Math.min(maxPositions, Math.round(v)));
      if (policy.maxBuys !== v) errors.push(`maxBuys clamped ${v} → ${policy.maxBuys} (bounds 0..${maxPositions})`);
    } else {
      errors.push(`invalid maxBuys "${raw.maxBuys}" — keeping deterministic maxBuys`);
    }
  }
  // 5. reason — short string only.
  if (raw.reason !== undefined && raw.reason !== null) {
    if (typeof raw.reason === 'string') policy.reason = String(raw.reason).slice(0, 500);
    else if (typeof raw.reasoning === 'string') policy.reason = String(raw.reasoning).slice(0, 500);
    else errors.push('invalid reason — using deterministic reason');
  }

  const hasPolicyField = policy.mode !== undefined || policy.minScore !== undefined || policy.maxBuys !== undefined;
  if (!hasPolicyField) {
    return { ok: false, policy: null, errors: errors.length ? errors : ['no usable policy fields in LLM output'] };
  }
  return { ok: true, policy, errors };
}

/** Strip markdown code fences and extract the first JSON object. */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { return null; }
}

/**
 * Call the LLM (OpenAI-compatible /chat/completions) and return a validated
 * policy override, or null on any failure. Async only — never call from the
 * scanner hot path. `fetchImpl` is injectable for tests.
 */
async function maybeLLMPolicy({ url, key, model, brief, timeoutMs = 30000, fetchImpl } = {}) {
  if (!url) return null;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(String(url).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      signal: ctrl ? ctrl.signal : undefined,
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: 'Bearer ' + key } : {})
      },
      body: JSON.stringify({
        model: model || 'google/gemini-2.5-flash-lite',
        messages: [
          { role: 'system', content: 'You are the strategy brain of a PAPER-ONLY Solana trading agent. Respond with a single JSON object: {"mode": "active"|"selective"|"watchOnly", "minScore": 60-90, "maxBuys": 0-3, "reason": "short text"}. Never include wallet, signer, broadcast, code, or execution fields.' },
          { role: 'user', content: 'Current state:\n' + brief + '\n\nSet the next session policy (JSON only).' }
        ],
        max_tokens: 200,
        temperature: 0.4
      })
    });
    if (!res.ok) return null;
    const body = await res.json();
    const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    const raw = extractJson(text);
    const validated = validatePolicyOutput(raw, {});
    return validated.ok ? { policy: validated.policy, errors: validated.errors } : null;
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Generic validated JSON call to the same OpenAI-compatible endpoint, shared
 * by every optional research/LLM feature (currently TradingAgents). Every
 * result must parse, validate against the caller's schema, reject forbidden
 * fields, time out, and fail safely — see module header.
 *
 * @param {object} opts { url, key, model, system, prompt, timeoutMs, fetchImpl,
 *                        validate }
 *   validate(raw) → { ok, json?, errors? } — caller-defined schema check + clamp.
 * @returns Promise<{ ok:true, json, errors:[] } | { ok:false, errors:string[] }>
 *          — null is returned when the transport itself fails (caller treats it
 *            as "LLM unavailable"; the deterministic engine never depends on it).
 */
async function maybeLLMJson({ url, key, model, system, prompt, timeoutMs = 15000, fetchImpl, validate } = {}) {
  if (!url) return null;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(String(url).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      signal: ctrl ? ctrl.signal : undefined,
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: 'Bearer ' + key } : {})
      },
      body: JSON.stringify({
        model: model || 'google/gemini-2.5-flash-lite',
        messages: [
          { role: 'system', content: system || 'You are a research assistant. Reply with a single JSON object only.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 400,
        temperature: 0.2
      })
    });
    if (!res.ok) return { ok: false, errors: ['LLM HTTP ' + res.status] };
    const body = await res.json();
    const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    const raw = extractJson(text);
    if (raw == null) return { ok: false, errors: ['LLM output is not parseable JSON'] };
    // Forbidden content — reject the whole output before any schema check.
    for (const keyName of Object.keys(raw)) {
      if (FORBIDDEN_FIELDS.some((f) => keyName.toLowerCase().includes(f))) {
        return { ok: false, errors: ['unsafe field "' + keyName + '" present — output rejected'] };
      }
    }
    if (typeof validate === 'function') {
      const v = validate(raw);
      if (v && v.ok) return { ok: true, json: v.json !== undefined ? v.json : raw, errors: v.errors || [] };
      return { ok: false, errors: (v && v.errors) || ['LLM output failed schema validation'] };
    }
    return { ok: true, json: raw, errors: [] };
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return { ok: false, errors: [isAbort ? 'LLM timeout' : 'LLM unavailable: ' + (err && err.message ? err.message : 'error')] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { validatePolicyOutput, extractJson, maybeLLMPolicy, maybeLLMJson, MODES, ALLOWED_FIELDS, FORBIDDEN_FIELDS };