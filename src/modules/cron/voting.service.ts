import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  Keypair,
  Networks,
  BASE_FEE,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

/**
 * Voting Cron Service
 *
 * Periodically votes for AQUA-BLUB pool using upvoteICE tokens
 * by calling Aquarius Router's config_global_rewards function.
 *
 * Period is configurable via VOTING_CRON_SCHEDULE env var
 * Default: Every 7 days at 3:00 AM UTC
 */
@Injectable()
export class VotingService {
  private readonly logger = new Logger(VotingService.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly adminKeypair: Keypair;
  private readonly stakingContractId: string;
  private readonly aquariusRouterContractId: string;
  private readonly aquaBlubPoolTokens: [string, string];
  private readonly votingShare: number; // Percentage to allocate to AQUA-BLUB pool (0-100)

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_URL');
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl);

    const adminSecret = this.configService.get<string>('ADMIN_SECRET_KEY');
    this.adminKeypair = Keypair.fromSecret(adminSecret);

    this.stakingContractId = this.configService.get<string>(
      'STAKING_CONTRACT_ID',
    );
    this.aquariusRouterContractId = this.configService.get<string>(
      'AQUARIUS_ROUTER_CONTRACT_ID',
    );

    // AQUA-BLUB pool token addresses (sorted)
    const aquaTokenId = this.configService.get<string>('AQUA_TOKEN_ID');
    const blubTokenId = this.configService.get<string>('BLUB_TOKEN_ID');

    // Sort token addresses (Aquarius requires sorted pairs)
    this.aquaBlubPoolTokens = [aquaTokenId, blubTokenId].sort() as [
      string,
      string,
    ];

    // Voting share for AQUA-BLUB pool (default 60%)
    this.votingShare =
      this.configService.get<number>('AQUA_BLUB_VOTING_SHARE') || 60;
  }

  /**
   * Configurable cron schedule via env var
   * Default: '0 3 * * 0' (Every Sunday at 3:00 AM UTC)
   *
   * Examples:
   * - Daily: '0 3 * * *'
   * - Weekly: '0 3 * * 0'
   * - Every 3 days: '0 3 *\/3 * *'
   */
  @Cron(process.env.VOTING_CRON_SCHEDULE || '0 3 * * 0', {
    name: 'aqua-blub-voting',
    timeZone: 'UTC',
  })
  async handleVoting() {
    this.logger.log('Starting AQUA-BLUB pool voting process...');

    try {
      // STEP 1: Get current upvoteICE balance
      const upvoteIceBalance = await this.getUpvoteIceBalance();
      this.logger.log(`Current upvoteICE balance: ${upvoteIceBalance}`);

      if (upvoteIceBalance <= 0) {
        this.logger.warn('No upvoteICE balance. Skipping voting...');
        return;
      }

      // STEP 2: Configure global rewards with voting shares
      await this.configureGlobalRewards();

      this.logger.log('Voting completed successfully!');
    } catch (error) {
      this.logger.error(`Voting failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Get upvoteICE balance from staking contract
   */
  private async getUpvoteIceBalance(): Promise<number> {
    const contract = new StellarSdk.Contract(this.stakingContractId);
    const operation = contract.call('get_upvote_ice_balance');

    const result = await this.simulateTransaction(operation);
    const balance = StellarSdk.scValToNative(result.result.retval);

    return Number(balance) / 1e7;
  }

  /**
   * Configure global rewards on Aquarius Router
   * Allocates voting shares to pools
   */
  private async configureGlobalRewards(): Promise<void> {
    const routerContract = new StellarSdk.Contract(
      this.aquariusRouterContractId,
    );

    // Reward tokens per second (7 decimal precision)
    // Example: 600 AQUA per second = 600_0000000
    const rewardTps =
      this.configService.get<number>('REWARD_TPS') || 600_0000000;

    // Expiration timestamp (30 days from now)
    const expiredAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    // Voting shares (7 decimal precision)
    // votingShare% to AQUA-BLUB, remaining to other pools
    const aquaBlubShare = Math.floor((this.votingShare / 100) * 1_0000000);

    // Build tokens_votes: Vec<(Vec<Address>, u32)>
    // Format: [(token_pair, voting_share)]
    const tokensVotes = [
      {
        tokens: this.aquaBlubPoolTokens,
        share: aquaBlubShare,
      },
      // Add other pools here if needed
      // For now, allocate remaining to another pool or leave it
    ];

    // Convert to ScVal
    const rewardTpsScVal = StellarSdk.nativeToScVal(rewardTps, {
      type: 'u128',
    });
    const expiredAtScVal = StellarSdk.nativeToScVal(expiredAt, { type: 'u64' });

    // Build tokens_votes ScVal
    const tokensVotesVec = tokensVotes.map((tv) => {
      const tokensVec = StellarSdk.nativeToScVal(tv.tokens, { type: 'vec' });
      const shareU32 = StellarSdk.nativeToScVal(tv.share, { type: 'u32' });

      return StellarSdk.xdr.ScVal.scvMap([
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.nativeToScVal('tokens'),
          val: tokensVec,
        }),
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.nativeToScVal('share'),
          val: shareU32,
        }),
      ]);
    });

    const tokensVotesScVal = StellarSdk.xdr.ScVal.scvVec(tokensVotesVec);

    const operation = routerContract.call(
      'config_global_rewards',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      rewardTpsScVal,
      expiredAtScVal,
      tokensVotesScVal,
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);

    // Wait for transaction confirmation
    await this.pollTransactionStatus(response.hash);

    this.logger.log(
      `Global rewards configured: ${this.votingShare}% to AQUA-BLUB pool, ` +
        `TPS: ${rewardTps}, Expires: ${new Date(expiredAt * 1000).toISOString()}`,
    );
  }

  /**
   * Manual vote trigger (can be called via endpoint if needed)
   */
  async manualVote(): Promise<void> {
    this.logger.log('Manual voting triggered by admin');
    await this.handleVoting();
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private async simulateTransaction(
    operation: StellarSdk.xdr.Operation,
  ): Promise<any> {
    const account = await this.server.getAccount(this.adminKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
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
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(operation)
      .setTimeout(180)
      .build();

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
      const status = await this.server.getTransaction(hash);

      if (status.status === 'SUCCESS') {
        return status;
      }

      if (status.status === 'FAILED') {
        throw new Error(`Transaction failed: ${hash}`);
      }

      await this.sleep(2000);
    }

    throw new Error(`Transaction timeout: ${hash}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
