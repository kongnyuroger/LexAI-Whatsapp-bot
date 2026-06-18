import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');

// Logs method, path, status code, and duration for every request, using
// the 'finish' event so the status code is whatever was actually sent
// (including ones set by guards/filters after this middleware runs), not
// just what the route handler returned. Deliberately never logs the body:
// webhook payloads carry WhatsApp message content, and several headers we
// don't log here carry the app secret / access tokens.
export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const message = `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`;
      if (res.statusCode >= 500) {
        logger.error(message);
      } else if (res.statusCode >= 400) {
        logger.warn(message);
      } else {
        logger.log(message);
      }
    });
    next();
  };
}
