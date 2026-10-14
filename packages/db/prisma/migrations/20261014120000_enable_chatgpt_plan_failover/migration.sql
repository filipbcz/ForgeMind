-- ChatGPT plan connections are introduced as automatic same-provider failovers.
-- Earlier UI could accidentally inherit the disabled checkbox from an API-key
-- connection while creating the enrollment, leaving the plan unusable.
UPDATE "ai_provider_connections"
SET "automatic_failover" = true,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "auth_mode"::text = 'chatgpt_plan_oauth'
  AND "automatic_failover" = false;
