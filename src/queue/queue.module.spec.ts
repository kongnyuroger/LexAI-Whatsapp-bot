import { parseRedisUrl } from './queue.module';

describe('parseRedisUrl', () => {
  it('parses host and port from a plain URL', () => {
    expect(parseRedisUrl('redis://localhost:6380')).toEqual({
      host: 'localhost',
      port: 6380,
      username: undefined,
      password: undefined,
    });
  });

  it('falls back to port 6379 when none is specified', () => {
    expect(parseRedisUrl('redis://localhost')).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
    });
  });

  it('extracts username and password when present', () => {
    expect(parseRedisUrl('redis://user:secret@redis-host:6379')).toEqual({
      host: 'redis-host',
      port: 6379,
      username: 'user',
      password: 'secret',
    });
  });

  it('enables TLS for rediss:// URLs', () => {
    expect(parseRedisUrl('rediss://default:secret@upstash.io:6379')).toEqual({
      host: 'upstash.io',
      port: 6379,
      username: 'default',
      password: 'secret',
      tls: {},
    });
  });

  it('does not enable TLS for plain redis:// URLs', () => {
    expect(parseRedisUrl('redis://localhost:6379')).not.toHaveProperty('tls');
  });
});
