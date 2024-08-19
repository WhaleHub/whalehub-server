import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { TokenModule } from './modules/token/token.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), TokenModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
