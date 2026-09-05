ALTER TABLE "windows_execution_jobs"
ADD COLUMN "wait_reason" TEXT,
ADD COLUMN "pending_phase" TEXT NOT NULL DEFAULT 'validate';

ALTER TABLE "windows_execution_jobs"
ADD CONSTRAINT "windows_execution_jobs_pending_phase_check"
CHECK ("pending_phase" IN ('probe', 'author', 'validate', 'package'));

ALTER TABLE "windows_execution_jobs"
ADD CONSTRAINT "windows_execution_jobs_wait_reason_check"
CHECK ("wait_reason" IS NULL OR "wait_reason" IN ('unavailable_capability', 'insufficient_capacity'));
