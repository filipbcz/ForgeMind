ALTER TABLE "project_audit_jobs"
  ADD COLUMN "gap_proposal" JSONB,
  ADD COLUMN "gap_proposal_status" TEXT,
  ADD COLUMN "gap_proposal_review" JSONB,
  ADD COLUMN "gap_proposal_decided_at" TIMESTAMP(3),
  ADD COLUMN "gap_proposal_history" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "project_audit_jobs"
  ADD CONSTRAINT "project_audit_jobs_gap_proposal_status_check"
  CHECK ("gap_proposal_status" IS NULL OR "gap_proposal_status" IN ('proposed', 'activating', 'activated', 'dismissed'));
