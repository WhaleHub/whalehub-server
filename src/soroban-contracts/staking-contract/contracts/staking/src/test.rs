#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger, LedgerInfo}, vec, Env};

fn create_test_contract() -> (Env, Address, StakingContractClient<'static>) {
    let env = Env::default();
    let contract_id = env.register_contract(None, StakingContract);
    let client = StakingContractClient::new(&env, &contract_id);
    (env, contract_id, client)
}

fn setup_test_config(env: &Env) -> (Address, Address, Address) {
    let admin = Address::generate(env);
    let aqua_token = Address::generate(env);
    let blub_token = Address::generate(env);
    (admin, aqua_token, blub_token)
}

#[test]
fn test_initialize() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    
    let lock_periods = vec![&env, 86400u64, 604800u64, 2592000u64]; // 1 day, 1 week, 1 month
    let reward_multipliers = vec![&env, 10000i128, 12000i128, 15000i128]; // 1x, 1.2x, 1.5x
    
    env.mock_all_auths();
    
    let result = client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128, // min stake: 0.1 AQUA (7 decimals)
        &1000i128,      // 10% annual rate (1000 basis points)
        &lock_periods,
        &reward_multipliers,
    );
    
    assert_eq!(result, Ok(()));
    
    // Test config is stored correctly
    let config = client.get_config().unwrap();
    assert_eq!(config.admin, admin);
    assert_eq!(config.aqua_token, aqua_token);
    assert_eq!(config.blub_token, blub_token);
    assert_eq!(config.min_stake_amount, 1_000_000i128);
    assert_eq!(config.base_reward_rate, 1000i128);
    assert_eq!(config.emergency_pause, false);
}

#[test]
fn test_initialize_twice_fails() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    
    let lock_periods = vec![&env, 86400u64];
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // First initialization should succeed
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    // Second initialization should fail
    let result = client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    );
    
    assert_eq!(result, Err(Ok(StakingError::AlreadyInitialized)));
}

#[test]
fn test_stake_success() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64, 604800u64];
    let reward_multipliers = vec![&env, 10000i128, 12000i128];
    
    env.mock_all_auths();
    
    // Initialize contract
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    // Stake tokens
    let stake_amount = 10_000_000i128; // 1 AQUA
    let lock_period = 86400u64; // 1 day
    
    let result = client.stake(&user, &stake_amount, &lock_period);
    assert_eq!(result, Ok(()));
    
    // Check stake was recorded
    let stake_info = client.get_stake_balance(&user).unwrap();
    assert_eq!(stake_info.amount, stake_amount);
    assert_eq!(stake_info.lock_period, lock_period);
    assert_eq!(stake_info.reward_multiplier, 10000i128);
    
    // Check total staked
    assert_eq!(client.get_total_staked(), stake_amount);
}

#[test]
fn test_stake_insufficient_amount() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64];
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // Initialize contract
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128, // min stake: 0.1 AQUA
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    // Try to stake less than minimum
    let result = client.stake(&user, &500_000i128, &86400u64);
    assert_eq!(result, Err(Ok(StakingError::InsufficientAmount)));
}

#[test]
fn test_stake_invalid_lock_period() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64];
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // Initialize contract
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    // Try to stake with invalid lock period
    let result = client.stake(&user, &10_000_000i128, &999999u64);
    assert_eq!(result, Err(Ok(StakingError::InvalidLockPeriod)));
}

#[test]
fn test_unstake_before_lock_expires() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64]; // 1 day
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // Initialize and stake
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    client.stake(&user, &10_000_000i128, &86400u64).unwrap();
    
    // Try to unstake immediately (should fail)
    let result = client.unstake(&user);
    assert_eq!(result, Err(Ok(StakingError::LockPeriodNotExpired)));
}

