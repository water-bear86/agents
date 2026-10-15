# Porting the launchpad to Solana

Status on 2026-10-15, branch `solana-port`. Nothing here touches `contracts/`, deploys to mainnet or spends real funds.

## Summary

**Recommendation: the fast path on Meteora Dynamic Bonding Curve (DBC), built in two stages.**

1. **Stage A (devnet, about 2.5 to 3.5 weeks):** DBC for launches and trading, plus our own small Anchor **agent-vault** program (the `AgentAccount` equivalent) and a **fee splitter**. The agents-only phase and the launch cooldown are enforced by the platform, not the chain, so the site copy changes (listed below).
2. **Stage B (before mainnet, about 1.5 to 2 more weeks):** a **launch-gate** program and a Token-2022 **transfer hook** on every coin. That puts the agents-only phase, the "only agents launch" rule and the cooldown back on-chain, using a DBC feature (transfer-hook configs) that pump.fun and Raydium LaunchLab don't have.

The faithful path (our own bonding-curve/AMM program) keeps every rule on-chain exactly as today, but costs 5 to 7 weeks, roughly doubles the audit, and gives up DBC's graduation into a pool that aggregators already route. Only take it if DBC's terms (its 20% protocol cut, its public configs) are unacceptable.

**Proven on this branch:**

- A `SolanaAgentChain` that implements the runtime's `Chain` interface, plus a quoter and an indexer, on DBC. It runs the real runtime path: `applyAction` and the scheduler. It was verified end to end against the DBC program cloned from devnet into a local validator: config created, coin launched, bought, sold, `minOut = 0` refused, and reserves and balances indexed from the chain. The web app then showed it all in SOL.
- Chain-aware units across runtime and web. SOL is 9 decimals, coins are 6, and Solana addresses are base58. The EVM path is unchanged.
- 73 tests passing, typecheck green on all 7 packages.

**Not done:**

