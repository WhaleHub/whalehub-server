#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, log, symbol_short, Address, Env, Map, Vec,
};

// Data Types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityPool {
    pub token_a: Address,
    pub token_b: Address,
    pub total_liquidity: i128,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub fee_rate: i128, // Basis points (100 = 1%)
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LPStakeInfo {
    pub pool_id: u64,
    pub lp_amount: i128,
    pub timestamp: u64,
    pub lock_period: u64,
    pub reward_multiplier: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityConfig {
    pub admin: Address,
    pub staking_contract: Address,
    pub rewards_contract: Address,
    pub min_liquidity: i128,
    pub default_fee_rate: i128,
    pub emergency_pause: bool,
}

// Storage Keys
#[contracttype]
pub enum DataKey {
    Config,
    Pool(u64),
    UserLPStake(Address, u64),
    PoolCount,
    TotalLPStaked,
    PoolRewards(u64),
}

// Error Types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiquidityError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    PoolNotFound = 4,
    InsufficientLiquidity = 5,
    InvalidTokens = 6,
    InsufficientReserves = 7,
    SlippageTooHigh = 8,
    ContractPaused = 9,
    InvalidFeeRate = 10,
    StakeNotFound = 11,
    LockPeriodNotExpired = 12,
}

// Events
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolCreatedEvent {
    pub pool_id: u64,
    pub token_a: Address,
    pub token_b: Address,
    pub creator: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityAddedEvent {
    pub pool_id: u64,
    pub user: Address,
    pub amount_a: i128,
    pub amount_b: i128,
    pub lp_tokens: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LPStakedEvent {
    pub pool_id: u64,
    pub user: Address,
    pub lp_amount: i128,
    pub lock_period: u64,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LPUnstakedEvent {
    pub pool_id: u64,
    pub user: Address,
    pub lp_amount: i128,
    pub reward: i128,
    pub timestamp: u64,
}

#[contract]
pub struct LiquidityContract;

#[contractimpl]
impl LiquidityContract {
    /// Initialize the liquidity contract
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        rewards_contract: Address,
        min_liquidity: i128,
        default_fee_rate: i128,
    ) -> Result<(), LiquidityError> {
        // Check if already initialized
        if env.storage().instance().has(&DataKey::Config) {
            return Err(LiquidityError::AlreadyInitialized);
        }

        admin.require_auth();

        if default_fee_rate > 1000 { // Max 10% fee
            return Err(LiquidityError::InvalidFeeRate);
        }

        let config = LiquidityConfig {
            admin: admin.clone(),
            staking_contract,
            rewards_contract,
            min_liquidity,
            default_fee_rate,
            emergency_pause: false,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::PoolCount, &0u64);
        env.storage().instance().set(&DataKey::TotalLPStaked, &0i128);

        log!(&env, "Liquidity contract initialized by admin: {}", admin);
        
        Ok(())
    }

    /// Create a new liquidity pool
    pub fn create_pool(
        env: Env,
        creator: Address,
        token_a: Address,
        token_b: Address,
        initial_a: i128,
        initial_b: i128,
        fee_rate: Option<i128>,
    ) -> Result<u64, LiquidityError> {
        creator.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(LiquidityError::ContractPaused);
        }

        if token_a == token_b {
            return Err(LiquidityError::InvalidTokens);
        }

        if initial_a < config.min_liquidity || initial_b < config.min_liquidity {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        let pool_count: u64 = env.storage().instance().get(&DataKey::PoolCount).unwrap_or(0);
        let pool_id = pool_count + 1;

        let fee = fee_rate.unwrap_or(config.default_fee_rate);
        if fee > 1000 {
            return Err(LiquidityError::InvalidFeeRate);
        }

        let initial_liquidity = (initial_a * initial_b).integer_sqrt();

        let pool = LiquidityPool {
            token_a: token_a.clone(),
            token_b: token_b.clone(),
            total_liquidity: initial_liquidity,
            reserve_a: initial_a,
            reserve_b: initial_b,
            fee_rate: fee,
            created_at: env.ledger().timestamp(),
        };

        env.storage().instance().set(&DataKey::Pool(pool_id), &pool);
        env.storage().instance().set(&DataKey::PoolCount, &pool_id);

        // Emit event
        let event = PoolCreatedEvent {
            pool_id,
            token_a,
            token_b,
            creator: creator.clone(),
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("poolcrt"),), event);

        log!(&env, "Pool {} created by {} for tokens {} and {}", pool_id, creator, pool.token_a, pool.token_b);

        Ok(pool_id)
    }

    /// Add liquidity to an existing pool
    pub fn add_liquidity(
        env: Env,
        user: Address,
        pool_id: u64,
        amount_a: i128,
        amount_b: i128,
        min_liquidity: i128,
    ) -> Result<i128, LiquidityError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(LiquidityError::ContractPaused);
        }

        let mut pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id))
            .ok_or(LiquidityError::PoolNotFound)?;

        if amount_a <= 0 || amount_b <= 0 {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        // Calculate optimal amounts based on current reserves
        let optimal_b = (amount_a * pool.reserve_b) / pool.reserve_a;
        let optimal_a = (amount_b * pool.reserve_a) / pool.reserve_b;

        let (final_a, final_b) = if optimal_b <= amount_b {
            (amount_a, optimal_b)
        } else {
            (optimal_a, amount_b)
        };

        // Calculate LP tokens to mint
        let lp_tokens = if pool.total_liquidity == 0 {
            (final_a * final_b).integer_sqrt()
        } else {
            ((final_a * pool.total_liquidity) / pool.reserve_a).min(
                (final_b * pool.total_liquidity) / pool.reserve_b
            )
        };

        if lp_tokens < min_liquidity {
            return Err(LiquidityError::SlippageTooHigh);
        }

        // Update pool reserves
        pool.reserve_a += final_a;
        pool.reserve_b += final_b;
        pool.total_liquidity += lp_tokens;

        env.storage().instance().set(&DataKey::Pool(pool_id), &pool);

        // Emit event
        let event = LiquidityAddedEvent {
            pool_id,
            user: user.clone(),
            amount_a: final_a,
            amount_b: final_b,
            lp_tokens,
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("lpadd"),), event);

        log!(&env, "User {} added liquidity to pool {}: {}A + {}B = {}LP", user, pool_id, final_a, final_b, lp_tokens);

        Ok(lp_tokens)
    }

    /// Stake LP tokens
    pub fn stake_lp(
        env: Env,
        user: Address,
        pool_id: u64,
        lp_amount: i128,
        lock_period: u64,
    ) -> Result<(), LiquidityError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(LiquidityError::ContractPaused);
        }

        // Verify pool exists
        let _pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id))
            .ok_or(LiquidityError::PoolNotFound)?;

        if lp_amount <= 0 {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        // Check if user already has LP staked in this pool
        if env.storage().persistent().has(&DataKey::UserLPStake(user.clone(), pool_id)) {
            return Err(LiquidityError::AlreadyInitialized); // Reusing error for "already staked"
        }

        let reward_multiplier = Self::calculate_lp_multiplier(lock_period);
        let timestamp = env.ledger().timestamp();

        let stake_info = LPStakeInfo {
            pool_id,
            lp_amount,
            timestamp,
            lock_period,
            reward_multiplier,
        };

        env.storage().persistent().set(&DataKey::UserLPStake(user.clone(), pool_id), &stake_info);

        // Update total LP staked
        let mut total_lp_staked: i128 = env.storage().instance().get(&DataKey::TotalLPStaked).unwrap_or(0);
        total_lp_staked += lp_amount;
        env.storage().instance().set(&DataKey::TotalLPStaked, &total_lp_staked);

        // Emit event
        let event = LPStakedEvent {
            pool_id,
            user: user.clone(),
            lp_amount,
            lock_period,
            timestamp,
        };
        env.events().publish((symbol_short!("lpstake"),), event);

        log!(&env, "User {} staked {} LP tokens from pool {} for {} seconds", user, lp_amount, pool_id, lock_period);

        Ok(())
    }

    /// Unstake LP tokens
    pub fn unstake_lp(
        env: Env,
        user: Address,
        pool_id: u64,
    ) -> Result<i128, LiquidityError> {
        user.require_auth();

        let stake_info: LPStakeInfo = env.storage().persistent()
            .get(&DataKey::UserLPStake(user.clone(), pool_id))
            .ok_or(LiquidityError::StakeNotFound)?;

        let current_time = env.ledger().timestamp();
        let unlock_time = stake_info.timestamp + stake_info.lock_period;

        // Check if lock period has expired
        if current_time < unlock_time {
            return Err(LiquidityError::LockPeriodNotExpired);
        }

        // Calculate rewards (simplified)
        let time_staked = current_time - stake_info.timestamp;
        let base_reward = (stake_info.lp_amount * time_staked as i128) / 1_000_000; // Simple reward calculation
        let reward = (base_reward * stake_info.reward_multiplier) / 10000;

        // Remove stake
        env.storage().persistent().remove(&DataKey::UserLPStake(user.clone(), pool_id));

        // Update total LP staked
        let mut total_lp_staked: i128 = env.storage().instance().get(&DataKey::TotalLPStaked).unwrap_or(0);
        total_lp_staked -= stake_info.lp_amount;
        env.storage().instance().set(&DataKey::TotalLPStaked, &total_lp_staked);

        // Emit event
        let event = LPUnstakedEvent {
            pool_id,
            user: user.clone(),
            lp_amount: stake_info.lp_amount,
            reward,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("lpunstk"),), event);

        log!(&env, "User {} unstaked {} LP tokens from pool {} with {} reward", user, stake_info.lp_amount, pool_id, reward);

        Ok(stake_info.lp_amount + reward)
    }

    /// Remove liquidity from pool
    pub fn remove_liquidity(
        env: Env,
        user: Address,
        pool_id: u64,
        lp_amount: i128,
        min_a: i128,
        min_b: i128,
    ) -> Result<(i128, i128), LiquidityError> {
        user.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.emergency_pause {
            return Err(LiquidityError::ContractPaused);
        }

        let mut pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id))
            .ok_or(LiquidityError::PoolNotFound)?;

        if lp_amount <= 0 || lp_amount > pool.total_liquidity {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        // Calculate token amounts to return
        let amount_a = (lp_amount * pool.reserve_a) / pool.total_liquidity;
        let amount_b = (lp_amount * pool.reserve_b) / pool.total_liquidity;

        if amount_a < min_a || amount_b < min_b {
            return Err(LiquidityError::SlippageTooHigh);
        }

        // Update pool reserves
        pool.reserve_a -= amount_a;
        pool.reserve_b -= amount_b;
        pool.total_liquidity -= lp_amount;

        env.storage().instance().set(&DataKey::Pool(pool_id), &pool);

        log!(&env, "User {} removed {} LP from pool {}: {}A + {}B", user, lp_amount, pool_id, amount_a, amount_b);

        Ok((amount_a, amount_b))
    }

    /// Get pool information
    pub fn get_pool(env: Env, pool_id: u64) -> Option<LiquidityPool> {
        env.storage().instance().get(&DataKey::Pool(pool_id))
    }

    /// Get user's LP stake info
    pub fn get_lp_stake(env: Env, user: Address, pool_id: u64) -> Option<LPStakeInfo> {
        env.storage().persistent().get(&DataKey::UserLPStake(user, pool_id))
    }

    /// Get total number of pools
    pub fn get_pool_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::PoolCount).unwrap_or(0)
    }

    /// Get total LP tokens staked
    pub fn get_total_lp_staked(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalLPStaked).unwrap_or(0)
    }

    /// Get contract configuration
    pub fn get_config(env: Env) -> Result<LiquidityConfig, LiquidityError> {
        env.storage().instance()
            .get(&DataKey::Config)
            .ok_or(LiquidityError::NotInitialized)
    }

    /// Admin function to pause/unpause the contract
    pub fn set_emergency_pause(
        env: Env,
        admin: Address,
        paused: bool,
    ) -> Result<(), LiquidityError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(LiquidityError::Unauthorized);
        }

        config.emergency_pause = paused;
        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Emergency pause set to: {}", paused);
        
        Ok(())
    }

    /// Admin function to update minimum liquidity
    pub fn update_min_liquidity(
        env: Env,
        admin: Address,
        new_min: i128,
    ) -> Result<(), LiquidityError> {
        admin.require_auth();

        let mut config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(LiquidityError::Unauthorized);
        }

        config.min_liquidity = new_min;
        env.storage().instance().set(&DataKey::Config, &config);

        log!(&env, "Minimum liquidity updated to: {}", new_min);
        
        Ok(())
    }

    // Internal helper functions
    fn calculate_lp_multiplier(lock_period: u64) -> i128 {
        // Calculate reward multiplier based on lock period
        match lock_period {
            0..=86400 => 10000,        // 1x for up to 1 day
            86401..=604800 => 11000,   // 1.1x for up to 1 week
            604801..=2592000 => 12000, // 1.2x for up to 1 month
            2592001..=7776000 => 13000, // 1.3x for up to 3 months
            _ => 15000,                // 1.5x for longer than 3 months
        }
    }
}

// Helper trait for integer square root
trait IntegerSqrt {
    fn integer_sqrt(self) -> Self;
}

impl IntegerSqrt for i128 {
    fn integer_sqrt(self) -> Self {
        if self < 0 {
            return 0;
        }
        if self < 2 {
            return self;
        }
        
        let mut x = self;
        let mut y = (x + 1) / 2;
        
        while y < x {
            x = y;
            y = (x + self / x) / 2;
        }
        
        x
    }
} 