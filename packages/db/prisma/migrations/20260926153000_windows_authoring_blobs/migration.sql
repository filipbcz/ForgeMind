CREATE TABLE "windows_authoring_blobs" (
  "job_id" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "content" BYTEA NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "windows_authoring_blobs_pkey" PRIMARY KEY ("job_id", "sha256")
);

CREATE TABLE "windows_authoring_blob_chunks" (
  "job_id" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "chunk_index" INTEGER NOT NULL,
  "total_chunks" INTEGER NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "content" BYTEA NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "windows_authoring_blob_chunks_pkey" PRIMARY KEY ("job_id", "sha256", "chunk_index")
);

CREATE INDEX "windows_authoring_blob_chunks_job_id_sha256_idx"
  ON "windows_authoring_blob_chunks"("job_id", "sha256");

ALTER TABLE "windows_authoring_blobs"
  ADD CONSTRAINT "windows_authoring_blobs_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "windows_execution_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "windows_authoring_blob_chunks"
  ADD CONSTRAINT "windows_authoring_blob_chunks_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "windows_execution_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
