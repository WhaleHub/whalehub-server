import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
  Claimant,
} from '@stellar/stellar-sdk';

// Use max fee to avoid transaction failures during network congestion
const MAX_FEE = '1000000'; // 0.1 XLM max fee

/**
 * Voting Cron Service
 *
 * Periodically votes for pools using upvoteICE tokens from admin wallet.
 *
 * IMPORTANT: ICE tokens are NON-TRANSFERABLE!
 * - ICE tokens stay in the admin wallet (received from ICE locking)
 * - Admin wallet directly votes using upvoteICE
 * - No transfer from contract to admin needed
 *
 * According to Aquarius documentation:
 * - Voting uses Stellar Classic claimable balances (NOT Soroban contracts)
 * - upvoteICE tokens are sent as claimable balances to voting wallets
 * - Voting wallets are locked and represent specific market pairs
 * - Minimum voting period is 1 hour for ICE tokens
 *
 * @see https://docs.aqua.network/technical-documents/the-aquarius-voting-mechanism
 * @see https://docs.aqua.network/ice/ice-tokens-locking-aqua-and-getting-benefits
 *
 * Process:
 * 1. Get upvoteICE balance from admin wallet (Stellar Classic)
 * 2. Create claimable balance with upvoteICE to voting wallet
 */
@Injectable()
export class VotingService {
  private readonly logger = new Logger(VotingService.name);
  private readonly sorobanServer: StellarSdk.SorobanRpc.Server;
  private readonly horizonServer: StellarSdk.Horizon.Server;
  private readonly adminKeypair: Keypair;

  // upvoteICE asset on Stellar Classic
  private readonly upvoteIceAsset: Asset;

  // Voting wallet addresses for different pools
  // These are Aquarius voting wallets for specific market pairs
  private readonly votingWallets: Map<string, string> = new Map();

  // Voting duration in seconds (default 7 days)
  private readonly votingDurationSeconds: number;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_URL');
    const horizonUrl =
      this.configService.get<string>('STELLAR_HORIZON_URL') ||
      'https://horizon.stellar.org';

    this.sorobanServer = new StellarSdk.SorobanRpc.Server(rpcUrl);
    this.horizonServer = new StellarSdk.Horizon.Server(horizonUrl);

    const adminSecret = this.configService.get<string>('ADMIN_SECRET_KEY');
    this.adminKeypair = Keypair.fromSecret(adminSecret);

    // upvoteICE asset configuration
    // upvoteICE is issued by Aquarius
    const upvoteIceIssuer = this.configService.get<string>('UPVOTE_ICE_ISSUER');
    if (
      upvoteIceIssuer &&
      upvoteIceIssuer.length === 56 &&
      upvoteIceIssuer.startsWith('G')
    ) {
      this.upvoteIceAsset = new Asset('upvoteICE', upvoteIceIssuer);
    } else {
      this.logger.warn(
        'UPVOTE_ICE_ISSUER not configured or invalid. Voting disabled.',
      );
    }

    // Load voting wallet configurations
    // Format: VOTING_WALLET_AQUA_BLUB=G...
    this.loadVotingWallets();

