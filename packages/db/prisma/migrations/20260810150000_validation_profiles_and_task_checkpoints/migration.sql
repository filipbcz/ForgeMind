ALTER TABLE "projects"
ADD COLUMN "validation_profile" JSONB;

CREATE TYPE "TaskCheckpointStatus" AS ENUM ('started', 'completed', 'failed');

CREATE TABLE "task_checkpoints" (
    "id" UUID NOT NULL,
    "task_id" TEXT NOT NULL,
    "task_run_id" TEXT,
    "key" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "status" "TaskCheckpointStatus" NOT NULL DEFAULT 'started',
    "input_hash" TEXT NOT NULL,
    "output_json" JSONB,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_checkpoints_task_id_key_key"
ON "task_checkpoints"("task_id", "key");

CREATE INDEX "task_checkpoints_task_id_status_idx"
ON "task_checkpoints"("task_id", "status");

ALTER TABLE "task_checkpoints"
ADD CONSTRAINT "task_checkpoints_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_checkpoints"
ADD CONSTRAINT "task_checkpoints_task_run_id_fkey"
FOREIGN KEY ("task_run_id") REFERENCES "task_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
