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
  return {
    type: 'postgres',
    host: configService.get<string>('DATABASE_HOST'),
    port: parseInt(configService.get<string>('DATABASE_PORT')) || 5432,
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
    synchronize: configService.get<string>('NODE_ENV') !== 'production',
    logging: configService.get<string>('NODE_ENV') === 'development',
    
    // Optimized connection pool settings to prevent 502 errors
    extra: {
      // Connection pool settings
      max: 25, // Increased from default 10
      min: 5,  // Minimum connections in pool
      idle: 10000, // Close connections after 10 seconds of inactivity
      evict: 1000, // Check for idle connections every 1 second
      acquire: 60000, // Maximum time to get connection (60 seconds)
      
      // Connection timeout settings
      connectionTimeoutMillis: 30000, // 30 seconds to establish connection
      idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
      query_timeout: 25000, // 25 second query timeout (less than our app timeout)
      statement_timeout: 25000, // PostgreSQL statement timeout
      
      // Performance optimizations
      application_name: 'whalehub-server',
      
      // Connection stability
      keepAlive: true,
      keepAliveInitialDelayMillis: 0,
      
      // SSL settings for production
      ssl: configService.get<string>('NODE_ENV') === 'production' ? {
        rejectUnauthorized: false // For Render.com and similar platforms
      } : false,
      
      // Query optimization
      options: [
        // Faster query planning
        '-c', 'random_page_cost=1.1',
        '-c', 'effective_cache_size=1GB',
        '-c', 'shared_preload_libraries=pg_stat_statements',
        '-c', 'max_connections=100',
        '-c', 'work_mem=32MB',
        '-c', 'maintenance_work_mem=256MB',
        '-c', 'effective_io_concurrency=200'
      ].join(' ')
    },
    
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
    poolSize: 25, // Maximum active connections
    
    // Cache settings
    cache: {
      type: 'database',
      tableName: 'query_result_cache',
      duration: 30000 // Cache for 30 seconds
    }
  };
};
