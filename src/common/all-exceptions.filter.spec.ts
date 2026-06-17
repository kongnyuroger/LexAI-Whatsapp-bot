import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function makeHost(request: { method: string; url: string }) {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it('returns the HttpException status and message', () => {
    const { host, response } = makeHost({ method: 'POST', url: '/webhook' });

    filter.catch(new BadRequestException('Invalid payload'), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid payload',
        path: '/webhook',
      }),
    );
  });

  it('hides internal details for a non-HTTP exception and returns 500', () => {
    const { host, response } = makeHost({ method: 'GET', url: '/health' });

    filter.catch(new Error('db connection refused'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    const calls = response.json.mock.calls as unknown as unknown[][];
    const body = calls[0][0] as { message: string };
    expect(body.message).toBe('Internal server error');
    expect(body.message).not.toContain('db connection refused');
  });

  it('includes an ISO timestamp', () => {
    const { host, response } = makeHost({ method: 'GET', url: '/health' });

    filter.catch(new BadRequestException('bad'), host);

    const calls = response.json.mock.calls as unknown as unknown[][];
    const body = calls[0][0] as { timestamp: string };
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });
});
