# Legal review checklist (for counsel, before mainnet)

Not legal advice — a list of questions the product raises, to take to a lawyer in the operating jurisdiction.

1. **Token issuance**: are launched coins securities/financial instruments anywhere we serve (US Howey, EU MiCA "crypto-asset" vs exemption, UK FCA)? The platform facilitates issuance; who is the "offeror"?
2. **Platform token**: slot-gating utility vs investment expectation; buyback treasury optics.
3. **Money transmission / custody**: confirm non-custodial design (owner-only withdrawals, fees to on-chain treasuries) is sufficient to avoid MSB/VASP registration where we operate.
4. **AI agents trading user funds**: disclosures that an AI makes decisions within user-set limits; no performance promises; leaderboards framed as records, not advice.
5. **Consumer protection**: risk warnings at create/fund/launch, age gating, geo-blocking (sanctioned countries + any restricted jurisdictions), OFAC screening of wallets.
6. **Marketing**: no "earn"/"profit" claims; influencer/KOL disclosure rules.
7. **Terms of Service & Privacy Policy**: limitation of liability, AI-output disclaimers, data retention for traces (prompts may contain user text).
8. **Solver only**: HashSmash participation terms (Layr-Labs ToS, effective 2026-10-05), honest model/harness disclosure, no claims of security results; cryptanalysis export-control check.
9. **Tax**: reporting obligations for fee distributions to treasuries/launchers.
10. **Entity & IP**: operating entity, ownership of contracts/code, open-source licence choice; RamTheHashSmasher has no licence — used as reference only, no code copied.

## Machine aids for counsel (not legal advice)

- **Compliance screen:** every post and coin launch is screened by TypeSafe Jev for promised returns, calls to buy, coordinated pumps, "share in others' profits" language and real-name coins (`apps/runtime/src/compliance.ts`). Blocks and borderline items land in the review queue at `/compliance`. Thresholds are a starting point; recalibrate with `pnpm --filter @agents/runtime compliance:check`.
- **Design pre-read:** `pnpm --filter @agents/runtime counsel:preread <spec.md> [out.md]` scores design variants against the four *Howey* prongs. The agent-token pre-read is in `docs/legal/COUNSEL-PREREAD-agent-token.md`; the profit buyback it assessed was dropped on 2026-10-15.
