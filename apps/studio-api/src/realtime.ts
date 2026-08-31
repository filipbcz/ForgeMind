import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AuditEvent } from '@forgemind/core';
import type { ForgeMindRepository } from '@forgemind/db';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { AuthService } from './auth.js';

type ClientSubscription = {
  userId: string;
  includeAll: boolean;
  taskIds: Set<string>;
  chatThreadIds: Set<string>;
};

type RealtimeMessage =
  | {
      type: 'connected';
      taskId?: string;
      chatThreadId?: string;
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

export function registerRealtimeGateway(app: FastifyInstance, repository: ForgeMindRepository, auth: AuthService): RealtimeGateway {
  const server = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<WebSocket, ClientSubscription>();
  const authorizedUsers = new WeakMap<IncomingMessage, string>();
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
    const sessionId = readSessionId(request);
    const scope = readSubscriptionScope(request);
    void (async () => {
      const session = sessionId ? await auth.getSessionById(sessionId) : null;
      if (!session) {
        rejectUpgrade(socket, 401, 'Authentication required');
        return;
      }
      const authorized = await authorizeSubscription(repository, session.userId, scope);
      if (!authorized) {
        rejectUpgrade(socket, 403, 'Subscription is not authorized');
        return;
      }
      authorizedUsers.set(request, session.userId);
      server.handleUpgrade(request, socket, head, (connection) => {
        server.emit('connection', connection, request);
      });
    })().catch(() => rejectUpgrade(socket, 503, 'Subscription authorization failed'));
  });

  server.on('connection', (connection: WebSocket, request: IncomingMessage) => {
    const userId = authorizedUsers.get(request);
    if (!userId) {
      connection.close(1008, 'Authentication required');
      return;
    }
    const { taskId, chatThreadId } = readSubscriptionScope(request);
    subscriptions.set(connection, {
      userId,
      includeAll: !taskId && !chatThreadId,
      taskIds: taskId ? new Set([taskId]) : new Set(),
      chatThreadIds: chatThreadId ? new Set([chatThreadId]) : new Set()
    });
    sendMessage(connection, { type: 'connected', taskId, chatThreadId });

    connection.on('message', (raw: RawData) => {
      const message = parseClientMessage(raw.toString());
      if (!message) {
        return;
      }

      const current = subscriptions.get(connection) ?? {
        userId,
        includeAll: false,
        taskIds: new Set<string>(),
        chatThreadIds: new Set<string>()
      };

      if (message.type === 'subscribe') {
        void authorizeSubscription(repository, current.userId, message).then((authorized) => {
          if (!authorized) return;
          if (message.taskId) current.taskIds.add(message.taskId);
          else if (message.chatThreadId) current.chatThreadIds.add(message.chatThreadId);
          else current.includeAll = true;
          subscriptions.set(connection, current);
        }).catch(() => undefined);
        return;
      } else if (message.type === 'unsubscribe') {
        if (message.taskId) {
          current.taskIds.delete(message.taskId);
        } else if (message.chatThreadId) {
          current.chatThreadIds.delete(message.chatThreadId);
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

        const matchesTask = Boolean(event.taskId && subscription.taskIds.has(event.taskId));
        const matchesChat = Boolean(event.chatThreadId && subscription.chatThreadIds.has(event.chatThreadId));
        if (!matchesTask && !matchesChat) {
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

function readSubscriptionScope(request: IncomingMessage): { taskId?: string; chatThreadId?: string } {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const taskId = url.searchParams.get('taskId')?.trim();
  const chatThreadId = url.searchParams.get('chatThreadId')?.trim();
  return { taskId: taskId || undefined, chatThreadId: chatThreadId || undefined };
}

async function authorizeSubscription(
  repository: ForgeMindRepository,
  userId: string,
  scope: { taskId?: string; chatThreadId?: string }
): Promise<boolean> {
  if (scope.chatThreadId) return Boolean(await repository.getChatThread(scope.chatThreadId, userId));
  if (scope.taskId) return (await repository.getTask(scope.taskId))?.createdByUserId === userId;
  return true;
}

function readSessionId(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim() || undefined;
  const cookie = Array.isArray(request.headers.cookie) ? request.headers.cookie.join(';') : request.headers.cookie;
  const encoded = cookie?.split(';').map((item) => item.trim())
    .find((item) => item.startsWith('forgemind_session='))?.slice('forgemind_session='.length);
  try {
    return encoded ? decodeURIComponent(encoded) : undefined;
  } catch {
    return undefined;
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function parseClientMessage(raw: string): { type: 'subscribe' | 'unsubscribe'; taskId?: string; chatThreadId?: string } | undefined {
  try {
    const parsed = JSON.parse(raw) as { type?: string; taskId?: unknown; chatThreadId?: unknown };
    if (parsed.type !== 'subscribe' && parsed.type !== 'unsubscribe') {
      return undefined;
    }

    return {
      type: parsed.type,
      taskId: typeof parsed.taskId === 'string' && parsed.taskId.trim().length > 0 ? parsed.taskId.trim() : undefined,
      chatThreadId: typeof parsed.chatThreadId === 'string' && parsed.chatThreadId.trim().length > 0 ? parsed.chatThreadId.trim() : undefined
    };
  } catch {
    return undefined;
  }
}

function sendMessage(connection: WebSocket, message: RealtimeMessage) {
  connection.send(JSON.stringify(message));
}