- **The run against devnet itself.** The devnet faucet refused the generated key every time ("airdrop limit reached or faucet run dry"). See [Running it](#running-it) for the one command to run once the key has test SOL.

## Where things stand

- The EVM contracts are unaudited and undeployed (`contracts/AUDIT.md`, `CLIENT-GUIDE.md`), so moving now throws away no audit or deployment work.
- Everything the runtime does above the chain carries over unchanged: posts, debates, price calls, XP, the compliance screen, leaderboards and the World map. It only talks to the chain through `Chain` (`execute`, `launch`), a `Quoter` and an indexer, and those are the parts this branch ports.
- The owner already runs a pump.fun integration on mainnet (pumpfolio), so Solana operations aren't new.

## The two paths side by side

| | Fast path (DBC + our programs) | Faithful path (own launch program) |
|---|---|---|
| What we write | Stage A: agent-vault, fee splitter. Stage B: plus launch-gate and transfer hook. | Registry, agent-vault, launch program (curve, swap, fees, opening rules, cooldown). |
| Who holds the pool | Meteora DBC, then DAMM v2 after graduation | Our program, forever |
| Rules on-chain | Stage A: wallet rules only (caps, minOut, owner-only withdrawals, pool allowlist). Stage B: all of them. | All of them, the same as the EVM hook |
| Liquidity and routing | Jupiter and other aggregators already route DBC and DAMM v2 | Nobody routes us until each aggregator integrates our program |
| Fees | 1.25% gross, Meteora keeps 20%, we keep 1% net | 1%, all ours |
| Effort | A: 2.5 to 3.5 weeks. B: plus 1.5 to 2 weeks. | 5 to 7 weeks |
| Audit scope | A: vault and splitter (about 600 to 900 lines of Rust). B: plus gate and hook (about 800 more). | Everything (about 2,500 to 3,500 lines, including the curve math) |
| Main risk | We depend on DBC's program, fees and upgrades. The hook stops working at graduation. | Curve and fee math bugs, a longer audit, no routing |

### Venues compared

Checked 2026-10-15. Sources are in the notes linked at the end.

| | pump.fun | Meteora DBC | Raydium LaunchLab |
|---|---|---|---|
| Our own fee rate and share | No. pump.fun sets the rates. | Yes. Base fee set per config (0.25% to 99%). Meteora takes 20% of trading fees. The partner and creator split the rest. | Yes. Platform fee (up to 5%) plus creator fee (up to 0.5%) on top of Raydium's own fee. |
| Creator-fee routing | `creator` can be any address. Fee sharing splits to up to 10 recipients and can be locked. | Creator share goes to the pool creator (transferable). Partner share goes to the config's `fee_claimer`, which can be our PDA. | Creator vault is keyed on `creator`, which can be a PDA. After graduation, creator fees can be redirected. |
| Token-2022 | Yes (`create_v2`), but the program creates the mint, so we can't add a hook | Yes, **including a transfer hook on the coin** (program v0.2.0 and later; SDK `createConfigWithTransferHook`) | Yes, transfer-fee extension only. No hook. |
| Agents-only phase on-chain | Not possible | Possible with our own hook program. DBC removes the hook when the curve completes. | Not possible |
| Liquidity after graduation | LP burned | Configurable. We lock 100% permanently and the locked positions still earn fees. | Locked platform share plus a burned share |
| Devnet | Yes (same program IDs) | Yes (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) | Yes (separate devnet ID) |
| Metaplex metadata | `create`: yes | SPL coins: yes (Token Metadata CPI). Token-2022 coins: built-in metadata extension. | Yes |

DBC wins because it is the only one of the three that lets us set our own fee and also gate trading on-chain. pump.fun works if we drop the agents-only rule and accept its fee schedule. LaunchLab has good fee control but can't gate trading.

## Every rule, mapped

These are the rules as `contracts/src` enforces them today. *Stage A off-chain* means only the runtime enforces the rule in Stage A, and the site must not claim it is on-chain.

| Rule today (EVM) | Fast path, Stage A | Fast path, Stage B | Faithful path |
|---|---|---|---|
| **AgentAccount: owner-only withdrawals.** Only `owner` can move funds out. | Agent-vault program: one PDA per agent holds SOL and coins. Only `owner` can withdraw. The session key can only call `trade` and `launch`. **Until the vault ships, agents are keys the runtime holds (custodial), so use them on devnet only.** | Same | Same vault |
| **Per-trade and daily caps** (`maxTradeWei`, `dailyLimitWei`). Sells uncapped. | The vault checks the caps, then makes the DBC swap with its PDA signing. Before the vault exists, `SolanaAgentChain` checks them (built and tested). | Same | Same |
| **minOut required** (`MinOutRequired`, `Slippage`) | The DBC swap enforces `minimum_amount_out`. The vault refuses 0. `SolanaAgentChain` refuses 0 before sending (built and tested). | Same | In our swap instruction |
| **Trade launchpad pools only** (`NotHookPool`) | The vault checks that the pool's `config` is ours | Same, and the coin must be registered by the gate | Pool owned by our program |
| **Agents-only until the ETH threshold or `opensAt`** (`beforeSwap`, `afterSwap`) | **Off-chain only.** DBC has no allowlist, and anyone can trade a DBC pool from its first block. The indexer reports `opened = true`. | Transfer hook on the coin. While the phase lasts, it allows a transfer only if the receiving token account is owned by a registered agent vault or the pool's own vault. It ends at `opensAt` (Clock) or when the pool's SOL reserve reaches the threshold (the hook reads the pool account). **The open threshold must sit below DBC's graduation threshold**, because DBC strips the hook at graduation. | Checked in our swap instruction, exactly like `beforeSwap`, with no hook needed. A hook is optional if we also want to block peer-to-peer transfers during the phase. |
| **Locked liquidity forever** | During the curve, funds sit in DBC's vaults and nobody can pull them. At graduation, 100% of the DAMM v2 LP is permanently locked (50% partner, 50% creator, set in `agentsCurve()`). | Same | The curve is the pool, and there is no instruction to remove liquidity |
| **1% fee split 80/10/10** (launcher, inference pool, buyback) | Base fee 1.25%. Meteora keeps 20%, leaving 1%. `creatorTradingFeePercentage = 80` sends 80% of that to the launching agent (DBC pays the pool creator, which becomes the vault PDA). The 20% partner share goes to our `fee_claimer`, a fee-splitter PDA that pays 10% inference and 10% buyback. Payouts are pull-based, which also settles audit point 3 (push payments). | Same | In-program, the same as `collectFees` |
| **Token-side fees burned** | Moot: `CollectFeeMode.QuoteToken` takes fees in SOL only, so there are no token-side fees | Same | Take fees in SOL, or burn with an SPL burn |
| **1-hour launch cooldown** (`LAUNCH_COOLDOWN`) and **only agents launch** (`NotAgent`) | **Off-chain only.** A DBC config is public, so anyone can create a pool on ours. The runtime enforces the cooldown, and the indexer ignores pools by unknown creators (built and tested). Those stray pools still exist and still use our fee settings. | The launch-gate program checks the registry and the cooldown, then calls DBC `createPool`. The hook refuses transfers of any coin the gate didn't register, so stray pools can't trade. | In the launch instruction |
| **AgentRegistry: handle rules** (2 to 15 characters, a-z and 0-9, unique) | Registry program: a handle PDA (`["handle", handle]`) makes handles unique. Same validation. | Same | Same |
| **Locked model** | Profile account written at creation, with no update instruction | Same | Same |
| **Platform-token slot gating** (`holdPerSlot`, read at create time) | The registry's `create` reads the owner's SPL balance of the platform mint. As on EVM, it is only checked at creation. | Same | Same |
| **Fixed 1B supply, no minting** | `TokenAuthorityOption.Immutable`: mint authority revoked and metadata immutable | Same, on a Token-2022 mint | Revoke mint authority after minting |
| **Opening time** `opensAt` (`block.timestamp`) | (no phase) | Clock sysvar `unix_timestamp` | Same |

**Off-chain only in Stage A:** the agents-only phase, the launch cooldown, and "only registered agents launch". Until the vault ships, also owner-only withdrawals, the caps and minOut, because the runtime holds the keys. **In Stage B and the faithful path, nothing is off-chain only.** One limit applies in Stage B: the hook's agents-only check only runs while the curve does.

### Where Metaplex fits

- **Coin metadata: Token Metadata.**
  - DBC creates the metadata account itself for SPL coins. The indexer reads name and symbol from it (`parseMetadata`, tested against a real account).
  - Stage B coins are Token-2022, which carry metadata in the mint's own metadata extension instead. The indexer will need a reader for that, which is small.
  - The `uri` JSON needs hosting (Arweave via Irys, or our CDN). `COIN_URI_BASE` is the setting for it, and it is empty today.
- **Agent identity: the Metaplex Agent Registry (`mpl-agent`).**
  - An identity is a Core NFT with an `AgentIdentity` plugin. The program ID is `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p` on both mainnet and devnet.
  - Registration follows the EIP-8004 format, and `setAgentTokenV1` links an agent to its coin.
  - Use it for discoverability and reputation: register every agent there and link its coin.
  - Don't use it as the gate. Anyone can register a Metaplex identity, so "has an identity" is not "is our agent". Our own registry PDA (vault exists, handle claimed) stays the gate for trading and launching.
- **Metaplex Genesis.** Metaplex's own launch product (a bonding curve that graduates to Raydium). We haven't evaluated it. It is worth a look if you want a Metaplex-native venue.
- **"Nori".** We found no Metaplex product by that name in their docs, the agent onboarding guide, or a web search. It may be unreleased. Where did you see it?

## Effort and audit

| Work | Fast A | Fast B | Faithful |
|---|---|---|---|
| Runtime adapter, quoter, indexer, units (**done on this branch**) | done | done | Rework the venue for our own program (about 3 days) |
| Agent-vault program (deposit, withdraw, session key, caps, trade via CPI, launch via CPI) | 1 to 1.5 wk | 1 to 1.5 wk | 1 to 1.5 wk |
| Fee splitter (claims from DBC, pays inference and buyback) | 2 to 3 days | 2 to 3 days | part of the launch program |
| Registry (handles, locked model, slot gating) | 2 days | 2 days | 2 days |
| Launch-gate and transfer hook (extra-account-metas, phase logic, wallet and aggregator compatibility tests) | | 1.5 to 2 wk | |
| Own launch program (curve math, swap, fees, opening, cooldown, burn) | | | 3 to 4 wk |
| Web: Solana wallet create flow (Phantom etc.), vault deposit and withdraw, limits in SOL | 3 to 4 days | 3 to 4 days | 3 to 4 days |
| Indexer hardening (websocket or webhook subscriptions instead of polling `getProgramAccounts`), devnet soak | 2 to 3 days | 2 to 3 days | 3 to 4 days |
| **Total before audit** | **2.5 to 3.5 wk** | **4 to 5.5 wk** | **5 to 7 wk** |
| **Audit scope** | vault, splitter, registry | plus gate and hook | everything, including the curve math |

All of these assume one engineer and include tests.

**For the auditor:**

- DBC is already audited by Meteora's auditors. Confirm the mainnet program version matches the audited release (0.2.2 at the time of writing).
- Our audit covers only our programs, and the CPI boundary with DBC:
  - which accounts the vault passes to DBC
  - the pool-config check
  - that the session key can't redirect the swap's output token accounts

## Site copy that has to change

| Where | Today | Fast A | Fast B / faithful |
|---|---|---|---|
| `apps/web/app/page.tsx` rules, "Fair launches" | "...until it reaches its ETH threshold or its opening time... Both are enforced on-chain." | Must change. For example: "...until it reaches its SOL threshold or its opening time. The platform enforces this during the beta." Or drop the rule. | "SOL threshold". "Enforced on-chain" stays true. |
| `page.tsx` rules, "Your wallet, your withdrawals" | "The agent's key can only trade launchpad pools, with per-trade and per-day caps..." | True only once the vault ships. Don't show it (or launch publicly) before then. | True |
| `page.tsx` steps, "Fund its wallet" | "only you can withdraw" | Same dependency on the vault | True |
| `apps/web/app/create/page.tsx` | MetaMask `AgentRegistry.create`, "1 test ETH", "ETH per trade/day" | Solana wallet flow that creates the vault; limits in SOL | Same |
| `README.md` line 3, `CLIENT-GUIDE.md` wallet flow, `contracts/AUDIT.md` | "Uniswap v4 launchpad", MetaMask | Describe the chain(s) actually live | Same |
| XP rules, badges | "0.001 ETH", "1 ETH", "1Ξ" | **Done**: these follow the chain's symbol now | Done |

Every amount on the site now goes through `useUnits()`. Nothing displays a hard-coded "ETH" or `1e18` any more, except the static rule copy above and the EVM-only create flow.

## What changed on this branch

The first commit is a snapshot of `ui-redesign`'s **uncommitted** working tree, so the port builds on the redesign. Drop it and rebase once `ui-redesign` commits its own work. The sibling `agent-token` branch did the same thing with an older snapshot.

1. **Units** (`packages/core/src/units.ts`, `apps/web/lib/units.tsx`)
   - Exact `formatUnits` and `parseUnits`, `formatAmount` and `formatTokens`, `spotPrice`.
   - Base58 and 0x address checks, plus `shortAddress`.
   - `EVM_UNITS` (ETH 18/18) and `SOLANA_UNITS` (SOL 9, coins 6, 1B supply).
   - `World.units` drives prices, prompts, presets (`planFor`: 0.1 native max buy), XP and badges, highlights, and the risk-engine messages.
   - `GET /v1/chain` publishes the units. The web's `UnitsProvider` reads them.
   - Field names (`balanceWei`, `ethIn`) are kept for API and MCP compatibility. Read them as "smallest native unit".
   - The anti-wash owner check no longer lowercases addresses, because Solana keys are case-sensitive.
2. **Adapter** (`apps/runtime/src/solana/`)
   - `SolanaVenue` interface, implemented by `MeteoraDbcVenue` (DBC SDK pinned to 1.5.13; 2.0.0 was published the same day and was skipped).
   - `SolanaAgentChain`, `SolanaQuoter`, `SolanaIndexer`.
   - `agentsCurve()`: our config (1.25% flat fee, 80% creator share, fees in SOL, immutable 1B supply with 6 decimals, 100% LP locked at graduation into DAMM v2).
   - Main runtime wiring: `CHAIN_FAMILY=solana`, `SOLANA_RPC_URL`, `DBC_CONFIG`, and `AGENTS_JSON` entries with `keypair`. Mainnet is refused unless `SOLANA_ALLOW_MAINNET=1`.
3. **Tests**
   - `solana/chain.test.ts`: mocked RPC that checks every transaction is fully signed. Covers buy and sell fills, minOut, caps and the daily reset, failed transactions, launch signing, and `applyAction` in lamports.
   - `solana/indexer.test.ts`: the DBC venue decoding **recorded** devnet-program accounts through a mocked `Connection`. Its quotes match the live validator exactly. Also covers Metaplex parsing and discovery that ignores strangers' pools.
   - `core/units.test.ts`.

## Running it

Keys are generated outside the repo, in `~/.config/agents-solana-devnet/`. `.gitignore` also blocks `*keypair*.json` and `id.json`.

```bash
# Local validator with the real devnet programs cloned (unlimited test SOL)
solana-test-validator --reset --url devnet \
  --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm --filter @agents/runtime solana:smoke

# Devnet: fund the runtime key printed by the script (about 1.5 SOL from faucet.solana.com), then
SOLANA_RPC_URL=https://api.devnet.solana.com pnpm --filter @agents/runtime solana:smoke

# Demo in SOL units without any chain
CHAIN_FAMILY=solana pnpm --filter @agents/runtime start
```

The devnet runtime key generated for this work is `4y1rXfuv5tBrbppDAScRegDLvtrv9bZXBjaKNchL8y3L`.

Measured on the local validator:

- A launch cost the agent about 0.0245 SOL (rent for the pool, mint, metadata and vaults, plus fees).
- 0.01 SOL bought about 6.3M tokens at the curve's start.
- The full scheduler ran on DBC: atlas and vesper launched, bought, sold and made price calls, and the web app displayed SOL and 6-decimal amounts with base58 addresses.

## Decisions for the owner

1. **Path.** Fast A then B (recommended), Fast A only (agents-only phase becomes a platform rule), or faithful.
2. **Fee.** 1.25% gross for 1% net (recommended, matches today), or 1% gross for 0.8% net.
3. **Thresholds in SOL.** The open threshold (agents-only phase) and DBC's graduation threshold. In Stage B the open threshold must be below graduation. The smoke config uses a 5 SOL graduation threshold.
4. **Custody until the vault ships.** Runtime-held keys on devnet only (recommended), or wait for the vault before inviting anyone.
5. **Identity.** Register agents in the Metaplex Agent Registry for discoverability (recommended), with our own registry as the gate.
6. **Platform token for slot gating.** Which SPL mint, and how much per slot.
7. **Metadata hosting** for coin JSON (Arweave/Irys or our CDN).
8. **XP and badges in SOL.** They now count thousandths of the native coin, so 0.001 SOL earns what 0.001 ETH did. Rescale, or keep that?
9. **Keep EVM alive?** The runtime and web now run either chain. Pick one for launch, or run both.
10. **"Nori".** What was it?

## Coordination with ropet (the EVM side)

ropet authored every commit on `main`, including `contracts/`, the runtime and the web wallet flow.

- **Freeze or continue `contracts/`?** This branch doesn't touch it. If Solana is the path, further EVM contract work (and the planned EVM testnet run) should pause, and the AUDIT.md scope moves to the Solana programs.
- **Shared files.** This branch edits code ropet owns:
  - runtime: `chain.ts` (SimChain takes units), `main.ts` (chain selection, `/v1/chain`), `actions.ts`, `tick.ts`, `world.ts`
  - core: `risk.ts`, `plan.ts`, `progress.ts`
  - web: `api.ts`, `ui.tsx`, the pages, `layout.tsx`

  Each change is small and additive, and the EVM defaults are unchanged. Still, merge order matters. `ui-redesign` (uncommitted), `agent-token` and this branch all overlap.
- **Convention to agree on.** No new `1e18` or `"ETH"` literals. Runtime amounts go through `world.units` and the core `formatUnits`. The web goes through `useUnits()`.
- **Wallet flow.** ropet built the MetaMask create flow. The Solana create flow (wallet adapter, creating the vault, deposit) is the natural piece for ropet to take on, or at least to review.
- **Interfaces stay stable.** `Chain` is unchanged. Indexers now share a minimal `{ pass, syncBalances }` shape and quoters a `{ refresh }` shape in `main.ts`, so an EVM indexer change doesn't need Solana changes.

Venue research notes, with sources: `side-session-notes/local_bc50ddfe-e56c-4034-9312-af026edebaf0/solana-venues-research.md`, outside the repo.
