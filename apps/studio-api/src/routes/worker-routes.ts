import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ForgeMindRepository } from '@forgemind/db';
import { sendBadRequest } from '../http.js';

const workerEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20)
});

const workerQueueControlSchema = z.object({
  paused: z.boolean()
});

export function registerWorkerRoutes(app: FastifyInstance, repository: ForgeMindRepository) {
  app.get('/api/worker/status', async () => repository.getWorkerStatus());

  app.put('/api/worker/queue', async (request, reply) => {
    try {
      const input = workerQueueControlSchema.parse(request.body);
      await repository.setWorkerQueuePaused(input.paused);
      return repository.getWorkerStatus();
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/worker/events', async (request) => {
    const query = workerEventsQuerySchema.parse(request.query ?? {});
    return repository.getRecentWorkerEvents(query.limit);
  });

  app.get('/api/metrics', async (_request, reply) => {
    const snapshot = await repository.getOperationalMetrics();
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return formatMetrics(snapshot);
  });
}

function formatMetrics(snapshot: Awaited<ReturnType<ForgeMindRepository['getOperationalMetrics']>>): string {
  return [
    '# HELP forgemind_tasks_total Total number of tasks.',
    '# TYPE forgemind_tasks_total gauge',
    `forgemind_tasks_total ${snapshot.tasks.total}`,
    `forgemind_tasks_draft ${snapshot.tasks.draft}`,
    `forgemind_tasks_submitted ${snapshot.tasks.submitted}`,
    `forgemind_tasks_active ${snapshot.tasks.active}`,
    `forgemind_tasks_completed ${snapshot.tasks.completed}`,
    `forgemind_tasks_failed ${snapshot.tasks.failed}`,
    `forgemind_tasks_cancelled ${snapshot.tasks.cancelled}`,
    `forgemind_tasks_provider_failed_total ${snapshot.tasks.providerFailed}`,
    `forgemind_tasks_validation_failed_total ${snapshot.tasks.validationFailed}`,
    '',
    '# HELP forgemind_queue_jobs Queue job gauges and wait metrics.',
    '# TYPE forgemind_queue_jobs gauge',
    `forgemind_queue_jobs_pending ${snapshot.queue.pending}`,
    `forgemind_queue_jobs_claimed ${snapshot.queue.claimed}`,
    `forgemind_queue_jobs_failed ${snapshot.queue.failed}`,
    `forgemind_queue_wait_seconds_avg ${snapshot.queue.averagePendingWaitSeconds.toFixed(3)}`,
    `forgemind_queue_wait_seconds_max ${snapshot.queue.maxPendingWaitSeconds.toFixed(3)}`,
    '',
    '# HELP forgemind_runs Task run gauges and duration metrics.',
    '# TYPE forgemind_runs gauge',
    `forgemind_runs_queued ${snapshot.runs.queued}`,
    `forgemind_runs_running ${snapshot.runs.running}`,
    `forgemind_runs_succeeded ${snapshot.runs.succeeded}`,
    `forgemind_runs_failed ${snapshot.runs.failed}`,
    `forgemind_runs_cancelled ${snapshot.runs.cancelled}`,
    `forgemind_run_duration_seconds_avg ${snapshot.runs.averageDurationSeconds.toFixed(3)}`,
    `forgemind_run_duration_seconds_max ${snapshot.runs.maxDurationSeconds.toFixed(3)}`,
    '',
    '# HELP forgemind_metrics_generated_at_unix Unix timestamp when metrics were generated.',
    '# TYPE forgemind_metrics_generated_at_unix gauge',
    `forgemind_metrics_generated_at_unix ${Math.floor(new Date(snapshot.generatedAt).getTime() / 1000)}`
  ].join('\n');
}
