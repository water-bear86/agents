//! Agents launchpad on Solana: the port of AgentRegistry + AgentAccount + LaunchHook.
//!
//! - Registry: unique handles, a model locked at creation, platform-token slot gating.
//! - Vault: one system-owned PDA per agent holds its SOL, and is the authority of its token
//!   accounts. Only the owner can move funds out. The session key (the runtime) can only buy,
//!   sell and launch on this platform's Meteora DBC pools, within per-trade and daily caps, and
//!   every trade needs a minimum output.
//! - Launch gate: coins are launched through this program only (registered agents, 1-hour
//!   cooldown). Each coin is a Token-2022 mint with our transfer hook, which keeps trading
//!   agents-only until the coin opens (SOL threshold or opening time).
//! - Fees: DBC pays the creator share (80% of our 1%) to the agent's vault, and the partner
//!   share to the `fees` PDA, which `distribute_fees` splits evenly to inference and buyback.
//!
//! Meteora DBC is called by raw CPI (discriminators and account order from its IDL in
//! `solana/idls/dynamic_bonding_curve.json`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::token::{self, SyncNative};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r");

pub const DBC_PROGRAM: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
pub const HOOK_PROGRAM: Pubkey = pubkey!("8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9");
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

const DBC_SWAP2_WITH_HOOK: [u8; 8] = [183, 93, 153, 40, 24, 230, 194, 151];
const DBC_INIT_POOL_T22_HOOK: [u8; 8] = [182, 13, 233, 177, 42, 145, 135, 2];
// claim_trading_fee2 / claim_creator_trading_fee2: the variants that accept transfer-hook pools.
const DBC_CLAIM_PARTNER_FEE: [u8; 8] = [84, 191, 71, 50, 9, 162, 55, 193];
const DBC_CLAIM_CREATOR_FEE: [u8; 8] = [238, 247, 213, 94, 110, 145, 88, 142];
const HOOK_INIT_METAS: [u8; 8] = [92, 197, 174, 197, 41, 124, 19, 3];
/// Byte offsets inside a DBC VirtualPool / TransferHookPool account (8-byte discriminator + PoolState).
const POOL_CONFIG_OFFSET: usize = 72;
const POOL_QUOTE_RESERVE_OFFSET: usize = 240;

pub const MAX_HANDLE: usize = 15;
pub const MAX_MODEL: usize = 64;
pub const MAX_NAME: usize = 32;
pub const MAX_SYMBOL: usize = 10;
pub const MAX_URI: usize = 200;
const DAY: i64 = 86_400;

#[program]
pub mod agents {
    use super::*;

    /// One-time platform setup. Everything here is immutable afterwards, like the EVM constructor args.
    pub fn init_platform(ctx: Context<InitPlatform>, args: PlatformArgs) -> Result<()> {
        require!(args.open_window > 0 && args.launch_cooldown >= 0, AgentsError::BadArgs);
        let p = &mut ctx.accounts.platform;
        p.admin = ctx.accounts.admin.key();
        p.dbc_config = args.dbc_config;
        p.platform_mint = args.platform_mint;
        p.hold_per_slot = args.hold_per_slot;
        p.inference = args.inference;
        p.buyback = args.buyback;
        p.open_threshold = args.open_threshold;
        p.open_window = args.open_window;
        p.launch_cooldown = args.launch_cooldown;
        p.bump = ctx.bumps.platform;
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

        // Slot gating: hold (slots + 1) * hold_per_slot of the platform token, checked at creation only.
        let platform = &ctx.accounts.platform;
        let slots = &mut ctx.accounts.slots;
        if platform.platform_mint != Pubkey::default() {
            let required = (slots.count as u64 + 1).checked_mul(platform.hold_per_slot).ok_or(AgentsError::BadArgs)?;
            let held = match &ctx.accounts.owner_platform_tokens {
                Some(t) if t.mint == platform.platform_mint && t.owner == ctx.accounts.owner.key() => t.amount,
                _ => 0,
            };
            require!(held >= required, AgentsError::NotEnoughPlatformToken);
        }
        slots.count += 1;

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
        a.spent_today = 0;
        a.day_start = 0;
        a.last_launch_at = 0;
        a.profile_hash = profile_hash;
        a.bump = ctx.bumps.agent;
        a.vault_bump = ctx.bumps.vault;
        a.handle = handle.clone();
        a.model_id = model_id.clone();
        ctx.accounts.member.agent = a.key();

        emit!(AgentCreated { agent: a.key(), vault: a.vault, owner: a.owner, handle, model_id, profile_hash });
        emit!(SessionSet { agent: a.key(), session_key, max_trade, daily_limit });
        Ok(())
    }

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

