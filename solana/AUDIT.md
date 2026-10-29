# Security review of the Solana program (pre-audit)

This is an internal review and the scope for an external audit. It is **not** a substitute for one.

## Scope

| Program | Id | Lines | What it does |
|---|---|---|---|
| `programs/agents` | `4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r` | about 750 (with tests) | Agent registry and vaults. Owners fund and withdraw. The runtime's session key swaps through Jupiter within caps, at no worse than the Pyth price. The admin keeps a token whitelist and a pause switch. |

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
  - one side SOL and the other a whitelisted token
  - fresh Pyth prices for SOL (a fixed feed id) and the token

  The prices must come from Pyth's own sponsored feed accounts, not from an update anyone could post for a moment of their choosing. They must be fully verified, at most `max_age` old, with a confidence band within 2% of the price. They give `floor = fair value × (1 − max_slippage)`.
- For a session-key buy, the caps apply.

**After the CPI:**
- What left the input account is at most `amount_in`.
- What arrived in the output account is at least `min_out` and at least the floor.
- The vault's SOL didn't fall, and the vault is still system-owned with no data.
- Every vault token account in the route, input and output included, still belongs to the vault and kept its lamports. The input and output accounts are unchanged apart from their balances: no delegate, close authority or state change. Every other vault token account is unchanged byte for byte.

## What a stolen session key can do

It can trade at up to `max_slippage_bps` (300 bps on mainnet) worse than the sponsored oracle price, which includes sandwiching its own trades. Buys are capped. The rolling cap refills `daily_limit` per day, so up to about twice `daily_limit` can be spent in any 24 hours.

**Worst case per agent:** about 3% of its token holdings once, plus about 3% of what it is allowed to buy each day. One session key serves every agent, so the same bound applies to all of them at once. The owner can revoke the key at any time (`set_session` with the default key), and the admin can pause every session key at once.

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

## Testing done

**`apps/runtime/src/solana/e2e.ts`: 37 checks**
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

**Rust unit tests:** the rolling cap, and the oracle floor in both directions (including a 5-decimal token, bad prices and overflow).

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

## Ask the auditor to look hardest at

1. Whether the post-CPI invariants fully contain anything a Jupiter route can do with the vault's signature, given that Jupiter forwards it to AMM programs.
2. The oracle floor math (`oracle_floor`), its exponents and rounding, and the Pyth verification settings.
3. The trailing-bytes behaviour of Jupiter's route parsing, and whether checking the fee account is enough to keep a fee from being paid. (Unverified: what Jupiter does with a non-zero fee and no fee account.)
4. Account confusion in `swap`: the input and output accounts appearing elsewhere in the route, duplicate accounts, Token-2022 mints on the owner's own swaps.
