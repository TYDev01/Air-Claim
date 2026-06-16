---
name: airclaim-frontend
description: Build or modify the AirClaim Next.js frontend — the dApp UI that lets users insure flights, check/claim delay payouts, and read policy state from the InsuredFlightsAgency and FlightOracle contracts on Celo. Use for any frontend/UI/web work on AirClaim (Next.js, React, wagmi/viem, wallet connect, insure/claim flows, reading on-chain policy data). Covers contract addresses, ABIs, the canonical flightId encoding, premium/payout math, and chain config.
---

# AirClaim frontend (Next.js)

AirClaim is parametric flight-delay insurance on Celo. The frontend lets a user:
connect a wallet, **insure** a flight (pay a premium), watch the policy, and
**claim** a payout when the flight is confirmed delayed/cancelled on-chain.

This skill is the source of truth for wiring the UI to the contracts. When it
disagrees with memory, trust the committed ABIs and `deployments/celo.json`.

## Stack & conventions

- **Next.js (App Router) + TypeScript**, in a `frontend/` directory at the repo root.
- **wagmi v2 + viem** for chain access; **@tanstack/react-query** (wagmi peer).
- A wallet connector — **RainbowKit** or **ConnectKit** (either is fine; pick one).
- Do **not** hand-write ABIs or addresses. Import the committed ABIs from
  `backend/abis/InsuredFlightsAgency.json` and `backend/abis/FlightOracle.json`
  (copy them into `frontend/src/abi/` at build time or import via a path alias),
  and read addresses from `deployments/<network>.json`.
- Money is **native CELO (18 decimals)**. Ticket prices and premiums are in CELO wei.
- Keep all on-chain reads through wagmi hooks (`useReadContract`) and writes
  through `useWriteContract` + `useWaitForTransactionReceipt`.

## Chains

| Network | chainId | viem chain |
|---|---|---|
| Celo mainnet | 42220 | `celo` |
| Alfajores testnet | 44787 | `celoAlfajores` |
| Local/fork | 31337 | `hardhat` |

Match the backend: it supports the same three (`backend/src/chain/ChainClient.ts`).

## Deployed addresses (Celo mainnet — `deployments/celo.json`)

- InsuredFlightsAgency: `0x9911b0aDD0e026B8091Ec0b1f4dF6893FF24F6A4`
- FlightOracle: `0xc45c6d4C3fb5D3FEf8f09D30a4AFA2a992b84b5D`
- cUSD stablecoin: `0x765DE816845861e75A25fCA122bb6898B8B1282a`
- CELO/USD feed: `0x0568fD19986748cEfF3301e55c0eb1E729E0Ab7e`

Read these from the JSON, do not hardcode in components. Alfajores has its own
`deployments/alfajores.json` once deployed.

## CRITICAL: canonical `flightId`

`flightId` is **not** a hash of the flight code alone. Use the project-wide
canonical encoding (see `scripts/config/flightId.ts`), or policies/oracle
records/indexer rows will not line up and `insureFlight` may revert:

```ts
import { keccak256, toBytes } from "viem";

/** flightId = keccak256(abi.encodePacked(flightIata, "-", "YYYY-MM-DD")). */
export function canonicalFlightId(flightIata: string, flightDate: string): `0x${string}` {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flightDate)) throw new Error("flightDate must be YYYY-MM-DD (UTC)");
  return keccak256(toBytes(`${flightIata.toUpperCase()}-${flightDate}`));
}
```

`flightDate` here is the scheduled-departure **UTC calendar date**. The contract
also takes a separate `flightDate` arg that is a **uint64 unix timestamp** of
scheduled departure — these are two different things; don't conflate them.

## Premium & payout math

- Premium per passenger = `ticketPrice / 10 + baseFee` (10% of ticket + flat fee).
- **Always call `premiumFor(ticketPrices[])` first** and send that value EXACTLY
  as `msg.value`. `insureFlight` requires `msg.value == totalPremium` and reverts
  on any other amount (over or under) — there is no refund of excess.
- Payout on a valid claim = **10% of the claimant's ticket price**, paid in cUSD
  when the feed is healthy and the contract holds enough stablecoin, otherwise in
  native CELO. The UI should present "up to 10% of ticket price" and not assume a
  currency.

## Contract interface the UI needs (InsuredFlightsAgency)

Writes:
- `insureFlight(bytes32 flightId, string flightNumber, string departure, string arrival, uint64 flightDate, address[] passengers, uint256[] ticketPrices)` **payable**
- `claimInsurance(bytes32 flightId)`

Reads (views):
- `premiumFor(uint256[] ticketPrices) → uint256`
- `policyInfo(bytes32 flightId) → PolicyView { policyId, flightId, flightNumber, departure, arrival, flightDate(uint64), claimable(bool), exists(bool), passengerCount }`
- `passengerInfo(bytes32 flightId, address passenger) → (bool found, uint256 ticketPrice, bool claimed)`
- `policyIdFor(bytes32 flightId) → uint256`

Events to watch for UX (toasts / optimistic refresh):
- `FlightInsured(uint256 policyId, bytes32 flightId, string flightNumber, string departure, string arrival, uint64 flightDate, address[] passengers, uint256 totalPremium)`
- `DelayConfirmed(bytes32 flightId, uint256 policyId, uint32 delayMinutes)`
- `InsuranceClaimed(uint256 policyId, bytes32 flightId, address passenger, uint256 amount, bool paidInStablecoin)`

`checkFlightDelay(bytes32)` exists but the backend keeper calls it; the UI does
not need to. A flight becomes claimable when the oracle confirms a delay past the
threshold (or a cancellation).

## Core user flows

1. **Insure**: collect flight details + per-passenger ticket prices → compute
   `flightId` via `canonicalFlightId` → `premiumFor([...])` → `insureFlight(...)`
   with `value: premium` → wait for receipt → show policy.
2. **Track**: poll `policyInfo(flightId)` / `passengerInfo(flightId, account)`;
   show states: Scheduled → Delayed (claimable) → claimed. Disable Claim until
   `policyInfo.claimable === true`.
3. **Claim**: if `claimable` and the connected wallet is an insured passenger who
   hasn't claimed (`passengerInfo.found && !passengerInfo.claimed`), enable
   `claimInsurance(flightId)`; on success surface the `InsuranceClaimed.amount`
   and `paidInStablecoin` so the user knows the currency.

## Gotchas

- One active policy per `flightId` — a second `insureFlight` for the same id
  reverts (`IFA: policy exists`). Surface this clearly.
- `flightDate` (the uint64 arg) must be in the future or `insureFlight` reverts.
- The contract can be **paused** (owner emergency stop); insure/claim revert while
  paused. Handle the revert gracefully.
- Ticket prices and premiums are CELO wei — format with viem `formatEther` /
  `parseEther`, never assume a fixed display precision.
- Re-extract ABIs with `npm run abis:extract` after any contract change; the UI's
  copies must not drift (CI runs `npm run abis:check`).

## Suggested structure

```
frontend/
  src/
    abi/                 # generated copies of the two ABIs (or path-aliased)
    lib/flightId.ts      # canonicalFlightId (mirror of scripts/config/flightId.ts)
    lib/contracts.ts     # addresses from deployments/*.json + chain config
    wagmi.ts             # wagmi config (celo, celoAlfajores) + connectors
    app/                 # App Router pages: insure, policy/[flightId], claim
    components/
```

When scaffolding, prefer `create-next-app` (TS, App Router) inside `frontend/`,
then add `wagmi viem @tanstack/react-query` and a connector. Verify the build
with `npm run build` in `frontend/` before declaring done.