    /// Owner only: tokens (wrapped SOL or coins) out of a vault token account. Coins still in their
    /// agents-only phase can only go to another agent's vault: the transfer hook refuses anything else.
    pub fn withdraw_token<'info>(ctx: Context<'_, '_, '_, 'info, WithdrawToken<'info>>, amount: u64) -> Result<()> {
        let agent = ctx.accounts.agent.key();
        let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &[ctx.accounts.agent.vault_bump]];
        spl_token_2022::onchain::invoke_transfer_checked(
            ctx.accounts.token_program.key,
            ctx.accounts.from.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.to.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.remaining_accounts,
            amount,
            ctx.accounts.mint.decimals,
            &[seeds],
        )?;
        emit!(Withdrawn { agent, asset: ctx.accounts.mint.key(), to: ctx.accounts.to.key(), amount });
        Ok(())
    }

    /// Buy a coin with SOL from the vault. Remaining accounts: the coin's transfer-hook accounts.
    pub fn buy<'info>(ctx: Context<'_, '_, '_, 'info, Trade<'info>>, amount_in: u64, min_out: u64) -> Result<()> {
        require!(min_out > 0, AgentsError::MinOutRequired);
        require!(amount_in > 0, AgentsError::BadArgs);
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts.agent;
        let op = ctx.accounts.operator.key();
        require!(op == a.owner || op == a.session_key, AgentsError::NotAuthorized);
        if op != a.owner {
            require!(amount_in <= a.max_trade, AgentsError::OverTradeCap);
            if now >= a.day_start + DAY {
                a.day_start = now;
                a.spent_today = 0;
            }
            require!(a.spent_today.checked_add(amount_in).ok_or(AgentsError::OverDailyCap)? <= a.daily_limit, AgentsError::OverDailyCap);
            a.spent_today += amount_in;
        }

        // Wrap whatever the wrapped-SOL account is short of from the vault's lamports.
        let have = ctx.accounts.vault_quote.amount;
        if have < amount_in {
            let need = amount_in - have;
            let left = ctx.accounts.vault.lamports().checked_sub(need).ok_or(AgentsError::InsufficientFunds)?;
            require!(left == 0 || left >= Rent::get()?.minimum_balance(0), AgentsError::InsufficientFunds);
            let agent = ctx.accounts.agent.key();
            let seeds: &[&[u8]] = &[b"vault", agent.as_ref(), &[ctx.accounts.agent.vault_bump]];
            system_program::transfer(
                CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.vault_quote.to_account_info(),
                }, &[seeds]),
                need,
            )?;
            token::sync_native(CpiContext::new(ctx.accounts.token_quote_program.to_account_info(), SyncNative {
                account: ctx.accounts.vault_quote.to_account_info(),
            }))?;
        }

        let before = ctx.accounts.vault_base.amount;
        swap(&ctx, true, amount_in, min_out)?;
        ctx.accounts.vault_base.reload()?;
        let out = ctx.accounts.vault_base.amount.checked_sub(before).ok_or(AgentsError::Slippage)?;
        require!(out >= min_out, AgentsError::Slippage);
        emit!(Traded { agent: ctx.accounts.agent.key(), mint: ctx.accounts.base_mint.key(), buy: true, amount_in, amount_out: out });
        Ok(())
    }

    /// Sell a coin for SOL. Proceeds stay in the vault as wrapped SOL (the next buy spends it first).
    /// Sells are not capped: they only return SOL to the vault.
    pub fn sell<'info>(ctx: Context<'_, '_, '_, 'info, Trade<'info>>, tokens_in: u64, min_out: u64) -> Result<()> {
        require!(min_out > 0, AgentsError::MinOutRequired);
        require!(tokens_in > 0, AgentsError::BadArgs);
        let a = &ctx.accounts.agent;
        let op = ctx.accounts.operator.key();
        require!(op == a.owner || op == a.session_key, AgentsError::NotAuthorized);
        let before = ctx.accounts.vault_quote.amount;
        swap(&ctx, false, tokens_in, min_out)?;
        ctx.accounts.vault_quote.reload()?;
        let out = ctx.accounts.vault_quote.amount.checked_sub(before).ok_or(AgentsError::Slippage)?;
        require!(out >= min_out, AgentsError::Slippage);
        emit!(Traded { agent: ctx.accounts.agent.key(), mint: ctx.accounts.base_mint.key(), buy: false, amount_in: tokens_in, amount_out: out });
        Ok(())
    }

    /// Launch a coin: a Token-2022 mint with our transfer hook on a DBC pool under our config,
    /// created by the agent's vault (so creator fees go to the vault). Registered agents only,
    /// one launch per cooldown.
    pub fn launch(ctx: Context<Launch>, name: String, symbol: String, uri: String) -> Result<()> {
        require!(!name.is_empty() && name.len() <= MAX_NAME, AgentsError::BadArgs);
        require!(!symbol.is_empty() && symbol.len() <= MAX_SYMBOL, AgentsError::BadArgs);
        require!(uri.len() <= MAX_URI, AgentsError::BadArgs);
        let now = Clock::get()?.unix_timestamp;
        let platform = &ctx.accounts.platform;
        let a = &mut ctx.accounts.agent;
        let op = ctx.accounts.operator.key();
        require!(op == a.owner || op == a.session_key, AgentsError::NotAuthorized);
        require!(a.last_launch_at == 0 || now >= a.last_launch_at + platform.launch_cooldown, AgentsError::Cooldown);
        a.last_launch_at = now;

        let agent_key = a.key();
        let vault_seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &[a.vault_bump]];
        let x = &ctx.accounts;
        let mut data = DBC_INIT_POOL_T22_HOOK.to_vec();
        (name.clone(), symbol.clone(), uri).serialize(&mut data)?;
        let accounts = vec![
            AccountMeta::new_readonly(x.dbc_config.key(), false),
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(x.vault.key(), true),
            AccountMeta::new(x.base_mint.key(), true),
            AccountMeta::new_readonly(x.quote_mint.key(), false),
            AccountMeta::new(x.pool.key(), false),
            AccountMeta::new(x.base_vault.key(), false),
            AccountMeta::new(x.quote_vault.key(), false),
            AccountMeta::new_readonly(HOOK_PROGRAM, false),
            AccountMeta::new(x.vault.key(), true),
            AccountMeta::new_readonly(x.token_quote_program.key(), false),
            AccountMeta::new_readonly(x.token_program.key(), false),
            AccountMeta::new_readonly(x.system_program.key(), false),
            AccountMeta::new_readonly(x.dbc_event_authority.key(), false),
            AccountMeta::new_readonly(DBC_PROGRAM, false),
        ];
        invoke_signed(
            &Instruction { program_id: DBC_PROGRAM, accounts, data },
            &[
                x.dbc_config.to_account_info(), x.pool_authority.to_account_info(), x.vault.to_account_info(), x.base_mint.to_account_info(),
                x.quote_mint.to_account_info(), x.pool.to_account_info(), x.base_vault.to_account_info(), x.quote_vault.to_account_info(),
                x.hook_program.to_account_info(), x.token_quote_program.to_account_info(), x.token_program.to_account_info(),
                x.system_program.to_account_info(), x.dbc_event_authority.to_account_info(), x.dbc_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;

        // Register the hook's extra accounts for this mint. Only our hook-authority PDA may, so a pool
        // someone else creates on our public DBC config has no hook accounts and can never trade.
        let hook_seeds: &[&[u8]] = &[b"hook-auth", &[ctx.bumps.hook_authority]];
        invoke_signed(
            &Instruction {
                program_id: HOOK_PROGRAM,
                accounts: vec![
                    AccountMeta::new(x.operator.key(), true),
                    AccountMeta::new(x.extra_account_meta_list.key(), false),
                    AccountMeta::new_readonly(x.base_mint.key(), false),
                    AccountMeta::new_readonly(x.hook_authority.key(), true),
                    AccountMeta::new_readonly(x.system_program.key(), false),
                ],
                data: HOOK_INIT_METAS.to_vec(),
            },
            &[x.operator.to_account_info(), x.extra_account_meta_list.to_account_info(), x.base_mint.to_account_info(), x.hook_authority.to_account_info(), x.system_program.to_account_info()],
            &[hook_seeds],
        )?;

        let c = &mut ctx.accounts.coin;
        c.mint = ctx.accounts.base_mint.key();
        c.launcher = agent_key;
        c.pool = ctx.accounts.pool.key();
        c.opens_at = now + platform.open_window;
        c.opened = false;
        c.bump = ctx.bumps.coin;
        c.name = name.clone();
        c.symbol = symbol.clone();
        emit!(Launched { mint: c.mint, launcher: agent_key, pool: c.pool, name, symbol, opens_at: c.opens_at });
        Ok(())
    }

    /// Permissionless: opens a coin to everyone once its pool holds `open_threshold` SOL or its
    /// opening time has passed. (On EVM the hook flipped this inside the swap; here the runtime cranks it.)
    pub fn open_coin(ctx: Context<OpenCoin>) -> Result<()> {
        let c = &mut ctx.accounts.coin;
        require!(!c.opened, AgentsError::AlreadyOpen);
        let reserve = pool_quote_reserve(&ctx.accounts.pool, &ctx.accounts.platform.dbc_config)?;
        let by_threshold = reserve >= ctx.accounts.platform.open_threshold;
        let by_time = Clock::get()?.unix_timestamp >= c.opens_at;
        require!(by_threshold || by_time, AgentsError::NotYet);
        c.opened = true;
        emit!(Opened { mint: c.mint, by_threshold });
        Ok(())
    }

    /// Permissionless: claims the agent's creator share of trading fees into its vault (as wrapped SOL).
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        let x = &ctx.accounts;
        let agent_key = x.agent.key();
        let seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &[x.agent.vault_bump]];
        let mut data = DBC_CLAIM_CREATOR_FEE.to_vec();
        // Fees are taken in SOL only, so there is never a coin-side amount (and no hook accounts) to claim.
        (0u64, u64::MAX, 0u32).serialize(&mut data)?;
        invoke_signed(
            &Instruction {
                program_id: DBC_PROGRAM,
                accounts: vec![
                    AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
                    AccountMeta::new(x.pool.key(), false),
                    AccountMeta::new(x.vault_base.key(), false),
                    AccountMeta::new(x.vault_quote.key(), false),
                    AccountMeta::new(x.base_vault.key(), false),
                    AccountMeta::new(x.quote_vault.key(), false),
                    AccountMeta::new_readonly(x.base_mint.key(), false),
                    AccountMeta::new_readonly(x.quote_mint.key(), false),
                    AccountMeta::new_readonly(x.vault.key(), true),
                    AccountMeta::new_readonly(x.token_base_program.key(), false),
                    AccountMeta::new_readonly(x.token_quote_program.key(), false),
                    AccountMeta::new_readonly(x.dbc_event_authority.key(), false),
                    AccountMeta::new_readonly(DBC_PROGRAM, false),
                ],
                data,
            },
            &[
                x.pool_authority.to_account_info(), x.pool.to_account_info(), x.vault_base.to_account_info(), x.vault_quote.to_account_info(),
                x.base_vault.to_account_info(), x.quote_vault.to_account_info(), x.base_mint.to_account_info(), x.quote_mint.to_account_info(),
                x.vault.to_account_info(), x.token_base_program.to_account_info(), x.token_quote_program.to_account_info(),
                x.dbc_event_authority.to_account_info(), x.dbc_program.to_account_info(),
            ],
            &[seeds],
        )?;
        Ok(())
    }

    /// Permissionless: claims the platform's (partner) share of a pool's fees and splits it evenly
    /// between the inference pool and the buyback wallet (10% + 10% of the 1%). Pull-based, so a
    /// recipient can never block collection.
    pub fn distribute_fees(ctx: Context<DistributeFees>) -> Result<()> {
        let x = &ctx.accounts;
        let seeds: &[&[u8]] = &[b"fees", &[ctx.bumps.fees]];
        let mut data = DBC_CLAIM_PARTNER_FEE.to_vec();
        // Fees are taken in SOL only, so there is never a coin-side amount (and no hook accounts) to claim.
        (0u64, u64::MAX, 0u32).serialize(&mut data)?;
        invoke_signed(
            &Instruction {
                program_id: DBC_PROGRAM,
                accounts: vec![
                    AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
                    AccountMeta::new_readonly(x.dbc_config.key(), false),
                    AccountMeta::new(x.pool.key(), false),
                    AccountMeta::new(x.fees_base.key(), false),
                    AccountMeta::new(x.fees_quote.key(), false),
                    AccountMeta::new(x.base_vault.key(), false),
                    AccountMeta::new(x.quote_vault.key(), false),
                    AccountMeta::new_readonly(x.base_mint.key(), false),
                    AccountMeta::new_readonly(x.quote_mint.key(), false),
                    AccountMeta::new_readonly(x.fees.key(), true),
                    AccountMeta::new_readonly(x.token_base_program.key(), false),
                    AccountMeta::new_readonly(x.token_quote_program.key(), false),
                    AccountMeta::new_readonly(x.dbc_event_authority.key(), false),
                    AccountMeta::new_readonly(DBC_PROGRAM, false),
                ],
                data,
            },
            &[
                x.pool_authority.to_account_info(), x.dbc_config.to_account_info(), x.pool.to_account_info(), x.fees_base.to_account_info(),
                x.fees_quote.to_account_info(), x.base_vault.to_account_info(), x.quote_vault.to_account_info(), x.base_mint.to_account_info(),
                x.quote_mint.to_account_info(), x.fees.to_account_info(), x.token_base_program.to_account_info(), x.token_quote_program.to_account_info(),
                x.dbc_event_authority.to_account_info(), x.dbc_program.to_account_info(),
            ],
            &[seeds],
        )?;
        ctx.accounts.fees_quote.reload()?;
        let total = ctx.accounts.fees_quote.amount;
        let to_inference = total / 2;
        let to_buyback = total - to_inference;
        for (to, amount) in [(&ctx.accounts.inference_quote, to_inference), (&ctx.accounts.buyback_quote, to_buyback)] {
            if amount == 0 {
                continue;
            }
            token::transfer(
                CpiContext::new_with_signer(ctx.accounts.token_quote_program.to_account_info(), token::Transfer {
                    from: ctx.accounts.fees_quote.to_account_info(),
                    to: to.to_account_info(),
                    authority: ctx.accounts.fees.to_account_info(),
                }, &[seeds]),
                amount,
            )?;
        }
        emit!(FeesDistributed { mint: ctx.accounts.base_mint.key(), to_inference, to_buyback });
        Ok(())
    }
}

