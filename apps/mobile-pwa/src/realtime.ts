import { buildWebSocketUrl } from './api.js';
import type { RealtimeMessage } from './types.js';

type RealtimeHandlers = {
  onMessage: (message: RealtimeMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
  onStateChange?: (state: RealtimeConnectionState) => void;
  onMetaChange?: (meta: RealtimeConnectionMeta) => void;
};

export type RealtimeConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type RealtimeConnectionMeta = {
  state: RealtimeConnectionState;
  lastMessageAt?: string;
  lastHeartbeatAt?: string;
};

type Subscription = {
  id: number;
  taskId?: string;
  handlers: RealtimeHandlers;
};

class RealtimeConnectionManager {
  private socket: WebSocket | undefined;
  private reconnectTimer: number | undefined;
  private nextId = 1;
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly taskRefCounts = new Map<string, number>();
  private globalRefCount = 0;
  private state: RealtimeConnectionState = 'idle';
  private lastMessageAt: string | undefined;
  private lastHeartbeatAt: string | undefined;

  subscribe(taskId: string | undefined, handlers: RealtimeHandlers): () => void {
    const id = this.nextId++;
    this.subscriptions.set(id, {
      id,
      taskId,
      handlers
    });

    if (taskId) {
      const nextCount = (this.taskRefCounts.get(taskId) ?? 0) + 1;
      this.taskRefCounts.set(taskId, nextCount);
      if (nextCount === 1) {
        this.sendControlMessage('subscribe', taskId);
      }
    } else {
      this.globalRefCount += 1;
      if (this.globalRefCount === 1) {
        this.sendControlMessage('subscribe');
      }
    }

    this.ensureConnected();
    if (this.socket?.readyState === WebSocket.OPEN) {
      handlers.onOpen?.();
    }
    handlers.onStateChange?.(this.state);
    handlers.onMetaChange?.(this.snapshotMeta());

    return () => {
      const subscription = this.subscriptions.get(id);
      if (!subscription) {
        return;
      }

      this.subscriptions.delete(id);
      if (subscription.taskId) {
        const currentCount = this.taskRefCounts.get(subscription.taskId) ?? 0;
        const nextCount = Math.max(0, currentCount - 1);
        if (nextCount === 0) {
          this.taskRefCounts.delete(subscription.taskId);
          this.sendControlMessage('unsubscribe', subscription.taskId);
        } else {
          this.taskRefCounts.set(subscription.taskId, nextCount);
        }
      } else if (this.globalRefCount > 0) {
        this.globalRefCount -= 1;
        if (this.globalRefCount === 0) {
          this.sendControlMessage('unsubscribe');
        }
      }

      if (this.subscriptions.size === 0) {
        this.disposeSocket();
      }
    };
  }

  private ensureConnected() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.setState('connecting');
    this.socket = new WebSocket(buildWebSocketUrl());
    this.socket.addEventListener('open', () => {
      this.setState('connected');
      this.flushSubscriptions();
      for (const subscription of this.subscriptions.values()) {
        subscription.handlers.onOpen?.();
      }
    });
    this.socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as RealtimeMessage;
        this.lastMessageAt = new Date().toISOString();
        if (message.type === 'heartbeat') {
          this.lastHeartbeatAt = message.sentAt;
        }
        this.notifyMetaChange();
        for (const subscription of this.subscriptions.values()) {
          if (!matchesSubscription(subscription.taskId, message)) {
            continue;
          }
          subscription.handlers.onMessage(message);
        }
      } catch {
        // Ignore malformed frames.
      }
    });
    this.socket.addEventListener('close', () => {
      const hadSubscribers = this.subscriptions.size > 0;
      for (const subscription of this.subscriptions.values()) {
        subscription.handlers.onClose?.();
      }
      this.socket = undefined;
      if (hadSubscribers) {
        this.scheduleReconnect();
      } else {
        this.setState('idle');
      }
    });
    this.socket.addEventListener('error', () => {
      for (const subscription of this.subscriptions.values()) {
        subscription.handlers.onError?.();
      }
    });
  }

  private flushSubscriptions() {
    if (this.globalRefCount > 0) {
      this.sendControlMessage('subscribe');
    }

    for (const taskId of this.taskRefCounts.keys()) {
      this.sendControlMessage('subscribe', taskId);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.subscriptions.size === 0) {
      return;
    }

    this.setState('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnected();
    }, 2000);
  }

  private sendControlMessage(type: 'subscribe' | 'unsubscribe', taskId?: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify({
      type,
      taskId: taskId ?? null
    }));
  }

  private disposeSocket() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }

    this.setState('idle');
  }

  private setState(state: RealtimeConnectionState) {
    if (this.state === state) {
      return;
    }

    this.state = state;
    for (const subscription of this.subscriptions.values()) {
      subscription.handlers.onStateChange?.(state);
    }
    this.notifyMetaChange();
  }

  private notifyMetaChange() {
    const meta = this.snapshotMeta();
    for (const subscription of this.subscriptions.values()) {
      subscription.handlers.onMetaChange?.(meta);
    }
  }

  private snapshotMeta(): RealtimeConnectionMeta {
    return {
      state: this.state,
      lastMessageAt: this.lastMessageAt,
      lastHeartbeatAt: this.lastHeartbeatAt
    };
  }
}

function matchesSubscription(taskId: string | undefined, message: RealtimeMessage): boolean {
  if (message.type !== 'audit_event') {
    return true;
  }

  if (!taskId) {
    return true;
  }

  return message.event.taskId === taskId;
}

const realtimeConnectionManager = new RealtimeConnectionManager();

export function subscribeRealtime(taskId: string | undefined, handlers: RealtimeHandlers): () => void {
  return realtimeConnectionManager.subscribe(taskId, handlers);
}
