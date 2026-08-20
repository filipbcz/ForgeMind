# ForgeMind Architecture

Aktualni architektura je PostgreSQL-backed orchestrator s worker polling modelem.

Statusy v tomto dokumentu maji stejny vyznam jako v `docs/readme-parity.md`: `implemented`, `tested`, `production-verified` a `deferred`.

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
- projects.project_architecture: omezena strukturovana pamet modulu, verejnych rozhrani, zavislosti, rozhodnuti, konvenci, technickeho dluhu a architektonickych validaci.
- project_architecture_versions: nemenne architektonicke snapshoty vcetne databazovych schemat, zdrojove contract verze a tasku. Projekt, roadmap cyklus i task odkazuji na konkretni verzi.

Provider session snizuje opakovane posilani kontextu, ale neni source of truth. Aktualni repozitar, project contract a konkretni ProjectArchitectureVersion tasku maji vzdy prednost pred historii AI session.

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

1. Globalni worker_control umoznuje persistentne pozastavit frontu. Aktivni task dobehne a dalsi claim je atomicky zablokovan do obnoveni fronty.
2. recoverStuckQueueJobs vrati zasekle claimed joby zpet do pending.
3. claimNextSubmittedTask claimne nejstarsi pending job, ktery je ready podle next_attempt_at.
4. provider estimate se ulozi pro reporting; pouze provider fail zastavi beh pred execute.
5. implementacni provider vrati zmeny i minimalni spustitelne validationChecks ve stejne odpovedi; worker je pote spusti pred review. Kontrola muze deklarovat requiredCapabilities pro platformu nebo licencovany runtime. Worker spusti kompatibilni kontroly a autoritativni nekompatibilni kontrolu odlozi bez oslabeni na statickou nahradu; task po predani zdroju ceka na schopny worker a nezavisle roadmap kroky mohou pokracovat. Pri skutecnem selhani dostane AI kompletni prikaz, exit code, stdout a stderr a strukturovane rozhodne mezi nahrazenim kontroly, opravou implementace a skutecnym blockerem. Manualni kontroly se negeneruji ani nevyhodnocuji; pokud zadne kriterium nelze automatizovat, validation faze se oznaci jako preskocena a workflow pokracuje.
   Ve stejne odpovedi provider vraci malou architectureUpdate deltu. Nevznika tim dalsi AI volani.
6. runWorkerTask provede planning/implementation/validation/review/GitHub kroky.
7. hooks zapisuji status prechody, iteration data, GitHub IDs a audit eventy.
8. finalizeQueueJob pouzije retry/backoff semantiku:
- failed a attempt < max -> task submitted + queue reason phase_retry + pending s exponential backoff do next_attempt_at
- failed po limitu -> final failed
- succeeded/cancelled -> final stav

Retry a obnova workeru jsou phase-aware. Z iteration checkpointu a audit udalosti se urci posledni nedokoncena faze. Planning, implementation, validation, review a delivery se obnovuji samostatne; uspesne predchozi faze ani dokoncene commit/push operace se neopakuji. U validacni sady se zachovaji jednotlive uspesne prikazy, dokoncena AI nahrada kontroly navaze jejim spustenim a prerusena diagnostika navaze novym AI rozhodnutim. Pouze AI rozhodnuti `repair_implementation` vraci task do implementace. Implementacni retry dostane kompletni posledni validation error nebo review blockers a pokracuje nad zachovanym workspace.

Komplexni validacni prostredi:

1. Projekt muze mit strukturovany `ProjectValidationProfile`. Profil obsahuje pouze relativni Docker Compose soubory, nazvy sluzeb, nazvy povinnych runtime promennych, migracni a readiness prikazy a timeout; hodnoty secrets se do projektu neukladaji.
2. AI vraci minimalni autoritativni prikazy a kazdy oznaci jako setup, build, database, api, browser nebo smoke.
3. Worker sestavi jednu deterministickou sadu: instalace zavislosti, `docker compose up -d --wait`, migrace, readiness a nakonec AI build/API/browser/smoke kontroly. Vsechny prikazy prochazeji stejnou sandbox a approval policy.
4. Kazdy validacni prikaz ma checkpoint s otiskem skutecneho workspace. Restart nad nezmenenym workspace uspesny prikaz neprovede znovu; nova implementacni zmena vytvori novy otisk a vynuti nove overeni.

