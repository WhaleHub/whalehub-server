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
    --id CCQC3ZLMLDWV5OVNJDKKE65TEWEALV4EIJN6SK5DOFDBOBR724TYIIKL \
    --source-account samuel \
    --rpc-url https://mainnet.stellar.validationcloud.io/v1/UaLIvjCBwsYqlBvH0IZkwkyBIYTndtRlEe2hTRtnjH4 \
    --network-passphrase 'Public Global Stellar Network ; September 2015' \
    -- balance \
    --id GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V
```

GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V - public key
GDMFFHVJQZSDXM4SRU2W6KFLWV62BKXNNJVC4GT25NMQK2LENFUVO44I - second public key
