import { NestFactory } from '@nestjs/core';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { requestLogger } from './common/request-logger.middleware';
import { flattenValidationErrors } from './common/flatten-validation-errors.util';

async function bootstrap() {
  const validationLogger = new Logger('ValidationPipe');

  // rawBody: true exposes req.rawBody (a Buffer) so WebhookSignatureGuard can
  // verify Meta's X-Hub-Signature-256 HMAC against the exact bytes sent —
  // verifying against the already-parsed/re-serialized JSON body would not
  // reliably reproduce the same bytes Meta signed.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.use(requestLogger());
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      // Default ValidationPipe behavior swallows the actual failed
      // constraints into the response body only — nothing server-side ever
      // logs *why* a request was rejected. That made a real webhook payload
      // mismatch from Meta invisible in Render's logs (just "400"). This
      // logs the constraint paths only, never error.value, since that can
      // carry WhatsApp message text/PII.
      exceptionFactory: (errors) => {
        validationLogger.warn(
          `Validation failed: ${flattenValidationErrors(errors).join('; ')}`,
        );
        return new BadRequestException(errors);
      },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
