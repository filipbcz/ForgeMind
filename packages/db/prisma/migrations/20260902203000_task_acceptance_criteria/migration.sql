ALTER TABLE "tasks"
ADD COLUMN "acceptance_criteria" JSONB NOT NULL DEFAULT '[]';
