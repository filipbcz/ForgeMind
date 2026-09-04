# Platform qualification scenarios

This suite defines repeatable, secret-free platform qualification scenarios that must exist before the manual final audit can be treated as available evidence. The scenarios cover the platform behavior requested for vNext qualification only; they do not run BOREK-FILIP validation, production deployment, merge, or final audit.

Run the contract check:

```sh
node qualification/platform-scenarios/validate.mjs
```

The command prints deterministic JSON evidence with per-scenario definition hashes. Store run outputs outside the repository, for example under `.forgemind/qualification/platform-scenarios/`, when executing a real qualification pass.

## Evidence rules

- Evidence must contain no credentials, bearer headers, cookies, private keys, provider payload bodies, or raw environment values.
- Diagnostic exports must pass through central redaction before attachment.
- Artifacts should be bounded transcripts, state timelines, record counts, hashes, and audit event identifiers.
- Real runs must reference exact commits. Scenario definitions are stable and versioned in `qualification/platform-scenarios/scenarios.mjs`.
- Fixture scenario evidence proves only typed execution and safe upload. It cannot unlock final audit or claim physical verification by itself; a `production-verified` BOREK-FILIP claim needs a successful canonical `borek-filip` execution for the exact revision plus real device, manual session, local probe and artifact provenance. This physical run is deferred and is not a runtime approval gate.
- Manual final audit remains a user action after qualification evidence exists.

## Scenario catalog

### success-roadmap-step

Expected states: submitted task, pending queue job, claimed queue job, running run, in-progress task, ready-for-review task, completed task, succeeded queue job, succeeded run.

Expected audit events: task submission, queue job creation and claim, run start, iteration completion, validation completion, GitHub operation completion, task completion, queue finalization.

Recovery procedure: confirm there is one active queue job and terminal run; retry from the latest safe checkpoint if validation evidence is missing; verify adapter audit before retrying delivery.

### validation-repair

Expected states: submitted task, claimed queue job, running run, failed validation, repair implementation, successful validation, completed task, succeeded run.

Expected audit events: validation failure, recovery decision, completed checkpoint, skipped external effect on retry, validation completion, task completion.

Recovery procedure: inspect the transcript and recovery decision; retry from the selected checkpoint; confirm external effects are skipped rather than repeated.

### worker-restart-resume

Expected states: claimed queue job, running run, offline worker, pending job after claim timeout, reclaimed job, resumed run, completed task, succeeded run.

Expected audit events: missed heartbeat, recovered queue job, claimed queue job, skipped checkpoint, task completion.

Recovery procedure: wait for claim timeout; run queue recovery; start one replacement worker and confirm checkpoint skip behavior.

### provider-and-github-outage

Expected states: submitted task, claimed queue job, running run, failed run, pending job with backoff, submitted task, claimed job after backoff, succeeded run.

Expected audit events: provider preflight or external operation failure, fallback skipped or GitHub operation failure, queue finalization, queue requeue, skipped external effect on retry, task completion.

Recovery procedure: keep provider fallback within the same approved provider kind and resolved model; allow backoff or retry through the existing endpoint; verify idempotency lookup before retrying delivery.

### runtime-access-without-approval

Expected states: submitted task, running run, accepted access, implementation, validation, review, delivery, no runtime approval record, completed task.

Expected audit events: access check, iteration, validation, review and GitHub operation completion, task completion.

Recovery procedure: reject failed authentication or role checks; otherwise continue without creating an approval; handle execution failure through ordinary phase-aware retry.

### specification-change-regeneration

Expected states: active specification v1, active contract v1, active roadmap cycle, created specification v2, active contract v2, new active roadmap cycle, carried unfinished steps, superseded or removed requirements.

Expected audit events: specification version creation, contract version creation, roadmap cycle creation, contract recovery request, roadmap validation completion.

Recovery procedure: recover only from immutable historical contract versions older than the latest contract; regenerate through the contract-aware API path; verify active unfinished requirements are still covered.

### manual-audit-recovery

Expected states: qualification evidence present, manually triggered audit action, queued audit job, running audit job, interrupted audit job, retryable audit job, retried audit job, terminal audit evidence.

Expected audit events: audit request, audit job start, audit job recovery, audit job completion or failure.

Recovery procedure: never auto-start final audit; use the manual action after confirming the old job is retryable or terminal; require latest-cycle qualification evidence before accepting the terminal audit.

### disk-exhaustion-artifact-bounds

Expected states: submitted task, running run, bounded artifact capture, failed or truncated artifact capture, failed run, pending queue result with backoff, operator cleanup required, task retryable after cleanup.

Expected audit events: artifact upload start, artifact truncation or failure, validation failure, queue finalization, operator recovery required.

Recovery procedure: pause claims if free space is below the operator threshold; clean only documented disposable workspace and artifact cache paths; resume and retry from the latest persisted checkpoint.

### database-restore-path

Expected states: restored previous schema, forward migrations applied, readable task records, readable queue records, readable approval records, readable audit records, application starts against restored database.

Expected audit events: restore start, migration validation completion, restore verification.

Recovery procedure: restore into an isolated database only; run the forward-only migration validator before workers start; start API first, verify read paths, then resume workers after queue and audit counts are consistent.

### windows-validation-fixture-flow

Expected states: enrolled runner, active manual session, current probe evidence, exact-commit fixture lease, running fixture, succeeded fixture, reconciled evidence, resumed deferred validation.

Expected audit events: enrollment redemption, manual session start, execution lease, result submission, evidence reconciliation.

Recovery procedure: keep validation deferred without a fresh session and probe; expire stale leases before manual reactivation; rerun only the bounded fixture for the same exact commit and reconcile once.

### Targeted regression scenarios

The catalog also binds the consolidated runtime claims to existing executable coverage:

- `selective-validation-reuse` -> `apps/worker/src/validation.test.ts` and `apps/worker/src/workflow.test.ts`
- `unbounded-technical-retry` -> `packages/db/src/repository.task-run.test.ts` and `apps/worker/src/db-worker.test.ts`
- `delivery-only-recovery` -> `apps/worker/src/db-worker.test.ts` and `packages/github/src/index.test.ts`
- `repository-grounded-planning` -> `apps/studio-api/src/roadmap-resume.test.ts`, `apps/studio-api/src/roadmap.test.ts` and `packages/providers/src/roadmap-review-prompt.test.ts`
- `audit-gap-proposal-decision` -> `apps/worker/src/db-worker.test.ts`, `packages/db/src/acceptance-evidence.test.ts` and `apps/studio-api/src/routes.test.ts`

These scenario definitions are `tested` contract evidence when their linked tests pass. They are not production results and do not rewrite stored results from earlier qualification runs.
