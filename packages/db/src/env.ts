export const LOCAL_DATABASE_URL = 'postgresql://forgemind:forgemind@127.0.0.1:5432/forgemind?schema=public';

export function ensureDatabaseUrl(): string {
  const configuredUrl = process.env.DATABASE_URL;
  if (configuredUrl) {
    const databaseUrl = configureProductionDatabaseUrl(configuredUrl);
    process.env.DATABASE_URL = databaseUrl;
    return databaseUrl;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production.');
  }

  process.env.DATABASE_URL = LOCAL_DATABASE_URL;
  return process.env.DATABASE_URL;
}

export function configureProductionDatabaseUrl(
  source: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  if (environment.NODE_ENV !== 'production') {
    return source;
  }

  const databaseUrl = new URL(source);
  if (!databaseUrl.searchParams.has('connection_limit')) {
    databaseUrl.searchParams.set(
      'connection_limit',
      resolvePositiveInteger(environment.FORGEMIND_DB_CONNECTION_LIMIT, 10)
    );
  }
  if (!databaseUrl.searchParams.has('pool_timeout')) {
    databaseUrl.searchParams.set(
      'pool_timeout',
      resolvePositiveInteger(environment.FORGEMIND_DB_POOL_TIMEOUT_SECONDS, 30)
    );
  }

  return databaseUrl.toString();
}

function resolvePositiveInteger(value: string | undefined, fallback: number): string {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : String(fallback);
}
