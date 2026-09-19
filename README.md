# Nifty Monthly 45-DTE Naked Straddle

An algorithmic options trading engine built on Node.js, TypeScript, and Angel One SmartAPI. It executes a systematic, carryforward, single-position short straddle on monthly NIFTY index options, entering at ~45 DTE and exiting at 50% profit, 100% stop-loss, or 21 DTE.

---

## Strategy Overview

- **Instrument:** NIFTY monthly index options (`NFO`).
- **Structure:** Short (naked) ATM CE + short ATM PE (1 lot, same strike, same monthly expiry).
- **Style:** Carryforward (multi-day / multi-week hold), strictly 1 active position at a time (no scaling or averaging).
- **Entry Schedule:** Evaluated once daily at **15:00 IST**:
  1. Checks local store for an open position (if open, proceeds directly to exit/monitoring).
  2. Resolves current monthly expiry dynamically from Angel One scrip master.
  3. Computes calendar-day DTE from today to monthly expiry.
  4. If `DTE === 45`, evaluates the **dual-ATM premium-symmetry check** and enters.
  5. If `DTE !== 45`, no action is taken.
- **Strike Selection (Dual-ATM Symmetry Check):**
  - Fetches Spot LTP and Current-Month Future LTP.
  - Rounds both to nearest strike interval (50).
  - Fetches CE/PE quotes at both ATM strikes and computes `|ceLTP - peLTP|`.
  - Selects the strike with the smaller premium divergence to optimize delta neutrality at entry.
- **Exit Triggers:**
  - **Stop Loss (SL):** Unrealized loss reaches **100%** of combined entry premium received.
  - **Profit Target (PT):** Unrealized profit reaches **50%** of combined entry premium received.
  - **21-DTE Hard Exit:** Forced square-off at **15:00 IST** when 21 calendar days remain to expiry (holiday-adjusted backwards to previous trading day if 21-DTE falls on a holiday or weekend).
- **Risk & Monitoring:** Continuous WebSocket MTM evaluation during market hours, logged to append-only files at `logs/mtm/mtm-NIFTY-{YYYY-MM-DD}.log`.

---

## Core Engineering Principles

Built according to production safety rules established in `blueprint.md`:

1. **Non-Destructive Cleanup (§2.1):** Position state preservation — closed positions maintain historical pricing, P&L, and exit metadata for reports and audits.
2. **Alerted Fallbacks (§2.2):** Risk-critical calculations alert loudly if defaults are ever used.
3. **Independent Control Switches (§2.3):**
   - Soft Pause (`.kill`): Pauses new entries; leaves active position exits and monitoring untouched.
   - Hard Stop (`.panic`): Immediate emergency square-off and total halt.
   - Paper Mode (`.paper`): Simulates execution and ticks without routing orders to broker.
4. **Non-Idempotent Order Guard (§2.4):** Order placement calls are strictly excluded from generic auto-retry to prevent duplicate orders.
5. **Timezone Determinism (§2.5):** All date, calendar, and DTE calculations use `Intl.DateTimeFormat` with `Asia/Kolkata` and explicit `Date.UTC(...)` arithmetic. Docker/PM2 process manager pins `TZ=UTC`.
6. **Append-Only Reporting (§2.6, §1.8):** Daily trade reports at 15:40 IST are generated directly from the immutable intraday MTM log, not from mutable live position memory.
7. **Scrip Master Lot Size Verification (§2.10):** Aggregates contract rows via majority voting; blocks trading and alerts if scrip master diverges from configured lot size.

---

## Project Structure

