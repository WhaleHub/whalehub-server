#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, Env, String, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub version: u32,
    pub total_supply: i128,
    pub treasury_address: Address,
    pub reward_rate: i128, // basis points per day
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockEntry {
    pub user: Address,
    pub amount: i128,
    pub lock_timestamp: u64,
    pub duration_days: u32,
    pub reward_multiplier: i128,
    pub tx_hash: Bytes,
    pub pol_contributed: i128, // 10% of locked AQUA that goes to POL
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockTotals {
    pub total_locked_aqua: i128,
    pub total_entries: u32,
    pub last_update_ts: u64,
    pub accumulated_rewards: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LpPosition {
    pub pool_id: Bytes,
    pub total_asset_a: i128,
    pub total_asset_b: i128,
    pub last_tx: Bytes,
    pub last_update_ts: u64,
    pub lp_shares: i128,
    pub reward_debt: i128, // for reward calculation
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnlockEntry {
    pub amount: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlubRestakeEntry {
    pub amount: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
    pub previous_amount: i128, // track restake additions
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardTotals {
    pub lp_total: i128,
    pub locked_total: i128,
    pub last_update_ts: u64,
    pub pending_lp: i128, // unclaimed LP rewards
    pub pending_locked: i128, // unclaimed locked rewards
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardDistribution {
    pub kind: u32, // 0 = LP, 1 = LOCKED
    pub pool_id: Bytes,
    pub total_reward: i128,
    pub distributed_amount: i128,
    pub treasury_amount: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
    pub user_count: u32,
}

// Gas-optimized global state
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalState {
    pub total_locked: i128,
    pub total_lp_staked: i128,
    pub total_users: u32,
    pub last_reward_update: u64,
    pub reward_per_locked_token: i128, // accumulated rewards per token (with precision)
    pub reward_per_lp_token: i128, // accumulated rewards per LP token (with precision)
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolOwnedLiquidity {
    pub total_aqua_contributed: i128, // Total 10% AQUA from all locks
    pub total_blub_contributed: i128, // Total 10% BLUB from all locks
    pub aqua_blub_lp_position: i128, // Total LP tokens held by protocol
    pub total_pol_rewards_earned: i128, // Total rewards earned from POL voting
    pub last_reward_claim: u64,
    pub ice_voting_power_used: i128, // ICE tokens used for voting on AQUA-BLUB pair
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    UserLockCount(Address),
    UserLockByIndex(Address, u32),
    UserLpCount(Address),
    UserLpByIndex(Address, u32),
    UserUnlockCount(Address),
    UserUnlockByIndex(Address, u32),
    UserBlubRestakeCount(Address),
    UserBlubRestakeByIndex(Address, u32),
    LockTotals,
    LpTotals,
    UserRewards(Address),
    DistributionCount,
    DistributionByIndex(u32),
    GlobalState,
    RewardSnapshot(u64),
    ProtocolOwnedLiquidity, // POL tracking
    DailyPolSnapshot(u64), // Daily POL performance snapshots
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidInput = 4,
    NotFound = 5,
    InsufficientBalance = 6,
    RewardCalculationFailed = 7,
    UnlockNotReady = 8,
    AlreadyClaimed = 9,
}

// Events remain the same but add gas-optimized reward events
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockRecordedEvent {
    pub user: Address,
    pub amount: i128,
    pub duration_days: u32,
    pub reward_multiplier: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
    pub lock_index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LpDepositRecordedEvent {
    pub user: Address,
    pub pool_id: Bytes,
    pub amount_a: i128,
    pub amount_b: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnlockRecordedEvent {
    pub user: Address,
    pub amount: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
    pub entry_index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlubRestakeRecordedEvent {
    pub user: Address,
    pub amount: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
    pub entry_index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardDistributionRecordedEvent {
    pub kind: u32,
    pub pool_id: Bytes,
    pub total_reward: i128,
    pub distributed_amount: i128,
    pub treasury_amount: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
    pub distribution_index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardCreditedEvent {
    pub kind: u32, // 0 = LP, 1 = LOCKED
    pub user: Address,
    pub pool_id: Bytes,
    pub amount: i128,
    pub tx_hash: Bytes,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolContributionEvent {
    pub user: Address,
    pub aqua_locked: i128,
    pub pol_aqua_amount: i128, // 10% of locked AQUA
    pub pol_blub_amount: i128, // 10% of minted BLUB
    pub total_pol_aqua: i128,
    pub total_pol_blub: i128,
    pub timestamp: u64,
    pub lock_index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolRewardsClaimedEvent {
    pub reward_amount: i128,
    pub ice_voting_power: i128,
    pub total_pol_rewards: i128,
    pub reward_distribution_to_users: i128, // 70% to users
    pub treasury_amount: i128, // 30% to treasury
    pub timestamp: u64,
}

// Gas-optimized batch reward calculation event
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchRewardCalculatedEvent {
    pub kind: u32,
    pub total_amount: i128,
    pub user_count: u32,
    pub timestamp: u64,
}

#[contract]
pub struct StakingRegistry;

#[contractimpl]
impl StakingRegistry {
    pub fn initialize(env: Env, admin: Address, treasury_address: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        let cfg = Config { 
            admin: admin.clone(),
            version: 2,
            total_supply: 0,
            treasury_address,
            reward_rate: 100, // 1% per day default
        };
        env.storage().instance().set(&DataKey::Config, &cfg);

        // Initialize global state
        let global_state = GlobalState {
            total_locked: 0,
            total_lp_staked: 0,
            total_users: 0,
            last_reward_update: env.ledger().timestamp(),
            reward_per_locked_token: 0,
            reward_per_lp_token: 0,
        };
        env.storage().instance().set(&DataKey::GlobalState, &global_state);

        // Initialize POL state
        let pol = ProtocolOwnedLiquidity {
            total_aqua_contributed: 0,
            total_blub_contributed: 0,
            aqua_blub_lp_position: 0,
            total_pol_rewards_earned: 0,
            last_reward_claim: 0,
            ice_voting_power_used: 0,
        };
        env.storage().instance().set(&DataKey::ProtocolOwnedLiquidity, &pol);
        
        Ok(())
    }

    pub fn get_config(env: Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    // Staking/unstaking/restaking logic

    /// Record AQUA lock with POL contribution (admin-only)
    pub fn record_lock(
        env: Env,
        admin: Address,
        user: Address,
        amount: i128,
        duration_days: u32,
        tx_hash: Bytes,
    ) -> Result<u32, Error> {
        let config = Self::get_config(&env)?;
        admin.require_auth();
        
        if config.admin != admin {
            return Err(Error::Unauthorized);
        }

        if amount <= 0 {
            return Err(Error::InvalidInput);
        }

        let now = env.ledger().timestamp();

        // Calculate reward multiplier based on lock duration
        let reward_multiplier = Self::calculate_lock_multiplier(duration_days);
        
        // Calculate POL contribution (10% of locked AQUA)
        let pol_contribution = amount / 10; // 10% to POL

        // Get user's lock count
        let mut count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserLockCount(user.clone()))
            .unwrap_or(0);
        let index = count;
        count = count.saturating_add(1);
        env.storage().persistent().set(&DataKey::UserLockCount(user.clone()), &count);

        // Create lock record with POL tracking
        let lock = LockEntry {
            user: user.clone(),
            amount,
            lock_timestamp: now,
            duration_days,
            reward_multiplier,
            tx_hash: tx_hash.clone(),
            pol_contributed: pol_contribution,
        };

        env.storage()
            .persistent()
            .set(&DataKey::UserLockByIndex(user.clone(), index), &lock);

        // Update lock totals
        Self::update_lock_totals(&env, amount, reward_multiplier)?;

        // Update POL tracking
        Self::update_pol_contribution(&env, pol_contribution, pol_contribution)?; // BLUB=AQUA 1:1

        // Update global state
        Self::update_global_state(&env)?;

        // Emit POL contribution event
        let pol = Self::get_pol(&env);
        let pol_event = PolContributionEvent {
            user: user.clone(),
            aqua_locked: amount,
            pol_aqua_amount: pol_contribution,
            pol_blub_amount: pol_contribution, // 1:1 AQUA:BLUB
            total_pol_aqua: pol.total_aqua_contributed,
            total_pol_blub: pol.total_blub_contributed,
            timestamp: now,
            lock_index: index,
        };
        env.events().publish((symbol_short!("pol"),), pol_event);

        // Emit lock event
        let event = LockRecordedEvent {
            user: user.clone(),
            amount,
            duration_days,
            reward_multiplier,
            tx_hash,
            timestamp: now,
            lock_index: index,
        };
        env.events().publish((symbol_short!("lock"),), event);

        Ok(index)
    }

    pub fn record_unlock(env: Env, admin: Address, user: Address, amount: i128, tx_hash: Bytes) -> Result<u32, Error> {
        let cfg = Self::get_config(env.clone())?;
        admin.require_auth();
        if cfg.admin != admin { return Err(Error::Unauthorized); }
        if amount <= 0 { return Err(Error::InvalidInput); }

        let now = env.ledger().timestamp();

        // Update global state efficiently  
        Self::update_global_state(&env, -amount, 0, false)?;

        let mut count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserUnlockCount(user.clone()))
            .unwrap_or(0);
        let index = count;
        count = count.saturating_add(1);
        env.storage().persistent().set(&DataKey::UserUnlockCount(user.clone()), &count);

        let entry = UnlockEntry { 
            amount, 
            tx_hash: tx_hash.clone(), 
            timestamp: now,
            claimed: false,
        };
        env.storage().persistent().set(&DataKey::UserUnlockByIndex(user.clone(), index), &entry);

        // Update user totals with final reward calculation
        let mut totals: LockTotals = env
            .storage()
            .persistent()
            .get(&DataKey::UserLockTotals(user.clone()))
            .unwrap_or(LockTotals { 
                total_locked_aqua: 0, 
                total_entries: 0, 
                last_update_ts: 0,
                accumulated_rewards: 0,
            });

        // Calculate final rewards before unlock
        let pending_rewards = Self::calculate_pending_rewards(&env, &user, &totals, now)?;
        totals.accumulated_rewards = totals.accumulated_rewards.saturating_add(pending_rewards);

        if totals.total_locked_aqua >= amount {
            totals.total_locked_aqua -= amount;
        } else {
            totals.total_locked_aqua = 0;
        }
        totals.last_update_ts = now;
        env.storage().persistent().set(&DataKey::UserLockTotals(user.clone()), &totals);

        let evt = UnlockRecordedEvent { 
            user: user.clone(), 
            amount, 
            tx_hash, 
            timestamp: now, 
            entry_index: index 
        };
        env.events().publish((symbol_short!("unlock"),), evt);

        Ok(index)
    }

    pub fn record_blub_restake(env: Env, admin: Address, user: Address, amount: i128, tx_hash: Bytes) -> Result<u32, Error> {
        let cfg = Self::get_config(env.clone())?;
        admin.require_auth();
        if cfg.admin != admin { return Err(Error::Unauthorized); }
        if amount <= 0 { return Err(Error::InvalidInput); }

        let now = env.ledger().timestamp();

        // Get previous amount for tracking compound growth
        let previous_amount = {
            let current_count: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::UserBlubRestakeCount(user.clone()))
                .unwrap_or(0);
            
            if current_count > 0 {
                env.storage()
                    .persistent()
                    .get::<DataKey, BlubRestakeEntry>(&DataKey::UserBlubRestakeByIndex(user.clone(), current_count - 1))
                    .map(|entry| entry.amount)
                    .unwrap_or(0)
            } else {
                0
            }
        };

        let mut count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserBlubRestakeCount(user.clone()))
            .unwrap_or(0);
        let index = count;
        count = count.saturating_add(1);
        env.storage().persistent().set(&DataKey::UserBlubRestakeCount(user.clone()), &count);

        let entry = BlubRestakeEntry { 
            amount, 
            tx_hash: tx_hash.clone(), 
            timestamp: now,
            previous_amount,
        };
        env.storage().persistent().set(&DataKey::UserBlubRestakeByIndex(user.clone(), index), &entry);

        let evt = BlubRestakeRecordedEvent { 
            user: user.clone(),
            amount, 
            tx_hash, 
            timestamp: now, 
            entry_index: index 
        };
        env.events().publish((symbol_short!("rstk"),), evt);

        Ok(index)
    }

    pub fn record_lp_deposit(
        env: Env,
        admin: Address,
        user: Address,
        pool_id: Bytes,
        amount_a: i128,
        amount_b: i128,
        tx_hash: Bytes,
    ) -> Result<(), Error> {
        let cfg = Self::get_config(env.clone())?;
        admin.require_auth();
        if cfg.admin != admin { return Err(Error::Unauthorized); }
        if amount_a < 0 || amount_b < 0 { return Err(Error::InvalidInput); }

        let now = env.ledger().timestamp();

        // Calculate LP shares
        let lp_shares = Self::calculate_lp_shares(amount_a, amount_b);

        // Update global LP state
        Self::update_global_state(&env, 0, lp_shares, true)?;

        let mut pools: Vec<Bytes> = env
            .storage()
            .persistent()
            .get(&DataKey::UserPools(user.clone()))
            .unwrap_or(Vec::new(&env));
        let mut found = false;
        for existing in pools.iter() {
            if existing == pool_id {
                found = true;
                break;
            }
        }
        if !found {
            pools.push_back(pool_id.clone());
            env.storage().persistent().set(&DataKey::UserPools(user.clone()), &pools);
        }

        let mut pos: LpPosition = env
            .storage()
            .persistent()
            .get(&DataKey::UserLp(user.clone(), pool_id.clone()))
            .unwrap_or(LpPosition {
                pool_id: pool_id.clone(),
                total_asset_a: 0,
                total_asset_b: 0,
                last_tx: Bytes::new(&env),
                last_update_ts: 0,
                lp_shares: 0,
                reward_debt: 0,
            });

        // Calculate pending LP rewards before update
        let global_state = Self::get_global_state(&env)?;
        let pending_lp_rewards = pos.lp_shares.saturating_mul(global_state.reward_per_lp_token) / 1_000_000 - pos.reward_debt;

        pos.total_asset_a = pos.total_asset_a.saturating_add(amount_a);
        pos.total_asset_b = pos.total_asset_b.saturating_add(amount_b);
        pos.lp_shares = pos.lp_shares.saturating_add(lp_shares);
        pos.last_tx = tx_hash.clone();
        pos.last_update_ts = now;
        pos.reward_debt = pos.lp_shares.saturating_mul(global_state.reward_per_lp_token) / 1_000_000;

        env.storage()
            .persistent()
            .set(&DataKey::UserLp(user.clone(), pool_id.clone()), &pos);

        // Update user rewards if there were pending rewards
        if pending_lp_rewards > 0 {
            Self::update_user_reward_totals(&env, &user, pending_lp_rewards, 0, now)?;
        }

        let evt = LpDepositRecordedEvent {
            user: user.clone(),
            pool_id,
            amount_a,
            amount_b,
            tx_hash,
            timestamp: now,
        };
        env.events().publish((symbol_short!("lpdep"),), evt);

        Ok(())
    }

    // Reward calculation and distribution functions

    pub fn calculate_user_rewards(env: Env, user: Address) -> Result<UserRewardTotals, Error> {
        let now = env.ledger().timestamp();
        
        // Get current totals
        let mut totals: UserRewardTotals = env
            .storage()
            .persistent()
            .get(&DataKey::UserRewards(user.clone()))
            .unwrap_or(UserRewardTotals { 
                lp_total: 0, 
                locked_total: 0, 
                last_update_ts: 0,
                pending_lp: 0,
                pending_locked: 0,
            });

        // Calculate locked rewards
        let lock_totals: LockTotals = env
            .storage()
            .persistent()
            .get(&DataKey::UserLockTotals(user.clone()))
            .unwrap_or(LockTotals { 
                total_locked_aqua: 0, 
                total_entries: 0, 
                last_update_ts: 0,
                accumulated_rewards: 0,
            });

        let pending_locked_rewards = Self::calculate_pending_rewards(&env, &user, &lock_totals, now)?;
        totals.pending_locked = lock_totals.accumulated_rewards.saturating_add(pending_locked_rewards);

        // Calculate LP rewards for all pools
        let pools: Vec<Bytes> = env
            .storage()
            .persistent()
            .get(&DataKey::UserPools(user.clone()))
            .unwrap_or(Vec::new(&env));

        let mut total_pending_lp = 0i128;
        let global_state = Self::get_global_state(&env)?;

        for pool_id in pools.iter() {
            if let Some(pos) = env.storage().persistent().get::<DataKey, LpPosition>(&DataKey::UserLp(user.clone(), pool_id.clone())) {
                let pending_pool_rewards = pos.lp_shares.saturating_mul(global_state.reward_per_lp_token) / 1_000_000 - pos.reward_debt;
                total_pending_lp = total_pending_lp.saturating_add(pending_pool_rewards);
            }
        }

        totals.pending_lp = totals.lp_total.saturating_add(total_pending_lp);
        totals.last_update_ts = now;

        Ok(totals)
    }

    pub fn record_reward_distribution(
        env: Env,
        admin: Address,
        kind: u32, // 0 = LP, 1 = LOCKED
        pool_id: Bytes,
        total_reward: i128,
        distributed_amount: i128,
        treasury_amount: i128,
        tx_hash: Bytes,
    ) -> Result<u32, Error> {
        let cfg = Self::get_config(env.clone())?;
        admin.require_auth();
        if cfg.admin != admin { return Err(Error::Unauthorized); }
        if total_reward < 0 || distributed_amount < 0 || treasury_amount < 0 { 
            return Err(Error::InvalidInput); 
        }

        let now = env.ledger().timestamp();

        // Update global reward rates for gas-efficient future calculations
        Self::update_reward_rates(&env, kind, distributed_amount)?;

        let mut dcount: u32 = env.storage().instance().get(&DataKey::DistributionCount).unwrap_or(0);
        let idx = dcount;
        dcount = dcount.saturating_add(1);
        env.storage().instance().set(&DataKey::DistributionCount, &dcount);

        // Estimate user count based on global state
        let global_state = Self::get_global_state(&env)?;
        let estimated_users = if kind == 0 { 
            global_state.total_users / 2 // Rough estimate for LP users
        } else { 
            global_state.total_users 
        };

        let dist = RewardDistribution {
            kind,
            pool_id: pool_id.clone(),
            total_reward,
            distributed_amount,
            treasury_amount,
            tx_hash: tx_hash.clone(),
            timestamp: now,
            user_count: estimated_users,
        };
        env.storage().instance().set(&DataKey::DistributionByIndex(idx), &dist);

        let evt = RewardDistributionRecordedEvent {
            kind,
            pool_id,
            total_reward,
            distributed_amount,
            treasury_amount,
            tx_hash,
            timestamp: now,
            distribution_index: idx,
        };
        env.events().publish((symbol_short!("dist"),), evt);

        // Emit batch calculation event for gas tracking
        let batch_evt = BatchRewardCalculatedEvent {
            kind,
            total_amount: distributed_amount,
            user_count: estimated_users,
            timestamp: now,
        };
        env.events().publish((symbol_short!("batch"),), batch_evt);

        Ok(idx)
    }

    pub fn credit_user_reward(
        env: Env,
        admin: Address,
        kind: u32, // 0 = LP, 1 = LOCKED
        user: Address,
        pool_id: Bytes,
        amount: i128,
        tx_hash: Bytes,
    ) -> Result<(), Error> {
        let cfg = Self::get_config(env.clone())?;
        admin.require_auth();
        if cfg.admin != admin { return Err(Error::Unauthorized); }
        if amount <= 0 { return Err(Error::InvalidInput); }

        let now = env.ledger().timestamp();

        Self::update_user_reward_totals(&env, &user, 
            if kind == 0 { amount } else { 0 },
            if kind == 1 { amount } else { 0 },
            now)?;

        let evt = UserRewardCreditedEvent { 
            kind, 
            user: user.clone(), 
            pool_id, 
            amount, 
            tx_hash, 
            timestamp: now 
        };
        env.events().publish((symbol_short!("ucred"),), evt);
        
        Ok(())
    }

    /// Record POL rewards claimed from AQUA-BLUB pair voting (admin-only)
    pub fn record_pol_rewards(
        env: Env,
        admin: Address,
        reward_amount: i128,
        ice_voting_power: i128,
    ) -> Result<(), Error> {
        let config = Self::get_config(&env)?;
        admin.require_auth();
        
        if config.admin != admin {
            return Err(Error::Unauthorized);
        }

        if reward_amount <= 0 {
            return Err(Error::InvalidInput);
        }

        let now = env.ledger().timestamp();

        // Get current POL state
        let mut pol = Self::get_pol(&env);
        pol.total_pol_rewards_earned = pol.total_pol_rewards_earned.saturating_add(reward_amount);
        pol.last_reward_claim = now;
        pol.ice_voting_power_used = ice_voting_power;

        env.storage().instance().set(&DataKey::ProtocolOwnedLiquidity, &pol);

        // Calculate distribution: 70% to users, 30% to treasury
        let user_distribution = (reward_amount * 70) / 100;
        let treasury_amount = reward_amount - user_distribution;

        // Create daily snapshot
        let day = now / 86400;
        env.storage().instance().set(&DataKey::DailyPolSnapshot(day), &pol);

        // Emit POL rewards event
        let event = PolRewardsClaimedEvent {
            reward_amount,
            ice_voting_power,
            total_pol_rewards: pol.total_pol_rewards_earned,
            reward_distribution_to_users: user_distribution,
            treasury_amount,
            timestamp: now,
        };
        env.events().publish((symbol_short!("polrew"),), event);
        
        Ok(())
    }

    // Gas optimization

    fn update_global_state(env: &Env, locked_delta: i128, lp_delta: i128, is_new_user: bool) -> Result<(), Error> {
        let mut global_state = Self::get_global_state(env)?;
        
        global_state.total_locked = global_state.total_locked.saturating_add(locked_delta);
        global_state.total_lp_staked = global_state.total_lp_staked.saturating_add(lp_delta);
        
        if is_new_user {
            global_state.total_users = global_state.total_users.saturating_add(1);
        }
        
        global_state.last_reward_update = env.ledger().timestamp();
        
        env.storage().instance().set(&DataKey::GlobalState, &global_state);
        Ok(())
    }

    fn update_reward_rates(env: &Env, kind: u32, distributed_amount: i128) -> Result<(), Error> {
        let mut global_state = Self::get_global_state(env)?;
        
        if kind == 0 && global_state.total_lp_staked > 0 {
            // Update LP reward rate
            let rate_increase = (distributed_amount * 1_000_000) / global_state.total_lp_staked;
            global_state.reward_per_lp_token = global_state.reward_per_lp_token.saturating_add(rate_increase);
        } else if kind == 1 && global_state.total_locked > 0 {
            // Update locked reward rate  
            let rate_increase = (distributed_amount * 1_000_000) / global_state.total_locked;
            global_state.reward_per_locked_token = global_state.reward_per_locked_token.saturating_add(rate_increase);
        }
        
        env.storage().instance().set(&DataKey::GlobalState, &global_state);
        Ok(())
    }

    fn update_user_reward_totals(env: &Env, user: &Address, lp_amount: i128, locked_amount: i128, timestamp: u64) -> Result<(), Error> {
        let mut totals: UserRewardTotals = env
            .storage()
            .persistent()
            .get(&DataKey::UserRewards(user.clone()))
            .unwrap_or(UserRewardTotals { 
                lp_total: 0, 
                locked_total: 0, 
                last_update_ts: 0,
                pending_lp: 0,
                pending_locked: 0,
            });

        totals.lp_total = totals.lp_total.saturating_add(lp_amount);
        totals.locked_total = totals.locked_total.saturating_add(locked_amount);
        totals.last_update_ts = timestamp;
        
        env.storage().persistent().set(&DataKey::UserRewards(user.clone()), &totals);
        Ok(())
    }

    /// Update POL contribution tracking
    fn update_pol_contribution(env: &Env, aqua_amount: i128, blub_amount: i128) -> Result<(), Error> {
        let mut pol: ProtocolOwnedLiquidity = env
            .storage()
            .instance()
            .get(&DataKey::ProtocolOwnedLiquidity)
            .unwrap_or_default();

        pol.total_aqua_contributed = pol.total_aqua_contributed.saturating_add(aqua_amount);
        pol.total_blub_contributed = pol.total_blub_contributed.saturating_add(blub_amount);

        env.storage().instance().set(&DataKey::ProtocolOwnedLiquidity, &pol);

        Ok(())
    }

    /// Get Protocol Owned Liquidity state
    fn get_pol(env: &Env) -> ProtocolOwnedLiquidity {
        env.storage()
            .instance()
            .get(&DataKey::ProtocolOwnedLiquidity)
            .unwrap_or_default()
    }

    fn update_lock_totals(env: &Env, amount: i128, reward_multiplier: i128) -> Result<(), Error> {
        let mut totals: LockTotals = env
            .storage()
            .persistent()
            .get(&DataKey::LockTotals)
            .unwrap_or(LockTotals {
                total_locked_aqua: 0,
                total_entries: 0,
                last_update_ts: 0,
                accumulated_rewards: 0,
            });

        totals.total_locked_aqua = totals.total_locked_aqua.saturating_add(amount);
        totals.total_entries = totals.total_entries.saturating_add(1);
        totals.last_update_ts = env.ledger().timestamp();

        env.storage().persistent().set(&DataKey::LockTotals, &totals);
        Ok(())
    }

    fn calculate_lock_multiplier(duration_days: u32) -> i128 {
        // Convert days to basis points multiplier
        // Longer locks get higher multipliers (similar to ICE calculation)
        let base_multiplier = 10000; // 1.0x for minimum lock
        let duration_bonus = (duration_days as i128 * 100).min(10000); // Max 1.0x bonus
        base_multiplier + duration_bonus
    }

    fn calculate_lp_shares(amount_a: i128, amount_b: i128) -> i128 {
        // Simplified LP share calculation mirroring AMM logic
        if amount_a <= 0 || amount_b <= 0 { return 0; }
        // Geometric mean for LP shares (gas-optimized integer sqrt approximation)
        Self::integer_sqrt(amount_a.saturating_mul(amount_b))
    }

    fn integer_sqrt(value: i128) -> i128 {
        if value < 2 { return value; }
        let mut x = value;
        let mut y = (x + 1) / 2;
        while y < x {
            x = y;
            y = (x + value / x) / 2;
        }
        x
    }

    fn calculate_pending_rewards(env: &Env, user: &Address, totals: &LockTotals, current_time: u64) -> Result<i128, Error> {
        if totals.total_locked_aqua == 0 || totals.last_update_ts >= current_time {
            return Ok(0);
        }

        let cfg = Self::get_config(env.clone())?;
        let time_diff = current_time.saturating_sub(totals.last_update_ts);
        let days_elapsed = time_diff / 86400; // seconds per day

        if days_elapsed == 0 { return Ok(0); }

        // Get user's accumulated multiplier from all locks
        let total_multiplier = Self::get_user_total_multiplier(env, user)?;

        // Calculate base reward: amount * rate * days * multiplier / 10000 / 10000
        let base_reward = totals.total_locked_aqua
            .saturating_mul(cfg.reward_rate as i128)
            .saturating_mul(days_elapsed as i128)
            .saturating_mul(total_multiplier)
            / 100_000_000; // 10000 * 10000 for basis points and multiplier

        Ok(base_reward)
    }

    fn get_user_total_multiplier(env: &Env, user: &Address) -> Result<i128, Error> {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserLockCount(user.clone()))
            .unwrap_or(0);

        if count == 0 { return Ok(10000); } // Default 1x multiplier

        let mut total_amount = 0i128;
        let mut weighted_multiplier = 0i128;

        for i in 0..count {
            if let Some(entry) = env.storage().persistent().get::<DataKey, LockEntry>(&DataKey::UserLockByIndex(user.clone(), i)) {
                total_amount = total_amount.saturating_add(entry.amount);
                weighted_multiplier = weighted_multiplier.saturating_add(
                    entry.amount.saturating_mul(entry.reward_multiplier)
                );
            }
        }

        if total_amount == 0 { return Ok(10000); }
        Ok(weighted_multiplier / total_amount)
    }

    fn get_global_state(env: &Env) -> Result<GlobalState, Error> {
        env.storage()
            .instance()
            .get(&DataKey::GlobalState)
            .ok_or(Error::NotInitialized)
    }

    // Getters (gas-optimized, return only essential data)
    pub fn get_user_lock_totals(env: Env, user: Address) -> Option<LockTotals> {
        env.storage().persistent().get(&DataKey::UserLockTotals(user))
    }

    pub fn get_user_lock_count(env: Env, user: Address) -> u32 {
        env.storage().persistent().get(&DataKey::UserLockCount(user)).unwrap_or(0)
    }

    pub fn get_user_lock_by_index(env: Env, user: Address, index: u32) -> Option<LockEntry> {
        env.storage().persistent().get(&DataKey::UserLockByIndex(user, index))
    }

    pub fn get_user_pools(env: Env, user: Address) -> Vec<Bytes> {
        env.storage().persistent().get(&DataKey::UserPools(user)).unwrap_or(Vec::new(&env))
    }

    pub fn get_user_lp(env: Env, user: Address, pool_id: Bytes) -> Option<LpPosition> {
        env.storage().persistent().get(&DataKey::UserLp(user, pool_id))
    }

    pub fn get_user_rewards(env: Env, user: Address) -> Option<UserRewardTotals> {
        env.storage().persistent().get(&DataKey::UserRewards(user))
    }

    pub fn get_unlock_count(env: Env, user: Address) -> u32 {
        env.storage().persistent().get(&DataKey::UserUnlockCount(user)).unwrap_or(0)
    }

    pub fn get_unlock_by_index(env: Env, user: Address, index: u32) -> Option<UnlockEntry> {
        env.storage().persistent().get(&DataKey::UserUnlockByIndex(user, index))
    }

    pub fn get_blub_restake_count(env: Env, user: Address) -> u32 {
        env.storage().persistent().get(&DataKey::UserBlubRestakeCount(user)).unwrap_or(0)
    }

    pub fn get_blub_restake_by_index(env: Env, user: Address, index: u32) -> Option<BlubRestakeEntry> {
        env.storage().persistent().get(&DataKey::UserBlubRestakeByIndex(user, index))
    }

    pub fn get_distribution_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::DistributionCount).unwrap_or(0)
    }

    pub fn get_distribution_by_index(env: Env, index: u32) -> Option<RewardDistribution> {
        env.storage().instance().get(&DataKey::DistributionByIndex(index))
    }

    pub fn get_global_state(env: Env) -> Option<GlobalState> {
        env.storage().instance().get(&DataKey::GlobalState)
    }

    /// Get POL state
    pub fn get_protocol_owned_liquidity(env: Env) -> ProtocolOwnedLiquidity {
        Self::get_pol(&env)
    }

    /// Get daily POL snapshot
    pub fn get_daily_pol_snapshot(env: Env, day: u64) -> Option<ProtocolOwnedLiquidity> {
        env.storage().instance().get(&DataKey::DailyPolSnapshot(day))
    }

    /// Get total POL contribution for user
    pub fn get_user_pol_contribution(env: Env, user: Address) -> i128 {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserLockCount(user.clone()))
            .unwrap_or(0);

        let mut total_contribution = 0i128;
        for i in 0..count {
            if let Some(lock) = env.storage().persistent().get::<DataKey, LockEntry>(&DataKey::UserLockByIndex(user.clone(), i)) {
                total_contribution = total_contribution.saturating_add(lock.pol_contributed);
            }
        }

        total_contribution
    }

    // Admin functions for gas optimization
    pub fn update_reward_rate(env: Env, admin: Address, new_rate: i128) -> Result<(), Error> {
        let mut cfg = Self::get_config(env.clone())?;
        admin.require_auth();
        if cfg.admin != admin { return Err(Error::Unauthorized); }
        if new_rate > 1000 { return Err(Error::InvalidInput); } // Max 10% daily

        cfg.reward_rate = new_rate;
        env.storage().instance().set(&DataKey::Config, &cfg);
        Ok(())
    }
} 

// Default implementation for POL
impl Default for ProtocolOwnedLiquidity {
    fn default() -> Self {
        Self {
            total_aqua_contributed: 0,
            total_blub_contributed: 0,
            aqua_blub_lp_position: 0,
            total_pol_rewards_earned: 0,
            last_reward_claim: 0,
            ice_voting_power_used: 0,
        }
    }
} 