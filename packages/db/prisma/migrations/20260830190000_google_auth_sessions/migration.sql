ALTER TABLE "users"
ADD COLUMN "google_subject" TEXT;

CREATE UNIQUE INDEX "users_google_subject_key"
ON "users"("google_subject");

CREATE TABLE "auth_sessions" (
  "token_hash" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("token_hash")
);

CREATE INDEX "auth_sessions_user_id_expires_at_idx"
ON "auth_sessions"("user_id", "expires_at");

CREATE INDEX "auth_sessions_expires_at_idx"
ON "auth_sessions"("expires_at");

ALTER TABLE "auth_sessions"
ADD CONSTRAINT "auth_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