#[test]
fn test_unstake_after_lock_expires() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64]; // 1 day
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // Initialize and stake
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    let stake_amount = 10_000_000i128;
    client.stake(&user, &stake_amount, &86400u64).unwrap();
    
    // Advance time past lock period
    env.ledger().with_mut(|li| {
        li.timestamp = 86400 + 1; // 1 day + 1 second
    });
    
    // Should be able to unstake now
    let result = client.unstake(&user);
    assert!(result.is_ok());
    let total_return = result.unwrap();
    
    // Should get back at least the original amount (plus any rewards)
    assert!(total_return >= stake_amount);
    
    // Stake should be removed
    assert!(client.get_stake_balance(&user).is_none());
    
    // Total staked should be reduced
    assert_eq!(client.get_total_staked(), 0);
}

#[test]
fn test_restake() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64, 604800u64]; // 1 day, 1 week
    let reward_multipliers = vec![&env, 10000i128, 12000i128]; // 1x, 1.2x
    
    env.mock_all_auths();
    
    // Initialize and stake
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    let initial_amount = 10_000_000i128;
    client.stake(&user, &initial_amount, &86400u64).unwrap();
    
    // Advance time to accumulate some rewards
    env.ledger().with_mut(|li| {
        li.timestamp = 43200; // 12 hours
    });
    
    // Restake with longer lock period
    let result = client.restake(&user, &604800u64);
    assert_eq!(result, Ok(()));
    
    // Check that stake amount increased (rewards compounded)
    let stake_info = client.get_stake_balance(&user).unwrap();
    assert!(stake_info.amount >= initial_amount);
    assert_eq!(stake_info.lock_period, 604800u64);
    assert_eq!(stake_info.reward_multiplier, 12000i128);
}

#[test]
fn test_calculate_rewards() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64];
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // Initialize and stake
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128, // 10% annual rate
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    client.stake(&user, &10_000_000i128, &86400u64).unwrap();
    
    // Advance time
    env.ledger().with_mut(|li| {
        li.timestamp = 86400; // 1 day
    });
    
    // Calculate rewards
    let rewards = client.calculate_rewards(&user);
    assert!(rewards.is_ok());
    
    // Should have some rewards (though small for 1 day)
    let reward_amount = rewards.unwrap();
    assert!(reward_amount >= 0);
}

#[test]
fn test_emergency_pause() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64];
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // Initialize contract
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    // Pause the contract
    client.set_emergency_pause(&admin, &true).unwrap();
    
    // Verify config updated
    let config = client.get_config().unwrap();
    assert_eq!(config.emergency_pause, true);
    
    // Try to stake while paused (should fail)
    let result = client.stake(&user, &10_000_000i128, &86400u64);
    assert_eq!(result, Err(Ok(StakingError::ContractPaused)));
    
    // Unpause and try again
    client.set_emergency_pause(&admin, &false).unwrap();
    let result = client.stake(&user, &10_000_000i128, &86400u64);
    assert_eq!(result, Ok(()));
}

#[test]
fn test_update_reward_rate() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    
    let lock_periods = vec![&env, 86400u64];
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // Initialize contract
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128, // 10% initial rate
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    // Update reward rate
    let new_rate = 1500i128; // 15%
    client.update_reward_rate(&admin, &new_rate).unwrap();
    
    // Verify config updated
    let config = client.get_config().unwrap();
    assert_eq!(config.base_reward_rate, new_rate);
}

#[test]
fn test_unauthorized_admin_functions() {
    let (env, _contract_id, client) = create_test_contract();
    let (admin, aqua_token, blub_token) = setup_test_config(&env);
    let unauthorized_user = Address::generate(&env);
    
    let lock_periods = vec![&env, 86400u64];
    let reward_multipliers = vec![&env, 10000i128];
    
    env.mock_all_auths();
    
    // Initialize contract
    client.initialize(
        &admin,
        &aqua_token,
        &blub_token,
        &1_000_000i128,
        &1000i128,
        &lock_periods,
        &reward_multipliers,
    ).unwrap();
    
    // Try to pause with unauthorized user
    let result = client.set_emergency_pause(&unauthorized_user, &true);
    assert_eq!(result, Err(Ok(StakingError::Unauthorized)));
    
    // Try to update reward rate with unauthorized user
    let result = client.update_reward_rate(&unauthorized_user, &2000i128);
    assert_eq!(result, Err(Ok(StakingError::Unauthorized)));
} 