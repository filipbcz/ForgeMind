UPDATE "project_implementation_steps" AS "step"
SET
  "status" = 'cancelled',
  "completed_at" = NULL,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "step"."status" = 'pending'
  AND EXISTS (
    SELECT 1
    FROM "project_roadmap_cycles" AS "current_cycle"
    JOIN "project_roadmap_cycles" AS "newer_cycle"
      ON "newer_cycle"."project_id" = "current_cycle"."project_id"
      AND "newer_cycle"."cycle_number" > "current_cycle"."cycle_number"
    WHERE "current_cycle"."id" = "step"."cycle_id"
  );
