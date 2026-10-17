#!/usr/bin/env node
/**
 * market-data.js — REAL Solana market-data layer for the paper trader.
 *
 * Dependency-free (uses Node's global fetch). 100% read-only: this module only
 * ever fetches public market data; it cannot trade, sign, or broadcast.
 *
 * Sources
 * -------
 *   dex      — DexScreener public API (https://api.dexscreener.com).
 *              This is the DEFAULT real source (no key required).
 *              Discovery feeds: newest token profiles, latest + top boosts.
 *   gt       — GeckoTerminal public API (https://www.geckoterminal.com/dex-api).
 *              DISCOVERY FEED ONLY (trending + new Solana pools). GeckoTerminal
 *              mints are resolved through the DexScreener pair batch endpoint,
 *              so every candidate shares one real price schema — GeckoTerminal
 *              widens the universe, it never becomes a second price provider.
 *   circuit  — optional PRIMARY when CIRCUIT_PRICE_API_URL is set
 *              (expected JSON shape documented below). Falls back to dex.
 *   mock     — TEST-ONLY provider activated by CIRCUIT_MOCK_MARKET_FILE.
 *              It replays a local JSON fixture. Never used in production.
 *
 * Every price carries provenance metadata:
 *   { priceUsd, priceSol, source, timestamp, ageMs }
 *
 * priceSol is ALWAYS derived from the real SOL price
 * (priceUsd / solPriceUsd) — never from an approximation.
 *
 * Safety: no wallet, no keys, no signing, no broadcast. Read-only market data.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TOKENS_PER_REQUEST = 30;   // DexScreener batch limit
const DEFAULT_SOL_PRICE_CACHE_MS = 30000;

/* ------------------------------------------------------------------ *
 * Address validation (Solana base58 mint addresses).
 * ------------------------------------------------------------------ */

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidSolanaAddress(addr) {
  return typeof addr === 'string' && ADDR_RE.test(addr);
}

