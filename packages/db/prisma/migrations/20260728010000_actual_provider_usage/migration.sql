ALTER TABLE "task_runs"
  ADD COLUMN "total_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "usage_source" TEXT NOT NULL DEFAULT 'estimated',
  ADD COLUMN "actual_cost_usd" DECIMAL(10,4);

UPDATE "task_runs"
SET "total_tokens" = "input_tokens" + "output_tokens";

ALTER TABLE "provider_usage"
  ADD COLUMN "phase" TEXT,
  ADD COLUMN "attempt" INTEGER,
  ADD COLUMN "total_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "usage_source" TEXT NOT NULL DEFAULT 'estimated',
  ADD COLUMN "actual_cost_usd" DECIMAL(10,4);

UPDATE "provider_usage"
SET "total_tokens" = "input_tokens" + "output_tokens";
