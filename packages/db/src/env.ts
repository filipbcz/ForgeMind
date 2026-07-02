export const LOCAL_DATABASE_URL = 'postgresql://forgemind:forgemind@127.0.0.1:5432/forgemind?schema=public';

export function ensureDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production.');
  }

  process.env.DATABASE_URL = LOCAL_DATABASE_URL;
  return process.env.DATABASE_URL;
}

