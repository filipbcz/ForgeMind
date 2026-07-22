CREATE TYPE "AiProviderAuthMode" AS ENUM ('api_key', 'codex_oauth');

ALTER TABLE "ai_provider_connections"
  ADD COLUMN "auth_mode" "AiProviderAuthMode" NOT NULL DEFAULT 'api_key',
  ADD COLUMN "codex_home" TEXT,
  ADD COLUMN "account_summary" TEXT;

ALTER TABLE "ai_provider_connections"
  ALTER COLUMN "api_key_ciphertext" DROP NOT NULL,
  ALTER COLUMN "api_key_fingerprint" DROP NOT NULL;
