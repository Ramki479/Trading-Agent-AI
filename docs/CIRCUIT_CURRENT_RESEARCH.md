# CIRCUIT CURRENT RESEARCH — `Circuit-LLM/circuit-agent` (main, commit `9663c47`)

Research performed September 2026 against the **current** upstream repository
(`https://github.com/Circuit-LLM/circuit-agent/tree/main`), tracing actual
source code — not just the README. Everything below is marked:

- **VERIFIED IN CURRENT SOURCE** — read directly from the repo files listed
- **README ONLY** — claimed in README/docs but not traced to code
- **OUR IMPLEMENTATION** — what we built in this paper agent (never presented
  as official Circuit behavior)

Branch examined: `main` (tree sha `9663c47615fb9c86291e1b8c4f88dcb5dcb0fe55`).
Module map from `ARCHITECTURE.md` (VERIFIED) and the repo tree.

---

## 1. Current architecture

**VERIFIED IN CURRENT SOURCE** (`ARCHITECTURE.md`, `agent.js`, `lib/`):

Five loops run in parallel; the LLM is only in the loop when needed:

| Loop | Interval (verified) | Role |
| --- | --- | --- |
| `auto-scanner` | every 60 s (`strategy.scanIntervalMs: 60000`) | scan → score → rug check → buy best candidate |
| `position-mon` | every ~5 s (`strategy.positionCheckMs: 5000`) | price fetch → stops / TP / trailing / max-hold → auto-sell |
| `heartbeat` | every 5 min (`heartbeat.intervalMs: 300000`) | status → exception detect → LLM **only if needed** |
| `agent-loop` | every ~90 min (TTL 90 min, refresh every 60 min) | LLM sets session strategy for the next window |
| `reflect` | every 4 h (`reflect.intervalMs: 14400000`) | LLM reviews trades → tunes config → stores lessons |

Supporting layers (all VERIFIED):

- **Scanner** — `lib/auto-scanner.js`: deterministic dip-reversal scorer
  (`lib/scoring.js`, 0–100, 6 components), pre-buy gate, session-strategy
  reader, learned-gate reader, regime-sizing reader.
- **Position monitor** — `lib/monitor.js`: batch price fetch (Circuit
  price-feed, sub-100 ms Geyser reserve prices), stop/TP/trailing/max-hold
  exits, swarm sell-signal early exit.
- **LLM queue** — `lib/processor.js`: file-based queue
  (`data/queue/{incoming,processing,outgoing,dead-letter}`). Telegram chat,
  heartbeat exceptions, agent-loop and reflect all share ONE queue → one LLM
  call at a time.
- **Market-data layer** — `lib/circuit.js` (CIRCUIT Data API, x402 CIRC
  payment), `lib/feedBase.js` (real-time Geyser price feed), `lib/context.js`
  (cached SOL price + Fear & Greed).
- **Execution layer** — `lib/swap.js` (Jupiter Ultra + Jito fast-path),
  `lib/paper-swap.js` (paper mode), `lib/wallet.js`, `lib/circuit-reinvest.js`.
- **Memory** — `lib/memory.js` + `lib/memory/*` (plan-grade, procedural,
  trade-recall, reflection-learner, skill-tracker, chat-extract, episode-recall).
- **Adaptive intelligence** — `lib/analysis/*` (clusterer, regime-detector,
  regime-state, gate-learner, learned-gates, holder-predictor,
  intelligence-generator, approval-queue, adaptive-simulator),
  `lib/regime-sizing.js`, `lib/dca-ecosystem-gating.js`, `lib/ecosystem-intel.js`.
- **Dashboard** — `lib/dashboard.js` + `lib/dashboard.html` (Express server,
  loopback `127.0.0.1:18800`).

**OUR IMPLEMENTATION**: single-process, dependency-free paper agent. Files:
`agentd.js` (engine), `market-data.js` (DexScreener/GeckoTerminal, optional
Circuit price API), `dashboard-api.js` + `dashboard/` (read-only web UI). New
adaptive layer: `performance-analyzer.js`, `regime-detector.js`,
`learned-gates.js`, `adaptive-policy.js`, `reflection-engine.js`,
`strategy-experiments.js`, `market-health.js` — all deterministic, no paid
infrastructure.

