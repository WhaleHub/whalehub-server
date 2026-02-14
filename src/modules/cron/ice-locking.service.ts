import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  Networks,
} from '@stellar/stellar-sdk';

// Max fee for transactions (1 XLM in stroops for reliability)
const MAX_FEE = '1000000';

/**
 * ICE Locking Cron Service
 *
 * Runs daily at 2 AM UTC to:
 * 1. Authorize ICE lock in staking contract
 * 2. Transfer AQUA from contract to admin wallet
 * 3. Create claimable balance on Stellar Classic for Aquarius to detect
 * 4. Wait for Aquarius to mint 4 ICE token types
 * 5. Transfer ICE tokens to staking contract
 * 6. Sync contract's ICE balances
 */
@Injectable()
export class IceLockingService {
  private readonly logger = new Logger(IceLockingService.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly horizonServer: StellarSdk.Horizon.Server;
  private readonly adminKeypair: Keypair;
  private readonly stakingContractId: string;
  private readonly aquaAsset: Asset;

  // ICE token contract addresses (SAC wrapped)
  private readonly iceTokenId: string;
  private readonly governIceTokenId: string;
  private readonly upvoteIceTokenId: string;
  private readonly downvoteIceTokenId: string;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_URL');
    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL');

    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl);
    this.horizonServer = new StellarSdk.Horizon.Server(horizonUrl);

    const adminSecret = this.configService.get<string>('ADMIN_SECRET_KEY');
    this.adminKeypair = Keypair.fromSecret(adminSecret);

    this.stakingContractId = this.configService.get<string>(
      'STAKING_CONTRACT_ID',
    );

    // AQUA asset (Stellar Classic)
    const aquaIssuer = this.configService.get<string>('AQUA_ISSUER');
    this.aquaAsset = new Asset('AQUA', aquaIssuer);

