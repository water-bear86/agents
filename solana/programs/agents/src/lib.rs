//! Agent vaults on Solana: AI agents trade real tokens with their owners' money, within limits.
//!
//! - Registry: unique handles and a model locked at creation.
//! - Vault: one system-owned PDA per agent holds its SOL, and is the authority of its token
//!   accounts. Only the owner can move funds out, at any time; nothing can pause withdrawals.
//! - Session key (the runtime): may only swap through Jupiter, between SOL and tokens on the
//!   platform's whitelist, with every swap's proceeds landing back in the vault. Buys spend SOL
//!   within a per-trade cap and a rolling daily cap. Every session-key swap must get at least the
//!   Pyth oracle price less the platform's maximum slippage, so even a stolen session key can't
//!   sell the vault's tokens, or buy, at a bad price.
//! - Admin: keeps the token whitelist and can pause the session key's trading in an incident.
//!   The admin can never touch a vault.
//!
//! Jupiter is called by raw CPI (instruction layouts from its on-chain IDL). Only its exact-in
//! `route` is accepted, with no platform fee account, and the swap
//! must leave every other vault token account and the vault itself exactly as they were.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::token::{self, SyncNative};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface};
use pyth_solana_receiver_sdk::price_update::{Price, PriceUpdateV2};
use pyth_solana_receiver_sdk::PYTH_PUSH_ORACLE_ID;

declare_id!("4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r");

pub const JUPITER: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Jupiter v6 exact-in routes. `route`: accounts [token_program, user_transfer_authority,
/// user_source_token_account, user_destination_token_account, destination_token_account,
/// destination_mint, platform_fee_account, event_authority, program]; args (route_plan, in_amount
/// u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8).
const JUP_ROUTE: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];
/// Pyth's SOL/USD feed id, fixed so the admin can't repoint the price every sell is measured in.
pub const SOL_USD_FEED: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];
/// Ceilings on the admin's oracle settings.
pub const MAX_SLIPPAGE_BPS: u16 = 500;
pub const MAX_PRICE_AGE: u32 = 120;
/// A price whose confidence band is wider than this share of the price is refused.
pub const MAX_CONFIDENCE_BPS: u64 = 200;

pub const MAX_HANDLE: usize = 15;
pub const MAX_MODEL: usize = 64;
const DAY: i64 = 86_400;

#[program]
pub mod agents {
    use super::*;

    /// One-time setup by the program's upgrade authority, so nobody can front-run it.
    pub fn init_platform(ctx: Context<InitPlatform>, oracle: OracleSettings) -> Result<()> {
        oracle.check()?;
        let p = &mut ctx.accounts.platform;
        p.admin = ctx.accounts.admin.key();
        p.pending_admin = Pubkey::default();
        p.paused = false;
        p.oracle = oracle;
        p.bump = ctx.bumps.platform;
        p.reserved = [0; 64];
        emit!(AdminSet { admin: p.admin });
        Ok(())
    }

    /// How old a price may be, and how far below the oracle price a session-key swap may fill.
    pub fn set_oracle(ctx: Context<AdminOnly>, oracle: OracleSettings) -> Result<()> {
        oracle.check()?;
        ctx.accounts.platform.oracle = oracle;
        Ok(())
    }

    /// Proposes a new admin, who takes over by calling `accept_admin`, so a mistyped key can't
    /// lock the whitelist and pause switch away for good.
    pub fn set_admin(ctx: Context<AdminOnly>, admin: Pubkey) -> Result<()> {
        ctx.accounts.platform.pending_admin = admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let p = &mut ctx.accounts.platform;
        p.admin = p.pending_admin;
        p.pending_admin = Pubkey::default();
        emit!(AdminSet { admin: p.admin });
        Ok(())
    }

    /// Stops (or restarts) every session key's trading. Owners can always trade and withdraw.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.platform.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    /// Adds a token, with its Pyth USD price feed, to the whitelist session keys may trade.
    pub fn allow_mint(ctx: Context<AllowMint>, feed: [u8; 32]) -> Result<()> {
        require!(feed != [0u8; 32], AgentsError::BadArgs);
        let m = &mut ctx.accounts.allowed;
        m.mint = ctx.accounts.mint.key();
        m.feed = feed;
        m.decimals = ctx.accounts.mint.decimals;
        m.bump = ctx.bumps.allowed;
        m.reserved = [0; 32];
        emit!(MintAllowed { mint: m.mint, allowed: true });
        Ok(())
    }

