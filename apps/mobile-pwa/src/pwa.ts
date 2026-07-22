let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration | null> | undefined;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', () => {
    void ensureServiceWorkerRegistration();
  });
}

export async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    return null;
  }

  if (!serviceWorkerRegistrationPromise) {
    serviceWorkerRegistrationPromise = navigator.serviceWorker
      .register('/sw.js')
      .catch((error: unknown) => {
        console.warn('Service worker registration failed', error);
        return null;
      });
  }

  return serviceWorkerRegistrationPromise;
}

export async function subscribeForPushNotifications(input: {
  vapidPublicKey: string;
  deviceName?: string;
  onSubscribe: (payload: {
    endpoint: string;
    keys?: {
      p256dh?: string;
      auth?: string;
    };
    deviceName?: string;
  }) => Promise<void>;
}) {
  const registration = await ensureServiceWorkerRegistration();
  if (!registration) {
    throw new Error('Service Worker is not available in this browser.');
  }

  if (!('PushManager' in window)) {
    throw new Error('Push notifications are not supported in this browser.');
  }

  const permission = await ensureNotificationPermission();
  if (permission !== 'granted') {
    throw new Error('Notifications permission was not granted.');
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64UrlToUint8Array(input.vapidPublicKey)
    });
  }

  await input.onSubscribe(pushSubscriptionToPayload(subscription, input.deviceName));
  return subscription.endpoint;
}

export async function unsubscribeFromPushNotifications(input: {
  onUnsubscribe: (endpoint: string) => Promise<void>;
}) {
  const registration = await ensureServiceWorkerRegistration();
  if (!registration || !('PushManager' in window)) {
    return { removed: false, endpoint: undefined as string | undefined };
  }

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    return { removed: false, endpoint: undefined as string | undefined };
  }

  const endpoint = subscription.endpoint;
  await input.onUnsubscribe(endpoint);
  await subscription.unsubscribe();
  return { removed: true, endpoint };
}

async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) {
    throw new Error('Notifications API is not available in this browser.');
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  if (Notification.permission === 'denied') {
    return 'denied';
  }

  return Notification.requestPermission();
}

function pushSubscriptionToPayload(
  subscription: PushSubscription,
  deviceName?: string
): {
  endpoint: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  deviceName?: string;
} {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth
    },
    deviceName
  };
}

function decodeBase64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64 + padding);
  const output = new Uint8Array(raw.length);

  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }

  return output;
}

