#![no_std]
use soroban_sdk::{contracttype, Address, String, Vec};

/// Shared data types used across all WhaleHub contracts
/// This ensures type consistency and enables proper cross-contract integration

// ============================================================================
// Core Business Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StakeType {
    Standard,
    Compound,
    Governance,
    Liquidity,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RewardPoolType {
    Staking,
    Liquidity,
    Governance,
    Bonus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PoolType {
    ConstantProduct,
    Stableswap,
    Weighted,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Failed,
    Executed,
    Cancelled,
}

// ============================================================================
// Cross-Contract Communication Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CrossContractCall {
    pub target_contract: Address,
    pub function_name: String,
    pub parameters: Vec<u8>,
    pub caller_contract: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStakeUpdate {
    pub user: Address,
    pub old_amount: i128,
    pub new_amount: i128,
    pub stake_type: StakeType,
    pub multiplier: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardUpdate {
    pub user: Address,
    pub pool_type: RewardPoolType,
    pub amount_change: i128,
    pub new_multiplier: i128,
    pub operation_type: String, // "stake", "unstake", "claim", "compound"
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VotingPowerUpdate {
    pub user: Address,
    pub old_power: i128,
    pub new_power: i128,
    pub reason: String,
    pub timestamp: u64,
}

// ============================================================================
// Financial Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenAmount {
    pub token_address: Address,
    pub amount: i128,
    pub decimals: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityPair {
    pub token_a: Address,
    pub token_b: Address,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub lp_token_supply: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeStructure {
    pub trading_fee: i128,        // In basis points
    pub protocol_fee: i128,       // In basis points
    pub performance_fee: i128,    // In basis points
    pub early_withdrawal_fee: i128, // In basis points
}

// ============================================================================
// User Data Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserProfile {
    pub address: Address,
    pub tier: String,
    pub total_staked: i128,
    pub total_rewards_earned: i128,
    pub total_liquidity_provided: i128,
    pub governance_participation: u32,
    pub joined_timestamp: u64,
    pub last_activity: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardSummary {
    pub staking_rewards: i128,
    pub liquidity_rewards: i128,
    pub governance_rewards: i128,
    pub bonus_rewards: i128,
    pub total_claimable: i128,
    pub total_claimed: i128,
}

// ============================================================================
// System Configuration Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SystemConfig {
    pub admin: Address,
    pub emergency_pause: bool,
    pub version: u32,
    pub last_update: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractAddresses {
    pub staking_contract: Address,
    pub rewards_contract: Address,
    pub liquidity_contract: Address,
    pub governance_contract: Address,
    pub aqua_token: Address,
    pub blub_token: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalLimits {
    pub max_stake_per_user: i128,
    pub min_stake_amount: i128,
    pub max_claim_per_tx: i128,
    pub min_claim_amount: i128,
    pub max_proposal_duration: u64,
    pub min_lock_period: u64,
    pub max_lock_period: u64,
}

// ============================================================================
// Analytics and Metrics Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SystemMetrics {
    pub total_value_locked: i128,
    pub total_users: u32,
    pub total_transactions: u64,
    pub average_stake_size: i128,
    pub total_rewards_distributed: i128,
    pub active_proposals: u32,
    pub last_updated: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolMetrics {
    pub pool_id: u64,
    pub tvl: i128,
    pub volume_24h: i128,
    pub fees_24h: i128,
    pub apr: i128,
    pub liquidity_providers: u32,
    pub last_updated: u64,
}

// ============================================================================
// Error Types for Cross-Contract Operations
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SharedError {
    InvalidContractAddress = 1,
    UnauthorizedCrossContractCall = 2,
    InvalidTokenAmount = 3,
    InsufficientBalance = 4,
    InvalidUserAddress = 5,
    ContractPaused = 6,
    NumericOverflow = 7,
    InvalidTimestamp = 8,
    DataSerializationError = 9,
    ContractVersionMismatch = 10,
}

// ============================================================================
// Event Types for Cross-Contract Monitoring
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CrossContractEvent {
    pub source_contract: Address,
    pub target_contract: Address,
    pub event_type: String,
    pub user_address: Address,
    pub amount: i128,
    pub timestamp: u64,
    pub success: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SystemStateChange {
    pub parameter_name: String,
    pub old_value: String,
    pub new_value: String,
    pub changed_by: Address,
    pub timestamp: u64,
    pub reason: String,
}

// ============================================================================
// Time-related Types
// ============================================================================

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimeRange {
    pub start_time: u64,
    pub end_time: u64,
    pub duration: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledAction {
    pub action_id: u64,
    pub target_contract: Address,
    pub function_name: String,
    pub parameters: Vec<u8>,
    pub scheduled_time: u64,
    pub executed: bool,
    pub created_by: Address,
}

// ============================================================================
// Utility Functions for Type Conversion and Validation
// ============================================================================

/// Convert basis points to percentage
pub fn basis_points_to_percentage(basis_points: i128) -> i128 {
    basis_points / 100
}

/// Convert percentage to basis points
pub fn percentage_to_basis_points(percentage: i128) -> i128 {
    percentage * 100
}

/// Validate that an amount is positive
pub fn validate_positive_amount(amount: i128) -> bool {
    amount > 0
}

/// Validate that a percentage is within valid range (0-100%)
pub fn validate_percentage(percentage: i128) -> bool {
    percentage >= 0 && percentage <= 10000 // 10000 basis points = 100%
}

/// Calculate time difference in days
pub fn time_diff_in_days(start_time: u64, end_time: u64) -> u64 {
    if end_time <= start_time {
        return 0;
    }
    (end_time - start_time) / 86400 // 86400 seconds in a day
}

/// Validate address is not zero address
pub fn validate_address(address: &Address) -> bool {
    // In a real implementation, we would check against the zero address
    // For now, we assume all addresses are valid
    true
}

// ============================================================================
// Constants
// ============================================================================

/// Basis points representing 100% (10000 basis points = 100%)
pub const MAX_BASIS_POINTS: i128 = 10000;

/// Seconds in a day
pub const SECONDS_PER_DAY: u64 = 86400;

/// Seconds in a year (365 days)
pub const SECONDS_PER_YEAR: u64 = 365 * SECONDS_PER_DAY;

/// Maximum reasonable lock period (5 years)
pub const MAX_LOCK_PERIOD: u64 = 5 * SECONDS_PER_YEAR;

/// Minimum lock period (1 day)
pub const MIN_LOCK_PERIOD: u64 = SECONDS_PER_DAY;

/// Maximum reasonable reward rate (1000% APY)
pub const MAX_REWARD_RATE: i128 = 100000; // 1000% in basis points

/// Precision factor for calculations (7 decimals)
pub const PRECISION_FACTOR: i128 = 10_000_000;

// ============================================================================
// Default Implementations
// ============================================================================

impl Default for FeeStructure {
    fn default() -> Self {
        Self {
            trading_fee: 30,     // 0.3%
            protocol_fee: 5,     // 0.05%
            performance_fee: 200, // 2%
            early_withdrawal_fee: 500, // 5%
        }
    }
}

impl Default for GlobalLimits {
    fn default() -> Self {
        Self {
            max_stake_per_user: 1_000_000_0000000, // 1M tokens
            min_stake_amount: 100_0000000,         // 100 tokens
            max_claim_per_tx: 100_000_0000000,     // 100K tokens
            min_claim_amount: 1_0000000,           // 1 token
            max_proposal_duration: 7 * SECONDS_PER_DAY, // 7 days
            min_lock_period: MIN_LOCK_PERIOD,
            max_lock_period: MAX_LOCK_PERIOD,
        }
    }
}

impl Default for SystemMetrics {
    fn default() -> Self {
        Self {
            total_value_locked: 0,
            total_users: 0,
            total_transactions: 0,
            average_stake_size: 0,
            total_rewards_distributed: 0,
            active_proposals: 0,
            last_updated: 0,
        }
    }
} 