    /// Takes a token off the whitelist. Session keys can then neither buy nor sell it; owners still can.
    pub fn disallow_mint(ctx: Context<DisallowMint>) -> Result<()> {
        emit!(MintAllowed { mint: ctx.accounts.allowed.mint, allowed: false });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_agent(
        ctx: Context<CreateAgent>,
        handle: String,
        model_id: String,
        profile_hash: [u8; 32],
        session_key: Pubkey,
        max_trade: u64,
        daily_limit: u64,
        fund: u64,
    ) -> Result<()> {
        let h = handle.as_bytes();
        require!(h.len() >= 2 && h.len() <= MAX_HANDLE, AgentsError::BadHandle);
        require!(h.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()), AgentsError::BadHandle);
        require!(!model_id.is_empty() && model_id.len() <= MAX_MODEL, AgentsError::BadArgs);

        if fund > 0 {
            require!(fund >= Rent::get()?.minimum_balance(0), AgentsError::FundTooSmall);
            system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(), system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                }),
                fund,
            )?;
        }

        let a = &mut ctx.accounts.agent;
        a.owner = ctx.accounts.owner.key();
        a.vault = ctx.accounts.vault.key();
        a.session_key = session_key;
        a.max_trade = max_trade;
        a.daily_limit = daily_limit;
        a.spent = 0;
        a.spent_at = 0;
        a.profile_hash = profile_hash;
        a.bump = ctx.bumps.agent;
        a.vault_bump = ctx.bumps.vault;
        a.handle = handle.clone();
        a.model_id = model_id.clone();

        emit!(AgentCreated { agent: a.key(), vault: a.vault, owner: a.owner, handle, model_id, profile_hash });
        emit!(SessionSet { agent: a.key(), session_key, max_trade, daily_limit });
        Ok(())
    }

    /// Owner only: replace or revoke (Pubkey::default()) the session key and its caps.
    pub fn set_session(ctx: Context<OwnerOnly>, session_key: Pubkey, max_trade: u64, daily_limit: u64) -> Result<()> {
        let a = &mut ctx.accounts.agent;
        a.session_key = session_key;
        a.max_trade = max_trade;
        a.daily_limit = daily_limit;
        emit!(SessionSet { agent: a.key(), session_key, max_trade, daily_limit });
        Ok(())
    }

    /// Owner only: SOL out of the vault to any account. The vault may be emptied completely.
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let left = vault.lamports().checked_sub(amount).ok_or(AgentsError::InsufficientFunds)?;
        require!(left == 0 || left >= Rent::get()?.minimum_balance(0), AgentsError::FundTooSmall);
        let agent = ctx.accounts.agent.key();
        let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &[ctx.accounts.agent.vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), system_program::Transfer {
                from: vault.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
            }, &[seeds]),
            amount,
        )?;
        emit!(Withdrawn { agent, asset: Pubkey::default(), to: ctx.accounts.to.key(), amount });
        Ok(())
    }

    /// Owner only: tokens out of a vault token account to any token account. Remaining accounts:
    /// the mint's transfer-hook accounts, if it has a hook (Token-2022 matches them by key).
    pub fn withdraw_token<'info>(ctx: Context<'_, '_, '_, 'info, WithdrawToken<'info>>, amount: u64) -> Result<()> {
        let agent = ctx.accounts.agent.key();
        let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &[ctx.accounts.agent.vault_bump]];
        let mut ix = spl_token_2022::instruction::transfer_checked(
            ctx.accounts.token_program.key,
            &ctx.accounts.from.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.to.key(),
            &ctx.accounts.vault.key(),
            &[],
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ix.accounts.extend(ctx.remaining_accounts.iter().map(|a| AccountMeta { pubkey: a.key(), is_signer: false, is_writable: a.is_writable }));
        let mut infos = vec![
            ctx.accounts.from.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.to.to_account_info(),
            ctx.accounts.vault.to_account_info(),
        ];
        infos.extend(ctx.remaining_accounts.iter().cloned());
        invoke_signed(&ix, &infos, &[seeds])?;
        emit!(Withdrawn { agent, asset: ctx.accounts.mint.key(), to: ctx.accounts.to.key(), amount });
        Ok(())
    }

    /// Owner or session key: closes a vault token account, sending its rent (and, for wrapped
    /// SOL, its balance) back to the vault. Other tokens must be empty first.
    pub fn close_token_account(ctx: Context<CloseVaultAccount>) -> Result<()> {
        let a = &ctx.accounts.agent;
        let op = ctx.accounts.operator.key();
        require!(op == a.owner || op == a.session_key, AgentsError::NotAuthorized);
        let acct = &ctx.accounts.account;
        require!(acct.mint == NATIVE_MINT || acct.amount == 0, AgentsError::NotEmpty);
        let agent = a.key();
        let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &[a.vault_bump]];
        token_interface::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), CloseAccount {
            account: acct.to_account_info(),
            destination: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        }, &[seeds]))?;
        Ok(())
    }

    /// Swap through Jupiter from one vault token account to another. `route` is the Jupiter
    /// instruction data; remaining accounts are its accounts, in order.
    ///
    /// Session key: only between SOL and a whitelisted token, at no worse than the oracle price
    /// less the platform's maximum slippage; buys spend wrapped SOL (topped up from the vault's
    /// SOL) within the caps. The owner may swap anything.
    pub fn swap<'info>(ctx: Context<'_, '_, '_, 'info, Swap<'info>>, amount_in: u64, min_out: u64, route: Vec<u8>) -> Result<()> {
        require!(min_out > 0, AgentsError::MinOutRequired);
        require!(amount_in > 0, AgentsError::BadArgs);
        let x = &ctx.accounts;
        let input_mint = x.vault_input.mint;
        let output_mint = x.vault_output.mint;
        require_keys_neq!(input_mint, output_mint, AgentsError::BadArgs);
        require_keys_neq!(x.vault_input.key(), x.vault_output.key(), AgentsError::BadArgs);

        let now = Clock::get()?.unix_timestamp;
        let op = x.operator.key();
        let is_owner = op == x.agent.owner;
        require!(is_owner || op == x.agent.session_key, AgentsError::NotAuthorized);
        // The least a session-key swap must return, from the oracle; owners set their own minimum.
        let mut floor = 0u64;
        if !is_owner {
            require!(!x.platform.paused, AgentsError::Paused);
            let buy = input_mint == NATIVE_MINT;
            // Between SOL and one whitelisted token only, so a session key can never move value into anything else.
            require!(buy || output_mint == NATIVE_MINT, AgentsError::SellsToSolOnly);
            let token_mint = if buy { output_mint } else { input_mint };
            let allowed = x.allowed.as_ref().ok_or(AgentsError::NotWhitelisted)?;
            require_keys_eq!(allowed.mint, token_mint, AgentsError::NotWhitelisted);
            let o = &x.platform.oracle;
            let clock = Clock::get()?;
            let sol_price = oracle_price(x.sol_price.as_deref(), &SOL_USD_FEED, &clock, o.max_age)?;
            let token_price = oracle_price(x.token_price.as_deref(), &allowed.feed, &clock, o.max_age)?;
            floor = oracle_floor(amount_in, buy, &sol_price, &token_price, allowed.decimals, o.max_slippage_bps)?;
            if buy {
                // A buy: within the caps.
                require!(amount_in <= x.agent.max_trade, AgentsError::OverTradeCap);
                let a = &mut ctx.accounts.agent;
                let spent = spent_now(a.spent, a.spent_at, a.daily_limit, now);
                let total = spent.checked_add(amount_in).ok_or(AgentsError::OverDailyCap)?;
                require!(total <= a.daily_limit, AgentsError::OverDailyCap);
                a.spent = total;
                a.spent_at = now;
            }
        }

        // Buying with SOL: wrap whatever the wrapped-SOL account is short of from the vault's lamports.
        let x = &ctx.accounts;
        let agent_key = x.agent.key();
        let seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &[x.agent.vault_bump]];
        if input_mint == NATIVE_MINT && x.vault_input.amount < amount_in {
            let need = amount_in - x.vault_input.amount;
            let left = x.vault.lamports().checked_sub(need).ok_or(AgentsError::InsufficientFunds)?;
            require!(left == 0 || left >= Rent::get()?.minimum_balance(0), AgentsError::InsufficientFunds);
            system_program::transfer(
                CpiContext::new_with_signer(x.system_program.to_account_info(), system_program::Transfer {
                    from: x.vault.to_account_info(),
                    to: x.vault_input.to_account_info(),
                }, &[seeds]),
                need,
            )?;
            token::sync_native(CpiContext::new(x.token_program.to_account_info(), SyncNative {
                account: x.vault_input.to_account_info(),
            }))?;
            ctx.accounts.vault_input.reload()?;
        }

        // Check the route before handing Jupiter the vault's signature.
        let x = &ctx.accounts;
        let hops = ctx.remaining_accounts;
        check_route(&route, hops, amount_in, &x.vault.key(), &x.vault_input.key(), &x.vault_output.key())?;

        // Snapshot every vault token account in the route: the other ones must come back exactly as
        // they were, and the input and output ones unchanged apart from their balances (no delegate,
        // close authority or owner set by a pool along the way).
        let vault_key = x.vault.key();
        let mut snapshots: Vec<(usize, bool, u64, Vec<u8>)> = Vec::new();
        for (i, acc) in hops.iter().enumerate() {
            if vault_token_state(acc, &vault_key).is_some() {
                let moves = acc.key() == x.vault_input.key() || acc.key() == x.vault_output.key();
                snapshots.push((i, moves, acc.lamports(), acc.try_borrow_data()?.to_vec()));
            }
        }
        let input_before = x.vault_input.amount;
        let output_before = x.vault_output.amount;
        let lamports_before = x.vault.lamports();

        let metas: Vec<AccountMeta> = hops
            .iter()
            .map(|a| AccountMeta { pubkey: a.key(), is_signer: a.key() == vault_key, is_writable: a.is_writable })
            .collect();
        let mut infos: Vec<AccountInfo<'info>> = hops.to_vec();
        infos.push(x.jupiter_program.to_account_info());
        invoke_signed(&Instruction { program_id: JUPITER, accounts: metas, data: route }, &infos, &[seeds])?;

        ctx.accounts.vault_input.reload()?;
        ctx.accounts.vault_output.reload()?;
        let x = &ctx.accounts;
        let spent = input_before.checked_sub(x.vault_input.amount).ok_or(AgentsError::RouteMovedFunds)?;
        require!(spent <= amount_in, AgentsError::RouteMovedFunds);
        let out = x.vault_output.amount.checked_sub(output_before).ok_or(AgentsError::Slippage)?;
        require!(out >= min_out, AgentsError::Slippage);
        require!(out >= floor, AgentsError::BelowOraclePrice);
        require!(x.vault.lamports() >= lamports_before, AgentsError::RouteMovedFunds);
        // Jupiter passes the vault's signature on to the pools it routes through; make sure none of
        // them reassigned or allocated it.
        require!(*x.vault.owner == System::id() && x.vault.data_is_empty(), AgentsError::RouteMovedFunds);
        for (i, moves, lamports, before) in snapshots {
            require!(vault_token_state(&hops[i], &vault_key).is_some(), AgentsError::RouteMovedFunds);
            // Wrapped SOL's balance is its lamports, so only the accounts the swap doesn't trade must keep theirs.
            require!(moves || hops[i].lamports() >= lamports, AgentsError::RouteMovedFunds);
            let after = hops[i].try_borrow_data()?;
            // Accounts the swap trades keep everything but their balance (Token-2022 extensions such as
            // withheld transfer fees may move too); every other vault account comes back byte for byte.
            let same = if moves { same_but_amount(&before, &after) } else { before[..] == after[..] };
            require!(same, AgentsError::RouteMovedFunds);
        }
        // The input and output accounts may not appear in the route under another authority either.
        require!(vault_token_state(&x.vault_input.to_account_info(), &vault_key).is_some(), AgentsError::RouteMovedFunds);
        require!(vault_token_state(&x.vault_output.to_account_info(), &vault_key).is_some(), AgentsError::RouteMovedFunds);

        emit!(Swapped { agent: agent_key, input_mint, output_mint, amount_in: spent, amount_out: out, by_owner: is_owner });
        Ok(())
    }
}

