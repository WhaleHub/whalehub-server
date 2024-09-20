import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { TokenEntity } from '@/utils/typeorm/entities/token.entity';
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { LpBalanceEntity } from '@/utils/typeorm/entities/lp-balances.entity';
import { TreasuryDepositsEntity } from '@/utils/typeorm/entities/treasuryDeposits.entity';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';

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
      TokenEntity,
      PoolsEntity,
      LpBalanceEntity,
      TreasuryDepositsEntity,
      ClaimableRecordsEntity,
    ],
    migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
    extra: {
      charset: 'utf8mb4_unicode_ci',
    },
    synchronize:
      configService.get<string>('NODE_ENV') === 'development' ? true : false,
    autoLoadEntities: true,
    logging: false,
    ssl: configService.get<string>('NODE_ENV') === 'development' ? false : true,
  };
};
