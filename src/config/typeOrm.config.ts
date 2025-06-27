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
    host: configService.get<string>('POSTGRES_HOST'),
    port: configService.get<number>('POSTGRES_PORT'),
    username: configService.get<string>('POSTGRES_USER'),
    database: configService.get<string>('POSTGRES_DATABASE'),
    password: configService.get<string>('POSTGRES_PASSWORD'),
    entities: [
      UserEntity,
      StakeEntity,
      TokenEntity,
      PoolsEntity,
      LpBalanceEntity,
      RewardClaimsEntity,
      ClaimableRecordsEntity,
    ],
    migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
    extra: {
      charset: 'utf8mb4_unicode_ci',
      max: 20, // Maximum number of connections in pool
      min: 5,  // Minimum number of connections in pool
      acquireTimeoutMillis: 30000, // Connection timeout
      idleTimeoutMillis: 30000, // Idle connection timeout
      createTimeoutMillis: 30000, // Create connection timeout
    },
    synchronize:
      configService.get<string>('NODE_ENV') === 'development' ? true : true,
    autoLoadEntities: true,
    logging: false,
    ssl: configService.get<string>('NODE_ENV') === 'development' ? false : true,
    // Add memory management for large result sets
    cache: {
      duration: 30000, // 30 seconds cache
      type: 'database',
      options: {
        max: 100, // Max number of cached queries
      }
    },
    // Prevent memory leaks from long-running queries
    maxQueryExecutionTime: 30000, // 30 seconds max query time
  };
};
