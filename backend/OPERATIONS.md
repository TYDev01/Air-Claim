# AirClaim Oracle Backend — Operations Runbook

This document is for operators running the AirClaim oracle in production.
It covers startup verification, alert response, database maintenance, and incident procedures.

---

## Table of contents

1. [Startup checklist](#1-startup-checklist)
2. [Health and monitoring](#2-health-and-monitoring)
3. [Common alerts and responses](#3-common-alerts-and-responses)
4. [Transaction management](#4-transaction-management)
5. [Database maintenance](#5-database-maintenance)
6. [Scaling and configuration tuning](#6-scaling-and-configuration-tuning)
7. [Incident response](#7-incident-response)
8. [Deployment procedure](#8-deployment-procedure)
9. [Secret rotation](#9-secret-rotation)

---

## 1. Startup checklist

Before starting the oracle in a new environment:

**Wallet**
- [ ] Updater wallet has `UPDATER_ROLE` on `FlightOracle`
  ```bash
  cast call $FLIGHT_ORACLE_ADDRESS "hasRole(bytes32,address)" \
    $(cast keccak "UPDATER_ROLE") $UPDATER_ADDRESS \
    --rpc-url $CELO_RPC_URL
  # Expected: 0x...0000000000000000000000000000000000000000000000000000000000000001
  ```
- [ ] Updater wallet CELO balance ≥ `MIN_UPDATER_BALANCE_WEI`
  ```bash
  cast balance $UPDATER_ADDRESS --rpc-url $CELO_RPC_URL --ether
  ```

**Config**
- [ ] `DELAY_THRESHOLD_MINUTES` matches the contract's `delayThresholdMinutes`
  ```bash
  cast call $FLIGHT_ORACLE_ADDRESS "delayThresholdMinutes()" --rpc-url $CELO_RPC_URL
  ```
- [ ] `CHECK_COOLDOWN_SECONDS` ≥ contract's `checkCooldownSeconds`
  ```bash
  cast call $INSURED_FLIGHTS_AGENCY_ADDRESS "checkCooldownSeconds()" --rpc-url $CELO_RPC_URL
  ```
- [ ] `INDEX_FROM_BLOCK` set to the `InsuredFlightsAgency` deployment block (avoids full-chain scan)
- [ ] Alert channel configured (`ALERT_WEBHOOK_URL` or `TELEGRAM_*`)

**Database**
- [ ] Migrations applied: `npx prisma migrate deploy`
- [ ] Connection reachable from the oracle process

**First-run smoke test**
```bash
DRY_RUN=true npm start
# Should log: "Scheduler started — all loops armed"
# Should log: "Indexer tick — no new flights" (or events if flights exist)
# Should NOT log any FATAL or ERROR entries
```

---

## 2. Health and monitoring

### Liveness endpoint

```bash
curl http://localhost:3000/healthz
# {"status":"ok","service":"airclaim-oracle-backend","uptime":42}
```

Returns `200 ok` when the process is alive.
Returns `503` if unhealthy (future: DB/chain connectivity checks).

### Prometheus metrics

```bash
curl http://localhost:3000/metrics
```

Key metrics to alert on:

| Metric | Alert condition | Meaning |
|--------|----------------|---------|
| `airclaim_oracle_updates_total{outcome="failed"}` | Rate > 0 over 15 min | Oracle tx submissions failing |
| `airclaim_keeper_checks_total{outcome="failed"}` | Rate > 0 over 15 min | Keeper tx submissions failing |
| `airclaim_active_flights` | > 0 and oracle updates = 0 | Oracle stopped processing |
| `airclaim_updater_balance_wei` | < `MIN_UPDATER_BALANCE_WEI` | Wallet running low |
| `airclaim_indexer_last_block` | Not advancing | Indexer stuck (RPC issue) |
| `airclaim_oracle_tick_duration_seconds{quantile="0.99"}` | > 120 s | Oracle tick too slow |

### Recommended Prometheus alert rules (example)

```yaml
groups:
  - name: airclaim
    rules:
      - alert: OracleUpdateFailing
        expr: rate(airclaim_oracle_updates_total{outcome="failed"}[15m]) > 0
        for: 5m
        annotations:
          summary: Oracle update transactions are failing

      - alert: UpdaterBalanceLow
        expr: airclaim_updater_balance_wei < 100000000000000000
        for: 1m
        annotations:
          summary: Updater wallet balance below 0.1 CELO — top up immediately

      - alert: IndexerStuck
        expr: increase(airclaim_indexer_last_block[10m]) == 0
        for: 10m
        annotations:
          summary: Indexer last block not advancing — possible RPC issue
```

---

## 3. Common alerts and responses

### "Oracle UPDATE FAILED for {IATA}"

**Cause:** `ChainClient.updateFlight()` exhausted all retry attempts.

**Response:**
1. Check logs for the specific error:
   ```bash
   docker compose logs oracle --since 1h | grep "UPDATE FAILED"
   ```
2. Common causes:
   - **Nonce mismatch**: Another process used the same wallet. Check for competing txs.
   - **Gas too low**: Celo network congested. Increase `TX_MAX_FEE_GWEI`.
   - **RPC timeout**: Switch `CELO_RPC_URL` to a more reliable provider.
   - **Insufficient balance**: Top up the updater wallet.
3. The failed outbox entry will not retry automatically. After fixing the root cause, restart the process — the outbox entry is in `failed` state and will not block new entries for the same flight.

### "Keeper CHECK FAILED for {IATA}"

Same response as above, substituting `checkFlightDelay` for `updateFlight`.

### "Oracle HOLD for {IATA}: flight_status=incident"

**Cause:** AviationStack reported `incident` or `diverted` — the mapper cannot safely determine the correct payout status.

**Response:**
1. This is intentional fail-safe behaviour. The oracle does not write to the chain.
2. Monitor the flight manually via AviationStack or the airline's status page.
3. If the status resolves (e.g. to `landed`), the oracle will resume automatically on the next tick.
4. If the incident results in cancellation, contact AviationStack support to confirm the `cancelled` status will be reflected in the API.

### "AviationStack request failed (network or circuit open)"

**Cause:** Either a network error or the cockatiel circuit breaker opened after 5 consecutive failures.

**Response:**
1. Check AviationStack API status at https://status.aviationstack.com
2. Check your API key quota in the AviationStack dashboard.
3. The circuit half-opens after 30 seconds and will self-heal if the API recovers.
4. If the outage is prolonged (> 1 hour), no data is written on-chain — the oracle is holding. Flights already on-chain retain their last submitted status.

### "Updater wallet balance below threshold"

**Response:** Top up the updater wallet immediately.

```bash
# Check current balance
cast balance $UPDATER_ADDRESS --rpc-url $CELO_RPC_URL --ether

# Send 1 CELO from a funded wallet
cast send $UPDATER_ADDRESS --value 1ether \
  --private-key $FUNDED_PRIVATE_KEY \
  --rpc-url $CELO_RPC_URL
```

Recommended minimum operating balance: **2 CELO** (enough for ~200 oracle updates at typical gas prices).

---

## 4. Transaction management

### Checking outbox state

```sql
-- Pending entries (not yet submitted)
SELECT flight_id, kind, created_at
FROM tx_outbox WHERE status = 'pending'
ORDER BY created_at;

-- Failed entries in the last 24h
SELECT flight_id, kind, last_error, attempts, created_at
FROM tx_outbox WHERE status = 'failed'
  AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

-- Submitted but not yet confirmed (possible stuck tx)
SELECT flight_id, kind, tx_hash, submitted_at
FROM tx_outbox WHERE status = 'submitted'
  AND submitted_at < NOW() - INTERVAL '10 minutes';
```

### Stuck transactions

If a tx has been `submitted` for more than `TX_TIMEOUT_SECONDS` (default 120 s):

1. The oracle's `_sendWithRetry` loop will automatically resubmit with a bumped fee (`TX_FEE_BUMP_PERCENT`).
2. If the oracle process is not running, manually check the tx on [Celo Explorer](https://celoscan.io):
   ```bash
   cast tx $TX_HASH --rpc-url $CELO_RPC_URL
   ```
3. If the tx is permanently stuck (wrong nonce), restart the oracle — `_nextNonce` re-syncs from `eth_getTransactionCount(pending)` on boot.

### Manually clearing a failed outbox entry

After fixing the root cause, a failed entry can be reset to allow a fresh attempt:

```sql
-- Reset a specific failed entry to pending (triggers retry on next oracle tick)
UPDATE tx_outbox
SET status = 'pending', last_error = NULL, attempts = 0
WHERE id = '<entry-uuid>';
```

> Only do this after confirming the original tx was NOT mined (check the tx hash on-chain first).

---

## 5. Database maintenance

### Archiving confirmed outbox entries

Confirmed outbox entries are kept as an audit trail but can be archived after 90 days:

```sql
-- Archive entries older than 90 days to a separate table (create first)
INSERT INTO tx_outbox_archive
SELECT * FROM tx_outbox
WHERE status = 'confirmed' AND confirmed_at < NOW() - INTERVAL '90 days';

DELETE FROM tx_outbox
WHERE status = 'confirmed' AND confirmed_at < NOW() - INTERVAL '90 days';
```

### Indexer cursor inspection

```sql
-- Check the current indexer position
SELECT last_processed_block, updated_at FROM indexer_cursor;
```

Compare with the current chain tip to estimate lag:
```bash
cast block-number --rpc-url $CELO_RPC_URL
```

### Terminal flight cleanup

Flights with `is_terminal = true` no longer need active processing but are kept for the audit trail. They can be archived after the claim window closes (typically 30 days after the flight date).

```sql
-- Count terminal flights older than 30 days
SELECT COUNT(*) FROM tracked_flight
WHERE is_terminal = true
  AND scheduled_departure_utc < NOW() - INTERVAL '30 days';
```

### Vacuum and index health

Run periodically on the Postgres instance:

```sql
VACUUM ANALYZE tracked_flight;
VACUUM ANALYZE tx_outbox;
```

---

## 6. Scaling and configuration tuning

### AviationStack rate limits

| Plan | Monthly requests | Safe RPH | Recommended `AVIATIONSTACK_MAX_RPH` |
|------|-----------------|----------|-------------------------------------|
| Basic | 10,000 | 13 | 12 |
| Professional | 50,000 | 68 | 60 |
| Business | 250,000 | 342 | 300 |

If you are tracking many flights simultaneously and hitting rate limits, increase your AviationStack plan before increasing `AVIATIONSTACK_MAX_RPH`.

### RPC provider selection

- **Forno** (`https://forno.celo.org`): Free, rate-limited, suitable for low-volume use.
- **Infura / Alchemy / QuickNode**: Recommended for production. Higher rate limits, SLA guarantees.
- For `INDEX_BATCH_SIZE`, tune to your provider's `eth_getLogs` limit (Forno: ~2000; private nodes: up to 10000).

### Multiple oracle instances

Running two oracle instances against the same DB is safe due to the outbox idempotency guard — `createOutboxEntry` returns `null` (no-op) if a pending/submitted entry already exists. Only one instance will submit per flight per tick.

However, both instances share the same updater wallet, so their nonce locks will conflict. **Run only one active instance per wallet in production.**

---

## 7. Incident response

### Oracle process crashed (OOM / unhandled exception)

1. Check the exit reason in container logs:
   ```bash
   docker compose logs oracle --tail 50
   ```
2. Restart the oracle — it is fully restart-safe. The outbox will resume from the last confirmed state.
   ```bash
   docker compose restart oracle
   ```
3. If repeatedly crashing, enable `LOG_LEVEL=debug` and capture a full log before restarting.

### Database connection lost

The oracle will log errors and continue attempting to process flights. Individual ticks that fail DB operations will log at error level and reschedule. The process does not exit on DB errors.

To force a clean reconnect:
```bash
docker compose restart oracle
```

### RPC provider down

The oracle's circuit breaker will open after 5 consecutive failures and half-open every 30 s. No txs are sent while the circuit is open. Flights retain their last on-chain status.

Switch `CELO_RPC_URL` to a backup provider and restart:
```bash
# Update .env then:
docker compose up -d oracle
```

### Wrong DELAY_THRESHOLD_MINUTES

If this does not match the contract's value, the mapper may write incorrect statuses.

**Do not change this value on a running instance with active flights.** The already-submitted statuses were computed with the old threshold and may be inconsistent with a new one. To fix:
1. Stop the oracle.
2. Correct the value in `.env`.
3. Clear all `pending` outbox entries (they have not been submitted yet).
4. Restart the oracle — it will re-evaluate all active flights on the first tick.

---

## 8. Deployment procedure

### Rolling update (no downtime)

1. Build the new image:
   ```bash
   docker build -t airclaim-oracle:new .
   ```
2. Run the new image with `DRY_RUN=true` for 5 minutes to confirm startup:
   ```bash
   docker run --env-file .env -e DRY_RUN=true airclaim-oracle:new
   ```
3. Stop the old container (graceful — waits up to 30 s):
   ```bash
   docker compose stop oracle
   ```
4. Start the new container:
   ```bash
   docker compose up -d oracle
   ```
5. Confirm health:
   ```bash
   curl http://localhost:3000/healthz
   docker compose logs oracle --since 2m
   ```

### Database migration during deployment

Migrations run automatically in the container entrypoint (`prisma migrate deploy`). For destructive migrations (column drops, type changes), follow this sequence:
1. Deploy the code change first with the old schema still active (backward-compatible).
2. Confirm the new code runs correctly.
3. Then apply the destructive migration.

---

## 9. Secret rotation

### Rotating UPDATER_PRIVATE_KEY

1. Generate a new wallet.
2. Grant `UPDATER_ROLE` to the new wallet on `FlightOracle`:
   ```bash
   cast send $FLIGHT_ORACLE_ADDRESS \
     "grantRole(bytes32,address)" \
     $(cast keccak "UPDATER_ROLE") $NEW_UPDATER_ADDRESS \
     --private-key $ADMIN_PRIVATE_KEY \
     --rpc-url $CELO_RPC_URL
   ```
3. Fund the new wallet with ≥ 2 CELO.
4. Update `UPDATER_PRIVATE_KEY` in `.env` (and your secrets manager).
5. Restart the oracle.
6. Confirm the new wallet is used in logs (`updater role verified`).
7. Revoke the old key's role:
   ```bash
   cast send $FLIGHT_ORACLE_ADDRESS \
     "revokeRole(bytes32,address)" \
     $(cast keccak "UPDATER_ROLE") $OLD_UPDATER_ADDRESS \
     --private-key $ADMIN_PRIVATE_KEY \
     --rpc-url $CELO_RPC_URL
   ```

### Rotating AVIATIONSTACK_API_KEY

1. Generate a new key in the AviationStack dashboard.
2. Update `AVIATIONSTACK_API_KEY` in `.env` and your secrets manager.
3. Restart the oracle — no DB changes required.
4. Invalidate the old key in the AviationStack dashboard.

### Rotating DATABASE_URL (password change)

1. Update the Postgres password.
2. Update `DATABASE_URL` and `POSTGRES_PASSWORD` in `.env`.
3. Restart the oracle and Postgres containers:
   ```bash
   docker compose up -d
   ```
