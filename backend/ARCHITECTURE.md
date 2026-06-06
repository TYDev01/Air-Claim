# AirClaim Oracle Backend — Architecture

## Overview

This service bridges real-world flight data and the AirClaim smart contracts on Celo. It has two
runtime responsibilities:

1. **Oracle updater** — polls AviationStack for active flights, maps API status → on-chain enum,
   and calls `FlightOracle.updateFlight()` only on genuine transitions.
2. **Keeper** — calls `InsuredFlightsAgency.checkFlightDelay()` for tracked flights once they are
   past their scheduled arrival window, opening claims without requiring passenger interaction.

Trust model: this service is the single centralized oracle. Whoever runs it controls the data that
triggers (or withholds) insurance payouts. Security, correctness, and auditability are paramount.
A path to decentralisation (multi-signer updater, Chainlink Functions, etc.) is noted as future work.

---

## Module breakdown

```
backend/
├── src/
│   ├── config/
│   │   └── schema.ts          # zod env schema; boots fail fast on bad config
│   ├── interfaces/
│   │   ├── IFlightDataProvider.ts   # abstraction over AviationStack (swappable)
│   │   ├── IChainClient.ts          # typed viem wrapper for oracle + IFA writes
│   │   └── IFlightRepository.ts     # DB abstraction for tracked flights + outbox
│   ├── providers/
│   │   └── AviationStackProvider.ts # IFlightDataProvider implementation
│   ├── chain/
│   │   └── ChainClient.ts           # viem account + nonce manager + EIP-1559 fees
│   ├── db/
│   │   └── PrismaRepository.ts      # IFlightRepository over Prisma/Postgres
│   ├── oracle/
│   │   └── OracleUpdater.ts         # fetch → map → idempotency → outbox → submit
│   ├── keeper/
│   │   └── Keeper.ts                # checkFlightDelay calls for eligible flights
│   ├── scheduler/
│   │   └── Scheduler.ts             # node-cron wiring + adaptive cadence
│   ├── http/
│   │   └── HttpServer.ts            # Fastify: /healthz + /metrics
│   └── main.ts                      # bootstrap: config → DB → chain → scheduler
├── prisma/
│   └── schema.prisma
├── abis/
│   ├── FlightOracle.json            # copied from hardhat artifacts; never hand-written
│   └── InsuredFlightsAgency.json
├── test/
│   ├── unit/                        # vitest; API + RPC mocked here only
│   └── integration/                 # against Celo fork or Alfajores
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── ARCHITECTURE.md
```

---

## Data model

### Table: `tracked_flight`

Populated by indexing `FlightInsured` events from `InsuredFlightsAgency`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `flight_id` | bytes32 (hex string) | `keccak256(flightIata)` — matches contract |
| `flight_iata` | varchar | e.g. `"ET309"` |
| `flight_date` | date | UTC departure date |
| `origin_iata` | varchar | |
| `dest_iata` | varchar | |
| `scheduled_departure_utc` | timestamptz | from insure event |
| `scheduled_arrival_utc` | timestamptz | estimated; may be null initially |
| `last_submitted_status` | enum | `Scheduled \| Delayed \| Cancelled \| Landed` |
| `last_submitted_delay_minutes` | int | 0 if not delayed |
| `last_submitted_at` | timestamptz | when the last outbox entry was confirmed |
| `is_terminal` | boolean | true once Landed or Cancelled confirmed |
| `keeper_eligible_after` | timestamptz | scheduled arrival + buffer |
| `keeper_last_called_at` | timestamptz | rate-limit against contract cooldown |
| `last_indexed_block` | bigint | high-water-mark for event indexing |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Table: `tx_outbox`

One row per intended on-chain write. Gives restart-safety and idempotency.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `flight_id` | bytes32 | FK → tracked_flight |
| `kind` | enum | `oracle_update \| keeper_check` |
| `intended_status` | enum | for `oracle_update` only |
| `intended_delay_minutes` | int | |
| `status` | enum | `pending \| submitted \| confirmed \| failed` |
| `tx_hash` | varchar | null until submitted |
| `attempts` | int | retry counter |
| `last_error` | text | last failure reason |
| `submitted_at` | timestamptz | |
| `confirmed_at` | timestamptz | |
| `created_at` | timestamptz | |

### Table: `indexer_cursor`

One row, tracks the highest processed block for event indexing.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | always 1 |
| `last_processed_block` | bigint | |
| `updated_at` | timestamptz | |

---

## Polling / scheduling strategy

```
┌─────────────────────────────────────────────────────────────┐
│  Adaptive cadence per flight (evaluated at each tick)       │
│                                                             │
│  > 4 h before departure     →  every 30 min                 │
│  1–4 h before departure     →  every 10 min                 │
│  0–1 h before departure     →  every 5 min                  │
│  In-flight (departed, not   →  every 3 min                  │
│    yet landed)                                              │
│  > 2 h past scheduled arr.  →  every 15 min (fallback)      │
│  Terminal (Landed/Cancelled) → stop polling                  │
└─────────────────────────────────────────────────────────────┘

AviationStack rate limits (documented):
  Free plan    : 100 req/month  — not viable for production
  Basic plan   : 10,000 req/month (~14/hour sustained)
  Professional : 50,000 req/month (~69/hour sustained)

For a fleet of N active flights, the scheduler calculates the
required request budget per hour and logs a warning if it
exceeds plan capacity. Flights are jittered ±10 % to avoid
thundering-herd against the API.

The keeper runs every 60 seconds, checks all non-terminal
flights with keeper_eligible_after ≤ now, and calls
checkFlightDelay if keeper_last_called_at is more than
CHECK_COOLDOWN seconds ago (mirrors the contract's own
throttle to avoid wasted gas).
```

