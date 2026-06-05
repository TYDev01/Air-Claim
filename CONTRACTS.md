# AirClaim — Contract Architecture

> **Target network:** Celo mainnet (chainId 42220).  
> All price-feed and stablecoin addresses are injected at construction; nothing is hardcoded in source.

---

## 1. Interfaces

### `IFlightOracle` (`contracts/interfaces/IFlightOracle.sol`)

Read-only interface consumed by `InsuredFlightsAgency`.

| Item | Detail |
|---|---|
| `FlightStatus` enum | `Scheduled` / `Delayed` / `Cancelled` / `Landed` |
| `FlightRecord` struct | `status`, `delayMinutes` (uint32), `source` (string), `updatedAt` (uint64) |
| `getFlightRecord(bytes32)` | Returns full record; `updatedAt == 0` → never written |
| `getDelayMinutes(bytes32)` | Convenience: delay in minutes |
| `getStatus(bytes32)` | Convenience: current status enum |
| `FlightStatusUpdated` event | Emitted on every authorised write |

**Key:** `flightId` is `keccak256(abi.encodePacked(flightIdentifierString))` — callers must hash consistently.

---

### `IRandomnessSource` (`contracts/interfaces/IRandomnessSource.sol`)

Single seam for all game randomness. Default implementation: `CommitRevealRandomness`.

| Item | Detail |
|---|---|
| `commit(bytes32)` | Operator stores `keccak256(operatorSeed)` before player acts; returns `requestId` |
| `revealAndConsume(uint256, bytes32, bytes32)` | Operator reveals pre-image; combined with user entropy → final seed |
| `isPending(uint256)` | True if committed and not yet consumed |
| `getCommitment(uint256)` | Returns stored commitment |
| `Committed` / `Revealed` events | Audit trail |

**Why not VRF / PREVRANDAO?** Chainlink VRF is unavailable on Celo. PREVRANDAO is constant across multiple Celo L2 blocks (sourced from L1), exploitable for staked play. Commit–reveal ensures neither party alone controls the outcome.

---

### `AggregatorV3Interface` (Chainlink — imported from `@chainlink/contracts`)

Used by `InsuredFlightsAgency` to convert CELO amounts to stablecoin units.

| Key function | Purpose |
|---|---|
| `latestRoundData()` | Returns `roundId`, `answer`, `startedAt`, `updatedAt`, `answeredInRound` |
| `decimals()` | Feed precision — read dynamically, never assumed to be 8 or 18 |

**Production safety checks applied on every read:**
- `answer > 0`
- `updatedAt != 0` and not older than the configured staleness window
- `answeredInRound >= roundId`
- Decimals read from feed and used to scale correctly

**Sequencer uptime:** Celo does not currently have a Chainlink L2 Sequencer Uptime Feed published (checked June 2026). Strict staleness checks are therefore the primary freshness guard. This is flagged — if a sequencer feed is deployed on Celo before mainnet launch, it should be integrated and the grace period enforced.

---

## 2. Contracts

### `FlightOracle.sol` (implements `IFlightOracle`)

| Aspect | Detail |
|---|---|
| Storage | `mapping(bytes32 => FlightRecord) private _records` |
| Access control | `AccessControl`: `DEFAULT_ADMIN_ROLE` (owner), `UPDATER_ROLE` (off-chain relay) |
| Write function | `updateFlight(bytes32 flightId, FlightStatus, uint32 delayMinutes, string source)` — `UPDATER_ROLE` only |
| Role rotation | Admin can `grantRole` / `revokeRole` the updater without redeployment |
| Events | `FlightStatusUpdated(flightId, status, delayMinutes, updatedAt)` |
| Inherits | `AccessControl` |

**Wiring:** deployed independently; its address is passed to `InsuredFlightsAgency` constructor.

---

### `InsuredFlightsAgency.sol`

The core insurance contract. Manages premiums, delay confirmation, and payouts.

| Aspect | Detail |
|---|---|
| Constructor args | `oracle` (IFlightOracle), `priceFeed` (AggregatorV3Interface, immutable), `stablecoin` (IERC20, immutable), `delayThresholdMinutes`, `baseFee` |
| Premium | 10% of each passenger's ticket price + `baseFee` per passenger; collected in native CELO on `insureFlight` |
| `insureFlight(...)` | Creates a policy with auto-incrementing `policyId`; stores per-passenger ticket prices and claim flags |
| `checkFlightDelay(bytes32 flightId)` | Reads oracle; if `delayMinutes > threshold`, marks flight claimable; rate-limited (min interval between calls per flight) |
| `claimInsurance(bytes32 flightId)` | Checks: flight not Scheduled, caller insured, threshold met, not already claimed → pays 10% of caller's ticket price |
| Payout logic | If stablecoin balance covers the CELO-denominated payout (converted via price feed), pay stablecoin via `SafeERC20`; otherwise pay native CELO |
| Price feed guard | Reverts on stale / zero / negative / incomplete round; falls back to native CELO if feed unusable |
| Reserve protection | Owner withdrawal limited to `address(this).balance - _reservedForClaims` |
| Inherits | `ReentrancyGuard`, `Pausable`, `Ownable` |
| Events | `FlightInsured`, `DelayConfirmed`, `InsuranceClaimed` |

