import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ForgeMindRepository } from '@forgemind/db';
import type { AuthService } from '../auth.js';
import { sendBadRequest } from '../http.js';

const googleCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional()
});

const SESSION_COOKIE = 'forgemind_session';
const OAUTH_STATE_COOKIE = 'forgemind_google_oauth';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export function registerAuthRoutes(app: FastifyInstance, repository: ForgeMindRepository, auth: AuthService) {
  app.post('/api/auth/google/login', async (_request, reply) => {
    try {
      const login = auth.startGoogleLogin();
      reply.header('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, login.stateCookie, {
        maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
        path: '/api/auth/google/callback'
      }));
      return reply.code(202).send({ provider: login.provider, mode: login.mode, authUrl: login.authUrl });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/auth/google/callback', async (request, reply) => {
    try {
      const input = googleCallbackQuerySchema.parse(request.query);
      const stateCookie = readCookie(request.headers.cookie, OAUTH_STATE_COOKIE);
      const result = await auth.completeGoogleCallback(input, stateCookie);
      reply.header('Set-Cookie', [
        serializeCookie(SESSION_COOKIE, result.session.id, {
          maxAge: SESSION_MAX_AGE_SECONDS,
          path: '/'
        }),
        clearCookie(OAUTH_STATE_COOKIE, '/api/auth/google/callback')
      ]);
      await repository.writeAudit({
        actorType: 'user',
        actorId: result.user.id,
        eventType: 'auth_google_login_completed',
        payload: { provider: 'google', email: result.user.email }
      });
      return reply.redirect(resolveAuthReturnUrl());
    } catch (error) {
      reply.header('Set-Cookie', clearCookie(OAUTH_STATE_COOKIE, '/api/auth/google/callback'));
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = readSessionId(request.headers.authorization, request.headers.cookie);
    const session = sessionId ? await auth.getSessionById(sessionId) : null;
    if (!session || !sessionId) return reply.code(401).send({ error: 'Authentication required.' });

    await auth.logout(sessionId);
    reply.header('Set-Cookie', clearCookie(SESSION_COOKIE, '/'));
    await repository.writeAudit({
      actorType: 'user',
      actorId: session.userId,
      eventType: 'auth_logout',
      payload: { provider: 'google', loggedOut: true }
    });
    return reply.send({ userId: session.userId, loggedOut: true });
  });

  app.get('/api/auth/session', async (request, reply) => {
    const sessionId = readSessionId(request.headers.authorization, request.headers.cookie);
    const session = sessionId ? await auth.getSessionById(sessionId) : null;
    if (!session && sessionId) reply.header('Set-Cookie', clearCookie(SESSION_COOKIE, '/'));
    return {
      configured: auth.isConfigured(),
      user: session?.user ?? null,
      session: session
        ? {
            provider: session.provider,
            mode: session.mode,
            userId: session.userId,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt
          }
        : null
    };
  });
}

export function readSessionId(
  authorization: string | undefined,
  cookieHeader: string | string[] | undefined
): string | undefined {
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim() || undefined;
  }
  return readCookie(cookieHeader, SESSION_COOKIE);
}

function serializeCookie(name: string, value: string, options: { maxAge: number; path: string }): string {
  const secure = process.env.FORGEMIND_SESSION_COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=${options.path}; Max-Age=${options.maxAge}${secure}`;
}

function clearCookie(name: string, path: string): string {
  const secure = process.env.FORGEMIND_SESSION_COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${name}=; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=0${secure}`;
}

function readCookie(cookieHeader: string | string[] | undefined, name: string): string | undefined {
  const cookie = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  const encoded = cookie
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  try {
    return encoded ? decodeURIComponent(encoded) : undefined;
  } catch {
    return undefined;
  }
}

function resolveAuthReturnUrl(): string {
  const configured = process.env.FORGEMIND_AUTH_RETURN_URL?.trim()
    || process.env.FORGEMIND_CORS_ORIGINS?.split(',')[0]?.trim();
  if (configured) return new URL(configured).toString();

  const callbackUrl = process.env.GOOGLE_OAUTH_CALLBACK_URL?.trim();
  return callbackUrl ? new URL(callbackUrl).origin : '/';
}