/// The session key's spending over the last day: what it spent, refilled linearly over a day.
pub fn spent_now(spent: u64, spent_at: i64, daily_limit: u64, now: i64) -> u64 {
    let elapsed = now.saturating_sub(spent_at).max(0) as u128;
    let refill = (daily_limit as u128).saturating_mul(elapsed) / DAY as u128;
    (spent as u128).saturating_sub(refill) as u64
}

/// Only Jupiter's exact-in routes, from the vault's input account to its output account, for
/// `amount_in`, with no platform fee account (so no fee can be paid whatever the fee field says).
/// The amount sits at the end of the data; trailing bytes could make it misleading, which is why
/// the swap also checks what actually left the vault.
fn check_route(route: &[u8], hops: &[AccountInfo], amount_in: u64, vault: &Pubkey, input: &Pubkey, output: &Pubkey) -> Result<()> {
    require!(route.len() >= 8 + 19, AgentsError::BadRoute);
    let disc: [u8; 8] = route[..8].try_into().unwrap();
    let n = route.len();
    // (authority, source, destinations; the optional destination is the Jupiter program id when unset; fee account)
    require!(disc == JUP_ROUTE, AgentsError::BadRoute);
    let (authority, source, destinations, optional, fee_account): (usize, usize, &[usize], Option<usize>, usize) = (1, 2, &[3, 4], Some(4), 6);
    require!(route[n - 1] == 0, AgentsError::RouteTakesFee);
    require!(u64::from_le_bytes(route[n - 19..n - 11].try_into().unwrap()) == amount_in, AgentsError::BadRoute);

    let key = |i: usize| hops.get(i).map(|a| a.key()).ok_or(AgentsError::BadRoute);
    require_keys_eq!(key(fee_account)?, JUPITER, AgentsError::RouteTakesFee);
    require_keys_eq!(key(authority)?, *vault, AgentsError::BadRoute);
    require_keys_eq!(key(source)?, *input, AgentsError::BadRoute);
    for &d in destinations {
        let k = key(d)?;
        require!(k == *output || (optional == Some(d) && k == JUPITER), AgentsError::BadRoute);
    }
    Ok(())
}

