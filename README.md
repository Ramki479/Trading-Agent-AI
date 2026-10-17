# Real-Market Solana Paper Trader (`agentd`)

Self-contained, dependency-free **REAL-MARKET SOLANA PAPER TRADING** agent
(Circuit `paper-trader`) with a fully persistent portfolio, real price
history, and a **read-only** web dashboard/API.

```
        REAL SOLANA MARKET DATA            PAPER EXECUTION
   ┌─────────────────────────────┐   ┌──────────────────────────┐
   │ DISCOVERY FEEDS (60 s)      │   │ agentd.js                │
   │  DexScreener: profiles,     │   │  • discovery (60 s)       │
   │    latest boosts, top boosts│──▶│  • 15 s price sampling    │
   │  GeckoTerminal: trending,   │   │  • local 5m recovery      │
   │    new pools                │   │  • dip-reversal strategy  │
   │ PRICES: DexScreener pairs   │   │  • paper BUY/SELL (0.05)  │
   │ (real mints, liq, vol,      │   └──────────┬───────────────┘
   │  SOL/USD; optional Circuit) │              ▼
   └─────────────────────────────┘   portfolio.json · trades.jsonl
                                     equity-history.jsonl · heartbeat.json
                                     candidates.json · agent.log
                                                ▼
                     dashboard-api.js (:8787, READ-ONLY) → web dashboard
```

**No wallet. No private keys. No seed phrase. No signer. No broadcast. No real
money.** Every price used for accounting originates from **real market data**;
trades are simulated with virtual SOL. Wallet / signer / broadcast are
DISABLED by design and cannot be enabled by configuration.

## Safety invariants (hard-coded)

- `paperTrading` is **always** `true` — there is no live-trading code path.
  `CIRCUIT_SIGNER_URL` (if set) is **ignored**.
- No wallet is created/loaded; no keys/seed phrases exist (`meta.json` records
  `wallet: null`, `signerUrl: null`).
- `custody` is always `"local"`.
- No `Math.random()` anywhere in market data / P&L / signals. Every displayed
  value derives from observed real market data.
- Missing, stale, invalid, or divergent prices → **NO TRADE** (never a guess).
- The dashboard API is strictly read-only: it never writes state, cannot
  trade, and every response advertises `"paper": true`.

## Market data (real)

| Source | Role | Activation |
| --- | --- | --- |
| **DexScreener** | prices + discovery feeds (no key) | always |
| **GeckoTerminal** | discovery feeds only (no key) | always |
| **Circuit data API** | optional price primary | `CIRCUIT_PRICE_API_URL` env |
| **Mock** | tests only | `CIRCUIT_MOCK_MARKET_FILE` env |

Price flow:

- **Discovery** (60 s) — a **merged multi-feed scan**. Five independent real
  feeds contribute Solana mints, each isolated so one failing feed is logged
  (`[DISCOVERY-SKIP]`) and skipped while the rest of the scan continues:

  | Feed | Source | What it adds |
  | --- | --- | --- |
  | `dex-profiles` | DexScreener | newest token profiles |
  | `dex-boosts` | DexScreener | currently boosted tokens |
  | `dex-boosts-top` | DexScreener | top boosted tokens |
  | `gt-trending` | GeckoTerminal | trending pools — established tokens (dip-reversal population) |
  | `gt-new` | GeckoTerminal | newly created pools |

  Mints are deduped across feeds (candidates record which feed(s) found them
  as `via`), then resolved in one pass through the **DexScreener pair batch
  endpoint**. GeckoTerminal therefore widens the *universe* the strategy sees;
  it never becomes a second price provider — every candidate shares one real
  price/liquidity/volume schema and one real SOL conversion. A mint with no
  usable DexScreener pair data is dropped (the engine never guesses a price
  for an unknown pair). Every candidate has a real base58 mint, price USD,
  price SOL, liquidity, volume, 1h change, source, timestamp. Invalid / null
  mints and stale entries are rejected. The scan only errors when *every*
  feed and pair resolution fails.
- **SOL price**: real SOL/USD from the wrapped-SOL market; `priceSol =
  priceUsd / solPriceUsd` — never an approximation.
- **Price metadata**: `{ priceUsd, priceSol, source, timestamp, ageMs }`.
  Prices older than `CIRCUIT_MAX_PRICE_AGE_MS` (default 60 s) are refused.
