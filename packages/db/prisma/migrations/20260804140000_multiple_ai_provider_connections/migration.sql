ALTER TYPE "ProviderKind" ADD VALUE IF NOT EXISTS 'github_copilot';

ALTER TABLE "ai_provider_connections"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ai_provider_connections"
SET
  "name" = CASE
    WHEN "auth_mode" = 'codex_oauth' THEN 'Codex OAuth'
    ELSE initcap("provider"::text) || ' API key'
  END,
  "is_default" = true
WHERE "name" IS NULL;

ALTER TABLE "ai_provider_connections"
  ALTER COLUMN "name" SET NOT NULL;

DROP INDEX IF EXISTS "ai_provider_connections_user_id_key";

CREATE UNIQUE INDEX "ai_provider_connections_user_id_name_key"
  ON "ai_provider_connections"("user_id", "name");

CREATE INDEX "ai_provider_connections_user_id_is_default_idx"
  ON "ai_provider_connections"("user_id", "is_default");

ALTER TABLE "projects"
  ADD COLUMN "ai_provider_connection_id" TEXT;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_ai_provider_connection_id_fkey"
  FOREIGN KEY ("ai_provider_connection_id")
  REFERENCES "ai_provider_connections"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