    // Voting duration (default 7 days = 604800 seconds)
    this.votingDurationSeconds =
      this.configService.get<number>('VOTING_DURATION_SECONDS') || 604800;
  }

  /**
   * Load voting wallet addresses from environment variables
   */
  private loadVotingWallets(): void {
    // AQUA-BLUB pool
    const aquaBlubWallet = this.configService.get<string>(
      'VOTING_WALLET_AQUA_BLUB',
    );
    if (aquaBlubWallet) {
      this.votingWallets.set('AQUA_BLUB', aquaBlubWallet);
    }

    // Add more pools as needed
    // const xlmUsdcWallet = this.configService.get<string>('VOTING_WALLET_XLM_USDC');
    // if (xlmUsdcWallet) this.votingWallets.set('XLM_USDC', xlmUsdcWallet);

    this.logger.log(
      `Loaded ${this.votingWallets.size} voting wallet configurations`,
    );
  }

  /**
   * Weekly voting cron (Every Sunday at 3:00 AM UTC)
   * Can be overridden via VOTING_CRON_SCHEDULE env var
   */
  @Cron(process.env.VOTING_CRON_SCHEDULE || '0 3 * * 0', {
    name: 'pool-voting',
    timeZone: 'UTC',
  })
  async handleVoting() {
    this.logger.log('Starting pool voting process...');

    try {
      // Validate configuration
      if (!this.upvoteIceAsset) {
        this.logger.error('UPVOTE_ICE_ISSUER not configured. Skipping voting.');
        return;
      }

      if (this.votingWallets.size === 0) {
        this.logger.error('No voting wallets configured. Skipping voting.');
        return;
      }

      // STEP 1: Get upvoteICE balance from admin wallet
      const upvoteIceBalance = await this.getAdminUpvoteIceBalance();
      this.logger.log(
        `Admin upvoteICE balance: ${upvoteIceBalance.toFixed(7)}`,
      );

      if (upvoteIceBalance <= 0) {
        this.logger.warn('No upvoteICE in admin wallet. Skipping voting...');
        return;
      }

      // STEP 2: Distribute votes across configured pools
      // For now, allocate 100% to AQUA_BLUB pool
      // Can be changed to split across multiple pools
      const voteAllocations = this.calculateVoteAllocations(upvoteIceBalance);

      // STEP 3: Vote for each pool
      for (const [poolName, amount] of voteAllocations) {
        const votingWallet = this.votingWallets.get(poolName);
        if (!votingWallet) {
          this.logger.warn(`No voting wallet for ${poolName}. Skipping...`);
          continue;
        }

        try {
          const txHash = await this.voteForPool(poolName, votingWallet, amount);
          this.logger.log(
            `Voted ${amount.toFixed(7)} upvoteICE for ${poolName}: ${txHash}`,
          );
        } catch (voteError) {
          this.logger.error(
            `Failed to vote for ${poolName}: ${voteError.message}`,
          );
        }
      }

      this.logger.log('Voting process completed!');
    } catch (error) {
      this.logger.error(`Voting failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Get upvoteICE balance from admin wallet (Stellar Classic)
   * ICE tokens are non-transferable, so they stay in admin wallet
   */
  private async getAdminUpvoteIceBalance(): Promise<number> {
    try {
      const account = await this.horizonServer.loadAccount(
        this.adminKeypair.publicKey(),
      );

      const upvoteIceBalance = account.balances.find(
        (b) =>
          b.asset_type !== 'native' &&
          (b as any).asset_code === 'upvoteICE' &&
          (b as any).asset_issuer === this.upvoteIceAsset.getIssuer(),
      );

      if (!upvoteIceBalance) {
        return 0;
      }

      return parseFloat(upvoteIceBalance.balance);
    } catch (error) {
      this.logger.error(`Failed to get upvoteICE balance: ${error.message}`);
      return 0;
    }
  }

  /**
   * Calculate vote allocations across pools
   * Currently allocates 100% to AQUA_BLUB, can be customized
   */
  private calculateVoteAllocations(totalBalance: number): Map<string, number> {
    const allocations = new Map<string, number>();

    // Simple allocation: 100% to AQUA_BLUB
    // Can be changed to split across multiple pools
    // Example: 70% AQUA_BLUB, 30% XLM_USDC
    if (this.votingWallets.has('AQUA_BLUB')) {
      allocations.set('AQUA_BLUB', totalBalance);
    }

    return allocations;
  }

  /**
   * Vote for a specific pool by creating a claimable balance
   *
   * According to Aquarius:
   * - Claimable balance is sent to the voting wallet
   * - Neither sender nor voting wallet can claim before voting period ends
   * - Voting wallets are locked, so only sender can reclaim after period
   */
  private async voteForPool(
    poolName: string,
    votingWallet: string,
    amount: number,
    maxRetries = 3,
  ): Promise<string> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const account = await this.horizonServer.loadAccount(
          this.adminKeypair.publicKey(),
        );

        // Calculate unlock time (voting duration from now)
        const unlockTime =
          Math.floor(Date.now() / 1000) + this.votingDurationSeconds;

        // Create claimants:
        // 1. Voting wallet - can never claim (wallet is locked)
        // 2. Admin (sender) - can claim after voting period ends
        const claimants = [
          // Voting wallet claimant (with impossible predicate - can never claim)
          new Claimant(
            votingWallet,
            Claimant.predicateNot(Claimant.predicateUnconditional()),
          ),
          // Admin claimant (can claim after voting period)
          new Claimant(
            this.adminKeypair.publicKey(),
            Claimant.predicateNot(
              Claimant.predicateBeforeAbsoluteTime(unlockTime.toString()),
            ),
          ),
        ];

        const transaction = new TransactionBuilder(account, {
          fee: MAX_FEE,
          networkPassphrase: Networks.PUBLIC,
        })
          .addOperation(
            Operation.createClaimableBalance({
              asset: this.upvoteIceAsset,
              amount: amount.toFixed(7),
              claimants: claimants,
            }),
          )
          .setTimeout(180)
          .build();

        transaction.sign(this.adminKeypair);

        const response =
          await this.horizonServer.submitTransaction(transaction);
        this.logger.log(
          `Created voting claimable balance for ${poolName}: ${response.hash}`,
        );

        return response.hash;
      } catch (error) {
        const isTimeout =
          error.message?.includes('timeout') ||
          error.message?.includes('Timeout');

        if (isTimeout && attempt < maxRetries) {
          this.logger.warn(
            `Vote attempt ${attempt} for ${poolName} timed out, retrying...`,
          );
          await this.sleep(3000);
          continue;
        }

        // Log full Horizon error
        if (error.response?.data?.extras?.result_codes) {
          this.logger.error(
            `Horizon error: ${JSON.stringify(error.response.data.extras.result_codes)}`,
          );
        }
        if (error.response?.data?.extras?.result_xdr) {
          this.logger.error(
            `Result XDR: ${error.response.data.extras.result_xdr}`,
          );
        }
        if (error.response?.data?.detail) {
          this.logger.error(`Detail: ${error.response.data.detail}`);
        }
        throw error;
      }
    }

    throw new Error(
      `Failed to vote for ${poolName} after ${maxRetries} attempts`,
    );
  }

  /**
   * Manual vote trigger for a specific pool
   */
  async manualVoteForPool(
    poolName: string,
    amount?: number,
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    this.logger.log(`Manual vote triggered for ${poolName}`);

    try {
      const votingWallet = this.votingWallets.get(poolName);
      if (!votingWallet) {
        return { success: false, error: `No voting wallet for ${poolName}` };
      }

      // Use provided amount or get full balance
      let voteAmount = amount;
      if (!voteAmount) {
        voteAmount = await this.getAdminUpvoteIceBalance();
      }

      if (voteAmount <= 0) {
        return { success: false, error: 'No upvoteICE available' };
      }

      const hash = await this.voteForPool(poolName, votingWallet, voteAmount);
      return { success: true, hash };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Manual vote trigger (votes for all configured pools)
   */
  async manualVote(): Promise<void> {
    this.logger.log('Manual voting triggered');
    await this.handleVoting();
  }

  /**
   * Reclaim upvoteICE from expired voting claimable balances
   * This can be called periodically to recover tokens after voting period ends
   */
  async reclaimExpiredVotes(): Promise<{
    reclaimedCount: number;
    reclaimedAmount: number;
  }> {
    this.logger.log('Checking for expired voting claimable balances...');

    let reclaimedCount = 0;
    let reclaimedAmount = 0;

    try {
      // Query claimable balances for admin that are claimable now
      const claimableBalances = await this.horizonServer
        .claimableBalances()
        .claimant(this.adminKeypair.publicKey())
        .asset(this.upvoteIceAsset)
        .limit(50)
        .call();

      const now = Math.floor(Date.now() / 1000);

      for (const balance of claimableBalances.records) {
        // Check if this balance is claimable now
        const isClaimable = this.isClaimableNow(balance.claimants, now);

        if (isClaimable) {
          try {
            await this.claimBalance(balance.id);
            reclaimedCount++;
            reclaimedAmount += parseFloat(balance.amount);
            this.logger.log(
              `Reclaimed claimable balance: ${balance.id} (${balance.amount} upvoteICE)`,
            );
          } catch (claimError) {
            this.logger.warn(
              `Failed to claim balance ${balance.id}: ${claimError.message}`,
            );
          }
        }
      }

      this.logger.log(
        `Reclaimed ${reclaimedCount} expired voting balances (${reclaimedAmount.toFixed(7)} upvoteICE)`,
      );
    } catch (error) {
      this.logger.error(`Failed to reclaim votes: ${error.message}`);
    }

    return { reclaimedCount, reclaimedAmount };
  }

  /**
   * Check if a claimable balance is claimable by admin now
   */
  private isClaimableNow(claimants: any[], now: number): boolean {
    const adminClaimant = claimants.find(
      (c) => c.destination === this.adminKeypair.publicKey(),
    );

    if (!adminClaimant) return false;

    // Parse the predicate to check if it's claimable
    // For our voting balances, admin can claim after the unlock time
    // The predicate is: NOT(before_absolute_time(unlock_time))
    // Which means: claimable after unlock_time
    try {
      const predicate = adminClaimant.predicate;
      if (predicate.not && predicate.not.abs_before) {
        const unlockTime = parseInt(predicate.not.abs_before, 10);
        return now >= unlockTime;
      }
    } catch {
      return false;
    }

    return false;
  }

  /**
   * Claim a claimable balance
   */
  private async claimBalance(balanceId: string, maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const account = await this.horizonServer.loadAccount(
          this.adminKeypair.publicKey(),
        );

        const transaction = new TransactionBuilder(account, {
          fee: MAX_FEE,
          networkPassphrase: Networks.PUBLIC,
        })
          .addOperation(
            Operation.claimClaimableBalance({
              balanceId: balanceId,
            }),
          )
          .setTimeout(180)
          .build();

        transaction.sign(this.adminKeypair);

        await this.horizonServer.submitTransaction(transaction);
        return;
      } catch (error) {
        const isTimeout =
          error.message?.includes('timeout') ||
          error.message?.includes('Timeout');

        if (isTimeout && attempt < maxRetries) {
          this.logger.warn(`Claim attempt ${attempt} timed out, retrying...`);
          await this.sleep(3000);
          continue;
        }

        throw error;
      }
    }
  }

  /**
   * Get voting status - current balance and active votes
   */
  async getVotingStatus(): Promise<{
    upvoteIceBalance: number;
    activeVotes: Array<{
      id: string;
      amount: string;
      unlockTime: number;
      canReclaim: boolean;
    }>;
    configuredPools: string[];
  }> {
    const upvoteIceBalance = await this.getAdminUpvoteIceBalance();

    // Get active claimable balances (votes)
    const activeVotes: Array<{
      id: string;
      amount: string;
      unlockTime: number;
      canReclaim: boolean;
    }> = [];

    try {
      const claimableBalances = await this.horizonServer
        .claimableBalances()
        .claimant(this.adminKeypair.publicKey())
        .asset(this.upvoteIceAsset)
        .limit(50)
        .call();

      const now = Math.floor(Date.now() / 1000);

      for (const balance of claimableBalances.records) {
        const adminClaimant = balance.claimants.find(
          (c) => c.destination === this.adminKeypair.publicKey(),
        );

        let unlockTime = 0;
        if (adminClaimant?.predicate?.not?.abs_before) {
          unlockTime = parseInt(adminClaimant.predicate.not.abs_before, 10);
        }

        activeVotes.push({
          id: balance.id,
          amount: balance.amount,
          unlockTime,
          canReclaim: now >= unlockTime,
        });
      }
    } catch (error) {
      this.logger.warn(`Failed to get active votes: ${error.message}`);
    }

    return {
      upvoteIceBalance,
      activeVotes,
      configuredPools: Array.from(this.votingWallets.keys()),
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
