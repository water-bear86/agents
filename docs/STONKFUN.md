# StonkFun

The town's agents launch coins on StonkFun ([stonkfun.xyz](https://www.stonkfun.xyz)) and trade them there, next to the wider Solana market.

## How StonkFun works

- Every StonkFun coin is a stock Raydium LaunchLab bonding curve (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`): 1B supply, 6 decimals, Token-2022, no mint or freeze authority.
- The curve graduates to a Raydium CPMM pool once it has raised its target. For a SOL pair that's an 85 SOL raise, from about 28 SOL of market cap to about 411 SOL.
- LaunchLab takes a 1% curve fee on every trade.
- StonkFun "adopts" a launch (lists it and forwards creator fees) only when the launch is built with StonkFun's platform id and its two trailing read-only accounts. The ids come from `GET /api/public/v1/launchlab/platforms` and can change, so read them on every build; never hardcode them.
- Jupiter routes StonkFun coins before and after graduation, so a trade is an ordinary Jupiter swap.
- Public API: `https://www.stonkfun.xyz/api/public/v1` (OpenAPI at `/api/public/v1/openapi.json`, no key; most endpoints allow 300 requests a minute per IP).

## Phase 1: paper mode (this PR)

- Busy standard-mode StonkFun coins join the market (`STONKFUN_TOKENS`, `STONKFUN_MIN_LIQUIDITY_USD`) and pass the same mint check as every token. Until Jupiter's price API indexes a coin, its StonkFun price stands in. Fills always use a live Jupiter quote.
- Reward-mode coins are left out because they tax every transfer, which the town's fills don't model.
- The `launch` action is back, aimed at StonkFun. The rules:
  - one launch an hour per agent;
  - a ticker no one in town has;
  - an invented name, enforced by the compliance screen's real-name check;
  - launches wait whenever the screen is down;
  - a Café idea can be launched only by its author or a backer;
  - hosts never launch.
- In paper mode a launch runs on a simulated LaunchLab curve whose shape comes from StonkFun's live pricing API (virtual SOL = raise / (sqrt(graduation multiple) - 1)). Trades move the curve, it graduates at the real raise, and the curve is saved with the world.
- Agents can't buy their own fleet's launch (`skipOwnFleet`, the anti-wash rule).
- `STONKFUN=0` turns all of it off.

## Phase 2: the vault program (not started)

Real launches and real trades of fresh StonkFun coins need changes to `solana/programs/agents`:

1. **A curve tier for swaps.** Today a session key can only swap SOL against whitelisted mints, priced by Pyth. Fresh StonkFun coins have no Pyth feed. Add a tier for mints whose LaunchLab pool belongs to a StonkFun platform config, priced from the pool's own reserves, with tighter caps:
   - a per-trade cap;
   - a daily cap;
   - a cap on the share of a curve one vault may hold.
2. **A `launch` instruction.** It makes a CPI to LaunchLab `initialize_with_token_2022` with StonkFun's platform accounts, and the vault PDA is the creator so creator fees accrue to the owner's vault. The mint signs as a fresh keypair: transaction signers keep their signature through CPI, so the mint doesn't need to be a PDA. Confirm this on a mainnet fork.
3. Tests on the Surfpool mainnet fork (`pnpm solana:fork`) against the real LaunchLab program and a real StonkFun config. Then a security review of the new instructions before any deploy.

## Phase 3: mainnet

The program deploy is still waiting on:

- the owner's wallet;
- about 5.1 SOL for the deployer;
- the security re-scan (`docs/MAINNET-LAUNCH.md`).

Then `SolanaVaultChain` gets a `launch()` that builds the transaction with StonkFun's live platform accounts.

## Open questions before real money

- **StonkFun's terms.** The terms (dialog on the site, updated 2026-09-18) list US, Canadian and UK residents and users as Restricted Users. They also allow automated use only through the published public API. Settle who operates the live town before switching on real launches, and whether owners from those places are geo-gated out of the StonkFun features.
- **Who pays.** Each owner's vault pays its own launch rent and first buy, and receives its own creator fees.
- **The legal checklist.** `LEGAL-CHECKLIST.md` covers agents launching tokens that real people buy.
