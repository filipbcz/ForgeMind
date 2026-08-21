\set ON_ERROR_STOP on
\if :{?schema}
SET search_path TO :"schema", public;
\endif

-- @forgemind-supported-previous-migration: 20260814120000_worker_capability_gates
-- This fixture represents the supported previous PostgreSQL schema by replaying
-- migrations up to the marker above. The migration validator applies newer
-- migrations on top of this fixture to prove forward compatibility.

BEGIN;
\ir ../../packages/db/prisma/migrations/20260702211000_init/migration.sql
\ir ../../packages/db/prisma/migrations/20260703155500_queue_retry_metadata/migration.sql
\ir ../../packages/db/prisma/migrations/20260703173000_github_connection_project_repo/migration.sql
\ir ../../packages/db/prisma/migrations/20260704010000_ai_provider_connection/migration.sql
\ir ../../packages/db/prisma/migrations/20260705090000_ai_provider_oauth/migration.sql
\ir ../../packages/db/prisma/migrations/20260712230000_task_iteration_provider_audit/migration.sql
\ir ../../packages/db/prisma/migrations/20260713103000_remove_mock_provider_kind/migration.sql
\ir ../../packages/db/prisma/migrations/20260717203000_project_roadmap_cycles/migration.sql
\ir ../../packages/db/prisma/migrations/20260717211500_notification_settings/migration.sql
\ir ../../packages/db/prisma/migrations/20260718230000_project_git_automation/migration.sql
\ir ../../packages/db/prisma/migrations/20260718234500_project_safe_operation_approvals/migration.sql
\ir ../../packages/db/prisma/migrations/20260718235500_project_default_task_mode/migration.sql
\ir ../../packages/db/prisma/migrations/20260728010000_actual_provider_usage/migration.sql
\ir ../../packages/db/prisma/migrations/20260802210000_worker_queue_control/migration.sql
\ir ../../packages/db/prisma/migrations/20260804140000_multiple_ai_provider_connections/migration.sql
\ir ../../packages/db/prisma/migrations/20260807190000_project_contract_and_step_traceability/migration.sql
\ir ../../packages/db/prisma/migrations/20260807200000_acceptance_evidence/migration.sql
\ir ../../packages/db/prisma/migrations/20260807210000_project_audit_jobs/migration.sql
\ir ../../packages/db/prisma/migrations/20260808120000_provider_sessions_and_project_memory/migration.sql
\ir ../../packages/db/prisma/migrations/20260810110000_project_specification_versions/migration.sql
\ir ../../packages/db/prisma/migrations/20260810114500_project_contract_versions/migration.sql
\ir ../../packages/db/prisma/migrations/20260810121000_normalize_legacy_contract_metadata/migration.sql
\ir ../../packages/db/prisma/migrations/20260810133000_roadmap_quality_and_architecture_versions/migration.sql
\ir ../../packages/db/prisma/migrations/20260810134500_unique_architecture_source_task/migration.sql
\ir ../../packages/db/prisma/migrations/20260810150000_validation_profiles_and_task_checkpoints/migration.sql
\ir ../../packages/db/prisma/migrations/20260814120000_worker_capability_gates/migration.sql
COMMIT;
