import cors from '@fastify/cors';
import { createRepository, getPrismaClient } from '@forgemind/db';
import type { AuditEvent } from '@forgemind/core';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
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

export async function createApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info'
    }
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  });
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