/* ------------------------------------------------------------------ *
 * HTTP helper with timeout + error classification.
 * ------------------------------------------------------------------ */

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'http' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    throw new Error(isAbort ? `${label}: timeout after ${timeoutMs}ms` : `${label}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} for ${url.slice(0, 120)}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ *
 * Price helpers.
 * ------------------------------------------------------------------ */

function isValidPrice(p) {
  return p && typeof p.priceUsd === 'number' && Number.isFinite(p.priceUsd) && p.priceUsd > 0 &&
    typeof p.priceSol === 'number' && Number.isFinite(p.priceSol) && p.priceSol > 0 &&
    Number.isFinite(p.timestamp);
}

/** Age in ms of a price at the current moment. */
function priceAgeMs(p, now = Date.now()) {
  return Math.max(0, now - p.timestamp);
}

/**
 * Compare two prices (same asset, different providers). Returns
 * { ok, divergencePct } — ok=false when relative divergence is abnormal.
 */
function comparePrices(a, b, maxDivergencePct) {
  if (!isValidPrice(a) || !isValidPrice(b)) return { ok: false, divergencePct: null };
  const hi = Math.max(a.priceUsd, b.priceUsd);
  const lo = Math.min(a.priceUsd, b.priceUsd);
  if (hi <= 0) return { ok: false, divergencePct: null };
  const divergencePct = ((hi - lo) / hi) * 100;
  return { ok: divergencePct <= maxDivergencePct, divergencePct: Math.round(divergencePct * 100) / 100 };
}

/* ------------------------------------------------------------------ *
 * Mock provider (tests only). Activated by CIRCUIT_MOCK_MARKET_FILE.
 *
 * Fixture shape:
  *   {
  *     "solPriceUsd": 150,
  *     "solChange1hPct": 2, "solChange24hPct": 6, // SOL trend for regime (omit → UNKNOWN-leaning)
  *     "tokens": [
  *       {
  *         "symbol": "DIPRISE",
  *         "mint": "<valid base58 mint>",
  *         "priceUsd": 0.00001, "priceSol": 6.67e-8,
  *         "liquidityUsd": 150000, "volume24hUsd": 500000,
  *         "change1hPct": -20, "change5mPct": 2.5,
  *         "txBuys": 200, "txSells": 100,   // h24 order flow (omit → quality gates fail open)
  *         "fdvUsd": 800000, "marketCapUsd": 800000, // omit → liq-vs-mcap gate fails open
  *         "series": [6.67e-8, 6.67e-8, ...],   // optional priceSol walk
 *         "fail": false,      // simulate per-token price failure
 *         "stale": false,     // rejected at discovery (never a candidate)
 *         "invalid": false,   // rejected at discovery (never a candidate)
 *         "staleAtBuy": false,// candidate, but price is stale at decision time
 *         "invalidAtBuy": false // candidate, but price invalid at decision time
 *       }
 *     ],
 *     "failAll": false  // simulate total provider outage
 *   }
 * ------------------------------------------------------------------ */

function loadMockFixture(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const fx = JSON.parse(raw);
  if (!fx || !Array.isArray(fx.tokens)) throw new Error('mock fixture must have a tokens array');
  const byMint = new Map();
  const pairsByMint = new Map(); // test-only: multiple pair rows per mint
  for (const t of fx.tokens) {
    if (Array.isArray(t.pairs) && t.pairs.length) {
      pairsByMint.set(t.mint, t.pairs.map((p) => Object.assign({}, p)));
      if (!byMint.has(t.mint)) byMint.set(t.mint, Object.assign({}, t));
    } else {
      byMint.set(t.mint, Object.assign({}, t));
    }
  }
  return { solPriceUsd: Number(fx.solPriceUsd) || 150, solChange1hPct: fx.solChange1hPct, solChange24hPct: fx.solChange24hPct, byMint, pairsByMint, failAll: !!fx.failAll };
}

function createMockProvider(mockFile, { maxPriceAgeMs }) {
  const fx = loadMockFixture(mockFile);
  const seriesIdx = new Map();
  const liqSeriesIdx = new Map();

  const advance = (mint) => {
    const t = fx.byMint.get(mint);
    if (!t || !Array.isArray(t.series) || !t.series.length) return null;
    const i = seriesIdx.get(mint) || 0;
    seriesIdx.set(mint, i + 1);
    return t.series[Math.min(i, t.series.length - 1)];
  };

  const advanceLiq = (mint) => {
    const t = fx.byMint.get(mint);
    if (!t || !Array.isArray(t.liquiditySeries) || !t.liquiditySeries.length) return null;
    const i = liqSeriesIdx.get(mint) || 0;
    liqSeriesIdx.set(mint, i + 1);
    return t.liquiditySeries[Math.min(i, t.liquiditySeries.length - 1)];
  };

  return {
    name: 'mock',
    label: 'mock',
    async getSolPriceUsd() {
      if (fx.failAll) throw new Error('mock provider unavailable');
      const c1h = Number(fx.solChange1hPct);
      const c24 = Number(fx.solChange24hPct);
      return {
        priceUsd: fx.solPriceUsd, priceSol: 1, source: 'mock', timestamp: Date.now(), ageMs: 0,
        change1hPct: Number.isFinite(c1h) ? c1h : null,
        change24hPct: Number.isFinite(c24) ? c24 : null
      };
    },
    async discoverCandidates() {
      if (fx.failAll) throw new Error('mock provider unavailable');
      const out = [];
      for (const t of fx.byMint.values()) {
        if (t.stale || t.invalid) continue; // discovery rejects bad entries
        out.push({
          symbol: t.symbol,
          mint: t.mint,
          // Mock identity anchor — a stable per-token pool address so BUY-time
          // and monitor-time observations always refer to the same pool unless
          // a fixture explicitly overrides it (tests simulate pair changes).
          pairAddress: t.pairAddress || t.mint,
          dex: t.dex || 'mock',
          priceUsd: Number(t.priceUsd) || 0,
          priceSol: Number(t.priceSol) || 0,
          liquidityUsd: Number(t.liquidityUsd) || 0,
          volume24hUsd: Number(t.volume24hUsd) || 0,
          change1hPct: Number(t.change1hPct) || 0,
          change5mPct: Number(t.change5mPct) || 0,
          // Fixture-controlled order-flow + valuation (absent → null →
          // quality gates fail open, so legacy fixtures behave as before).
          txBuys: Number.isFinite(Number(t.txBuys)) ? Number(t.txBuys) : null,
          txSells: Number.isFinite(Number(t.txSells)) ? Number(t.txSells) : null,
          fdvUsd: Number.isFinite(Number(t.fdvUsd)) ? Number(t.fdvUsd) : null,
          marketCapUsd: Number.isFinite(Number(t.marketCapUsd)) ? Number(t.marketCapUsd) : null,
          source: 'mock',
          fetchedAt: Date.now()
        });
      }
      return out;
    },
    /** Per-token failure is isolated: one bad token never stops the rest.
     * opts.preferredPairs (Map<mint, pairAddress>) selects the preferred pair
     * row for mints declared with a `pairs` array (Phase 15 test support);
     * otherwise the highest-liquidity pair row is chosen. */
    async fetchTokenPrices(mints, opts = {}) {
      if (fx.failAll) throw new Error('mock provider unavailable');
      const out = new Map();
      for (const mint of mints) {
        const t = fx.byMint.get(mint);
        if (!t) continue;

        // Multi-pair row selection (test-only capability).
        const pairRows = fx.pairsByMint.get(mint);
        if (pairRows && pairRows.length) {
          const want = opts.preferredPairs && opts.preferredPairs.get(mint);
          let row = want ? pairRows.find((p) => p.pairAddress === want) : null;
          if (!row) {
            row = pairRows.slice().sort((a, b) => Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0))[0];
          }
          if (!row) continue;
          const priceSolRow = Number(row.priceSol) || 0;
          const priceUsdRow = Number(row.priceUsd) || 0;
          if (!(priceSolRow > 0) || !(priceUsdRow > 0)) continue;
          const nowRow = Date.now();
          out.set(mint, {
            priceUsd: priceUsdRow,
            priceSol: priceSolRow,
            source: 'mock',
            timestamp: nowRow,
            ageMs: 0,
            pairAddress: row.pairAddress || mint,
            dex: row.dex || 'mock',
            liquidityUsd: Number(row.liquidityUsd) || 0,
            volume24hUsd: Number(row.volume24hUsd) || 0
          });
          continue;
        }
        try {
          if (t.fail) throw new Error(`mock fetch failure (${t.symbol})`);
          const baseSol = Number(t.priceSol) || 0;
          const priceSol = advance(mint) || baseSol;
          const baseLiq = Number(t.liquidityUsd) || 0;
          const liqWalked = advanceLiq(mint);
          const liquidityUsd = liqWalked != null ? Number(liqWalked) || 0 : baseLiq;
          const now = Date.now();
          let ageMs = 0;
          if (t.staleAtBuy) ageMs = maxPriceAgeMs + 60000; // guarantee staleness
          const priceUsd = t.invalidAtBuy ? 0
            : (Number(t.priceUsd) || 0) * (baseSol ? priceSol / baseSol : 1);
          out.set(mint, {
            priceUsd,
            priceSol: t.invalidAtBuy ? 0 : priceSol,
            source: 'mock',
            timestamp: now - ageMs,
            ageMs,
            pairAddress: t.pairAddress || t.mint,
            dex: t.dex || 'mock',
            liquidityUsd,
            volume24hUsd: Number(t.volume24hUsd) || 0
          });
        } catch (err) {
          // isolate per-token failures — continue with the remaining tokens
        }
      }
      return out;
    }
  };
}

/* ------------------------------------------------------------------ *
 * DexScreener provider (REAL market data).
 * ------------------------------------------------------------------ */

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';
const MAX_DISCOVERY_MINTS = 90; // cap on merged discovery mints per scan

/**
 * Solana mint from a DexScreener token-profile / token-boost entry (else null).
 * Only real Solana entries pass: chainId must be 'solana' and the token
 * address must be a valid base58 Solana mint. Non-Solana entries are rejected
 * even when their address happens to look base58-like.
 */
function mintFromProfileEntry(p) {
  if (!p || p.chainId !== 'solana') return null;
  return isValidSolanaAddress(p.tokenAddress) ? p.tokenAddress : null;
}

/**
 * Solana mint from a GeckoTerminal relationship id, e.g. 'solana_<address>'.
 * Any non-Solana id ('ethereum_0x…', 'base_0x…', …) is rejected.
 */
function mintFromGeckoId(id) {
  if (typeof id !== 'string') return null;
  const at = id.indexOf('_');
  const addr = at >= 0 ? id.slice(at + 1) : id;
  return isValidSolanaAddress(addr) ? addr : null;
}

/** Solana mints (deduped, in order) from a GeckoTerminal pools response body. */
function mintsFromGeckoPools(body) {
  const pools = Array.isArray(body && body.data) ? body.data : [];
  const out = [];
  const seen = new Set();
  for (const pool of pools) {
    const rel = pool && pool.relationships && pool.relationships.base_token;
    const mint = mintFromGeckoId(rel && rel.data && rel.data.id);
    if (mint && !seen.has(mint)) { seen.add(mint); out.push(mint); }
  }
  return out;
}

function createDexProvider({ maxPriceAgeMs, solPriceCacheMs, onEvent }) {
  let solCache = null;      // { priceUsd, ts }
  let lastOkAt = null;
  let lastError = null;
  let requests = 0;
  let failures = 0;

  const noteOk = () => { lastOkAt = Date.now(); lastError = null; };
  const noteErr = (msg) => { lastError = msg; failures += 1; };
  const emit = (tag, msg) => { if (onEvent) onEvent(tag, msg); };

  async function getSolPriceUsd() {
    const now = Date.now();
    if (solCache && now - solCache.ts < solPriceCacheMs) return solCache;
    requests += 1;
    const data = await fetchJson(
      `${DEXSCREENER_BASE}/latest/dex/tokens/${WRAPPED_SOL_MINT}`,
      { timeoutMs: DEFAULT_TIMEOUT_MS, label: 'dex-sol-price' }
    );
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    const solPair = pairs.find((p) =>
      p && p.baseToken && p.baseToken.address === WRAPPED_SOL_MINT && Number(p.priceUsd) > 0);
    if (!solPair) throw new Error('dex-sol-price: no SOL/USD pair in response');
    const priceUsd = Number(solPair.priceUsd);
    noteOk();
    // SOL trend travels with the price (same wSOL pair — no extra request).
    // Missing windows → null (callers treat unknown trend as no signal).
    const pc = solPair.priceChange || {};
    const change1hPct = Number(pc.h1);
    const change24hPct = Number(pc.h24);
    solCache = { priceUsd, ts: now };
    return {
      priceUsd, priceSol: 1, source: 'dexscreener', timestamp: now, ageMs: 0,
      change1hPct: Number.isFinite(change1hPct) ? change1hPct : null,
      change24hPct: Number.isFinite(change24hPct) ? change24hPct : null
    };
  }

  function candidateFromPair(pair) {
    const base = pair.baseToken;
    if (!base || !isValidSolanaAddress(base.address)) return null;
    const priceUsd = Number(pair.priceUsd);
    const priceNative = Number(pair.priceNative);
    const liquidityUsd = Number(pair.liquidity && pair.liquidity.usd) || 0;
    const volume24hUsd = Number(pair.volume && pair.volume.h24) || 0;
    const priceChange = pair.priceChange || {};
    if (!(priceUsd > 0)) return null;
    if (!(liquidityUsd > 0) || !(volume24hUsd > 0)) return null;
    const change1hPct = Number(priceChange.h1);
    const change5mPct = Number(priceChange.m5);
    if (!Number.isFinite(change1hPct) || !Number.isFinite(change5mPct)) return null;
    // Order-flow + valuation (entry-quality gates; null when absent so the
    // gates fail open instead of trading blind or blocking blindly).
    const h24 = (pair.txns && pair.txns.h24) || {};
    const txBuys = Number(h24.buys);
    const txSells = Number(h24.sells);
    const fdvUsd = Number(pair.fdv);
    const marketCapUsd = Number(pair.marketCap);
    return {
      symbol: base.symbol || base.address.slice(0, 6),
      mint: base.address,
      // Price identity: the exact AMM pool this price came from. Preserved so
      // an open position is never accounted against a different pool.
      pairAddress: pair.pairAddress || null,
      dex: pair.dexId || null,
      priceUsd,
      priceSol: 0, // filled later via real SOL price
      priceNative,
      quoteToken: pair.quoteToken ? pair.quoteToken.address : null,
      liquidityUsd,
      volume24hUsd,
      change1hPct,
      change5mPct,
      txBuys: Number.isFinite(txBuys) ? txBuys : null,
      txSells: Number.isFinite(txSells) ? txSells : null,
      fdvUsd: Number.isFinite(fdvUsd) ? fdvUsd : null,
      marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : null,
      source: 'dexscreener',
      fetchedAt: Date.now()
    };
  }

  /**
   * Discovery — merged multi-feed scan.
   *
   * Feeds (each isolated: one failing feed is logged and skipped, never the
   * whole scan):
   *   dex-profiles      newest token profiles      (DexScreener)
   *   dex-boosts        currently boosted tokens   (DexScreener)
   *   dex-boosts-top    top boosted tokens         (DexScreener)
   *   gt-trending       trending pools             (GeckoTerminal)
   *   gt-new            newly created pools        (GeckoTerminal)
   *
   * Feeds contribute Solana MINTS only. Every mint is then resolved through
   * the DexScreener pair batch endpoint, so all candidates share one real
   * price/liquidity/volume schema and one real SOL conversion. A mint without
   * usable DexScreener pair data is dropped — the engine never guesses a price
   * for an unknown pair. `via` records which feed(s) found each candidate.
   *
   * The scan only throws when every feed AND every pair resolution fails.
   */
  async function discoverCandidates() {
    const feeds = [
      { id: 'dex-profiles', url: `${DEXSCREENER_BASE}/token-profiles/latest/v1`, label: 'dex-profiles', extract: (b) => (Array.isArray(b) ? b : []).map(mintFromProfileEntry).filter(Boolean) },
      { id: 'dex-boosts', url: `${DEXSCREENER_BASE}/token-boosts/latest/v1`, label: 'dex-boosts', extract: (b) => (Array.isArray(b) ? b : []).map(mintFromProfileEntry).filter(Boolean) },
      { id: 'dex-boosts-top', url: `${DEXSCREENER_BASE}/token-boosts/top/v1`, label: 'dex-boosts-top', extract: (b) => (Array.isArray(b) ? b : []).map(mintFromProfileEntry).filter(Boolean) },
      { id: 'gt-trending', url: `${GECKOTERMINAL_BASE}/trending_pools?page=1`, label: 'gt-trending', extract: mintsFromGeckoPools },
      { id: 'gt-new', url: `${GECKOTERMINAL_BASE}/new_pools?page=1`, label: 'gt-new', extract: mintsFromGeckoPools }
    ];

    // 1. Gather mints from every feed, deduped, with feed attribution.
    const mints = [];
    const via = new Map(); // mint -> [feed ids]
    let feedFailures = 0;
    for (const feed of feeds) {
      requests += 1;
      let body;
      try {
        body = await fetchJson(feed.url, { timeoutMs: DEFAULT_TIMEOUT_MS, label: feed.label });
        noteOk();
      } catch (err) {
        noteErr(err.message);
        feedFailures += 1;
        emit('DISCOVERY-SKIP', `discovery feed ${feed.id} unavailable (${err.message}) — continuing with the others`);
        continue;
      }
      for (const mint of feed.extract(body)) {
        if (!via.has(mint)) { via.set(mint, []); mints.push(mint); }
        via.get(mint).push(feed.id);
      }
    }
    if (!mints.length) {
      if (feedFailures === feeds.length) throw new Error('all discovery feeds unavailable');
      return [];
    }
    const targets = mints.slice(0, MAX_DISCOVERY_MINTS);

    // 2. Resolve mints through the DexScreener pair batch endpoint (chunked,
    //    isolated — one failed chunk never stops the rest).
    const bestByMint = new Map();
    const chunks = [];
    for (let i = 0; i < targets.length; i += MAX_TOKENS_PER_REQUEST) {
      chunks.push(targets.slice(i, i + MAX_TOKENS_PER_REQUEST));
    }
    let chunkFailures = 0;
    for (const chunk of chunks) {
      requests += 1;
      let data;
      try {
        data = await fetchJson(`${DEXSCREENER_BASE}/latest/dex/tokens/${chunk.join(',')}`,
          { timeoutMs: DEFAULT_TIMEOUT_MS, label: 'dex-tokens' });
        noteOk();
      } catch (err) {
        noteErr(err.message);
        chunkFailures += 1;
        emit('DISCOVERY-SKIP', `pair resolution failed for ${chunk.length} mint(s) (${err.message}) — continuing`);
        continue;
      }
      const pairs = Array.isArray(data.pairs) ? data.pairs : [];
      for (const pair of pairs) {
        if (!pair || pair.chainId !== 'solana') continue;
        const cand = candidateFromPair(pair);
        if (!cand) continue;
        const prev = bestByMint.get(cand.mint);
        if (!prev || cand.liquidityUsd > prev.liquidityUsd) bestByMint.set(cand.mint, cand);
      }
    }
    if (!bestByMint.size) {
      if (chunkFailures === chunks.length) throw new Error('pair resolution failed for all discovery mints');
      return [];
    }

    // 3. Fill priceSol from the REAL SOL price; reject candidates we cannot.
    let solPriceUsd = null;
    try {
      solPriceUsd = (await getSolPriceUsd()).priceUsd;
    } catch (err) {
      emit('PRICE-FALLBACK', `SOL price unavailable (${err.message}) — using SOL-quoted priceNative where possible`);
    }

    const out = [];
    for (const cand of bestByMint.values()) {
      // Phase 14 (audit P2-05): isolate each candidate — one malformed entry
      // must never abort the entire discovery scan.
      try {
        if (solPriceUsd) {
          cand.priceSol = cand.priceUsd / solPriceUsd;
        } else if (cand.quoteToken === WRAPPED_SOL_MINT && cand.priceNative > 0) {
          cand.priceSol = cand.priceNative;
        } else {
          continue; // no way to express this price in SOL → drop the candidate
        }
        // Root cause of the historical "Cannot read properties of undefined
        // (reading 'join')": bestByMint is keyed by mints resolved from
        // DexScreener pairs while `via` is keyed by mints extracted from the
        // discovery feeds; a mint present in the pair batch but missing from
        // the feed map (or vice versa) made via.get(...) undefined. Defend
        // with a safe fallback instead of crashing.
        const viaArr = via.get(cand.mint);
        cand.via = Array.isArray(viaArr) ? viaArr.join('+') : 'unknown';
        out.push(cand);
      } catch (err) {
        emit('DISCOVERY-SKIP', `candidate ${(cand && cand.mint) || '?'} dropped: ${err.message} — scan continues`);
      }
    }
    return out;
  }

  /**
   * Fetch current prices for many mints with bounded concurrency. Batch size
   * respects the API limit; one failed batch never stops the rest. Returns a
   * Map<mint, priceInfo>.
   *
   * Phase 15 (audit: STONK pair flapping): opts.preferredPairs is an optional
   * Map<mint, pairAddress>. When the mint's preferred (e.g. entry) pair is
   * present in the response it is selected INSTEAD of the best-liquidity pair,
   * so open positions keep being priced on their anchored market identity.
   * If the preferred pair is absent from the response the previous
   * best-liquidity selection is returned unchanged — price-integrity's
   * PAIR_CHANGED gate remains the authority that rejects foreign-pair
   * observations for anchored positions (no silent switching, no hysteresis).
   */
  async function fetchTokenPrices(mints, opts = {}) {
    const sol = await getSolPriceUsd().catch(() => null);
    const out = new Map();
    const chunks = [];
    for (let i = 0; i < mints.length; i += MAX_TOKENS_PER_REQUEST) {
      chunks.push(mints.slice(i, i + MAX_TOKENS_PER_REQUEST));
    }
    const CONCURRENCY = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        requests += 1;
        let data;
        try {
          data = await fetchJson(`${DEXSCREENER_BASE}/latest/dex/tokens/${chunk.join(',')}`,
            { timeoutMs: DEFAULT_TIMEOUT_MS, label: 'dex-tokens' });
          noteOk();
        } catch (err) {
          noteErr(err.message);
          continue; // skip failed batch, keep sampling the rest
        }
        const pairs = Array.isArray(data.pairs) ? data.pairs : [];
        const byBase = new Map();
        const preferredByBase = new Map();
        for (const pair of pairs) {
          if (!pair || pair.chainId !== 'solana' || !pair.baseToken) continue;
          const want = opts.preferredPairs && opts.preferredPairs.get(pair.baseToken.address);
          if (want && pair.pairAddress === want) {
            preferredByBase.set(pair.baseToken.address, pair);
            continue;
          }
          const cur = byBase.get(pair.baseToken.address);
          if (!cur || Number(pair.liquidity && pair.liquidity.usd) > Number(cur.liquidity && cur.liquidity.usd)) {
            byBase.set(pair.baseToken.address, pair);
          }
        }
        const now = Date.now();
        for (const mint of chunk) {
          // Phase 15: entry pair wins over best-liquidity when available.
          const pair = preferredByBase.get(mint) || byBase.get(mint);
          if (!pair) continue;
          const priceUsd = Number(pair.priceUsd);
          let priceSol = 0;
          if (sol && sol.priceUsd > 0) {
            priceSol = priceUsd / sol.priceUsd;
          } else if (pair.quoteToken && pair.quoteToken.address === WRAPPED_SOL_MINT) {
            priceSol = Number(pair.priceNative) || 0;
          } else {
            continue; // cannot express in SOL → skip
          }
          if (!(priceUsd > 0) || !(priceSol > 0)) continue;
          out.set(mint, {
            priceUsd,
            priceSol,
            source: 'dexscreener',
            timestamp: now,
            ageMs: 0,
            // Identity of the pool actually priced (best-liquidity pair).
            pairAddress: pair.pairAddress || null,
            dex: pair.dexId || null,
            // Pool depth for the gap-kill liquidity-rug path (gap-kill skips
            // the check when absent — price gap still applies).
            liquidityUsd: Number(pair.liquidity && pair.liquidity.usd) || 0,
            volume24hUsd: Number(pair.volume && pair.volume.h24) || 0
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    return out;
  }

  return {
    name: 'dexscreener',
    label: 'dexscreener',
    getSolPriceUsd,
    discoverCandidates,
    fetchTokenPrices,
    stats() {
      return { requests, failures, lastOkAt, lastError };
    }
  };
}

/* ------------------------------------------------------------------ *
 * Circuit data API hook (optional PRIMARY).
 *
 * Activated by CIRCUIT_PRICE_API_URL. Expected contract (documented in
 * README): GET {base}/tokens/{mint} →
 *   { "priceUsd": 0.000123, "priceSol": 1.2e-6, "source": "circuit",
 *     "timestamp": 1720000000000 }
 * If a price field is missing it falls back to the other field via the real
 * SOL price. Any failure falls back to DexScreener automatically.
 * ------------------------------------------------------------------ */

function createCircuitProvider(apiBase, { onEvent }) {
  let lastOkAt = null;
  let lastError = null;
  let requests = 0;
  let failures = 0;
  const emit = (tag, msg) => { if (onEvent) onEvent(tag, msg); };

  return {
    name: 'circuit',
    label: 'circuit',
    async fetchTokenPrices(mints) {
      const out = new Map();
      const CONCURRENCY = 4;
      let cursor = 0;
      async function worker() {
        while (cursor < mints.length) {
          const mint = mints[cursor++];
          requests += 1;
          try {
            const body = await fetchJson(`${apiBase}/tokens/${mint}`,
              { timeoutMs: DEFAULT_TIMEOUT_MS, label: 'circuit-price' });
            const priceUsd = Number(body && body.priceUsd);
            const priceSol = Number(body && body.priceSol);
            const now = Date.now();
            if (priceUsd > 0 || priceSol > 0) {
              lastOkAt = now;
              lastError = null;
              out.set(mint, {
                priceUsd,
                priceSol,
                source: 'circuit',
                timestamp: now,
                ageMs: 0,
                pairAddress: (body && body.pairAddress) || null,
                dex: (body && body.dex) || null,
                liquidityUsd: Number(body && body.liquidityUsd) || 0,
                volume24hUsd: Number(body && (body.volume24hUsd || body.volumeUsd)) || 0
              });
            } else {
              lastError = `circuit-price: no valid price for ${mint}`;
            }
          } catch (err) {
            lastError = err.message;
            failures += 1;
            emit('PRICE-FALLBACK', `Circuit price failed for ${mint} (${err.message}) — falling back to DexScreener`);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, mints.length) }, worker));
      return out;
    },
    stats() {
      return { requests, failures, lastOkAt, lastError };
    }
  };
}

/* ------------------------------------------------------------------ *
 * createMarketData — the one entry point.
 *
 * options:
 *   circuitApiUrl    optional CIRCUIT_PRICE_API_URL (becomes primary)
 *   mockFile         optional CIRCUIT_MOCK_MARKET_FILE (tests only)
 *   maxPriceAgeMs    staleness limit for trade decisions
 *   solPriceCacheMs  SOL price cache TTL
 *   onEvent          (tag, msg) callback for [PRICE-FALLBACK] style logs
 * ------------------------------------------------------------------ */

function createMarketData(options = {}) {
  const opts = Object.assign({
    circuitApiUrl: null,
    mockFile: null,
    maxPriceAgeMs: 60000,
    solPriceCacheMs: DEFAULT_SOL_PRICE_CACHE_MS,
    onEvent: null
  }, options);

  if (opts.mockFile) {
    return {
      mode: 'mock',
      primarySource: 'mock',
      fallbackSource: null,
      ...createMockProvider(opts.mockFile, { maxPriceAgeMs: opts.maxPriceAgeMs })
    };
  }

  const dex = createDexProvider({
    maxPriceAgeMs: opts.maxPriceAgeMs,
    solPriceCacheMs: opts.solPriceCacheMs,
    onEvent: opts.onEvent
  });

  if (opts.circuitApiUrl) {
    const circuit = createCircuitProvider(opts.circuitApiUrl, { onEvent: opts.onEvent });
    return {
      mode: 'real',
      primarySource: 'circuit',
      fallbackSource: 'dexscreener',
      async getSolPriceUsd() { return dex.getSolPriceUsd(); },
      /**
       * Primary = Circuit. Prices the Circuit API cannot provide are fetched
       * from DexScreener. When both provide a price, they are compared and
       * abnormally divergent prices are rejected (never silently substituted).
       */
      async fetchTokenPrices(mints, pairOpts = {}) {
        const [circuitPrices, dexPrices] = await Promise.all([
          circuit.fetchTokenPrices(mints).catch(() => new Map()),
          // Phase 15: forward preferred-pair anchoring to the DEX leg.
          dex.fetchTokenPrices(mints, pairOpts).catch(() => new Map())
        ]);
        const out = new Map();
        for (const mint of mints) {
          const c = circuitPrices.get(mint);
          const d = dexPrices.get(mint);
          if (c && d) {
            const cmp = comparePrices(c, d, opts.maxDivergencePct || 25);
            if (!cmp.ok) {
              if (opts.onEvent) {
                opts.onEvent('FILTER', `price divergence ${cmp.divergencePct}% for ${mint} — rejecting`);
              }
              continue;
            }
            // Circuit primary; pool identity (when the DEX quote provides it)
            // is carried for price-integrity diagnostics.
            out.set(mint, Object.assign({}, c, {
              priceSol: c.priceSol || d.priceSol,
              pairAddress: c.pairAddress || d.pairAddress || null,
              dex: c.dex || d.dex || null,
              liquidityUsd: Number(c.liquidityUsd) || Number(d.liquidityUsd) || 0,
              volume24hUsd: Number(c.volume24hUsd) || Number(d.volume24hUsd) || 0
            }));
          } else if (c) {
            out.set(mint, c);
          } else if (d) {
            if (opts.onEvent) {
              opts.onEvent('PRICE-FALLBACK', `Circuit price missing for ${mint} — using DexScreener`);
            }
            out.set(mint, d);
          }
        }
        return out;
      },
      async discoverCandidates() {
        // Discovery via DexScreener (Circuit has no discovery contract yet).
        return dex.discoverCandidates();
      },
      priceSources: () => [
        { name: 'circuit', role: 'primary', ...circuit.stats() },
        { name: 'dexscreener', role: 'fallback', ...dex.stats() }
      ]
    };
  }

  return {
    mode: 'real',
    primarySource: 'dexscreener',
    fallbackSource: null,
    getSolPriceUsd: dex.getSolPriceUsd,
    discoverCandidates: dex.discoverCandidates,
    fetchTokenPrices: dex.fetchTokenPrices,
    priceSources: () => [{ name: 'dexscreener', role: 'primary', ...dex.stats() }]
  };
}

module.exports = {
  createMarketData,
  isValidSolanaAddress,
  isValidPrice,
  priceAgeMs,
  comparePrices,
  mintFromProfileEntry,
  mintFromGeckoId,
  mintsFromGeckoPools,
  WRAPPED_SOL_MINT
};