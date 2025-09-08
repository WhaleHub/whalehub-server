#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, log, symbol_short, Address, Env, Map, Vec, String,
    Bytes,
};
use whalehub_shared::{RewardPoolType, validate_positive_amount, MAX_BASIS_POINTS, SECONDS_PER_DAY};

// Enhanced Data Types for better reward management
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardPool {
    pub total_rewards: i128,
    pub distributed_rewards: i128,
    pub reserved_rewards: i128, // For future distributions
    pub last_distribution: u64,
    pub distribution_rate: i128, // Rewards per second
    pub pool_type: RewardPoolType,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardInfo {
    pub total_earned: i128,
    pub total_claimed: i128,
    pub pending_rewards: i128,
    pub last_claim: u64,
    pub last_update: u64,
    pub multiplier: i128, // Basis points
    pub streak_bonus: i128, // Consecutive claim bonus
    pub reward_debt: i128, // For accurate reward calculation
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardTier {
    pub tier_name: String,
    pub min_stake_amount: i128,
    pub multiplier_bonus: i128, // Additional multiplier in basis points
    pub min_lock_period: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardConfig {
    pub admin: Address,
    pub staking_contract: Address,
    pub liquidity_contract: Address,
    pub governance_contract: Address,
    pub reward_token: Address,
    pub distribution_period: u64, // Seconds
    pub min_claim_amount: i128,
    pub max_claim_per_tx: i128,
    pub claim_cooldown: u64,
    pub emergency_pause: bool,
    pub auto_compound_enabled: bool,
    pub performance_fee: i128, // Fee in basis points for claimed rewards
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalRewardStats {
    pub total_rewards_distributed: i128,
    pub total_unique_claimants: u32,
    pub average_claim_amount: i128,
    pub total_performance_fees: i128,
    pub last_stats_update: u64,
}

// Enhanced Storage Keys
#[contracttype]
pub enum DataKey {
    Config,
    RewardPool(RewardPoolType),
    UserReward(Address),
    UserClaimHistory(Address, u64), // Address, timestamp
    GlobalRewardRate,
    LastGlobalUpdate,
    TotalStakers,
    RewardTiers,
    GlobalStats,
    ContractVersion,
    EmergencyFunds,
    PerformanceFees,
    AutoCompoundSettings(Address),
    RewardMultipliers(Address), // User-specific multipliers
}

// Enhanced Error Types
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
    StakingContractOnly = 10,
    ClaimCooldownActive = 11,
    InvalidRewardPool = 12,
    NumericOverflow = 13,
    InvalidTier = 14,
    CrossContractCallFailed = 15,
    InsufficientPermissions = 16,
    InvalidTimestamp = 17,
    RewardPoolInactive = 18,
    DistributionLimitExceeded = 19,
    ContractVersionMismatch = 20,
}

// Enhanced Events
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardClaimedEvent {
    pub user: Address,
    pub amount: i128,
    pub pool_type: RewardPoolType,
    pub fee_paid: i128,
    pub streak_bonus: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardDistributedEvent {
    pub pool_type: RewardPoolType,
    pub total_amount: i128,
    pub recipients: u32,
    pub average_amount: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardPoolFundedEvent {
    pub pool_type: RewardPoolType,
    pub amount: i128,
    pub funder: Address,
    pub new_distribution_rate: i128,
    pub timestamp: u64,
}

#[contract]
pub struct RewardsContract;

#[contractimpl]
impl RewardsContract {
    /// Initialize the enhanced rewards contract
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        liquidity_contract: Address,
        governance_contract: Address,
        reward_token: Address,
        distribution_period: u64,
        min_claim_amount: i128,
        max_claim_per_tx: i128,
        claim_cooldown: u64,
        performance_fee: i128,
    ) -> Result<(), RewardError> {
        // Check if already initialized
        if env.storage().instance().has(&DataKey::Config) {
            return Err(RewardError::AlreadyInitialized);
        }

        admin.require_auth();

        // Validate parameters
        if performance_fee > 2000 { // Max 20% performance fee
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
            liquidity_contract,
            governance_contract,
            reward_token,
            distribution_period,
            min_claim_amount,
            max_claim_per_tx,
            claim_cooldown,
            emergency_pause: false,
            auto_compound_enabled: true,
            performance_fee,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        
        // Initialize reward pools for different types
        let pool_types = vec![&env, RewardPoolType::Staking, RewardPoolType::Liquidity, 
                             RewardPoolType::Governance, RewardPoolType::Bonus];
        
        for pool_type in pool_types.iter() {
            let reward_pool = RewardPool {
                total_rewards: 0,
                distributed_rewards: 0,
                reserved_rewards: 0,
                last_distribution: env.ledger().timestamp(),
                distribution_rate: 0,
                pool_type: pool_type.clone(),
                active: true,
            };
            env.storage().instance().set(&DataKey::RewardPool(pool_type.clone()), &reward_pool);
        }
        
        // Initialize default reward tiers
        let default_tiers = vec![&env,
            RewardTier {
                tier_name: String::from_str(&env, "Bronze"),
                min_stake_amount: 1000_0000000, // 1000 tokens
                multiplier_bonus: 0,
                min_lock_period: 0,
            },
            RewardTier {
                tier_name: String::from_str(&env, "Silver"),
                min_stake_amount: 10000_0000000, // 10K tokens
                multiplier_bonus: 500, // 5% bonus
                min_lock_period: 2592000, // 30 days
            },
            RewardTier {
                tier_name: String::from_str(&env, "Gold"),
                min_stake_amount: 100000_0000000, // 100K tokens
                multiplier_bonus: 1500, // 15% bonus
                min_lock_period: 7776000, // 90 days
            },
        ];
        env.storage().instance().set(&DataKey::RewardTiers, &default_tiers);
        
        // Initialize global stats
        let global_stats = GlobalRewardStats {
            total_rewards_distributed: 0,
            total_unique_claimants: 0,
            average_claim_amount: 0,
            total_performance_fees: 0,
            last_stats_update: env.ledger().timestamp(),
        };
        
        env.storage().instance().set(&DataKey::GlobalRewardRate, &0i128);
        env.storage().instance().set(&DataKey::LastGlobalUpdate, &env.ledger().timestamp());
        env.storage().instance().set(&DataKey::TotalStakers, &0u32);
        env.storage().instance().set(&DataKey::GlobalStats, &global_stats);
        env.storage().instance().set(&DataKey::ContractVersion, &1u32);
        env.storage().instance().set(&DataKey::EmergencyFunds, &0i128);
        env.storage().instance().set(&DataKey::PerformanceFees, &0i128);

        log!(&env, "Enhanced Rewards contract initialized by admin: {}", admin);
        
        Ok(())
    }

    /// Fund multiple reward pools (admin only)
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
        
        // Update distribution rate based on new funding
        if config.distribution_period > 0 {
            let available_rewards = reward_pool.total_rewards 
                .checked_sub(reward_pool.distributed_rewards)
                .ok_or(RewardError::NumericOverflow)?;
            reward_pool.distribution_rate = available_rewards
                .checked_div(config.distribution_period as i128)
                .unwrap_or(0);
        }

        env.storage().instance().set(&DataKey::RewardPool(pool_type.clone()), &reward_pool);

        // Emit event
        let event = RewardPoolFundedEvent {
            pool_type: pool_type.clone(),
            amount,
            funder: admin.clone(),
            new_distribution_rate: reward_pool.distribution_rate,
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("funded"),), event);

        log!(&env, "Reward pool {:?} funded with {} tokens by {}", pool_type, amount, admin);
        
        Ok(())
    }

    /// Update user reward info with cross-contract integration
    pub fn update_user_reward(
        env: Env,
        caller_contract: Address,
        user: Address,
        staked_amount: i128,
        multiplier: i128,
        pool_type: RewardPoolType,
    ) -> Result<(), RewardError> {
        let config = Self::get_config(&env)?;
        
        // Verify caller is authorized contract
        if caller_contract != config.staking_contract 
           && caller_contract != config.liquidity_contract 
           && caller_contract != config.governance_contract {
            return Err(RewardError::Unauthorized);
        }

        Self::update_global_rewards(&env, &pool_type)?;

        let current_time = env.ledger().timestamp();
        let global_rate: i128 = env.storage().instance().get(&DataKey::GlobalRewardRate).unwrap_or(0);

        let mut user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user.clone()))
            .unwrap_or(UserRewardInfo {
                total_earned: 0,
                total_claimed: 0,
                pending_rewards: 0,
                last_claim: current_time,
                last_update: current_time,
                multiplier,
                streak_bonus: 0,
                reward_debt: 0,
            });

        // Calculate new rewards since last update
        if user_reward.last_update < current_time && staked_amount > 0 {
            let time_diff = current_time.saturating_sub(user_reward.last_update);
            
            // Apply tier-based multiplier
            let tier_multiplier = Self::get_user_tier_multiplier(&env, &user, staked_amount);
            let total_multiplier = multiplier.checked_add(tier_multiplier).unwrap_or(multiplier);
            
            let base_reward = staked_amount
                .checked_mul(global_rate)
                .unwrap_or(0)
                .checked_mul(time_diff as i128)
                .unwrap_or(0)
                .checked_div(1_000_000)
                .unwrap_or(0);
                
            let multiplied_reward = base_reward
                .checked_mul(total_multiplier)
                .unwrap_or(0)
                .checked_div(MAX_BASIS_POINTS)
                .unwrap_or(0);
            
            user_reward.pending_rewards = user_reward.pending_rewards
                .checked_add(multiplied_reward)
                .unwrap_or(user_reward.pending_rewards);
            user_reward.total_earned = user_reward.total_earned
                .checked_add(multiplied_reward)
                .unwrap_or(user_reward.total_earned);
        }

        user_reward.last_update = current_time;
        user_reward.multiplier = multiplier;

        env.storage().persistent().set(&DataKey::UserReward(user.clone()), &user_reward);

        Ok(())
    }

    /// Enhanced claim rewards with fees and bonuses
    pub fn claim_rewards(env: Env, user: Address, auto_compound: bool) -> Result<i128, RewardError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(RewardError::ContractPaused);
        }

        // Check claim cooldown
        let mut user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user.clone()))
            .ok_or(RewardError::NoRewardsToClaim)?;

        let current_time = env.ledger().timestamp();
        if current_time < user_reward.last_claim + config.claim_cooldown {
            return Err(RewardError::ClaimCooldownActive);
        }

        let claimable_amount = user_reward.pending_rewards;

        if claimable_amount <= 0 {
            return Err(RewardError::NoRewardsToClaim);
        }

        if claimable_amount < config.min_claim_amount {
            return Err(RewardError::BelowMinimumClaim);
        }

        if claimable_amount > config.max_claim_per_tx {
            return Err(RewardError::AboveMaximumClaim);
        }

        // Calculate streak bonus (consecutive days claiming)
        let days_since_last_claim = (current_time - user_reward.last_claim) / SECONDS_PER_DAY;
        let streak_bonus = if days_since_last_claim == 1 {
            user_reward.streak_bonus + 1
        } else {
            1 // Reset streak
        };
        
        let bonus_amount = Self::calculate_streak_bonus(claimable_amount, streak_bonus);

        // Calculate performance fee
        let fee_amount = (claimable_amount * config.performance_fee) / MAX_BASIS_POINTS;
        let net_amount = claimable_amount + bonus_amount - fee_amount;

        // Check reward pool availability
        let staking_pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool(RewardPoolType::Staking))
            .ok_or(RewardError::InvalidRewardPool)?;

        let available_rewards = staking_pool.total_rewards - staking_pool.distributed_rewards;
        if net_amount > available_rewards {
            return Err(RewardError::InsufficientRewards);
        }

        // Update user reward info
        user_reward.total_claimed = user_reward.total_claimed
            .checked_add(claimable_amount)
            .ok_or(RewardError::NumericOverflow)?;
        user_reward.pending_rewards = 0;
        user_reward.last_claim = current_time;
        user_reward.streak_bonus = streak_bonus;

        env.storage().persistent().set(&DataKey::UserReward(user.clone()), &user_reward);

        // Update reward pool
        let mut updated_pool = staking_pool;
        updated_pool.distributed_rewards = updated_pool.distributed_rewards
            .checked_add(net_amount)
            .ok_or(RewardError::NumericOverflow)?;
        env.storage().instance().set(&DataKey::RewardPool(RewardPoolType::Staking), &updated_pool);

        // Update performance fees
        let mut total_fees: i128 = env.storage().instance().get(&DataKey::PerformanceFees).unwrap_or(0);
        total_fees = total_fees.checked_add(fee_amount).unwrap_or(total_fees);
        env.storage().instance().set(&DataKey::PerformanceFees, &total_fees);

        // Update global stats
        Self::update_global_claim_stats(&env, net_amount)?;

        // Handle auto-compound if requested
        let final_amount = if auto_compound && config.auto_compound_enabled {
            Self::handle_auto_compound(&env, &user, net_amount)?
        } else {
            net_amount
        };

        // Store claim history
        let history_key = DataKey::UserClaimHistory(user.clone(), current_time);
        env.storage().persistent().set(&history_key, &claimable_amount);

        // Emit event
        let event = RewardClaimedEvent {
            user: user.clone(),
            amount: claimable_amount,
            pool_type: RewardPoolType::Staking,
            fee_paid: fee_amount,
            streak_bonus: bonus_amount,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("claimed"),), event);

        log!(&env, "User {} claimed {} reward tokens (net: {}, fee: {}, bonus: {})", 
             user, claimable_amount, net_amount, fee_amount, bonus_amount);

        Ok(final_amount)
    }

    /// Batch distribute rewards to multiple users
    pub fn batch_distribute_rewards(
        env: Env,
        admin: Address,
        pool_type: RewardPoolType,
        recipients: Vec<Address>,
        amounts: Vec<i128>,
    ) -> Result<u32, RewardError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        if config.emergency_pause {
            return Err(RewardError::ContractPaused);
        }

        if recipients.len() != amounts.len() {
            return Err(RewardError::InvalidConfiguration);
        }

        let mut total_distributed = 0i128;
        let mut successful_distributions = 0u32;

        for (i, recipient) in recipients.iter().enumerate() {
            if let Some(amount) = amounts.get(i) {
                if amount > 0 {
                    match Self::distribute_reward_to_user(&env, recipient, amount, &pool_type) {
                        Ok(_) => {
                            total_distributed = total_distributed.checked_add(amount).unwrap_or(total_distributed);
                            successful_distributions += 1;
                        },
                        Err(e) => {
                            log!(&env, "Failed to distribute {} to {}: {:?}", amount, recipient, e);
                        }
                    }
                }
            }
        }

        // Emit batch distribution event
        let average_amount = if successful_distributions > 0 {
            total_distributed / (successful_distributions as i128)
        } else {
            0
        };

        let event = RewardDistributedEvent {
            pool_type,
            total_amount: total_distributed,
            recipients: successful_distributions,
            average_amount,
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("distrib"),), event);

        log!(&env, "Batch distributed {} rewards to {} users", total_distributed, successful_distributions);

        Ok(successful_distributions)
    }

    // Enhanced getter functions
    pub fn get_claimable_rewards(env: Env, user: Address) -> i128 {
        let user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user))
            .unwrap_or_default();

        user_reward.pending_rewards
    }

    pub fn get_user_reward_info(env: Env, user: Address) -> Option<UserRewardInfo> {
        env.storage().persistent().get(&DataKey::UserReward(user))
    }

    pub fn get_reward_pool(env: Env, pool_type: RewardPoolType) -> Option<RewardPool> {
        env.storage().instance().get(&DataKey::RewardPool(pool_type))
    }

    pub fn get_user_tier(env: Env, user: Address, staked_amount: i128) -> String {
        let tiers: Vec<RewardTier> = env.storage().instance()
            .get(&DataKey::RewardTiers)
            .unwrap_or(vec![&env]);

        for tier in tiers.iter().rev() {
            if staked_amount >= tier.min_stake_amount {
                return tier.tier_name.clone();
            }
        }

        String::from_str(&env, "Bronze")
    }

    pub fn get_global_stats(env: Env) -> Option<GlobalRewardStats> {
        env.storage().instance().get(&DataKey::GlobalStats)
    }

    pub fn get_config(env: &Env) -> Result<RewardConfig, RewardError> {
        env.storage().instance()
            .get(&DataKey::Config)
            .ok_or(RewardError::NotInitialized)
    }

    // Enhanced admin functions
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

        log!(&env, "Emergency pause set to: {}", paused);
        
        Ok(())
    }

    pub fn update_reward_tiers(
        env: Env,
        admin: Address,
        new_tiers: Vec<RewardTier>,
    ) -> Result<(), RewardError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        env.storage().instance().set(&DataKey::RewardTiers, &new_tiers);

        log!(&env, "Reward tiers updated with {} tiers", new_tiers.len());
        
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
        env.storage().instance().set(&DataKey::RewardPool(pool_type.clone()), &pool);

        log!(&env, "Reward pool {:?} active status set to: {}", pool_type, active);
        
        Ok(())
    }

    // Internal helper functions
    fn update_global_rewards(env: &Env, pool_type: &RewardPoolType) -> Result<(), RewardError> {
        let current_time = env.ledger().timestamp();
        let last_update: u64 = env.storage().instance()
            .get(&DataKey::LastGlobalUpdate)
            .unwrap_or(current_time);

        if current_time > last_update {
            let reward_pool: RewardPool = env.storage().instance()
                .get(&DataKey::RewardPool(pool_type.clone()))
                .unwrap_or_default();

            let time_diff = current_time - last_update;
            let new_rewards = reward_pool.distribution_rate
                .checked_mul(time_diff as i128)
                .unwrap_or(0);

            let current_rate: i128 = env.storage().instance()
                .get(&DataKey::GlobalRewardRate)
                .unwrap_or(0);

            let updated_rate = current_rate.checked_add(new_rewards).unwrap_or(current_rate);
            env.storage().instance().set(&DataKey::GlobalRewardRate, &updated_rate);
            env.storage().instance().set(&DataKey::LastGlobalUpdate, &current_time);
        }

        Ok(())
    }

    fn get_user_tier_multiplier(env: &Env, user: &Address, staked_amount: i128) -> i128 {
        let tiers: Vec<RewardTier> = env.storage().instance()
            .get(&DataKey::RewardTiers)
            .unwrap_or(vec![&env]);

        for tier in tiers.iter().rev() {
            if staked_amount >= tier.min_stake_amount {
                return tier.multiplier_bonus;
            }
        }

        0
    }

    fn calculate_streak_bonus(base_amount: i128, streak_days: i128) -> i128 {
        if streak_days <= 1 {
            return 0;
        }

        // Progressive bonus: 1% per day, capped at 20%
        let bonus_rate = (streak_days * 100).min(2000); // Max 20% bonus
        (base_amount * bonus_rate) / MAX_BASIS_POINTS
    }

    fn update_global_claim_stats(env: &Env, claimed_amount: i128) -> Result<(), RewardError> {
        let mut stats: GlobalRewardStats = env.storage().instance()
            .get(&DataKey::GlobalStats)
            .unwrap_or_default();

        stats.total_rewards_distributed = stats.total_rewards_distributed
            .checked_add(claimed_amount)
            .ok_or(RewardError::NumericOverflow)?;
        stats.total_unique_claimants += 1;
        stats.average_claim_amount = if stats.total_unique_claimants > 0 {
            stats.total_rewards_distributed / (stats.total_unique_claimants as i128)
        } else {
            0
        };
        stats.last_stats_update = env.ledger().timestamp();

        env.storage().instance().set(&DataKey::GlobalStats, &stats);
        Ok(())
    }

    fn distribute_reward_to_user(
        env: &Env,
        user: &Address,
        amount: i128,
        pool_type: &RewardPoolType,
    ) -> Result<(), RewardError> {
        let mut user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user.clone()))
            .unwrap_or_default();

        user_reward.pending_rewards = user_reward.pending_rewards
            .checked_add(amount)
            .ok_or(RewardError::NumericOverflow)?;
        user_reward.total_earned = user_reward.total_earned
            .checked_add(amount)
            .ok_or(RewardError::NumericOverflow)?;

        env.storage().persistent().set(&DataKey::UserReward(user.clone()), &user_reward);
        Ok(())
    }

    fn handle_auto_compound(env: &Env, user: &Address, amount: i128) -> Result<i128, RewardError> {
        // This would integrate with the staking contract to automatically stake rewards
        // For now, we'll just log the intended action
        log!(env, "Would auto-compound {} rewards for user {}", amount, user);
        
        Ok(amount)
    }
}

// Default implementations
impl Default for UserRewardInfo {
    fn default() -> Self {
        Self {
            total_earned: 0,
            total_claimed: 0,
            pending_rewards: 0,
            last_claim: 0,
            last_update: 0,
            multiplier: MAX_BASIS_POINTS, // 1x multiplier
            streak_bonus: 0,
            reward_debt: 0,
        }
    }
}

impl Default for RewardPool {
    fn default() -> Self {
        Self {
            total_rewards: 0,
            distributed_rewards: 0,
            reserved_rewards: 0,
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
            average_claim_amount: 0,
            total_performance_fees: 0,
            last_stats_update: 0,
        }
    }
} 