# Real-money launch checklist (Solana vaults, Jupiter)

This is the plan for letting owners put real SOL behind their agents. It sits on top of the deploy runbook in [MAINNET-LAUNCH.md](MAINNET-LAUNCH.md), which covers the program deploy step by step.

**The shape of it.** Real money runs on its own runtime, next to the paper town. Each owner funds their own agent's vault and can withdraw at any time. The runtime's session key trades only between SOL and a short whitelist of tokens, through Jupiter, at no worse than the Pyth price less 3%. StonkFun launches stay in the paper town: its terms bar users in Canada, the US and the UK, and its coins have no Pyth feed (see [STONKFUN.md](STONKFUN.md)).

Nothing in this document has been deployed or paid for. Steps marked 💸 spend real SOL, and the owner gives the go-ahead for each one.

## 1. The whitelist

The program accepts a token only if it is a plain SPL Token mint (not Token-2022) with a Pyth price account that Pyth itself keeps updated on Solana (a "sponsored" feed). Every session-key swap needs that price to be at most `maxAgeSeconds` old (60 s configured, 120 s ceiling) with a confidence band of 2% or less. The runtime adds one more rule: the town models every token with 6 decimals.

### What we checked (27 October 2026)

Pyth lists 422 USD feeds. 127 of them have a sponsored account on Solana, and most of those are no longer updated: the account still exists, but its last price is weeks or months old.

| Token | Sponsored feed | Mint | Liquidity (Jupiter) | Verdict |
|---|---|---|---|---|
| WIF | live | SPL, 6 decimals | about $5.6M | ✓ on the list |
| FARTCOIN | live | SPL, 6 decimals | about $5.6M | ✓ on the list |
| TRUMP | live | SPL, 6 decimals | about $19.8M | ✓ on the list |
| JUP | live | SPL, 6 decimals | about $5.1M | ✓ on the list (not a memecoin) |
| BONK | live | SPL, **5 decimals** | about $6.0M | Needs the runtime change below |
| MEW | live | SPL, **5 decimals** | about $9.1M | Needs the runtime change below |
| PUMP | live | **Token-2022**, 6 decimals | about $38M | Needs a program change |
| MET (Meteora) | live | SPL, 6 decimals | about $3.7M | ✓ could be added (not a memecoin) |
| POPCAT, PENGU, PNUT, GOAT, SPX6900, USELESS | **stale for months** | | | ✗ no usable price |

Feed ids (Pyth, USD):

| Token | Feed id |
|---|---|
| BONK | `72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419` |
| MEW | `514aed52ca5294177f20187ae883cec4a018619772ddce41efcc36a6448f5d5d` |
| PUMP | `7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9` |
| MET | `0292e0f405bcd4a496d34e48307f6787349ad2bcd8505c3d3a9f77d81a67a682` |

The four on the list today are in `solana/mainnet.config.json` with their feed ids.

**What this means.** With no code changes, the memecoins the vault can trade are the ones already on the list: WIF, FARTCOIN and TRUMP. Pyth has stopped updating the sponsored feeds of most other memecoins, so their prices are unusable.

### Ways to grow it

1. **5-decimal tokens (BONK, MEW): runtime change only.** The program already stores each token's decimals and uses them in the price floor. The runtime assumes 6 decimals everywhere (`tokenDecimals` in `packages/core/src/units.ts`, the mint checks in `apps/runtime/src/solana/paper.ts`, and the preflight in `mainnet.ts`). Making decimals per token is a moderate change, with tests, and needs no new program review.
2. **Token-2022 (PUMP): program change.** `AllowMint` requires the SPL Token program. Allowing Token-2022 means checking each mint's extensions (no transfer fee, no transfer hook, no permanent delegate), then a new review and a program upgrade before or after launch. PUMP is by far the most liquid candidate, so this is worth considering after launch.
3. **Re-check before deploy day.** Pyth starts and stops sponsoring feeds. The preflight checks every configured feed's age, and the admin removes tokens whose feed goes stale.

## 2. Feed timing and the 60-second limit

We read 20 sponsored feeds every 4 seconds for 15 minutes:
- **SOL/USD** updates about every 10 seconds. Its age never passed 21 s.
- **Every token feed** (WIF, FARTCOIN, TRUMP, JUP, BONK, MEW, PUMP, MET and the others) updates about once a minute: a median gap of 53 s and a longest gap of 55 to 61 s. Its age just before the next update reached 57 to 61 s.
- **Confidence** stayed well inside the 2% limit: 0.2% at most for the listed tokens, 0.45% for MEW.

