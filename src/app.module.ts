import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TokenModule } from './modules/token/token.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './utils/typeorm/entities/user.entity';
import { TokenEntity } from './utils/typeorm/entities/token.entity';
import { typeOrmConfig } from './config/typeOrm.config';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, TokenEntity]),
    TypeOrmModule.forRootAsync({
      useFactory: async (configService: ConfigService) =>
        await typeOrmConfig(configService),
      inject: [ConfigService],
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    TokenModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
