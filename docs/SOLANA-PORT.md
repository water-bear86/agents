# The launchpad on Solana

Status on 2026-10-15, branch `solana-port`. Nothing here touches `contracts/`, deploys to mainnet or spends real funds.

## Summary

**The port is built.** Every rule the EVM contracts enforce is now enforced on Solana by two Anchor programs, working with Meteora's Dynamic Bonding Curve (DBC):

- `agents` covers the registry, the agent vaults, the launch gate and the fee split.
- `agents_hook` is a Token-2022 transfer hook that keeps each coin agents-only until it opens.

The runtime trades through the vaults with only its session key, and the website creates agents and withdraws from vaults with the owner's own Solana wallet.

| | |
|---|---|
| Programs | `solana/programs/agents` (`4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r`), `solana/programs/agents_hook` (`8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9`) |
| Venue | Meteora DBC (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`), with coins graduating to DAMM v2 |
| Proof | `pnpm --filter @agents/runtime solana:e2e`: 31 on-chain checks, all passing on a local validator running the devnet DBC program |
| Tests | Typecheck green on all 7 packages; unit tests passing (runtime 41, core 22, others 13); Rust id test |
| Review | `solana/AUDIT.md` (scope, trust model, points for the auditor) |
| Not done yet | Devnet deployment (the key is unfunded on devnet; see [Deploying](#deploying)), external audit, mainnet |

## Why this path

We built the fast path: an existing venue plus our own programs. Of the three venues below, DBC is the only one that lets us set our own fee *and* enforce an agents-only phase on-chain, because it supports a Token-2022 transfer hook on the coin.

A launch program entirely our own (the "faithful path") would have kept the EVM design one to one. It would also have cost 5 to 7 weeks, roughly doubled the audit, and left the coins in a pool no aggregator routes.

| | pump.fun | Meteora DBC | Raydium LaunchLab |
|---|---|---|---|
| Our own fee rate and share | No. pump.fun sets the rates. | Yes. Base fee set per config. Meteora takes 20% of trading fees. The partner and creator split the rest. | Yes. Platform plus creator fee on top of Raydium's own fee. |
| Creator-fee routing | Any address. Fee sharing to up to 10 recipients. | Creator share to the pool creator (our vault PDA). Partner share to the config's `fee_claimer` (our `fees` PDA). | Creator vault keyed on `creator` (can be a PDA) |
| Token-2022 | Yes, but pump creates the mint, so we can't add a hook | Yes, **including a transfer hook** | Transfer-fee extension only |
| Agents-only phase on-chain | Not possible | **Possible**, through our hook | Not possible |
| Liquidity after graduation | LP burned | Configurable. We lock 100% permanently, and the locked positions still earn fees. | Locked platform share plus a burned share |
| Devnet | Yes | Yes (same program id) | Yes |

Sources are in `side-session-notes/.../solana-venues-research.md`.

## Every rule, and where Solana enforces it

| Rule today (EVM) | On Solana | Checked by |
|---|---|---|
| **Owner-only withdrawals** (`AgentAccount.withdraw*`) | Each agent's SOL and coins sit in a vault PDA (`["vault", agent]`). Only `withdraw_sol` and `withdraw_token` move funds out, and both require the owner's signature. | e2e: "the session key withdraws from a vault" refused; the owner withdraws |
| **Per-trade and daily caps** (`maxTradeWei`, `dailyLimitWei`; sells uncapped) | `buy` checks `max_trade` and a rolling daily `spent_today` for the session key. The owner is uncapped. Sells are uncapped. | e2e: over the per-trade cap, over the daily cap, at the cap |
| **minOut required** | `buy` and `sell` refuse `min_out = 0`. DBC enforces the minimum, and the program checks the fill again. | e2e: minOut 0, unreachable minOut |
| **Launchpad pools only** (`NotHookPool`) | Trades need the coin's `Coin` record, with `coin.pool == pool` and the pool's config equal to the platform's. | Enforced in `swap()`; covered by every trade in the e2e |
| **Session key's powers** | Only the owner or the session key can operate an agent. Swap input and output accounts must be owned by the vault. | e2e: "a stranger signing as the operator" refused |
| **Agents-only until the threshold or `opensAt`** (`beforeSwap`, `afterSwap`) | The transfer hook allows a coin to move only into the pool or into a registered agent vault until the coin opens. It opens by time (the hook reads the clock) or by threshold (`open_coin`, a permissionless crank the runtime sends each pass). | e2e: an outsider's direct DBC buy refused during the phase and allowed after opening; the crank opens by threshold |
| **Locked liquidity** | During the curve, DBC's vaults hold everything and no instruction removes it. At graduation, 100% of the DAMM v2 LP is permanently locked (50% partner, 50% creator). | DBC; `agentsCurve()` |
| **1% fee, 80/10/10** | 1.25% gross. Meteora keeps 20%, leaving 1%. The creator share is 80% of that, claimed into the agent's vault (`claim_creator_fees`). The platform's 20% goes to the `fees` PDA, and `distribute_fees` splits it evenly to the inference pool and the buyback wallet. Payouts are pull-based. | e2e: launcher share 80.0%, inference equals buyback |
| **Token-side fees burned** | Moot: fees are taken in SOL only, so no token-side fee exists | `CollectFeeMode.QuoteToken` |
| **1-hour launch cooldown, only agents launch** | `launch` checks the operator and the cooldown, then calls DBC. Only coins launched this way get hook accounts, so a pool someone else creates on our public DBC config can never trade. | e2e: second launch refused; stray pool untradeable |
| **Handles** (2 to 15 characters, a-z and 0-9, unique) | Validated in `create_agent`. The `["agent", handle]` PDA makes handles unique. | e2e: bad handle, taken handle |
| **Locked model** | Stored at creation; no instruction updates it | |
| **Platform-token slot gating** | `create_agent` checks the owner's balance of `platform_mint` (off when it is unset), at creation only, as on EVM | |
| **Fixed supply, no minting** | 1B supply at 6 decimals, mint authority revoked (`TokenAuthorityOption.Immutable`) | DBC config |
| **Immutable setup** (constructor arguments) | `init_platform` runs once, and only the program's upgrade authority can call it | e2e: a stranger front-running setup is refused |

There are three differences, all deliberate:

- **Owners can't pull coins out during the phase.** During a coin's agents-only phase, an owner can't move its coins to their own wallet; the hook applies to everyone. They can sell, and they can withdraw coins once the coin opens.
- **Threshold opening needs a crank.** It takes an `open_coin` call rather than happening inside the swap. Time-based opening needs no call.
- **The programs are upgradeable.** The EVM contracts weren't. Decide before mainnet (see below).

## Where Metaplex fits

- **Coin metadata.** Coins are Token-2022 mints, so DBC writes name, symbol and URI into the mint's own metadata extension, not a Metaplex Token Metadata account. The `Coin` record in our program also stores name and symbol, and that is what the indexer reads. The `uri` JSON needs hosting (`COIN_URI_BASE`; Arweave via Irys, or our CDN).
- **Agent identity: the Metaplex Agent Registry (`mpl-agent`).** Not built, and recommended as a follow-up. Register each agent's identity (a Core NFT with an `AgentIdentity` plugin, program `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p`) and link its coin with `setAgentTokenV1`, for discoverability and reputation. Our own registry stays the gate: anyone can register a Metaplex identity.
- **"Nori".** We found no Metaplex product by that name.

## What's on the branch

1. **Programs** (`solana/`, Anchor 0.32)
   - `agents`: `init_platform`, `create_agent`, `set_session`, `withdraw_sol`, `withdraw_token`, `buy`, `sell`, `launch`, `open_coin`, `claim_creator_fees`, `distribute_fees`.
   - `agents_hook`: `initialize_extra_account_meta_list` (only the agents program can call it), `transfer_hook`.
   - DBC is called by raw CPI using its IDL in `solana/idls/`.
   - `Cargo.lock` is resolved for the SBF toolchain's Rust 1.79.
2. **Runtime** (`apps/runtime/src/solana/`)
   - `program.ts`: PDAs, instruction builders, and the hook accounts. Meteora's SDK resolves those with placeholder addresses, which doesn't work for a hook that looks at the receiver, so we build them ourselves.
   - `chain.ts`: `SolanaAgentChain`, which implements the runtime's `Chain`.
   - `indexer.ts`: the quoter and indexer, plus cranks for opening and fees.
   - `dbc.ts`: reads DBC pools, including transfer-hook pools, and quotes with the SDK's exact swap math. It also builds the platform's curve config.
   - `setup.ts`: platform setup and `create_agent`.
   - `e2e.ts`: the 31-check run.
   - `main.ts` runs the scheduler on Solana with `CHAIN_FAMILY=solana`, `SOLANA_RPC_URL`, `SOLANA_SESSION_KEYPAIR` and `AGENTS_JSON` handles. Mainnet is refused unless `SOLANA_ALLOW_MAINNET=1`.
3. **Units** (`packages/core/src/units.ts`, `apps/web/lib/units.tsx`). SOL has 9 decimals and coins 6, Solana addresses are base58, and prices, prompts, presets, XP and badges all follow the chain. The EVM path is unchanged.
4. **Web**
   - `/v1/chain` publishes the units, the program id, the session key and a public RPC URL. A keyed RPC URL is never sent to the browser.
   - On Solana, the create page has the owner's wallet (Phantom, or any `window.solana`) create the agent and fund its vault.
   - The agent page shows the vault and an owner-only withdrawal.
   - The hand-encoded instructions are tested byte for byte against Anchor's.
   - Landing and create-page copy use the chain's symbol.

The branch's first commit is a snapshot of `ui-redesign`'s uncommitted work, so the port builds on the redesign. Drop it and rebase once `ui-redesign` commits its own work.

## Running it

Keys live outside the repo in `~/.config/agents-solana-devnet/` (override with `SOLANA_KEY_DIR`). Program keypairs stay in `solana/target/deploy/`, which git ignores.

```bash
cd solana && anchor build
```

```bash
pnpm --filter @agents/runtime solana:validator
```

```bash
SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm --filter @agents/runtime solana:e2e
```

The validator command loads both programs as upgradeable, with `runtime.json` from the key directory as their upgrade authority, and clones DBC from devnet. The e2e script sets up the platform on first run, creates agents from owner wallets, and checks every rule.

To run the scheduler on the result (demo model, no LLM spend), use handles of agents created with the session key:

```bash
CHAIN_FAMILY=solana SOLANA_RPC_URL=http://127.0.0.1:8899 SOLANA_SESSION_KEYPAIR=~/.config/agents-solana-devnet/runtime.json AGENTS_JSON='[{"handle":"..."}]' pnpm --filter @agents/runtime start
```

## Deploying

**Devnet** needs about 10 devnet SOL on `4y1rXfuv5tBrbppDAScRegDLvtrv9bZXBjaKNchL8y3L`. The two programs are 516 KB and 230 KB, roughly 5.2 SOL of rent, plus temporary deploy buffers. Use faucet.solana.com with **Devnet** selected; testnet SOL doesn't help, because DBC isn't deployed on testnet. Then:

```bash
cd solana && anchor deploy --provider.cluster devnet
```

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com pnpm --filter @agents/runtime solana:e2e
```

**Before mainnet:**

1. An external audit of both programs (`solana/AUDIT.md`).
2. Decide on the upgrade authority: a multisig with a timelock, or immutable.
3. Real thresholds in SOL. The graduation threshold must sit above the open threshold.
4. Coin metadata hosting.
5. A devnet soak with the real LLM loop.
6. Confirm aggregators resolve our hook accounts. Jupiter-style resolvers using real accounts should; Meteora's own SDK helper doesn't.

## Decisions for the owner

1. **Thresholds in SOL.** The open threshold (the smoke config uses 0.05 SOL) and the graduation threshold (5 SOL in the test config).
2. **Fee.** 1.25% gross for 1% net (built), or 1% gross for 0.8% net.
3. **Upgrade authority.** Multisig with a timelock, or freeze the programs after the audit.
4. **Platform token for slot gating** (off until set): which SPL mint, and how much per slot.
5. **Metadata hosting** for coin JSON.
6. **XP and badges.** They count thousandths of SOL now (0.001 SOL earns what 0.001 ETH did). Rescale?
7. **Keep EVM alive?** Runtime and web run either chain. Pick one for launch, or run both.
8. **Metaplex Agent Registry** for agent identity (recommended follow-up).

## Coordination with ropet (the EVM side)

ropet authored every commit on `main`, including `contracts/`, the runtime and the MetaMask create flow.

- **`contracts/`** is untouched. If Solana is the launch chain, further EVM contract work (and the planned EVM testnet run) should pause, and the audit budget moves to `solana/AUDIT.md`.
- **Shared files.** This branch edits:
  - runtime: `chain.ts`, `main.ts`, `actions.ts`, `tick.ts`, `world.ts`
  - core: `risk.ts`, `plan.ts`, `progress.ts`
  - web: `api.ts`, `ui.tsx`, `units.tsx`, the pages, `layout.tsx`, the create flow

  The EVM defaults and the MetaMask flow are unchanged, but merge order matters. `ui-redesign` (uncommitted), `agent-token` and this branch all overlap.
- **Convention.** No new `1e18` or `"ETH"` literals. Runtime amounts go through `world.units`, and the web through `useUnits()`.
- **Review asks for ropet.** The Solana create flow (`apps/web/lib/solana.ts`), and whether the runtime's `Chain` and indexer shapes still suit the EVM side.
