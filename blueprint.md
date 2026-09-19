# Algo Trading Strategy Blueprint

_A reusable blueprint for building expiry/options/equity trading algos on Angel One SmartAPI. Section 1 documents the current strategy. Section 2 is a strategy-agnostic checklist of hard-won engineering rules — carry these into any new strategy built from this blueprint, before writing strategy-specific logic._

---

## 1. Current Strategy — Nifty Monthly 45-DTE Naked Straddle

### Overview

- **Instrument:** NIFTY monthly options only (SENSEX/BANKNIFTY planned later - §1.4).
- **Style:** Carryforward (multi-day/multi-week hold), single position at a time, no scaling/averaging.
- **Structure:** Short (naked) straddle - sell 1 lot ATM CE + 1 lot ATM PE on the same monthly expiry, same strike.
- **Schedule:** One job, once a day, at **15:00 IST**, every trading day:
  1. Check position store for an open position. If one exists -> skip entry, go straight to monitoring/exit logic for that position.
  2. If no open position -> resolve the current monthly expiry and compute its DTE.
  3. If DTE >= 42 (see rounding/holiday note below) -> run the entry sequence and sell the straddle.
  4. If DTE > 45 -> do nothing, exit the job.
- **Expiry resolution:** Always the **monthly** NIFTY expiry (resolve dynamically from the scrip master, never hardcode the expiry weekday). DTE is calculated in **calendar days** from "today" (the 15:00 run date) to that expiry date.
- **One trade per cycle:** Only one straddle is ever open at a time. After an exit (SL, PT, or 21-DTE), no re-entry into the same expiry - the next entry is evaluated against the _next_ monthly expiry's 45-DTE date, following the same daily check.

### Position structure (2 legs)

| Leg | Expiry          | Side | Qty                                                                   | Strike selection             |
| --- | --------------- | ---- | --------------------------------------------------------------------- | ---------------------------- |
| CE  | Current monthly | SELL | 1 lot (`LOT_SIZE`, env-configurable, default 65 - verified per §2.10) | See "Strike selection" below |
| PE  | Current monthly | SELL | 1 lot (`LOT_SIZE`, env-configurable, default 65 - verified per §2.10) | Same strike as CE            |

There are no hedge legs and no ratio structure - this is a pure undefined-risk short straddle. Both legs are always entered together, same strike, same expiry (see §1.2 for partial-fill handling).

### Strike selection - dual-ATM premium-symmetry check

<!-- Goal: pick the strike (spot-ATM or future-ATM) whose CE/PE premiums are closest to each other, so the straddle starts as close to delta-neutral as possible. -->

At entry time (15:00 IST, on a confirmed 45-DTE day):

1. Fetch **spot LTP** and **future LTP** (current monthly future) for NIFTY.
2. Round each to the nearest strike interval (currently 50, verify against scrip master - see rounding function below) -> `spotATM` and `futATM`. These may be the same strike or different strikes.
3. Fetch CE and PE LTP at `spotATM` -> compute `spotDiff = abs(ceLtp_spotATM - peLtp_spotATM)`.
4. Fetch CE and PE LTP at `futATM` -> compute `futDiff = abs(ceLtp_futATM - peLtp_futATM)`.
   - If `spotATM === futATM`, skip step 4 - there is only one candidate.
5. Compare `spotDiff` vs `futDiff`. Sell the CE+PE pair at whichever strike produced the **smaller** difference. On an exact tie, default to `spotATM` (documented, deterministic tie-break).

**Worked example (matches the numbers given):**

- Spot = 24000 -> `spotATM` = 24000. CE = 70, PE = 30 -> `spotDiff` = 20.
- Future = 24200 -> `futATM` = 24200. CE = 55, PE = 45 -> `futDiff` = 10.
- `futDiff` (10) < `spotDiff` (20) -> sell 24200 CE + 24200 PE.

### Strike rounding