---

## 2. Current strategy mechanism

**VERIFIED IN CURRENT SOURCE** (`lib/auto-scanner.js`, `lib/scoring.js`,
`config/agent.json`):

- **What the scanner evaluates**: dip-reversal candidates from the Circuit
  Data API (on-chain OHLCV + RugCheck), optionally momentum (`scoring-momentum`)
  or order-flow (`scoring-flow`) scorers.
- **How candidates are scored**: `scoreDipReversal()` — 6-component model,
  score 0–100. Gates: `minScanScore` (default 55), `minLiquidity` (default
  50 000–80 000), `maxEntry1hDropPct` (−15%), `maxBuyRatioPct` (65% cap on 5m
  buy pressure), plus anti-pump gates (`maxEntry6hGainPct`, `maxEntry24hGainPct`).
- **Which filters are deterministic**: liquidity floor, 1h-drop band, held /
  recently-traded (loss-weighted cooldown 6 h → 72 h) / blacklisted, rug
  DANGER, session buy cap, position cap, circuit breaker (3 consecutive gross
  losses within 60 min → pause 60 min), optional daily loss kill-switch —
  ALL deterministic, no LLM.
- **Which decisions use the LLM**: only the `selective` pre-buy gate
  (`lib/pre-buy-gate.js`, approve/reject per candidate). `active` mode buys the
  top scorer with no per-buy LLM call. `watchOnly` scans but never buys.
- **When strategy settings change**: `agent-loop` writes
  `data/session_strategy.json` every ~90 min (VERIFIED).
- **How settings reach the scanner**: the scanner calls `loadStrategy()` at
  the top of EVERY scan cycle and applies `session.minScoreOverride` →
  `minScanScore`, `session.maxBuysThisSession` → session buy cap,
  `session.patternFilter` → pattern filter, `session.mode` → buy/skip logic
  (VERIFIED in `lib/auto-scanner.js`). If the strategy expired (agent-loop
  missed a cycle) the scanner falls back to `active` + config defaults.

**OUR IMPLEMENTATION**: V1 dip-reversal preserved exactly (score 0–100 from
1h dip + 5m recovery + liquidity + volume; gates: score ≥ 60, 1h ∈
(−35%, +15%], 5m recovery ∈ [+0.25%, +8%], no position, no cooldown, fresh
real price). The adaptive policy layer overrides the same four knobs Circuit
overrides — `minScore`, `maxBuys`, `mode`, and entry size — within hard
bounds. All V1 deterministic filters stay untouched.

---

## 3. Agent-loop mechanism

**VERIFIED IN CURRENT SOURCE** (`lib/agent-loop.js`):

- **Interval**: session TTL = **90 minutes** (`SESSION_TTL_MS = 90 * 60_000`).
  Refresh cadence = 60 min (`REFRESH_INTERVAL_MS = 60 * 60_000`), clamped to
  `min(configured, TTL − 15 min)` so a refresh always lands before expiry.
  Startup schedules the first run ~5 min before expiry (or 2 min if overdue).
- **Inputs** (`buildBrief`): cached market context (Fear & Greed, SOL price,
  swarm), open positions, session stats (buys so far / cap, current mode),
  config pattern filter + operator defaultMode, 7d performance (win rate, avg
  P&L), **regime analysis** (`regime-state.detectRegime` + `strategyForRegime`),
  plan-grade summary (last 5 grades), trade-recall breakdown (exit reasons).
- **LLM role**: ONE tool call (`set_session_strategy`) with fields
  `mode ∈ {active, selective, watchOnly}`, `patternFilter`,
  `minScoreOverride`, `maxBuysThisSession`, `sessionGoal`, `reasoning`.
- **Outputs / allowed strategy changes**: mode, pattern filter, minScore
  override (clamped 10–100), maxBuys (clamped 1–20), session goal/reasoning.
  Buy counter resets to 0 on each new session; `incrementSessionBuy()` is an
  in-memory atomic counter synced to the file (avoids load-modify-save races).
