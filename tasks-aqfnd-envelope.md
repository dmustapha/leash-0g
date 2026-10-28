# AQ-FND ⑥ Beat 3 — envelope cockpit surface (M-2 LeashEnvelopeModuleV6)

Gap: the M-2 owner envelope has NO FE surface (write or read). Module 0x973b…189e deployed,
account.envelopeModule() points to it. Build the owner-facing surface so Dami signs envelope.set
in the cockpit and the UI names what the agent may do alone.

## Steps
- [x] chain.ts: EnvelopeModule ABI (parseAbi) — propose/apply_/tightenEnvelope/envelope(view).
- [x] chain.ts: readEnvelopeModule(account) via account.envelopeModule().
- [x] chain.ts: proposeEnvelopeOnchain / applyEnvelopeOnchain / tightenEnvelopeOnchain
      (target the MODULE, args (account, kind=1, payload=abi.encode(asset, EnvelopeEntry))).
- [x] chain.ts: readEnvelope(account, asset) → {set, maxPerTransferCap, maxWindowCap, minWindowSeconds}.
- [x] components/cockpit/EnvelopeForm.tsx: owner form (token, maxPerTransfer, maxWindow,
      minWindowSeconds) propose→apply (timelocked) + current-envelope display.
- [x] page.tsx: proposeEnvelope/applyEnvelope handlers + render, gated v6.
- [~] Verify: typecheck 0 (done); driving envelope.set live via the new UI (Dami signs) → on-chain
      envelope(account, AQB).set == true with the committed caps.

## Notes
- propose/apply are onlyOwner on the MODULE (not the account) — call ON the module address.
- kind 1 = envelope entry; validate minWindowSeconds>0 && maxWindowCap>=maxPerTransferCap.
- apply re-submits same payload (commit check), like the budget fix.
- Beat 6 will need kind-2 veto-config — add in a follow-up within this slice if cheap.