    // ICE token SAC addresses
    this.iceTokenId = this.configService.get<string>('ICE_TOKEN_ID');
    this.governIceTokenId = this.configService.get<string>(
      'GOVERN_ICE_TOKEN_ID',
    );
    this.upvoteIceTokenId = this.configService.get<string>(
      'UPVOTE_ICE_TOKEN_ID',
    );
    this.downvoteIceTokenId = this.configService.get<string>(
      'DOWNVOTE_ICE_TOKEN_ID',
    );
  }

  /**
   * Runs daily at 2:00 AM UTC
   * Can be manually triggered via endpoint if needed
   */
  @Cron(CronExpression.EVERY_10_SECONDS, {
    name: 'ice-locking-daily',
    timeZone: 'UTC',
  })
  async handleDailyIceLocking() {
    this.logger.log('Starting daily ICE locking process...');

    try {
      // STEP 1: Get pending AQUA amount
      const pendingAqua = await this.getPendingAquaForIce();

      if (pendingAqua <= 0) {
        this.logger.log('No pending AQUA for ICE locking. Skipping...');
        return;
      }

      this.logger.log(`Pending AQUA for ICE: ${pendingAqua}`);

      // STEP 2: Authorize ICE lock (3 years for maximum ICE)
      const lockId = await this.authorizeIceLock(pendingAqua, 3);
      this.logger.log(`ICE lock authorized with ID: ${lockId}`);

      // STEP 3: Transfer AQUA from contract to admin
      await this.transferAuthorizedAqua(lockId);
      this.logger.log(`AQUA transferred to admin wallet`);

      // STEP 4: Create claimable balance on Stellar Classic
      await this.createClaimableBalance(pendingAqua, 3);
      this.logger.log(`Claimable balance created for Aquarius`);

      // STEP 5: Wait for Aquarius to process and mint ICE tokens (polling)
      await this.waitForIceTokens();
      this.logger.log(`ICE tokens received`);

      // NOTE: ICE tokens cannot be transferred - they are locked to the receiving account
      // ICE tokens will stay in admin wallet and be used for voting from there
      // Skip STEP 6 (transferIceTokensToContract) and STEP 7 (syncContractIceBalances)

      this.logger.log('Daily ICE locking process completed successfully!');
      this.logger.log('ICE tokens are now in admin wallet for voting');
    } catch (error) {
      this.logger.error(`ICE locking failed: ${error.message}`, error.stack);
      // TODO: Send alert/notification to admin
    }
  }

  /**
   * Query pending AQUA available for ICE locking
   */
  private async getPendingAquaForIce(): Promise<number> {
    const contract = new StellarSdk.Contract(this.stakingContractId);
    const operation = contract.call('get_pending_aqua_for_ice');

    const result = await this.simulateTransaction(operation);
    const scVal = StellarSdk.scValToNative(result.result.retval);

    return Number(scVal) / 1e7; // Convert from stroop to AQUA
  }

  /**
   * Authorize ICE lock in staking contract
   */
  private async authorizeIceLock(
    aquaAmount: number,
    durationYears: number,
    maxRetries = 3,
  ): Promise<number> {
    const contract = new StellarSdk.Contract(this.stakingContractId);

    const aquaAmountI128 = StellarSdk.nativeToScVal(
      Math.floor(aquaAmount * 1e7),
      { type: 'i128' },
    );
    const duration = StellarSdk.nativeToScVal(durationYears, { type: 'u64' });

    const operation = contract.call(
      'authorize_ice_lock',
      aquaAmountI128,
      duration,
    );

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const tx = await this.buildAndSignTransaction(operation);
        const response = await this.server.sendTransaction(tx);

        // Wait for confirmation
        const confirmed = await this.pollTransactionStatus(response.hash);

        // Extract lock_id from result
        // If returnValue is missing (XDR parse error), query contract for latest lock_id
        if (confirmed.returnValue) {
          const lockId = Number(
            StellarSdk.scValToNative(confirmed.returnValue),
          );
          return lockId;
        } else {
          // Fallback: query contract state to get latest lock_id
          this.logger.warn(
            'returnValue missing, querying contract for lock_id',
          );
          const lockId = await this.getLatestLockId();
          return lockId;
        }
      } catch (error) {
        const isTimeout = error.message?.includes('timeout');
        if (isTimeout && attempt < maxRetries) {
          this.logger.warn(
            `authorizeIceLock timeout, retrying (${attempt}/${maxRetries})...`,
          );
          await this.sleep(3000);
          continue;
        }
        throw error;
      }
    }

    throw new Error('authorizeIceLock failed after max retries');
  }

  /**
   * Query contract for the latest ICE lock ID
   */
  private async getLatestLockId(): Promise<number> {
    const contract = new StellarSdk.Contract(this.stakingContractId);
    const operation = contract.call('get_global_state');

    const result = await this.simulateTransaction(operation);
    const state = StellarSdk.scValToNative(result.result.retval);

    // ice_lock_counter is incremented after creating lock, so latest lock_id = counter - 1
    const lockId = Number(state.ice_lock_counter || state.ice_lock_counter) - 1;
    return lockId >= 0 ? lockId : 0;
  }

  /**
   * Transfer authorized AQUA from contract to admin wallet
   */
  private async transferAuthorizedAqua(
    lockId: number,
    maxRetries = 3,
  ): Promise<void> {
    const contract = new StellarSdk.Contract(this.stakingContractId);
    const lockIdU64 = StellarSdk.nativeToScVal(lockId, { type: 'u64' });

    const operation = contract.call('transfer_authorized_aqua', lockIdU64);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const tx = await this.buildAndSignTransaction(operation);
        const response = await this.server.sendTransaction(tx);

        await this.pollTransactionStatus(response.hash);
        return;
      } catch (error) {
        const isTimeout = error.message?.includes('timeout');
        if (isTimeout && attempt < maxRetries) {
          this.logger.warn(
            `transferAuthorizedAqua timeout, retrying (${attempt}/${maxRetries})...`,
          );
          await this.sleep(3000);
          continue;
        }
        throw error;
      }
    }

    throw new Error('transferAuthorizedAqua failed after max retries');
  }

  /**
   * Create claimable balance on Stellar Classic for Aquarius to detect
   * Formula: ICE = AQUA × (duration_years / 3) × 10
   */
  private async createClaimableBalance(
    aquaAmount: number,
    durationYears: number,
  ): Promise<void> {
    const account = await this.horizonServer.loadAccount(
      this.adminKeypair.publicKey(),
    );

    // Calculate unlock time (duration_years from now)
    const unlockTime =
      Math.floor(Date.now() / 1000) + durationYears * 365 * 24 * 60 * 60;

    // Create claimable balance operation
    const claimant = new StellarSdk.Claimant(
      this.adminKeypair.publicKey(),
      StellarSdk.Claimant.predicateNot(
        StellarSdk.Claimant.predicateBeforeAbsoluteTime(unlockTime.toString()),
      ),
    );

    const transaction = new TransactionBuilder(account, {
      fee: MAX_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(
        Operation.createClaimableBalance({
          asset: this.aquaAsset,
          amount: aquaAmount.toFixed(7),
          claimants: [claimant],
        }),
      )
      .setTimeout(180)
      .build();

    transaction.sign(this.adminKeypair);

    const response = await this.horizonServer.submitTransaction(transaction);
    this.logger.log(`Claimable balance created: ${response.hash}`);
  }

  /**
   * Wait for Aquarius to detect claimable balance and mint ICE tokens
   * Polls admin wallet balance for ICE tokens
   */
  private async waitForIceTokens(
    maxAttempts = 60,
    intervalMs = 60000,
  ): Promise<void> {
    this.logger.log('Waiting for Aquarius to mint ICE tokens...');

    for (let i = 0; i < maxAttempts; i++) {
      const iceBalance = await this.getTokenBalance(
        this.iceTokenId,
        this.adminKeypair.publicKey(),
      );

      if (iceBalance > 0) {
        this.logger.log(`ICE tokens detected: ${iceBalance}`);
        return;
      }

      this.logger.log(
        `Attempt ${i + 1}/${maxAttempts}: No ICE tokens yet, waiting...`,
      );
      await this.sleep(intervalMs);
    }

    throw new Error('Timeout waiting for ICE tokens from Aquarius');
  }

  /**
   * Transfer all 4 ICE token types from admin to staking contract
   */
  private async transferIceTokensToContract(): Promise<void> {
    // stakingContractId is already a C... address string
    const contractAddress = this.stakingContractId;

    const tokens = [
      { id: this.iceTokenId, name: 'ICE' },
      { id: this.governIceTokenId, name: 'governICE' },
      { id: this.upvoteIceTokenId, name: 'upvoteICE' },
      { id: this.downvoteIceTokenId, name: 'downvoteICE' },
    ];

    for (const token of tokens) {
      const balance = await this.getTokenBalance(
        token.id,
        this.adminKeypair.publicKey(),
      );

      if (balance > 0) {
        await this.transferToken(token.id, contractAddress.toString(), balance);
        this.logger.log(`Transferred ${balance} ${token.name} to contract`);
      } else {
        this.logger.warn(`No ${token.name} balance to transfer`);
      }
    }
  }

  /**
   * Sync contract's ICE token balances
   */
  private async syncContractIceBalances(maxRetries = 3): Promise<void> {
    const contract = new StellarSdk.Contract(this.stakingContractId);
    const operation = contract.call('sync_all_ice_balances');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const tx = await this.buildAndSignTransaction(operation);
        const response = await this.server.sendTransaction(tx);

        await this.pollTransactionStatus(response.hash);
        return;
      } catch (error) {
        const isTimeout = error.message?.includes('timeout');
        if (isTimeout && attempt < maxRetries) {
          this.logger.warn(
            `syncContractIceBalances timeout, retrying (${attempt}/${maxRetries})...`,
          );
          await this.sleep(3000);
          continue;
        }
        throw error;
      }
    }

    throw new Error('syncContractIceBalances failed after max retries');
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private async simulateTransaction(
    operation: StellarSdk.xdr.Operation,
  ): Promise<any> {
    const account = await this.server.getAccount(this.adminKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: MAX_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(operation)
      .setTimeout(180)
      .build();

    const simulated = await this.server.simulateTransaction(tx);

    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulated)) {
      throw new Error(`Simulation failed: ${simulated.error}`);
    }

    return simulated;
  }

  private async buildAndSignTransaction(
    operation: StellarSdk.xdr.Operation,
  ): Promise<StellarSdk.Transaction> {
    const account = await this.server.getAccount(this.adminKeypair.publicKey());

    let tx = new TransactionBuilder(account, {
      fee: MAX_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(operation)
      .setTimeout(180)
      .build();

    // Simulate to get auth and resource fees
    const simulated = await this.server.simulateTransaction(tx);

    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulated)) {
      throw new Error(`Simulation failed: ${simulated.error}`);
    }

    tx = StellarSdk.SorobanRpc.assembleTransaction(tx, simulated).build();
    tx.sign(this.adminKeypair);

    return tx;
  }

  private async pollTransactionStatus(
    hash: string,
    maxAttempts = 30,
  ): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await this.server.getTransaction(hash);

        if (status.status === 'SUCCESS') {
          return status;
        }

        if (status.status === 'FAILED') {
          throw new Error(`Transaction failed: ${hash}`);
        }

        await this.sleep(2000);
      } catch (error) {
        // Handle "Bad union switch: 4" - transaction succeeded but SDK can't parse response
        if (error.message?.includes('Bad union switch')) {
          this.logger.warn(
            `XDR parse error (Bad union switch) for ${hash}, assuming success`,
          );
          return { status: 'SUCCESS', hash };
        }
        throw error;
      }
    }

    throw new Error(`Transaction timeout: ${hash}`);
  }

  private async getTokenBalance(
    tokenId: string,
    address: string,
  ): Promise<number> {
    const contract = new StellarSdk.Contract(tokenId);
    const addressScVal = StellarSdk.nativeToScVal(address, { type: 'address' });

    const operation = contract.call('balance', addressScVal);

    try {
      const result = await this.simulateTransaction(operation);
      const balance = StellarSdk.scValToNative(result.result.retval);
      return Number(balance) / 1e7;
    } catch (error) {
      this.logger.warn(
        `Failed to get balance for ${tokenId}: ${error.message}`,
      );
      return 0;
    }
  }

  private async transferToken(
    tokenId: string,
    toAddress: string,
    amount: number,
    maxRetries = 3,
  ): Promise<void> {
    const contract = new StellarSdk.Contract(tokenId);

    const from = StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
      type: 'address',
    });
    const to = StellarSdk.nativeToScVal(toAddress, { type: 'address' });
    const amountI128 = StellarSdk.nativeToScVal(Math.floor(amount * 1e7), {
      type: 'i128',
    });

    const operation = contract.call('transfer', from, to, amountI128);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const tx = await this.buildAndSignTransaction(operation);
        const response = await this.server.sendTransaction(tx);

        await this.pollTransactionStatus(response.hash);
        return;
      } catch (error) {
        const isTimeout = error.message?.includes('timeout');
        if (isTimeout && attempt < maxRetries) {
          this.logger.warn(
            `transferToken timeout, retrying (${attempt}/${maxRetries})...`,
          );
          await this.sleep(3000);
          continue;
        }
        throw error;
      }
    }

    throw new Error('transferToken failed after max retries');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
