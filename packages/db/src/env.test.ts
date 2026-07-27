import { describe, expect, it } from 'vitest';
import { configureProductionDatabaseUrl } from './env.js';

describe('database environment', () => {
  it('adds production pool defaults without replacing explicit URL options', () => {
    const configured = new URL(
      configureProductionDatabaseUrl(
        'postgresql://forgemind:secret@postgres:5432/forgemind?schema=public',
        { NODE_ENV: 'production' }
      )
    );

    expect(configured.searchParams.get('schema')).toBe('public');
    expect(configured.searchParams.get('connection_limit')).toBe('10');
    expect(configured.searchParams.get('pool_timeout')).toBe('30');

    const explicit = new URL(
      configureProductionDatabaseUrl(
        'postgresql://forgemind:secret@postgres:5432/forgemind?connection_limit=20&pool_timeout=60',
        {
          NODE_ENV: 'production',
          FORGEMIND_DB_CONNECTION_LIMIT: '12',
          FORGEMIND_DB_POOL_TIMEOUT_SECONDS: '45'
        }
      )
    );

    expect(explicit.searchParams.get('connection_limit')).toBe('20');
    expect(explicit.searchParams.get('pool_timeout')).toBe('60');
  });
});
