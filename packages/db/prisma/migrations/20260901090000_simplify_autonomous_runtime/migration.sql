-- Resume work that was parked by runtime approvals, limits, or capability gates.
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
WHERE task."status"::text IN (
  'waiting_for_plan_approval',
  'needs_approval',
  'budget_exceeded',
  'iteration_limit_reached',
  'repeated_error_detected',
  'approval_rejected',
  'waiting_for_capability'
)
AND NOT EXISTS (
  SELECT 1
  FROM "task_queue_jobs" AS queue_job
  WHERE queue_job."task_id" = task."id"
    AND queue_job."status" IN ('pending', 'claimed')
);

UPDATE "tasks"
SET "status" = 'submitted', "finished_at" = NULL, "updated_at" = CURRENT_TIMESTAMP
WHERE "status"::text IN (
  'waiting_for_plan_approval',
  'needs_approval',
  'budget_exceeded',
  'iteration_limit_reached',
  'repeated_error_detected',
  'approval_rejected',
  'waiting_for_capability'
);

UPDATE "project_implementation_steps"
SET "status" = 'running', "completed_at" = NULL
WHERE "status"::text = 'waiting_for_capability';

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

UPDATE "task_iterations"
SET "phase" = 'review'
WHERE "phase" = 'approval';

UPDATE "approvals"
SET "status" = 'cancelled', "resolved_at" = COALESCE("resolved_at", CURRENT_TIMESTAMP)
WHERE "status" = 'pending';

UPDATE "chat_approvals"
SET "status" = 'cancelled', "resolved_at" = COALESCE("resolved_at", CURRENT_TIMESTAMP)
WHERE "status" = 'pending';

ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_task_id_fkey";
ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "ProjectRoadmapCycleStatus" RENAME VALUE 'awaiting_extension_approval' TO 'awaiting_extension_decision';

-- Legacy enum values, columns, and approval tables intentionally remain as
-- immutable historical storage. The current Prisma schema no longer exposes
-- them and the runtime never writes them.