```javascript
function roundToNearestStrikeInterval(
  price,
  interval /* e.g. 50 for NIFTY - verify against scrip master, don't hardcode */
) {
  return Math.round(price / interval) * interval;
}
```

### Entry sequence (strict order)

#### Step 1 - Position & DTE check (15:00 IST daily)

- Trading-day check (holiday calendar, §2.5-safe `Intl.DateTimeFormat` logic).
- Read position store. If an open position exists, skip to monitoring (WebSocket loop is already running independently - see §1.6/§1.7) and end this job run.
- If no open position: fetch current monthly expiry date from the scrip master (never hardcode), compute calendar-day DTE from today.
- If `DTE !== 45`, log and exit. No alert needed - this is the normal no-op path most days.

#### Step 2 - Strike resolution (only on a confirmed 45-DTE day)

- Fetch spot LTP and current-month future LTP.
- Run the dual-ATM premium-symmetry check above to pick the entry strike.

#### Step 3 - Order placement (both legs)

- Place SELL orders for CE and PE at the chosen strike, same expiry, `LOT_SIZE` quantity each, simultaneously (both legs are legs of one intended position, not sequenced phases - there is no long/hedge ordering dependency like a ratio structure).
- Confirm fills on both legs before proceeding (see §1.2 for partial fills).

#### Step 4 - Post-entry snapshot

- On confirmed double fill, record: entry timestamp, strike, expiry date, CE entry premium, PE entry premium, combined entry premium (Rs = `(ceLTP + peLTP) * LOT_SIZE`), and derive:
  - `slAmount` = combined entry premium (Rs) - i.e. 100% of premium received.
  - `ptAmount` = 50% of combined entry premium (Rs).
  - `dte21Date` = expiry date minus 21 calendar days (trading-day adjusted, see §1.3.1).
- Start/confirm the WebSocket MTM monitoring loop for this position (§1.7).

### §1.1 No hedge legs - undefined risk (confirmed)

Unlike a hedged ratio structure, this strategy holds **naked short options** with no protective long legs. There is no leg-type mapping table because there are only two legs, both short, same expiry, same strike. The SL is the sole risk control (in addition to the hard 21-DTE time exit) - there is no margin-based hedge to cap tail risk. This must be treated as undefined-risk in margin/kill-switch alerting (§1.6, §2.2): margin utilization can spike sharply on a gap move, and any margin-call alert should be treated as high severity for this strategy.

### §1.2 Partial-entry policy

- Both legs (CE sell, PE sell) must fill for the position to be considered "open." If only one leg fills within the order-placement window:
  - Immediately alert (Telegram primary, Slack fallback) with the filled leg's details.
  - Attempt to fill the missing leg via retry (bounded retry budget, order placement excluded from generic retry per §2.4 - use a dedicated bounded retry specific to entry completion).
  - If the missing leg cannot be filled within the retry budget, **exit the filled leg immediately** (do not carry a naked single-leg position that was never an intended strategy state) and alert loudly that the day's entry aborted.
- A partially-filled-then-unwound day does **not** count as a trade for that expiry; the strategy will attempt entry again the next trading day if DTE is still within a reasonable freshness window (define via env, e.g. re-attempt while `DTE >= 43`, otherwise skip that expiry cycle entirely and wait for the next month - avoid entering deep past the intended 45-DTE window).

### §1.3 Exit rules - 50% premium profit target / 100% premium stop-loss / 21-DTE hard exit

Exit is evaluated on **combined premium in Rs**, not on margin percentage.

#### Baseline (entry premium)

- Captured once, at confirmed double-fill (Step 4 above): `entryPremiumRupees = (ceEntryLTP + peEntryLTP) * LOT_SIZE`.
- This value is immutable for the life of the position - never recomputed from a mutable store field after entry (§2.1). Persist it in the position snapshot at entry time.

#### Thresholds

