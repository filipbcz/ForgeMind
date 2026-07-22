-- Add queue retry metadata
ALTER TABLE "task_queue_jobs"
ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "next_attempt_at" TIMESTAMP(3);

-- New queue claim index to support delayed retries
CREATE INDEX "task_queue_jobs_status_next_attempt_at_created_at_idx"
ON "task_queue_jobs"("status", "next_attempt_at", "created_at");
