import webpush from 'web-push';
import type { NotificationDispatcher, NotificationSubscription, PushNotificationPayload } from './notifications.js';
import { resolveRuntimeEnvVar } from './runtime-env.js';

const DEFAULT_SUBJECT = 'mailto:ops@forgemind.local';

export function createWebPushDispatcher(): NotificationDispatcher | undefined {
  const publicKey = resolveRuntimeEnvVar('VAPID_PUBLIC_KEY');
  const privateKey = resolveRuntimeEnvVar('VAPID_PRIVATE_KEY');

  if (!publicKey || !privateKey) {
    return undefined;
  }

  webpush.setVapidDetails(resolveRuntimeEnvVar('VAPID_SUBJECT') ?? DEFAULT_SUBJECT, publicKey, privateKey);

  return {
    async send(subscription: NotificationSubscription, payload: PushNotificationPayload) {
      if (!subscription.keys?.auth || !subscription.keys?.p256dh) {
        throw new Error('Push subscription is missing required keys.');
      }

      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            auth: subscription.keys.auth,
            p256dh: subscription.keys.p256dh
          }
        },
        JSON.stringify(payload)
      );
    }
  };
}
