CREATE TYPE "ChatThreadStatus" AS ENUM ('active', 'archived');
CREATE TYPE "ChatRunStatus" AS ENUM ('queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled', 'interrupted');
CREATE TYPE "ChatMessageRole" AS ENUM ('user', 'assistant', 'system');

CREATE TABLE "chat_threads" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "project_id" TEXT,
  "provider_connection_id" TEXT,
  "title" TEXT NOT NULL,
  "status" "ChatThreadStatus" NOT NULL DEFAULT 'active',
  "mode" "TaskMode" NOT NULL DEFAULT 'safe',
  "repository_owner" TEXT,
  "repository_name" TEXT,
  "base_branch" TEXT,
  "branch_name" TEXT,
  "context_summary" TEXT,
  "provider_session_id" TEXT,
  "provider_session_provider" "ProviderKind",
  "provider_session_model" TEXT,
  "provider_session_connection_id" TEXT,
  "provider_session_updated_at" TIMESTAMP(3),
  "last_message_at" TIMESTAMP(3),
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_runs" (
  "id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "status" "ChatRunStatus" NOT NULL DEFAULT 'queued',
  "prompt" TEXT NOT NULL,
  "provider" "ProviderKind",
  "model" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "cached_tokens" INTEGER NOT NULL DEFAULT 0,
  "actual_cost_usd" DECIMAL(10,4),
  "error_message" TEXT,
  "response_summary" TEXT,
  "result_json" JSONB,
  "stop_requested" BOOLEAN NOT NULL DEFAULT false,
  "next_attempt_at" TIMESTAMP(3),
  "claimed_at" TIMESTAMP(3),
  "heartbeat_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_messages" (
  "id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "run_id" TEXT,
  "sequence" INTEGER NOT NULL,
  "role" "ChatMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "metadata_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_approvals" (
  "id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "type" "ApprovalType" NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
  "requested_by" TEXT NOT NULL,
  "approved_by_user_id" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "risk_level" "RiskLevel" NOT NULL,
  "payload_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "chat_approvals_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "audit_log" ADD COLUMN "chat_thread_id" TEXT;
ALTER TABLE "audit_log" ADD COLUMN "chat_run_id" TEXT;

CREATE INDEX "chat_threads_user_id_status_updated_at_idx" ON "chat_threads"("user_id", "status", "updated_at");
CREATE INDEX "chat_threads_project_id_idx" ON "chat_threads"("project_id");
CREATE INDEX "chat_runs_status_next_attempt_at_created_at_idx" ON "chat_runs"("status", "next_attempt_at", "created_at");
CREATE INDEX "chat_runs_thread_id_created_at_idx" ON "chat_runs"("thread_id", "created_at");
CREATE UNIQUE INDEX "chat_runs_one_active_per_thread_idx"
  ON "chat_runs"("thread_id")
  WHERE "status" IN ('queued', 'running', 'waiting_for_approval');
CREATE UNIQUE INDEX "chat_messages_thread_id_sequence_key" ON "chat_messages"("thread_id", "sequence");
CREATE INDEX "chat_messages_thread_id_created_at_idx" ON "chat_messages"("thread_id", "created_at");
CREATE INDEX "chat_messages_run_id_idx" ON "chat_messages"("run_id");
CREATE INDEX "chat_approvals_thread_id_status_idx" ON "chat_approvals"("thread_id", "status");
CREATE INDEX "chat_approvals_run_id_status_idx" ON "chat_approvals"("run_id", "status");
CREATE INDEX "audit_log_chat_thread_id_created_at_idx" ON "audit_log"("chat_thread_id", "created_at");
CREATE INDEX "audit_log_chat_run_id_created_at_idx" ON "audit_log"("chat_run_id", "created_at");

ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "ai_provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "chat_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat_approvals" ADD CONSTRAINT "chat_approvals_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_approvals" ADD CONSTRAINT "chat_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "chat_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_approvals" ADD CONSTRAINT "chat_approvals_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chat_thread_id_fkey" FOREIGN KEY ("chat_thread_id") REFERENCES "chat_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chat_run_id_fkey" FOREIGN KEY ("chat_run_id") REFERENCES "chat_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