/// DBC exact-in swap through the transfer-hook pool, signed by the agent's vault.
fn swap<'info>(ctx: &Context<'_, '_, '_, 'info, Trade<'info>>, buy: bool, amount_in: u64, min_out: u64) -> Result<()> {
    let x = &ctx.accounts;
    require_keys_eq!(x.coin.pool, x.pool.key(), AgentsError::NotPlatformPool);
    // Pool's own config must be ours (DBC also checks the config account matches the pool).
    pool_quote_reserve(&x.pool, &x.platform.dbc_config)?;
    let (input, output) = if buy { (&x.vault_quote, &x.vault_base) } else { (&x.vault_base, &x.vault_quote) };
    let hook = ctx.remaining_accounts;
    let mut data = DBC_SWAP2_WITH_HOOK.to_vec();
    // SwapParameters2 { amount_0, amount_1, swap_mode: ExactIn }, TransferHookAccountsInfo { slices: [TransferHookBase(len)] }
    (amount_in, min_out, 0u8).serialize(&mut data)?;
    (1u32, 0u8, hook.len() as u8).serialize(&mut data)?;
    let mut accounts = vec![
        AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
        AccountMeta::new_readonly(x.dbc_config.key(), false),
        AccountMeta::new(x.pool.key(), false),
        AccountMeta::new(input.key(), false),
        AccountMeta::new(output.key(), false),
        AccountMeta::new(x.base_vault.key(), false),
        AccountMeta::new(x.quote_vault.key(), false),
        AccountMeta::new(x.base_mint.key(), false),
        AccountMeta::new_readonly(x.quote_mint.key(), false),
        AccountMeta::new_readonly(x.vault.key(), true),
        AccountMeta::new_readonly(x.token_base_program.key(), false),
        AccountMeta::new_readonly(x.token_quote_program.key(), false),
        AccountMeta::new_readonly(DBC_PROGRAM, false), // referral: none
        AccountMeta::new_readonly(x.dbc_event_authority.key(), false),
        AccountMeta::new_readonly(DBC_PROGRAM, false),
    ];
    accounts.extend(hook.iter().map(|a| if a.is_writable { AccountMeta::new(a.key(), false) } else { AccountMeta::new_readonly(a.key(), false) }));
    let mut infos = vec![
        x.pool_authority.to_account_info(), x.dbc_config.to_account_info(), x.pool.to_account_info(), input.to_account_info(),
        output.to_account_info(), x.base_vault.to_account_info(), x.quote_vault.to_account_info(), x.base_mint.to_account_info(),
        x.quote_mint.to_account_info(), x.vault.to_account_info(), x.token_base_program.to_account_info(),
        x.token_quote_program.to_account_info(), x.dbc_event_authority.to_account_info(), x.dbc_program.to_account_info(),
    ];
    infos.extend(hook.iter().cloned());
    let agent_key = x.agent.key();
    let seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &[x.agent.vault_bump]];
    invoke_signed(&Instruction { program_id: DBC_PROGRAM, accounts, data }, &infos, &[seeds])?;
    Ok(())
}

