# AirClaim Oracle Backend

Production-grade oracle backend for the [AirClaim](../README.md) flight-delay insurance protocol on Celo.

Bridges real-time AviationStack flight data to the on-chain `FlightOracle` and `InsuredFlightsAgency` contracts, maintaining claim eligibility for insured passengers without any manual intervention.

---

## What it does

| Pipeline | Trigger | Action |
|----------|---------|--------|
| **Indexer** | Every 60 s | Fetches `FlightInsured` events from `InsuredFlightsAgency` and populates the `tracked_flight` table |
| **Oracle updater** | Adaptive (3–30 min) | Polls AviationStack for each active flight and calls `FlightOracle.updateFlight()` when status changes |
| **Keeper** | Every 5 min | Calls `InsuredFlightsAgency.checkFlightDelay()` for eligible flights to open passenger claim windows |

All three pipelines are restart-safe via a transactional outbox (PostgreSQL) and never double-submit across process restarts.

---

## Quick start

### Prerequisites

- Node.js ≥ 20
- PostgreSQL 14+
- An [AviationStack](https://aviationstack.com) API key
- A Celo wallet with `UPDATER_ROLE` on the deployed `FlightOracle` contract

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — fill in every REQUIRED field
```

Minimum required fields:

| Variable | Description |
|----------|-------------|
| `CELO_RPC_URL` | Celo RPC endpoint |
| `UPDATER_PRIVATE_KEY` | `0x`-prefixed 32-byte hex private key |
| `FLIGHT_ORACLE_ADDRESS` | Deployed `FlightOracle` address |
| `INSURED_FLIGHTS_AGENCY_ADDRESS` | Deployed `InsuredFlightsAgency` address |
| `AVIATIONSTACK_API_KEY` | AviationStack access key |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/db` |
| `MIN_UPDATER_BALANCE_WEI` | Alert threshold for updater wallet balance |
| `INDEX_FROM_BLOCK` | Contract deployment block (avoids genesis backfill) |

### 3. Run database migrations

```bash
npx prisma migrate deploy
```

### 4. Start the oracle

```bash
# Development (tsx watch — auto-restarts on file change)
npm run dev

# Production (compiled)
npm run build && npm start
```

The process exposes:
- `GET /healthz` — liveness probe
- `GET /metrics` — Prometheus metrics

---

## Docker

```bash
# Build and start the full stack (Postgres + oracle)
cp .env.example .env   # fill in secrets
docker compose up -d

# Tail logs
docker compose logs -f oracle

# Stop (data volume persists)
docker compose down
```

The oracle container runs `prisma migrate deploy` automatically on startup before launching the node process.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    main.ts (bootstrap)                   │
└────────────────────────┬────────────────────────────────┘
                         │ wires
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    Scheduler      HTTP server    Prometheus
   (adaptive)     /healthz        /metrics
          │        /metrics
    ┌─────┼──────────────────┐
    ▼     ▼                  ▼
Indexer  Oracle          Keeper
(60 s)  Updater         (5 min)
(fixed)  (3–30 min
         adaptive)
    │       │                │
    └───────┴────────────────┘
                │
         PrismaRepository
         (PostgreSQL)
                │
    ┌───────────┴───────────┐
    │   tracked_flight      │  one row per insured flight
    │   tx_outbox           │  one row per pending write
    │   indexer_cursor      │  single-row high-water-mark
    └───────────────────────┘
```

### Key design decisions

**Transactional outbox** — every on-chain write is persisted to `tx_outbox` before broadcasting. On restart the process re-reads pending entries and retries, preventing double-submission and data loss.

**Fail-safe mapper** — `mapApiStatus()` returns `Unknown` for ambiguous statuses (`incident`, `diverted`). The oracle holds and alerts rather than writing a guessed status on-chain.

**Adaptive polling** — the oracle interval shrinks from 30 min (pre-departure) to 3 min (in-flight) based on the state of active flights, respecting AviationStack rate limits.

**Idempotent restarts** — state lives in the DB, never in memory. Restarting the process mid-tick is always safe.

---

## Development

### Run tests

```bash
# Unit tests (no DB required)
npm test

# With coverage
npm run test:coverage

# Integration tests (requires DATABASE_URL pointing to a test DB)
DATABASE_URL=postgresql://... npm test
```

### Type-check without building

```bash
npm run typecheck
```

### Prisma schema changes

```bash
# Create a new migration
npx prisma migrate dev --name <description>

# Regenerate the Prisma client after schema changes
npx prisma generate

# Inspect the database
npx prisma studio
```

### DRY_RUN mode

Set `DRY_RUN=true` in `.env` to run the full oracle and keeper pipelines without broadcasting any transactions. All logic executes; chain writes are logged but not sent. Useful for validating configuration against mainnet state.

---

## Module map

```
src/
  config/schema.ts          — zod env validation (loadConfig)
  logger.ts                 — pino structured logger with secret redaction
  main.ts                   — process entry point, DI wiring, graceful shutdown

  interfaces/
    IChainClient.ts         — on-chain read/write abstraction
    IFlightDataProvider.ts  — flight data source abstraction
    IFlightRepository.ts    — persistence abstraction

  chain/
    abis.ts                 — load contract ABIs from artifacts/
    ChainClient.ts          — viem PublicClient + WalletClient, EIP-1559, nonce lock

  providers/
    mapper.ts               — AviationStack status → on-chain enum (safety-critical)
    AviationStackProvider.ts — HTTP client with circuit breaker + retry

  db/
    PrismaRepository.ts     — all DB operations (outbox, flights, cursor)
    FlightTracker.ts        — FlightInsured event indexer

  oracle/
    OracleUpdater.ts        — oracle update pipeline

  keeper/
    Keeper.ts               — keeper checkFlightDelay pipeline

  alerting/
    Alerter.ts              — NoopAlerter / WebhookAlerter / TelegramAlerter / CompositeAlerter

  scheduler/
    Scheduler.ts            — adaptive self-rescheduling loops

  http/
    server.ts               — Fastify /healthz + /metrics

  metrics/
    metrics.ts              — prom-client metric registration

test/
  unit/
    config.test.ts          — zod schema validation
    mapper.test.ts          — exhaustive status mapping
    shouldSubmit.test.ts    — OracleUpdater idempotency guard
    outbox.test.ts          — outbox state machine
    aviationStack.test.ts   — provider normalisation + orchestration
  integration/
    flightLifecycle.test.ts — full lifecycle with real Postgres
```

---

## Environment variables

See [.env.example](.env.example) for the full documented list with defaults.

---

## Operations

See [OPERATIONS.md](OPERATIONS.md) for runbook procedures: startup checks, common alerts, fee bumping, database maintenance, and incident response.
