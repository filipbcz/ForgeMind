CREATE TABLE "ai_provider_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "api_key_ciphertext" TEXT NOT NULL,
    "api_key_fingerprint" TEXT NOT NULL,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_provider_connections_user_id_key" ON "ai_provider_connections"("user_id");

ALTER TABLE "ai_provider_connections" ADD CONSTRAINT "ai_provider_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
