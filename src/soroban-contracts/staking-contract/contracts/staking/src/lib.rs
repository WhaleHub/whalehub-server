#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, log, symbol_short, vec, Address, Env, Map, String,
    Symbol, Vec,
};

// Data Types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeInfo {
    pub amount: i128,
    pub timestamp: u64,
    pub lock_period: u64,
    pub reward_multiplier: i128, // Basis points (10000 = 1x)
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakingConfig {
    pub admin: Address,
    pub aqua_token: Address,
    pub blub_token: Address,
    pub min_stake_amount: i128,
    pub base_reward_rate: i128, // Annual percentage in basis points
    pub lock_periods: Vec<u64>, // Available lock periods in seconds
    pub reward_multipliers: Vec<i128>, // Corresponding multipliers in basis points
    pub emergency_pause: bool,
}

// Storage Keys
#[contracttype]
pub enum DataKey {
    Config,
    UserStake(Address),
    TotalStaked,
    RewardPool,
    LastRewardUpdate,
}

// Error Types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StakingError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InsufficientAmount = 4,
    InsufficientBalance = 5,
    InvalidLockPeriod = 6,
    StakeNotFound = 7,
    LockPeriodNotExpired = 8,
    ContractPaused = 9,
    InvalidConfiguration = 10,
}

