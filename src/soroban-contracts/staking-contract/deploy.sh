#!/bin/bash

# WhaleHub Soroban Contracts Deployment Script
# Usage: ./deploy.sh [testnet|mainnet]

set -e

NETWORK=${1:-testnet}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🚀 Deploying WhaleHub Soroban Contracts to $NETWORK"
echo "=================================================="

# Configuration
ADMIN_SECRET="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"  # Replace with actual secret
ADMIN_ADDRESS="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"  # Replace with actual address

# Token addresses (replace with actual addresses)
AQUA_TOKEN_ADDRESS="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQAHHAGCN4YD"
BLUB_TOKEN_ADDRESS="CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

# Contract parameters
MIN_STAKE_AMOUNT=1000000  # 0.1 AQUA (7 decimals)
BASE_REWARD_RATE=1000     # 10% annual (1000 basis points)
MIN_LIQUIDITY=1000000     # 0.1 tokens minimum
DEFAULT_FEE_RATE=30       # 0.3% (30 basis points)

# Governance parameters
VOTING_PERIOD=604800      # 7 days
EXECUTION_DELAY=172800    # 2 days
QUORUM_THRESHOLD=1000     # 10%
PASS_THRESHOLD=5100       # 51%
MIN_PROPOSAL_POWER=1000000 # 0.1 tokens

# Build contracts
echo "📦 Building contracts..."
cargo build --release --target wasm32-unknown-unknown

# Optimize WASM files
echo "⚡ Optimizing WASM files..."
soroban contract optimize --wasm target/wasm32-unknown-unknown/release/staking_contract.wasm
soroban contract optimize --wasm target/wasm32-unknown-unknown/release/rewards_contract.wasm
soroban contract optimize --wasm target/wasm32-unknown-unknown/release/liquidity_contract.wasm
soroban contract optimize --wasm target/wasm32-unknown-unknown/release/governance_contract.wasm

# Deploy contracts
echo "🚢 Deploying contracts to $NETWORK..."

echo "Deploying Staking Contract..."
STAKING_CONTRACT_ID=$(soroban contract deploy \
    --wasm target/wasm32-unknown-unknown/release/staking_contract.wasm \
    --source-account admin \
    --network $NETWORK 2>&1 | grep -o 'C[A-Z0-9]\{55\}')

echo "Deploying Rewards Contract..."
REWARDS_CONTRACT_ID=$(soroban contract deploy \
    --wasm target/wasm32-unknown-unknown/release/rewards_contract.wasm \
    --source-account admin \
    --network $NETWORK 2>&1 | grep -o 'C[A-Z0-9]\{55\}')

echo "Deploying Liquidity Contract..."
LIQUIDITY_CONTRACT_ID=$(soroban contract deploy \
    --wasm target/wasm32-unknown-unknown/release/liquidity_contract.wasm \
    --source-account admin \
    --network $NETWORK 2>&1 | grep -o 'C[A-Z0-9]\{55\}')

echo "Deploying Governance Contract..."
GOVERNANCE_CONTRACT_ID=$(soroban contract deploy \
    --wasm target/wasm32-unknown-unknown/release/governance_contract.wasm \
    --source-account admin \
    --network $NETWORK 2>&1 | grep -o 'C[A-Z0-9]\{55\}')

# Initialize contracts
echo "⚙️  Initializing contracts..."

echo "Initializing Staking Contract..."
soroban contract invoke \
    --id $STAKING_CONTRACT_ID \
    --source-account admin \
    --network $NETWORK \
    -- initialize \
    --admin $ADMIN_ADDRESS \
    --aqua_token $AQUA_TOKEN_ADDRESS \
    --blub_token $BLUB_TOKEN_ADDRESS \
    --min_stake_amount $MIN_STAKE_AMOUNT \
    --base_reward_rate $BASE_REWARD_RATE \
    --lock_periods '[86400, 604800, 2592000]' \
    --reward_multipliers '[10000, 12000, 15000]'

echo "Initializing Rewards Contract..."
soroban contract invoke \
    --id $REWARDS_CONTRACT_ID \
    --source-account admin \
    --network $NETWORK \
    -- initialize \
    --admin $ADMIN_ADDRESS \
    --staking_contract $STAKING_CONTRACT_ID \
    --reward_token $BLUB_TOKEN_ADDRESS \
    --distribution_period 604800 \
    --min_claim_amount 1000000

echo "Initializing Liquidity Contract..."
soroban contract invoke \
    --id $LIQUIDITY_CONTRACT_ID \
    --source-account admin \
    --network $NETWORK \
    -- initialize \
    --admin $ADMIN_ADDRESS \
    --staking_contract $STAKING_CONTRACT_ID \
    --rewards_contract $REWARDS_CONTRACT_ID \
    --min_liquidity $MIN_LIQUIDITY \
    --default_fee_rate $DEFAULT_FEE_RATE

