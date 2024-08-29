## Deploy Soroban Contract

To deploy the Soroban contract to the Stellar public network, use the following command:

```bash
soroban contract deploy \
  --wasm src/soroban-contracts/soroban_token_contract.wasm \
  --source samuel \
  --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
  --network-passphrase 'Public Global Stellar Network ; September 2015'
```

```bash
soroban contract invoke \
    --id CCQC3ZLMLDWV5OVNJDKKE65TEWEALV4EIJN6SK5DOFDBOBR724TYIIKL \
    --source-account samuel \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --network-passphrase 'Public Global Stellar Network ; September 2015'
    -- initialize \
    --admin GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V \
    --decimal 7 \
    --name "Demo Token" \
    --symbol "DT"
```

```bash
soroban contract invoke \
    --id CCQC3ZLMLDWV5OVNJDKKE65TEWEALV4EIJN6SK5DOFDBOBR724TYIIKL \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --network-passphrase 'Public Global Stellar Network ; September 2015' \
    --function name
```

```bash
soroban contract invoke \
    --id CCQC3ZLMLDWV5OVNJDKKE65TEWEALV4EIJN6SK5DOFDBOBR724TYIIKL \
    --source-account samuel \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --network-passphrase 'Public Global Stellar Network ; September 2015' \
    -- mint \
    --to GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V \
    --amount 1000000000
```

```bash
soroban contract invoke \
    --id CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA \
    --source-account samuel \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --network-passphrase 'Public Global Stellar Network ; September 2015' \
    -- balance \
    --id GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V
```

```js
stellar contract bindings typescript \
  --network testnet \
  --contract-id $(cat .stellar/contract-ids/hello_world.txt) \
  --output-dir packages/hello_world
```

```bash
stellar contract asset deploy \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --source-account samuel \
    --network-passphrase 'Public Global Stellar Network ; September 2015' \
    --asset WHLAQUA:GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V
```

```bash
stellar contract id asset \
    --source-account samuel \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --network-passphrase 'Public Global Stellar Network ; September 2015' \
    --asset AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA
```

```bash
soroban contract info interface \
    --wasm ./src/soroban-contracts/soroban_token_contract.wasm
    --source-account samuel \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --network-passphrase 'Public Global Stellar Network ; September 2015' \
    --id CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA \
```

```bash
soroban contract invoke \
    --id CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK \
    --source-account samuel \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --network-passphrase 'Public Global Stellar Network ; September 2015'
    -- share_id  \
    --sim-only
```

<!-- Commands:
  pool_type
  get_info
  get_pool
  share_id
  get_total_shares
  get_reserves
  deposit
  swap
  estimate_swap
  withdraw
  get_liquidity
  get_liquidity_calculator
  set_liquidity_calculator
  version
  upgrade
  init_admin
  set_token_hash
  set_pool_hash
  set_stableswap_pool_hash
  configure_init_pool_payment
  get_init_pool_payment_token
  get_init_pool_payment_address
  get_stable_pool_payment_amount
  get_standard_pool_payment_amount
  set_reward_token
  get_rewards_config
  get_tokens_for_reward
  get_total_liquidity
  config_global_rewards
  fill_liquidity
  config_pool_rewards
  get_rewards_info
  get_user_reward
  get_total_accumulated_reward
  get_total_configured_reward
  get_total_claimed_reward
  get_total_outstanding_reward
  distribute_outstanding_reward
  claim
  init_standard_pool
  init_stableswap_pool
  get_pools
  remove_pool
  get_tokens_sets_count
  get_tokens
  get_pools_for_tokens_range
  set_pools_plane
  get_plane
  set_swap_router
  get_swap_router
  estimate_swap_routed
  swap_chained
  help               -->

GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V - public key
GDMFFHVJQZSDXM4SRU2W6KFLWV62BKXNNJVC4GT25NMQK2LENFUVO44I - second public key