- **Divergence**: when both Circuit and DexScreener supply a price, relative
  divergence above the limit rejects it (`[FILTER] ... price divergence XX%`).
- **Failure isolation**: per-request timeouts (`AbortController`), bounded
  concurrency, retry-free skip; one bad token or one failed provider never
  stops the agent. Failures are logged (`[PRICE-FALLBACK]`,
  `[DISCOVERY-SKIP]`, `[HISTORY-SKIP]`, `[SCAN ERROR]`) and the agent keeps
  running.

The Circuit API hook expects `GET {CIRCUIT_PRICE_API_URL}/tokens/{mint}` →
`{ "priceUsd": ..., "priceSol": ..., "timestamp": ... }` (a missing field
falls back to the other via the real SOL price; failures fall back to
DexScreener automatically).

### 5-minute price history (local, real)

The 5m recovery used for trading is **never** the discovery API's reported 5m
value. The agent maintains its own per-token real-time history:

- samples ≈ every 15 s (bounded concurrency, non-overlapping cycles, ~15 min
  kept);
- `5m recovery = (current / baseline ≈5 min old − 1) × 100`, where the
  baseline must actually be ≈5 minutes old;
- insufficient history → **`5m = WARMING` → no trade**. Warming is never
  treated as 0%.

## Strategy (fixed — do not change without explicit request)

Dip/reversal with these exact gates:

```
MAX_POSITIONS    = 5            trade size = 0.05 SOL (config default)
STOP_LOSS        = -6%          TAKE_PROFIT = +8%  (fixed fallbacks)
ATR exits        SL=1.5×NATR    TP=2.5×NATR (per-position; NATR>4% rejected)
ORDERFLOW        h24 sells≤1.5×buys; liq≥2% of mcap (fdv fallback)
RSI + VWAP       1m RSI(14)<30 turning up + reclaim 5m mean (closes-only proxy)
WINPROB          Laplace-NB P(win) over entry features, PF-tuned threshold
ENSEMBLE 2/3     V1+TA+ATLAS explicit-BUY agreement (SHADOW records, ENFORCE blocks)
                 BUY/HOLD/AVOID votes only on explicit BUY; per-mint verdicts
                 remembered within each layer's cache TTL; no verdict
                 anywhere → degraded V1-only (liveness)
BANDIT           Thompson minScore per regime|time|liq (workflow-approved)
REGIME           SOL 1h/24h trend + discovery breadth (never own PnL)
RISK             daily loss halt ≤-3% (watchOnly rest of UTC day);
VOL SIZE         size = base × (3% targetVol / NATR), hard cap 0.05 SOL
BOUNCE CONFIRM   2 rising 15s closes + rising 5m slope (no single-point buys)
PARTIAL_TAKE     = +5% (50%)    runner SL→entry (ATR runners keep sized TP)
MIN_5M_RECOVERY  = +0.25%       MAX_5M_RECOVERY = +8%
1h change        > -35% and <= +15%
MIN_SCORE        = 60           re-entry cooldown = 600000 ms (10 min)
```

A candidate is ranked by a deterministic score (0–100, from real data only):
up to 35 pts for a deeper 1h dip inside the allowed band, 30 for a stronger
local 5m recovery, 20 for liquidity, 15 for volume. All eight BUY gates must
pass, including: no open position for the mint, not inside re-entry cooldown,
price valid and fresh (a fresh price is fetched at decision time), real market
price available, and max positions not exceeded. Each rejection is logged:

```
[SCAN #12] 3 real candidate(s)
  ABC score=70 1h=-18.20% 5m=+1.32% price=$0.00012345 priceSOL=0.00000123 liq=25.0K vol=150.0K src=dexscreener
  XYZ score=45 1h=+131.00% 5m=warming(4 samples) ...
[FILTER] ABC 1h change outside range
[PAPER BUY] XYZ
```

