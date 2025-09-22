#!/bin/bash

# Whalehub Contract Testing Script
echo "WHALEHUB CONTRACT TESTING"
echo "============================"

# Set variables
export STAKING_CONTRACT="CCTOX3DR5EGTYSH3CH74YPHNBQ2BBYKQTUVV5NPPXJGGCAIF277BBHIX"
export GOVERNANCE_CONTRACT="CASNQHCB75PEZU5BX2BZK3SN4WKE3UAPSJPM6WAR7DLPLDBUMZFUHOBA"
export TESTER="GBOX4KT2M23EIF5YXADVXFEEIWYFIRSDY3WG2KHUKPI4AAFHX3FRQ6KI"

echo "Testing Staking Contract Functions:"
echo "======================================"

echo "1️⃣ Global State:"
soroban contract invoke --id $STAKING_CONTRACT --source fresh-deployer --network testnet -- get_global_state

echo -e "\n2️⃣ User Lock Count:"
soroban contract invoke --id $STAKING_CONTRACT --source fresh-deployer --network testnet -- get_user_lock_count --user $TESTER

echo -e "\n3️⃣ Lock Details:"
soroban contract invoke --id $STAKING_CONTRACT --source fresh-deployer --network testnet -- get_user_lock_by_index --user $TESTER --index 0

echo -e "\n4️⃣ POL State:"
soroban contract invoke --id $STAKING_CONTRACT --source fresh-deployer --network testnet -- get_protocol_owned_liquidity

echo -e "\n🗳️ Testing Governance Contract:"
echo "================================"

echo "5️⃣ Voting Power:"
soroban contract invoke --id $GOVERNANCE_CONTRACT --source fresh-deployer --network testnet -- get_voting_power --user $TESTER

echo -e "\n✅ Testing Complete!"
echo "Explorer Links:"
echo "Staking: https://testnet.stellarexpert.io/contract/$STAKING_CONTRACT"
echo "Governance: https://testnet.stellarexpert.io/contract/$GOVERNANCE_CONTRACT"
