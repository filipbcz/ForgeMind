ALTER TABLE "ai_provider_connections"
  ADD COLUMN "allowed_models" JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE "ai_provider_connections"
SET "allowed_models" = CASE
  WHEN "provider" IN ('openai', 'codex')
    THEN '["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]'::jsonb
  ELSE jsonb_build_array("model")
END;

ALTER TABLE "tasks"
  ADD COLUMN "model_routing_decision" JSONB;