---

### `CommitRevealRandomness.sol` (implements `IRandomnessSource`)

| Aspect | Detail |
|---|---|
| Storage | `mapping(uint256 => bytes32) _commitments`, `mapping(uint256 => bool) _consumed`, `uint256 _nextRequestId` |
| `commit(bytes32)` | Only callable by authorised operators; stores commitment; emits `Committed` |
| `revealAndConsume(...)` | Verifies `keccak256(operatorSeed) == commitment`; final seed = `uint256(keccak256(abi.encodePacked(operatorSeed, userEntropy, block.number)))`; marks consumed |
| Access control | `Ownable`; operator whitelist managed by owner |
| Inherits | `Ownable` |

**Wiring:** deployed once; its address is injected into `LuckySpin` and `BattleShip` constructors.

---

### `LuckySpin.sol`

| Aspect | Detail |
|---|---|
| Entry | Player submits 5 distinct numbers in [1, 20] + stake in native CELO (≤ cap) + `requestId` from a committed randomness request |
| Randomness | Calls `IRandomnessSource.revealAndConsume`; derives 5 distinct drawn numbers from the seed |
| Payouts | 3 matches → ×5 stake, 4 → ×10, 5 → ×25; < 3 → nothing |
| House check | Rejects bet if `address(this).balance < stake × 25` before accepting |
| Inherits | `ReentrancyGuard`, `Ownable`, `Pausable` |
| Events | `SpinPlaced`, `SpinResult` |

---

### `BattleShip.sol`

| Aspect | Detail |
|---|---|
| Entry | Player picks a box in [0, 15] + stake in native CELO (≤ cap) + `requestId` |
| Randomness | Calls `IRandomnessSource.revealAndConsume`; drop box = `seed % 16` |
| Payout | Correct prediction → 2× stake; wrong → nothing |
| House check | Rejects bet if `address(this).balance < stake × 2` |
| Inherits | `ReentrancyGuard`, `Ownable`, `Pausable` |
| Events | `BattlePlaced`, `BattleResult` |

---

## 3. Wiring Diagram

```
                         ┌──────────────────────────┐
                         │   CommitRevealRandomness  │
                         │   (IRandomnessSource)     │
                         └───────────┬──────────────┘
                                     │ IRandomnessSource
                    ┌────────────────┴────────────────┐
                    │                                  │
             ┌──────▼──────┐                  ┌───────▼──────┐
             │  LuckySpin  │                  │  BattleShip  │
             └─────────────┘                  └──────────────┘

                         ┌──────────────────┐
                         │   FlightOracle   │◄── UPDATER_ROLE (off-chain relay)
                         │  (IFlightOracle) │
                         └────────┬─────────┘
                                  │ IFlightOracle
                         ┌────────▼─────────────────────┐
                         │    InsuredFlightsAgency       │
                         │                               │
                         │  ◄── AggregatorV3Interface ──►│ Chainlink CELO/USD feed
                         │  ◄── IERC20 (stablecoin)   ──►│ cUSD / USDC / USDₜ
                         └───────────────────────────────┘
```

---

## 4. External addresses (injected per network — never hardcoded in source)

| Item | Mainnet resolution |
|---|---|
| Chainlink CELO/USD feed | Resolve from `https://docs.chain.link/data-feeds/price-feeds/addresses?network=celo`; confirm on celoscan before deploy. **Do not commit an unverified literal.** |
| cUSD stablecoin | `0x765DE816845861e75A25fCA122bb6898B8B1282a` (Mento cUSD on Celo mainnet — confirm on celoscan) |
| USDC on Celo | Available; address injected via config |

All addresses live in `scripts/config/networkConfig.ts`, not in contract source.

---

## 5. Assumptions and open questions

1. **Sequencer uptime feed:** No Chainlink L2 Sequencer Uptime Feed is currently published for Celo. Strict staleness checks (`updatedAt` freshness window) are the primary guard. If a sequencer feed is deployed before mainnet launch, `InsuredFlightsAgency` should integrate it — flag this for review before deploy.
2. **`flightId` hashing:** All callers must apply `keccak256(abi.encodePacked(rawFlightId))` consistently. The deployment script and front-end must agree on the encoding.
3. **Stablecoin decimals:** The stablecoin ERC-20 is treated as having 18 decimals (standard for cUSD). If a 6-decimal token (USDC) is injected, the scaling logic in `InsuredFlightsAgency` must account for this — implementation will read the stablecoin's `decimals()`.
4. **Premium currency:** Premiums are collected in native CELO (`msg.value`). A future upgrade may accept stablecoin premiums — out of scope here.
5. **Game operator:** `CommitRevealRandomness` requires a trusted operator to pre-commit before each game round. The off-chain operator infrastructure is outside the contract scope.
