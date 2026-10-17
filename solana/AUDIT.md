# Internal security review of the Solana programs (pre-audit)

This is a self-review, **not** a substitute for an external audit. Hand this file to the auditor as the scope and threat model. The EVM equivalent is `contracts/AUDIT.md`.

## Scope

| Program | Id | Lines | What it does |
|---|---|---|---|
| `programs/agents` | `4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r` | about 900 | Registry, agent vaults, trading and launching by raw CPI into Meteora DBC, opening crank, fee claims and split |
| `programs/agents_hook` | `8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9` | about 150 | Token-2022 transfer hook: agents-only phase, refuses coins we didn't launch |

Out of scope: Meteora DBC itself (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`), audited by Meteora's auditors. Do confirm the deployed version matches the audited release.

## Testing done

- `apps/runtime/src/solana/e2e.ts` runs against a real cluster: a local validator running the devnet DBC program and our two programs. All 31 checks pass:
  - platform setup refused to anyone but the upgrade authority
  - taken and invalid handles refused
  - launch, and the cooldown refusing a second launch
  - an agent buys during the agents-only phase
  - an outsider buying straight from DBC refused during the phase
  - the session key refused withdrawals; the owner can withdraw SOL
  - the owner refused moving coins out to a wallet during the phase
  - per-trade cap, daily cap, `minOut = 0`, unreachable minOut and a stranger acting as operator all refused
  - opening by threshold; outsiders can trade once open
  - a pool someone else creates on our public DBC config can't trade
  - a sell, and owner coin withdrawal after opening
  - fee split: 80.0% to the launcher, then inference and buyback equal
- Unit tests:
  - instruction building and fill parsing against a mocked RPC
  - the web app's hand-encoded instructions checked byte for byte against Anchor's
  - DBC pool decoding against recorded accounts
  - a Rust test pinning the ids the hook hard-codes

## Trust model

| Role | Can | Cannot |
|---|---|---|
| Agent owner | withdraw all SOL and tokens from the vault; rotate the session key and caps; trade and launch without caps | move coins in their agents-only phase to a non-agent account (the hook applies to everyone) |
| Session key (runtime) | `buy` within `max_trade` and the daily limit, `sell`, `launch` once per cooldown, all with `minOut > 0` and only on this platform's pools | withdraw, redirect swap output (input and output accounts must be owned by the vault), touch other pools |
| Upgrade authority | `init_platform` once (sets the DBC config, fee recipients, thresholds); upgrade both programs | change the platform after init (no update instruction) |
| Anyone | `open_coin` when due, `claim_creator_fees` (pays the vault), `distribute_fees` (pays the fixed recipients), create a pool on our public DBC config | trade a coin the agents program didn't launch (no hook accounts), change any recipient |

The programs are upgradeable. That is the main remaining trust assumption, and the EVM contracts don't have it. Before mainnet, decide whether to hand the upgrade authority to a multisig with a timelock, or make the programs immutable.

## Points for the external auditor

1. **CPI into DBC by raw instruction** (`swap`, `launch`, `claim_creator_fees`, `distribute_fees` in `programs/agents/src/lib.rs`). The discriminators and account order come from DBC's IDL, which is checked into `solana/idls/`. Confirm:
   - the order matches the deployed DBC version
   - the vault PDA's signature can't be used for anything beyond the intended instruction
2. **Pool checks.** `swap` requires `coin.pool == pool`, and requires the pool's config (read at byte offset 72) to be ours. The quote reserve is read at offset 240. These offsets assume DBC's `PoolState` layout; a DBC upgrade that changes the layout would break `open_coin`. Consider anchoring on the account discriminator as well.
3. **Remaining accounts forwarded to DBC** as transfer-hook accounts are supplied by the operator, and all are passed as non-signers. Token-2022 matches them by key against the validation account. Confirm no account in that list can gain write access it shouldn't have.
4. **Transfer hook phase logic.** It allows a transfer when the coin is open, or its opening time has passed, or the receiving token account's owner is DBC's pool authority or a vault with a `Member` record.
   - The `Member` PDA is derived from the receiver's owner (`AccountData` seed on the destination). Meteora's SDK resolves hook accounts with placeholder addresses, so its `swap2WithTransferHook` helper fails for our coins. Our runtime and web build these accounts themselves, and Jupiter-style resolvers that use real accounts work.
   - DBC removes the hook when the curve completes. The open threshold must therefore be below the graduation threshold (`setupPlatform` enforces this).
5. **Opening is a crank, not a swap side effect.** On EVM, `afterSwap` flipped `opened` in the same transaction. Here, threshold opening needs an `open_coin` call; the runtime sends it every pass. Time-based opening needs no crank, because the hook checks the clock itself.
6. **Vault pays DBC rent on launch** (about 0.02 SOL). A compromised session key could spend about one launch's rent per cooldown period from a vault. That is bounded, but it is not zero. On EVM, launches cost the session key's gas instead.
7. **Wrapped SOL.**
   - Buys wrap the shortfall from vault lamports into the vault's wSOL account; sale proceeds stay as wSOL.
   - The vault must stay rent-exempt or be emptied completely (both are checked).
   - Owners withdraw wSOL with `withdraw_token`.
8. **Daily cap** uses `Clock::unix_timestamp` windows, as the EVM version used `block.timestamp`.
9. **Sells are not capped** (they only return SOL to the vault), matching the EVM design (audit point 6 there).
10. **Slot gating** reads the owner's platform-token balance at creation only, as on EVM. It is off when `platform_mint` is the default key.
11. **Fees are pull-based.** Creator fees are claimed into the vault, and the partner share into the `fees` PDA, which splits it 50/50. A recipient can never block collection, which settles EVM audit point 3.

## Known differences from the EVM contracts

- Coins are Token-2022 with 6 decimals. Supply is 1B with mint authority revoked, and liquidity is locked. Liquidity lives in DBC's curve and then in DAMM v2, with 100% of the LP permanently locked at graduation.
- Fees are taken in SOL only, so there is no token-side fee to burn.
- The fee is 1.25% gross. Meteora's protocol keeps 20%, so the platform and launcher get 1%, the same as on EVM.
- During the agents-only phase, owners can't move coins out to their own wallet. They can sell, and they can withdraw once the coin opens. The EVM contracts allowed `withdrawToken` at any time.
