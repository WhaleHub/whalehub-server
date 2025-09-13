#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Vec, Bytes,
};

// Simplified data types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityPool {
    pub pool_id: Bytes,
    pub token_a: Address,
    pub token_b: Address,
    pub total_liquidity: i128,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub fee_rate: i128, // Basis points (30 = 0.3%)
    pub created_at: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LPPosition {
    pub user: Address,
    pub pool_id: Bytes,
    pub lp_amount: i128,
    pub asset_a_deposited: i128,
    pub asset_b_deposited: i128,
    pub timestamp: u64,
    pub last_reward_claim: u64,
    pub total_fees_earned: i128,
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
    pub treasury_address: Address,
    pub max_pools: u32, // Gas optimization limit
}

// Gas-optimized global tracking
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalLiquidityStats {
    pub total_value_locked: i128,
    pub total_pools: u32,
    pub total_lp_providers: u32,
    pub total_fees_collected: i128,
    pub last_update: u64,
}

#[contracttype]
pub enum DataKey {
    Config,
    Pool(Bytes), // Use Bytes for pool ID for gas efficiency
    UserLPPosition(Address, Bytes), // user, pool_id
    UserPools(Address), // List of pools user participates in
    PoolCount,
    GlobalStats,
    PoolSnapshot(Bytes, u64), // pool_id, day - for analytics
    FeesCollected(Bytes, u64), // pool_id, day - for reward calculation
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiquidityError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    PoolNotFound = 4,
    InsufficientLiquidity = 5,
    InvalidTokens = 6,
    InvalidFeeRate = 10,
    ContractPaused = 9,
    PoolLimitReached = 11,
    InvalidPoolId = 12,
    PositionNotFound = 13,
    NumericOverflow = 14,
}

