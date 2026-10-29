# Security review of the Solana program (pre-audit)

This is an internal review and the scope for an external audit. It is **not** a substitute for one.

## Scope

| Program | Id | Lines | What it does |
|---|---|---|---|
| `programs/agents` | `4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r` | about 800 (with tests) | Agent registry and vaults. Owners fund and withdraw. The runtime's session key swaps through Jupiter within caps, at no worse than the Pyth price. The admin keeps a token whitelist and a pause switch. |

Out of scope, but the program depends on them:
- Jupiter v6 (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`), called by raw CPI.
- The Pyth receiver (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`), read through `pyth-solana-receiver-sdk` 1.2.0.
- The AMMs Jupiter routes through.

## Roles

| Who | Can | Can't |
|---|---|---|
| Owner (the wallet that created the agent) | Withdraw SOL and tokens at any time, swap anything, set or revoke the session key and its caps, close vault token accounts | Nothing is out of reach for its own vault |
| Session key (the runtime) | Swap through Jupiter between SOL and whitelisted tokens. Buys stay within `max_trade` and a rolling `daily_limit`. Every swap must return at least the Pyth price less `max_slippage_bps`. It can also close vault token accounts, sending the rent and any wrapped SOL to the vault. | Withdraw, swap one token into another, trade while paused, trade a token off the whitelist, accept a route with a platform fee |
| Admin | Add and remove whitelisted tokens (plain SPL Token mints with a Pyth feed), pause and resume session keys, set the oracle settings within ceilings (price age at most 120 s, slippage at most 5%), propose a new admin | Move funds out of a vault, stop owners, set up the platform a second time, change the SOL/USD feed (a program constant) |
| Upgrade authority | Upgrade the program. This is the strongest power: a malicious upgrade could drain every vault. It is held by the owner's wallet. | |
| Anyone | Create an agent, send SOL or tokens to a vault | Everything else |

`init_platform` can only be called by the program's upgrade authority, so setup can't be front-run. The admin handover is two steps (`set_admin` proposes, `accept_admin` takes over), so a mistyped key can't lock the role away. The launch tooling hands the upgrade authority to the owner only after the owner's wallet has accepted the admin role on-chain, which proves the address is theirs.

**The admin is trusted for prices.** An admin acting together with a session-key holder could whitelist a worthless token against another token's feed, and session keys would then buy it up to their caps. Today the admin and the upgrade authority are the same wallet, and the upgrade authority can replace the program anyway. Before handing either role to a multisig, or making the program immutable, put a delay on `allow_mint` and `set_oracle` so owners can revoke their session keys first.

## How a swap is checked

**Before the CPI:**
- `check_route` accepts only Jupiter's exact-in `route`.
- The route's transfer authority must be the vault, its source must be the vault's input account, and its destinations must be the vault's output account. `route`'s optional destination may also be left unset.
- The platform fee account must be unset (the Jupiter program id), and the fee byte must be 0.
- The `in_amount` at the end of the data must equal `amount_in`. Jupiter ignores trailing bytes, so this field can be spoofed. That is why the checks after the CPI measure what actually left the vault, and why the fee account, not the fee field, is what blocks fees.
- For a session key:
  - not paused
  - both accounts plain SPL Token accounts
  - one side SOL and the other a whitelisted token
  - fresh Pyth prices for SOL (a fixed feed id) and the token

  The prices must come from Pyth's own sponsored feed accounts, not from an update account anyone could create with a price of their choosing. Anyone can post a newer signed price to a sponsored account, but never an older one, so a session key can choose its moment only within the `max_age` window. Prices must be fully verified, at most `max_age` old (90 s planned for mainnet), with a confidence band within 2% of the price. What the vault gives is valued at the top of its band (`price + conf`) and what it gets at the bottom (`price - conf`), so fair value is the most the band says the input could be worth, and `floor = fair value × (1 − max_slippage)`. A wider band raises the floor; it never lowers it.

  **What the band costs in slippage.** A band of b% on each side raises fair value by about 2b% over the midpoint (exactly `(1 + b_in) / (1 − b_out)`), so it uses about 2b% of the slippage allowance. With 300 bps allowed:
  - SOL and the listed tokens: bands measured at 0.2% at most (docs/REAL-MONEY-LAUNCH.md), so about 0.4% is used and about 2.6% is left for the route's pool fee and price impact. On 29 October 2026 the live sponsored feeds read SOL 0.085% and JUP, WIF, TRUMP, FARTCOIN, BONK and MEW 0.04% to 0.12%, so about 0.1% to 0.2% was used.
  - MEW: measured up to 0.45%, so with SOL at 0.2% about 0.65% is used and about 2.35% is left.
  - Bands at the 2% limit on both sides would use about 4%, more than the allowance, so every session-key swap is refused until the bands narrow. That fails safe, but it also blocks stop-loss exits in a disorderly market; the owner can still trade.

  A direct Jupiter route on an open AMM normally fills within a pool fee (0.25% to 1%) plus a little price impact of the live price, so 300 bps still lets normal trades through.
