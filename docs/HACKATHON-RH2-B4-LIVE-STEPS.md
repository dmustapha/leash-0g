# RH2 B4 — live cockpit band-hero staging (Dami-paired, post-gate)

The capability-factory seam is built + tested + wire-proven (D5 5/5). The LIVE
cockpit create of the band hero needs TWO things that are deliberately NOT done
autonomously (outward/irreversible + house gate):

## Prerequisite — a backend carrying the seam
Render auto-deploys the **production** service from `main`; the capability-factory
code lives on `hackathon-robinhood`. The binding post-deadline gate forbids a
mainline merge in-sprint. So the live band-hero create runs against a **branch
backend**, one of:
- local: `cd backend && pnpm build && node dist/index.js` with `backend/.env`
  (already carries `EXTRA_CHAINS` with `capabilityFactories.oracleBand`), relay up
  (`node contracts/rpc-relay.cjs`); point the cockpit at it; OR
- a Render **preview/branch** service built from `hackathon-robinhood` (do NOT
  repoint the production service's branch).

The production service keeps the prod factory (B1) — that is what makes the
same-address onboard (B2) real for existing agents; it is correct as-is.

## Step 1 — mint the band hero (in-page fetch, owner session, never leaves browser)
From Dami's authenticated cockpit tab (token stays in the browser):
```js
await fetch('/api/agents', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    name: 'oracle-wall hero',
    chainId: 46630,
    capability: 'oracleBand',            // ← selects the price-band wall factory
    auditPubKey: '04' + 'ab'.repeat(64), // or a real browser-generated audit pubkey
    policy: { perTransferCapWei: '1000000000000000000', windowCapWei: '10000000000000000000', windowSeconds: 3600, expiresAt: 2147483647 },
    allowlist: [],
    goal: { type: 'requester' },
    tokenConfig: { settlementToken: '0x5F6a3AbC97E421f7B3930fc504D6a0CE4eE41e06', perTransferCapTokenWei: '1000000000000000000000', windowCapTokenWei: '5000000000000000000000' },
  }),
}).then(r => r.json());
```
Returns the new agent (its account minted through the band-wall factory on RH).

## Step 2 — configure the band so it IS the hero
The band is set via `tightenPriceBand` + `enableRequireBandForSwap` (not in the UI).
Reuse the exact calls in `backend/scripts/rh-capability-hero-d5.ts` (D5d) against
the new account, then fund + grant approve/swap as in `rh-onboard-hero-drill.ts`.

## Step 3 — D4 fleet-visibility assertion
`GET /api/agents` lists it; `GET /api/agents/:id` detail loads with its band policy;
audit rows carry RH Blockscout links (prefix `web/lib/networks.ts[46630]`).

> Machine-verified already (no browser needed): D4 band latch ON on-chain + hero
> drill 5/5 (`rh-hero-staging-d4.ts`), and D5 the full capability-factory create
> wire (`rh-capability-hero-d5.ts`). The steps above are the live UI evidence on top.