```text
monthly-straddle/
├── analysis/
│   ├── generateReport.ts        # 15:40 IST daily trade report generator
│   └── reports/                 # Output markdown trade reports (gitignored)
├── logs/
│   └── mtm/                     # Append-only tick logs: mtm-NIFTY-{YYYY-MM-DD}.log
├── src/
│   ├── config/
│   │   └── env.ts               # Typed Zod environment schema
│   ├── helpers/
│   │   ├── api.ts               # Axios client with idempotent retry separation
│   │   ├── constants.ts         # Strategy constants & SmartAPI endpoints
│   │   ├── holidayCheck.ts      # Trading day calendar, DTE, 21-DTE adjuster
│   │   ├── logger.ts            # Winston IST daily rotating logger
│   │   ├── login.ts             # TOTP authentication & session management
│   │   ├── marketData.ts        # LTP fetching & strike rounding
│   │   ├── modeManager.ts       # .paper / .kill / .panic switch manager
│   │   ├── mtmLogger.ts         # Format & write append-only MTM lines
│   │   ├── orders.ts            # Non-idempotent order execution
│   │   ├── scripMaster.ts       # Scrip download, expiry resolution, lot size voting
│   │   └── websocket.ts         # Real-time WebSocket tick stream
│   ├── jobs/
│   │   ├── dailyEntryJob.ts     # 15:00 IST entry & 21-DTE hard exit evaluation
│   │   └── exitMonitor.ts       # Live SL/PT order execution & panic handlers
│   ├── store/
│   │   └── positionStore.ts     # JSON position state store
│   ├── telegram/
│   │   └── bot.ts               # Owner-authenticated bot (/status, /kill, /panic)
│   ├── notifier.ts              # Telegram alerts with Slack webhook fallback
│   ├── server.ts                # Express health check endpoint
│   └── main.ts                  # Cron scheduling & application bootstrap
├── tests/
│   ├── fixtures/                # Fixture MTM logs for smoke tests
│   └── strategy.test.ts         # Core unit & smoke test suite
├── ecosystem.config.cjs         # PM2 configuration with TZ=UTC
├── package.json
└── tsconfig.json
```

---

## Getting Started

### Prerequisites

- **Node.js**: `>= 22.0.0 LTS`
- **pnpm**: `>= 10.0.0`
- **Angel One SmartAPI** account & credentials

### Installation

```powershell
pnpm install
```

### Environment Configuration

Copy the example environment configuration:

```powershell
cp .env.example .env
```

Edit `.env` with your credentials:

```env
PORT=3000
NODE_ENV=production

# Angel One SmartAPI
API_KEY=your_angel_api_key
CLIENT_CODE=your_client_code
CLIENT_PIN=your_client_pin
CLIENT_TOTP_PIN=your_totp_secret

# Telegram
USE_TELEGRAM=true
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Slack (Optional Fallback)
USE_SLACK=false
SLACK_WEBHOOK_URL=

# Strategy Parameters
LOT_SIZE=65
TARGET_DTE=45
HARD_EXIT_DTE=21
PT_PCT_OF_PREMIUM=50
SL_PCT_OF_PREMIUM=100
ENTRY_JOB_HOUR=15
ENTRY_JOB_MINUTE=0
REPORT_HOUR=15
REPORT_MINUTE=40
PAPER_MODE=true
```

> **Note on boolean flags** (`USE_TELEGRAM`, `USE_SLACK`, `PAPER_MODE`): values are parsed explicitly, so `false` correctly disables the flag. Accepted truthy values are `true` / `1` / `yes` / `on`; falsy are `false` / `0` / `no` / `off` (case-insensitive).

---

## Running the Engine

### Development / Paper Trading

Run in watch mode with paper trading enabled:

```powershell
pnpm dev
```

### Build & Production (PM2)

```powershell
pnpm build
pm2 start ecosystem.config.cjs
```

### Health Check

Verify status via HTTP:

```powershell
curl http://localhost:3000/health
```

---

## Telegram Bot Commands

When enabled, the bot allows authenticated control from your specified `TELEGRAM_CHAT_ID`:

| Command    | Action                                                                        |
| ---------- | ----------------------------------------------------------------------------- |
| `/status`  | View current mode (Paper/Live), switch states, and active position metrics    |
| `/kill`    | Activate soft pause (`.kill`): blocks new entries, keeps SL/PT monitor active |
| `/unkill`  | Deactivate soft pause: resumes standard daily entry checks                    |
| `/panic`   | Activate hard stop (`.panic`): immediately squares off open position          |
| `/unpanic` | Deactivates hard stop mode                                                    |

---

## Testing & CI

Run unit tests and reporting smoke test:

```powershell
pnpm test
```

Generate a sample report against fixture data:

```powershell
pnpm smoke-report
```

---

## License

ISC
