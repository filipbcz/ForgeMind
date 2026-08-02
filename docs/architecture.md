# ForgeMind Architecture

Aktualni architektura je PostgreSQL-backed orchestrator s worker polling modelem.

## 1) Monorepo komponenty

- apps/studio-api: REST orchestrator pro projekty, tasky, approvals, worker status/events, webhooky.
- apps/mobile-pwa: mobilni PWA pro task lifecycle, queue a approval akce.
- apps/worker: worker process (single run nebo daemon polling), ktery claimuje queue joby a provadi workflow.
- packages/db: Prisma schema + repository vrstva, zdroj pravdy pro task state, queue, runs, approvals a audit.
- packages/core: domenove typy, limity, policy a stavovy automat.
- packages/providers: AIProvider kontrakt a implementace provideru.
- packages/github: GitHub adapter (issue/branch/push/PR/check status) a helpery.
- packages/config: parser agent.config.yaml + prevod limitu do core modelu.

## 2) Datovy model a source of truth

Primarni source of truth je PostgreSQL (packages/db/prisma/schema.prisma). Klicove entity:

- tasks: lifecycle tasku od draft po ready_for_user_review nebo fail stavy.
- task_queue_jobs: queue backlog a claim/retry metadata (status, attempt_count, next_attempt_at, claimed_at).
- task_runs: vykonove behy workeru (queued/running/succeeded/failed/cancelled).
- task_iterations: detailni iterace (planning/implementation/validation/review) vcetne diff a validation payloadu.
- approvals: rizikove rozhodnuti, ktera pozastavi workflow.
- audit_log: auditovatelny event stream pro stavove prechody, queue a GitHub operace.

## 3) API orchestrace (studio-api)

Studio API pouziva repository + dispatch service:

- /api/tasks/:id/start a /api/tasks/:id/retry vytvori submitted stav a enqueuji queue job.
- /api/tasks/:id/cancel ukonci task a konzistentne zavre pending/claimed queue joby.
- /api/tasks/:id/queue, /api/tasks/:id/runs, /api/worker/status, /api/worker/events vraci operacni data nad persisted stavem.
- /api/metrics vraci Prometheus-like text export operacnich metrik pro scraping.
- /api/notifications/* drzi subscription/settings endpointy + VAPID public key bootstrap pro PushManager.
- /api/approvals/:id/approve po finalnim schvaleni automaticky obnovi task (retryTask start=true) a znovu ho enqueuje.
- /api/webhooks/github overuje x-hub-signature-256 proti GITHUB_WEBHOOK_SECRET.

## 4) Queue a worker runtime flow

Worker flow (apps/worker/src/db-worker.ts):

1. recoverStuckQueueJobs vrati zasekle claimed joby zpet do pending.
2. claimNextSubmittedTask claimne nejstarsi pending job, ktery je ready podle next_attempt_at.
3. provider estimate se ulozi pro reporting; pouze provider fail zastavi beh pred execute.
4. runWorkerTask provede planning/implementation/validation/review/GitHub kroky.
5. hooks zapisuji status prechody, iteration data, GitHub IDs a audit eventy.
6. finalizeQueueJob pouzije retry/backoff semantiku:
- failed a attempt < max -> pending + exponential backoff do next_attempt_at
- failed po limitu -> final failed
- succeeded/cancelled -> final stav

## 5) Policy enforcement (aktualni)

Aktivne vynucene policy vetve:

- risky provider outcome -> needs_approval + approval record.
- approval finalizace -> automatic resume + re-enqueue.
- tokeny a cena se zaznamenavaji jako metriky, bez budget stopu.
- repeated stejna validation/review chyba -> repeated_error_detected.
- max iterace -> iteration_limit_reached.
- provider exception -> provider_failed.
- GitHub operation failure -> audit event task_github_operation_failed.

## 6) Integracni hranice

- GitHub adapter je zapojen pres packages/github.
- Provider vrstva je zapojena pres packages/providers.
- Worker i API sdileji domenove typy z packages/core.

## 7) Aktualni omezeni

1. Single-worker model (queue-ready, ale bez multi-worker koordinace).
2. Runtime command sandbox je zatim konzervativni, ale vyzaduje dalsi hardening allowlistu.
3. End-to-end scenar od task creation po draft PR je funkcni po castich, formalni E2E test je dalsi krok.

## 8) Monitoring metriky

Aktualni endpoint `/api/metrics` publikuje agregovane metriky z DB snapshotu:

- task lifecycle metriky (`forgemind_tasks_*`) vcetne `provider_failed`, `budget_exceeded`, `iteration_limit_reached`, `repeated_error_detected`, `validation_failed`.
- queue metriky (`forgemind_queue_jobs_*`, `forgemind_queue_wait_seconds_*`).
- approvals metriky (`forgemind_approvals_*`).
- run metriky (`forgemind_runs_*`, `forgemind_run_duration_seconds_*`).
- cas generovani snapshotu (`forgemind_metrics_generated_at_unix`).

## 9) Push notifikace

- Mobile PWA registruje Service Worker a vytvari PushManager subscription pres VAPID public key (`/api/notifications/vapid-public-key`).
- Subscription metadata se uklada do `notification_subscriptions`, user preference do `notification_settings`.
- Studio API ma event bridge, ktery polluje `getRecentWorkerEvents` a pri `task_status_needs_approval`, `task_status_completed` a failure status eventech odesila push payloady na aktivni subscriptions.