- For a session-key buy, the caps apply.

**After the CPI:**
- What left the input account is at most `amount_in`.
- What arrived in the output account is at least `min_out` and at least the floor.
- The vault's SOL didn't fall, and the vault is still system-owned with no data.
- Every vault token account in the route, input and output included, still belongs to the vault. The input and output accounts are unchanged apart from their balances: no delegate, close authority or state change. Their lamports may move, since wrapped SOL's balance is its lamports and only the token program can debit them. Every other vault token account keeps its lamports and is unchanged byte for byte.

## What a stolen session key can do

It can trade at up to `max_slippage_bps` (300 bps on mainnet) worse than the cautious edge of a sponsored oracle price (the edge that asks most of the trade, so never more than 3% below the midpoint, and less the wider the band), which includes sandwiching its own trades. That price can be up to `max_age` old, and the key picks the moment, so against the live market a trade can also lose however far the token moved in its favour since that price. On a fast memecoin that can be a few percent within 90 s.

- **Sells have no cap.** The key can sell all of an agent's tokens back to SOL at once, at the floor.
- **Buys are capped.** The rolling cap refills `daily_limit` per day, so up to about twice `daily_limit` can be spent in any 24 hours. What it buys can be sold straight back, so each capped buy can lose the margin twice.

**Worst case per agent:** about (3% + the token's move over `max_age`) of its token holdings once, plus about twice that on up to twice `daily_limit` of buys each day. One session key serves every agent, so the same bound applies to all of them at once. The owner can revoke the key at any time (`set_session` with the default key), and the admin can pause every session key at once.

Ways to tighten this later, each a program change: a session-key sell cap measured in SOL, a shorter price age with the runtime posting fresh Pyth updates in the same transaction, and a lower slippage for the most liquid tokens.

## Known limits and decisions

- **The website pins the program id** at build time (`NEXT_PUBLIC_SOLANA_PROGRAM_ID`) and refuses to sign for any program the runtime's API names instead.
- **Only one hop per swap.** The runtime asks Jupiter for direct routes, and only through open AMMs (Raydium, Orca, Meteora, Pump.fun's AMM). Some private market makers insist that the trader signs the transaction itself, which a vault PDA can't. Multi-hop routes would pass through middle-token accounts the vault lacks, and the program wants every untraded vault account back untouched.
- **The whitelist is plain SPL tokens with a live sponsored Pyth feed.**
  - SPL only, because Token-2022 extensions (permanent delegate, transfer hooks, pausing) could take or trap what session keys buy.
  - Any decimal count. The program stores each mint's decimals for the price floor, and the runtime prices and caps each token by its own decimals (BONK and MEW have 5).
  - Sponsored feeds update about once a minute. Some have gone stale for weeks (POPCAT, RAY and PENGU in October 2026). Session-key trades on a stale feed fail with `BadPrice`. That is safe, but the token is effectively frozen for agents until the admin removes it.
- **Freeze authorities:** USDC-style freeze authorities on a whitelisted token could freeze a vault's holding. Prefer tokens without one; the preflight flags them.
- **No pause on owners**, by design. An owner can always withdraw SOL, and can withdraw any token whose own program allows it.
- **Handles can be taken first** (the agent PDA is derived from the handle). A front-run creation simply fails; no funds are at risk.
- **Agent accounts can't be closed, and ownership can't be transferred.**
- **Nothing may approve a vault as a token delegate.** The vault signs every swap, and Jupiter forwards that signature, so a route could spend from any token account that names the vault as its delegate. Such an account isn't the vault's, and the swap's net checks still hold, but it would let a route pass through accounts the vault doesn't own. Neither the program nor the website ever makes such an approval; keep it that way.
- **The session key can close the vault's empty token accounts, even while paused.** The rent always goes back to the vault and anyone can recreate the accounts, so the worst a stolen key can do here is make the next swap recreate them.
- **No events for `set_oracle`, `set_admin` or `close_token_account`.** Their effects show in the platform record and the transaction history. Adding events changes the IDL, so it waits for the next program change.
- **Every Pyth error is `BadPrice`.** Stale, wrong-feed and partly verified prices look the same in the logs; the runtime reads the feed's age itself to tell them apart.
- **Anchor resolves to 0.32.2.** `Cargo.toml` asks for `0.32.1`, which Cargo reads as "0.32.1 or a later 0.32"; the lock file pins 0.32.2, and the reproducible build uses the lock file.

## Testing done

**Reproducible build (27 October 2026).** `solana-verify build --library-name agents` (solana-verify 0.5.2, image `solanafoundation/solana-verifiable-build` for Solana 2.3.0, digest `sha256:695f890e…6cb4`) from the reviewed source gives:
- executable hash (`solana-verify get-executable-hash`): `f06293433f21069472d6052daa268a58dec329c8dc83dc29fe98efe113a80eb7`
- file sha256 (what the preflight prints): `72370885201564f46873551b8e200013c9c332a0bbada73be1c985cdc7798111`, 483,304 bytes

A clean build from a fresh copy of the commit gave the same bytes. Any change under `programs/` or to `Cargo.lock` changes the hash; rebuild and record it again.

**Rebuild after the confidence-band correction (29 October 2026).** The hashes above and the 37-check result below were for the program before the correction (see "Correction, 29 October 2026"). That change alters `oracle_floor`, so both were redone on the corrected source with the same tools and image:
- executable hash: `5f708ece8134ae8ccc8472e534bb58b6bb6c1e2f44f562a2421ba279d3400a8b`
- file sha256: `902a8966e124c2be6d044701f7205e9a14cf16f0af2d715779542661b74f0bdb`, 483,936 bytes
- fork run: that exact file deployed to a fresh Surfpool fork (`solana-verify get-program-hash` on the fork matched), then `solana:e2e`: 37 of 37 passed, including the real Jupiter buys and sells with the tighter floor.

These are the hashes to deploy. Any further change under `programs/` or to `Cargo.lock` before deploy means redoing both (docs/MAINNET-LAUNCH.md step 2).

**`apps/runtime/src/solana/e2e.ts`: 37 checks** (37 of 37 passed on 27 October 2026 on the original build, and again on 29 October 2026 on the corrected build, each on a fresh Surfpool fork running exactly that file)
- Runs on a local mainnet fork (Surfpool), so it uses mainnet's real Jupiter, pools and Pyth accounts. Our program is deployed locally.
- Setup: only the upgrade authority can set up the platform, and only the admin can whitelist.
- Admin handover: a proposed admin has no power until it accepts, and only it can accept. The website reads the platform record and the whitelist the same way Anchor does.
- Real buys and sells through Jupiter.
- Caps: the per-trade cap and the daily cap.
- Refused swaps:
  - a token that isn't whitelisted
  - a route with a fee
  - a route that names a fee account
  - a route that pays someone else
  - a route for a different amount
  - a stranger trading the vault
  - a swap below the oracle price
  - a swap on a stale price
  - a session-key swap without the price accounts
  - an over-limit oracle setting
  - a session-key swap from one token into another
- Pause: session keys stop while owners keep trading.
- Withdrawals and accounts:
  - the session key can't withdraw
  - the owner withdraws tokens and SOL, emptying the vault
  - closing the wrapped-SOL account returns it as SOL
  - closing a non-empty token account is refused
  - a buy of a token taken off the whitelist is refused

**Rust unit tests:** the rolling cap, and the oracle floor in both directions (including a 5-decimal token, the confidence band, bad prices and overflow).

**TypeScript tests:**
- Every instruction the website encodes by hand matches Anchor byte for byte.
- The route checks.
- The mainnet settings.

**Three independent reviews (October 2026).** Their findings shaped what's here:
- the oracle floor
- `route` only, with the fee account unset, because Jupiter ignores trailing bytes
- full account-state checks
- plain SPL tokens only
- the two-step admin handover
- direct routes
- pinned Pyth accounts and a fixed SOL/USD feed
- the confidence check
- lamports in the snapshot
- handing over the upgrade authority only after the owner proves the address
- the pinned program id on the website

## Security review, 27 October 2026 (before mainnet)

A full review of `programs/agents` at commit `eaf462d` (program unchanged since `f3e3956`; `oracle_floor` was corrected afterwards, see the correction below): two independent reviews of the code (the swap path; the oracle, roles and owner paths), cargo-audit and osv-scanner on `Cargo.lock`, and gitleaks on the repository. No Critical or High findings.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | Medium | The floor used Pyth's midpoint price, so a confidence band up to 2% wide loosened it, and the documented worst case left out the price's age, uncapped sells and round trips. | **Fixed (corrected 29 October 2026):** each side is valued at the cautious edge of its band: the input at `price + conf`, the output at `price - conf` (`oracle_floor`, unit test `oracle_floor_takes_the_cautious_side_of_the_confidence_band`, which now requires the banded floor to be above the midpoint floor). The first fix used the opposite edges, which lowered the floor; see the correction below. **Documented:** the age window and uncapped sells, in "What a stolen session key can do". A sell cap or a shorter price age is the owner's call. |
| 2 | Low | Session-key swaps relied on the whitelist alone to keep Token-2022 accounts out; the post-swap checks compare only the base 165 bytes of the accounts traded. | **Fixed:** session-key swaps require plain SPL Token accounts. It can't fail today, so no test can reach it; the end-to-end swaps confirm it lets normal trades through. |
| 3 | Low | A route can use the vault's forwarded signature on a third party's token account that names the vault as delegate. | **Accepted:** not the vault's money, and the net checks hold. Documented above. |
| 4 | Low | The session key can close empty vault token accounts while paused. | **Accepted:** rent goes to the vault; griefing only. Documented above. |
| 5 | Info | The `init-if-needed` Anchor feature was enabled but unused. | **Fixed:** removed. |
| 6 | Info | No events for `set_oracle`, `set_admin`, `close_token_account`; every Pyth error maps to `BadPrice`; two PDA derivations per session-key swap; `check_route` leaves Jupiter's token program, mint, event authority and program slots to Jupiter. | **Accepted:** no value at risk. Documented above or below. |
| 7 | Info | This document said traded accounts keep their lamports. | **Fixed:** corrected (wrapped SOL's balance is its lamports). |
| 8 | Info | Dependency advisories: borsh 0.10.4 (RUSTSEC-2023-0033, zero-sized types), block-buffer (panic), bincode and libsecp256k1 (unmaintained), rand 0.7.3 (unsound with a custom logger). All arrive through anchor-lang, solana-program and pythnet-sdk. | **Accepted:** none is reachable from the program (it deserialises no zero-sized types and uses no randomness). They go away with the next Anchor and Pyth SDK upgrades. |

What the reviews checked and found sound: the `route` discriminator (no other Jupiter instruction shares it) and its account and argument offsets; the trailing-bytes behaviour, contained by measuring what left the vault; account confusion (same mint or account on both sides, non-ATA vault accounts, repeated route accounts, a forged whitelist entry); the wrap step and caps; what a route can do with the vault's signature (transfers, rent, reassigning the vault, delegates, closing); reentrancy (refused by the runtime); Pyth verification level, feed id and account pinning; the floor's exponents, rounding and overflow; `init_platform`'s upgrade-authority check; the two-step admin handover; owner withdrawals and Token-2022 transfer hooks.

## Correction, 29 October 2026: confidence band direction

The first fix for finding 1 took the edges the wrong way round. It valued what the vault gives at `price - conf` and what it gets at `price + conf`, and the floor is `amount_in × p_in / p_out`, so both choices lowered the floor below the midpoint one. Its unit test asserted that (1 SOL at $150 ± 1% had to return only 147.03 USDC, banded floor below midpoint) while its comment said "never looser". With `MAX_CONFIDENCE_BPS` at 200, a stolen session key could fill about `max_slippage` plus twice the band (about 7%) below the market instead of 3%.

The program was not deployed to mainnet with this code. The corrected `oracle_floor` takes the input at `price + conf` and the output at `price - conf`, still refuses a band as wide as the price (on either side), and its unit test now expects 153.03 USDC for that buy and 1.020 SOL for the matching sell, and checks the banded floor is above the midpoint floor with and without slippage. The HyperEVM port (`hyper/src/PriceFloor.sol`, `test_confidenceBandTightensTheFloor` in water-bear86/agents-hyper) takes the same direction.

## Ask the auditor to look hardest at

1. Whether the post-CPI invariants fully contain anything a Jupiter route can do with the vault's signature, given that Jupiter forwards it to AMM programs.
2. The oracle floor math (`oracle_floor`), its exponents and rounding, and the Pyth verification settings.
3. The trailing-bytes behaviour of Jupiter's route parsing, and whether checking the fee account is enough to keep a fee from being paid. (Unverified: what Jupiter does with a non-zero fee and no fee account.)
4. Account confusion in `swap`: the input and output accounts appearing elsewhere in the route, duplicate accounts, Token-2022 mints on the owner's own swaps.
