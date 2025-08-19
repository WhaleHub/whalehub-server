import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { TokenEntity } from '@/utils/typeorm/entities/token.entity';
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { LpBalanceEntity } from '@/utils/typeorm/entities/lp-balances.entity';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';
import { RewardClaimsEntity } from '@/utils/typeorm/entities/claimRecords.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';

export const typeOrmConfig = async (
  configService: ConfigService,
): Promise<TypeOrmModuleOptions> => {
  const nodeEnv = configService.get<string>('NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';

  const host = configService.get<string>('POSTGRES_HOST') || '127.0.0.1';
  const port = Number(configService.get<string>('POSTGRES_PORT') ?? 5432);
  const username = configService.get<string>('POSTGRES_USER');
  const password = configService.get<string>('POSTGRES_PASSWORD');
  const database = configService.get<string>('POSTGRES_DATABASE');

  // Fail fast if critical envs are missing
  for (const [k, v] of Object.entries({ host, port, username, password, database })) {
    if (v === undefined || v === null || v === '') {
      throw new Error(`Missing database config: ${k}`);
    }
  }

  const base: TypeOrmModuleOptions = {
    type: 'postgres',
    host,
    port,
    username,
    password,
    database,
    entities: [
      UserEntity,
      TokenEntity,
      PoolsEntity,
      LpBalanceEntity,
      ClaimableRecordsEntity,
      RewardClaimsEntity,
      StakeEntity,
    ],
    synchronize: !isProduction,
    logging: nodeEnv === 'development',

    // Retries (TypeORM supports these on initial connection)
    retryAttempts: 3,
    retryDelay: 3000,

    // Let TypeORM pick up entities from feature modules (optional if you list entities)
    autoLoadEntities: true,

    // Log slow queries
    maxQueryExecutionTime: 25_000,

    // Cache in DB (table will be auto-created)
    cache: {
      type: 'database',
      tableName: 'query_result_cache',
      duration: 30_000,
    },

    // Pool config – pg uses `extra` for pool options
    extra: {
      max: 25,                    // max clients in pool
      min: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 30_000,
      statement_timeout: 25_000,  // server-side statement timeout
      query_timeout: 25_000,      // client-side
      application_name: 'whalehub-server',
      keepAlive: true,
      keepAliveInitialDelayMillis: 0,
      ssl: isProduction ? { rejectUnauthorized: false } : false,
    },
  };

  return base;
};