echo "Initializing Governance Contract..."
soroban contract invoke \
    --id $GOVERNANCE_CONTRACT_ID \
    --source-account admin \
    --network $NETWORK \
    -- initialize \
    --admin $ADMIN_ADDRESS \
    --staking_contract $STAKING_CONTRACT_ID \
    --rewards_contract $REWARDS_CONTRACT_ID \
    --liquidity_contract $LIQUIDITY_CONTRACT_ID \
    --voting_period $VOTING_PERIOD \
    --execution_delay $EXECUTION_DELAY \
    --quorum_threshold $QUORUM_THRESHOLD \
    --pass_threshold $PASS_THRESHOLD \
    --min_proposal_power $MIN_PROPOSAL_POWER

# Save contract addresses
echo "💾 Saving contract addresses..."
cat > deployed_contracts_${NETWORK}.json << EOF
{
  "network": "$NETWORK",
  "deployed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "contracts": {
    "staking": "$STAKING_CONTRACT_ID",
    "rewards": "$REWARDS_CONTRACT_ID",
    "liquidity": "$LIQUIDITY_CONTRACT_ID",
    "governance": "$GOVERNANCE_CONTRACT_ID"
  },
  "tokens": {
    "aqua": "$AQUA_TOKEN_ADDRESS",
    "blub": "$BLUB_TOKEN_ADDRESS"
  },
  "admin": "$ADMIN_ADDRESS"
}
EOF

# Generate TypeScript bindings
echo "📝 Generating TypeScript bindings..."
mkdir -p ../../../jewel-swap/src/contracts/{staking,rewards,liquidity,governance}

soroban contract bindings typescript \
    --wasm target/wasm32-unknown-unknown/release/staking_contract.wasm \
    --contract-id $STAKING_CONTRACT_ID \
    --output-dir ../../../jewel-swap/src/contracts/staking \
    --network $NETWORK

soroban contract bindings typescript \
    --wasm target/wasm32-unknown-unknown/release/rewards_contract.wasm \
    --contract-id $REWARDS_CONTRACT_ID \
    --output-dir ../../../jewel-swap/src/contracts/rewards \
    --network $NETWORK

soroban contract bindings typescript \
    --wasm target/wasm32-unknown-unknown/release/liquidity_contract.wasm \
    --contract-id $LIQUIDITY_CONTRACT_ID \
    --output-dir ../../../jewel-swap/src/contracts/liquidity \
    --network $NETWORK

soroban contract bindings typescript \
    --wasm target/wasm32-unknown-unknown/release/governance_contract.wasm \
    --contract-id $GOVERNANCE_CONTRACT_ID \
    --output-dir ../../../jewel-swap/src/contracts/governance \
    --network $NETWORK

# Create environment configuration
echo "🔧 Creating environment configuration..."
cat > ../../../jewel-swap/src/contracts/config.ts << EOF
// Auto-generated contract configuration
export const CONTRACTS = {
  STAKING: '$STAKING_CONTRACT_ID',
  REWARDS: '$REWARDS_CONTRACT_ID',
  LIQUIDITY: '$LIQUIDITY_CONTRACT_ID',
  GOVERNANCE: '$GOVERNANCE_CONTRACT_ID',
} as const;

export const TOKENS = {
  AQUA: '$AQUA_TOKEN_ADDRESS',
  BLUB: '$BLUB_TOKEN_ADDRESS',
} as const;

export const NETWORK = '$NETWORK';
export const ADMIN = '$ADMIN_ADDRESS';
EOF

echo ""
echo "✅ Deployment completed successfully!"
echo ""
echo "📋 Contract Addresses:"
echo "   Staking:    $STAKING_CONTRACT_ID"
echo "   Rewards:    $REWARDS_CONTRACT_ID"
echo "   Liquidity:  $LIQUIDITY_CONTRACT_ID"
echo "   Governance: $GOVERNANCE_CONTRACT_ID"
echo ""
echo "📁 Files created:"
echo "   - deployed_contracts_${NETWORK}.json"
echo "   - ../../../jewel-swap/src/contracts/config.ts"
echo "   - TypeScript bindings in ../../../jewel-swap/src/contracts/"
echo ""
echo "🔗 Next steps:"
echo "   1. Update your frontend to use the new contract addresses"
echo "   2. Fund the rewards contract with initial rewards"
echo "   3. Test all functionality on $NETWORK"
echo "   4. Monitor contract events and gas usage"
echo ""

if [ "$NETWORK" = "mainnet" ]; then
    echo "⚠️  MAINNET DEPLOYMENT COMPLETED"
    echo "   Please verify all functionality before announcing to users"
    echo "   Consider running a bug bounty program"
fi 