// Simplified events
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolRegisteredEvent {
    pub pool_id: Bytes,
    pub token_a: Address,
    pub token_b: Address,
    pub creator: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityRecordedEvent {
    pub user: Address,
    pub pool_id: Bytes,
    pub amount_a: i128,
    pub amount_b: i128,
    pub lp_tokens: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesCollectedEvent {
    pub pool_id: Bytes,
    pub total_fees: i128,
    pub timestamp: u64,
}

#[contract]
pub struct LiquidityContract;

#[contractimpl]
impl LiquidityContract {
    // liquidity pool integration
    
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        rewards_contract: Address,
        treasury_address: Address,
        min_liquidity: i128,
        default_fee_rate: i128,
        max_pools: u32,
    ) -> Result<(), LiquidityError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(LiquidityError::AlreadyInitialized);
        }

        admin.require_auth();

        // Validate parameters
        if default_fee_rate > 1000 { // Max 10% fee
            return Err(LiquidityError::InvalidFeeRate);
        }

        if min_liquidity <= 0 {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        let config = LiquidityConfig {
            admin: admin.clone(),
            staking_contract,
            rewards_contract,
            min_liquidity,
            default_fee_rate,
            emergency_pause: false,
            treasury_address,
            max_pools,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::PoolCount, &0u32);

        // Initialize global stats
        let global_stats = GlobalLiquidityStats {
            total_value_locked: 0,
            total_pools: 0,
            total_lp_providers: 0,
            total_fees_collected: 0,
            last_update: env.ledger().timestamp(),
        };
        env.storage().instance().set(&DataKey::GlobalStats, &global_stats);
        
        Ok(())
    }

    // Register a pool from AMM contract (admin-only)
    pub fn register_pool(
        env: Env,
        admin: Address,
        pool_id: Bytes,
        token_a: Address,
        token_b: Address,
        initial_a: i128,
        initial_b: i128,
        fee_rate: Option<i128>,
    ) -> Result<(), LiquidityError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(LiquidityError::Unauthorized);
        }

        if config.emergency_pause {
            return Err(LiquidityError::ContractPaused);
        }

        // Check pool limit for gas optimization
        let pool_count: u32 = env.storage().instance().get(&DataKey::PoolCount).unwrap_or(0);
        if pool_count >= config.max_pools {
            return Err(LiquidityError::PoolLimitReached);
        }

        // Validate tokens are different
        if token_a == token_b {
            return Err(LiquidityError::InvalidTokens);
        }

        // Check if pool already exists
        if env.storage().instance().has(&DataKey::Pool(pool_id.clone())) {
            return Err(LiquidityError::AlreadyInitialized);
        }

        let fee = fee_rate.unwrap_or(config.default_fee_rate);
        if fee > 1000 {
            return Err(LiquidityError::InvalidFeeRate);
        }

        // Calculate initial liquidity (AMM logic)
        let initial_liquidity = Self::calculate_lp_tokens(initial_a, initial_b, 0);

        let pool = LiquidityPool {
            pool_id: pool_id.clone(),
            token_a: token_a.clone(),
            token_b: token_b.clone(),
            total_liquidity: initial_liquidity,
            reserve_a: initial_a,
            reserve_b: initial_b,
            fee_rate: fee,
            created_at: env.ledger().timestamp(),
            active: true,
        };

        env.storage().instance().set(&DataKey::Pool(pool_id.clone()), &pool);
        
        let new_count = pool_count.saturating_add(1);
        env.storage().instance().set(&DataKey::PoolCount, &new_count);

        // Update global stats
        Self::update_global_stats(&env, initial_a + initial_b, 1, 0, 0)?;

        let event = PoolRegisteredEvent {
            pool_id: pool_id.clone(),
            token_a,
            token_b,
            creator: admin.clone(),
            timestamp: env.ledger().timestamp(),
        };
        env.events().publish((symbol_short!("poolreg"),), event);

        Ok(())
    }

    // Record liquidity addition (admin-only, called after backend confirms AMM transaction)
    pub fn record_liquidity_addition(
        env: Env,
        admin: Address,
        user: Address,
        pool_id: Bytes,
        amount_a: i128,
        amount_b: i128,
        lp_tokens_minted: i128,
    ) -> Result<(), LiquidityError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(LiquidityError::Unauthorized);
        }

        if config.emergency_pause {
            return Err(LiquidityError::ContractPaused);
        }

        // Validate inputs
        if amount_a <= 0 || amount_b <= 0 || lp_tokens_minted <= 0 {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        // Check pool exists
        let mut pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id.clone()))
            .ok_or(LiquidityError::PoolNotFound)?;

        if !pool.active {
            return Err(LiquidityError::ContractPaused);
        }

        // Update pool reserves
        pool.reserve_a = pool.reserve_a.saturating_add(amount_a);
        pool.reserve_b = pool.reserve_b.saturating_add(amount_b);
        pool.total_liquidity = pool.total_liquidity.saturating_add(lp_tokens_minted);

        env.storage().instance().set(&DataKey::Pool(pool_id.clone()), &pool);

        // Update or create user LP position
        let current_time = env.ledger().timestamp();
        let mut position: LPPosition = env.storage().persistent()
            .get(&DataKey::UserLPPosition(user.clone(), pool_id.clone()))
            .unwrap_or(LPPosition {
                user: user.clone(),
                pool_id: pool_id.clone(),
                lp_amount: 0,
                asset_a_deposited: 0,
                asset_b_deposited: 0,
                timestamp: current_time,
                last_reward_claim: current_time,
                total_fees_earned: 0,
            });

        // Track if this is a new LP provider
        let is_new_provider = position.lp_amount == 0;

        position.lp_amount = position.lp_amount.saturating_add(lp_tokens_minted);
        position.asset_a_deposited = position.asset_a_deposited.saturating_add(amount_a);
        position.asset_b_deposited = position.asset_b_deposited.saturating_add(amount_b);

        env.storage().persistent().set(&DataKey::UserLPPosition(user.clone(), pool_id.clone()), &position);

        // Add pool to user's pool list if new
        if is_new_provider {
            let mut user_pools: Vec<Bytes> = env.storage().persistent()
                .get(&DataKey::UserPools(user.clone()))
                .unwrap_or(Vec::new(&env));
            
            user_pools.push_back(pool_id.clone());
            env.storage().persistent().set(&DataKey::UserPools(user.clone()), &user_pools);
        }

        // Update global stats
        let tvl_increase = amount_a + amount_b;
        let new_providers = if is_new_provider { 1 } else { 0 };
        Self::update_global_stats(&env, tvl_increase, 0, new_providers, 0)?;

        let event = LiquidityRecordedEvent {
            user: user.clone(),
            pool_id: pool_id.clone(),
            amount_a,
            amount_b,
            lp_tokens: lp_tokens_minted,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("lpadd"),), event);

        Ok(())
    }

    // Record liquidity removal (admin-only, called after backend confirms AMM transaction)
    pub fn record_liquidity_removal(
        env: Env,
        admin: Address,
        user: Address,
        pool_id: Bytes,
        lp_tokens_burned: i128,
        amount_a_returned: i128,
        amount_b_returned: i128,
    ) -> Result<(), LiquidityError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(LiquidityError::Unauthorized);
        }

        if config.emergency_pause {
            return Err(LiquidityError::ContractPaused);
        }

        // Get user position
        let mut position: LPPosition = env.storage().persistent()
            .get(&DataKey::UserLPPosition(user.clone(), pool_id.clone()))
            .ok_or(LiquidityError::PositionNotFound)?;

        if position.lp_amount < lp_tokens_burned {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        // Update pool reserves
        let mut pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id.clone()))
            .ok_or(LiquidityError::PoolNotFound)?;

        pool.reserve_a = pool.reserve_a.saturating_sub(amount_a_returned);
        pool.reserve_b = pool.reserve_b.saturating_sub(amount_b_returned);
        pool.total_liquidity = pool.total_liquidity.saturating_sub(lp_tokens_burned);

        env.storage().instance().set(&DataKey::Pool(pool_id.clone()), &pool);

        // Update user position
        position.lp_amount = position.lp_amount.saturating_sub(lp_tokens_burned);
        
        // If position is now empty, clean up
        if position.lp_amount == 0 {
            env.storage().persistent().remove(&DataKey::UserLPPosition(user.clone(), pool_id.clone()));
            
            // Remove from user pools list
            let mut user_pools: Vec<Bytes> = env.storage().persistent()
                .get(&DataKey::UserPools(user.clone()))
                .unwrap_or(Vec::new(&env));
            
            user_pools.retain(|p| p != &pool_id);
            env.storage().persistent().set(&DataKey::UserPools(user.clone()), &user_pools);
        } else {
            env.storage().persistent().set(&DataKey::UserLPPosition(user.clone(), pool_id.clone()), &position);
        }

        // Update global stats (decrease TVL)
        let tvl_decrease = amount_a_returned + amount_b_returned;
        Self::update_global_stats(&env, -tvl_decrease, 0, 0, 0)?;

        Ok(())
    }

    // Record fees collected for a pool (called during reward distribution)
    pub fn record_fees_collected(
        env: Env,
        admin: Address,
        pool_id: Bytes,
        total_fees: i128,
    ) -> Result<(), LiquidityError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(LiquidityError::Unauthorized);
        }

        if total_fees <= 0 {
            return Err(LiquidityError::InsufficientLiquidity);
        }

        // Check pool exists
        let pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id.clone()))
            .ok_or(LiquidityError::PoolNotFound)?;

        if !pool.active {
            return Err(LiquidityError::ContractPaused);
        }

        let current_time = env.ledger().timestamp();
        let day = current_time / 86400; // Day-based fee tracking

        // Store daily fee collection for analytics
        let fees_key = DataKey::FeesCollected(pool_id.clone(), day);
        let existing_fees: i128 = env.storage().instance().get(&fees_key).unwrap_or(0);
        let updated_fees = existing_fees.saturating_add(total_fees);
        env.storage().instance().set(&fees_key, &updated_fees);

        // Update global stats
        Self::update_global_stats(&env, 0, 0, 0, total_fees)?;

        let event = FeesCollectedEvent {
            pool_id,
            total_fees,
            timestamp: current_time,
        };
        env.events().publish((symbol_short!("fees"),), event);

        Ok(())
    }

    // Gas optimization helpers

    fn update_global_stats(
        env: &Env, 
        tvl_delta: i128, 
        pools_delta: u32, 
        providers_delta: u32, 
        fees_delta: i128
    ) -> Result<(), LiquidityError> {
        let mut stats: GlobalLiquidityStats = env.storage().instance()
            .get(&DataKey::GlobalStats)
            .unwrap_or_default();

        stats.total_value_locked = stats.total_value_locked.saturating_add(tvl_delta);
        stats.total_pools = stats.total_pools.saturating_add(pools_delta);
        stats.total_lp_providers = stats.total_lp_providers.saturating_add(providers_delta);
        stats.total_fees_collected = stats.total_fees_collected.saturating_add(fees_delta);
        stats.last_update = env.ledger().timestamp();

        env.storage().instance().set(&DataKey::GlobalStats, &stats);
        Ok(())
    }

    fn calculate_lp_tokens(amount_a: i128, amount_b: i128, existing_liquidity: i128) -> i128 {
        if existing_liquidity == 0 {
            // Initial liquidity: geometric mean
            Self::integer_sqrt(amount_a.saturating_mul(amount_b))
        } else {
            // Subsequent liquidity: maintain ratio
            amount_a.min(amount_b) // Simplified for gas optimization
        }
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

    // Gas-optimized getters
    pub fn get_pool(env: Env, pool_id: Bytes) -> Option<LiquidityPool> {
        env.storage().instance().get(&DataKey::Pool(pool_id))
    }

    pub fn get_user_lp_position(env: Env, user: Address, pool_id: Bytes) -> Option<LPPosition> {
        env.storage().persistent().get(&DataKey::UserLPPosition(user, pool_id))
    }

    pub fn get_user_pools(env: Env, user: Address) -> Vec<Bytes> {
        env.storage().persistent().get(&DataKey::UserPools(user)).unwrap_or(Vec::new(&env))
    }

    pub fn get_pool_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::PoolCount).unwrap_or(0)
    }

    pub fn get_global_stats(env: Env) -> Option<GlobalLiquidityStats> {
        env.storage().instance().get(&DataKey::GlobalStats)
    }

    pub fn get_daily_fees(env: Env, pool_id: Bytes, day: u64) -> i128 {
        env.storage().instance().get(&DataKey::FeesCollected(pool_id, day)).unwrap_or(0)
    }

    pub fn get_config(env: &Env) -> Result<LiquidityConfig, LiquidityError> {
        env.storage().instance()
            .get(&DataKey::Config)
            .ok_or(LiquidityError::NotInitialized)
    }

    // Admin functions
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
        
        Ok(())
    }

    pub fn toggle_pool(
        env: Env,
        admin: Address,
        pool_id: Bytes,
        active: bool,
    ) -> Result<(), LiquidityError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(LiquidityError::Unauthorized);
        }

        let mut pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id.clone()))
            .ok_or(LiquidityError::PoolNotFound)?;

        pool.active = active;
        env.storage().instance().set(&DataKey::Pool(pool_id), &pool);
        
        Ok(())
    }

    pub fn update_pool_fee_rate(
        env: Env,
        admin: Address,
        pool_id: Bytes,
        new_fee_rate: i128,
    ) -> Result<(), LiquidityError> {
        admin.require_auth();

        let config = Self::get_config(&env)?;
        
        if config.admin != admin {
            return Err(LiquidityError::Unauthorized);
        }

        if new_fee_rate > 1000 { // Max 10%
            return Err(LiquidityError::InvalidFeeRate);
        }

        let mut pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id.clone()))
            .ok_or(LiquidityError::PoolNotFound)?;

        pool.fee_rate = new_fee_rate;
        env.storage().instance().set(&DataKey::Pool(pool_id), &pool);
        
        Ok(())
    }

    // Calculate user's share of pool fees (for reward estimation)
    pub fn calculate_user_fee_share(
        env: Env,
        user: Address,
        pool_id: Bytes,
    ) -> Result<i128, LiquidityError> {
        let position: LPPosition = env.storage().persistent()
            .get(&DataKey::UserLPPosition(user, pool_id.clone()))
            .ok_or(LiquidityError::PositionNotFound)?;

        let pool: LiquidityPool = env.storage().instance()
            .get(&DataKey::Pool(pool_id))
            .ok_or(LiquidityError::PoolNotFound)?;

        if pool.total_liquidity == 0 {
            return Ok(0);
        }

        // User's percentage of the pool
        let user_percentage = (position.lp_amount * 10000) / pool.total_liquidity; // basis points
        Ok(user_percentage)
    }
}

// Default implementations for gas optimization
impl Default for GlobalLiquidityStats {
    fn default() -> Self {
        Self {
            total_value_locked: 0,
            total_pools: 0,
            total_lp_providers: 0,
            total_fees_collected: 0,
            last_update: 0,
        }
    }
} 