import cors from '@fastify/cors';
import { createRepository, getPrismaClient } from '@forgemind/db';
import { redactError } from '@forgemind/core';
import type { AuditEvent } from '@forgemind/core';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rawBody from 'fastify-raw-body';
import { createAuthService } from './auth.js';
import { createNotificationService } from './notifications.js';
import { registerRealtimeGateway } from './realtime.js';
import { registerRoutes } from './routes.js';
import { createWebPushDispatcher } from './web-push.js';

const TERMINAL_FAILURE_STATUSES = new Set([
  'failed',
  'provider_failed',
  'validation_failed',
  'budget_exceeded',
  'iteration_limit_reached',
  'repeated_error_detected',
  'approval_rejected'
]);

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4000',
  'http://127.0.0.1:4000'
];

const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
const DEFAULT_REQUEST_HEADER_LIMIT_BYTES = 16_384;
const DEFAULT_SENSITIVE_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_SENSITIVE_RATE_LIMIT_MAX = 30;
const MAX_RATE_LIMIT_BUCKETS = 10_000;
const CSRF_HEADER = 'x-forgemind-csrf';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export async function createApp() {
  validateProductionHttpSecurityConfig();
  const allowedCorsOrigins = resolveAllowedCorsOrigins();
  const requestBodyLimit = resolvePositiveIntegerEnv('FORGEMIND_REQUEST_BODY_LIMIT_BYTES', DEFAULT_REQUEST_BODY_LIMIT_BYTES);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        '*.apiKey',
        '*.api_key',
        '*.token',
        '*.accessToken',
        '*.access_token',
        '*.password',
        '*.secret'
      ]
    },
    bodyLimit: requestBodyLimit
  });

  registerErrorRedaction(app);
  await registerHttpGuardrails(app, allowedCorsOrigins);
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true
  });

  const repository = createRepository(getPrismaClient());
  const notificationService = createNotificationService(repository, createWebPushDispatcher());
  const authService = createAuthService();
  const realtime = registerRealtimeGateway(app);
  registerRoutes(app, repository, notificationService, authService);

  startTaskNotificationBridge(app, repository, notificationService, realtime);

  return app;
}

export function registerErrorRedaction(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    const redactedMessage = redactError(error);
    const statusCode = typeof error === 'object'
      && error !== null
      && 'statusCode' in error
      && typeof error.statusCode === 'number'
      ? error.statusCode
      : 500;
    request.log.error({ error: redactedMessage }, 'request failed');
    return reply.code(statusCode >= 400 ? statusCode : 500).send({ error: redactedMessage });
  });
}

export async function registerHttpGuardrails(app: FastifyInstance, allowedCorsOrigins = resolveAllowedCorsOrigins()) {
  const requestHeaderLimit = resolvePositiveIntegerEnv('FORGEMIND_REQUEST_HEADER_LIMIT_BYTES', DEFAULT_REQUEST_HEADER_LIMIT_BYTES);
  const rateLimitWindowMs = resolvePositiveIntegerEnv('FORGEMIND_SENSITIVE_RATE_LIMIT_WINDOW_MS', DEFAULT_SENSITIVE_RATE_LIMIT_WINDOW_MS);
  const rateLimitMax = resolvePositiveIntegerEnv('FORGEMIND_SENSITIVE_RATE_LIMIT_MAX', DEFAULT_SENSITIVE_RATE_LIMIT_MAX);
  const rateLimitBuckets = new Map<string, RateLimitBucket>();

  app.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(reply);

    if (requestHeaderBytes(request) > requestHeaderLimit) {
      return reply.code(431).send({ error: 'Request headers are too large.' });
    }

    const rejection = rejectUnsafeBrowserMutation(request, allowedCorsOrigins);
    if (rejection) {
      return reply.code(rejection.statusCode).send({ error: rejection.error });
    }

    if (isSensitiveEndpoint(request)) {
      const rateLimit = consumeRateLimit(request, rateLimitBuckets, rateLimitWindowMs, rateLimitMax);
      reply.header('X-RateLimit-Limit', String(rateLimitMax));
      reply.header('X-RateLimit-Remaining', String(rateLimit.remaining));
      reply.header('X-RateLimit-Reset', String(Math.ceil(rateLimit.resetAt / 1000)));
      if (!rateLimit.allowed) {
        return reply.code(429).send({ error: 'Too many sensitive API requests. Try again later.' });
      }
    }
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedCorsOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  });
}