/// A price from Pyth's own sponsored feed account for `feed` (not an update anyone could post
/// for a moment of their choosing), fully verified, fresh, and with a tight confidence band.
fn oracle_price(update: Option<&Account<PriceUpdateV2>>, feed: &[u8; 32], clock: &Clock, max_age: u32) -> Result<Price> {
    let update = update.ok_or(AgentsError::PriceRequired)?;
    let sponsored = Pubkey::find_program_address(&[&0u16.to_le_bytes(), feed], &PYTH_PUSH_ORACLE_ID).0;
    require_keys_eq!(update.key(), sponsored, AgentsError::BadPrice);
    let price = update.get_price_no_older_than(clock, max_age as u64, feed).map_err(|_| AgentsError::BadPrice)?;
    require!(price.price > 0, AgentsError::BadPrice);
    require!((price.conf as u128) * 10_000 <= (price.price as u128) * MAX_CONFIDENCE_BPS as u128, AgentsError::BadPrice);
    Ok(price)
}

/// What `amount_in` is worth on the other side at the oracle prices, less `slippage_bps`.
/// Prices are USD per whole token as `price * 10^exponent`; SOL has 9 decimals.
pub fn oracle_floor(amount_in: u64, buy: bool, sol: &Price, token: &Price, decimals: u8, slippage_bps: u16) -> Result<u64> {
    require!(sol.price > 0 && token.price > 0, AgentsError::BadPrice);
    // buy:  tokens = lamports * sol / token * 10^(decimals - 9);  sell: lamports = tokens * token / sol * 10^(9 - decimals)
    let (p_in, p_out, k) = if buy {
        (sol.price as u128, token.price as u128, decimals as i32 + sol.exponent - token.exponent - 9)
    } else {
        (token.price as u128, sol.price as u128, token.exponent - sol.exponent + 9 - decimals as i32)
    };
    let pow = |e: i32| 10u128.checked_pow(e.unsigned_abs()).ok_or(AgentsError::BadPrice);
    let mut num = (amount_in as u128).checked_mul(p_in).ok_or(AgentsError::BadPrice)?;
    let mut den = p_out;
    if k >= 0 { num = num.checked_mul(pow(k)?).ok_or(AgentsError::BadPrice)?; } else { den = den.checked_mul(pow(k)?).ok_or(AgentsError::BadPrice)?; }
    let fair = num / den;
    let floor = fair.checked_mul((10_000 - slippage_bps) as u128).ok_or(AgentsError::BadPrice)? / 10_000;
    Ok(u64::try_from(floor).unwrap_or(u64::MAX))
}

