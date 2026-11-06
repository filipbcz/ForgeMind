ALTER TABLE "project_implementation_steps"
  ADD COLUMN "execution_intent" JSONB;

ALTER TABLE "tasks"
  ADD COLUMN "execution_intent" JSONB;
