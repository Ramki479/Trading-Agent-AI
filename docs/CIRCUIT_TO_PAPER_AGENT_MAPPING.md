# CIRCUIT → PAPER AGENT MECHANISM MAPPING

Mapping each verified Circuit mechanism to our existing paper agent: what
exists, what must be added, and what must NOT be copied. Every row follows
the same shape:

```
Circuit mechanism
  ↓
Current Circuit implementation (verified — see docs/CIRCUIT_CURRENT_RESEARCH.md)
  ↓
Equivalent component in our agent
  ↓
What needs to be added
  ↓
What must NOT be copied
```

Legend for "Action": **APPLICABLE** = implement in our paper agent;
**APPLICABLE, ADAPTED** = implement with stricter paper-agent bounds;
**NOT APPLICABLE** = do not import (paper-only / paid infra / live-trading).

---

## 1. Scanner

| | |
| --- | --- |
| **Circuit** | `auto-scanner` every 60 s: deterministic scoring (0–100), rug check, pre-buy gate (selective), session-strategy reader, learned-gate reader, regime-sizing reader. |
| **Our agent** | `agentd.js discoveryOnce()` — deterministic V1 dip-reversal scanner, every 60 s (default). |
| **Add** | Adaptive knobs read at scan time: session policy (mode / minScore / maxBuys), learned gates, regime sizing, market-health gate. |
| **Do NOT copy** | RugCheck/blacklist API calls, swarm checks, Jupiter execution. |

**Action: APPLICABLE** — V1 scoring and all eight BUY gates stay byte-identical; only the knobs Circuit itself overrides (minScore, buy cap, mode, size) are layered on top, inside hard bounds.

---

## 2. Agent-loop

| | |
| --- | --- |
| **Circuit** | `lib/agent-loop.js` — every 90 min (TTL), one LLM `set_session_strategy` call → `{mode, patternFilter, minScoreOverride, maxBuysThisSession, sessionGoal, reasoning}`; clamped (minScore 10–100, maxBuys 1–20); fallback extends current strategy; persisted `data/session_strategy.json`. |
| **Our agent** | No equivalent. |
| **Add** | `adaptive-policy.js` — deterministic 90-min session policy (`{mode, minScore, maxBuys, strategyVersion, regime, confidence, reason, expiresAt}`), fallback to V1 on expiry/UNKNOWN, optional async schema-validated LLM hook. |
| **Do NOT copy** | The OpenAI client dependency, tool-call loop, pattern-filter narrowing (operator keeps full pattern control). |

**Action: APPLICABLE** — modes `active` / `selective` / `watchOnly` (same names as upstream). `selective` in our paper agent = top-1-per-scan + stricter learned gates (no per-buy LLM gate — documented difference).

---

## 3. Reflection

| | |
| --- | --- |
| **Circuit** | `lib/reflect.js` — every 4 h; reviews full trade history; win rates by pattern/regime; proposes config changes (auto-apply within safe bounds when `reflect.autoApply`); saves lessons; shares swarm insights. |
| **Our agent** | No equivalent. |
| **Add** | `reflection-engine.js` — 4-h cycle computing the full metric set (win rate, expectancy, profit factor, drawdown, streaks, breakdowns by pattern/regime/score/time/liquidity), producing lessons + recommendations + candidate policy changes; grades previous changes. |
| **Do NOT copy** | Swarm insight sharing, task review, Telegram reports, survival checks tied to real SOL/CIRC balances. |

**Action: APPLICABLE** — never edits source code; every output is a data file + schema-validated candidate that must pass the approval workflow.

---

## 4. Learned gates

| | |
| --- | --- |
| **Circuit** | `lib/analysis/learned-gates.js` + `gate-learner.js` + `clusterer.js` — cluster = `pattern|timeOfDay|liquidityClass`; learns buyRatio threshold per cluster; n ≥ 5 min; confidence ≥ 0.85 to apply; `data/learned-gates.json` read on every scan. |
| **Our agent** | No equivalent. |
| **Add** | `learned-gates.js` — learn minScore / 1h-dip / 5m-recovery thresholds per `regime|timeOfDay|liquidityClass` cluster from actual paper outcomes; min-sample protection (`INSUFFICIENT_DATA` → V1); confidence-gated; `data/learned-gates.json`. |
| **Do NOT copy** | The buyRatio metric (our agent has no buy-pressure feed) — replaced with the three thresholds our V1 strategy actually gates on. Documented as OUR IMPLEMENTATION. |

**Action: APPLICABLE** (dimensions adapted to our data).

---

## 5. Regime detection

