import cors from '@fastify/cors';
import Fastify from 'fastify';
import { registerRoutes } from './routes.js';
import { createStore } from './store.js';

export async function createApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info'
    }
  });

  await app.register(cors, {
    origin: true
  });

  const store = createStore();
  registerRoutes(app, store);

  return app;
}

