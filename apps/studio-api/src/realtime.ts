import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AuditEvent } from '@forgemind/core';
import { WebSocket, WebSocketServer } from 'ws';

type ClientSubscription = {
  includeAll: boolean;
  taskIds: Set<string>;
};

type RealtimeMessage =
  | {
      type: 'connected';
      taskId?: string;
    }
  | {
      type: 'heartbeat';
      sentAt: string;
    }
  | {
      type: 'audit_event';
      event: AuditEvent;
    };

export interface RealtimeGateway {
  publishAuditEvent(event: AuditEvent): void;
  hasSubscribers(): boolean;
}

export function registerRealtimeGateway(app: FastifyInstance): RealtimeGateway {
  const server = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<WebSocket, ClientSubscription>();
  const heartbeatTimer = globalThis.setInterval(() => {
    const heartbeat = {
      type: 'heartbeat' as const,
      sentAt: new Date().toISOString()
    };

    for (const connection of subscriptions.keys()) {
      if (connection.readyState !== WebSocket.OPEN) {
        subscriptions.delete(connection);
        continue;
      }

      sendMessage(connection, heartbeat);
    }
  }, 10000);

  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    server.handleUpgrade(request, socket, head, (connection) => {
      server.emit('connection', connection, request);
    });
  });

  server.on('connection', (connection, request) => {
    const taskId = readTaskId(request);
    subscriptions.set(connection, {
      includeAll: !taskId,
      taskIds: taskId ? new Set([taskId]) : new Set()
    });
    sendMessage(connection, { type: 'connected', taskId });

    connection.on('message', (raw) => {
      const message = parseClientMessage(raw.toString());
      if (!message) {
        return;
      }

      const current = subscriptions.get(connection) ?? {
        includeAll: false,
        taskIds: new Set<string>()
      };

      if (message.type === 'subscribe') {
        if (message.taskId) {
          current.taskIds.add(message.taskId);
        } else {
          current.includeAll = true;
        }
      } else if (message.type === 'unsubscribe') {
        if (message.taskId) {
          current.taskIds.delete(message.taskId);
        } else {
          current.includeAll = false;
        }
      }

      subscriptions.set(connection, current);
    });

    connection.on('close', () => {
      subscriptions.delete(connection);
    });
  });

  app.addHook('onClose', async () => {
    globalThis.clearInterval(heartbeatTimer);
    for (const connection of subscriptions.keys()) {
      connection.close();
    }
    subscriptions.clear();
    server.close();
  });

  return {
    hasSubscribers() {
      return subscriptions.size > 0;
    },
    publishAuditEvent(event) {
      for (const [connection, subscription] of subscriptions.entries()) {
        if (connection.readyState !== WebSocket.OPEN) {
          subscriptions.delete(connection);
          continue;
        }

        if (subscription.includeAll) {
          sendMessage(connection, {
            type: 'audit_event',
            event
          });
          continue;
        }

        if (!event.taskId || !subscription.taskIds.has(event.taskId)) {
          continue;
        }

        sendMessage(connection, {
          type: 'audit_event',
          event
        });
      }
    }
  };
}

function readTaskId(request: IncomingMessage): string | undefined {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const taskId = url.searchParams.get('taskId')?.trim();
  return taskId ? taskId : undefined;
}

function parseClientMessage(raw: string): { type: 'subscribe' | 'unsubscribe'; taskId?: string } | undefined {
  try {
    const parsed = JSON.parse(raw) as { type?: string; taskId?: unknown };
    if (parsed.type !== 'subscribe' && parsed.type !== 'unsubscribe') {
      return undefined;
    }

    return {
      type: parsed.type,
      taskId: typeof parsed.taskId === 'string' && parsed.taskId.trim().length > 0 ? parsed.taskId.trim() : undefined
    };
  } catch {
    return undefined;
  }
}

function sendMessage(connection: WebSocket, message: RealtimeMessage) {
  connection.send(JSON.stringify(message));
}
