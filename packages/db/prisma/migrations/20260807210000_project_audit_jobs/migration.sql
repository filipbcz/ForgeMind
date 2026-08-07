ALTER TYPE "ProjectRoadmapCycleStatus" ADD VALUE IF NOT EXISTS 'verifying';
ALTER TYPE "ProjectRoadmapCycleStatus" ADD VALUE IF NOT EXISTS 'partial';
ALTER TYPE "ProjectRoadmapCycleStatus" ADD VALUE IF NOT EXISTS 'blocked';

CREATE TYPE "ProjectAuditJobStatus" AS ENUM ('pending', 'claimed', 'succeeded', 'blocked', 'failed');

CREATE TABLE "project_audit_jobs" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "cycle_id" TEXT NOT NULL,
  "trigger_task_id" TEXT,
  "requirement_ids" JSONB NOT NULL DEFAULT '[]',
  "status" "ProjectAuditJobStatus" NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "claimed_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),

  CONSTRAINT "project_audit_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_audit_jobs_cycle_id_key" ON "project_audit_jobs"("cycle_id");
CREATE INDEX "project_audit_jobs_status_next_attempt_at_created_at_idx"
ON "project_audit_jobs"("status", "next_attempt_at", "created_at");

ALTER TABLE "project_audit_jobs"
ADD CONSTRAINT "project_audit_jobs_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_audit_jobs"
ADD CONSTRAINT "project_audit_jobs_cycle_id_fkey"
FOREIGN KEY ("cycle_id") REFERENCES "project_roadmap_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
