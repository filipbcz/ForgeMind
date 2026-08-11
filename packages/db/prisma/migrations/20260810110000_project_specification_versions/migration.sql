CREATE TYPE "ProjectSpecificationSource" AS ENUM ('initial_brief', 'approved_extension', 'manual_revision');

CREATE TABLE "project_specification_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "full_specification" TEXT NOT NULL,
    "change_summary" TEXT NOT NULL,
    "source" "ProjectSpecificationSource" NOT NULL,
    "parent_version_id" TEXT,
    "source_cycle_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_specification_versions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "project_roadmap_cycles"
ADD COLUMN "specification_version_id" TEXT;

CREATE UNIQUE INDEX "project_specification_versions_project_id_version_key"
ON "project_specification_versions"("project_id", "version");

CREATE UNIQUE INDEX "project_specification_versions_source_cycle_id_key"
ON "project_specification_versions"("source_cycle_id");

CREATE INDEX "project_specification_versions_project_id_created_at_idx"
ON "project_specification_versions"("project_id", "created_at");

ALTER TABLE "project_specification_versions"
ADD CONSTRAINT "project_specification_versions_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_specification_versions"
ADD CONSTRAINT "project_specification_versions_parent_version_id_fkey"
FOREIGN KEY ("parent_version_id") REFERENCES "project_specification_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_specification_versions"
ADD CONSTRAINT "project_specification_versions_source_cycle_id_fkey"
FOREIGN KEY ("source_cycle_id") REFERENCES "project_roadmap_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_roadmap_cycles"
ADD CONSTRAINT "project_roadmap_cycles_specification_version_id_fkey"
FOREIGN KEY ("specification_version_id") REFERENCES "project_specification_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "project_specification_versions" (
    "id",
    "project_id",
    "version",
    "full_specification",
    "change_summary",
    "source",
    "approved_at",
    "created_at"
)
SELECT
    'spec_' || md5(project."id" || ':v:1'),
    project."id",
    1,
    COALESCE(
        NULLIF(BTRIM(project."brief"), ''),
        (
            SELECT cycle."objective"
            FROM "project_roadmap_cycles" cycle
            WHERE cycle."project_id" = project."id"
            ORDER BY cycle."cycle_number" ASC
            LIMIT 1
        ),
        project."name"
    ),
    'Initial project brief.',
    'initial_brief',
    project."created_at",
    project."created_at"
FROM "projects" project;

INSERT INTO "project_specification_versions" (
    "id",
    "project_id",
    "version",
    "full_specification",
    "change_summary",
    "source",
    "source_cycle_id",
    "approved_at",
    "created_at"
)
SELECT
    'spec_' || md5(cycle."project_id" || ':v:' || cycle."cycle_number"::TEXT),
    cycle."project_id",
    cycle."cycle_number",
    initial."full_specification" || COALESCE((
        SELECT STRING_AGG(
            E'\n\nApproved extension - cycle ' || extension."cycle_number"::TEXT || E':\n' || extension."objective",
            '' ORDER BY extension."cycle_number"
        )
        FROM "project_roadmap_cycles" extension
        WHERE extension."project_id" = cycle."project_id"
          AND extension."cycle_number" BETWEEN 2 AND cycle."cycle_number"
    ), ''),
    'Approved extension for cycle ' || cycle."cycle_number"::TEXT || '.',
    'approved_extension',
    previous_cycle."id",
    cycle."created_at",
    cycle."created_at"
FROM "project_roadmap_cycles" cycle
JOIN "project_specification_versions" initial
  ON initial."project_id" = cycle."project_id" AND initial."version" = 1
LEFT JOIN "project_roadmap_cycles" previous_cycle
  ON previous_cycle."project_id" = cycle."project_id"
 AND previous_cycle."cycle_number" = cycle."cycle_number" - 1
WHERE cycle."cycle_number" > 1;

UPDATE "project_specification_versions" child
SET "parent_version_id" = parent."id"
FROM "project_specification_versions" parent
WHERE parent."project_id" = child."project_id"
  AND parent."version" = child."version" - 1;

UPDATE "project_roadmap_cycles" cycle
SET "specification_version_id" = specification."id"
FROM "project_specification_versions" specification
WHERE specification."project_id" = cycle."project_id"
  AND specification."version" = cycle."cycle_number";
