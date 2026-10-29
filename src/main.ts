import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ErrorInterceptor } from '@/middleware/error.interceptor';
import { TelegramErrorLogger } from '@/modules/cron/telegram-error-logger';
import { ValidationPipe, HttpException, HttpStatus } from '@nestjs/common';

async function bootstrap() {
  // if (process.env.NODE_ENV === 'development') {
  //   const keyFile = fs.readFileSync(path.join(certFolder, 'server.key'));
  //   const certFile = fs.readFileSync(path.join(certFolder, 'server.cert'));

  //   httpsOptions = {
  //     key: keyFile,
  //     cert: certFile,
  //   };
  // }

  // Every logged error is also posted to Telegram (see telegram-error-logger.ts).
  const logger = new TelegramErrorLogger();
  logger.captureConsoleErrors();
  const app = await NestFactory.create(AppModule, { logger });

  const config = new DocumentBuilder()
    .setTitle('Whalehub Server')
    .setDescription('Whalehub Server backend documentation')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter Bearer token',
        in: 'header',
      },
      'Bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('doc', app, document);

  const configService = app.get(ConfigService);
  const serverPort = configService.get<number>('SERVER_PORT');
  const serverIp = configService.get<string>('SERVER_IP');

  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validateCustomDecorators: true,
      stopAtFirstError: true,
      exceptionFactory: (errors) => {
        const messages = errors
          .map((error) => Object.values(error.constraints || {}).join(', '))
          .join('; ');
        return new HttpException(
          `Validation failed: ${messages}`,
          HttpStatus.BAD_REQUEST,
        );
      },
    }),
  );
  app.useGlobalInterceptors(new ErrorInterceptor());

  await app.listen(serverPort, serverIp);

  console.log(`Application is now running on: ${await app.getUrl()}`);
}

bootstrap();
