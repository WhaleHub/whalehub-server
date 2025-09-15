#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, vec,
};

// Inline shared types and constants
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RewardPoolType {
    Staking,
    Liquidity,
    Governance,
    Bonus,
}

pub fn validate_positive_amount(amount: i128) -> bool {
    amount > 0
}

pub const MAX_BASIS_POINTS: i128 = 10000;
pub const SECONDS_PER_DAY: u64 = 86400;

// Simplified data types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardPool {
    pub total_rewards: i128,
    pub distributed_rewards: i128,
    pub last_distribution: u64,
    pub distribution_rate: i128, // Rewards per day (simplified)
    pub pool_type: RewardPoolType,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardInfo {
    pub total_earned: i128,
    pub total_claimed: i128,
    pub last_claim: u64,
    pub last_update: u64,
    pub claim_count: u32, // For tracking claim frequency
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardConfig {
    pub admin: Address,
    pub staking_contract: Address,
    pub reward_token: Address,
    pub min_claim_amount: i128,
    pub max_claim_per_tx: i128,
    pub claim_cooldown: u64,
    pub emergency_pause: bool,
    pub treasury_address: Address,
    pub treasury_fee_rate: i128, // basis points for treasury allocation
}

// Gas-optimized global tracking
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalRewardStats {
    pub total_rewards_distributed: i128,
    pub total_unique_claimants: u32,
    pub last_stats_update: u64,
    pub average_claim_size: i128,
}

#[contracttype]
pub enum DataKey {
    Config,
    RewardPool(RewardPoolType),
    UserReward(Address),
    UserClaimHistory(Address, u32), // Address, claim index
    GlobalStats,
    RewardSnapshot(u64), // Daily snapshots for gas optimization
    ClaimWindow(u64), // Track claim windows for rate limiting
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RewardError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InsufficientRewards = 4,
    NoRewardsToClaim = 5,
    BelowMinimumClaim = 6,
    AboveMaximumClaim = 7,
    ContractPaused = 8,
    InvalidConfiguration = 9,
    ClaimCooldownActive = 11,
    InvalidRewardPool = 12,
    NumericOverflow = 13,
    InvalidTimestamp = 17,
    RewardPoolInactive = 18,
}

impl From<RewardError> for soroban_sdk::Error {
    fn from(error: RewardError) -> Self {
        soroban_sdk::Error::from_contract_error(error as u32)
    }
}

impl From<&RewardError> for soroban_sdk::Error {
    fn from(error: &RewardError) -> Self {
        soroban_sdk::Error::from_contract_error(error.clone() as u32)
    }
}

impl From<soroban_sdk::Error> for RewardError {
    fn from(_: soroban_sdk::Error) -> Self {
        RewardError::InvalidConfiguration
    }
}

// Simplified events
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardClaimedEvent {
    pub user: Address,
    pub amount: i128,
    pub pool_type: RewardPoolType,
    pub timestamp: u64,
    pub claim_index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardPoolFundedEvent {
    pub pool_type: RewardPoolType,
    pub amount: i128,
    pub funder: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchRewardProcessedEvent {
    pub pool_type: RewardPoolType,
    pub total_amount: i128,
    pub recipients_processed: u32,
    pub timestamp: u64,
}

#[contract]
pub struct RewardsContract;

#[contractimpl]
impl RewardsContract {
    // Complete reward calculation and distribution
    
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        reward_token: Address,
        treasury_address: Address,
        min_claim_amount: i128,
        max_claim_per_tx: i128,
        claim_cooldown: u64,
        treasury_fee_rate: i128,
    ) -> Result<(), RewardError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(RewardError::AlreadyInitialized);
        }

        admin.require_auth();

        // Validate parameters
        if treasury_fee_rate > 2000 { // Max 20% treasury fee
            return Err(RewardError::InvalidConfiguration);
        }

        if min_claim_amount >= max_claim_per_tx {
            return Err(RewardError::InvalidConfiguration);
        }

        if !validate_positive_amount(min_claim_amount) || !validate_positive_amount(max_claim_per_tx) {
            return Err(RewardError::InvalidConfiguration);
        }

        let config = RewardConfig {
            admin: admin.clone(),
            staking_contract,
            reward_token,
            min_claim_amount,
            max_claim_per_tx,
            claim_cooldown,
            emergency_pause: false,
            treasury_address,
            treasury_fee_rate,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        
        // Initialize simplified reward pools (LP and LOCKED only)
        let pool_types = vec![&env, RewardPoolType::Liquidity, RewardPoolType::Staking];
        
        for pool_type in pool_types.iter() {
            let reward_pool = RewardPool {
                total_rewards: 0,
                distributed_rewards: 0,
                last_distribution: env.ledger().timestamp(),
                distribution_rate: 0,
                pool_type: pool_type.clone(),
                active: true,
            };
            env.storage().instance().set(&DataKey::RewardPool(pool_type.clone()), &reward_pool);
        }
        
        // Initialize global stats
        let global_stats = GlobalRewardStats {
            total_rewards_distributed: 0,
            total_unique_claimants: 0,
            last_stats_update: env.ledger().timestamp(),
            average_claim_size: 0,
        };
        
        env.storage().instance().set(&DataKey::GlobalStats, &global_stats);
        
        Ok(())
    }

    // Gas-optimized reward pool funding
    pub fn fund_reward_pool(
        env: Env,
        admin: Address,
        pool_type: RewardPoolType,
        amount: i128,
    ) -> Result<(), RewardError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        if config.emergency_pause {
            return Err(RewardError::ContractPaused);
        }

        if !validate_positive_amount(amount) {
            return Err(RewardError::InvalidConfiguration);
        }

        let mut reward_pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool(pool_type.clone()))
            .ok_or(RewardError::InvalidRewardPool)?;

        if !reward_pool.active {
            return Err(RewardError::RewardPoolInactive);
        }

        reward_pool.total_rewards = reward_pool.total_rewards
            .checked_add(amount)
            .ok_or(RewardError::NumericOverflow)?;
        
        // Set daily distribution rate
        reward_pool.distribution_rate = amount / 7; // Distribute over 7 days
        reward_pool.last_distribution = env.ledger().timestamp();

        env.storage().instance().set(&DataKey::RewardPool(pool_type.clone()), &reward_pool);

        let event = RewardPoolFundedEvent {
            pool_type: pool_type.clone(),
            amount,
            funder: admin.clone(),
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("funded"),), event);
        
        Ok(())
    }

    // Simplified reward estimation
    pub fn estimate_user_rewards(
        env: Env, 
        user: Address, 
        pool_type: RewardPoolType,
        user_stake_amount: i128,
        total_stake_amount: i128,
    ) -> Result<i128, RewardError> {
        if total_stake_amount == 0 || user_stake_amount == 0 {
            return Ok(0);
        }

        let reward_pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool(pool_type))
            .ok_or(RewardError::InvalidRewardPool)?;

        // Calculate user's share of daily rewards
        let user_percentage = (user_stake_amount * 10000) / total_stake_amount; // basis points
        let estimated_daily_reward = (reward_pool.distribution_rate * user_percentage) / 10000;

        Ok(estimated_daily_reward)
    }

    // Gas-optimized batch reward processing
    pub fn process_batch_rewards(
        env: Env,
        admin: Address,
        pool_type: RewardPoolType,
        total_pool_amount: i128,
        treasury_amount: i128,
    ) -> Result<u32, RewardError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        if config.emergency_pause {
            return Err(RewardError::ContractPaused);
        }

        let mut reward_pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool(pool_type.clone()))
            .ok_or(RewardError::InvalidRewardPool)?;

        if !reward_pool.active {
            return Err(RewardError::RewardPoolInactive);
        }

        // Check if enough rewards available
        let available_rewards = reward_pool.total_rewards - reward_pool.distributed_rewards;
        let total_distribution = total_pool_amount + treasury_amount;
        
        if total_distribution > available_rewards {
            return Err(RewardError::InsufficientRewards);
        }

        // Update pool state
        reward_pool.distributed_rewards = reward_pool.distributed_rewards
            .checked_add(total_distribution)
            .ok_or(RewardError::NumericOverflow)?;
        reward_pool.last_distribution = env.ledger().timestamp();

        env.storage().instance().set(&DataKey::RewardPool(pool_type.clone()), &reward_pool);

        // Update global stats for gas optimization
        Self::update_global_stats(&env, total_pool_amount, 0)?;

        // Create snapshot for future gas-optimized queries
        let snapshot_key = DataKey::RewardSnapshot(env.ledger().timestamp() / SECONDS_PER_DAY);
        env.storage().instance().set(&snapshot_key, &total_distribution);

        // Emit batch event
        let batch_event = BatchRewardProcessedEvent {
            pool_type: pool_type.clone(),
            total_amount: total_pool_amount,
            recipients_processed: 0, // Will be updated by individual credit calls
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("batch"),), batch_event);

        Ok(0) // Return processed count
    }

    // Individual reward crediting (called by backend after distribution)
    pub fn credit_user_reward(
        env: Env,
        admin: Address,
        user: Address,
        pool_type: RewardPoolType,
        amount: i128,
    ) -> Result<(), RewardError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        if !validate_positive_amount(amount) {
            return Err(RewardError::InvalidConfiguration);
        }

        let current_time = env.ledger().timestamp();

        let mut user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user.clone()))
            .unwrap_or(UserRewardInfo {
                total_earned: 0,
                total_claimed: 0,
                last_claim: 0,
                last_update: current_time,
                claim_count: 0,
            });

        user_reward.total_earned = user_reward.total_earned
            .checked_add(amount)
            .ok_or(RewardError::NumericOverflow)?;
        user_reward.last_update = current_time;

        env.storage().persistent().set(&DataKey::UserReward(user.clone()), &user_reward);

        Ok(())
    }

    // Simplified reward claiming (gas-optimized)
    pub fn claim_rewards(
        env: Env, 
        user: Address, 
        pool_type: RewardPoolType,
    ) -> Result<i128, RewardError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(RewardError::ContractPaused);
        }

        let mut user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user.clone()))
            .ok_or(RewardError::NoRewardsToClaim)?;

        let current_time = env.ledger().timestamp();
        
        // Check claim cooldown
        if current_time < user_reward.last_claim + config.claim_cooldown {
            return Err(RewardError::ClaimCooldownActive);
        }

        let claimable_amount = user_reward.total_earned - user_reward.total_claimed;

        if claimable_amount <= 0 {
            return Err(RewardError::NoRewardsToClaim);
        }

        if claimable_amount < config.min_claim_amount {
            return Err(RewardError::BelowMinimumClaim);
        }

        if claimable_amount > config.max_claim_per_tx {
            return Err(RewardError::AboveMaximumClaim);
        }

        // Check reward pool availability
        let reward_pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool(pool_type.clone()))
            .ok_or(RewardError::InvalidRewardPool)?;

        let available_rewards = reward_pool.total_rewards - reward_pool.distributed_rewards;
        if claimable_amount > available_rewards {
            return Err(RewardError::InsufficientRewards);
        }

        // Update user state
        user_reward.total_claimed = user_reward.total_claimed
            .checked_add(claimable_amount)
            .ok_or(RewardError::NumericOverflow)?;
        user_reward.last_claim = current_time;
        user_reward.claim_count = user_reward.claim_count.saturating_add(1);

        env.storage().persistent().set(&DataKey::UserReward(user.clone()), &user_reward);

        // Store claim history for tracking
        let history_key = DataKey::UserClaimHistory(user.clone(), user_reward.claim_count);
        env.storage().persistent().set(&history_key, &claimable_amount);

        // Update global stats
        Self::update_global_stats(&env, claimable_amount, 1)?;

        // Emit claim event
        let event = RewardClaimedEvent {
            user: user.clone(),
            amount: claimable_amount,
            pool_type,
            timestamp: current_time,
            claim_index: user_reward.claim_count,
        };
        env.events().publish((symbol_short!("claimed"),), event);

        Ok(claimable_amount)
    }

    // Gas optimization helpers

    fn update_global_stats(env: &Env, amount: i128, new_claimants: u32) -> Result<(), RewardError> {
        let mut stats: GlobalRewardStats = env.storage().instance()
            .get(&DataKey::GlobalStats)
            .unwrap_or_default();

        stats.total_rewards_distributed = stats.total_rewards_distributed
            .checked_add(amount)
            .ok_or(RewardError::NumericOverflow)?;
        
        if new_claimants > 0 {
            stats.total_unique_claimants = stats.total_unique_claimants.saturating_add(new_claimants);
        }
        
        stats.average_claim_size = if stats.total_unique_claimants > 0 {
            stats.total_rewards_distributed / (stats.total_unique_claimants as i128)
        } else {
            0
        };
        
        stats.last_stats_update = env.ledger().timestamp();

        env.storage().instance().set(&DataKey::GlobalStats, &stats);
        Ok(())
    }

    // Gas-optimized getters
    pub fn get_claimable_rewards(env: Env, user: Address) -> i128 {
        let user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user))
            .unwrap_or_default();

        user_reward.total_earned - user_reward.total_claimed
    }

    pub fn get_user_reward_info(env: Env, user: Address) -> Option<UserRewardInfo> {
        env.storage().persistent().get(&DataKey::UserReward(user))
    }

    pub fn get_reward_pool(env: Env, pool_type: RewardPoolType) -> Option<RewardPool> {
        env.storage().instance().get(&DataKey::RewardPool(pool_type))
    }

    pub fn get_global_stats(env: Env) -> Option<GlobalRewardStats> {
        env.storage().instance().get(&DataKey::GlobalStats)
    }

    pub fn get_config(env: &Env) -> Result<RewardConfig, RewardError> {
        env.storage().instance()
            .get(&DataKey::Config)
            .ok_or(RewardError::NotInitialized)
    }

    // Admin functions
    pub fn set_emergency_pause(
        env: Env,
        admin: Address,
        paused: bool,
    ) -> Result<(), RewardError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        config.emergency_pause = paused;
        env.storage().instance().set(&DataKey::Config, &config);
        
        Ok(())
    }

    pub fn toggle_reward_pool(
        env: Env,
        admin: Address,
        pool_type: RewardPoolType,
        active: bool,
    ) -> Result<(), RewardError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        let mut pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool(pool_type.clone()))
            .ok_or(RewardError::InvalidRewardPool)?;

        pool.active = active;
        env.storage().instance().set(&DataKey::RewardPool(pool_type), &pool);
        
        Ok(())
    }

    // Gas-optimized batch queries for analytics
    pub fn get_daily_snapshot(env: Env, day: u64) -> Option<i128> {
        env.storage().instance().get(&DataKey::RewardSnapshot(day))
    }
}

// Default implementations for gas optimization
impl Default for UserRewardInfo {
    fn default() -> Self {
        Self {
            total_earned: 0,
            total_claimed: 0,
            last_claim: 0,
            last_update: 0,
            claim_count: 0,
        }
    }
}

impl Default for RewardPool {
    fn default() -> Self {
        Self {
            total_rewards: 0,
            distributed_rewards: 0,
            last_distribution: 0,
            distribution_rate: 0,
            pool_type: RewardPoolType::Staking,
            active: true,
        }
    }
}

impl Default for GlobalRewardStats {
    fn default() -> Self {
        Self {
            total_rewards_distributed: 0,
            total_unique_claimants: 0,
            last_stats_update: 0,
            average_claim_size: 0,
        }
    }
} 