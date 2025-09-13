#![no_std]
use soroban_sdk::contracttype;

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

// ============================================================================
// Utility Functions
// ============================================================================

/// Validate that an amount is positive
pub fn validate_positive_amount(amount: i128) -> bool {
    amount > 0
}

/// Convert basis points to percentage
pub fn basis_points_to_percentage(basis_points: i128) -> i128 {
    basis_points / 100
}

/// Convert percentage to basis points
pub fn percentage_to_basis_points(percentage: i128) -> i128 {
    percentage * 100
}

/// Validate that a percentage is within valid range (0-100%)
pub fn validate_percentage(percentage: i128) -> bool {
    percentage >= 0 && percentage <= 10000 // 10000 basis points = 100%
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