/// The pool's SOL reserve, after checking the account is a DBC pool on our config.
fn pool_quote_reserve(pool: &AccountInfo, config: &Pubkey) -> Result<u64> {
    require_keys_eq!(*pool.owner, DBC_PROGRAM, AgentsError::NotPlatformPool);
    let d = pool.try_borrow_data()?;
    require!(d.len() >= POOL_QUOTE_RESERVE_OFFSET + 8, AgentsError::NotPlatformPool);
    let cfg = Pubkey::try_from(&d[POOL_CONFIG_OFFSET..POOL_CONFIG_OFFSET + 32]).map_err(|_| AgentsError::NotPlatformPool)?;
    require_keys_eq!(cfg, *config, AgentsError::NotPlatformPool);
    Ok(u64::from_le_bytes(d[POOL_QUOTE_RESERVE_OFFSET..POOL_QUOTE_RESERVE_OFFSET + 8].try_into().unwrap()))
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Platform {
    pub admin: Pubkey,
    pub dbc_config: Pubkey,
    /// `Pubkey::default()` turns slot gating off.
    pub platform_mint: Pubkey,
    pub hold_per_slot: u64,
    /// Owners of the wrapped-SOL accounts that receive the partner fee split.
    pub inference: Pubkey,
    pub buyback: Pubkey,
    pub open_threshold: u64,
    pub open_window: i64,
    pub launch_cooldown: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PlatformArgs {
    pub dbc_config: Pubkey,
    pub platform_mint: Pubkey,
    pub hold_per_slot: u64,
    pub inference: Pubkey,
    pub buyback: Pubkey,
    pub open_threshold: u64,
    pub open_window: i64,
    pub launch_cooldown: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub session_key: Pubkey,
    pub max_trade: u64,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub day_start: i64,
    pub last_launch_at: i64,
    pub profile_hash: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
    #[max_len(15)]
    pub handle: String,
    #[max_len(64)]
    pub model_id: String,
}

/// Marks a vault as a registered agent's; the transfer hook looks it up by the receiving account's owner.
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub agent: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Slots {
    pub count: u32,
}

/// Fixed-size fields first: the transfer hook reads `mint`, `opens_at` and `opened` by offset.
#[account]
#[derive(InitSpace)]
pub struct Coin {
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub pool: Pubkey,
    pub opens_at: i64,
    pub opened: bool,
    pub bump: u8,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitPlatform<'info> {
    /// Must be the program's upgrade authority, so nobody can front-run setup with their own fee recipients.
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
#[instruction(handle: String)]
pub struct CreateAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(init, payer = owner, space = 8 + Agent::INIT_SPACE, seeds = [b"agent", handle.as_bytes()], bump)]
    pub agent: Account<'info, Agent>,
    /// CHECK: system-owned PDA holding the agent's SOL; only this program can sign for it.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = owner, space = 8 + Member::INIT_SPACE, seeds = [b"member", vault.key().as_ref()], bump)]
    pub member: Account<'info, Member>,
    #[account(init_if_needed, payer = owner, space = 8 + Slots::INIT_SPACE, seeds = [b"slots", owner.key().as_ref()], bump)]
    pub slots: Account<'info, Slots>,
    pub owner_platform_tokens: Option<InterfaceAccount<'info, TokenAccount>>,
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
pub struct Trade<'info> {
    pub operator: Signer<'info>,
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, has_one = vault)]
    pub agent: Box<Account<'info, Agent>>,
    /// CHECK: the agent's vault PDA (has_one); signs the swap.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    #[account(seeds = [b"coin", base_mint.key().as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: must be the platform's DBC config.
    #[account(address = platform.dbc_config @ AgentsError::NotPlatformPool)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC pool for this coin (checked against `coin.pool` and its config).
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DBC's vaults for the pool; DBC checks them.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: as above.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = NATIVE_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = base_mint, token::authority = vault, token::token_program = token_base_program)]
    pub vault_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = vault, token::token_program = token_quote_program)]
    pub vault_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: fixed DBC pool authority.
    #[account(address = DBC_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    pub token_base_program: Interface<'info, TokenInterface>,
    #[account(address = anchor_spl::token::ID)]
    pub token_quote_program: Interface<'info, TokenInterface>,
    /// CHECK: DBC event authority PDA; DBC checks it.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM)]
    pub dbc_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Launch<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut, has_one = vault)]
    pub agent: Box<Account<'info, Agent>>,
    /// CHECK: the agent's vault PDA (has_one); creator and payer of the pool.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: new mint keypair, created by DBC.
    #[account(mut)]
    pub base_mint: Signer<'info>,
    #[account(init, payer = operator, space = 8 + Coin::INIT_SPACE, seeds = [b"coin", base_mint.key().as_ref()], bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: must be the platform's DBC config.
    #[account(address = platform.dbc_config @ AgentsError::NotPlatformPool)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: created by DBC.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: created by DBC.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: created by DBC.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL.
    #[account(address = NATIVE_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: fixed DBC pool authority.
    #[account(address = DBC_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token::ID)]
    pub token_quote_program: Interface<'info, TokenInterface>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: our transfer hook.
    #[account(address = HOOK_PROGRAM)]
    pub hook_program: UncheckedAccount<'info>,
    /// CHECK: created by the hook program.
    #[account(mut)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: PDA that authorises hook registration.
    #[account(seeds = [b"hook-auth"], bump)]
    pub hook_authority: UncheckedAccount<'info>,
    /// CHECK: DBC event authority PDA; DBC checks it.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM)]
    pub dbc_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenCoin<'info> {
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(mut)]
    pub coin: Account<'info, Coin>,
    /// CHECK: the coin's pool (address checked), read for its SOL reserve.
    #[account(address = coin.pool)]
    pub pool: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(has_one = vault)]
    pub agent: Box<Account<'info, Agent>>,
    /// CHECK: the agent's vault PDA (has_one); the pool's creator.
    pub vault: UncheckedAccount<'info>,
    #[account(seeds = [b"coin", base_mint.key().as_ref()], bump = coin.bump, constraint = coin.launcher == agent.key() @ AgentsError::NotOwner)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: the coin's pool.
    #[account(mut, address = coin.pool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, token::mint = base_mint, token::authority = vault, token::token_program = token_base_program)]
    pub vault_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = vault, token::token_program = token_quote_program)]
    pub vault_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DBC checks.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC checks.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = NATIVE_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: fixed DBC pool authority.
    #[account(address = DBC_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
    /// CHECK: DBC checks.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM)]
    pub dbc_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DistributeFees<'info> {
    #[account(seeds = [b"platform"], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    /// CHECK: PDA that is the DBC config's fee claimer.
    #[account(seeds = [b"fees"], bump)]
    pub fees: UncheckedAccount<'info>,
    #[account(seeds = [b"coin", base_mint.key().as_ref()], bump = coin.bump)]
    pub coin: Box<Account<'info, Coin>>,
    /// CHECK: must be the platform's DBC config.
    #[account(address = platform.dbc_config @ AgentsError::NotPlatformPool)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the coin's pool.
    #[account(mut, address = coin.pool)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, token::mint = base_mint, token::authority = fees, token::token_program = token_base_program)]
    pub fees_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = fees, token::token_program = token_quote_program)]
    pub fees_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = platform.inference, token::token_program = token_quote_program)]
    pub inference_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = platform.buyback, token::token_program = token_quote_program)]
    pub buyback_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DBC checks.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC checks.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = NATIVE_MINT)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: fixed DBC pool authority.
    #[account(address = DBC_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    pub token_base_program: Interface<'info, TokenInterface>,
    #[account(address = anchor_spl::token::ID)]
    pub token_quote_program: Interface<'info, TokenInterface>,
    /// CHECK: DBC checks.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM)]
    pub dbc_program: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------- events and errors