Trvale checkpointy a idempotence:

1. `task_checkpoints` uklada stav `started/completed/failed`, fazi, stabilni klic operace, otisk vstupu a omezeny vystup pro validaci a externi efekty.
2. Commit, push, vytvoreni PR, GitHub checks a merge se pri phase retry obnovuji pouze od prvni nedokoncene operace.
3. GitHub adapter pred vytvorenim PR vyhleda otevreny PR pro stejnou head/base branch a merge jiz slouceneho PR vraci jako uspesny. Opakovani po vypadku proto nevytvari duplicitni PR ani merge.
4. Migrace validacniho prostredi pouzivaji stejne checkpointy jako ostatni prikazy. Project audit ma unikatni job na roadmap cyklus. Dokonceni posledniho implementacniho kroku audit automaticky nespousti; uzivatel jej spusti rucne az po kontrole rozsahu. Pokud audit prida opravne kroky, jejich dokonceni opet ceka na dalsi rucni audit.

Project architecture lifecycle:

1. Roadmap plan inicializuje architektonicke moduly, databazova schemata a hranice a ulozi prvni nemenny snapshot.
2. Roadmap cyklus i task odkazuji na konkretni snapshot; worker pri claimu pouzije verzi tasku a dostane jen relevantni moduly a globalni pravidla v omezenem kontextu.
3. Implementace vrati architectureUpdate deltu; review ji porovna s diffem a existujicimi hranicemi.
4. Po dokonceni tasku repository deltu slouci bez duplicit, idempotentne vytvori novou verzi a zachova auditni vazbu rozhodnuti na task.
5. Architektonicke validacni prikazy se pridaji do kazde validacni sady, projdou stejnou bezpecnostni policy a pri retry se znovu nespousteji, pokud uz prosly.
6. Capability a release audity dostanou architektonicky kontext explicitne a zustavaji nezavisle na implementacni session.

Brief-to-release gate:

1. Projekt ma verzovanou historii uplnych specifikacnich snapshotu. Vytvoreni projektu zalozi verzi 1, rucni zmena briefu vytvori dalsi revizi a schvalene rozsireni v jedne transakci vytvori novou verzi specifikace i navazujici roadmap cyklus. Kazdy cyklus odkazuje na verzi, podle ktere vznikl.
2. Opakovane schvaleni stejneho rozsireni je idempotentni podle zdrojoveho roadmap cyklu a nesmi znovu volat provider ani vytvorit duplicitni specifikaci, cyklus nebo task.
3. Kazda zmena project contractu vytvori nemenny `ProjectContractVersion` navazany na konkretni specifikaci a roadmap cyklus. Projekt drzi pouze ukazatel na aktualni verzi; historicke verze zustavaji citelne pres API a UI.
4. Prvni roadmapa vraci uplny contract. Schvalene rozsireni vraci pouze strukturovany `contractDelta`; ForgeMind deterministicky kontroluje zakladni verzi, existenci identifikatoru, duvody odstraneni a konflikt operaci a pak vytvori kumulativni contract bez dalsiho AI volani.
5. Requirement ma lifecycle `active`, `superseded` nebo `removed`, verzi vzniku a pripadnou vazbu na nahradu. Nezmenene aktivni pozadavky se prenaseji automaticky a nemohou potichu zmizet.
6. Kazdy novy contract requirement nese kratke briefReferences; roadmap kroky, tasky a acceptance evidence zustavaji navazane pres stejne `REQ-*` identifikatory.
7. Po uspesnych capability auditech spusti worker v cerstvem nezavislem kontextu release audit nad aktualni specifikaci, contractem, aktualnim commitem a cilene omezenym repository packetem.
8. Audit ze specifikace znovu odvozuje podstatne produktove povinnosti. Project cycle nelze dokoncit bez konkretniho repository evidence pro kazdou z nich a pro kazde release kriterium.
9. Pokud contract nekterou podstatnou povinnost opomenul, audit vrati atomicky novy `REQ-*` a minimalni opravny krok. Repository amendment vytvori novou contract verzi, zrusi pouze dotcene capability/release evidence a zachova dukazy hotovych pozadavku.
10. Navrh volitelneho rozsireni se vytvori az po uspesnem `Original brief coverage` evidence na aktualnim commitu.
11. Roadmap krok nese `changeRationale`, explicitni zavislosti na drivejsich krocich a `validationFocus`. Pri regeneraci se z cyklu vybrane zakladni contract verze prenesou vsechny nedokoncene kroky; novy cyklus musi vedle delty pokryt i vsechny jejich stale aktivni `REQ-*`. Pred ulozenim se deterministicky kontroluje toto pokryti, duplicita, poradi zavislosti, prekroceni povoleneho rozsahu a migracni, kompatibilitni a regresni odpovednost.
12. Neplatna roadmapa dostane nejvyse jeden cileny AI repair pouze nad chybnymi kroky a validacni chybou. Pokud oprava znovu neprojde, nevytvori se cyklus ani prvni task.

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
3. Representative pipeline coverage je `tested` v `apps/worker/src/mvp-scenario.test.ts` a `apps/studio-api/src/routes.test.ts`. Produkcni E2E overeni realneho GitHubu, realneho providera a nasazene PWA zustava `deferred`.

