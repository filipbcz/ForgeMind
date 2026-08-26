import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ForgeMindRepository } from '@forgemind/db';
import type { AuthService } from '../auth.js';
import { sendBadRequest } from '../http.js';

const githubCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional()
});

export function registerAuthRoutes(app: FastifyInstance, repository: ForgeMindRepository, auth?: AuthService) {
  app.post('/api/auth/github/login', async (_request, reply) => {
    try {
      if (!auth) {
        return reply.code(503).send({ error: 'Auth service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const login = auth.startGitHubLogin();
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'auth_github_login_started',
        payload: { provider: 'github', mode: login.mode }
      });
      return reply.code(202).send(login);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/auth/github/callback', async (request, reply) => {
    try {
      if (!auth) {
        return reply.code(503).send({ error: 'Auth service is not configured.' });
      }

      const input = githubCallbackQuerySchema.parse(request.query);
      const currentUser = await repository.getCurrentUser();
      const session = auth.completeGitHubCallback(input, currentUser);
      reply.header('Set-Cookie', serializeSessionCookie(session.session.id));
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'auth_github_callback_completed',
        payload: {
          provider: 'github',
          mode: session.session.mode,
          providerAccess: session.session.providerAccess
        }
      });
      return reply.send(session);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    try {
      if (!auth) {
        return reply.code(503).send({ error: 'Auth service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const result = auth.logout(currentUser.id);
      reply.header('Set-Cookie', 'forgemind_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'auth_logout',
        payload: { provider: 'github', loggedOut: result.loggedOut }
      });
      return reply.send(result);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/auth/session', async (_request, reply) => {
    if (!auth) {
      return reply.code(503).send({ error: 'Auth service is not configured.' });
    }

    const currentUser = await repository.getCurrentUser();
    return {
      user: currentUser,
      session: auth.getSession(currentUser.id)
    };
  });
}

function serializeSessionCookie(sessionId: string): string {
  const secure = process.env.FORGEMIND_SESSION_COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `forgemind_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/${secure}`;
}
