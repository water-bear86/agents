# Mainnet launch runbook (Solana)

This is prepared, not run. **Nothing here has been sent to mainnet and no real SOL has been spent.** The steps that spend money are marked 💸; do them only after the owner's go-ahead.

The tools behind it:

- `solana/mainnet.config.json` holds the launch settings. Every empty value in it is a decision for the owner.
- `pnpm --filter @agents/runtime solana:mainnet preflight` checks everything it can **read-only**: the RPC is mainnet, DBC is live, our builds and what they cost, the deployer's balance, the multisig and its vault, the settings, and (after the deploy) the upgrade authority and the Platform record. It sends nothing.
- `pnpm --filter @agents/runtime solana:mainnet platform` prints the DBC config and Platform record it would create. It only sends with `--send` and `SOLANA_ALLOW_MAINNET=1`.

The preflight run on 2026-10-15 confirmed:

- the RPC reports mainnet's genesis hash
- Meteora DBC and Squads v4 are both live
- our program keypairs match the ids
- the deploy costs about **3.91 SOL** in rent

It also listed what's still open: the multisig, the deployer, the three recipient wallets and the session key.

## 1. Before deploy day

### Decisions (owner)

| Decision | Where it goes | Suggested |
|---|---|---|
| Graduation threshold (SOL in the curve when DBC graduates the coin to DAMM v2 and removes the hook) | `platform.migrationThresholdSol` | 85, which is pump.fun's scale; template value |
| Open threshold (SOL in the pool when a coin opens to everyone) | `platform.openThresholdSol` | Below graduation. 20 in the template. |
| Opening window (a coin opens after this long even if the threshold isn't reached) | `platform.openWindowHours` | 24 |
| Inference pool, buyback and leftover wallets | `platform.inference`, `platform.buyback`, `platform.leftoverReceiver` | Wallets the multisig controls. Two different wallets for inference and buyback. |
| Slot gating (platform token per agent slot) | `platform.platformMint`, `platform.holdPerSlot` | Off until there is a platform token |
| Multisig members, threshold, time lock | Squads app (step 2) | 2-of-3 on hardware wallets, time lock of at least 24 hours |
| Upgrade policy after the audit | | Keep upgrades behind the multisig with its time lock, or make the programs immutable once the audit is done. With no pause instruction (same as the EVM contracts), the multisig is the only way to fix a bug. Weigh that against users' wish for immutability. |
| Coin metadata hosting | `COIN_URI_BASE` in the runtime's environment | Arweave via Irys, or our CDN |

### Code and audit

1. **External audit** of `solana/programs/agents` and `solana/programs/agents_hook` at a frozen commit. `solana/AUDIT.md` is the scope and threat model to hand over. Fix the findings, then rerun the e2e on localnet and devnet.
2. **Merge the branch.** `solana-port` sits on a snapshot of `ui-redesign`'s uncommitted work. Rebase it once `ui-redesign` commits, agree the merge order with ropet, and push. The verified build in step 4 needs the commit public on GitHub.
3. Optionally embed a `security.txt` in both programs (the `solana-security-txt` crate) with a contact for researchers. It changes the binaries, so do it before the audit's final commit.

### Keys

| Key | What it is | Notes |
|---|---|---|
| Deployer | A fresh hot key made only for the deploy | It must sign about 500 buffer writes, so a Ledger is impractical. It holds about 4.2 SOL for an hour, sets up the platform, and loses all authority at handover (step 7). Never reuse the devnet key. |
| Multisig members | Hardware wallets | Created in step 2 |
| Session key | The runtime's signer for every agent trade | Generate it on the server that runs the runtime and never move it. Owners only ever see its public key (`runtime.sessionKeyPublic`). It can only trade within each agent's caps; it can never withdraw. |
| Program id keypairs | `solana/target/deploy/*-keypair.json`, backed up in `~/.config/agents-solana-devnet/programs/` | Only needed for the first deploy. Keep an offline backup. Anyone holding them before the deploy could claim the addresses on mainnet. |

### Costs

| | SOL |
|---|---|
| `agents` program rent (540 KB) | 2.745 |
| `agents_hook` program rent (230 KB) | 1.169 |
| Write buffer (refunded when each deploy completes) | peak +2.75, returned |
| DBC config, Platform record, recipients' wrapped-SOL accounts | about 0.01 |
| Transaction fees with priority fees | about 0.05 |
| **Fund the deployer with** | **4.2** (anything left is returned to the owner at the end) |

## 2. Create the Squads multisig

1. At app.squads.so, create a v4 multisig. Choose the members (hardware wallets), the threshold (for example 2 of 3) and the time lock.
2. Put its address in `multisig.address`. The preflight derives vault 0, the address that will hold the upgrade authority, and prints it.
3. Optionally create the inference, buyback and leftover wallets as further Squads vaults (vault 1, 2, 3...) so the multisig controls them too. Put those addresses in `mainnet.config.json`.

## 3. Preflight

```bash
pnpm --filter @agents/runtime solana:mainnet preflight
```

Every line must be ✓ or · (informational). Use a paid RPC for deploy day by setting `SOLANA_RPC_URL`; the public endpoint rate-limits buffer writes.

## 4. Build the exact binaries to deploy

Mainnet gets binaries from a reproducible build, so anyone can check them against the public source. Don't deploy the output of `anchor build`, because its hash won't match.

This needs Docker and the `solana-verify` CLI (`cargo install solana-verify`). Neither is set up on the machine this was prepared on, so this step hasn't been tried yet. Try it well before deploy day: the reproducible build image may use a different Rust version than the local SBF toolchain this branch's `Cargo.lock` was resolved for. If the build fails on dependency versions, re-resolve the lockfile for that image.

```bash
cd solana && solana-verify build --library-name agents && solana-verify build --library-name agents_hook
```

```bash
cd solana && solana-verify get-executable-hash target/deploy/agents.so && solana-verify get-executable-hash target/deploy/agents_hook.so
```

Record both hashes. Then rerun the full e2e on a local validator with these exact files (`solana:validator` loads `solana/target/deploy`):

```bash
SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm --filter @agents/runtime solana:e2e
```

## 5. 💸 Deploy both programs

Fund the deployer with 4.2 SOL first, then deploy the hook, then `agents`:

```bash
solana program deploy -u "$SOLANA_RPC_URL" -k <deployer.json> --program-id solana/target/deploy/agents_hook-keypair.json solana/target/deploy/agents_hook.so --with-compute-unit-price 100000 --max-sign-attempts 100 --use-rpc
```

```bash
solana program deploy -u "$SOLANA_RPC_URL" -k <deployer.json> --program-id solana/target/deploy/agents-keypair.json solana/target/deploy/agents.so --with-compute-unit-price 100000 --max-sign-attempts 100 --use-rpc
```

If a deploy is interrupted, its buffer still holds the rent. List the buffers and close them to get it back before retrying:

```bash
solana program show --buffers -u "$SOLANA_RPC_URL" -k <deployer.json>
```

```bash
solana program close --buffers -u "$SOLANA_RPC_URL" -k <deployer.json>
```

## 6. 💸 Set up the platform

The deployer is still the upgrade authority at this point, which `init_platform` requires: that is the protection against anyone else front-running setup. Dry run first, and read every value:

```bash
pnpm --filter @agents/runtime solana:mainnet platform
```

```bash
SOLANA_ALLOW_MAINNET=1 pnpm --filter @agents/runtime solana:mainnet platform --send
```

This creates the DBC config (Token-2022 coins with our hook, fees claimable by the agents program's `fees` PDA, 100% of the LP locked at graduation) and the Platform record. **Both are permanent**: the Platform has no update instruction, so a wrong recipient means redeploying under new program ids.

## 7. 💸 Verify the build, then hand the upgrade authority to the multisig

1. **Verify the build while the deployer can still sign.** Submit the verification against the public commit. `--remote` writes a small verification record signed by the upgrade authority, then asks the verification service to rebuild and compare.

   ```bash
   solana-verify verify-from-repo -u "$SOLANA_RPC_URL" --program-id 4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r https://github.com/water-bear86/agents --commit-hash <commit> --library-name agents --mount-path solana --remote -k <deployer.json>
   ```

   Repeat for `agents_hook` (`8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9`, `--library-name agents_hook`).

2. **Hand over both programs** to the multisig's vault 0 (printed by the preflight). The vault can't sign, hence the skip flag:

   ```bash
   solana program set-upgrade-authority 4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check -u "$SOLANA_RPC_URL" -k <deployer.json>
   ```

   ```bash
   solana program set-upgrade-authority 8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9 --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check -u "$SOLANA_RPC_URL" -k <deployer.json>
   ```

   Squads also offers a Safe Authority Transfer from its Programs tab, where the multisig approves the change before it happens. It is slower but catches a mistyped vault address. A wrong address here is unrecoverable.

3. Run the preflight again. It must show both programs with the vault as upgrade authority, the Platform set up, and its recipients matching the config. Then sweep what's left on the deployer back to the owner and retire the key.

## 8. Turn on the runtime and the website

| Setting | Value |
|---|---|
| `CHAIN_FAMILY` | `solana` |
| `SOLANA_RPC_URL` | A paid mainnet RPC (it carries a key, so it stays server-side) |
| `SOLANA_ALLOW_MAINNET` | `1` (the runtime refuses mainnet without it) |
| `SOLANA_SESSION_KEYPAIR` | Path to the session key on the server |
| `SOLANA_PUBLIC_RPC_URL` | A browser-safe RPC for the wallet flows (no API key in the URL) |
| `COIN_URI_BASE` | Where coin metadata JSON is served |
| `AGENTS_JSON` | The handles of agents created with the session key |
| `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY` | As today |

The website reads the program id, the session key and the public RPC from the runtime's `/v1/chain`. Nothing chain-specific is baked into the web build.

## 9. 💸 First hour

1. The owner creates one agent from the website, funded with a small amount (for example 0.1 SOL).
2. The runtime picks it up. Watch its first launch and trades on its page and in the runtime log (`[crank]` lines show opening and fee claims).
3. Check one coin on an explorer:
   - the mint has the transfer hook
   - the pool belongs to our DBC config
   - a direct buy from a non-agent wallet fails while the coin is closed
4. After the first trades, check `distribute_fees` sent equal amounts to the inference and buyback wallets.

## Upgrades and incidents

- **Upgrading.** Build with `solana-verify build`, then write a buffer (`solana program write-buffer <so> -u "$SOLANA_RPC_URL"`) and set its authority to the vault (`solana program set-buffer-authority <buffer> --new-buffer-authority <vault>`). Propose the upgrade from the program's page in the Squads app. It executes after the threshold and the time lock. Re-verify the build afterwards.
- **There is no pause switch**, as on EVM. In an incident, the fastest response is an upgrade through the multisig, which takes as long as the time lock allows. Decide the time lock with that in mind, or ask the auditor whether a narrowly scoped pause (for example, blocking new launches only) is worth adding.
- **Graduated coins** live on Meteora DAMM v2 with LP locked. The agents program has no authority over them, and the hook is gone by then.

## Sources

- Squads, program upgrade authority and upgrades: https://docs.squads.so/main/navigating-your-squad/developers-assets/programs
- Solana, verified builds (`solana-verify build`, `verify-from-repo`): https://solana.com/docs/programs/verified-builds
- Anchor, verifiable builds: https://www.anchor-lang.com/docs/verifiable-builds
