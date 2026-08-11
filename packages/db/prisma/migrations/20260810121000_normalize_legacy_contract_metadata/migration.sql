WITH normalized AS (
    SELECT
        contract."id",
        jsonb_set(
            contract."contract_json",
            '{requirements}',
            COALESCE((
                SELECT jsonb_agg(
                    requirement || jsonb_build_object(
                        'status', COALESCE(requirement->>'status', 'active'),
                        'introducedInVersion', contract."version",
                        'lastChangedInVersion', contract."version"
                    )
                    ORDER BY requirement_index
                )
                FROM jsonb_array_elements(COALESCE(contract."contract_json"->'requirements', '[]'::jsonb))
                    WITH ORDINALITY AS requirements(requirement, requirement_index)
            ), '[]'::jsonb),
            true
        ) AS contract_json
    FROM "project_contract_versions" contract
    WHERE contract."change_summary" = 'Imported legacy current contract; earlier cycle contract snapshots were not recorded.'
)
UPDATE "project_contract_versions" contract
SET "contract_json" = normalized."contract_json"
FROM normalized
WHERE normalized."id" = contract."id";

UPDATE "projects" project
SET "project_contract" = contract."contract_json"
FROM "project_contract_versions" contract
WHERE contract."id" = project."current_contract_version_id"
  AND contract."change_summary" = 'Imported legacy current contract; earlier cycle contract snapshots were not recorded.';