#[event]
pub struct AgentCreated { pub agent: Pubkey, pub vault: Pubkey, pub owner: Pubkey, pub handle: String, pub model_id: String, pub profile_hash: [u8; 32] }
#[event]
pub struct SessionSet { pub agent: Pubkey, pub session_key: Pubkey, pub max_trade: u64, pub daily_limit: u64 }
#[event]
pub struct Withdrawn { pub agent: Pubkey, pub asset: Pubkey, pub to: Pubkey, pub amount: u64 }
#[event]
pub struct Traded { pub agent: Pubkey, pub mint: Pubkey, pub buy: bool, pub amount_in: u64, pub amount_out: u64 }
#[event]
pub struct Launched { pub mint: Pubkey, pub launcher: Pubkey, pub pool: Pubkey, pub name: String, pub symbol: String, pub opens_at: i64 }
#[event]
pub struct Opened { pub mint: Pubkey, pub by_threshold: bool }
#[event]
pub struct FeesDistributed { pub mint: Pubkey, pub to_inference: u64, pub to_buyback: u64 }

#[error_code]
pub enum AgentsError {
    #[msg("Handle must be 2-15 characters, a-z and 0-9")]
    BadHandle,
    #[msg("Bad arguments")]
    BadArgs,
    #[msg("Not enough of the platform token for another agent slot")]
    NotEnoughPlatformToken,
    #[msg("Funding must cover the vault's rent-exempt minimum")]
    FundTooSmall,
    #[msg("Only the agent's owner may do this")]
    NotOwner,
    #[msg("Only the owner or the session key may do this")]
    NotAuthorized,
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
    #[msg("Not one of this platform's pools")]
    NotPlatformPool,
    #[msg("Launch cooldown: one launch per hour")]
    Cooldown,
    #[msg("Coin is already open")]
    AlreadyOpen,
    #[msg("Coin has neither reached its threshold nor its opening time")]
    NotYet,
    #[msg("Only the program's upgrade authority can set up the platform")]
    NotUpgradeAuthority,
}
