import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { TokenEntity } from '@/utils/typeorm/entities/token.entity';

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
    entities: [UserEntity, TokenEntity],
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