```
slAmount  = entryPremiumRupees            // 100% of premium received - full loss of premium
ptAmount  = entryPremiumRupees * 0.5      // 50% of premium received
```

| Condition                                                                       | Action                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `unrealizedLossRupees >= slAmount`                                              | Exit both legs immediately (market/limit-with-fallback per §2.4) - stop-loss hit |
| `unrealizedProfitRupees >= ptAmount`                                            | Exit both legs immediately - profit target hit                                   |
| Neither triggered by 21 DTE (or nearest prior trading day, §1.3.1) at 15:00 IST | Exit both legs at whatever P&L stands - time-based exit                          |

**Worked example (matches the numbers given):**

- Entry combined premium = `(ceEntry + peEntry)` points x `LOT_SIZE`.
- SL = 100% of that Rs figure (full premium given back).
- PT = 50% of that Rs figure.
- Example: 50 + 50 = 100 points x 65 = Rs 6,500 entry premium -> SL = Rs 6,500 loss, PT = Rs 3,250 profit.

#### P&L calculation

- `unrealizedPnLRupees = entryPremiumRupees - ((ceCurrentLTP + peCurrentLTP) * LOT_SIZE)`
  - Positive = profit (premium has decayed/moved in our favor since we are short).
  - Negative = loss (combined premium has risen above entry).
- Computed continuously off live WebSocket LTP for both legs (§1.7) - never off stale/cached LTP.
- No "worthless leg" exclusion logic is needed here (unlike a hedged ratio structure) since both legs are always live/tradeable naked shorts until exit; if one leg genuinely goes to a near-zero LTP, it still marks correctly in the combined P&L formula above.

#### Exit execution (SL / PT / 21-DTE)

- On any of the three trigger conditions, exit **both legs together** (buy-to-cover CE and PE).
- Use limit-with-fallback order logic (§2.4-safe - exits are not blindly retried the same way idempotent reads are).
- On confirmed exit fills: record exit timestamp, exit LTPs, realized P&L, exit reason (`SL` / `PT` / `21DTE`), and close the position in the store.
- Send an immediate alert (Telegram primary, Slack fallback) with the exit reason and realized P&L - this is a risk-relevant event per §2.2's alerting bar.

#### Carryforward & monitoring sessions

- Position is held carryforward across all trading days between entry and exit (no intraday-only squareoff).
- Monitoring runs continuously via WebSocket during market hours every day the position is open (§1.7); SL/PT can trigger intraday, any day, not just at the 15:00 job run.
- The 15:00 daily job still runs every day regardless - for an open position, it only performs the 21-DTE check; for no position, it evaluates 45-DTE entry as described above.

#### §1.3.1 21-DTE hard exit (with holiday adjustment)

- Target hard-exit date = expiry date minus 21 calendar days.
- If that date is a market holiday, exit on the **previous trading day** (e.g. 21 DTE falls on a holiday -> exit on 20 DTE), never the next trading day - the intent is "no later than 21 DTE."
- Exit executes at **15:00 IST** on that (adjusted) day, using whatever unrealized P&L stands at that time, unless SL or PT has already triggered intraday before then.

| Position status at 15:00 IST on 21-DTE (or adjusted) day | Action                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| Still open (neither SL nor PT triggered)                 | Exit both legs at market/limit-with-fallback, log reason `21DTE` |
| Already closed earlier (SL or PT already triggered)      | No-op - nothing to do, position already closed                   |

#### §1.3.2 Scheduled job times (IST)

| Time                      | Job                                                  | Details                                                                         |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| 15:00                     | Daily entry/DTE-check job                            | No open position -> check 45-DTE entry; open position -> check 21-DTE hard exit |
| Continuous (market hours) | WebSocket MTM monitor                                | Evaluates SL/PT on every tick while a position is open (§1.7)                   |
| 15:40                     | Daily report (if a trade closed or is open that day) | Reads from `logs/mtm/` append-only log                                          |

