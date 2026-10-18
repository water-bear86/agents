# Mainnet launch runbook (Solana)

Steps marked 💸 spend real SOL. The owner gives the go-ahead for each one.

The program is `agents` (`solana/programs/agents`, id `4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r`). What it enforces and what it leaves open is in `solana/AUDIT.md`.

The tools:
- `solana/mainnet.config.json` holds the launch settings:
  - the owner's wallet
  - the starting whitelist, each token with its Pyth feed
  - the oracle settings
- `pnpm --filter @agents/runtime solana:mainnet preflight` checks everything it can **read-only**:
  - the RPC is mainnet, and Jupiter is live
  - the build, and what deploying it costs
  - the deployer's balance
  - each whitelisted token's mint and Pyth feed
  - after the deploy: the upgrade authority, the admin and the whitelist
- `pnpm --filter @agents/runtime solana:mainnet setup` prints the platform setup it would do. It only sends with `--send` and `SOLANA_ALLOW_MAINNET=1`.

## What it costs

| | SOL |
|---|---|
| Program rent (454 KB), kept as long as the program exists | about 2.36 |
| Upload buffer, refunded when the deploy completes | about 2.36 |
| Platform record and one record per whitelisted token | about 0.002 each |
| Transaction fees with priority fees | about 0.05 |
| **Fund the deployer with** | **about 4.9** (what's left goes back to the owner) |

A later upgrade that makes the program bigger extends it first (`solana program extend`), paying rent for the extra bytes then.

## Keys

| Key | What it is |
|---|---|
| Deployer | A fresh hot key made only for this (`~/.config/agents-solana-mainnet/deployer.json`, outside the repo). It signs about 500 buffer writes, sets up the platform, then hands everything to the owner and is emptied. Never reuse the devnet key. |
| Owner | The owner's own wallet. It becomes the upgrade authority and the platform admin. A hardware wallet is best: the upgrade authority can replace the program. |
| Session key | The runtime's signer for agent trades. Make it on the server that runs the runtime and never move it. Owners only see its public key. It can't withdraw, and the program limits what it can trade and at what price. |
| Program id keypair | `solana/target/deploy/agents-keypair.json`, backed up in `~/.config/agents-solana-devnet/programs/`. Only needed for the first deploy. Keep an offline copy. |

## Steps

### 1. Settings
Put the owner's wallet in `owner` in `solana/mainnet.config.json`, and review the whitelist and oracle settings. Starting values:
- **Whitelist:** JUP, WIF, TRUMP and FARTCOIN. Each is a plain SPL token with 6 decimals, a live Pyth feed and over $1M of liquidity (checked October 2026).
- **Oracle:** prices at most 60 s old, fills at most 3% below them. The program caps these at 120 s and 5%.

### 2. Reproducible build
Mainnet gets a build anyone can check against the public source. This needs Docker and `solana-verify`.

```bash
cd solana && solana-verify build --library-name agents && solana-verify get-executable-hash target/deploy/agents.so
```

Record the hash. Then run the end-to-end test on a mainnet fork with exactly that file:

```bash
pnpm --filter @agents/runtime solana:fork
```

```bash
solana program deploy -u localhost -k ~/.config/agents-solana-devnet/runtime.json --program-id solana/target/deploy/agents-keypair.json solana/target/deploy/agents.so
```

```bash
SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm --filter @agents/runtime solana:e2e
```

### 3. Preflight
Use a paid RPC for deploy day by setting `SOLANA_RPC_URL`; the public endpoint rate-limits buffer writes.

```bash
pnpm --filter @agents/runtime solana:mainnet preflight
```

Every line must be ✓ or ·.

### 4. 💸 Fund the deployer, then deploy

```bash
solana program deploy -u "$SOLANA_RPC_URL" -k ~/.config/agents-solana-mainnet/deployer.json --program-id solana/target/deploy/agents-keypair.json solana/target/deploy/agents.so --with-compute-unit-price 100000 --max-sign-attempts 100 --use-rpc
```

If the deploy is interrupted, its buffer still holds the rent. Close it to get the rent back before retrying:

```bash
solana program close --buffers -u "$SOLANA_RPC_URL" -k ~/.config/agents-solana-mainnet/deployer.json
```

### 5. 💸 Set up the platform
The deployer is still the upgrade authority, which `init_platform` requires. Dry run first, and read every value:

```bash
pnpm --filter @agents/runtime solana:mainnet setup
```

```bash
SOLANA_ALLOW_MAINNET=1 pnpm --filter @agents/runtime solana:mainnet setup --send
```

This sets up the platform with the oracle settings, whitelists the tokens, and proposes the owner as admin.

### 6. 💸 Verify the build, then hand the program to the owner
1. Verify while the deployer can still sign. `--remote` writes a small record signed by the upgrade authority and asks the verification service to rebuild from the public commit:

   ```bash
   solana-verify verify-from-repo -u "$SOLANA_RPC_URL" --program-id 4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r https://github.com/water-bear86/agents --commit-hash <commit> --library-name agents --mount-path solana --remote -k ~/.config/agents-solana-mainnet/deployer.json
   ```

2. The owner opens `/admin` on the website, connects their wallet and accepts the admin role. That proves the address in the config is a wallet the owner controls.

3. Hand the upgrade authority to that wallet. The upgrade authority moves without the new holder signing, and a wrong address can't be undone, so `handover` only prints the command once the owner has accepted the admin role:

   ```bash
   pnpm --filter @agents/runtime solana:mainnet handover
   ```

4. Run the preflight again. It must show:
   - the owner as upgrade authority and admin
   - the whitelist set up

   Then send what's left on the deployer to the owner and retire the key.

### 7. Turn on the runtime (the owner's call, separately)

| Setting | Value |
|---|---|
| `CHAIN_FAMILY` | `solana` |
| `SOLANA_RPC_URL` | A paid mainnet RPC (it carries a key, so it stays server-side) |
| `SOLANA_ALLOW_MAINNET` | `1` (the runtime refuses mainnet without it) |
| `SOLANA_SESSION_KEYPAIR` | Path to the session key on the server |
| `SOLANA_PUBLIC_RPC_URL` | A browser-safe RPC for the wallet flows (no API key in the URL) |
| `JUPITER_API_KEY` | Jupiter's paid API; the free one allows about a request a second |
| `AGENTS_JSON` | The handles of agents created with the session key |
| `PAPER` | Unset |

## Running it

- **Pause:** the admin pauses every session key from `/admin`. Owners can still trade and withdraw.
- **Whitelist:** the admin adds a token on `/admin` with its mint and its Pyth USD feed id from pyth.network/price-feeds. Check first that the token is a plain SPL token with 6 decimals and that its sponsored feed is live; the preflight checks both. Remove tokens whose feed goes stale.
- **Upgrades:** build with `solana-verify build`, upgrade with the owner's wallet as upgrade authority, then verify the build again.
- **A stolen session key:** pause on `/admin`, move the runtime to a new key, and have owners point their agents at it (`set_session`).
