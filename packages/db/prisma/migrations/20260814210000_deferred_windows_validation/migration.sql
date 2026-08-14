ALTER TYPE "AcceptanceEvidenceStatus" ADD VALUE IF NOT EXISTS 'deferred';

ALTER TABLE "tasks"
ADD COLUMN "deferred_validation_capabilities" JSONB NOT NULL DEFAULT '[]';
