import { createId, nowIso } from '@forgemind/shared';

export interface NotificationStore {
  getNotificationSettings(userId: string): Promise<NotificationSettingsSnapshot>;
  updateNotificationSettings(userId: string, input: Partial<NotificationSettings>): Promise<NotificationSettingsSnapshot>;
  subscribeNotification(userId: string, input: NotificationSubscriptionInput): Promise<NotificationSubscription>;
  unsubscribeNotification(userId: string, endpoint: string): Promise<{ userId: string; endpoint: string; removed: boolean }>;
}

export interface NotificationSettingsSnapshot {
  userId: string;
  settings: NotificationSettings;
  subscriptions: NotificationSubscription[];
}

export interface NotificationSubscriptionInput {
  endpoint: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  deviceName?: string;
}

export interface NotificationSettings {
  pushEnabled: boolean;
  taskUpdates: boolean;
}

export interface NotificationSubscription extends NotificationSubscriptionInput {
  id: string;
  userId: string;
  createdAt: string;
}

export type NotificationEventKind = 'task_completed' | 'task_failed';

export interface PushNotificationPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  data?: Record<string, unknown>;
}

export interface NotificationDispatchResult {
  sent: number;
  failed: number;
}

export interface NotificationDispatcher {
  send(subscription: NotificationSubscription, payload: PushNotificationPayload): Promise<void>;
}

const defaultSettings: NotificationSettings = {
  pushEnabled: false,
  taskUpdates: true
};

export class NotificationService {
  constructor(
    private readonly store?: NotificationStore,
    private readonly dispatcher?: NotificationDispatcher
  ) {}

  private readonly settingsByUser = new Map<string, NotificationSettings>();
  private readonly subscriptionsByUser = new Map<string, NotificationSubscription[]>();

  async getSettings(userId: string): Promise<NotificationSettingsSnapshot> {
    if (this.store) {
      return this.store.getNotificationSettings(userId);
    }

    const settings = this.settingsByUser.get(userId) ?? defaultSettings;
    const subscriptions = this.subscriptionsByUser.get(userId) ?? [];

    return {
      userId,
      settings,
      subscriptions
    };
  }

  async updateSettings(userId: string, input: Partial<NotificationSettings>): Promise<NotificationSettingsSnapshot> {
    if (this.store) {
      return this.store.updateNotificationSettings(userId, input);
    }

    const current = this.settingsByUser.get(userId) ?? defaultSettings;
    const next = {
      ...current,
      ...input
    };
    this.settingsByUser.set(userId, next);
    return this.getSettings(userId);
  }

  async subscribe(userId: string, input: NotificationSubscriptionInput): Promise<NotificationSubscription> {
    if (this.store) {
      return this.store.subscribeNotification(userId, input);
    }

    const existing = this.subscriptionsByUser.get(userId) ?? [];
    const deduped = existing.filter((item) => item.endpoint !== input.endpoint);
    const subscription: NotificationSubscription = {
      id: createId('subscription'),
      userId,
      endpoint: input.endpoint,
      keys: input.keys,
      deviceName: input.deviceName,
      createdAt: nowIso()
    };
    this.subscriptionsByUser.set(userId, [...deduped, subscription]);
    const current = this.settingsByUser.get(userId) ?? defaultSettings;
    this.settingsByUser.set(userId, { ...current, pushEnabled: true });
    return subscription;
  }

  async unsubscribe(userId: string, endpoint: string): Promise<{ userId: string; endpoint: string; removed: boolean }> {
    if (this.store) {
      return this.store.unsubscribeNotification(userId, endpoint);
    }

    const existing = this.subscriptionsByUser.get(userId) ?? [];
    const next = existing.filter((item) => item.endpoint !== endpoint);
    this.subscriptionsByUser.set(userId, next);

    const current = this.settingsByUser.get(userId) ?? defaultSettings;
    this.settingsByUser.set(userId, { ...current, pushEnabled: next.length > 0 && current.pushEnabled });

    return {
      userId,
      endpoint,
      removed: next.length !== existing.length
    };
  }

  async sendToUser(
    userId: string,
    payload: PushNotificationPayload
  ): Promise<NotificationDispatchResult> {
    if (!this.dispatcher) {
      return { sent: 0, failed: 0 };
    }

    const snapshot = await this.getSettings(userId);
    if (!snapshot.settings.pushEnabled || !snapshot.settings.taskUpdates) {
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;

    for (const subscription of snapshot.subscriptions) {
      if (!subscription.endpoint) {
        continue;
      }

      try {
        await this.dispatcher.send(subscription, payload);
        sent += 1;
      } catch {
        failed += 1;
      }
    }

    return { sent, failed };
  }

  async notifyTaskEvent(input: {
    userId: string;
    taskId: string;
    taskTitle: string;
    status: string;
  }): Promise<NotificationDispatchResult> {
    const normalized = normalizeTaskStatus(input.status);
    const payload = createTaskNotificationPayload(input.taskId, input.taskTitle, normalized);
    return this.sendToUser(input.userId, payload);
  }
}

export function createNotificationService(store?: NotificationStore, dispatcher?: NotificationDispatcher) {
  return new NotificationService(store, dispatcher);
}

function normalizeTaskStatus(status: string): NotificationEventKind {
  if (status === 'completed') return 'task_completed';
  return 'task_failed';
}

function createTaskNotificationPayload(taskId: string, taskTitle: string, eventKind: NotificationEventKind): PushNotificationPayload {
  if (eventKind === 'task_completed') {
    return {
      title: 'Task completed',
      body: `Task "${taskTitle}" finished successfully.`,
      tag: `task-${taskId}-completed`,
      url: '/?view=tasks',
      data: {
        taskId,
        eventType: eventKind
      }
    };
  }

  return {
    title: 'Task failed',
    body: `Task "${taskTitle}" ended in a failed state.`,
    tag: `task-${taskId}-failed`,
    url: '/?view=tasks',
    data: {
      taskId,
      eventType: eventKind
    }
  };
}
