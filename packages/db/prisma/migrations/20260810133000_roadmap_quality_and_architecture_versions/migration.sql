CREATE TYPE "ProjectArchitectureVersionSource" AS ENUM (
  'initial_plan',
  'approved_extension',
  'task_update',
  'legacy_import'
);

ALTER TABLE "projects"
  ADD COLUMN "current_architecture_version_id" TEXT;

ALTER TABLE "tasks"
  ADD COLUMN "architecture_version_id" TEXT;

ALTER TABLE "project_roadmap_cycles"
  ADD COLUMN "architecture_version_id" TEXT;

ALTER TABLE "project_implementation_steps"
  ADD COLUMN "change_rationale" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "depends_on_step_titles" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "validation_focus" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "project_architecture_versions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "architecture_json" JSONB NOT NULL,
  "architecture_update" JSONB,
  "change_summary" TEXT NOT NULL,
  "source" "ProjectArchitectureVersionSource" NOT NULL,
  "parent_version_id" TEXT,
  "contract_version_id" TEXT,
  "source_task_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_architecture_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_architecture_versions_project_id_version_key"
  ON "project_architecture_versions"("project_id", "version");
CREATE INDEX "project_architecture_versions_project_id_created_at_idx"
  ON "project_architecture_versions"("project_id", "created_at");
CREATE UNIQUE INDEX "projects_current_architecture_version_id_key"
  ON "projects"("current_architecture_version_id");
INSERT INTO "project_architecture_versions" (
  "id", "project_id", "version", "architecture_json", "change_summary", "source", "created_at"
)
SELECT
  gen_random_uuid()::text,
  "id",
  1,
  "project_architecture",
  'Imported current architecture; earlier architecture history was not recorded.',
  'legacy_import'::"ProjectArchitectureVersionSource",
  "updated_at"
FROM "projects"
WHERE "project_architecture" IS NOT NULL;

UPDATE "projects" AS project
SET "current_architecture_version_id" = version."id"
FROM "project_architecture_versions" AS version
WHERE version."project_id" = project."id";

UPDATE "project_roadmap_cycles" AS cycle
SET "architecture_version_id" = project."current_architecture_version_id"
FROM "projects" AS project
WHERE project."id" = cycle."project_id";

UPDATE "tasks" AS task
SET "architecture_version_id" = project."current_architecture_version_id"
FROM "projects" AS project
WHERE project."id" = task."project_id";

ALTER TABLE "project_architecture_versions"
  ADD CONSTRAINT "project_architecture_versions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_architecture_versions_parent_version_id_fkey"
  FOREIGN KEY ("parent_version_id") REFERENCES "project_architecture_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "project_architecture_versions_contract_version_id_fkey"
  FOREIGN KEY ("contract_version_id") REFERENCES "project_contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "project_architecture_versions_source_task_id_fkey"
  FOREIGN KEY ("source_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_current_architecture_version_id_fkey"
  FOREIGN KEY ("current_architecture_version_id") REFERENCES "project_architecture_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_roadmap_cycles"
  ADD CONSTRAINT "project_roadmap_cycles_architecture_version_id_fkey"
  FOREIGN KEY ("architecture_version_id") REFERENCES "project_architecture_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_architecture_version_id_fkey"
  FOREIGN KEY ("architecture_version_id") REFERENCES "project_architecture_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
