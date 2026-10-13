ALTER TYPE "AiProviderAuthMode" ADD VALUE IF NOT EXISTS 'chatgpt_plan_oauth';

ALTER TABLE "ai_provider_connections"
  ADD COLUMN "automatic_failover" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "failover_priority" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "oauth_client_id" TEXT,
  ADD COLUMN "oauth_subject" TEXT,
  ADD COLUMN "oauth_issuer" TEXT,
  ADD COLUMN "oauth_host_id" TEXT,
  ADD COLUMN "oauth_scopes" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "oauth_access_token_ciphertext" TEXT,
  ADD COLUMN "oauth_refresh_token_ciphertext" TEXT,
  ADD COLUMN "oauth_id_token_ciphertext" TEXT,
  ADD COLUMN "oauth_expires_at" TIMESTAMP(3);

CREATE TABLE "ai_provider_oauth_enrollments" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "upload_token_hash" TEXT,
  "name" TEXT NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "automatic_failover" BOOLEAN NOT NULL DEFAULT true,
  "failover_priority" INTEGER NOT NULL DEFAULT 100,
  "host_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "exchanged_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_provider_oauth_enrollments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_provider_oauth_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ai_provider_oauth_enrollments_code_hash_key" ON "ai_provider_oauth_enrollments"("code_hash");
CREATE UNIQUE INDEX "ai_provider_oauth_enrollments_upload_token_hash_key" ON "ai_provider_oauth_enrollments"("upload_token_hash");
CREATE INDEX "ai_provider_oauth_enrollments_user_id_expires_at_idx" ON "ai_provider_oauth_enrollments"("user_id", "expires_at");