// Events
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeEvent {
    pub user: Address,
    pub amount: i128,
    pub lock_period: u64,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnstakeEvent {
    pub user: Address,
    pub amount: i128,
    pub reward: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestakeEvent {
    pub user: Address,
    pub old_amount: i128,
    pub new_amount: i128,
    pub reward_compounded: i128,
    pub timestamp: u64,
}

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    /// Initialize the staking contract
    pub fn initialize(
        env: Env,
        admin: Address,
        aqua_token: Address,
        blub_token: Address,
        min_stake_amount: i128,
        base_reward_rate: i128,
        lock_periods: Vec<u64>,
        reward_multipliers: Vec<i128>,
    ) -> Result<(), StakingError> {
        // Check if already initialized
        if env.storage().instance().has(&DataKey::Config) {
            return Err(StakingError::AlreadyInitialized);
        }

        // Validate inputs
        if lock_periods.len() != reward_multipliers.len() {
            return Err(StakingError::InvalidConfiguration);
        }

        admin.require_auth();

        let config = StakingConfig {
            admin: admin.clone(),
            aqua_token,
            blub_token,
            min_stake_amount,
            base_reward_rate,
            lock_periods,
            reward_multipliers,
            emergency_pause: false,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::TotalStaked, &0i128);
        env.storage().instance().set(&DataKey::RewardPool, &0i128);
        env.storage().instance().set(&DataKey::LastRewardUpdate, &env.ledger().timestamp());

        log!(&env, "Staking contract initialized by admin: {}", admin);
        
        Ok(())
    }

    /// Stake AQUA tokens for BLUB with specified lock period
    pub fn stake(
        env: Env,
        user: Address,
        amount: i128,
        lock_period: u64,
    ) -> Result<(), StakingError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        // Check if contract is paused
        if config.emergency_pause {
            return Err(StakingError::ContractPaused);
        }

        // Validate amount
        if amount < config.min_stake_amount {
            return Err(StakingError::InsufficientAmount);
        }

        // Validate lock period
        let lock_index = config.lock_periods.iter().position(|&period| period == lock_period);
        if lock_index.is_none() {
            return Err(StakingError::InvalidLockPeriod);
        }

        let multiplier = config.reward_multipliers.get(lock_index.unwrap()).unwrap();
        let timestamp = env.ledger().timestamp();

        // Check if user already has a stake (for this version, one stake per user)
        if env.storage().persistent().has(&DataKey::UserStake(user.clone())) {
            return Err(StakingError::AlreadyInitialized); // Reusing error for "already staked"
        }

        // Create stake info
        let stake_info = StakeInfo {
            amount,
            timestamp,
            lock_period,
            reward_multiplier: multiplier,
        };

        // Store user stake
        env.storage().persistent().set(&DataKey::UserStake(user.clone()), &stake_info);

        // Update total staked
        let mut total_staked: i128 = env.storage().instance().get(&DataKey::TotalStaked).unwrap_or(0);
        total_staked += amount;
        env.storage().instance().set(&DataKey::TotalStaked, &total_staked);

        // Emit event
        let event = StakeEvent {
            user: user.clone(),
            amount,
            lock_period,
            timestamp,
        };
        env.events().publish((symbol_short!("stake"),), event);

        log!(&env, "User {} staked {} AQUA for {} seconds", user, amount, lock_period);

        Ok(())
    }

    /// Unstake BLUB tokens back to AQUA (after lock period)
    pub fn unstake(env: Env, user: Address) -> Result<i128, StakingError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        // Get user stake
        let stake_info: StakeInfo = env.storage().persistent()
            .get(&DataKey::UserStake(user.clone()))
            .ok_or(StakingError::StakeNotFound)?;

        let current_time = env.ledger().timestamp();
        let unlock_time = stake_info.timestamp + stake_info.lock_period;

        // Check if lock period has expired
        if current_time < unlock_time {
            return Err(StakingError::LockPeriodNotExpired);
        }

        // Calculate rewards
        let reward = Self::calculate_user_reward(&env, &user, &stake_info, current_time)?;
        let total_return = stake_info.amount + reward;

        // Remove user stake
        env.storage().persistent().remove(&DataKey::UserStake(user.clone()));

        // Update total staked
        let mut total_staked: i128 = env.storage().instance().get(&DataKey::TotalStaked).unwrap_or(0);
        total_staked -= stake_info.amount;
        env.storage().instance().set(&DataKey::TotalStaked, &total_staked);

        // Emit event
        let event = UnstakeEvent {
            user: user.clone(),
            amount: stake_info.amount,
            reward,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("unstake"),), event);

        log!(&env, "User {} unstaked {} AQUA with {} reward", user, stake_info.amount, reward);

        Ok(total_return)
    }

    /// Restake current stake with rewards compounded
    pub fn restake(
        env: Env,
        user: Address,
        new_lock_period: u64,
    ) -> Result<(), StakingError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        // Check if contract is paused
        if config.emergency_pause {
            return Err(StakingError::ContractPaused);
        }

        // Get current stake
        let mut stake_info: StakeInfo = env.storage().persistent()
            .get(&DataKey::UserStake(user.clone()))
            .ok_or(StakingError::StakeNotFound)?;

        // Validate new lock period
        let lock_index = config.lock_periods.iter().position(|&period| period == new_lock_period);
        if lock_index.is_none() {
            return Err(StakingError::InvalidLockPeriod);
        }

        let current_time = env.ledger().timestamp();
        
        // Calculate accumulated rewards
        let reward = Self::calculate_user_reward(&env, &user, &stake_info, current_time)?;
        
        let old_amount = stake_info.amount;
        let new_amount = stake_info.amount + reward;
        let new_multiplier = config.reward_multipliers.get(lock_index.unwrap()).unwrap();

        // Update stake info
        stake_info.amount = new_amount;
        stake_info.timestamp = current_time;
        stake_info.lock_period = new_lock_period;
        stake_info.reward_multiplier = new_multiplier;

        // Store updated stake
        env.storage().persistent().set(&DataKey::UserStake(user.clone()), &stake_info);

        // Update total staked (add the reward amount)
        let mut total_staked: i128 = env.storage().instance().get(&DataKey::TotalStaked).unwrap_or(0);
        total_staked += reward;
        env.storage().instance().set(&DataKey::TotalStaked, &total_staked);

        // Emit event
        let event = RestakeEvent {
            user: user.clone(),
            old_amount,
            new_amount,
            reward_compounded: reward,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("restake"),), event);

        log!(&env, "User {} restaked: old={}, new={}, reward={}", user, old_amount, new_amount, reward);

        Ok(())
    }

    /// Get user's stake balance and info
    pub fn get_stake_balance(env: Env, user: Address) -> Option<StakeInfo> {
        env.storage().persistent().get(&DataKey::UserStake(user))
    }

    /// Calculate pending rewards for a user
    pub fn calculate_rewards(env: Env, user: Address) -> Result<i128, StakingError> {
        let stake_info: StakeInfo = env.storage().persistent()
            .get(&DataKey::UserStake(user.clone()))
            .ok_or(StakingError::StakeNotFound)?;

        let current_time = env.ledger().timestamp();
        Self::calculate_user_reward(&env, &user, &stake_info, current_time)
    }

    /// Get total amount staked in the contract
    pub fn get_total_staked(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalStaked).unwrap_or(0)
    }

    /// Get contract configuration
    pub fn get_config(env: Env) -> Result<StakingConfig, StakingError> {
        env.storage().instance()
            .get(&DataKey::Config)
            .ok_or(StakingError::NotInitialized)
    }

    /// Admin function to pause/unpause the contract
    pub fn set_emergency_pause(env: Env, admin: Address, paused: bool) -> Result<(), StakingError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(StakingError::Unauthorized);
        }

        config.emergency_pause = paused;
        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Emergency pause set to: {}", paused);
        
        Ok(())
    }

    /// Admin function to update reward rate
    pub fn update_reward_rate(
        env: Env,
        admin: Address,
        new_rate: i128,
    ) -> Result<(), StakingError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(StakingError::Unauthorized);
        }

        config.base_reward_rate = new_rate;
        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Base reward rate updated to: {}", new_rate);
        
        Ok(())
    }

    // Internal helper functions
    fn calculate_user_reward(
        env: &Env,
        _user: &Address,
        stake_info: &StakeInfo,
        current_time: u64,
    ) -> Result<i128, StakingError> {
        let config = Self::get_config(env)?;
        
        let time_staked = current_time.saturating_sub(stake_info.timestamp);
        
        // Convert time from seconds to years (approximate)
        let time_in_years = (time_staked as i128) * 1_000_000 / (365 * 24 * 60 * 60 * 1_000_000); // Using 6 decimal precision
        
        // Calculate base reward: amount * rate * time * multiplier
        // rate is in basis points (10000 = 100%)
        // multiplier is in basis points (10000 = 1x)
        let base_reward = stake_info.amount
            .checked_mul(config.base_reward_rate).ok_or(StakingError::InvalidConfiguration)?
            .checked_mul(time_in_years).ok_or(StakingError::InvalidConfiguration)?
            .checked_div(10000 * 1_000_000).ok_or(StakingError::InvalidConfiguration)?; // Adjust for basis points and time precision
        
        let final_reward = base_reward
            .checked_mul(stake_info.reward_multiplier).ok_or(StakingError::InvalidConfiguration)?
            .checked_div(10000).ok_or(StakingError::InvalidConfiguration)?; // Adjust for multiplier basis points
        
        Ok(final_reward.max(0))
    }
} 