## 8) Evidence map

| Oblast | Status | Evidence |
| --- | --- | --- |
| REST orchestrator, task lifecycle, webhooky, approvals, notifications | `implemented`, `tested` | `apps/studio-api/src/routes.ts`; `apps/studio-api/src/routes.test.ts`; `apps/studio-api/src/webhook.test.ts`; `apps/studio-api/src/notifications.test.ts` |
| Worker runtime, retry, validation, review, delivery checkpoints | `implemented`, `tested` | `apps/worker/src/workflow.ts`; `apps/worker/src/db-worker.ts`; `apps/worker/src/workflow.test.ts`; `apps/worker/src/db-worker.test.ts`; `apps/worker/src/mvp-scenario.test.ts` |
| PostgreSQL queue, project contract, acceptance evidence, architecture versions | `implemented`, `tested` | `packages/db/prisma/schema.prisma`; `packages/db/src/repository.ts`; `packages/db/src/repository.task-run.test.ts`; `packages/core/src` |
| GitHub adapter boundary | `implemented`, `tested` | `packages/github/src/index.ts`; `packages/github/src/index.test.ts` |
| Provider adapter boundary | `implemented`, `tested` | `packages/providers/src/provider.ts`; `packages/providers/src/codex-provider.ts`; `packages/providers/src/openai-provider.test.ts`; `apps/worker/src/db-worker.test.ts` |
| Production verification of full platform behavior | `deferred` | `docs/roadmap-quality-implementation-plan.md`; `docs/deploy-raspberry.md` |

## 9) Monitoring metriky

Aktualni endpoint `/api/metrics` publikuje agregovane metriky z DB snapshotu:

- task lifecycle metriky (`forgemind_tasks_*`) vcetne `provider_failed`, `budget_exceeded`, `iteration_limit_reached`, `repeated_error_detected`, `validation_failed`.
- queue metriky (`forgemind_queue_jobs_*`, `forgemind_queue_wait_seconds_*`).
- approvals metriky (`forgemind_approvals_*`).
- run metriky (`forgemind_runs_*`, `forgemind_run_duration_seconds_*`).
- cas generovani snapshotu (`forgemind_metrics_generated_at_unix`).

## 10) Push notifikace

- Mobile PWA registruje Service Worker a vytvari PushManager subscription pres VAPID public key (`/api/notifications/vapid-public-key`).
- Subscription metadata se uklada do `notification_subscriptions`, user preference do `notification_settings`.
- Studio API ma event bridge, ktery polluje `getRecentWorkerEvents` a pri `task_status_needs_approval`, `task_status_completed` a failure status eventech odesila push payloady na aktivni subscriptions.
