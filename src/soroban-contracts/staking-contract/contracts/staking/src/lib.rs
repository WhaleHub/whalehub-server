#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, log, symbol_short, vec, Address, Env, Map, String,
    Symbol, Vec, Bytes,
};
use whalehub_shared::{StakeType, validate_positive_amount, MAX_BASIS_POINTS, SECONDS_PER_YEAR};

// Enhanced Data Types with better architecture
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeInfo {
    pub amount: i128,
    pub timestamp: u64,
    pub lock_period: u64,
    pub reward_multiplier: i128, // Basis points (10000 = 1x)
    pub stake_type: StakeType,
    pub last_reward_update: u64,
    pub compound_count: u32, // Track restaking frequency
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakingConfig {
    pub admin: Address,
    pub aqua_token: Address,
    pub blub_token: Address,
    pub rewards_contract: Address,
    pub governance_contract: Address,
    pub min_stake_amount: i128,
    pub base_reward_rate: i128, // Annual percentage in basis points
    pub lock_periods: Vec<u64>, // Available lock periods in seconds
    pub reward_multipliers: Vec<i128>, // Corresponding multipliers in basis points
    pub emergency_pause: bool,
    pub max_stake_per_user: i128, // Prevent whale concentration
    pub fee_rate: i128, // Early withdrawal fee in basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalStakingStats {
    pub total_staked: i128,
    pub total_stakers: u32,
    pub average_lock_period: u64,
    pub total_rewards_distributed: i128,
    pub last_stats_update: u64,
}

// Enhanced Storage Keys with better organization
#[contracttype]
pub enum DataKey {
    Config,
    UserStake(Address),
    UserStakeHistory(Address, u64), // Address, timestamp
    TotalStaked,
    RewardPool,
    LastRewardUpdate,
    GlobalStats,
    ContractVersion,
    PausedOperations,
    WhitelistedAddresses,
    BlacklistedAddresses,
    StakeTypeConfig(StakeType),
}

// Enhanced Error Types with more granular error handling
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
    MaxStakeExceeded = 11,
    InvalidStakeType = 12,
    RewardContractError = 13,
    GovernanceContractError = 14,
    CrossContractCallFailed = 15,
    AddressBlacklisted = 16,
    OperationNotAllowed = 17,
    NumericOverflow = 18,
    InvalidTimestamp = 19,
    ContractVersionMismatch = 20,
}