**What this means.** With `maxAgeSeconds` at 60, a swap that lands in the last few seconds before a token feed's next update is refused as stale. That's a small share of trades, but it includes exits. A stop loss that fires at the wrong second fails, and the watcher tries again on its next pass.

**Suggestion: set `maxAgeSeconds` to 90.** That's still inside the program's 120 s ceiling, and it removes those refusals. The cost is that a price up to 90 s old sets the floor, so the 3% slippage band is measured from slightly further back.

**The bigger effect on fast tokens.** The floor is "no worse than a price up to a minute old, less 3%". When a token moves more than about 3% within a minute:
- buys are refused while it rises, which protects the vault;
- sells are refused while it falls, so a stop loss can't get out until the feed catches up.

The 3% band is set in the config (the program allows up to 5%). A wider band lets stop losses through in fast drops, but it also lets a bad fill through. Decide this with the per-style timeframes: the vault suits trades that last minutes to hours, not seconds.

## 3. Before anything is spent

- [ ] **Security scan of the vault commit.** The deploy was put on hold until the scan is rerun on the vault program. The program changed on 29 October 2026 (the confidence band in `oracle_floor` now raises the floor instead of lowering it; see `solana/AUDIT.md`), so scan `solana/programs/agents` at the `main` commit that includes that fix. Fix or accept every finding in writing.
- [ ] **Decide on an external audit.** `solana/AUDIT.md` is an internal review and says so. Real money from other people is the point where an outside audit normally comes in. At the least, cap what each vault can hold or trade at launch (below) until one is done.
- [ ] **Legal read.** The runtime trades other people's money from Canada. Get a lawyer's view on running a trading service for third parties (this is separate from whether the coins are securities), plus terms of use and a risk notice owners accept before funding a vault.
- [ ] **Reproducible build and fork test.** Follow MAINNET-LAUNCH.md step 2: `solana-verify build`, record the hash, run the end-to-end test on a mainnet fork with that exact file.
- [ ] **Keyed RPC.** Get a paid Solana RPC (Helius or similar). The public endpoint already refuses the paper runtime's requests ("HTTP 403"), and the deploy writes about 500 buffer transactions.
- [ ] **Real wallet test.** Create an agent, fund it, and withdraw with Phantom and with one other wallet on a mainnet fork or devnet. Wallet extensions haven't been tested with the real flows yet.
- [ ] **Launch limits.** Pick small numbers for the first weeks: the per-trade cap (`max_trade`) and the daily cap (`daily_limit`) the create page sets, and a stated maximum deposit per vault.

## 4. 💸 Deploy (owner's go-ahead for each step)

Follow MAINNET-LAUNCH.md steps 3 to 6:

- [ ] Preflight with the paid RPC: every line ✓ or ·.
- [ ] 💸 Fund the deployer with about 4.9 SOL and deploy (about 2.36 SOL stays as program rent, the rest is refunded).
- [ ] 💸 Set up the platform: oracle settings, whitelist, owner proposed as admin.
- [ ] 💸 Verify the build, the owner accepts admin on `/admin`, hand the upgrade authority to the owner, empty and retire the deployer.

## 5. The real-money runtime

- [ ] **A second Render service**, not the paper one. The paper town keeps running as it is. Settings are in MAINNET-LAUNCH.md step 7: `CHAIN_FAMILY=solana`, the paid `SOLANA_RPC_URL`, `SOLANA_ALLOW_MAINNET=1`, `SOLANA_SESSION_KEYPAIR`, a browser-safe `SOLANA_PUBLIC_RPC_URL`, `JUPITER_API_KEY`, and no `PAPER`.
- [ ] **Session key made on that server** and never copied off it. Put only its public key in `runtime.sessionKeyPublic` in `solana/mainnet.config.json`.
- [ ] **Its own `ADMIN_KEY`**, different from the paper runtime's, kept somewhere only the owner can read.
- [ ] **A web front end pointed at it**, a separate Vercel project or a clearly marked real-money section, so nobody mistakes paper for real or the other way round.
- [ ] **Exit watcher on.** Stop losses and take profits run every few seconds (`EXIT_WATCH_MS`). They sell through the same oracle floor, so a sell fails if the price fell more than 3% between the Pyth update and the fill. Watch the logs for refused exits in the first days.
- [ ] **Agents start small.** Owners create and fund agents themselves on the create page. The paper town's agents and their records don't move over.

## 6. First days

- [ ] Run the first real agents with the owner's own money only, for at least a few days, before inviting anyone else.
- [ ] Check every trade's receipt against the chain, and that withdrawals work at any time.
- [ ] Keep the pause switch on `/admin` in mind: it stops every session key, and owners can still withdraw.
- [ ] Re-run the preflight weekly and drop any token whose feed goes stale.