- **Fallback behavior**: LLM unavailable → the current strategy is **extended**
  with the buy counter preserved (cap can't be bypassed by an outage).
  Operator `agentLoop.defaultMode` pins the mode (LLM can't switch out of it).
  Pattern filter is operator-controlled — the LLM no longer narrows patterns.
- **Persistence**: `data/session_strategy.json` (atomic tmp→rename), with
  `expiresAt` TTL. `data/session-context.json` holds cached market context.

**OUR IMPLEMENTATION**: `adaptive-policy.js` — a deterministic session policy
engine (default 90-minute TTL, configurable), producing the same schema:
`{ mode, minScore, maxBuys, strategyVersion, regime, confidence, reason,
 expiresAt }`. No per-buy LLM gate: `selective` = top-1-per-scan + stricter
learned gates (documented difference). Optional async LLM hook
(`CIRCUIT_LLM_URL` + `CIRCUIT_LLM_KEY`) that can reinterpret the brief;
its output is schema-validated and clamped, and it is NEVER on the scan path.
If no LLM is configured the deterministic engine runs (offline-safe).

---

## 4. Reflection mechanism

**VERIFIED IN CURRENT SOURCE** (`lib/reflect.js`, `config/reflect.md`,
`config/agent.json`):

- **Interval**: `reflect.intervalMs` default **4 h** (14 400 000 ms).
  Startup skips a full cycle if the last reflect was < half-interval ago.
- **Trade-history inputs**: `data/trade_history.json` (closed trades),
  `data/positions.json` (open positions), wallet balances.
- **Performance metrics**: 7d + all-time windows — trade count, wins/losses,
  win rate, avg P&L %, total/net P&L SOL, avg hold minutes, best/worst trade,
  exit-reason breakdown. Pushed to the swarm registry.
- **LLM prompt/data**: `config/reflect.md` + a pre-injected wallet/position
  snapshot (the LLM never needs to call `check_wallet`). The LLM can use
  tools: `get_trade_history`, `recall_notes`, `save_note`, `update_config`,
  `check_wallet`, `share_insight`.
- **Configuration changes**: the LLM proposes config changes via
  `update_config`; `reflect.autoApply: true` (default in `agent.json`) means
  suggestions are auto-applied **within safe bounds**; otherwise queued for
  operator approval (Tier 2 approval workflow).
- **Safe bounds**: config changes go through the FIELD_SPEC allowlist
  (`lib/dashboard.js`) and the reflect prompt instructs safe ranges.
- **Lesson persistence**: `save_note` → `data/agent-notes.json`, injected into
  every future prompt (memory system). `data/reflection_log.jsonl` grades
  changes.
- **Auto-apply behavior**: `reflect.autoApply` (true by default) + Tier 2
  approval queue for recommendations from the analysis system.
- **Operator approval**: Tier 2 approval workflow (`approval-queue.js`) —
  recommendations are queued `pending` and the operator approves/rejects in
  the dashboard Intelligence tab.

**OUR IMPLEMENTATION**: `reflection-engine.js` — 4-hour cycle (configurable)
that computes the full metric set, grades expired policy changes, writes
lessons + recommendations + performance snapshots. NEVER edits source code;
config changes are data-driven (policy files) and validated by
`strategy-experiments.js`. `autoApply` defaults **false** until validation
passes (see Stage 12).

---

## 5. Learned-gates mechanism

**VERIFIED IN CURRENT SOURCE** (`lib/analysis/learned-gates.js`,
`lib/analysis/gate-learner.js`, `lib/analysis/clusterer.js`):

- **What data is clustered**: closed trades, keyed by
  `pattern | timeOfDay | liquidityClass` (`_clusterKey`). `timeOfDay` ∈
  morning/afternoon/evening/night; `liquidityClass` ∈ high/medium/low.
- **How clusters are defined**: `clusterer.clusterTrades()` computes per-cluster
  n, wins, losses, win rate, total/avg net P&L, avg hold, std dev,
  confidence (`high` ≥ 10, `medium` ≥ 5, `low` < 5).
- **What gates are learned**: the **buyRatio** cap per cluster (default 65%).
  `gate-learner.learnGates()` simulates thresholds 40–80 and picks the
  threshold maximizing `wins − losses×1.5`.
- **Minimum sample requirements**: cluster `n < 5` → skipped;
  confidence used in recommendations (high→85%, medium→60%, low→40).
- **How confidence is calculated**: `gate-learner` confidence from cluster
  size; `getGateThreshold` only applies a learned gate when
  `confidence ≥ analysis.gateConfidenceThreshold` (default **0.85**).
- **How learned gates reach live scanning**: scanner imports
  `learned-gates.js` and calls `applyLearnedGate(candidate, cfg)` on every
  scan — `data/learned-gates.json` is read on every tick.
- **Fallback behavior**: no file / low confidence → default threshold 65
  (V1 behavior).

**OUR IMPLEMENTATION**: `learned-gates.js` learns entry-threshold deltas
(minScore, 1h-dip band, 5m-recovery band) per cluster
`regime | timeOfDay | liquidityClass` from ACTUAL paper-trade outcomes.
Minimum sample protection: cluster n < MIN_SAMPLES (default 8) →
`INSUFFICIENT_DATA` → V1. Confidence = sample-size-based, and a gate only
applies at `confidence ≥ 0.85` (configurable). Persisted
`data/learned-gates.json`, read on every scan.

---

## 6. Regime detector

**VERIFIED IN CURRENT SOURCE** (`lib/analysis/regime-state.js`,
`lib/analysis/regime-detector.js`):

- **Regimes**: `bull`, `consolidation`, `recovery`, `dump` (+ implicit
  unknown = insufficient data → consolidation).
- **Inputs**: recent closed trades (7d). `detectRegime(trades, cfg)` uses
  win rate + average P&L heuristics:
  - WR > 60% and avg > +2% → **bull** (confidence up to 0.95)
  - WR > 50% and avg > +1% → **bull** (0.70)
  - WR > 40% and avg ≥ −1% → **consolidation** (0.60)
  - WR > 25% but avg < −2% → **recovery** (0.60)
  - WR ≤ 25% or avg < −3% → **dump** (up to 0.95)
  - < 5 recent trades → consolidation with low confidence (0.1–0.3)
- **Classification method**: deterministic heuristics (per-trade regime
  reconstruction uses peak P&L / hold time / exit P&L).
- **Update frequency**: computed during agent-loop ticks (every ~90 min) and
  persisted to `data/regime-state.json` with a **2 h TTL** (`validUntil`).
- **How regime affects strategy** (`strategyForRegime`):
  - bull → `active`, minScore 45, no buy cap
  - consolidation → `selective`, minScore 60, max 2 buys
  - recovery → `watchOnly`, 0 buys
  - dump → `watchOnly`, 0 buys
- **How regime affects position sizing** (`lib/regime-sizing.js`, Tier 7):
  bull **1.5×**, consolidation **1.0×**, recovery **0.3×**, dump **0.0×**
  (multipliers configurable; applied to `entryBudgetSol`).
- **Fallback behavior**: regime file missing/expired → default
  consolidation; sizing fail-open → 1.0×.

**OUR IMPLEMENTATION**: `regime-detector.js` — deterministic, data-driven,
same 4 regimes + explicit **UNKNOWN**. Detection reads the MARKET, never own
P&L (reflexive/laggy): SOL/USD 1h+24h trend off the wSOL pair plus discovery
breadth (% liquid universe, universe size, health gate, discovery failures).
No SOL direction input → **UNKNOWN** → **V1 fallback** (mode active,
minScore 60, no policy changes). Regime persisted to
`data/regime-state.json` with TTL. Sizing multipliers are OUR OWN,
configurable, and capped so the paper size never exceeds 0.05 SOL (see §9).

---

## 7. Reflection learner

**VERIFIED IN CURRENT SOURCE** (`lib/memory/reflection-learner.js`):

- **How configuration changes are tracked**: `logConfigChange(change,
  context, confidence)` appends `{timestamp, field, oldValue, newValue,
  reasoning, context, confidence, gradeAt (+4 h), grade: null}` to
  `data/reflection_log.jsonl` (append-only).
- **How changes are evaluated afterward**: `gradeExpiredChanges(trades, cfg)`
  (called by reflect at cycle start) compares the win rate of trades AFTER
  the change timestamp:
  - afterWinRate > 0.35 → **POSITIVE**
  - afterWinRate < 0.20 → **NEGATIVE**
  - else → **NEUTRAL**
  Grade + afterWinRate + afterAvgPnl + tradeSample are written back into the
  log entry.
- **How successful changes are identified**: `getRecentLessons(limit)` returns
  POSITIVE and NEGATIVE lessons with examples, injected into reflect's
  context.
- **How failed changes are remembered**: NEGATIVE grades stay in
  `reflection_log.jsonl` and are summarized into lessons for future reflects.
- **How repeat failures are prevented**: reflect reads the lessons and is
  instructed not to repeat failed experiments; pruning keeps a 30-day window.

**OUR IMPLEMENTATION**: `reflection-engine.js` — every adaptive change carries
`policyChangeId`, `strategyVersion`, `timestamp`, `parameter`, `oldValue`,
`newValue`, `reason`, `evidence`. Later graded with before/after performance
and classified **STRONGLY_POSITIVE / POSITIVE / NEUTRAL / NEGATIVE /
STRONGLY_NEGATIVE / INSUFFICIENT_DATA** (finer than upstream's 3-way, per the
task spec). Grades persist in `data/reflection_log.jsonl` and block repeat
applications of changes that historically hurt.

---

## 8. Approval system

**VERIFIED IN CURRENT SOURCE** (`lib/analysis/approval-queue.js`,
`lib/analysis/intelligence-generator.js`):

- **Recommendation lifecycle**: `intelligence-generator` produces ranked
  recommendations → `submitForApproval()` appends to `data/approvals.jsonl`
  (append-only) with `id`, `title`, `action`, `priority` (HIGH/MEDIUM/LOW),
  `expectedLift`, `type`, `data`, `status: 'pending'`.
- **Approval states**: `pending → approved | rejected`; after deployment
  `approved → applied | failed`.
- **autoApply behavior**: Tier 2 is operator-in-the-loop; `reflect.autoApply`
  controls the reflect loop's own config suggestions (default true in
  upstream `agent.json`).
- **Operator review**: dashboard Intelligence tab + APIs
  `/api/recommendations/pending`, `/api/recommendations/summary`.
- **Audit logging**: every entry is append-only JSONL with decision
  timestamps + operator notes.
- **Rollback**: upstream has no explicit rollback state machine — revert is
  manual via the config editor (README/docs do not describe an automatic
  rollback path).

**OUR IMPLEMENTATION**: `strategy-experiments.js` — richer lifecycle per the
task spec: **PROPOSED → BACKTESTING → SHADOW → PROMOTED | REJECTED |
ROLLED_BACK**. Append-only `data/approvals.jsonl` + `data/experiments.jsonl`.
`autoApply` default **false** until backtest + shadow validation pass.

---

## 9. Dynamic position sizing

**VERIFIED IN CURRENT SOURCE** (`lib/regime-sizing.js`, `config/agent.json`
`regimeSizing`):

- **Regime-based**: yes (Tier 7). Multipliers per regime, applied to
  `entryBudgetSol`, read on every buy scan.
- **Ecosystem/network health**: yes (Tier 3, `dca-ecosystem-gating.js`) —
  health score + priority fee scale DCA size (`dcaSizeMultiplier` = fee
  multiplier × health multiplier, clamped ≥ 0.5 fee factor).
- **Exact multiplier logic** (VERIFIED defaults): bull 1.5×, consolidation
  1.0×, recovery 0.3×, dump 0.0×. Fail-open 1.0× if regime unavailable.
- **Safety constraints**: `dumpMultiplier` 0.0 pauses entries; multipliers
  are configurable; the dashboard FIELD_SPEC bounds config edits.

**OUR IMPLEMENTATION**: PAPER-ONLY sizing with STRICTER bounds. Base size =
`config.tradeSizeSol` (default 0.05 SOL). Allowed adaptive range
**[0.0125, 0.05] SOL**. Multipliers (OUR OWN, configurable):
bull 1.0 (never upsize above the 0.05 ceiling), consolidation 1.0,
recovery 0.5 (→ 0.025 SOL), dump 0.0 (no entries). Ecosystem/market-health
may further scale down (min 0.0125) but never up. **MAX_TRADE_SIZE = 0.05 SOL
is a hard ceiling — never exceeded.**

---

## 10. Memory

**VERIFIED IN CURRENT SOURCE** (`lib/memory.js`, `lib/memory/*`,
`docs/MEMORY.md`):

- **What lessons are stored**: config-change grades (`reflection_log.jsonl`),
  plan grades, procedural patterns ("morning entries fail" → avoid), trade
  recall (exit-reason breakdown), skill performance, saved notes
  (`data/agent-notes.json`), chat episodes (optional).
- **Where stored**: `data/` files — `reflection_log.jsonl`,
  `agent-notes.json`, `skill_performance.jsonl`, `plan_grades.jsonl`,
  `procedural_history.jsonl`, `session-context.json` etc. Append-only with
  30-day pruning.
- **When read**: notes inject into every LLM session prompt; plan grades and
  trade recall inject into the agent-loop brief; reflection-learner lessons
  inject into reflect context.
- **How lessons influence future decisions**: they bias the LLM's
  `set_session_strategy` and `update_config` decisions; the scanner itself is
  deterministic and only affected through persisted policy/gate/regime files.

**OUR IMPLEMENTATION**: `data/learned-gates.json`, `data/regime-state.json`,
`data/adaptive-policy.json`, `data/strategy-versions.json`,
`data/reflection_log.jsonl`, `data/approvals.jsonl`, `data/lessons.jsonl`,
`data/experiments.jsonl`, `data/shadow-trades.jsonl`,
`data/performance-snapshots.jsonl`. All read back into live decisions at the
exact points Circuit reads its equivalents (scan gates, policy build,
reflection grading).

---

## 11. Backtesting / adaptation

**VERIFIED IN CURRENT SOURCE** (`docs/ANALYSIS.md`,
`lib/analysis/adaptive-simulator.js`, `tests/backtest-with-simulation.js`):

- **How Circuit validates learned strategies**: `adaptive-simulator` replays
  the closed-trade history under three scenarios — **baseline** (all trades),
  **adaptive** (drop clusters with WR < 15% and n ≥ 5), **selective** (only
  high-confidence clusters with WR > 50%). Results on 951 swarm trades:
  baseline 24.0% WR / −0.1297 SOL; adaptive 25.8% / −0.1052 SOL (+18.9%);
  selective 61.5% / −0.0049 SOL (+96.2%).
- **How historical trades are analyzed**: clusterer + regime-stats +
  gate-learner + holder-predictor + intelligence-generator, run offline via
  `npm test -- tests/backtest-with-simulation.js`.
- **Walk-forward / out-of-sample**: NOT present — the backtest is
  retrospective (in-sample) simulation; docs explicitly warn about
  overfitting and recommend A/B validation on live data.
- **How recommendations are generated**: intelligence-generator ranks
  clusters and regimes and emits prioritized recommendations with expected
  lift, then submits them to the approval queue.

**OUR IMPLEMENTATION**: every candidate policy change is backtested against
closed paper trades BEFORE promotion, then runs in **SHADOW** (hypothetical
trades recorded, never executed) before PROMOTED. The backtest stage has two
halves: the in-sample tolerance check AND a purged walk-forward OOS gate —
sequential exit-time folds keep only trades fully contained in-fold
(boundary straddlers purged), and every evaluated fold must clear strict
bars (default: ≥30 total OOS trades, PF>1.2, expectancy%>0 per fold).
In-sample edge that does not repeat out-of-sample never promotes. Operator
approval defaults to manual (autoApply false).

---

## 12. Dashboard

**VERIFIED IN CURRENT SOURCE** (`lib/dashboard.js`, `lib/dashboard.html`,
changelog v0.12.0):

- Tabs: Overview, Config (live-edit with FIELD_SPEC bounds), Positions,
  Scanner, Swarm, **Intelligence** (approval queue / skill performance /
  ecosystem health gauge — Tier 10), Watches, Tasks, Chat, Trades.
- Intelligence-tab APIs: `/api/recommendations/pending`,
  `/api/recommendations/summary`, `/api/skills/performance`,
  `/api/ecosystem/status`.
- Adaptive info exposed: pending/recent approvals, skill grades (advisory,
  INSUFFICIENT_DATA below sample floor), ecosystem health (TPS, validators,
  fees) + anomaly alerts + trading-gating status.

**OUR IMPLEMENTATION**: extends the existing read-only dashboard
(`dashboard-api.js` + `dashboard/`) with a new adaptive panel:
strategy version, mode, regime, adaptive policy, learned gates, last/next
agent-loop, last/next reflection, win rate, expectancy, drawdown, loss/win
streaks, experiments, shadow experiments, policy changes, reflection grades,
lessons, pending approvals, rollback status. The four safety banners
(PAPER TRADING / REAL SOLANA MARKET / WALLET DISABLED / SIGNER DISABLED /
BROADCAST DISABLED) remain always visible.

---

## VERIFIED vs README-ONLY summary

| Claim | Status |
| --- | --- |
| 5 loops + shared LLM queue | VERIFIED (`ARCHITECTURE.md`, `lib/agent-loop.js`, `lib/reflect.js`, `lib/processor.js`) |
| agent-loop every 90 min, refresh 60 min, fallback active | VERIFIED (`lib/agent-loop.js`) |
| reflect every 4 h | VERIFIED (`lib/reflect.js`, `config/agent.json`) |
| regime states + `strategyForRegime` + 2h TTL | VERIFIED (`lib/analysis/regime-state.js`) |
| regime sizing bull 1.5 / cons 1.0 / rec 0.3 / dump 0.0 | VERIFIED (`lib/regime-sizing.js`, `config/agent.json`) |
| learned buyRatio gates, confidence ≥ 0.85, n≥5 | VERIFIED (`lib/analysis/*`) |
| reflection grading POSITIVE/NEUTRAL/NEGATIVE after 4h | VERIFIED (`lib/memory/reflection-learner.js`) |
| approval queue pending/approved/rejected/applied | VERIFIED (`lib/analysis/approval-queue.js`) |
| backtest baseline/adaptive/selective | VERIFIED (`lib/analysis/adaptive-simulator.js`, `docs/ANALYSIS.md`) |
| ecosystem gating TPS/fees/validators | VERIFIED (`lib/ecosystem-intel.js`, `lib/dca-ecosystem-gating.js`) — paid Circuit infra |
| walk-forward / out-of-sample validation | NOT FOUND — backtest is retrospective in-sample (README/docs admit overfitting risk) |
| automatic rollback state machine | NOT FOUND — manual revert via config editor |
| CIRC payment / Jupiter / Jito / wallet | VERIFIED present upstream — **NOT APPLICABLE** to our paper agent (explicitly excluded) |

---

## Appendix — files inspected upstream

`README.md`, `ARCHITECTURE.md`, `docs/ANALYSIS.md`, `config/agent.json`,
`lib/agent-loop.js`, `lib/reflect.js`, `lib/auto-scanner.js`,
`lib/analysis/{clusterer,regime-detector,regime-state,gate-learner,
learned-gates,intelligence-generator,approval-queue,adaptive-simulator}.js`,
`lib/memory/reflection-learner.js`, `lib/regime-sizing.js`,
`lib/dca-ecosystem-gating.js`, `lib/ecosystem-intel.js` (present),
`tests/backtest-with-simulation.js` (referenced in docs), full repo tree via
the GitHub API (commit `9663c47`).