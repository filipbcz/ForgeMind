ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'waiting_for_capability';
ALTER TYPE "ProjectImplementationStepStatus" ADD VALUE IF NOT EXISTS 'waiting_for_capability';

ALTER TABLE "tasks"
ADD COLUMN "waiting_for_capabilities" JSONB NOT NULL DEFAULT '[]';
