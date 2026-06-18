import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { requestLogger } from './request-logger.middleware';

function createMockResponse(statusCode: number): Response {
  const res = new EventEmitter() as unknown as Response;
  (res as unknown as { statusCode: number }).statusCode = statusCode;
  return res;
}

describe('requestLogger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs at "log" level for a successful response', () => {
    const middleware = requestLogger();
    const req = { method: 'GET', originalUrl: '/health' } as Request;
    const res = createMockResponse(200);
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    res.emit('finish');

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('GET /health 200'),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs at "warn" level for a 4xx response', () => {
    const middleware = requestLogger();
    const req = { method: 'POST', originalUrl: '/webhook' } as Request;
    const res = createMockResponse(401);
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('POST /webhook 401'),
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs at "error" level for a 5xx response', () => {
    const middleware = requestLogger();
    const req = { method: 'GET', originalUrl: '/health' } as Request;
    const res = createMockResponse(503);
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('GET /health 503'),
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
