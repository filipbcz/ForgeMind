ALTER TABLE "projects"
ADD COLUMN "auto_create_pull_request" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "auto_merge_pull_request" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "auto_complete_task" BOOLEAN NOT NULL DEFAULT false;
