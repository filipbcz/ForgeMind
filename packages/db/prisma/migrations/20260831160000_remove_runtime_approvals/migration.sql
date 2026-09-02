-- Runtime approvals were replaced by the autonomous implementation-validation-review loop.
-- Keep historical rows for auditability, but resolve every pending request.
UPDATE "approvals"
SET "status" = 'cancelled', "resolved_at" = CURRENT_TIMESTAMP
WHERE "status" = 'pending';

UPDATE "chat_approvals"
SET "status" = 'cancelled', "resolved_at" = CURRENT_TIMESTAMP
WHERE "status" = 'pending';

-- Resume work that was blocked solely by the removed approval mechanism.
INSERT INTO "task_queue_jobs" (
  "id", "task_id", "status", "reason", "attempt_count", "created_at"
)
SELECT
  gen_random_uuid()::text,
  task."id",
  'pending',
  'phase_retry',
  0,
  CURRENT_TIMESTAMP
FROM "tasks" AS task
WHERE task."status" = 'needs_approval'
  AND NOT EXISTS (
    SELECT 1
    FROM "task_queue_jobs" AS queue_job
    WHERE queue_job."task_id" = task."id"
      AND queue_job."status" IN ('pending', 'claimed')
  );

UPDATE "tasks"
SET "status" = 'submitted', "finished_at" = NULL, "updated_at" = CURRENT_TIMESTAMP
WHERE "status" = 'needs_approval';

UPDATE "chat_runs"
SET
  "status" = 'queued',
  "claimed_at" = NULL,
  "heartbeat_at" = NULL,
  "finished_at" = NULL,
  "next_attempt_at" = NULL,
  "error_message" = NULL,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "status" = 'waiting_for_approval';

-- Legacy columns remain physically present for forward-only compatibility and
-- historical rollback inspection. The current Prisma schema and runtime no
-- longer expose or write them.