Sells are stop-loss / take-profit at per-position levels (ATR-sized
`SL=1.5×NATR, TP=2.5×NATR` when trailing NATR is known, else fixed −6%/+8%),
monitored every 5 s — plus risk exits: `partial-take` (50% at +5%, runner
SL→breakeven), `breakeven-stop`, `liquidity-kill` (pool drain ≥50% exits
now), adverse extremes fast-confirm in 1 print (single prints never sell),
and `time-stop` (stale <+2% past 60 m). Candidates hotter
than `NATR 4%` are rejected outright (stop would gap). Partials bank profit
without closing the trade (no cooldown); only final closes count toward
win rate.
After a final SELL the mint enters a 10-minute re-entry cooldown **persisted in
`portfolio.json`**, so a restart cannot bypass it.

## Files

| File | Purpose |
| --- | --- |
| `agentd.js` | The agent (engine + strategy + accounting). Start it on the machine that owns the account. |
| `market-data.js` | Real market-data layer (DexScreener / optional Circuit / mock-for-tests). Read-only. |
| `price-integrity.js` | Accounting trust gate: pair-change, source-divergence, extreme-move quarantine. |
| `research-history.js` | Bounded persistent RESEARCH price history (separate from the V1 operational 15-min history). Supports ATLAS/TradingAgents horizon resolution (5m–4h). |
| `ledger-integrity.js` | READ-ONLY ledger/portfolio reconciliation & foreign-row classifier (`node ledger-integrity.js [dataDir]`). |
| `dashboard-api.js` | **Read-only HTTP API** for the live paper portfolio. |
| `fx.js` | **Display-only** USD/INR layer for the API/dashboard (live rate + cache + converters). Never used by the engine. |
| `dashboard/` | **Web dashboard** (static HTML/CSS/JS, no build step). |
| `portfolio.js` / `paper-portfolio` | CLI portfolio viewer. |
| `test/run-tests.js` | Full test suite (`node test/run-tests.js`) — runs the agent against a mock provider. |
| `test/hardening-tests.js` | Deterministic offline tests for the forensic hardening fixes (92 checks). |
| `dev-fixture.js`, `dev-browser-check.js` | Local dev tooling for the dashboard. |

## Persistent state (atomic tmp + rename writes)

Data lives in `${CIRCUIT_AGENT_DATA_DIR}` (default `~/.circuit/agents/paper-trader/`):

| File | Purpose |
| --- | --- |
| `portfolio.json` | Account state: cash, equity, P&L, statistics, open positions, **cooldowns**. Written atomically; the source of truth. |
| `trades.jsonl` | Append-only ledger of every BUY and SELL (mint, SOL + USD prices, realized P&L, reason). |
| `equity-history.jsonl` | Append-only observed equity samples (never invented). |
| `heartbeat.json` | Machine-readable status + full portfolio summary + price sources + last errors. |
| `candidates.json` | Last discovery scan: real candidates, scores, decisions/reasons. |
| `config.json` | Runtime config (auto-created). |
| `meta.json` | Agent metadata (`wallet: null`, `signerUrl: null`). |
| `agent.lock` | Process lease with build provenance (pid, hostname, source dir, version, git, node, paper/wallet/signer/broadcast flags). A second copy refuses to start; a lock from a DIFFERENT build identity is never taken over (fail closed). |
| `agent.pid` | Companion pid file — a live mismatched pid blocks startup (foreign/legacy writer detection). |
| `research-prices.jsonl` | Research price history (bounded, restart-safe; retention ≈ 6h, per-mint + global caps, size-capped with compaction). |
| `ensemble-shadow.jsonl` | Ensemble gate records: every V1-pass candidate's 2/3 verdict (`agrees`/`needed`, votes, SHADOW vs ENFORCE). Append-only diagnostics; is NEVER read back as state. |
| `agent.log` | Human-readable log. |

Crash-safety ordering: portfolio state is persisted **before** the matching
ledger row is appended, so an interrupted trade can never resurrect a sold
position (worst case is a missing ledger row, never corrupted accounting).

## Configuration

`config.json` defaults:

```json
{
  "scanIntervalMs": 5000,        // monitor open positions
  "discoveryIntervalMs": 60000,  // token discovery
  "sampleIntervalMs": 15000,     // price-history sampling
  "paperTrading": true,          // force-true — cannot be turned off
  "strategy": "dip-reversal",
  "tradeSizeSol": 0.05,
  "startingCapitalSol": 10
}
```

