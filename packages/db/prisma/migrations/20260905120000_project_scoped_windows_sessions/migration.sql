ALTER TABLE "worker_sessions"
ADD COLUMN "authorized_project_ids" JSONB NOT NULL DEFAULT '[]'::jsonb;

