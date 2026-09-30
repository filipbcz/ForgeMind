ALTER TABLE "provider_usage"
  ADD COLUMN "request_id" TEXT,
  ADD COLUMN "client_request_id" TEXT,
  ADD COLUMN "pricing_version" TEXT;

CREATE INDEX "provider_usage_request_id_idx" ON "provider_usage"("request_id");

ALTER TABLE "chat_runs"
  ALTER COLUMN "actual_cost_usd" TYPE DECIMAL(14,8);

ALTER TABLE "task_runs"
  ALTER COLUMN "estimated_cost_usd" TYPE DECIMAL(14,8),
  ALTER COLUMN "actual_cost_usd" TYPE DECIMAL(14,8);

ALTER TABLE "provider_usage"
  ALTER COLUMN "estimated_cost_usd" TYPE DECIMAL(14,8),
  ALTER COLUMN "actual_cost_usd" TYPE DECIMAL(14,8);
