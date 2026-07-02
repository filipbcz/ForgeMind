import cors from '@fastify/cors';
import { createRepository, getPrismaClient } from '@forgemind/db';
import Fastify from 'fastify';
import { registerRoutes } from './routes.js';

export async function createApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info'
    }
  });

  await app.register(cors, {
    origin: true
  });

  const repository = createRepository(getPrismaClient());
  registerRoutes(app, repository);

  return app;
}
