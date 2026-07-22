-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'operator');

-- CreateEnum
CREATE TYPE "TaskMode" AS ENUM ('safe', 'auto', 'full_auto');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('draft', 'submitted', 'planning', 'waiting_for_plan_approval', 'creating_github_issue', 'creating_branch', 'running_ai', 'validating', 'reviewing', 'improving', 'needs_approval', 'creating_pr', 'ready_for_user_review', 'completed', 'failed', 'cancelled', 'budget_exceeded', 'iteration_limit_reached', 'repeated_error_detected', 'approval_rejected', 'provider_failed', 'validation_failed');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('codex', 'openai');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "QueueJobStatus" AS ENUM ('pending', 'claimed', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "IterationPhase" AS ENUM ('planning', 'implementation', 'validation', 'review', 'approval', 'pr_creation');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('budget_increase', 'continue_after_iteration_limit', 'new_dependency', 'risky_refactor', 'database_migration', 'config_change', 'deploy_staging', 'deploy_production', 'merge_pr', 'delete_files', 'github_workflow_change', 'systemd_change', 'nginx_config_change', 'write_outside_repo');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'agent', 'system', 'github');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "github_user_id" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "github_owner" TEXT NOT NULL,
    "github_repo" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "config_yaml" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "mode" "TaskMode" NOT NULL DEFAULT 'safe',
    "status" "TaskStatus" NOT NULL DEFAULT 'draft',
    "github_issue_number" INTEGER,
    "github_issue_url" TEXT,
    "branch_name" TEXT,
    "pull_request_number" INTEGER,
    "pull_request_url" TEXT,
    "max_iterations" INTEGER NOT NULL DEFAULT 10,
    "max_budget_usd" DECIMAL(10,2) NOT NULL DEFAULT 2.00,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_queue_jobs" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "status" "QueueJobStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "task_queue_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_runs" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "iteration_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DECIMAL(10,4) NOT NULL DEFAULT 0.00,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "summary" TEXT,
    "error_message" TEXT,
    CONSTRAINT "task_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_iterations" (
    "id" TEXT NOT NULL,
    "task_run_id" TEXT NOT NULL,
    "iteration_number" INTEGER NOT NULL,
    "phase" "IterationPhase" NOT NULL,
    "prompt" TEXT NOT NULL,
    "result_summary" TEXT NOT NULL,
    "diff_stat_json" JSONB NOT NULL,
    "validation_result_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_iterations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
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
    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_usage" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "task_run_id" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "credits" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "estimated_cost_usd" DECIMAL(10,4) NOT NULL DEFAULT 0.00,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" TEXT,
    "event_type" TEXT NOT NULL,
    "project_id" TEXT,
    "task_id" TEXT,
    "payload_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_user_id_key" ON "users"("github_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "tasks_project_id_status_idx" ON "tasks"("project_id", "status");

-- CreateIndex
CREATE INDEX "task_queue_jobs_status_created_at_idx" ON "task_queue_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "task_runs_task_id_status_idx" ON "task_runs"("task_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "task_iterations_task_run_id_iteration_number_phase_key" ON "task_iterations"("task_run_id", "iteration_number", "phase");

-- CreateIndex
CREATE INDEX "approvals_task_id_status_idx" ON "approvals"("task_id", "status");

-- CreateIndex
CREATE INDEX "provider_usage_provider_created_at_idx" ON "provider_usage"("provider", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_event_type_created_at_idx" ON "audit_log"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_task_id_created_at_idx" ON "audit_log"("task_id", "created_at");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_queue_jobs" ADD CONSTRAINT "task_queue_jobs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_iterations" ADD CONSTRAINT "task_iterations_task_run_id_fkey" FOREIGN KEY ("task_run_id") REFERENCES "task_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_task_run_id_fkey" FOREIGN KEY ("task_run_id") REFERENCES "task_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
