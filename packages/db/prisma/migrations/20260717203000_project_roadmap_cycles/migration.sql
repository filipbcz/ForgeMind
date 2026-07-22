ALTER TABLE "projects"
ADD COLUMN "brief" TEXT;

CREATE TYPE "ProjectRoadmapCycleStatus" AS ENUM ('active', 'awaiting_extension_approval', 'completed');
CREATE TYPE "ProjectImplementationStepStatus" AS ENUM ('pending', 'running', 'completed', 'cancelled');

CREATE TABLE "project_roadmap_cycles" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "cycle_number" INTEGER NOT NULL,
  "objective" TEXT NOT NULL,
  "extension_proposal" TEXT,
  "status" "ProjectRoadmapCycleStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "project_roadmap_cycles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_implementation_steps" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "cycle_id" TEXT NOT NULL,
  "sequence_number" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "acceptance_criteria" JSONB NOT NULL,
  "status" "ProjectImplementationStepStatus" NOT NULL DEFAULT 'pending',
  "task_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "project_implementation_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_roadmap_cycles_project_id_cycle_number_key" ON "project_roadmap_cycles"("project_id", "cycle_number");
CREATE INDEX "project_roadmap_cycles_project_id_status_idx" ON "project_roadmap_cycles"("project_id", "status");
CREATE UNIQUE INDEX "project_implementation_steps_cycle_id_sequence_number_key" ON "project_implementation_steps"("cycle_id", "sequence_number");
CREATE UNIQUE INDEX "project_implementation_steps_task_id_key" ON "project_implementation_steps"("task_id");
CREATE INDEX "project_implementation_steps_project_id_status_idx" ON "project_implementation_steps"("project_id", "status");

ALTER TABLE "project_roadmap_cycles"
ADD CONSTRAINT "project_roadmap_cycles_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_implementation_steps"
ADD CONSTRAINT "project_implementation_steps_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_implementation_steps"
ADD CONSTRAINT "project_implementation_steps_cycle_id_fkey"
FOREIGN KEY ("cycle_id") REFERENCES "project_roadmap_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_implementation_steps"
ADD CONSTRAINT "project_implementation_steps_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
