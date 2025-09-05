# Soroban Staking Contracts Makefile

.PHONY: build test clean deploy-testnet deploy-mainnet

# Build all contracts
build:
	@echo "Building all contracts..."
	cargo build --release --target wasm32-unknown-unknown
	@echo "Optimizing WASM files..."
	soroban contract optimize --wasm target/wasm32-unknown-unknown/release/staking_contract.wasm
	soroban contract optimize --wasm target/wasm32-unknown-unknown/release/rewards_contract.wasm
	soroban contract optimize --wasm target/wasm32-unknown-unknown/release/liquidity_contract.wasm
	soroban contract optimize --wasm target/wasm32-unknown-unknown/release/governance_contract.wasm

# Test all contracts
test:
	@echo "Running tests for all contracts..."
	cargo test

# Test individual contracts
test-staking:
	cargo test --package staking-contract

test-rewards:
	cargo test --package rewards-contract

test-liquidity:
	cargo test --package liquidity-contract

test-governance:
	cargo test --package governance-contract

# Clean build artifacts
clean:
	cargo clean
	rm -rf target/

# Deploy to testnet
deploy-testnet:
	@echo "Deploying to Stellar testnet..."
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/staking_contract.wasm \
		--source-account admin \
		--network testnet
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/rewards_contract.wasm \
		--source-account admin \
		--network testnet
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/liquidity_contract.wasm \
		--source-account admin \
		--network testnet
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/governance_contract.wasm \
		--source-account admin \
		--network testnet

# Deploy to mainnet (use with caution)
deploy-mainnet:
	@echo "Deploying to Stellar mainnet..."
	@echo "WARNING: This will deploy to mainnet. Are you sure? (y/N)"
	@read confirm && [ "$$confirm" = "y" ] || exit 1
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/staking_contract.wasm \
		--source-account admin \
		--network mainnet
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/rewards_contract.wasm \
		--source-account admin \
		--network mainnet
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/liquidity_contract.wasm \
		--source-account admin \
		--network mainnet
	soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/governance_contract.wasm \
		--source-account admin \
		--network mainnet

# Initialize contracts on testnet
init-testnet:
	@echo "Initializing contracts on testnet..."
	soroban contract invoke \
		--id $(STAKING_CONTRACT_ID) \
		--source-account admin \
		--network testnet \
		-- initialize \
		--admin $(ADMIN_ADDRESS) \
		--aqua_token $(AQUA_TOKEN_ADDRESS) \
		--blub_token $(BLUB_TOKEN_ADDRESS) \
		--min_stake_amount 1000000 \
		--base_reward_rate 1000 \
		--lock_periods '[86400, 604800, 2592000]' \
		--reward_multipliers '[10000, 12000, 15000]'

# Generate bindings for frontend
generate-bindings:
	@echo "Generating TypeScript bindings..."
	soroban contract bindings typescript \
		--wasm target/wasm32-unknown-unknown/release/staking_contract.wasm \
		--output-dir ../../../jewel-swap/src/contracts/staking
	soroban contract bindings typescript \
		--wasm target/wasm32-unknown-unknown/release/rewards_contract.wasm \
		--output-dir ../../../jewel-swap/src/contracts/rewards
	soroban contract bindings typescript \
		--wasm target/wasm32-unknown-unknown/release/liquidity_contract.wasm \
		--output-dir ../../../jewel-swap/src/contracts/liquidity
	soroban contract bindings typescript \
		--wasm target/wasm32-unknown-unknown/release/governance_contract.wasm \
		--output-dir ../../../jewel-swap/src/contracts/governance

# Format code
fmt:
	cargo fmt

# Run clippy linter
lint:
	cargo clippy -- -D warnings

# Run security audit
audit:
	cargo audit

# Full check (format, lint, test)
check: fmt lint test
	@echo "All checks passed!"

# Help
help:
	@echo "Available commands:"
	@echo "  build              - Build all contracts"
	@echo "  test               - Run all tests"
	@echo "  test-<contract>    - Run tests for specific contract"
	@echo "  clean              - Clean build artifacts"
	@echo "  deploy-testnet     - Deploy to testnet"
	@echo "  deploy-mainnet     - Deploy to mainnet (with confirmation)"
	@echo "  init-testnet       - Initialize contracts on testnet"
	@echo "  generate-bindings  - Generate TypeScript bindings"
	@echo "  fmt                - Format code"
	@echo "  lint               - Run linter"
	@echo "  audit              - Run security audit"
	@echo "  check              - Run format, lint, and test"
	@echo "  help               - Show this help" 