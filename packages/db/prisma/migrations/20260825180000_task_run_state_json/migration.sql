ALTER TABLE "task_runs"
ADD COLUMN "run_state_json" JSONB NOT NULL DEFAULT '{"version":1,"status":"queued"}';

UPDATE "task_runs"
SET "run_state_json" = jsonb_build_object('version', 1, 'status', "status"::text);

WITH latest_waiting_run AS (
  SELECT DISTINCT ON (tr."task_id")
    tr."id",
    t."waiting_for_capabilities"
  FROM "task_runs" tr
  JOIN "tasks" t ON t."id" = tr."task_id"
  WHERE t."status"::text = 'waiting_for_capability'
  ORDER BY tr."task_id", tr."started_at" DESC NULLS LAST, tr."id" DESC
)
UPDATE "task_runs" tr
SET "run_state_json" = jsonb_build_object(
  'version', 1,
  'status', 'waiting',
  'reason', 'unavailable_capability',
  'requiredCapabilities', latest_waiting_run."waiting_for_capabilities"
)
FROM latest_waiting_run
WHERE tr."id" = latest_waiting_run."id";

WITH latest_retry_run AS (
  SELECT DISTINCT ON (tr."task_id")
    tr."id",
    q."next_attempt_at"
  FROM "task_runs" tr
  JOIN "task_queue_jobs" q ON q."task_id" = tr."task_id"
  JOIN "tasks" t ON t."id" = tr."task_id"
  WHERE t."status" = 'submitted'
    AND q."status" = 'pending'
    AND q."next_attempt_at" IS NOT NULL
  ORDER BY tr."task_id", q."next_attempt_at" ASC, tr."started_at" DESC NULLS LAST, tr."id" DESC
)
UPDATE "task_runs" tr
SET "run_state_json" = jsonb_build_object(
  'version', 1,
  'status', 'retry_scheduled',
  'reason', 'retry_backoff',
  'nextAttemptAt', latest_retry_run."next_attempt_at"
)
FROM latest_retry_run
WHERE tr."id" = latest_retry_run."id";

WITH latest_blocked_run AS (
  SELECT DISTINCT ON (tr."task_id")
    tr."id",
    t."status"
  FROM "task_runs" tr
  JOIN "tasks" t ON t."id" = tr."task_id"
  WHERE t."status" IN (
    'validation_failed',
    'provider_failed',
    'budget_exceeded',
    'iteration_limit_reached',
    'repeated_error_detected',
    'approval_rejected'
  )
  ORDER BY tr."task_id", tr."started_at" DESC NULLS LAST, tr."id" DESC
)
UPDATE "task_runs" tr
SET "run_state_json" = jsonb_build_object(
  'version', 1,
  'status', 'blocked',
  'reason', latest_blocked_run."status"::text
)
FROM latest_blocked_run
WHERE tr."id" = latest_blocked_run."id";
