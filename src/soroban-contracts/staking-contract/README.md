# WhaleHub Soroban Staking Contracts

## Overview

This workspace contains four interconnected Soroban smart contracts that implement a comprehensive staking, rewards, and governance system for the WhaleHub protocol. The contracts are designed to replace the current database-driven staking system with a fully decentralized on-chain solution.

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  StakingContract│────│  RewardContract  │────│LiquidityContract│
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
                    ┌──────────────────┐
                    │GovernanceContract│
                    └──────────────────┘
```

## Contracts

### 1. Staking Contract (`contracts/staking/`)

**Purpose**: Core staking functionality for AQUA → BLUB conversion with lock periods and rewards.

**Key Features**:
- Stake AQUA tokens with configurable lock periods
- Automatic reward calculation based on time and multipliers
- Restaking with compound rewards
- Emergency pause functionality
- Multiple lock period options with different reward multipliers

**Main Functions**:
- `initialize()` - Set up contract with admin and parameters
- `stake()` - Stake AQUA tokens for specified lock period
- `unstake()` - Withdraw staked tokens after lock period expires
- `restake()` - Compound rewards and extend lock period
- `calculate_rewards()` - View pending rewards
- `get_stake_balance()` - View user's stake information

### 2. Rewards Contract (`contracts/rewards/`)

**Purpose**: Manages reward distribution and claiming across all staking activities.

**Key Features**:
- Centralized reward pool management
- Time-based reward distribution
- User-specific reward tracking
- Minimum claim thresholds
- Cross-contract reward coordination

**Main Functions**:
- `initialize()` - Set up reward system
- `fund_rewards()` - Add tokens to reward pool (admin)
- `claim_rewards()` - Claim accumulated rewards
- `update_user_reward()` - Update user rewards (called by staking contract)
- `get_claimable_rewards()` - View claimable reward amount

### 3. Liquidity Contract (`contracts/liquidity/`)

**Purpose**: Handles LP token staking and liquidity pool management.

**Key Features**:
- Create and manage liquidity pools
- LP token staking with lock periods
- Automated liquidity calculations
- Pool-specific reward multipliers
- Slippage protection

**Main Functions**:
- `initialize()` - Set up liquidity system
- `create_pool()` - Create new trading pair pool
- `add_liquidity()` - Add liquidity to existing pool
- `stake_lp()` - Stake LP tokens for rewards
- `unstake_lp()` - Unstake LP tokens after lock period
- `remove_liquidity()` - Remove liquidity from pool

### 4. Governance Contract (`contracts/governance/`)

**Purpose**: Decentralized governance for protocol parameters and upgrades.

**Key Features**:
- Proposal creation and voting
- Voting power based on staked amounts
- Time-locked proposal execution
- Quorum and passing thresholds
- Emergency admin controls

**Main Functions**:
- `initialize()` - Set up governance system
- `create_proposal()` - Create new governance proposal
- `vote()` - Vote on active proposals
- `execute_proposal()` - Execute passed proposals
- `update_voting_power()` - Update user's voting power

## Data Structures

### StakeInfo
```rust
pub struct StakeInfo {
    pub amount: i128,              // Staked amount
    pub timestamp: u64,            // Stake creation time
    pub lock_period: u64,          // Lock duration in seconds
    pub reward_multiplier: i128,   // Reward multiplier (basis points)
}
```

### RewardPool
```rust
pub struct RewardPool {
    pub total_rewards: i128,       // Total rewards available
    pub distributed_rewards: i128, // Already distributed
    pub last_distribution: u64,    // Last distribution timestamp
    pub distribution_rate: i128,   // Rewards per second
}
```

### LiquidityPool
```rust
pub struct LiquidityPool {
    pub token_a: Address,          // First token address
    pub token_b: Address,          // Second token address
    pub total_liquidity: i128,     // Total LP tokens
    pub reserve_a: i128,           // Reserve of token A
    pub reserve_b: i128,           // Reserve of token B
    pub fee_rate: i128,           // Fee rate (basis points)
    pub created_at: u64,          // Pool creation time
}
```

## Configuration

### Lock Periods and Multipliers
- **1 day (86400s)**: 1.0x multiplier (10000 basis points)
- **1 week (604800s)**: 1.2x multiplier (12000 basis points)
- **1 month (2592000s)**: 1.5x multiplier (15000 basis points)

### Governance Parameters
- **Voting Period**: 7 days (configurable)
- **Execution Delay**: 2 days (configurable)
- **Quorum Threshold**: 10% of total voting power
- **Pass Threshold**: 51% of votes cast
- **Proposal Cooldown**: 1 day per user

## Events

All contracts emit comprehensive events for off-chain monitoring:

- `StakeEvent` - When tokens are staked
- `UnstakeEvent` - When tokens are unstaked
- `RestakeEvent` - When stake is compounded
- `RewardClaimedEvent` - When rewards are claimed
- `PoolCreatedEvent` - When liquidity pool is created
- `ProposalCreatedEvent` - When governance proposal is created
- `VoteCastEvent` - When vote is cast

## Security Features

1. **Access Control**: Admin-only functions with proper authorization
2. **Emergency Pause**: All contracts can be paused in emergencies
3. **Overflow Protection**: Safe math operations throughout
4. **Input Validation**: Comprehensive parameter validation
5. **Reentrancy Protection**: State updates before external calls
6. **Time Lock**: Governance proposals have execution delays

## Testing

Each contract includes comprehensive test suites covering:
- Happy path scenarios
- Edge cases and error conditions
- Access control and authorization
- State transitions
- Mathematical calculations
- Event emissions

Run tests with:
```bash
make test                    # All tests
make test-staking           # Staking contract only
make test-rewards           # Rewards contract only
make test-liquidity         # Liquidity contract only
make test-governance        # Governance contract only
```

## Deployment

### Prerequisites
1. Soroban CLI installed and configured
2. Stellar accounts set up for admin and deployment
3. Network configurations (testnet/mainnet)

### Build and Deploy
```bash
# Build all contracts
make build

