//! Token-2022 transfer hook for agent coins: the Solana version of LaunchHook.beforeSwap.
//!
//! Until a coin opens (its pool reaches the SOL threshold, or its opening time passes), coins
//! may only move into a registered agent's vault or back into the DBC pool. After that, any
//! transfer goes through. Coins this platform didn't launch have no registered extra accounts,
//! so they can't be transferred at all: a stray pool on our public DBC config can't trade.
//!
//! DBC removes the hook when a curve completes (graduation), so the opening threshold must sit
//! below the graduation threshold.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9");

pub const AGENTS_PROGRAM: Pubkey = pubkey!("4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r");
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");

#[program]
pub mod agents_hook {
    use super::*;

    /// Called by the agents program at launch (signed by its `hook-auth` PDA) for each new coin.
    pub fn initialize_extra_account_meta_list(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
        let metas = extra_metas()?;
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
        Ok(())
    }

    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        let coin = read_coin(&ctx.accounts.coin, &ctx.accounts.mint.key())?;
        if coin.opened || Clock::get()?.unix_timestamp >= coin.opens_at {
            return Ok(());
        }
        // Agents-only phase: into the pool (a sell), or into a registered agent's vault (a buy).
        let to_owner = ctx.accounts.destination_token.owner;
        if to_owner == DBC_POOL_AUTHORITY {
            return Ok(());
        }
        let member = &ctx.accounts.member;
        let (expected, _) = Pubkey::find_program_address(&[b"member", to_owner.as_ref()], &AGENTS_PROGRAM);
        require_keys_eq!(member.key(), expected, HookError::AgentsOnly);
        require_keys_eq!(*member.owner, AGENTS_PROGRAM, HookError::AgentsOnly);
        let d = member.try_borrow_data()?;
        require!(d.len() >= 8 && d[..8] == *<agents::Member as anchor_lang::Discriminator>::DISCRIMINATOR, HookError::AgentsOnly);
        Ok(())
    }
}

/// Extra accounts after the standard five (source, mint, destination, owner, this list):
/// 5 the agents program, 6 the coin's `["coin", mint]` record, 7 the `["member", destination owner]` marker.
fn extra_metas() -> Result<Vec<ExtraAccountMeta>> {
    Ok(vec![
        ExtraAccountMeta::new_with_pubkey(&AGENTS_PROGRAM, false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(5, &[Seed::Literal { bytes: b"coin".to_vec() }, Seed::AccountKey { index: 1 }], false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[Seed::Literal { bytes: b"member".to_vec() }, Seed::AccountData { account_index: 2, data_index: 32, length: 32 }],
            false,
            false,
        )?,
    ])
}

struct CoinView { opens_at: i64, opened: bool }

fn read_coin(coin: &AccountInfo, mint: &Pubkey) -> Result<CoinView> {
    require_keys_eq!(*coin.owner, AGENTS_PROGRAM, HookError::UnknownCoin);
    let d = coin.try_borrow_data()?;
    require!(d.len() >= 8 + 32 * 3 + 8 + 1, HookError::UnknownCoin);
    require!(d[..8] == *<agents::Coin as anchor_lang::Discriminator>::DISCRIMINATOR, HookError::UnknownCoin);
    require!(&d[8..40] == mint.as_ref(), HookError::UnknownCoin);
    let o = 8 + 32 * 3;
    Ok(CoinView { opens_at: i64::from_le_bytes(d[o..o + 8].try_into().unwrap()), opened: d[o + 8] != 0 })
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the validation account for `mint`, created here.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(3).unwrap(),
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// The agents program's `hook-auth` PDA: only coins launched through it get hook accounts.
    #[account(seeds = [b"hook-auth"], bump, seeds::program = AGENTS_PROGRAM)]
    pub hook_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source owner or delegate; not used.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validation account.
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: the agents program id.
    #[account(address = AGENTS_PROGRAM)]
    pub agents_program: UncheckedAccount<'info>,
    /// CHECK: read by `read_coin`.
    pub coin: UncheckedAccount<'info>,
    /// CHECK: checked in the handler.
    pub member: UncheckedAccount<'info>,
}

#[error_code]
pub enum HookError {
    #[msg("This coin is in its agents-only phase: it can only go to a registered agent or the pool")]
    AgentsOnly,
    #[msg("Not a coin launched on this platform")]
    UnknownCoin,
}

#[cfg(test)]
mod tests {
    /// The hook hard-codes the agents program's ids (constants can't reference another crate's statics on this toolchain).
    #[test]
    fn ids_match_the_agents_program() {
        assert_eq!(super::AGENTS_PROGRAM, agents::ID);
        assert_eq!(super::DBC_POOL_AUTHORITY, agents::DBC_POOL_AUTHORITY);
        assert_eq!(agents::HOOK_PROGRAM, super::ID);
    }
}