---

## API → on-chain status mapping

| AviationStack `flight_status` | Condition | On-chain `FlightStatus` | `delayMinutes` |
|---|---|---|---|
| `"scheduled"` | — | `Scheduled` (0) | 0 |
| `"active"` | `departure.delay` < threshold | `Scheduled` (0) | `departure.delay \|\| 0` |
| `"active"` | `departure.delay` ≥ threshold | `Delayed` (1) | `departure.delay` |
| `"cancelled"` | — | `Cancelled` (2) | 0 |
| `"landed"` | `arrival.delay` < threshold | `Landed` (3) | 0 |
| `"landed"` | `arrival.delay` ≥ threshold | `Delayed` (1) → then `Landed` (3) | `arrival.delay` |
| `"incident"` | — | `Unknown` — **hold, do not write** | — |
| `"diverted"` | — | `Unknown` — **hold, do not write** | — |
| any other / null | — | `Unknown` — **hold, do not write** | — |
| API error / missing | — | `Unknown` — **hold, alert** | — |

`Unknown` is an internal sentinel that is **never written on-chain**.
If the mapper returns `Unknown`, the updater holds and fires an alert.

The delay threshold (`DELAY_THRESHOLD_MINUTES`) comes from config and must
match the contract's `delayThresholdMinutes` constructor parameter.

---

## Trust & security model

- **Single point of control.** This service is the sole oracle. Key compromise = wrong payouts.
- **Updater private key**: read from env only; never logged; pino `redact` covers all env-derived
  secrets. Document a path to HSM / AWS KMS / GCP Secret Manager in OPERATIONS.md.
- **Boot check**: on startup, verify the configured updater address holds `UPDATER_ROLE` on
  `FlightOracle`. Refuse to start if it doesn't.
- **Chain ID check**: verify `CHAIN_ID` matches the live network. Refuse to start on mismatch.
- **Fail safe, not fail open.** Any ambiguous API response → hold, retry, alert. Never guess.
- **Future hardening path**: multi-sig updater (Gnosis Safe), Chainlink Functions, or a
  decentralised oracle network for the flight data feed.

---

## Failure & alerting strategy

| Condition | Action |
|---|---|
| AviationStack unreachable (3 consecutive failures) | Circuit opens; alert fired; polling pauses for back-off period |
| Mapper returns `Unknown` | Hold; alert with raw API response digest; retry next cadence tick |
| TX submission failure | Retry up to `MAX_TX_ATTEMPTS`; bump gas on stuck tx; alert on max retries |
| Stuck tx (not confirmed in `TX_TIMEOUT_SECONDS`) | Resubmit with bumped `maxFeePerGas`; log old + new hash |
| Updater wallet balance < `MIN_UPDATER_BALANCE_CELO` | Alert immediately; oracle can still submit but will fail when gas runs out |
| Oracle staleness > `STALENESS_ALERT_SECONDS` | Alert — last successful update is too old |
| DB unreachable | Fail fast and exit (systemd/Docker will restart) |
| RPC unreachable | Retry with exponential backoff; alert after N failures; keep scheduler paused |

Alerts are fired to the configured webhook URL (Slack/Discord compatible) and/or Telegram.
At minimum one channel must be configured in production.

---

## Key interfaces (see `src/interfaces/`)

- `IFlightDataProvider` — fetch a single flight's current record; abstraction over AviationStack.
- `IChainClient` — typed reads (`hasUpdaterRole`, `lastOracleStatus`) and writes (`updateFlight`,
  `checkFlightDelay`); manages nonces and EIP-1559 fees internally.
- `IFlightRepository` — CRUD for tracked flights, outbox entries, and the indexer cursor.

---

## Dependency wiring (main.ts order)

1. Load + validate config (zod) → **abort on any error**
2. Connect to DB (Prisma) → health-check
3. Instantiate chain client (viem) → verify chain ID + updater role → **abort on mismatch**
4. Start HTTP server (Fastify) on `HTTP_PORT`
5. Run backfill: index `FlightInsured` events from genesis (or stored cursor)
6. Start scheduler — begins polling and keeping

---

## Scalability notes

For a single-instance deploy handling tens of flights, `node-cron` + Postgres is sufficient.
At hundreds of flights, replace node-cron with **BullMQ** (Redis-backed) for per-flight job queues
with built-in concurrency control, retries, and dead-letter queues. The `IFlightRepository` and
`IFlightDataProvider` interfaces are designed to be implementation-agnostic so this swap is
localized to `Scheduler.ts` and `main.ts`.