export function validateProductionHttpSecurityConfig() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const configuredCorsOrigins = process.env.FORGEMIND_CORS_ORIGINS?.trim();
  if (!configuredCorsOrigins) {
    throw new Error('Unsafe production HTTP configuration: set FORGEMIND_CORS_ORIGINS to explicit HTTPS origins.');
  }

  const origins = parseProductionCorsOrigins(configuredCorsOrigins);
  if (origins.length === 0) {
    throw new Error('Unsafe production HTTP configuration: FORGEMIND_CORS_ORIGINS must contain at least one origin.');
  }

  for (const origin of origins) {
    if (origin === '*' || origin.includes('*')) {
      throw new Error('Unsafe production HTTP configuration: wildcard CORS origins are not allowed.');
    }
    const url = new URL(origin);
    if (url.protocol !== 'https:') {
      throw new Error('Unsafe production HTTP configuration: production CORS origins must use https.');
    }
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0') {
      throw new Error('Unsafe production HTTP configuration: localhost CORS origins are not allowed in production.');
    }
  }

  if (process.env.FORGEMIND_SESSION_COOKIE_SECURE !== 'true') {
    throw new Error('Unsafe production HTTP configuration: set FORGEMIND_SESSION_COOKIE_SECURE=true.');
  }
}

export function resolveAllowedCorsOrigins(): Set<string> {
  const configured = process.env.FORGEMIND_CORS_ORIGINS
    ? parseCorsOrigins(process.env.FORGEMIND_CORS_ORIGINS)
    : undefined;
  return new Set(configured?.length ? configured : DEFAULT_CORS_ORIGINS);
}

function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      const url = new URL(origin);
      return url.origin;
    });
}

function parseProductionCorsOrigins(value: string): string[] {
  try {
    return parseCorsOrigins(value);
  } catch {
    throw new Error('Unsafe production HTTP configuration: FORGEMIND_CORS_ORIGINS must contain valid origins.');
  }
}

function applySecurityHeaders(reply: FastifyReply) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (process.env.NODE_ENV === 'production') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function rejectUnsafeBrowserMutation(
  request: FastifyRequest,
  allowedCorsOrigins: Set<string>
): { statusCode: number; error: string } | undefined {
  if (!isProtectedApiMutation(request)) {
    return undefined;
  }

  const origin = readSingleHeader(request.headers.origin);
  if (origin && !allowedCorsOrigins.has(origin)) {
    return { statusCode: 403, error: 'Origin is not allowed for mutating API requests.' };
  }

  if ((origin || hasSessionCookie(request)) && readSingleHeader(request.headers[CSRF_HEADER]) !== '1') {
    return { statusCode: 403, error: 'CSRF protection header is required for browser-originated mutations.' };
  }

  return undefined;
}

function isProtectedApiMutation(request: FastifyRequest): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    return false;
  }
  const path = request.url.split('?')[0] ?? request.url;
  return path.startsWith('/api/') && path !== '/api/auth/github/login' && path !== '/api/webhooks/github';
}

function isSensitiveEndpoint(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? request.url;
  if (path === '/api/auth/github/login') {
    return true;
  }
  return isProtectedApiMutation(request);
}

function consumeRateLimit(
  request: FastifyRequest,
  buckets: Map<string, RateLimitBucket>,
  windowMs: number,
  maxRequests: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const key = `${request.ip}:${request.method}:${request.url.split('?')[0] ?? request.url}`;
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  pruneRateLimitBuckets(buckets, now);

  return {
    allowed: bucket.count <= maxRequests,
    remaining: Math.max(0, maxRequests - bucket.count),
    resetAt: bucket.resetAt
  };
}

