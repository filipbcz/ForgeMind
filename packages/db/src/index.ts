import { PrismaClient } from '@prisma/client';
import { ensureDatabaseUrl } from './env.js';

let prisma: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  ensureDatabaseUrl();
  prisma ??= new PrismaClient();
  return prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}

export * from './env.js';
export * from './mappers.js';
export * from './roadmap.js';
export * from './repository.js';
export * from './specification.js';