### §1.4 Instrument scope & future expansion

- **Current scope:** NIFTY monthly options only, one position at a time.
- **Planned expansion:** SENSEX and BANKNIFTY monthly straddles, run as independent parallel positions once NIFTY is proven live (each gets its own position file per the existing `data/` per-instrument convention).
- Lot size for every instrument must be dynamically verified against the scrip master by majority vote across matching contract rows before any entry - never hardcoded and never taken from a single/last row (§2.10 applies unchanged).

### §1.5 Scheduling

- **15:00 IST daily:** entry/DTE-check job (§1.3.2).
- **Continuous during market hours while a position is open:** WebSocket MTM monitor evaluating SL (100% of premium) / PT (50% of premium).
- **15:40 IST:** daily report generation, if applicable.
- No weekly phased entry cron sequence is needed - this strategy has a single daily decision point plus continuous monitoring.

### §1.6 Kill switch, reporting, margin

- `.paper` / `.kill` / `.panic` switches from §2.3 apply unchanged: `.kill` pauses new entries (the 45-DTE check) without touching the live SL/PT/21-DTE monitor on an open position; `.panic` force-exits the open position immediately regardless of P&L.
- Because this is an **undefined-risk naked structure** (§1.1), margin alerts should be treated as higher-severity than in a hedged structure - alert on any material margin utilization jump, not just on threshold breach, per the "degrade, don't guess" spirit of §2.2.
- Trade reporting is sourced from the append-only MTM log (§1.7), never from live mutable position state (§2.1, §2.6).

### §1.7 MTM log (WebSocket -> file)

#### File naming & location

- `logs/mtm/mtm-NIFTY-{YYYY-MM-DD}.log`, one file per trading day, append-only, rotated daily.

#### Line format (exact)

```
{ISO8601 IST timestamp} | NIFTY | strike={strike} | ceLTP={ceLTP} | peLTP={peLTP} | combinedPremium={combinedPremium} | unrealizedPnL={unrealizedPnL} | pctOfSL={pctOfSL} | pctOfPT={pctOfPT}
```

| Field             | Rule                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `combinedPremium` | `(ceLTP + peLTP) * LOT_SIZE`, rupees                                       |
| `unrealizedPnL`   | `entryPremiumRupees - combinedPremium`                                     |
| `pctOfSL`         | `max(0, -unrealizedPnL) / slAmount * 100`, for at-a-glance risk monitoring |
| `pctOfPT`         | `max(0, unrealizedPnL) / ptAmount * 100`                                   |

#### When to write

