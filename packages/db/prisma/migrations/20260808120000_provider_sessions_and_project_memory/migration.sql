ALTER TABLE "projects"
ADD COLUMN "project_memory" JSONB,
ADD COLUMN "project_architecture" JSONB,
ADD COLUMN "planning_session_id" TEXT,
ADD COLUMN "planning_session_provider" "ProviderKind",
ADD COLUMN "planning_session_model" TEXT,
ADD COLUMN "planning_session_connection_id" TEXT,
ADD COLUMN "planning_session_updated_at" TIMESTAMP(3);

ALTER TABLE "tasks"
ADD COLUMN "provider_session_id" TEXT,
ADD COLUMN "provider_session_provider" "ProviderKind",
ADD COLUMN "provider_session_model" TEXT,
ADD COLUMN "provider_session_connection_id" TEXT,
ADD COLUMN "provider_session_updated_at" TIMESTAMP(3);
