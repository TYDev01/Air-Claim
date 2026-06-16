# AirClaim Frontend — Feature & Function Roadmap

Parametric flight-delay insurance dApp on **Celo**. The UI lets a user connect a
wallet, **insure** a flight (pay a premium), **track** the policy, and **claim** a
payout when the flight is confirmed delayed/cancelled on-chain.

## Build workflow (IMPORTANT)

- We ship **one function at a time**. After each single function is added, work
  **stops** and the user is notified, the user **pushes to GitHub**, then tells
  Claude to **continue**. Functions — not components, not files.
- Goal: a large number of small, reviewable commits (~900 target on this branch).
- Verify `npm run build` passes in `frontend/` periodically (not after every fn,
  to keep functions atomic — build checks happen at feature boundaries).

## Stack (already scaffolded)

Next.js 16 (App Router, TS, `src/`), Tailwind v4, shadcn/ui, Framer Motion.
Web3 layer to add: **wagmi v2 + viem + @tanstack/react-query** + a wallet connector.

## Canonical facts (do not drift)

- Addresses come from `deployments/celo.json` (mainnet) / `deployments/hardhat.json`.
  - InsuredFlightsAgency: `0x2578740ad058Af75dd2681B0979C9731e2755F27`
  - FlightOracle: `0x12aeCeB975C01BB3C062c90CF46Df7Ee1CA6BB0a`
  - cUSD: `0x765DE816845861e75A25fCA122bb6898B8B1282a`
- ABIs come from `backend/abis/*.json` (never hand-write).
- `flightId = keccak256(toBytes(\`${IATA.toUpperCase()}-${YYYY-MM-DD}\`))`.
- Premium per pax = `ticketPrice/10 + baseFee`; **send `premiumFor(prices)` exactly**
  as `msg.value`. Payout = up to 10% of ticket price (cUSD or native CELO).
- Money is CELO wei (18 decimals) — format via viem `formatEther`/`parseEther`.

---

## Phase 0 — Web3 foundation (lib)

- [x] `getContractAddresses(chainId)` — resolve addresses from deployments JSON.
- [x] `getSupportedChains()` — return the viem chains we support.
- [x] `createWagmiConfig()` — build the wagmi config (chains + connectors + transports).
- [x] `getDefaultChain()` — pick the active default chain from env.
- [x] `importInsuredFlightsAgencyAbi()` — typed accessor for the IFA ABI.
- [x] `importFlightOracleAbi()` — typed accessor for the oracle ABI.

## Phase 1 — Core domain utils (lib)

- [x] `canonicalFlightId(iata, date)` — mirror of `scripts/config/flightId.ts` (viem).
- [x] `assertIsoDate(date)` — strict YYYY-MM-DD guard.
- [x] `toFlightDateTimestamp(isoDateTime)` — scheduled-departure → uint64 unix.
- [x] `formatCelo(wei)` — wei → display string.
- [x] `parseCelo(input)` — display string → wei.
- [x] `formatPayoutEstimate(ticketPriceWei)` — "up to 10% of ticket" estimate.
- [x] `truncateAddress(addr)` — 0x1234…abcd.
- [x] `formatFlightDate(ts)` — uint64 → human date.
- [x] `derivePolicyStatus(policyInfo, passengerInfo)` — Scheduled|Delayed|Claimed|Claimable.

## Phase 2 — wagmi read hooks

- [x] `usePremiumFor(ticketPrices)` — read `premiumFor`.
- [x] `usePolicyInfo(flightId)` — read `policyInfo`.
- [x] `usePassengerInfo(flightId, account)` — read `passengerInfo`.
- [x] `usePolicyIdFor(flightId)` — read `policyIdFor`.
- [x] `useIsPaused()` — read paused state (graceful handling).

## Phase 3 — wagmi write hooks

- [x] `useInsureFlight()` — write `insureFlight` + wait for receipt.
- [ ] `useClaimInsurance()` — write `claimInsurance` + wait for receipt.

## Phase 4 — event hooks

- [ ] `useWatchFlightInsured(onLog)` — watch `FlightInsured`.
- [ ] `useWatchDelayConfirmed(onLog)` — watch `DelayConfirmed`.
- [ ] `useWatchInsuranceClaimed(onLog)` — watch `InsuranceClaimed`.

## Phase 5 — form / validation logic

- [ ] `validateFlightForm(values)` — required fields, future date, IATA shape.
- [ ] `validatePassengerRow(row)` — address + ticket price validation.
- [ ] `buildInsureArgs(formValues)` — assemble the `insureFlight` argument tuple.
- [ ] `computeTotalPremium(prices, premiumFor)` — sum + sanity check.

## Phase 6 — providers & app shell (components, wired via fns above)

- [ ] `Providers` — wagmi + react-query + connector providers.
- [ ] Wallet connect button.
- [ ] Root layout / theme.

## Phase 7 — pages

- [ ] Landing page (hero, value prop, CTA) — Framer Motion.
- [ ] `/insure` — flight + passengers form, premium preview, submit.
- [ ] `/policy/[flightId]` — status tracking, passenger table.
- [ ] `/claim` — eligibility check + claim action.

## Phase 8 — polish

- [ ] Toast/notification helper.
- [ ] Loading/skeleton + error states.
- [ ] Responsive + animation pass.
- [ ] Final `npm run build` verification.

---

### Progress log

(Each completed function gets a line here as we go, so we can track the ~900-commit cadence.)

1. `getContractAddresses(chainId)` — `frontend/src/lib/contracts.ts`
2. `getSupportedChains()` — `frontend/src/lib/chains.ts`
3. `createWagmiConfig()` — `frontend/src/lib/wagmi.ts`
4. `getDefaultChain()` — `frontend/src/lib/chains.ts`
5. `importInsuredFlightsAgencyAbi()` — `frontend/src/lib/abis.ts` (+ copied `src/abi/InsuredFlightsAgency.json`)
6. `importFlightOracleAbi()` — `frontend/src/lib/abis.ts` (+ copied `src/abi/FlightOracle.json`)
7. `canonicalFlightId(iata, date)` — `frontend/src/lib/flightId.ts` (verified parity with ethers)
8. `assertIsoDate(date)` — `frontend/src/lib/dates.ts` (canonicalFlightId now reuses it)
9. `toFlightDateTimestamp(isoDateTime)` — `frontend/src/lib/dates.ts`
10. `formatCelo(wei)` — `frontend/src/lib/money.ts`
11. `parseCelo(input)` — `frontend/src/lib/money.ts`
12. `formatPayoutEstimate(ticketPriceWei)` — `frontend/src/lib/money.ts` (+ tsconfig target → ES2020)
13. `truncateAddress(addr)` — `frontend/src/lib/format.ts`
14. `formatFlightDate(ts)` — `frontend/src/lib/format.ts`
15. `derivePolicyStatus(policy, passenger)` — `frontend/src/lib/policyStatus.ts` (Phase 1 complete)
16. `usePremiumFor(ticketPrices)` — `frontend/src/hooks/usePremiumFor.ts`
17. `usePolicyInfo(flightId)` — `frontend/src/hooks/usePolicyInfo.ts`
18. `usePassengerInfo(flightId, account)` — `frontend/src/hooks/usePassengerInfo.ts`
19. `usePolicyIdFor(flightId)` — `frontend/src/hooks/usePolicyIdFor.ts`
20. `useIsPaused()` — `frontend/src/hooks/useIsPaused.ts` (Phase 2 complete)
21. `useInsureFlight()` — `frontend/src/hooks/useInsureFlight.ts`