function pruneRateLimitBuckets(buckets: Map<string, RateLimitBucket>, now: number) {
  if (buckets.size <= MAX_RATE_LIMIT_BUCKETS) {
    return;
  }

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }

  while (buckets.size > MAX_RATE_LIMIT_BUCKETS) {
    const oldestKey = buckets.keys().next().value;
    if (!oldestKey) {
      return;
    }
    buckets.delete(oldestKey);
  }
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function hasSessionCookie(request: FastifyRequest): boolean {
  const cookie = Array.isArray(request.headers.cookie) ? request.headers.cookie.join(';') : request.headers.cookie;
  return Boolean(cookie
    ?.split(';')
    .map((item) => item.trim())
    .some((item) => item.startsWith('forgemind_session=')));
}

function requestHeaderBytes(request: FastifyRequest): number {
  return Object.entries(request.headers).reduce((total, [name, value]) => {
    const headerValue = Array.isArray(value) ? value.join(',') : String(value ?? '');
    return total + Buffer.byteLength(name) + Buffer.byteLength(headerValue);
  }, 0);
}

function resolvePositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function startTaskNotificationBridge(
  app: FastifyInstance,
  repository: ReturnType<typeof createRepository>,
  notifications: ReturnType<typeof createNotificationService>,
  realtime: { publishAuditEvent: (event: AuditEvent) => void; hasSubscribers: () => boolean }
) {
  const seenEvents = new Set<string>();
  let initialized = false;

  const stopPolling = startNonOverlappingPolling(async () => {
    try {
      const events = await repository.getRecentWorkerEvents(100);
      const ordered = [...events].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      for (const event of ordered) {
        if (seenEvents.has(event.id)) {
          continue;
        }

        seenEvents.add(event.id);
        if (!initialized) {
          continue;
        }

        realtime.publishAuditEvent(event);
        await notifyFromAuditEvent(event, repository, notifications);
      }

      initialized = true;
      trimSeenEvents(seenEvents, 1000);
    } catch (error) {
      app.log.warn({ error }, 'Task notification bridge poll failed');
    }
  }, () => realtime.hasSubscribers() ? 750 : 4_000);

  app.addHook('onClose', async () => {
    stopPolling();
  });
}

export function startNonOverlappingPolling(
  poll: () => Promise<void>,
  intervalMs: number | (() => number)
): () => void {
  let pollInProgress = false;
  let stopped = false;
  let timer: NodeJS.Timeout;

  const schedule = () => {
    timer = setTimeout(run, typeof intervalMs === 'function' ? intervalMs() : intervalMs);
  };
  const run = () => {
    if (stopped) return;
    if (pollInProgress) {
      schedule();
      return;
    }

    pollInProgress = true;
    void poll().then(
      () => {
        pollInProgress = false;
        if (!stopped) schedule();
      },
      () => {
        pollInProgress = false;
        if (!stopped) schedule();
      }
    );
  };
  run();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function notifyFromAuditEvent(
  event: AuditEvent,
  repository: ReturnType<typeof createRepository>,
  notifications: ReturnType<typeof createNotificationService>
) {
  if (!event.taskId) {
    return;
  }

  const match = /^task_status_(.+)$/.exec(event.eventType);
  if (!match) {
    return;
  }

  const status = match[1];
  if (!status) {
    return;
  }
  const shouldNotify = status === 'needs_approval' || status === 'completed' || TERMINAL_FAILURE_STATUSES.has(status);
  if (!shouldNotify) {
    return;
  }

  const task = await repository.getTask(event.taskId);
  if (!task) {
    return;
  }

  await notifications.notifyTaskEvent({
    userId: task.createdByUserId,
    taskId: task.id,
    taskTitle: task.title,
    status
  });
}

function trimSeenEvents(seenEvents: Set<string>, maxSize: number) {
  if (seenEvents.size <= maxSize) {
    return;
  }

  const overflow = seenEvents.size - maxSize;
  let index = 0;
  for (const id of seenEvents) {
    seenEvents.delete(id);
    index += 1;
    if (index >= overflow) {
      break;
    }
  }
}
