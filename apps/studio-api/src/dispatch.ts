import type { ForgeMindRepository } from '@forgemind/db';

export interface TaskDispatchResult {
  taskId: string;
  queueDepth: number;
  queuePosition: number | null;
  queuedAt: string;
}

export class TaskDispatchService {
  constructor(private readonly repository: ForgeMindRepository) {}

  async enqueueTask(
    taskId: string,
    reason: 'task_started' | 'task_retried' | 'roadmap_step_started' = 'task_started'
  ): Promise<TaskDispatchResult> {
    await this.repository.enqueueTask(taskId, reason);
    const queue = await this.repository.getTaskQueuePosition(taskId);
    const queuedAt = new Date().toISOString();

    await this.repository.writeAudit({
      actorType: 'system',
      eventType: 'task_enqueued',
      taskId,
      payload: {
        reason,
        queueDepth: queue.queueDepth,
        queuePosition: queue.queuePosition,
        queuedAt
      }
    });

    return {
      taskId,
      queueDepth: queue.queueDepth,
      queuePosition: queue.queuePosition,
      queuedAt
    };
  }

  async getQueueInfo(taskId: string): Promise<Omit<TaskDispatchResult, 'queuedAt'> & { queuedAt?: string }> {
    const queue = await this.repository.getTaskQueuePosition(taskId);
    return {
      taskId,
      queueDepth: queue.queueDepth,
      queuePosition: queue.queuePosition
    };
  }
}

export function createTaskDispatchService(repository: ForgeMindRepository) {
  return new TaskDispatchService(repository);
}