`startingCapitalSol` only applies when a new account is created; restarts load
`portfolio.json` as-is (balance never reset, ledger never erased). Strategy
thresholds (max positions, SL/TP, cooldown, score) are **hard-coded
constants** and are not configurable. The 1h/5m entry bands additionally
support **promoted tightening** through the approval workflow
(`strategy-experiments.js`: band experiment → `runBacktest` → shadow →
operator approval → `strategy-versions.json` `bandsBase`, rollback-safe);
the scanner applies the promoted bands globally, per-cluster learned gates
only tighten further. V1 (`-35..+15` / `+0.25..+8%`) applies until a band
experiment is promoted.

The ensemble gate's runtime knobs:

```
config.ensemble.mode       SHADOW (records, never blocks) | ENFORCE (FILTERs < minAgree) | OFF
config.ensemble.minAgree   2/3 default (1..3 clamped)
CIRCUIT_ENSEMBLE_MODE      env override for config.ensemble.mode
```

Environment variables (all optional; documented test/ops knobs):

| Variable | Meaning | Default |
| --- | --- | --- |
| `CIRCUIT_AGENT_DATA_DIR` | data directory | `~/.circuit/agents/paper-trader` |
| `CIRCUIT_PRICE_API_URL` | optional Circuit data API (primary) | off |
| `CIRCUIT_SIGNER_URL` | **ignored on purpose** (no signing) | — |
| `CIRCUIT_MOCK_MARKET_FILE` | mock provider (tests only) | off |
| `CIRCUIT_MONITOR_MS` / `CIRCUIT_DISCOVERY_MS` / `CIRCUIT_SAMPLE_MS` | loop intervals | 5000 / 60000 / 15000 |
| `CIRCUIT_HISTORY_WARM_MS` | 5m baseline age (test warm-up) | 300000 |
| `CIRCUIT_COOLDOWN_MS` | re-entry cooldown (test knob) | 600000 |
| `CIRCUIT_MAX_PRICE_AGE_MS` | staleness limit | 60000 |
| `CIRCUIT_MAX_DIVERGENCE_PCT` | cross-source divergence limit | 25 |

## INR display (dashboard only — the engine always trades in SOL)

The dashboard shows money in **Indian Rupees (₹)**; all trading, accounting
and strategy math in `agentd.js` remains **100% in SOL** (untouched).

Conversion (done in `dashboard-api.js`, display layer only):

```text
inrPerSol = solPriceUsd × usdInr        (real SOL/USD from the agent heartbeat)
INR value = SOL value × inrPerSol        (equity, cash, P&L, …)
INR value = USD value × usdInr           (token prices in USD)
```

- **USD/INR sources** (live, keyless, tried in order): `open.er-api.com`
  primary, then `api.frankfurter.app` and `api.frankfurter.dev` fallbacks —
  never a fake/random/hard-coded rate. After a failed refresh the next
  attempt happens ~60 s later (not after the full 5-minute cycle).
- **Caching**: the last valid real rate is stored in
  `fx-rate-cache.json` (inside the agent data dir; this is the **only** file
  the API ever writes — agent state files stay read-only). On a provider
  outage the last rate is kept and every payload flags `fx.cached: true`;
  the dashboard shows “RATE CACHED”. With no rate at all the dashboard
  shows the real **SOL/USD** values (never dashes, never a fabricated rate)
  plus a yellow “Exchange rate unavailable” notice. `FX_DISABLE=1` forces
  that fallback for dev/testing of the UI.
- Every API payload carries a top-level `fx` block
  (`{ usdInr, inrPerSol, solUsd, source, fetchedAt, cached, lastError }`)
  plus `*Inr` mirror fields next to the original `*Sol`/`*Usd` fields
  (e.g. `equitySol` + `equityInr`). Indian number formatting is used
  (`₹1,234.56`, `₹1,00,000.00`), the live rate is shown in the header
  (`1 USD = ₹94.54 …`), and original SOL/USD values remain in tooltips.

## Usage

```bash
cd ~/circuit-agent-cloud

# 1 — the paper trader (owns the account)
node agentd/agentd.js

# 2 — read-only API + dashboard (separate terminal)
node agentd/dashboard-api.js        # http://0.0.0.0:8787
```

On startup the agent prints the banner, acquires `agent.lock`, loads any
existing portfolio, seeds equity history once, and begins discovery/sampling/
monitoring. Stop gracefully with Ctrl-C (SIGINT/SIGTERM) or over IPC
(`{"type":"shutdown"}`) — state is persisted and the lock released.

