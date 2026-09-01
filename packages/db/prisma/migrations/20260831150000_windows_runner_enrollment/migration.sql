CREATE TABLE "worker_enrollments" (
  "id" TEXT NOT NULL, "device_id" TEXT NOT NULL, "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL, "used_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "worker_enrollments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "worker_enrollments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "worker_devices"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "worker_enrollments_code_hash_key" ON "worker_enrollments"("code_hash");
CREATE INDEX "worker_enrollments_device_id_expires_at_idx" ON "worker_enrollments"("device_id", "expires_at");

CREATE TABLE "worker_credentials" (
  "id" TEXT NOT NULL, "device_id" TEXT NOT NULL, "token_hash" TEXT NOT NULL, "scope" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revoked_at" TIMESTAMP(3),
  CONSTRAINT "worker_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "worker_credentials_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "worker_devices"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "worker_credentials_token_hash_key" ON "worker_credentials"("token_hash");
CREATE INDEX "worker_credentials_device_id_revoked_at_idx" ON "worker_credentials"("device_id", "revoked_at");
