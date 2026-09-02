import { describe, expect, it } from 'vitest';
import { createNotificationService, type NotificationSettings, type NotificationStore } from './notifications.js';

describe('notification service', () => {
  it('persists settings and subscriptions through the provided store', async () => {
    const calls: string[] = [];
    const state = new Map<string, { settings: NotificationSettings; subscriptions: Array<{ endpoint: string }> }>();

    const store: NotificationStore = {
      async getNotificationSettings(userId) {
        calls.push(`get:${userId}`);
        const current = state.get(userId) ?? {
          settings: {
            pushEnabled: false,
            taskUpdates: true
          },
          subscriptions: []
        };

        return {
          userId,
          settings: current.settings as never,
          subscriptions: current.subscriptions.map((item, index) => ({
            id: `subscription_${index + 1}`,
            userId,
            endpoint: item.endpoint,
            createdAt: new Date().toISOString()
          }))
        };
      },
      async updateNotificationSettings(userId, input) {
        calls.push(`update:${userId}`);
        const current = state.get(userId) ?? {
          settings: {
            pushEnabled: false,
            taskUpdates: true
          },
          subscriptions: []
        };

        const next = {
          ...current,
          settings: {
            ...current.settings,
            ...input
          }
        };
        state.set(userId, next);
        return this.getNotificationSettings(userId);
      },
      async subscribeNotification(userId, input) {
        calls.push(`subscribe:${userId}`);
        const current = state.get(userId) ?? {
          settings: {
            pushEnabled: false,
            taskUpdates: true
          },
          subscriptions: []
        };

        const next = {
          settings: {
            ...current.settings,
            pushEnabled: true
          },
          subscriptions: [...current.subscriptions.filter((item) => item.endpoint !== input.endpoint), { endpoint: input.endpoint }]
        };
        state.set(userId, next);

        return {
          id: 'subscription_1',
          userId,
          endpoint: input.endpoint,
          keys: input.keys,
          deviceName: input.deviceName,
          createdAt: new Date().toISOString()
        };
      },
      async unsubscribeNotification(userId, endpoint) {
        calls.push(`unsubscribe:${userId}`);
        const current = state.get(userId) ?? {
          settings: {
            pushEnabled: false,
            taskUpdates: true
          },
          subscriptions: []
        };

        const nextSubscriptions = current.subscriptions.filter((item) => item.endpoint !== endpoint);
        state.set(userId, {
          settings: {
            ...current.settings,
            pushEnabled: nextSubscriptions.length > 0 && current.settings.pushEnabled
          },
          subscriptions: nextSubscriptions
        });

        return {
          userId,
          endpoint,
          removed: true
        };
      }
    };

    const service = createNotificationService(store);
    await service.subscribe('user_1', {
      endpoint: 'https://push.example.com/one',
      deviceName: 'phone'
    });

    const settingsAfterSubscribe = await service.getSettings('user_1');
    expect(settingsAfterSubscribe.settings.pushEnabled).toBe(true);
    expect(settingsAfterSubscribe.subscriptions).toHaveLength(1);

    await service.updateSettings('user_1', { taskUpdates: false });
    const settingsAfterUpdate = await service.getSettings('user_1');
    expect(settingsAfterUpdate.settings.taskUpdates).toBe(false);

    await service.unsubscribe('user_1', 'https://push.example.com/one');
    const settingsAfterUnsubscribe = await service.getSettings('user_1');
    expect(settingsAfterUnsubscribe.settings.pushEnabled).toBe(false);
    expect(calls).toContain('subscribe:user_1');
    expect(calls).toContain('update:user_1');
    expect(calls).toContain('unsubscribe:user_1');
  });

  it('sends push payloads for task events only while subscription is active', async () => {
    const settingsByUser = new Map<string, NotificationSettings>();
    const subscriptionsByUser = new Map<string, Array<{ endpoint: string; keys?: { p256dh?: string; auth?: string } }>>();
    const sentPayloads: Array<{ endpoint: string; title: string; body: string }> = [];

    const store: NotificationStore = {
      async getNotificationSettings(userId) {
        const settings = settingsByUser.get(userId) ?? {
          pushEnabled: false,
          taskUpdates: true
        };
        const subscriptions = subscriptionsByUser.get(userId) ?? [];

        return {
          userId,
          settings,
          subscriptions: subscriptions.map((item, index) => ({
            id: `subscription_${index + 1}`,
            userId,
            endpoint: item.endpoint,
            keys: item.keys,
            createdAt: new Date().toISOString()
          }))
        };
      },
      async updateNotificationSettings(userId, input) {
        const current = await this.getNotificationSettings(userId);
        const next = { ...current.settings, ...input };
        settingsByUser.set(userId, next);
        return this.getNotificationSettings(userId);
      },
      async subscribeNotification(userId, input) {
        const current = subscriptionsByUser.get(userId) ?? [];
        subscriptionsByUser.set(
          userId,
          [...current.filter((item) => item.endpoint !== input.endpoint), { endpoint: input.endpoint, keys: input.keys }]
        );
        settingsByUser.set(userId, {
          pushEnabled: true,
          taskUpdates: true
        });

        return {
          id: 'subscription_1',
          userId,
          endpoint: input.endpoint,
          keys: input.keys,
          deviceName: input.deviceName,
          createdAt: new Date().toISOString()
        };
      },
      async unsubscribeNotification(userId, endpoint) {
        const current = subscriptionsByUser.get(userId) ?? [];
        const next = current.filter((item) => item.endpoint !== endpoint);
        subscriptionsByUser.set(userId, next);

        const currentSettings = settingsByUser.get(userId) ?? {
          pushEnabled: false,
          taskUpdates: true
        };
        settingsByUser.set(userId, { ...currentSettings, pushEnabled: next.length > 0 });

        return {
          userId,
          endpoint,
          removed: current.length !== next.length
        };
      }
    };

    const service = createNotificationService(store, {
      async send(subscription, payload) {
        sentPayloads.push({ endpoint: subscription.endpoint, title: payload.title, body: payload.body });
      }
    });

    await service.subscribe('user_1', {
      endpoint: 'https://push.example.com/subscription/2',
      keys: {
        auth: 'auth-key',
        p256dh: 'p256dh-key'
      }
    });

    const firstSend = await service.notifyTaskEvent({
      userId: 'user_1',
      taskId: 'task_123',
      taskTitle: 'Implement notifications',
      status: 'completed'
    });

    expect(firstSend.sent).toBe(1);
    expect(sentPayloads[0]?.title).toBe('Task completed');

    await service.unsubscribe('user_1', 'https://push.example.com/subscription/2');

    const secondSend = await service.notifyTaskEvent({
      userId: 'user_1',
      taskId: 'task_123',
      taskTitle: 'Implement notifications',
      status: 'completed'
    });

    expect(secondSend.sent).toBe(0);
    expect(sentPayloads).toHaveLength(1);
  });
});