### Dashboard

Open `http://UBUNTU_IP:8787` in a browser, or run the dashboard folder locally
and point it at the API (`agentd/dashboard/config.js` → `CIRCUIT_API_URL`, or
`?api=...` in the URL). It shows summary cards, positions, trade history,
equity curve (observed points only), live candidates with filter reasons,
price sources, system status (market/execution/wallet/broadcast), and last
errors. It auto-refreshes every 3 s and clearly marks offline/stale data —
it never invents values and has no write/trade capability.

### API endpoints (all GET, read-only, all `"paper": true`)

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | `{ ok, service, paper }` |
| `GET /api/portfolio` | Complete portfolio |
| `GET /api/heartbeat` | Heartbeat + portfolio summary + sources/errors |
| `GET /api/trades?limit=100` | Ledger, newest first (1–500) |
| `GET /api/positions` | Open positions |
| `GET /api/performance` | Portfolio + derived statistics |
| `GET /api/equity?limit=500` | Equity history |
| `GET /api/candidates` | Last discovery scan (real candidates + decisions) |
| `GET /api/system` | Market/execution/wallet/broadcast + price sources + errors |
| `GET /api/rates` | Live USD/INR rate + `fx` conversion info |
| `GET /api/dashboard` | Aggregated payload for the dashboard UI (INR mirrors included) |
| `GET /` | Serves the dashboard (same-origin) |

### Network / firewall (Ubuntu)

Keep the API on the private LAN only:

```bash
hostname -I
sudo ufw allow from 192.168.0.0/16 to any port 8787 proto tcp   # LAN only
curl http://127.0.0.1:8787/api/health
curl http://UBUNTU_IP:8787/api/health   # from Windows
```

## Tests

```bash
node agentd/test/run-tests.js        # full agent suite (584 checks)
node agentd/test/hardening-tests.js  # forensic-hardening suite (92 checks)
```

Runs the real agent as child processes against a deterministic mock market
provider (production always uses real data) and asserts on the resulting
state files. Coverage: address/price validation, 5m-history WARMING gate,
paper BUY / TAKE-PROFIT / STOP-LOSS with P&L correctness, restart recovery
(no balance reset, ledger preserved, sold positions never resurrect),
re-entry cooldown incl. persistence across restart, invalid/stale prices →
no trade, provider failures (per-token + total outage), concurrent sampler,
process lock, graceful shutdown, and the INR display layer (conversion
formula, Indian formatting, source fallback, cached-rate fallback on outage,
cache persistence — never a fabricated rate).

## Research vs operational history (important)

- **V1 operational history** (in-process, ~15 min retention) drives the
  strategy's 5m-recovery gate. It is unchanged and must never be mixed with
  research data.
- **Research history** (`research-prices.jsonl`) is a separate bounded store
  used ONLY by ATLAS/TradingAgents to resolve prediction horizons. Horizon
  outcomes always resolve from the earliest real observation **at or after**
  the prediction's target timestamp (bounded late tolerance, never a
  pre-target sample, never a fabricated price). Trade attribution is separate
  from horizon outcomes (`outcomeType: 'trade' | 'horizon'`), and a
  prediction is attributed to a trade only if it existed at/before entry.
- SL/TP are discrete polling thresholds evaluated every monitor cycle — not
  guaranteed fills.
- Pair changes on open positions are rejected by price-integrity; monitoring
  prefers each position's ENTRY pair when pricing it, but never silently
  switches identity (the PAIR_CHANGED gate remains authoritative).

## Verification

```bash
ls -lah ~/.circuit/agents/paper-trader/    # portfolio.json trades.jsonl equity-history.jsonl heartbeat.json candidates.json config.json meta.json agent.lock agent.log
cat ~/.circuit/agents/paper-trader/portfolio.json
cat ~/.circuit/agents/paper-trader/heartbeat.json     # paper:true, market:REAL SOLANA, wallet/broadcast DISABLED
tail -20 ~/.circuit/agents/paper-trader/trades.jsonl
tail -5  ~/.circuit/agents/paper-trader/agent.log     # [SCAN #n] ... real candidate(s) + decisions
node agentd/portfolio.js
curl -s http://127.0.0.1:8787/api/health
```
