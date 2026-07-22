UPDATE "ai_provider_connections"
SET "provider" = 'codex'
WHERE "provider"::text IN ('mock', 'github_copilot', 'local');

UPDATE "task_runs"
SET "provider" = 'codex'
WHERE "provider"::text IN ('mock', 'github_copilot', 'local');

UPDATE "provider_usage"
SET "provider" = 'codex'
WHERE "provider"::text IN ('mock', 'github_copilot', 'local');

CREATE TYPE "ProviderKind_new" AS ENUM ('codex', 'openai');

ALTER TABLE "ai_provider_connections"
  ALTER COLUMN "provider" TYPE "ProviderKind_new"
  USING ("provider"::text::"ProviderKind_new");

ALTER TABLE "task_runs"
  ALTER COLUMN "provider" TYPE "ProviderKind_new"
  USING ("provider"::text::"ProviderKind_new");

ALTER TABLE "provider_usage"
  ALTER COLUMN "provider" TYPE "ProviderKind_new"
  USING ("provider"::text::"ProviderKind_new");

ALTER TYPE "ProviderKind" RENAME TO "ProviderKind_old";
ALTER TYPE "ProviderKind_new" RENAME TO "ProviderKind";
DROP TYPE "ProviderKind_old";