/// The base state (mint, owner, amount, delegate, state, native reserve, delegated amount, close
/// authority) of an SPL Token or Token-2022 account whose authority is `vault`.
const TOKEN_ACCOUNT_LEN: usize = 165;
fn vault_token_state(acc: &AccountInfo, vault: &Pubkey) -> Option<[u8; TOKEN_ACCOUNT_LEN]> {
    if *acc.owner != anchor_spl::token::ID && *acc.owner != anchor_spl::token_2022::ID {
        return None;
    }
    let d = acc.try_borrow_data().ok()?;
    // Token-2022 accounts with extensions carry AccountType::Account (2) right after the base state.
    let is_account = d.len() == TOKEN_ACCOUNT_LEN || (d.len() > TOKEN_ACCOUNT_LEN && d[TOKEN_ACCOUNT_LEN] == 2);
    if !is_account || d[32..64] != vault.to_bytes() {
        return None;
    }
    d[..TOKEN_ACCOUNT_LEN].try_into().ok()
}

/// The base state is the same apart from the balance (bytes 64..72).
fn same_but_amount(a: &[u8], b: &[u8]) -> bool {
    a.len() >= TOKEN_ACCOUNT_LEN && b.len() >= TOKEN_ACCOUNT_LEN && a[..64] == b[..64] && a[72..TOKEN_ACCOUNT_LEN] == b[72..TOKEN_ACCOUNT_LEN]
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Platform {
    pub admin: Pubkey,
    /// Proposed by the admin; becomes the admin when it accepts.
    pub pending_admin: Pubkey,
    /// Stops session keys from trading. Never stops owners.
    pub paused: bool,
    pub oracle: OracleSettings,
    pub bump: u8,
    /// Room for later settings without a migration.
    pub reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct OracleSettings {
    /// Oldest price a session-key swap may use, in seconds.
    pub max_age: u32,
    /// How far below the oracle price a session-key swap may fill.
    pub max_slippage_bps: u16,
}

impl OracleSettings {
    fn check(&self) -> Result<()> {
        require!(self.max_age > 0 && self.max_age <= MAX_PRICE_AGE, AgentsError::BadArgs);
        require!(self.max_slippage_bps <= MAX_SLIPPAGE_BPS, AgentsError::BadArgs);
        Ok(())
    }
}

/// A token session keys may trade, with its Pyth USD price feed.
#[account]
#[derive(InitSpace)]
pub struct AllowedMint {
    pub mint: Pubkey,
    pub feed: [u8; 32],
    pub decimals: u8,
    pub bump: u8,
    /// Room for later settings without a migration.
    pub reserved: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub session_key: Pubkey,
    pub max_trade: u64,
    pub daily_limit: u64,
    /// SOL the session key has spent, as of `spent_at`; it refills at `daily_limit` per day.
    pub spent: u64,
    pub spent_at: i64,
    pub profile_hash: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
    #[max_len(15)]
    pub handle: String,
    #[max_len(64)]
    pub model_id: String,
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitPlatform<'info> {
    /// Must be the program's upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Platform::INIT_SPACE, seeds = [b"platform"], bump)]
    pub platform: Account<'info, Platform>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ AgentsError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::Agents>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ AgentsError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"platform"], bump = platform.bump, has_one = admin @ AgentsError::NotAdmin)]
    pub platform: Account<'info, Platform>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(mut, seeds = [b"platform"], bump = platform.bump, has_one = pending_admin @ AgentsError::NotAdmin)]
    pub platform: Account<'info, Platform>,
}

#[derive(Accounts)]
pub struct AllowMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"platform"], bump = platform.bump, has_one = admin @ AgentsError::NotAdmin)]
    pub platform: Account<'info, Platform>,
    /// Plain SPL tokens only: Token-2022 extensions (permanent delegate, transfer hook, pausing)
    /// could take or trap what session keys buy.
    #[account(mint::token_program = anchor_spl::token::ID)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = admin, space = 8 + AllowedMint::INIT_SPACE, seeds = [b"mint", mint.key().as_ref()], bump)]
    pub allowed: Account<'info, AllowedMint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DisallowMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"platform"], bump = platform.bump, has_one = admin @ AgentsError::NotAdmin)]
    pub platform: Account<'info, Platform>,
    #[account(mut, close = admin, seeds = [b"mint", allowed.mint.as_ref()], bump = allowed.bump)]
    pub allowed: Account<'info, AllowedMint>,
}

