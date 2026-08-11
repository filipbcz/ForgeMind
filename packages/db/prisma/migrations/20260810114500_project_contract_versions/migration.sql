CREATE TYPE "ProjectContractVersionSource" AS ENUM ('initial_plan', 'approved_extension', 'manual_regeneration');

CREATE TABLE "project_contract_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "specification_version_id" TEXT,
    "version" INTEGER NOT NULL,
    "contract_json" JSONB NOT NULL,
    "contract_delta" JSONB,
    "change_summary" TEXT NOT NULL,
    "source" "ProjectContractVersionSource" NOT NULL,
    "parent_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_contract_versions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "projects" ADD COLUMN "current_contract_version_id" TEXT;
ALTER TABLE "project_roadmap_cycles" ADD COLUMN "contract_version_id" TEXT;

CREATE UNIQUE INDEX "project_contract_versions_project_id_version_key"
ON "project_contract_versions"("project_id", "version");

CREATE INDEX "project_contract_versions_project_id_created_at_idx"
ON "project_contract_versions"("project_id", "created_at");

CREATE UNIQUE INDEX "projects_current_contract_version_id_key"
ON "projects"("current_contract_version_id");

ALTER TABLE "project_contract_versions"
ADD CONSTRAINT "project_contract_versions_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_contract_versions"
ADD CONSTRAINT "project_contract_versions_specification_version_id_fkey"
FOREIGN KEY ("specification_version_id") REFERENCES "project_specification_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_contract_versions"
ADD CONSTRAINT "project_contract_versions_parent_version_id_fkey"
FOREIGN KEY ("parent_version_id") REFERENCES "project_contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "projects"
ADD CONSTRAINT "projects_current_contract_version_id_fkey"
FOREIGN KEY ("current_contract_version_id") REFERENCES "project_contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_roadmap_cycles"
ADD CONSTRAINT "project_roadmap_cycles_contract_version_id_fkey"
FOREIGN KEY ("contract_version_id") REFERENCES "project_contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

WITH legacy_projects AS (
    SELECT
        project."id" AS project_id,
        COALESCE((project."project_contract"->>'version')::INTEGER, 1) AS version,
        project."project_contract"::jsonb AS contract_json,
        project."updated_at" AS created_at,
        (
            SELECT specification."id"
            FROM "project_specification_versions" specification
            WHERE specification."project_id" = project."id"
            ORDER BY specification."version" DESC
            LIMIT 1
        ) AS specification_version_id
    FROM "projects" project
    WHERE project."project_contract" IS NOT NULL
), normalized AS (
    SELECT
        legacy_projects.*,
        jsonb_set(
            jsonb_set(contract_json, '{version}', to_jsonb(version), true),
            '{requirements}',
            COALESCE((
                SELECT jsonb_agg(
                    requirement || jsonb_build_object(
                        'status', COALESCE(requirement->>'status', 'active'),
                        'introducedInVersion', COALESCE((requirement->>'introducedInVersion')::INTEGER, 1),
                        'lastChangedInVersion', COALESCE((requirement->>'lastChangedInVersion')::INTEGER, version)
                    )
                    ORDER BY requirement_index
                )
                FROM jsonb_array_elements(COALESCE(contract_json->'requirements', '[]'::jsonb))
                    WITH ORDINALITY AS requirements(requirement, requirement_index)
            ), '[]'::jsonb),
            true
        ) AS normalized_contract
    FROM legacy_projects
)
INSERT INTO "project_contract_versions" (
    "id", "project_id", "specification_version_id", "version", "contract_json",
    "change_summary", "source", "created_at"
)
SELECT
    'contract_' || md5(normalized."project_id" || ':v:' || normalized.version::TEXT),
    normalized."project_id",
    normalized."specification_version_id",
    normalized.version,
    normalized.normalized_contract,
    'Imported legacy current contract; earlier cycle contract snapshots were not recorded.',
    CASE WHEN normalized.version = 1
        THEN 'initial_plan'::"ProjectContractVersionSource"
        ELSE 'manual_regeneration'::"ProjectContractVersionSource"
    END,
    normalized."created_at"
FROM normalized;

UPDATE "projects" project
SET
    "current_contract_version_id" = contract."id",
    "project_contract" = contract."contract_json"
FROM "project_contract_versions" contract
WHERE contract."project_id" = project."id";

UPDATE "project_roadmap_cycles" cycle
SET "contract_version_id" = project."current_contract_version_id"
FROM "projects" project
WHERE project."id" = cycle."project_id";
