#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, log, symbol_short, Address, Env, Map, Vec,
};

// Data Types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardPool {
    pub total_rewards: i128,
    pub distributed_rewards: i128,
    pub last_distribution: u64,
    pub distribution_rate: i128, // Rewards per second
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardInfo {
    pub total_earned: i128,
    pub total_claimed: i128,
    pub last_claim: u64,
    pub multiplier: i128, // Basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardConfig {
    pub admin: Address,
    pub staking_contract: Address,
    pub reward_token: Address,
    pub distribution_period: u64, // Seconds
    pub min_claim_amount: i128,
    pub emergency_pause: bool,
}

// Storage Keys
#[contracttype]
pub enum DataKey {
    Config,
    RewardPool,
    UserReward(Address),
    GlobalRewardRate,
    LastGlobalUpdate,
    TotalStakers,
}

// Error Types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RewardError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InsufficientRewards = 4,
    NoRewardsToClaim = 5,
    BelowMinimumClaim = 6,
    ContractPaused = 7,
    InvalidConfiguration = 8,
    StakingContractOnly = 9,
}

// Events
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardClaimedEvent {
    pub user: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardDistributedEvent {
    pub total_amount: i128,
    pub recipients: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardPoolFundedEvent {
    pub amount: i128,
    pub funder: Address,
    pub timestamp: u64,
}

#[contract]
pub struct RewardsContract;

#[contractimpl]
impl RewardsContract {
    /// Initialize the rewards contract
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        reward_token: Address,
        distribution_period: u64,
        min_claim_amount: i128,
    ) -> Result<(), RewardError> {
        // Check if already initialized
        if env.storage().instance().has(&DataKey::Config) {
            return Err(RewardError::AlreadyInitialized);
        }

        admin.require_auth();

        let config = RewardConfig {
            admin: admin.clone(),
            staking_contract,
            reward_token,
            distribution_period,
            min_claim_amount,
            emergency_pause: false,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        
        // Initialize reward pool
        let reward_pool = RewardPool {
            total_rewards: 0,
            distributed_rewards: 0,
            last_distribution: env.ledger().timestamp(),
            distribution_rate: 0,
        };
        env.storage().instance().set(&DataKey::RewardPool, &reward_pool);
        
        env.storage().instance().set(&DataKey::GlobalRewardRate, &0i128);
        env.storage().instance().set(&DataKey::LastGlobalUpdate, &env.ledger().timestamp());
        env.storage().instance().set(&DataKey::TotalStakers, &0u32);

        log!(&env, "Rewards contract initialized by admin: {}", admin);
        
        Ok(())
    }

    /// Fund the reward pool (admin only)
    pub fn fund_rewards(
        env: Env,
        admin: Address,
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

        let mut reward_pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool)
            .unwrap_or(RewardPool {
                total_rewards: 0,
                distributed_rewards: 0,
                last_distribution: env.ledger().timestamp(),
                distribution_rate: 0,
            });

        reward_pool.total_rewards += amount;
        
        // Update distribution rate based on new funding
        if config.distribution_period > 0 {
            let available_rewards = reward_pool.total_rewards - reward_pool.distributed_rewards;
            reward_pool.distribution_rate = available_rewards / (config.distribution_period as i128);
        }

        env.storage().instance().set(&DataKey::RewardPool, &reward_pool);

        // Emit event
        let event = RewardPoolFundedEvent {
            amount,
            funder: admin.clone(),
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("funded"),), event);

        log!(&env, "Reward pool funded with {} tokens by {}", amount, admin);
        
        Ok(())
    }

    /// Update user reward info (called by staking contract)
    pub fn update_user_reward(
        env: Env,
        user: Address,
        staked_amount: i128,
        multiplier: i128,
    ) -> Result<(), RewardError> {
        let config = Self::get_config(&env)?;
        
        // Only staking contract can call this
        if env.current_contract_address() != config.staking_contract {
            return Err(RewardError::StakingContractOnly);
        }

        Self::update_global_rewards(&env)?;

        let current_time = env.ledger().timestamp();
        let global_rate: i128 = env.storage().instance().get(&DataKey::GlobalRewardRate).unwrap_or(0);

        let mut user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user.clone()))
            .unwrap_or(UserRewardInfo {
                total_earned: 0,
                total_claimed: 0,
                last_claim: current_time,
                multiplier,
            });

        // Calculate new rewards since last update
        if user_reward.last_claim < current_time && staked_amount > 0 {
            let time_diff = current_time - user_reward.last_claim;
            let base_reward = (staked_amount * global_rate * (time_diff as i128)) / 1_000_000; // Scale factor
            let multiplied_reward = (base_reward * user_reward.multiplier) / 10000; // Basis points
            
            user_reward.total_earned += multiplied_reward;
        }

        user_reward.last_claim = current_time;
        user_reward.multiplier = multiplier;

        env.storage().persistent().set(&DataKey::UserReward(user.clone()), &user_reward);

        Ok(())
    }

    /// Claim rewards for a user
    pub fn claim_rewards(env: Env, user: Address) -> Result<i128, RewardError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(RewardError::ContractPaused);
        }

        let mut user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user.clone()))
            .ok_or(RewardError::NoRewardsToClaim)?;

        let claimable_amount = user_reward.total_earned - user_reward.total_claimed;

        if claimable_amount <= 0 {
            return Err(RewardError::NoRewardsToClaim);
        }

        if claimable_amount < config.min_claim_amount {
            return Err(RewardError::BelowMinimumClaim);
        }

        // Check if reward pool has sufficient funds
        let reward_pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool)
            .unwrap_or_default();

        let available_rewards = reward_pool.total_rewards - reward_pool.distributed_rewards;
        if claimable_amount > available_rewards {
            return Err(RewardError::InsufficientRewards);
        }

        // Update user reward info
        user_reward.total_claimed += claimable_amount;
        env.storage().persistent().set(&DataKey::UserReward(user.clone()), &user_reward);

        // Update reward pool
        let mut updated_pool = reward_pool;
        updated_pool.distributed_rewards += claimable_amount;
        env.storage().instance().set(&DataKey::RewardPool, &updated_pool);

        // Emit event
        let event = RewardClaimedEvent {
            user: user.clone(),
            amount: claimable_amount,
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("claimed"),), event);

        log!(&env, "User {} claimed {} reward tokens", user, claimable_amount);

        Ok(claimable_amount)
    }

    /// Get claimable rewards for a user
    pub fn get_claimable_rewards(env: Env, user: Address) -> i128 {
        let user_reward: UserRewardInfo = env.storage().persistent()
            .get(&DataKey::UserReward(user))
            .unwrap_or_default();

        user_reward.total_earned - user_reward.total_claimed
    }

    /// Get user reward info
    pub fn get_user_reward_info(env: Env, user: Address) -> Option<UserRewardInfo> {
        env.storage().persistent().get(&DataKey::UserReward(user))
    }

    /// Get reward pool information
    pub fn get_reward_pool(env: Env) -> Option<RewardPool> {
        env.storage().instance().get(&DataKey::RewardPool)
    }

    /// Get contract configuration
    pub fn get_config(env: Env) -> Result<RewardConfig, RewardError> {
        env.storage().instance()
            .get(&DataKey::Config)
            .ok_or(RewardError::NotInitialized)
    }

    /// Admin function to pause/unpause the contract
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

    /// Admin function to update minimum claim amount
    pub fn update_min_claim_amount(
        env: Env,
        admin: Address,
        new_amount: i128,
    ) -> Result<(), RewardError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        config.min_claim_amount = new_amount;
        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Minimum claim amount updated to: {}", new_amount);
        
        Ok(())
    }

    /// Admin function to update distribution period
    pub fn update_distribution_period(
        env: Env,
        admin: Address,
        new_period: u64,
    ) -> Result<(), RewardError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        config.distribution_period = new_period;
        env.storage().instance().set(&DataKey::Config, &config);

        // Update distribution rate
        let mut reward_pool: RewardPool = env.storage().instance()
            .get(&DataKey::RewardPool)
            .unwrap_or_default();

        if new_period > 0 {
            let available_rewards = reward_pool.total_rewards - reward_pool.distributed_rewards;
            reward_pool.distribution_rate = available_rewards / (new_period as i128);
            env.storage().instance().set(&DataKey::RewardPool, &reward_pool);
        }

        log!(&env, "Distribution period updated to: {} seconds", new_period);
        
        Ok(())
    }

    /// Distribute rewards to all stakers (admin function)
    pub fn distribute_rewards(env: Env, admin: Address) -> Result<u32, RewardError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(RewardError::Unauthorized);
        }

        if config.emergency_pause {
            return Err(RewardError::ContractPaused);
        }

        Self::update_global_rewards(&env)?;

        let current_time = env.ledger().timestamp();
        let total_stakers: u32 = env.storage().instance().get(&DataKey::TotalStakers).unwrap_or(0);

        // Emit event
        let event = RewardDistributedEvent {
            total_amount: 0, // Would be calculated based on actual distribution
            recipients: total_stakers,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("distrib"),), event);

        log!(&env, "Rewards distributed to {} stakers", total_stakers);

        Ok(total_stakers)
    }

    // Internal helper functions
    fn update_global_rewards(env: &Env) -> Result<(), RewardError> {
        let current_time = env.ledger().timestamp();
        let last_update: u64 = env.storage().instance()
            .get(&DataKey::LastGlobalUpdate)
            .unwrap_or(current_time);

        if current_time > last_update {
            let reward_pool: RewardPool = env.storage().instance()
                .get(&DataKey::RewardPool)
                .unwrap_or_default();

            let time_diff = current_time - last_update;
            let new_rewards = reward_pool.distribution_rate * (time_diff as i128);

            let current_rate: i128 = env.storage().instance()
                .get(&DataKey::GlobalRewardRate)
                .unwrap_or(0);

            let updated_rate = current_rate + new_rewards;
            env.storage().instance().set(&DataKey::GlobalRewardRate, &updated_rate);
            env.storage().instance().set(&DataKey::LastGlobalUpdate, &current_time);
        }

        Ok(())
    }
}

impl Default for UserRewardInfo {
    fn default() -> Self {
        Self {
            total_earned: 0,
            total_claimed: 0,
            last_claim: 0,
            multiplier: 10000, // 1x multiplier
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
        }
    }
} 