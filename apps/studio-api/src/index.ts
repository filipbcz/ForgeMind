import { createApp } from './server.js';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';

const app = await createApp();

try {
  await app.listen({ port, host });
  app.log.info({ port, host }, 'ForgeMind Studio API listening');
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