| | |
| --- | --- |
| **Circuit** | `lib/analysis/regime-state.js` — bull/consolidation/recovery/dump from 7d win rate + avg P&L heuristics; `strategyForRegime` → mode/minScore/maxBuys; 2 h TTL; `data/regime-state.json`. |
| **Our agent** | No equivalent. |
| **Add** | `regime-detector.js` — deterministic detection from SOL trend (1h/24h off the wSOL pair) + discovery breadth (% liquid, universe size, health gate); explicit **UNKNOWN** on missing direction input; UNKNOWN → V1; persisted `data/regime-state.json`. Deliberately NOT own-PnL-driven (reflexive/laggy). |
| **Do NOT copy** | Per-trade peak-P&L reconstruction (our ledger has no peak tracking) — regime comes from outcomes + market data we actually record. |

**Action: APPLICABLE** (adapted inputs, same regime vocabulary).

---

## 6. Reflection learner (grading)

| | |
| --- | --- |
| **Circuit** | `lib/memory/reflection-learner.js` — logs config changes with `gradeAt +4h`; grades afterWinRate: >0.35 POSITIVE, <0.20 NEGATIVE, else NEUTRAL; lessons; 30-day prune; `data/reflection_log.jsonl`. |
| **Our agent** | No equivalent. |
| **Add** | `reflection-engine.js` grading — before/after performance per policy change; classification STRONGLY_POSITIVE / POSITIVE / NEUTRAL / NEGATIVE / STRONGLY_NEGATIVE / INSUFFICIENT_DATA; repeat-failure memory. |
| **Do NOT copy** | The raw 3-way grade (task spec demands 6-way) and the LLM-driven change proposal. |

**Action: APPLICABLE, ADAPTED.**

---

## 7. Approval workflow

| | |
| --- | --- |
| **Circuit** | `lib/analysis/approval-queue.js` — pending → approved/rejected → applied/failed; `data/approvals.jsonl`; dashboard Intelligence tab; operator-in-the-loop. |
| **Our agent** | No equivalent. |
| **Add** | `strategy-experiments.js` — PROPOSED → BACKTESTING → SHADOW → PROMOTED / REJECTED / ROLLED_BACK; `data/approvals.jsonl` + `data/experiments.jsonl`; autoApply default false. |
| **Do NOT copy** | The "applied" state (upstream applies config directly); we promote policy versions instead. |

**Action: APPLICABLE, ADAPTED.**

---

## 8. Shadow testing

| | |
| --- | --- |
| **Circuit** | No dedicated shadow state machine — backtest simulator (`adaptive-simulator.js`) replays history (baseline vs adaptive vs selective), in-sample. |
| **Our agent** | No equivalent. |
| **Add** | SHADOW phase: candidate policy records hypothetical trades in parallel with real paper trades (win rate, expectancy, profit factor, drawdown, trade frequency comparison); `data/shadow-trades.jsonl`. |
| **Do NOT copy** | Claiming it's upstream behavior — documented as OUR IMPLEMENTATION (upstream has no live shadow loop). |

**Action: APPLICABLE (our own mechanism, explicitly labeled).**

---

## 9. Rollback

| | |
| --- | --- |
| **Circuit** | No automatic rollback state machine (manual revert via config editor). |
| **Our agent** | No equivalent. |
| **Add** | Parent-policy chain in `data/strategy-versions.json` (V1 → V1.1 → V1.2); ROLLED_BACK when a promoted policy performs materially worse (win-rate / expectancy threshold, min sample); rollback NEVER touches safety controls (SL/TP/cooldown/position limit/paper-only). |
| **Do NOT copy** | — (upstream has no mechanism to copy). |

**Action: APPLICABLE (our own mechanism, per task Stage 14).**

---

## 10. Dynamic position sizing

| | |
| --- | --- |
| **Circuit** | `lib/regime-sizing.js` — bull 1.5×, consolidation 1.0×, recovery 0.3×, dump 0.0× (configurable), fail-open 1.0×; applies to entry budget on every buy. |
| **Our agent** | Fixed `tradeSizeSol` (0.05 SOL). |
| **Add** | Regime multiplier applied at BUY time; base 0.05; allowed adaptive range **[0.0125, 0.05]**; multipliers: bull 1.0 (capped), consolidation 1.0, recovery 0.5, dump 0.0 (no entries); market-health can only scale DOWN; **MAX_TRADE_SIZE = 0.05 SOL never exceeded**. |
| **Do NOT copy** | The 1.5× bull upsize — our safety ceiling is the original 0.05 SOL. |

**Action: APPLICABLE, ADAPTED (stricter paper-agent limits).**

---

## 11. Ecosystem / network health gating

