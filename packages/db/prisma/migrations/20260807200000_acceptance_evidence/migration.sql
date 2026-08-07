CREATE TYPE "AcceptanceEvidenceSource" AS ENUM ('validation_command', 'github_check', 'repository_audit', 'artifact');
CREATE TYPE "AcceptanceEvidenceStatus" AS ENUM ('passed', 'failed', 'blocked');

CREATE TABLE "acceptance_evidence" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "cycle_id" TEXT NOT NULL,
  "step_id" TEXT,
  "task_id" TEXT,
  "task_run_id" TEXT,
  "requirement_id" TEXT NOT NULL,
  "criterion_key" TEXT NOT NULL,
  "criterion" TEXT NOT NULL,
  "source" "AcceptanceEvidenceSource" NOT NULL,
  "status" "AcceptanceEvidenceStatus" NOT NULL,
  "evidence_key" TEXT NOT NULL,
  "contract_version" INTEGER NOT NULL,
  "commit_sha" TEXT,
  "command" TEXT,
  "exit_code" INTEGER,
  "details_url" TEXT,
  "payload_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "acceptance_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "acceptance_evidence_cycle_id_requirement_id_criterion_key_source_evidence_key_key"
ON "acceptance_evidence"("cycle_id", "requirement_id", "criterion_key", "source", "evidence_key");
CREATE INDEX "acceptance_evidence_project_id_cycle_id_requirement_id_idx"
ON "acceptance_evidence"("project_id", "cycle_id", "requirement_id");
CREATE INDEX "acceptance_evidence_task_id_idx" ON "acceptance_evidence"("task_id");

ALTER TABLE "acceptance_evidence"
ADD CONSTRAINT "acceptance_evidence_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "acceptance_evidence"
ADD CONSTRAINT "acceptance_evidence_cycle_id_fkey"
FOREIGN KEY ("cycle_id") REFERENCES "project_roadmap_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "acceptance_evidence"
ADD CONSTRAINT "acceptance_evidence_step_id_fkey"
FOREIGN KEY ("step_id") REFERENCES "project_implementation_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "acceptance_evidence"
ADD CONSTRAINT "acceptance_evidence_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "acceptance_evidence"
ADD CONSTRAINT "acceptance_evidence_task_run_id_fkey"
FOREIGN KEY ("task_run_id") REFERENCES "task_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
