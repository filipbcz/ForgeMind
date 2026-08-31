CREATE TYPE "WorkerDeviceStatus" AS ENUM ('offline', 'idle', 'reserved', 'running', 'draining', 'revoked');
CREATE TYPE "WorkerSessionStatus" AS ENUM ('active', 'draining', 'cancelled', 'expired', 'closed');
CREATE TYPE "ExecutionJobStatus" AS ENUM ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'expired');
CREATE TYPE "ExecutionLeaseStatus" AS ENUM ('active', 'released', 'expired', 'cancelled');

CREATE TABLE "worker_devices" (
  "id" TEXT PRIMARY KEY, "schema_version" INTEGER NOT NULL DEFAULT 1, "platform" TEXT NOT NULL,
  "runner_version" TEXT NOT NULL, "display_name" TEXT NOT NULL, "status" "WorkerDeviceStatus" NOT NULL DEFAULT 'offline',
  "capabilities" JSONB NOT NULL DEFAULT '[]', "probe_evidence" JSONB NOT NULL DEFAULT '[]', "metadata" JSONB NOT NULL DEFAULT '{}',
  "last_heartbeat_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "worker_sessions" (
  "id" TEXT PRIMARY KEY, "schema_version" INTEGER NOT NULL DEFAULT 1, "device_id" TEXT NOT NULL,
  "status" "WorkerSessionStatus" NOT NULL DEFAULT 'active', "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL, "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "ended_at" TIMESTAMP(3),
  CONSTRAINT "worker_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "worker_devices"("id") ON DELETE CASCADE
);
CREATE TABLE "windows_execution_jobs" (
  "id" TEXT PRIMARY KEY, "schema_version" INTEGER NOT NULL DEFAULT 1, "project_id" TEXT NOT NULL, "task_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL, "status" "ExecutionJobStatus" NOT NULL DEFAULT 'queued',
  "required_capabilities" JSONB NOT NULL DEFAULT '[]', "packet" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "windows_execution_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "windows_execution_jobs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "windows_execution_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "task_runs"("id") ON DELETE CASCADE
);
CREATE TABLE "windows_execution_leases" (
  "id" TEXT PRIMARY KEY, "schema_version" INTEGER NOT NULL DEFAULT 1, "job_id" TEXT NOT NULL, "device_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL, "status" "ExecutionLeaseStatus" NOT NULL DEFAULT 'active',
  "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expires_at" TIMESTAMP(3) NOT NULL, "nonce" TEXT NOT NULL,
  "released_at" TIMESTAMP(3),
  CONSTRAINT "windows_execution_leases_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "windows_execution_jobs"("id") ON DELETE CASCADE,
  CONSTRAINT "windows_execution_leases_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "worker_devices"("id") ON DELETE CASCADE,
  CONSTRAINT "windows_execution_leases_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "worker_sessions"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "windows_execution_leases_one_active_job" ON "windows_execution_leases"("job_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX "windows_execution_leases_session_id_nonce_key" ON "windows_execution_leases"("session_id", "nonce");
CREATE UNIQUE INDEX "worker_sessions_one_open_device" ON "worker_sessions"("device_id") WHERE "status" IN ('active', 'draining');
CREATE INDEX "worker_devices_status_last_heartbeat_at_idx" ON "worker_devices"("status", "last_heartbeat_at");
CREATE INDEX "worker_sessions_device_id_status_expires_at_idx" ON "worker_sessions"("device_id", "status", "expires_at");
CREATE INDEX "windows_execution_jobs_status_created_at_idx" ON "windows_execution_jobs"("status", "created_at");
CREATE INDEX "windows_execution_jobs_task_id_status_idx" ON "windows_execution_jobs"("task_id", "status");
CREATE INDEX "windows_execution_leases_status_expires_at_idx" ON "windows_execution_leases"("status", "expires_at");
CREATE INDEX "windows_execution_leases_session_id_status_idx" ON "windows_execution_leases"("session_id", "status");