| | |
| --- | --- |
| **Circuit** | `lib/ecosystem-intel.js` + `lib/dca-ecosystem-gating.js` — TPS, validators, fees, MEV → health score 0–100; gates entries/DCA when score < 60 or priority fee > 0.001 SOL; fail-open on missing data. |
| **Our agent** | No equivalent. |
| **Add** | `market-health.js` — PAPER-ONLY health proxy from real observable data the agent already fetches (price-source success, SOL-price freshness, discovery feed availability, candidate liquidity/volume quality); score 0–100; gates/shrinks NEW entries only; **never touches exits**. |
| **Do NOT copy** | Paid Circuit on-chain TPS/fees/validator APIs. Documented as OUR IMPLEMENTATION (a free-data equivalent, not upstream's feed). |

**Action: APPLICABLE with a free/public data proxy.**

---

## 12. Memory / persistence

| | |
| --- | --- |
| **Circuit** | `data/` JSON + JSONL files (session_strategy, regime-state, learned-gates, reflection_log, approvals, agent-notes, skill_performance), append-only + 30-day prune. |
| **Our agent** | `portfolio.json`, `trades.jsonl`, `equity-history.jsonl`, `heartbeat.json`, `candidates.json`, `config.json`, `meta.json`, `agent.lock`, `agent.log`. |
| **Add** | `data/learned-gates.json`, `data/regime-state.json`, `data/adaptive-policy.json`, `data/strategy-versions.json`, `data/reflection_log.jsonl`, `data/approvals.jsonl`, `data/lessons.jsonl`, `data/experiments.jsonl`, `data/shadow-trades.jsonl`, `data/performance-snapshots.jsonl` (atomic writes, append-only logs — same crash-safety conventions as the existing agent). |
| **Do NOT copy** | The agent-notes/chat/episode memory (LLM-facing notes are irrelevant to our deterministic engine — lessons live in `lessons.jsonl` instead). |

**Action: APPLICABLE** — only the files that are actually used are created.

---

## 13. LLM boundary

| | |
| --- | --- |
| **Circuit** | LLM in agent-loop + reflect + selective pre-buy gate + chat; tools can read history, save notes, update config, execute builder scripts. |
| **Our agent** | No LLM at all today. |
| **Add** | Optional async LLM hook (`CIRCUIT_LLM_URL` + key): may analyze performance, interpret regime, recommend config changes, generate lessons, evaluate experiments. Outputs schema-validated + clamped. |
| **Do NOT copy** | Any LLM tool that edits source, executes shell/JS, installs packages, or touches wallet/signer/broadcast. No hot-path LLM — scanner never waits. |

**Action: APPLICABLE with a hard boundary — deterministic engine is the default; LLM is an optional, async, validated layer.**

---

## 14. NOT APPLICABLE (explicit exclusions)

| Mechanism | Why not applicable |
| --- | --- |
| Jupiter Ultra execution | Real trading — paper-only agent |
| Jito fast-path / tips | Real trading — paper-only agent |
| Wallet generation / signing | Prohibited by design (meta.json: wallet null, signer null) |
| Broadcast / transaction submission | Prohibited by design |
| CIRC token payment / x402 | Paid infrastructure — our market data is keyless/free |
| Swarm signals / consensus / reputation | Requires the CIRCUIT swarm network |
| RugCheck / blacklist API | Paid Circuit endpoint — paper agent uses free data only |
| Holder-exodus guard (top-5 holder tracking) | Requires paid RPC/API — out of scope for a free-data paper agent |
| Telegram bot / watches / task board | Operator surface beyond this agent's scope |
| Builder skill (agent writes its own code) | Explicitly forbidden by the LLM boundary |

---

## Target architecture (as built)

```
REAL SOLANA MARKET DATA
          │
          ▼
   EXISTING V1 STRATEGY        ← unchanged baseline (score ≥ 60, 1h band,
          │                      5m band, SL −6%, TP +8%, cooldown, max 3/5)
          ▼
   ADAPTIVE POLICY LAYER
          │
     ┌────┼──────────┐
     ▼    ▼          ▼
  REGIME  LEARNED   SESSION
  DETECT  GATES     POLICY
  (+sizing, market-health gate)
     └────┼──────────┘
          ▼
    PAPER EXECUTION          ← 0.05 SOL cap, paper-only
          │
          ▼
      TRADE DATA
          │
     ┌────┴────┐
     ▼         ▼
  90-MIN     4-HOUR
 AGENT LOOP  REFLECTION
     │         │
     └────┬────┘
          ▼
      LEARNING (performance snapshots, grades)
          │
          ▼
  EXPERIMENT / APPROVAL (PROPOSED → BACKTESTING → SHADOW)
          │
          ▼
 PROMOTE / REJECT / ROLLBACK (strategy-versions chain, V1 → V1.1 → …)
```