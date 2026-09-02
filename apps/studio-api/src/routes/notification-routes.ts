import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ForgeMindRepository } from '@forgemind/db';
import type { NotificationService } from '../notifications.js';
import { sendBadRequest } from '../http.js';
import { resolveRuntimeEnvVar } from '../runtime-env.js';

const notificationSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z
    .object({
      p256dh: z.string().optional(),
      auth: z.string().optional()
    })
    .optional(),
  deviceName: z.string().min(1).optional()
});

const notificationSettingsSchema = z.object({
  pushEnabled: z.boolean().optional(),
  taskUpdates: z.boolean().optional()
});

export function registerNotificationRoutes(app: FastifyInstance, repository: ForgeMindRepository, notifications?: NotificationService) {
  app.post('/api/notifications/subscribe', async (request, reply) => {
    try {
      if (!notifications) {
        return reply.code(503).send({ error: 'Notifications service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const input = notificationSubscriptionSchema.parse(request.body);
      const subscription = await notifications.subscribe(currentUser.id, input);
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'notifications_subscribed',
        payload: { endpoint: input.endpoint, deviceName: input.deviceName ?? null }
      });
      return reply.code(201).send(subscription);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/notifications/unsubscribe', async (request, reply) => {
    try {
      if (!notifications) {
        return reply.code(503).send({ error: 'Notifications service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const input = z.object({ endpoint: z.string().url() }).parse(request.body);
      const result = await notifications.unsubscribe(currentUser.id, input.endpoint);
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'notifications_unsubscribed',
        payload: { endpoint: input.endpoint, removed: result.removed }
      });
      return reply.send(result);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/notifications/vapid-public-key', async (_request, reply) => {
    const publicKey = resolveRuntimeEnvVar('VAPID_PUBLIC_KEY');
    if (!publicKey) {
      return reply.code(503).send({ error: 'VAPID_PUBLIC_KEY is not configured.' });
    }

    return reply.send({ publicKey });
  });

  app.get('/api/notifications/settings', async (request, reply) => {
    if (!notifications) {
      return reply.code(503).send({ error: 'Notifications service is not configured.' });
    }

    const currentUser = await repository.getCurrentUser();
    return notifications.getSettings(currentUser.id);
  });

  app.put('/api/notifications/settings', async (request, reply) => {
    try {
      if (!notifications) {
        return reply.code(503).send({ error: 'Notifications service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const input = notificationSettingsSchema.parse(request.body);
      const settings = await notifications.updateSettings(currentUser.id, input);
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'notification_settings_updated',
        payload: input
      });
      return reply.send(settings);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });
}
