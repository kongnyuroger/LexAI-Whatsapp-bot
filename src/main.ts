import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  // rawBody: true exposes req.rawBody (a Buffer) so WebhookSignatureGuard can
  // verify Meta's X-Hub-Signature-256 HMAC against the exact bytes sent —
  // verifying against the already-parsed/re-serialized JSON body would not
  // reliably reproduce the same bytes Meta signed.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