#[derive(Accounts)]
#[instruction(handle: String)]
pub struct CreateAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Agent::INIT_SPACE, seeds = [b"agent", handle.as_bytes()], bump)]
    pub agent: Account<'info, Agent>,
    /// CHECK: system-owned PDA holding the agent's SOL; only this program can sign for it.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ AgentsError::NotOwner)]
    pub agent: Account<'info, Agent>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner @ AgentsError::NotOwner, has_one = vault)]
    pub agent: Account<'info, Agent>,
    /// CHECK: the agent's vault PDA (checked by has_one).
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: any destination the owner chooses.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner @ AgentsError::NotOwner, has_one = vault)]
    pub agent: Account<'info, Agent>,
    /// CHECK: the agent's vault PDA (checked by has_one), authority of `from`.
    pub vault: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = vault, token::token_program = token_program)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseVaultAccount<'info> {
    pub operator: Signer<'info>,
    #[account(has_one = vault)]
    pub agent: Account<'info, Agent>,
    /// CHECK: the agent's vault PDA (has_one); receives the rent.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault, token::token_program = token_program)]
    pub account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub operator: Signer<'info>,
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, has_one = vault)]
    pub agent: Box<Account<'info, Agent>>,
    /// CHECK: the agent's vault PDA (has_one); Jupiter's transfer authority.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault)]
    pub vault_input: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::authority = vault)]
    pub vault_output: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The whitelist entry for the token traded (the one that isn't SOL); required for the session key.
    pub allowed: Option<Box<Account<'info, AllowedMint>>>,
    /// Pyth price updates for SOL/USD and the token; required for the session key.
    pub sol_price: Option<Box<Account<'info, PriceUpdateV2>>>,
    pub token_price: Option<Box<Account<'info, PriceUpdateV2>>>,
    /// CHECK: Jupiter v6.
    #[account(address = JUPITER)]
    pub jupiter_program: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------- events and errors

#[event]
pub struct AdminSet { pub admin: Pubkey }
#[event]
pub struct PausedSet { pub paused: bool }
#[event]
pub struct MintAllowed { pub mint: Pubkey, pub allowed: bool }
#[event]
pub struct AgentCreated { pub agent: Pubkey, pub vault: Pubkey, pub owner: Pubkey, pub handle: String, pub model_id: String, pub profile_hash: [u8; 32] }
#[event]
pub struct SessionSet { pub agent: Pubkey, pub session_key: Pubkey, pub max_trade: u64, pub daily_limit: u64 }
#[event]
pub struct Withdrawn { pub agent: Pubkey, pub asset: Pubkey, pub to: Pubkey, pub amount: u64 }
#[event]
pub struct Swapped { pub agent: Pubkey, pub input_mint: Pubkey, pub output_mint: Pubkey, pub amount_in: u64, pub amount_out: u64, pub by_owner: bool }

#[error_code]
pub enum AgentsError {
    #[msg("Handle must be 2-15 characters, a-z and 0-9")]
    BadHandle,
    #[msg("Bad arguments")]
    BadArgs,
    #[msg("Funding must cover the vault's rent-exempt minimum")]
    FundTooSmall,
    #[msg("Only the agent's owner may do this")]
    NotOwner,
    #[msg("Only the owner or the session key may do this")]
    NotAuthorized,
    #[msg("Only the platform admin may do this")]
    NotAdmin,
    #[msg("Session-key trading is paused")]
    Paused,
    #[msg("Session keys may only buy whitelisted tokens")]
    NotWhitelisted,
    #[msg("Session keys may only sell back to SOL")]
    SellsToSolOnly,
    #[msg("Trade is over the per-trade cap")]
    OverTradeCap,
    #[msg("Trade is over the daily cap")]
    OverDailyCap,
    #[msg("A minimum output is required")]
    MinOutRequired,
    #[msg("Output below the minimum")]
    Slippage,
    #[msg("Not enough SOL in the vault")]
    InsufficientFunds,
    #[msg("Only Jupiter's exact-in routes from and to this vault are accepted")]
    BadRoute,
    #[msg("Routes may not take a platform fee or positive slippage")]
    RouteTakesFee,
    #[msg("The route moved vault funds it wasn't allowed to")]
    RouteMovedFunds,
    #[msg("Session-key swaps need the SOL and token price accounts")]
    PriceRequired,
    #[msg("Oracle price missing, stale, for the wrong feed, or out of range")]
    BadPrice,
    #[msg("Output below the oracle price less the maximum slippage")]
    BelowOraclePrice,
    #[msg("Token account must be empty to close")]
    NotEmpty,
    #[msg("Only the program's upgrade authority can set up the platform")]
    NotUpgradeAuthority,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spending_refills_over_a_day() {
        let limit = 1_000;
        assert_eq!(spent_now(1_000, 0, limit, 0), 1_000);
        assert_eq!(spent_now(1_000, 0, limit, DAY / 2), 500);
        assert_eq!(spent_now(1_000, 0, limit, DAY), 0);
        assert_eq!(spent_now(1_000, 0, limit, DAY * 5), 0);
        // A clock that goes backwards refills nothing.
        assert_eq!(spent_now(1_000, 100, limit, 50), 1_000);
    }

    fn usd(price: i64, exponent: i32) -> Price {
        Price { price, conf: 0, exponent, publish_time: 0 }
    }

    #[test]
    fn oracle_floor_values_both_directions() {
        let sol = usd(150_00000000, -8); // $150
        let usdc = usd(1_00000000, -8); // $1, 6 decimals
        // 1 SOL buys 150 USDC; 3% slippage allowed.
        assert_eq!(oracle_floor(1_000_000_000, true, &sol, &usdc, 6, 0).unwrap(), 150_000_000);
        assert_eq!(oracle_floor(1_000_000_000, true, &sol, &usdc, 6, 300).unwrap(), 145_500_000);
        // 150 USDC sells for 1 SOL.
        assert_eq!(oracle_floor(150_000_000, false, &sol, &usdc, 6, 0).unwrap(), 1_000_000_000);
        // A 5-decimal memecoin at $0.00002 (exponent -10): 0.1 SOL ($15) buys 750,000 tokens.
        let bonk = usd(200_000, -10);
        assert_eq!(oracle_floor(100_000_000, true, &sol, &bonk, 5, 0).unwrap(), 750_000 * 100_000);
        assert_eq!(oracle_floor(750_000 * 100_000, false, &sol, &bonk, 5, 0).unwrap(), 100_000_000);
    }

    #[test]
    fn sol_usd_feed_is_pyths() {
        let id = pyth_solana_receiver_sdk::price_update::get_feed_id_from_hex("0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d").unwrap();
        assert_eq!(id, SOL_USD_FEED);
    }

    #[test]
    fn oracle_floor_refuses_bad_prices() {
        let sol = usd(150_00000000, -8);
        assert!(oracle_floor(1, true, &sol, &usd(0, -8), 6, 0).is_err());
        assert!(oracle_floor(1, true, &usd(-5, -8), &sol, 6, 0).is_err());
        // Absurd exponents overflow into an error instead of a wrong floor.
        assert!(oracle_floor(u64::MAX, true, &usd(i64::MAX, 30), &usd(1, -30), 6, 0).is_err());
    }
}