# Deploy to testnet
make deploy-testnet

# Initialize contracts
STAKING_CONTRACT_ID=<contract_id> \
ADMIN_ADDRESS=<admin_address> \
AQUA_TOKEN_ADDRESS=<aqua_address> \
BLUB_TOKEN_ADDRESS=<blub_address> \
make init-testnet
```

### Frontend Integration
```bash
# Generate TypeScript bindings
make generate-bindings
```

## Migration Strategy

The migration from the current database-driven system to Soroban contracts will follow this timeline:

### Week 1: Foundation ✅
- [x] Contract architecture design
- [x] Core data structures and storage design
- [x] Basic contract implementations
- [x] Initial test suites

### Week 2: Core Logic (Next)
- [ ] Complete staking/unstaking/restaking logic
- [ ] Reward calculation and distribution
- [ ] Comprehensive testing
- [ ] Gas optimization

### Week 3: Advanced Features
- [ ] Liquidity pool integration
- [ ] Governance system
- [ ] Cross-contract interactions
- [ ] Event system

### Week 4: Backend Integration
- [ ] Enhanced SorobanService
- [ ] Database migration scripts
- [ ] API endpoint updates
- [ ] Hybrid mode support

### Week 5: Frontend & Deployment
- [ ] Frontend component updates
- [ ] TypeScript integration
- [ ] End-to-end testing
- [ ] Production deployment

## Contract Addresses

### Testnet
- Staking Contract: `TBD`
- Rewards Contract: `TBD`
- Liquidity Contract: `TBD`
- Governance Contract: `TBD`

### Mainnet
- Staking Contract: `TBD`
- Rewards Contract: `TBD`
- Liquidity Contract: `TBD`
- Governance Contract: `TBD`

## Gas Optimization

The contracts are optimized for minimal gas usage:
- Efficient storage patterns
- Batch operations where possible
- Minimal external calls
- Optimized mathematical operations

## Audit Status

- [ ] Internal security review
- [ ] External security audit
- [ ] Formal verification
- [ ] Bug bounty program

## Contributing

1. Follow Rust and Soroban best practices
2. Add comprehensive tests for new features
3. Update documentation for any changes
4. Run `make check` before submitting PRs

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For questions and support:
- GitHub Issues: [Create an issue](https://github.com/whalehub/issues)
- Documentation: [Full docs](https://docs.whalehub.io)
- Discord: [Join our community](https://discord.gg/whalehub)