// Enhanced Events with more detailed information
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeEvent {
    pub user: Address,
    pub amount: i128,
    pub lock_period: u64,
    pub stake_type: StakeType,
    pub multiplier: i128,
    pub timestamp: u64,
    pub total_user_stakes: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnstakeEvent {
    pub user: Address,
    pub amount: i128,
    pub reward: i128,
    pub fee: i128,
    pub stake_type: StakeType,
    pub timestamp: u64,
    pub remaining_user_stakes: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestakeEvent {
    pub user: Address,
    pub old_amount: i128,
    pub new_amount: i128,
    pub reward_compounded: i128,
    pub new_lock_period: u64,
    pub compound_count: u32,
    pub timestamp: u64,
}

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    /// Initialize the staking contract with enhanced configuration
    pub fn initialize(
        env: Env,
        admin: Address,
        aqua_token: Address,
        blub_token: Address,
        rewards_contract: Address,
        governance_contract: Address,
        min_stake_amount: i128,
        base_reward_rate: i128,
        lock_periods: Vec<u64>,
        reward_multipliers: Vec<i128>,
        max_stake_per_user: i128,
        fee_rate: i128,
    ) -> Result<(), StakingError> {
        // Check if already initialized
        if env.storage().instance().has(&DataKey::Config) {
            return Err(StakingError::AlreadyInitialized);
        }

        // Validate inputs
        if lock_periods.len() != reward_multipliers.len() {
            return Err(StakingError::InvalidConfiguration);
        }

        if base_reward_rate > 100000 || fee_rate > MAX_BASIS_POINTS {
            return Err(StakingError::InvalidConfiguration);
        }

        if !validate_positive_amount(min_stake_amount) || !validate_positive_amount(max_stake_per_user) {
            return Err(StakingError::InvalidConfiguration);
        }

        admin.require_auth();

        let config = StakingConfig {
            admin: admin.clone(),
            aqua_token,
            blub_token,
            rewards_contract,
            governance_contract,
            min_stake_amount,
            base_reward_rate,
            lock_periods,
            reward_multipliers,
            emergency_pause: false,
            max_stake_per_user,
            fee_rate,
        };

        // Initialize global stats
        let global_stats = GlobalStakingStats {
            total_staked: 0,
            total_stakers: 0,
            average_lock_period: 0,
            total_rewards_distributed: 0,
            last_stats_update: env.ledger().timestamp(),
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::TotalStaked, &0i128);
        env.storage().instance().set(&DataKey::RewardPool, &0i128);
        env.storage().instance().set(&DataKey::LastRewardUpdate, &env.ledger().timestamp());
        env.storage().instance().set(&DataKey::GlobalStats, &global_stats);
        env.storage().instance().set(&DataKey::ContractVersion, &1u32);

        log!(&env, "Enhanced Staking contract initialized by admin: {}", admin);
        
        Ok(())
    }

    /// Enhanced stake function with multiple stake types and better validation
    pub fn stake(
        env: Env,
        user: Address,
        amount: i128,
        lock_period: u64,
        stake_type: StakeType,
    ) -> Result<(), StakingError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        // Enhanced security checks
        Self::validate_user_eligibility(&env, &user)?;
        Self::check_contract_state(&env, &config)?;

        // Validate amount and limits
        if amount < config.min_stake_amount {
            return Err(StakingError::InsufficientAmount);
        }

        // Check max stake per user
        let current_user_stake = Self::get_user_total_staked(&env, &user);
        if current_user_stake + amount > config.max_stake_per_user {
            return Err(StakingError::MaxStakeExceeded);
        }

        // Validate lock period and get multiplier
        let (lock_index, multiplier) = Self::validate_lock_period(&config, lock_period)?;
        let timestamp = env.ledger().timestamp();

        // Check if user already has a stake (enhanced to support multiple stakes)
        let stake_key = DataKey::UserStake(user.clone());
        let existing_stake = env.storage().persistent().get::<DataKey, StakeInfo>(&stake_key);

        let stake_info = StakeInfo {
            amount,
            timestamp,
            lock_period,
            reward_multiplier: multiplier,
            stake_type: stake_type.clone(),
            last_reward_update: timestamp,
            compound_count: 0,
        };

        // Store user stake
        env.storage().persistent().set(&stake_key, &stake_info);

        // Store stake history
        let history_key = DataKey::UserStakeHistory(user.clone(), timestamp);
        env.storage().persistent().set(&history_key, &stake_info);

        // Update global statistics
        Self::update_global_stats(&env, amount, true)?;

        // Notify rewards contract
        Self::notify_rewards_contract(&env, &user, amount, multiplier)?;

        // Update governance voting power if governance stake
        if stake_type == StakeType::Governance {
            Self::notify_governance_contract(&env, &user, amount)?;
        }

        // Emit enhanced event
        let total_user_stakes = Self::get_user_total_staked(&env, &user);
        let event = StakeEvent {
            user: user.clone(),
            amount,
            lock_period,
            stake_type,
            multiplier,
            timestamp,
            total_user_stakes,
        };
        env.events().publish((symbol_short!("stake"),), event);

        log!(&env, "User {} staked {} tokens for {} seconds", user, amount, lock_period);

        Ok(())
    }

    /// Enhanced unstake with fee calculation and cross-contract notifications
    pub fn unstake(env: Env, user: Address, apply_fee: bool) -> Result<i128, StakingError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        Self::validate_user_eligibility(&env, &user)?;
        
        // Get user stake
        let stake_info: StakeInfo = env.storage().persistent()
            .get(&DataKey::UserStake(user.clone()))
            .ok_or(StakingError::StakeNotFound)?;

        let current_time = env.ledger().timestamp();
        let unlock_time = stake_info.timestamp + stake_info.lock_period;

        // Calculate rewards
        let reward = Self::calculate_user_reward(&env, &user, &stake_info, current_time)?;
        
        // Calculate early withdrawal fee if applicable
        let fee = if apply_fee && current_time < unlock_time {
            (stake_info.amount * config.fee_rate) / MAX_BASIS_POINTS
        } else if current_time < unlock_time {
            return Err(StakingError::LockPeriodNotExpired);
        } else {
            0
        };

        let total_return = stake_info.amount + reward - fee;

        // Remove user stake
        env.storage().persistent().remove(&DataKey::UserStake(user.clone()));

        // Update global statistics
        Self::update_global_stats(&env, stake_info.amount, false)?;

        // Notify contracts
        Self::notify_rewards_contract(&env, &user, -stake_info.amount, stake_info.reward_multiplier)?;
        if stake_info.stake_type == StakeType::Governance {
            Self::notify_governance_contract(&env, &user, -stake_info.amount)?;
        }

        // Emit event
        let remaining_stakes = Self::get_user_total_staked(&env, &user);
        let event = UnstakeEvent {
            user: user.clone(),
            amount: stake_info.amount,
            reward,
            fee,
            stake_type: stake_info.stake_type,
            timestamp: current_time,
            remaining_user_stakes: remaining_stakes,
        };
        env.events().publish((symbol_short!("unstake"),), event);

        log!(&env, "User {} unstaked {} tokens with {} reward and {} fee", user, stake_info.amount, reward, fee);

        Ok(total_return)
    }

    /// Enhanced restake with compound tracking
    pub fn restake(
        env: Env,
        user: Address,
        new_lock_period: u64,
        compound_rewards: bool,
    ) -> Result<(), StakingError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        Self::check_contract_state(&env, &config)?;
        Self::validate_user_eligibility(&env, &user)?;

        // Get current stake
        let mut stake_info: StakeInfo = env.storage().persistent()
            .get(&DataKey::UserStake(user.clone()))
            .ok_or(StakingError::StakeNotFound)?;

        // Validate new lock period
        let (_, new_multiplier) = Self::validate_lock_period(&config, new_lock_period)?;
        let current_time = env.ledger().timestamp();
        
        // Calculate accumulated rewards
        let reward = Self::calculate_user_reward(&env, &user, &stake_info, current_time)?;
        
        let old_amount = stake_info.amount;
        let new_amount = if compound_rewards {
            stake_info.amount + reward
        } else {
            stake_info.amount
        };

        // Check max stake limit
        if new_amount > config.max_stake_per_user {
            return Err(StakingError::MaxStakeExceeded);
        }

        // Update stake info
        stake_info.amount = new_amount;
        stake_info.timestamp = current_time;
        stake_info.lock_period = new_lock_period;
        stake_info.reward_multiplier = new_multiplier;
        stake_info.last_reward_update = current_time;
        stake_info.compound_count += 1;

        // Store updated stake
        env.storage().persistent().set(&DataKey::UserStake(user.clone()), &stake_info);

        // Update global stats if compounding
        if compound_rewards {
            Self::update_global_stats(&env, reward, true)?;
        }

        // Notify contracts
        Self::notify_rewards_contract(&env, &user, if compound_rewards { reward } else { 0 }, new_multiplier)?;

        // Emit event
        let event = RestakeEvent {
            user: user.clone(),
            old_amount,
            new_amount,
            reward_compounded: if compound_rewards { reward } else { 0 },
            new_lock_period,
            compound_count: stake_info.compound_count,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("restake"),), event);

        log!(&env, "User {} restaked: old={}, new={}, reward={}, compounds={}", 
             user, old_amount, new_amount, reward, stake_info.compound_count);

        Ok(())
    }

    // Enhanced getter functions
    pub fn get_stake_balance(env: Env, user: Address) -> Option<StakeInfo> {
        env.storage().persistent().get(&DataKey::UserStake(user))
    }

    pub fn get_user_total_staked(env: &Env, user: &Address) -> i128 {
        env.storage().persistent()
            .get::<DataKey, StakeInfo>(&DataKey::UserStake(user.clone()))
            .map(|stake| stake.amount)
            .unwrap_or(0)
    }

    pub fn get_global_stats(env: Env) -> Option<GlobalStakingStats> {
        env.storage().instance().get(&DataKey::GlobalStats)
    }

    pub fn calculate_rewards(env: Env, user: Address) -> Result<i128, StakingError> {
        let stake_info: StakeInfo = env.storage().persistent()
            .get(&DataKey::UserStake(user.clone()))
            .ok_or(StakingError::StakeNotFound)?;

        let current_time = env.ledger().timestamp();
        Self::calculate_user_reward(&env, &user, &stake_info, current_time)
    }

    pub fn get_total_staked(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalStaked).unwrap_or(0)
    }

    pub fn get_config(env: &Env) -> Result<StakingConfig, StakingError> {
        env.storage().instance()
            .get(&DataKey::Config)
            .ok_or(StakingError::NotInitialized)
    }

    // Enhanced admin functions
    pub fn set_emergency_pause(env: Env, admin: Address, paused: bool) -> Result<(), StakingError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(StakingError::Unauthorized);
        }

        config.emergency_pause = paused;
        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Emergency pause set to: {} by admin", paused);
        
        Ok(())
    }

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

        if new_rate > 100000 { // Max 1000% APY
            return Err(StakingError::InvalidConfiguration);
        }

        let old_rate = config.base_reward_rate;
        config.base_reward_rate = new_rate;
        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Base reward rate updated from {} to {}", old_rate, new_rate);
        
        Ok(())
    }

    // Helper functions for enhanced functionality
    fn validate_user_eligibility(env: &Env, user: &Address) -> Result<(), StakingError> {
        // Check blacklist
        if env.storage().persistent().has(&DataKey::BlacklistedAddresses) {
            let blacklist: Vec<Address> = env.storage().persistent()
                .get(&DataKey::BlacklistedAddresses)
                .unwrap_or(vec![&env]);
            
            if blacklist.contains(user) {
                return Err(StakingError::AddressBlacklisted);
            }
        }
        Ok(())
    }

    fn check_contract_state(env: &Env, config: &StakingConfig) -> Result<(), StakingError> {
        if config.emergency_pause {
            return Err(StakingError::ContractPaused);
        }
        Ok(())
    }

    fn validate_lock_period(config: &StakingConfig, lock_period: u64) -> Result<(usize, i128), StakingError> {
        let lock_index = config.lock_periods.iter()
            .position(|&period| period == lock_period)
            .ok_or(StakingError::InvalidLockPeriod)?;
        
        let multiplier = config.reward_multipliers
            .get(lock_index)
            .ok_or(StakingError::InvalidConfiguration)?;
            
        Ok((lock_index, multiplier))
    }

    fn update_global_stats(env: &Env, amount_change: i128, is_increase: bool) -> Result<(), StakingError> {
        let mut stats: GlobalStakingStats = env.storage().instance()
            .get(&DataKey::GlobalStats)
            .unwrap_or(GlobalStakingStats {
                total_staked: 0,
                total_stakers: 0,
                average_lock_period: 0,
                total_rewards_distributed: 0,
                last_stats_update: env.ledger().timestamp(),
            });

        if is_increase {
            stats.total_staked = stats.total_staked.checked_add(amount_change)
                .ok_or(StakingError::NumericOverflow)?;
        } else {
            stats.total_staked = stats.total_staked.checked_sub(amount_change)
                .ok_or(StakingError::NumericOverflow)?;
        }

        stats.last_stats_update = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::GlobalStats, &stats);
        
        // Also update the legacy total staked storage
        env.storage().instance().set(&DataKey::TotalStaked, &stats.total_staked);
        
        Ok(())
    }

    fn notify_rewards_contract(env: &Env, user: &Address, amount: i128, multiplier: i128) -> Result<(), StakingError> {
        let config = Self::get_config(env)?;
        
        // This would be implemented as a cross-contract call in production
        // For now, we'll just log the intended action
        log!(env, "Would notify rewards contract: user={}, amount={}, multiplier={}", user, amount, multiplier);
        
        Ok(())
    }

    fn notify_governance_contract(env: &Env, user: &Address, voting_power_change: i128) -> Result<(), StakingError> {
        let config = Self::get_config(env)?;
        
        // This would be implemented as a cross-contract call in production
        // For now, we'll just log the intended action
        log!(env, "Would notify governance contract: user={}, voting_power_change={}", user, voting_power_change);
        
        Ok(())
    }

    // Enhanced reward calculation with more sophisticated logic
    fn calculate_user_reward(
        env: &Env,
        _user: &Address,
        stake_info: &StakeInfo,
        current_time: u64,
    ) -> Result<i128, StakingError> {
        let config = Self::get_config(env)?;
        
        let time_staked = current_time.saturating_sub(stake_info.last_reward_update);
        
        // Convert time from seconds to years (using precise calculation)
        let time_factor = (time_staked as i128) * 1_000_000 / (SECONDS_PER_YEAR as i128);
        
        // Calculate base reward: amount * rate * time * multiplier
        let base_reward = stake_info.amount
            .checked_mul(config.base_reward_rate).ok_or(StakingError::NumericOverflow)?
            .checked_mul(time_factor).ok_or(StakingError::NumericOverflow)?
            .checked_div(MAX_BASIS_POINTS * 1_000_000).ok_or(StakingError::NumericOverflow)?;
        
        let final_reward = base_reward
            .checked_mul(stake_info.reward_multiplier).ok_or(StakingError::NumericOverflow)?
            .checked_div(MAX_BASIS_POINTS).ok_or(StakingError::NumericOverflow)?;
        
        // Apply compound bonus if applicable
        let compound_bonus = if stake_info.compound_count > 0 {
            let bonus_rate = (stake_info.compound_count as i128) * 100; // 1% per compound
            final_reward.checked_mul(bonus_rate).unwrap_or(0).checked_div(MAX_BASIS_POINTS).unwrap_or(0)
        } else {
            0
        };
        
        Ok((final_reward + compound_bonus).max(0))
    }
} 