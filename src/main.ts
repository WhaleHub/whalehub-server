import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ErrorInterceptor } from '@/middleware/error.interceptor';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
  app.useGlobalPipes(new ValidationPipe());
  app.useGlobalInterceptors(new ErrorInterceptor());

  await app.listen(serverPort, serverIp);

  console.log(`Application is now running on: ${await app.getUrl()}`);
}

bootstrap();
