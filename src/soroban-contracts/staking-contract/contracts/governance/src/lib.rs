#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Vec, Bytes,
};

// Simplified governance types that mirror the existing ICE token system
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceRecord {
    pub user: Address,
    pub aqua_locked: i128,
    pub ice_amount: i128, // ICE governance tokens calculated from AQUA lock
    pub lock_duration_years: u32,
    pub lock_timestamp: u64,
    pub voting_power: i128, // Derived from ICE amount
    pub tx_hash: Bytes,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceConfig {
    pub admin: Address,
    pub staking_contract: Address,
    pub treasury_address: Address,
    pub base_multiplier: i128, // 1.0 = 10000 basis points
    pub max_time_multiplier: i128, // 2.0 = 20000 basis points  
    pub emergency_pause: bool,
    pub version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceStats {
    pub total_ice_supply: i128,
    pub total_voting_power: i128,
    pub total_participants: u32,
    pub last_update: u64,
}

#[contracttype]
pub enum DataKey {
    Config,
    UserGovernance(Address),
    UserCount(Address), // Count of governance records for user
    UserByIndex(Address, u32), // User governance record by index
    GlobalStats,
    DailySnapshot(u64), // Daily governance participation snapshots
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovernanceError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidInput = 4,
    ContractPaused = 5,
    RecordNotFound = 6,
    NumericOverflow = 7,
}

// Events matching existing system operations
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IceTokensIssuedEvent {
    pub user: Address,
    pub aqua_locked: i128,
    pub ice_amount: i128,
    pub voting_power: i128,
    pub lock_duration_years: u32,
    pub tx_hash: Bytes,
    pub timestamp: u64,
    pub record_index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VotingPowerUpdatedEvent {
    pub user: Address,
    pub old_voting_power: i128,
    pub new_voting_power: i128,
    pub total_ice: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceStatsUpdatedEvent {
    pub total_ice_supply: i128,
    pub total_voting_power: i128,
    pub total_participants: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolVotingRecordedEvent {
    pub total_ice_voting_power: i128,
    pub aqua_blub_pair_votes: i128,
    pub voting_percentage: i128, // basis points
    pub timestamp: u64,
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initialize governance contract with ICE token parameters
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        treasury_address: Address,
        base_multiplier: i128, // 10000 = 1.0 multiplier
        max_time_multiplier: i128, // 20000 = 2.0 max multiplier
    ) -> Result<(), GovernanceError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(GovernanceError::AlreadyInitialized);
        }

        admin.require_auth();

        // Validate parameters
        if base_multiplier <= 0 || max_time_multiplier <= 0 {
            return Err(GovernanceError::InvalidInput);
        }

        let config = GovernanceConfig {
            admin: admin.clone(),
            staking_contract,
            treasury_address,
            base_multiplier,
            max_time_multiplier,
            emergency_pause: false,
            version: 1,
        };

        env.storage().instance().set(&DataKey::Config, &config);

        // Initialize global stats
        let stats = GovernanceStats {
            total_ice_supply: 0,
            total_voting_power: 0,
            total_participants: 0,
            last_update: env.ledger().timestamp(),
        };
        env.storage().instance().set(&DataKey::GlobalStats, &stats);
        
        Ok(())
    }

    /// Record ICE token issuance when user locks AQUA (admin-only)
    pub fn record_ice_issuance(
        env: Env,
        admin: Address,
        user: Address,
        aqua_locked: i128,
        lock_duration_years: u32,
        tx_hash: Bytes,
    ) -> Result<u32, GovernanceError> {
        let config = Self::get_config(&env)?;
        admin.require_auth();
        
        if config.admin != admin {
            return Err(GovernanceError::Unauthorized);
        }
        
        if config.emergency_pause {
            return Err(GovernanceError::ContractPaused);
        }

        if aqua_locked <= 0 || lock_duration_years == 0 {
            return Err(GovernanceError::InvalidInput);
        }

        let now = env.ledger().timestamp();

        // Calculate ICE amount using existing system formula: ICE = AQUA_AMOUNT * TIME_MULTIPLIER
        let ice_amount = Self::calculate_ice_amount(&config, aqua_locked, lock_duration_years);
        let voting_power = ice_amount; // 1:1 voting power with ICE tokens

        // Get user's record count
        let mut count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserCount(user.clone()))
            .unwrap_or(0);
        let index = count;
        count = count.saturating_add(1);
        env.storage().persistent().set(&DataKey::UserCount(user.clone()), &count);

        // Create governance record
        let record = GovernanceRecord {
            user: user.clone(),
            aqua_locked,
            ice_amount,
            lock_duration_years,
            lock_timestamp: now,
            voting_power,
            tx_hash: tx_hash.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::UserByIndex(user.clone(), index), &record);

        // Update user's total governance position
        Self::update_user_governance_totals(&env, &user)?;

        // Update global stats
        Self::update_global_stats(&env, ice_amount, voting_power, if count == 1 { 1 } else { 0 })?;

        // Emit event
        let event = IceTokensIssuedEvent {
            user: user.clone(),
            aqua_locked,
            ice_amount,
            voting_power,
            lock_duration_years,
            tx_hash,
            timestamp: now,
            record_index: index,
        };
        env.events().publish((symbol_short!("ice"),), event);

        Ok(index)
    }

    /// Update voting power when user's total stake changes (called by staking contract)
    pub fn update_voting_power(
        env: Env,
        caller: Address,
        user: Address,
        new_total_ice: i128,
    ) -> Result<(), GovernanceError> {
        let config = Self::get_config(&env)?;
        
        // Allow staking contract or admin to call this
        if caller != config.staking_contract && caller != config.admin {
            return Err(GovernanceError::Unauthorized);
        }
        
        if config.emergency_pause {
            return Err(GovernanceError::ContractPaused);
        }

        // Get current voting power
        let old_voting_power = Self::get_user_voting_power(&env, &user);
        let new_voting_power = new_total_ice; // 1:1 with ICE tokens

        // Update global stats with the difference
        let voting_power_delta = new_voting_power - old_voting_power;
        if voting_power_delta != 0 {
            Self::update_global_stats(&env, 0, voting_power_delta, 0)?;
        }

        // Emit event
        let event = VotingPowerUpdatedEvent {
            user: user.clone(),
            old_voting_power,
            new_voting_power,
            total_ice: new_total_ice,
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("vpower"),), event);

        Ok(())
    }

    /// Record automated POL voting with ICE tokens (admin-only)
    pub fn record_pol_voting(
        env: Env,
        admin: Address,
        total_ice_voting_power: i128,
        aqua_blub_pair_votes: i128,
    ) -> Result<(), GovernanceError> {
        let config = Self::get_config(&env)?;
        admin.require_auth();
        
        if config.admin != admin {
            return Err(GovernanceError::Unauthorized);
        }

        if config.emergency_pause {
            return Err(GovernanceError::ContractPaused);
        }

        if total_ice_voting_power <= 0 || aqua_blub_pair_votes <= 0 {
            return Err(GovernanceError::InvalidInput);
        }

        let now = env.ledger().timestamp();

        // Update global stats to reflect voting
        let mut stats: GovernanceStats = env
            .storage()
            .instance()
            .get(&DataKey::GlobalStats)
            .unwrap_or_default();

        stats.last_update = now;
        env.storage().instance().set(&DataKey::GlobalStats, &stats);

        // Emit POL voting event
        let event = PolVotingRecordedEvent {
            total_ice_voting_power,
            aqua_blub_pair_votes,
            voting_percentage: (aqua_blub_pair_votes * 10000) / total_ice_voting_power, // basis points
            timestamp: now,
        };
        env.events().publish((symbol_short!("polvote"),), event);

        Ok(())
    }

    /// Calculate ICE amount based on AQUA locked and duration
    fn calculate_ice_amount(config: &GovernanceConfig, aqua_amount: i128, lock_duration_years: u32) -> i128 {
        // Base multiplier for lock (1.0 = 10000 basis points)
        let base_multiplier = config.base_multiplier;
        
        // Time multiplier increases with lock duration, max 2x for longer locks
        let time_multiplier = (lock_duration_years as i128 * 10000 / 2).min(config.max_time_multiplier);
        
        // ICE = AQUA * base_multiplier * time_multiplier / 10000 / 10000
        aqua_amount
            .saturating_mul(base_multiplier)
            .saturating_mul(time_multiplier)
            / 100_000_000 // Divide by 10000 * 10000 for basis points
    }

    /// Update user's total governance position
    fn update_user_governance_totals(env: &Env, user: &Address) -> Result<(), GovernanceError> {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserCount(user.clone()))
            .unwrap_or(0);

        let mut total_ice = 0i128;
        let mut total_voting_power = 0i128;

        for i in 0..count {
            if let Some(record) = env.storage().persistent().get::<DataKey, GovernanceRecord>(&DataKey::UserByIndex(user.clone(), i)) {
                total_ice = total_ice.saturating_add(record.ice_amount);
                total_voting_power = total_voting_power.saturating_add(record.voting_power);
            }
        }

        // Store aggregated user governance data
        let user_totals = GovernanceRecord {
            user: user.clone(),
            aqua_locked: 0, // Not used in aggregated record
            ice_amount: total_ice,
            lock_duration_years: 0, // Not used in aggregated record
            lock_timestamp: env.ledger().timestamp(),
            voting_power: total_voting_power,
            tx_hash: Bytes::new(env), // Not used in aggregated record
        };

        env.storage().persistent().set(&DataKey::UserGovernance(user.clone()), &user_totals);

        Ok(())
    }

    /// Update global governance statistics
    fn update_global_stats(
        env: &Env,
        ice_delta: i128,
        voting_power_delta: i128,
        participants_delta: u32,
    ) -> Result<(), GovernanceError> {
        let mut stats: GovernanceStats = env
            .storage()
            .instance()
            .get(&DataKey::GlobalStats)
            .unwrap_or_default();

        stats.total_ice_supply = stats.total_ice_supply.saturating_add(ice_delta);
        stats.total_voting_power = stats.total_voting_power.saturating_add(voting_power_delta);
        stats.total_participants = stats.total_participants.saturating_add(participants_delta);
        stats.last_update = env.ledger().timestamp();

        env.storage().instance().set(&DataKey::GlobalStats, &stats);

        // Create daily snapshot for analytics
        let day = env.ledger().timestamp() / 86400;
        env.storage().instance().set(&DataKey::DailySnapshot(day), &stats);

        // Emit stats update event
        let event = GovernanceStatsUpdatedEvent {
            total_ice_supply: stats.total_ice_supply,
            total_voting_power: stats.total_voting_power,
            total_participants: stats.total_participants,
            timestamp: stats.last_update,
        };
        env.events().publish((symbol_short!("stats"),), event);

        Ok(())
    }

    /// Get user's total voting power
    fn get_user_voting_power(env: &Env, user: &Address) -> i128 {
        env.storage()
            .persistent()
            .get::<DataKey, GovernanceRecord>(&DataKey::UserGovernance(user.clone()))
            .map(|record| record.voting_power)
            .unwrap_or(0)
    }

    // Getters
    pub fn get_config(env: &Env) -> Result<GovernanceConfig, GovernanceError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(GovernanceError::NotInitialized)
    }

    pub fn get_user_governance(env: Env, user: Address) -> Option<GovernanceRecord> {
        env.storage().persistent().get(&DataKey::UserGovernance(user))
    }

    pub fn get_user_record_count(env: Env, user: Address) -> u32 {
        env.storage().persistent().get(&DataKey::UserCount(user)).unwrap_or(0)
    }

    pub fn get_user_record_by_index(env: Env, user: Address, index: u32) -> Option<GovernanceRecord> {
        env.storage().persistent().get(&DataKey::UserByIndex(user, index))
    }

    pub fn get_global_stats(env: Env) -> Option<GovernanceStats> {
        env.storage().instance().get(&DataKey::GlobalStats)
    }

    pub fn get_daily_snapshot(env: Env, day: u64) -> Option<GovernanceStats> {
        env.storage().instance().get(&DataKey::DailySnapshot(day))
    }

    pub fn get_voting_power(env: Env, user: Address) -> i128 {
        Self::get_user_voting_power(&env, &user)
    }

    pub fn get_total_voting_power(env: Env) -> i128 {
        env.storage()
            .instance()
            .get::<DataKey, GovernanceStats>(&DataKey::GlobalStats)
            .map(|stats| stats.total_voting_power)
            .unwrap_or(0)
    }

    // Admin functions
    pub fn set_emergency_pause(
        env: Env,
        admin: Address,
        paused: bool,
    ) -> Result<(), GovernanceError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(GovernanceError::Unauthorized);
        }

        config.emergency_pause = paused;
        env.storage().instance().set(&DataKey::Config, &config);
        
        Ok(())
    }

    pub fn update_multipliers(
        env: Env,
        admin: Address,
        base_multiplier: Option<i128>,
        max_time_multiplier: Option<i128>,
    ) -> Result<(), GovernanceError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(GovernanceError::Unauthorized);
        }

        if let Some(base) = base_multiplier {
            if base <= 0 {
                return Err(GovernanceError::InvalidInput);
            }
            config.base_multiplier = base;
        }

        if let Some(max_time) = max_time_multiplier {
            if max_time <= 0 {
                return Err(GovernanceError::InvalidInput);
            }
            config.max_time_multiplier = max_time;
        }

        env.storage().instance().set(&DataKey::Config, &config);

        Ok(())
    }

    /// Get current voting allocation for POL
    pub fn get_pol_voting_allocation(env: Env) -> i128 {
        // In the current system, all ICE tokens vote for AQUA-BLUB pair
        // This could be configurable in the future
        Self::get_total_voting_power(env)
    }
}

// Default implementations
impl Default for GovernanceStats {
    fn default() -> Self {
        Self {
            total_ice_supply: 0,
            total_voting_power: 0,
            total_participants: 0,
            last_update: 0,
        }
    }
} 