- On a fixed cadence (e.g. every 60s) while a position is open and market is live, **plus** immediately on any SL/PT breach (don't wait for the next cadence tick to log a breach).
- No writes when no position is open - omit rather than log zeros.

#### Implementation notes

- Timestamps always IST regardless of process `TZ` (§2.5) - use `Intl.DateTimeFormat` with explicit `Asia/Kolkata`, never rely on server-local time.
- Append-only - never rewritten or truncated intraday.

```javascript
function formatMtmLogLine(date, ceLTP, peLTP, entryPremiumRupees, lotSize, slAmount, ptAmount) {
  const combinedPremium = (ceLTP + peLTP) * lotSize;
  const unrealizedPnL = entryPremiumRupees - combinedPremium;
  const pctOfSL = (Math.max(0, -unrealizedPnL) / slAmount) * 100;
  const pctOfPT = (Math.max(0, unrealizedPnL) / ptAmount) * 100;
  const ts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
  return `${ts} | NIFTY | ceLTP=${ceLTP} | peLTP=${peLTP} | combinedPremium=${combinedPremium} | unrealizedPnL=${unrealizedPnL} | pctOfSL=${pctOfSL.toFixed(1)} | pctOfPT=${pctOfPT.toFixed(1)}`;
}
```

### §1.8 Daily trade report (15:40 IST - from MTM log)

- Report reads from `logs/mtm/mtm-NIFTY-{date}.log` (append-only), never from live mutable position state.
- **Input (required):** the day's MTM log file. If missing (no position was open that day), skip report generation - not an error.
- **Input (supplementary, static only):** entry snapshot (strike, expiry, entry premium, SL/PT amounts, DTE at entry) - used only for header context, never for P&L math itself (that comes from the MTM log).
- **Report content (minimum):** entry details, latest combined premium, unrealized/realized P&L, % of SL and PT consumed, exit reason if closed that day, DTE remaining to expiry and to the 21-DTE hard-exit date.
- **Output:** `analysis/reports/{YYYY-MM-DD}-nifty-straddle.md`; visibility (public/private/gitignored) decided explicitly per §2.8.
- **Scheduling:** runs at 15:40 IST, after the 15:00 entry/exit job and after market close, so same-day exits are reflected. A CI smoke test should render this report against a fixture MTM log (§2.9).

---

## 2. Core Engineering Principles — Apply to Every New Strategy

These are not strategy-specific. Each one maps to a real incident already hit while building this bot — read the "why" once, then treat it as a non-negotiable default for any future algo built from this blueprint.

### 2.1 Never let cleanup destroy data another process still needs

**Why:** `positionStore.clear()` was fixed to zero out `entryMargin` (correctly, to stop stale legs lingering). But the post-expiry report generator reads that same file 20 minutes later and now silently computes "Return on Margin" against 0.
**Rule:** Before any store/state "clear" or "reset" operation, ask _who else reads this state after I clear it?_ If a downstream job (reporting, reconciliation, audit) depends on post-trade values, either (a) write an immutable snapshot/log entry _before_ clearing, or (b) have downstream consumers read from an append-only log, never from the same mutable file the live process clears. Cleanup and reporting must never share a single mutable source of truth.

### 2.2 Fallback values are a production incident waiting to happen — never let them be silent

**Why:** The margin API was broken for ~2 weeks of live trading (a missing required field caused every call to fail), and the bot silently traded on a hardcoded ₹3,50,000 fallback margin the entire time, with no one aware until the reports were reviewed after the fact.
**Rule:** Any fallback/default value that feeds into a risk calculation (SL, margin, position sizing, entry price) must:

- Trigger an explicit alert every time it's used, not just a log line.
- Be visually distinguishable in every downstream report/status output (e.g. `₹3,50,000 (fallback)` never bare `₹3,50,000`).
- Have a retry budget before falling back at all — and the retry failure itself should be alerted, since a repeatedly-failing API call is itself the real signal.
- Be treated as a "degrade, don't guess" trigger where possible: consider blocking entry entirely rather than trading on fabricated numbers, if the risk math is safety-critical.

### 2.3 Separate "pause new activity" from "stop everything, no exceptions"

**Why:** An earlier single kill switch paused entries _and_ exits _and_ monitoring together — meaning the safety net (stop-loss) could be accidentally disabled by the same switch meant to just pause new trades.
**Rule:** Every algo needs at least two independent switches:

- A **soft pause** (blocks new entries only) — the default, low-risk lever.
- A **hard stop** (blocks exits/monitoring too) — reserved, clearly named (`/panic`, not `/kill`), and never the first thing reached for mid-trade.
  Never conflate these into one flag, and never let the "obvious" command name (`/kill`, `/stop`) map to the more dangerous behavior.

### 2.4 Order placement must never be blindly auto-retried

**Why:** A generic retry-with-backoff wrapper was applied to every API call including order placement. If a placed order succeeds broker-side but the HTTP response drops/times out, blind retry would submit a duplicate live order.
**Rule:** Classify every external call as **idempotent** (safe to retry: quotes, margin, LTP, scrip master) or **non-idempotent** (never blind-retry: order placement, any "do a thing" mutation). Non-idempotent calls should either skip retry entirely, or check the broker's order/trade book for an existing matching order before resubmitting.

### 2.5 Timezone logic must not depend on the host machine's config

**Why:** An early IST-date trick (`new Date(date.toLocaleString('en-US', {timeZone:'Asia/Kolkata'}))`) only worked correctly if the server's own OS timezone happened to be UTC — an implicit, unverified assumption.
**Rule:** Use `Intl.DateTimeFormat` + explicit `Date.UTC(...)` reconstruction for all "what day/date is it in IST" logic (never the `toLocaleString` round-trip). Additionally, pin `TZ=UTC` explicitly in the process manager config (`ecosystem.config.cjs` env block) as a second, independent safety layer — don't rely on either fix alone.

### 2.6 Reports and audit trails must read from append-only data, not live mutable state

**Why:** Because the report generator reads the same file the live trading logic clears (§2.1), report accuracy is hostage to trading-code timing, not a report-code decision.
**Rule:** Any "what happened" artifact (post-trade report, MTM history, audit log) should be built from its own independent, append-only log written incrementally during the day — never reconstructed after the fact from the current value of live/mutable state. Snapshot early and often; read snapshots, not live state, when generating summaries.

### 2.7 Verify every broker endpoint before trusting it in production

**Why:** On initial go-live, the login endpoint, scrip master URL, spot-quote endpoint, and WebSocket host were all outright wrong (old/deprecated paths) — not edge cases, just untested assumptions that only surfaced once real traffic hit them.
**Rule:** Before a new strategy or a new broker integration goes live, do a dry-run checklist against real (paper-mode-safe) calls to every endpoint the strategy touches: auth, quote/LTP, margin, order placement, WebSocket connect. Don't assume an endpoint copied from an old strategy or from docs is still current — hit it once in paper mode first.

### 2.8 Decide deliberately what trading data becomes public

**Why:** Automated post-expiry reports (real spot prices, strikes, quantities, P&L, margin) get committed straight to a public GitHub repo every expiry day as a side effect of the CI pipeline, with no explicit decision ever made about it.
**Rule:** Before wiring any automated commit-based reporting/logging pipeline, explicitly decide the visibility of the output (public repo, private repo, or gitignored entirely) as a deliberate step — not as an accidental default of "the pipeline already commits things."

### 2.9 Keep report-generation code changes independent of trading-logic changes

**Why:** The report generator's field-reading logic went stale relative to trading-code changes without anyone noticing (§2.1), and at least one report was manually hand-written with a different schema after the automated pipeline apparently failed silently for a day.
**Rule:** Whenever trading-logic state shape changes (new fields, cleared fields, renamed fields), grep every consumer of that state file — reports, dashboards, Telegram `/status` — in the same change, not as a follow-up. Add a smoke-test that renders a full end-of-day report against fixture data as part of CI, so a broken report is caught before it silently produces wrong numbers for weeks.

### 2.10 Never hardcode lot size — verify it dynamically against the scrip master, and never trust a single row

**Why:** NSE/BSE revise index lot sizes periodically (a live example: Nifty's lot size has changed more than once in recent years), and the scrip master itself contains one row per contract (every strike × every expiry) — naively looping and overwriting `lotSizes[name] = row.lotsize` on every match means the final value is just whatever row happened to be _last_ in the array that day, not a verified value. This is exactly how a "vague" or wrong lot size (e.g. a stray `75` instead of the real `65`) sneaks in silently.
**Rule:**

- Never hardcode lot size as a bare constant and trust it forever (`INDEX_CONFIGS.NIFTY.lotSize = 65` must be treated as a _default to verify_, not a fact).
- When deriving lot size from the scrip master, aggregate across **every matching contract row** for that index and take the **majority value**, not the last-seen value. If more than one distinct lot size appears across the day's contracts for the same index, that disagreement itself is the signal — log/alert it loudly rather than silently picking one.
- Reconcile the derived value against the hardcoded config at startup (and ideally on the 08:30 AM scrip-master-refresh cron too — see §1 step 1). If they disagree, **block entry and alert**; don't quietly trade with a lot size no one has verified for today.
- Skip/discard any row where `lotsize` fails to parse as a positive integer — don't let a single malformed row corrupt the aggregate.

```javascript
// Aggregate lot sizes across ALL matching contract rows — never overwrite with the last one seen.
function extractLotSizes(instruments, targetIndices) {
  const freq = {}; // { NIFTY: { 65: 412, 75: 1 } }

  for (const item of instruments) {
    if (
      item.exch_seg === 'NFO' &&
      (item.instrumenttype === 'FUTIDX' || item.instrumenttype === 'OPTIDX') &&
      targetIndices.includes(item.name)
    ) {
      const lot = parseInt(item.lotsize, 10);
      if (!Number.isFinite(lot) || lot <= 0) continue; // discard malformed rows, don't let them win

      freq[item.name] = freq[item.name] || {};
      freq[item.name][lot] = (freq[item.name][lot] || 0) + 1;
    }
  }

  const resolved = {};
  for (const [name, counts] of Object.entries(freq)) {
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [majorityLot, majorityCount] = ranked[0];
    const total = ranked.reduce((sum, [, c]) => sum + c, 0);

    resolved[name] = parseInt(majorityLot, 10);

    if (ranked.length > 1) {
      // Disagreement across contracts for the same index — this is the real finding, alert on it.
      console.warn(
        `Lot size disagreement for ${name}: ${JSON.stringify(counts)} — using majority ${majorityLot} (${majorityCount}/${total} contracts). Verify before trading.`
      );
    }
  }
  return resolved;
}

// At startup / on scrip-master refresh: reconcile against the hardcoded config, don't just log and move on.
function verifyLotSizeOrBlock(symbol, derivedLotSize, configuredLotSize, sendAlert) {
  if (derivedLotSize !== configuredLotSize) {
    sendAlert(
      `🚨 Lot size mismatch for ${symbol}: scrip master says ${derivedLotSize}, config says ${configuredLotSize}. Entry blocked until resolved.`
    );
    return false; // block entry for this symbol until config is corrected
  }
  return true;
}
```

---

## 3. Project Stack, Structure & Environment (Reference)

### Stack

| Concern         | Choice                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- |
| Runtime         | Node.js >= 22 LTS                                                                            |
| Language        | TypeScript (strict), ES modules                                                              |
| Package manager | pnpm                                                                                         |
| Framework       | Express (health check endpoint only)                                                         |
| Broker          | Angel One SmartAPI                                                                           |
| TOTP            | `otplib`                                                                                     |
| Scheduling      | `node-cron`                                                                                  |
| Telegram Bot    | `telegraf`, polling mode, owner-only auth middleware (§2.3 applies to its commands)          |
| Slack Backup    | Incoming Webhook fallback                                                                    |
| Logging         | Winston (daily rotated files, IST timestamps) + WebSocket-driven MTM append log (§1.7, §2.6) |
| Persistence     | Local JSON files, one position file per index/instrument                                     |
| Switches        | `.paper` (paper mode), `.kill` (soft pause), `.panic` (hard stop) — see §2.3                 |
| Testing         | Jest + ts-jest, coverage enforced on core modules; add a report-fixture smoke test (§2.9)    |
| Env             | `.env` via `dotenv`, no `process.env` access outside `src/config/env.ts`                     |
| Process manager | PM2, with `TZ=UTC` pinned explicitly (§2.5)                                                  |

### Structure

```
<strategy-name>/
├── src/
│   ├── server.ts                # Express health route
│   ├── config/env.ts            # dotenv validation + typed config
│   ├── store/                   # Position/session/config state (mutable, live)
│   ├── helpers/
│   │   ├── constants.ts         # Per-instrument config (lot size, strike step, tokens)
│   │   ├── api.ts               # axios wrapper: real IP/MAC, timeout, throttle, retry (idempotent calls only — §2.4)
│   │   ├── login.ts             # TOTP + session login
│   │   ├── holidayCheck.ts      # Timezone-safe (§2.5) expiry/trading-day logic
│   │   ├── scripMaster.ts / marketData.ts / websocket.ts / orders.ts
│   │   └── modeManager.ts       # .paper / .kill / .panic switches (§2.3)
│   ├── jobs/                    # Entry, exit/monitor, MTM logger (§1.7 — append-only, WebSocket-driven)
│   ├── telegram/bot.ts          # Owner-only auth middleware, mirrors switch semantics
│   ├── notifier.ts              # Telegram primary + Slack fallback
│   └── main.ts                  # Cron registration
├── analysis/
│   ├── generateReport.ts        # 15:40 job — reads logs/mtm/mtm-{index}-{date}.log (§1.8)
│   └── reports/                 # Output markdown; visibility per §2.8
├── logs/
│   └── mtm/                     # mtm-{index}-{YYYY-MM-DD}.log — §1.7
└── data/                        # Position state, config, cached scrips
```

### Environment Variables

```env
PORT=3000
NODE_ENV=production

# Broker Credentials
API_KEY=
CLIENT_CODE=
CLIENT_PIN=
CLIENT_TOTP_PIN=

# Telegram
USE_TELEGRAM=true
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=       # also the sole authorized command sender — §2.3

# Slack
USE_SLACK=false
SLACK_WEBHOOK_URL=
SLACK_SIGNING_SECRET=

# Strategy-specific toggles (Nifty Monthly 45-DTE Naked Straddle — §1)
LOT_SIZE=65                   # §1.4/§2.10: default only — always reconcile against scrip master, block entry on mismatch
TARGET_DTE=45                 # §1: DTE at which entry is evaluated daily
HARD_EXIT_DTE=21              # §1.3.1: latest DTE to force-close if SL/PT not hit (holiday-adjusted to nearest prior trading day)
PT_PCT_OF_PREMIUM=50          # §1.3: profit target as % of entry combined premium
SL_PCT_OF_PREMIUM=100         # §1.3: stop-loss as % of entry combined premium (full premium given back)
ENTRY_JOB_HOUR=15             # §1.3.2: daily entry/DTE-check job time
ENTRY_JOB_MINUTE=0
REPORT_HOUR=15                # §1.8: IST time for post-close markdown report
REPORT_MINUTE=40
# ENABLE_SENSEX=false          # future — do not implement until §1.4 expanded
# ENABLE_BANKNIFTY=false       # future — do not implement until §1.4 expanded
```

---

## 4. Pre-Launch Checklist (for any new strategy built from this blueprint)

- [ ] Every broker endpoint hit at least once in paper mode (§2.7)
- [ ] Every fallback value feeding risk math sends an explicit alert and is labeled as fallback in all output (§2.2)
- [ ] Order placement calls are excluded from generic retry (§2.4)
- [ ] Soft pause and hard stop are separate switches with separate names (§2.3)
- [ ] All date/day-of-week logic uses `Intl.DateTimeFormat`, and `TZ=UTC` is pinned in the process manager config (§2.5)
- [ ] Reports/audit trails read MTM time-series from `logs/mtm/` append-only files (§1.8), not live mutable state (§2.1, §2.6)
- [ ] A CI smoke test parses a fixture MTM log and renders a report (§2.9, §1.8)
- [ ] Visibility of any auto-committed trade data (public/private repo) has been explicitly decided, not defaulted (§2.8)
- [ ] Lot size per instrument is verified against the scrip master by majority vote across all matching contract rows, not hardcoded and never taken from a single/last row — entry blocks and alerts on mismatch (§2.10)
