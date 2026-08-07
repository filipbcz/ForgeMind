ALTER TABLE "projects"
ADD COLUMN "project_contract" JSONB;

ALTER TABLE "project_implementation_steps"
ADD COLUMN "requirement_ids" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "deliverables" JSONB NOT NULL DEFAULT '[]';
