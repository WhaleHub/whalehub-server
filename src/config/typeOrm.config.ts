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
  const nodeEnv = configService.get<string>('NODE_ENV');
  const isProduction = nodeEnv === 'production';

  const base: TypeOrmModuleOptions = {
    type: 'postgres',
    host: configService.get<string>('DATABASE_HOST'),
    port: parseInt(configService.get<string>('DATABASE_PORT') || '5432') || 5432,
    username: configService.get<string>('DATABASE_USERNAME'),
    password: configService.get<string>('DATABASE_PASSWORD'),
    database: configService.get<string>('DATABASE_NAME'),
    entities: [
      UserEntity,
      TokenEntity,
      PoolsEntity,
      LpBalanceEntity,
      ClaimableRecordsEntity,
      RewardClaimsEntity,
      StakeEntity,
    ],
    synchronize: nodeEnv !== 'production',
    logging: nodeEnv === 'development',

    // Connection retry settings
    retryAttempts: 3,
    retryDelay: 3000, // 3 seconds between retries
    
    // Auto load entities
    autoLoadEntities: true,
    
    // Connection name for multiple connections
    name: 'default',
    
    // Connection options for better performance
    maxQueryExecutionTime: 25000, // Log slow queries over 25 seconds
    
    // Pool settings specifically for heavy queries
    poolSize: 60, // Maximum active connections
    
    // Cache settings
    cache: {
      type: 'database',
      tableName: 'query_result_cache',
      duration: 30000,
    },
  } as TypeOrmModuleOptions;

  // Add Postgres-specific extras only when using Postgres
  (base as any).extra = {
    max: 25,
    min: 5,
    idle: 10000,
    evict: 1000,
    acquire: 60000,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    query_timeout: 25000,
    statement_timeout: 25000,
    application_name: 'whalehub-server',
    keepAlive: true,
    keepAliveInitialDelayMillis: 0,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    options: [
      '-c', 'random_page_cost=1.1',
      '-c', 'effective_cache_size=1GB',
      '-c', 'shared_preload_libraries=pg_stat_statements',
      '-c', 'max_connections=1000',
      '-c', 'work_mem=32MB',
      '-c', 'maintenance_work_mem=256MB',
      '-c', 'effective_io_concurrency=200',
    ].join(' '),
  };

  return base;
};
