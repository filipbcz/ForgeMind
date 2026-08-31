# ForgeMind - Implementacni tracker

## Aktivni plan kvality roadmapy

Aktualni navazujici prace se ridi dokumentem `docs/roadmap-quality-implementation-plan.md`.
Plan oddeluje dokonceni tasku, work itemu, kontraktni capability a celeho projektu. Tento tracker pouziva pouze statusy `implemented`, `tested`, `production-verified` a `deferred`. Etapy 1-6 a migracni kod etapy 7 jsou `implemented`; cilene testy u uvedenych kroku jsou `tested`; migracni matice a rizene produkcni overeni zustavaji `deferred`.

Posledni aktualizace: 2026-08-19
Zdroj pozadavku: README.md

## Kde jsme ted

- Zaklad persistence a fronty je `implemented` a `tested`: PostgreSQL queue, claim/finalize, recovery zaseklych claimed jobu (`packages/db/src/repository.ts`, `packages/db/src/repository.task-run.test.ts`).
- Mobilni operativni stav je `implemented`: runs, queue, worker status/events (`apps/mobile-pwa/src/App.tsx`, `apps/mobile-pwa/src/api.ts`).
- Kroky 1-22 (README MVP a parity vlna) jsou `implemented`; jednotlive radky nize uvadeji executable test evidence tam, kde existuje.
- Verzovany project contract, acceptance evidence, capability/release audit a completion gate jsou `implemented` a `tested` v `packages/core/src`, `packages/db/src`, `apps/studio-api/src/routes.ts`, `apps/worker/src/db-worker.ts`, `apps/studio-api/src/routes.test.ts` a `apps/worker/src/db-worker.test.ts`.
- ARM64 Raspberry Pi platform deploy workflow je `implemented` v `.github/workflows/deploy-raspberry.yml`, `infra/docker-compose.raspberry.yml` a `docs/deploy-raspberry.md`; produkcni overeni je `deferred`. OCI zustava rucni rollback cesta.
- Otevrena prace je `deferred`: potvrzeni stavu migraci a rizene produkcni overeni etapy 7 vcetne jednoho celeho requirementu.

## Pravidla postupu (abychom se neztraceli)

1. Delame jen aktivni krok; nic navic mimo poradi.
2. Kazdy krok ma tri casti: Cil, Zmena, Ověreni.
3. Dokud neni krok 1-4 `implemented` a podle potreby `tested`, neotvirame novy UI scope.
4. Po kazdem kroku zapiseme 1 vetu do tohoto trackeru: co je `implemented`, co je `tested`, co je `production-verified` a co zustava `deferred`.

## 12 jasnych kroku, podle kterych pojedeme

1. [`implemented`, `tested` 2026-07-03] Webhook podpisy v API
	Cil: Bezpecne overit, ze webhook prisel opravdu z GitHubu.
	Zmena: Pridat utilitu pro validaci podpisu a zapojit ji do webhook endpointu.
	Overeni: Jednotkove testy pro validni podpis, nevalidni podpis a chybejici hlavicky.

2. [`implemented`, `tested` 2026-07-03] Testy GitHub adapteru - issue a branch
	Cil: Mit stabilni kontrakt pro zalozeni issue a branche.
	Zmena: Rozsirit testy adapteru pro createIssue a createBranch (vcetne fallbacku pri existujici branchi).
	Overeni: Vitest v packages/github musi pokryt uspech i chybove vetve.

3. [`implemented`, `tested` 2026-07-03] Testy GitHub adapteru - PR a check status
	Cil: Overit, ze draft PR a cteni CI statusu funguje predvidatelne.
	Zmena: Dopsat testy pro createDraftPullRequest a readCheckStatus vcetne mapovani stavovych kodu.
	Overeni: Testy musi explicitne overit pending/success/failure mapovani.

4. [`implemented`, `tested` 2026-07-03] Worker audit pro GitHub chyby
	Cil: Kazde selhani GitHub operace musi byt dohledatelne v run/audit datech.
	Zmena: V worker flow zapisovat strukturovane audit udalosti pro fail v issue/branch/push/PR kroku.
	Overeni: Test, ktery simulaci chyby potvrdi zapis audit eventu.

5. [`implemented`, `tested` 2026-07-03] Cancel semantika queue
	Cil: Cancel task musi konzistentne ukoncit pending i claimed queue joby.
	Zmena: Upravit API cancel cestu a repository tak, aby nedochazelo k pozdnimu claimu zruseneho tasku.
	Overeni: Testy pro cancel pred claimem i behem claimnuteho jobu.

6. [`implemented`, `tested` 2026-07-03] Retry/backoff metadata ve fronte
	Cil: Mit riditelne opakovani po selhani bez nekonecnych smycek.
	Zmena: Pridat metadata pokusu a backoff pravidla na queue job (napr. attemptCount, nextAttemptAt).
	Overeni: Test opakovanych failu potvrdi, ze po limitu jde job do fail stavu.

7. [`implemented`, `tested` 2026-07-03] Provider outcome -> policy enforcement
	Cil: Provider vysledek musi vest na spravny stav tasku podle policy.
	Zmena: Explicitne mapovat risky outcomes na approval-required, budget overrun na stop a review blockers na retry/fail.
	Overeni: Testy v worker/core pro jednotlive policy scenare.

8. [`implemented`, `tested` 2026-07-03] Approval stop-and-resume tok
	Cil: Worker se pri potrebnem approval opravdu zastavi a umi pokracovat az po schvaleni.
	Zmena: Dotahnout lifecycle prechody a perzistenci approval navaznosti.
	Overeni: Integra test scenare "needs approval -> approved -> continue".

9. [`implemented`, `tested` 2026-07-03] Limity a detekce opakovanych chyb
	Cil: Chranit system pred zacyklenim a zbytecnym cerpanim kreditu.
	Zmena: Konsolidovat iteration limit, repeated-error detection a budget stop pod jednim rozhodovacim tokem.
	Overeni: Testy pro tri scenare: stejna chyba opakovane, prekroceny rozpocet, max iterace.

10. [`implemented` 2026-07-03] Dokumentace runtime bezpecnosti
	 Cil: Mit jasne a provozne pouzitelne guardrails.
	 Zmena: Aktualizovat docs/security.md o secrets handling, sandbox hranice, retention a systemd hardening.
	 Overeni: Kontrola souladu s realnym chovanim workeru a API.

11. [`implemented` 2026-07-03] Dokumentace architektury a konfigurace
	 Cil: Dokumentace musi odpovidat aktualni implementaci.
	 Zmena: Aktualizovat docs/architecture.md a docs/project-config.md podle queue, worker flow a policy reality.
	 Overeni: Rucni review bez rozporu proti README a kodu.

12. [`implemented`, `tested` 2026-07-03] End-to-end MVP scenar + finalni validace
	 Cil: Potvrdit hlavni README flow od zadani tasku az po draft PR.
	 Zmena: Dopsat E2E test scenar a spustit root validaci.
	 Overeni: `npm run build` a `npm test` v root musi projit bez chyb.

## Aktivni krok

Aktivne resime: Etapu 7 planu kvality roadmapy - potvrzeni migraci a rizene produkcni overeni. Implementacni kroky 1-22 jsou `implemented`; test evidence je uvedena nize; produkcni overeni zustava `deferred`.

## Navazujici kroky (README delta) - dalsi vlna

13. [`implemented`, `tested` 2026-07-03] Realny Codex provider + fallback provider policy
	Cil: Splnit README pozadavek na primarni Codex provider a kontrolovany fallback.
	Zmena: Implementovat samostatny CodexProvider adapter (ne alias OpenAI), sjednotit provider kontrakt a fallback rozhodovani v worker toku.
	Overeni: Testy provideru pokryji happy path, timeout/error mapovani a fallback scenar; `npm run build` musi projit.

14. [`implemented`, `tested` 2026-07-03] Rezimy autonomie Safe/Auto/Full-auto jako runtime policy
	Cil: Vynutit odlisne chovani agenta podle rezimu autonomie.
	Zmena: Dodat explicitni policy gate vrstvu (co je allowed/approval-required/forbidden) napojenou na workflow kroky a approval subsystem.
	Overeni: Testy pro kazdy rezim overi, ze rizikove operace konci ve `needs_approval` nebo `forbidden`, nikoliv tichym provedenim.

15. [`implemented`, `tested` 2026-07-03] Tvrdy command/scope sandbox enforcement
	Cil: Zastavit nepovolene prikazy a zapis mimo povolene cesty.
	Zmena: Zavest centralni validator prikazu a scope kontrolu podle configu (`allowlist`, `forbidden paths`, `write-outside-repo`).
	Overeni: Testy musi pokryt blokaci rizikovych prikazu, zapis mimo repo a korektni audit event pri blokaci.

16. [`implemented`, `tested` 2026-07-03] GitHub webhook event pipeline (krome podpisu)
	Cil: Zpracovavat relevantni GitHub eventy end-to-end, ne jen overit podpis.
	Zmena: Rozsirit webhook handler na konkretni event typy (napr. issue_comment/pull_request/check_suite nebo check_run dle README scope), mapovat je na task/run udalosti.
	Overeni: Testy webhook route + mapping logiky potvrdi spravne vetveni eventu a idempotentni zpracovani.

17. [`implemented`, `tested` 2026-07-03] Monitoring metriky + endpoint
	Cil: Mit operativni metriky vedle audit logu.
	Zmena: Pridat metriky (task lifecycle, queue wait, run duration, approvals, provider failures, budget/limit stops) a export endpoint pro scraping.
	Overeni: Integracni test endpointu a unit testy inkrementace metrik; dokumentace metrik v `docs/architecture.md`.

18. [`implemented`, `tested` 2026-07-03] Mobilni formulare/task detail dle README field richness
	Cil: Dorovnat mobilni UX/data model proti README pozadavkum.
	Zmena: Doplnit task create/detail o chybejici pole (napr. priority, scope files, acceptance criteria, runtime summary), vcetne validace na API vrstve.
	Overeni: UI testy (nebo komponentove testy) + route testy potvrdi serializaci a zobrazeni novych poli.

19. [`implemented`, `tested` 2026-07-03] Push notifikace end-to-end
	Cil: Zprovoznit realne push notifikace nad existujici SW registraci.
	Zmena: Doplnit PushManager subscription flow v PWA, ulozeni subscription v API a trigger notifikaci na klicove udalosti (approval needed, task completed, failed).
	Overeni: Testy API notifikaci + smoke scenar subscription lifecycle (subscribe/unsubscribe/send).

20. [`implemented`, `tested` 2026-07-03] GitHub issue body sablona podle README
	Cil: Generovat issue popis se vsemi povinnymi sekcemi.
	Zmena: Rozsirit renderer issue body o Omezeni, Akceptacni kriteria, validacni kroky a rizika; sjednotit s project config.
	Overeni: Snapshot testy v github package potvrdi kompletni markdown strukturu a odolnost na prazdne volitelne sekce.

21. [`implemented`, `tested` 2026-07-03] Representative pipeline test pres API -> worker -> GitHub adapter -> mobile read model
	Cil: Mit jeden reprezentativni tok overujici cele pipeline komponenty.
	Zmena: Dopsat e2e/integracni scenar, ktery projde od task submitu po ready-for-review/completed vcetne approval vetve.
	Overeni: Cileny test suite pro scenario musi byt zeleny v CI i lokalne.

22. [`implemented`, `tested` 2026-07-03] Finalni README parity pass + dokumentace acceptance
	Cil: Uzavrit README gapy transparentnim checklistem.
	Zmena: Aktualizovat tracker, README cross-reference a docs tak, aby kazdy README pozadavek mel implementacni odkaz nebo vedome odlozeni.
	Overeni: `npm run build`, `npm test` a rucni parity review bez otevreneho kritickeho gapu.

## Evidence pro completion claims

| Kroky | Status | Evidence |
| --- | --- | --- |
| 1, 16 | `implemented`, `tested` | `apps/studio-api/src/webhook.ts`; `apps/studio-api/src/routes.ts`; `apps/studio-api/src/webhook.test.ts`; `apps/studio-api/src/routes.test.ts` |
| 2, 3, 20 | `implemented`, `tested` | `packages/github/src/index.ts`; `packages/github/src/index.test.ts` |
| 4, 7, 9, 14, 15 | `implemented`, `tested` | `apps/worker/src/workflow.ts`; `apps/worker/src/db-worker.ts`; `apps/worker/src/workflow.test.ts`; `apps/worker/src/db-worker.test.ts` |
| 5, 6 | `implemented`, `tested` | `packages/db/src/repository.ts`; `packages/db/src/repository.task-run.test.ts` |
| 8, 18, 21 | `implemented`, `tested` | `apps/studio-api/src/routes.ts`; `apps/studio-api/src/routes.test.ts`; `apps/worker/src/db-worker.ts`; `apps/worker/src/db-worker.test.ts` |
| 10, 11, 22 | `implemented` | `docs/security.md`; `docs/architecture.md`; `docs/project-config.md`; `docs/readme-parity.md`; `README.md` |
| 12 | `implemented`, `tested` | `apps/worker/src/mvp-scenario.test.ts`; root `npm run build`; root `npm test` |
| 13 | `implemented`, `tested` | `packages/providers/src/provider.ts`; `packages/providers/src/codex-provider.ts`; `packages/providers/src/openai-provider.test.ts`; `apps/worker/src/db-worker.test.ts` |
| 17 | `implemented`, `tested` | `apps/studio-api/src/routes.ts`; `packages/db/src/repository.ts`; `apps/studio-api/src/routes.test.ts`; `docs/architecture.md` |
| 19 | `implemented`, `tested` | `apps/mobile-pwa/src/pwa.ts`; `apps/mobile-pwa/public/sw.js`; `apps/studio-api/src/notifications.ts`; `apps/studio-api/src/server.ts`; `apps/studio-api/src/notifications.test.ts`; `apps/studio-api/src/routes.test.ts` |
| Etapa 7 migracni matice a rizene produkcni overeni | `deferred` | `docs/roadmap-quality-implementation-plan.md` |

## Prubezny log

- 2026-08-19: Dokumentacni truth pass `implemented`: README, tracker, architektura, security a parity checklist pouzivaji statusy `implemented`, `tested`, `production-verified`, `deferred`; completion claims odkazuji na repository path nebo executable test; reprezentativni pipeline coverage je odlisena od produkcniho E2E overeni. Overeno cilenou statickou kontrolou dokumentace.
- 2026-08-07: Verzovany projektovy kontrakt, trasovatelne work itemy, acceptance evidence, read-only capability a release audit, perzistentni audit job s retry/heartbeat, prioritni gap work itemy a completion gate jsou `implemented` a `tested` v `apps/studio-api/src/routes.test.ts`, `apps/worker/src/db-worker.test.ts` a root `npm run build`; produkcni migrace a realny rollout zustavaji `deferred`.
- 2026-08-30: Perzistentni vicevlaknovy AI chat s volitelnym projektem a repozitarem, provider session, samostatnym workspace, realtime aktivitou, retry/cancel, diffem a chat approvals je `implemented` a `tested`; specifikace je v `docs/ai-chat-specification.md`, produkcni migrace a realny provider/GitHub E2E zustavaji `deferred`.

- 2026-07-03: Krok 1 `implemented` a `tested`. Doplneno overeni podpisu v webhook utilite i API route vrstve, testy prosly: `npx vitest run apps/studio-api/src/webhook.test.ts apps/studio-api/src/routes.test.ts`.
- 2026-07-03: Krok 2 `implemented` a `tested`. Doplneny testy createIssue a createBranch (vcetne fallbacku i chybove vetve), testy prosly: `npx vitest run packages/github/src/index.test.ts`.
- 2026-07-03: Krok 3 `implemented` a `tested`. Doplneny testy createDraftPullRequest a readCheckStatus mapovani (pending/success/failure), testy prosly: `npx vitest run packages/github/src/index.test.ts`.
- 2026-07-03: Krok 4 `implemented` a `tested`. Worker zapisuje `task_github_operation_failed` audit event pri selhani GitHub operace a udalost je ve worker event feedu, testy prosly: `npx vitest run apps/worker/src/workflow.test.ts apps/worker/src/db-worker.test.ts`.
- 2026-07-03: Krok 5 `implemented` a `tested`. `cancelTask` rusi aktivni queue joby (`pending` + `claimed`) a `finalizeQueueJob` uz meni jen aktivni queue job, testy prosly: `npx vitest run packages/db/src/repository.task-run.test.ts`.
- 2026-07-03: Krok 6 `implemented` a `tested`. Queue joby maji retry metadata (`attempt_count`, `next_attempt_at`) a `finalizeQueueJob` pouziva exponential backoff a finalni fail po limitu pokusu, testy prosly: `npx vitest run packages/db/src/repository.task-run.test.ts`.
- 2026-07-03: Krok 7 `implemented` a `tested`. Provider policy mapovani je explicitni: risky outcome -> `needs_approval`, budget overrun -> `budget_exceeded`, provider error -> `provider_failed`; testy prosly: `npx vitest run apps/worker/src/db-worker.test.ts apps/worker/src/workflow.test.ts`.
- 2026-07-03: Krok 8 `implemented` a `tested`. Schvaleni finalniho approval automaticky obnovi task (`needs_approval -> submitted`) a task se znovu enqueuje; testy prosly: `npx vitest run apps/studio-api/src/routes.test.ts apps/worker/src/db-worker.test.ts`.
- 2026-07-03: Krok 9 `implemented` a `tested`. Worker ma sjednocene rozhodovani limitu (budget, iteration, repeated-error) a aktivni detekci opakovane validation/review chyby, testy prosly: `npx vitest run apps/worker/src/db-worker.test.ts apps/worker/src/workflow.test.ts`.
- 2026-07-03: Krok 10 `implemented`. Dokumentace bezpecnosti byla rozsirena na provozni standard (secrets, sandbox, retention, systemd hardening, API guardrails) a sladena s aktualnim worker/API stavem v `docs/security.md`.
- 2026-07-03: Krok 11 `implemented`. Dokumentace architektury a konfigurace byla prepsana na aktualni PostgreSQL queue + worker policy stav (approval resume, retry/backoff, provider fail mapovani, runtime limity) v `docs/architecture.md` a `docs/project-config.md`.
- 2026-07-03: Krok 12 `implemented` a `tested`. Pridan MVP scenar test (`apps/worker/src/mvp-scenario.test.ts`) pro happy path i approval pause/resume a prosla root validace: `npm run build` a `npm test`.
- 2026-07-03: Krok 13 `implemented` a `tested`. Codex provider je samostatna implementace (`packages/providers/src/codex-provider.ts`) a worker umi fallback na sekundarni provider pri selhani primarniho volani (`apps/worker/src/db-worker.test.ts`).
- 2026-07-03: Krok 14 `implemented` a `tested`. Workflow ma runtime mode-aware policy gate (safe/auto/full-auto) pro implementacni i review risky changes s prechodem do `needs_approval` (`apps/worker/src/workflow.test.ts`, `apps/worker/src/db-worker.test.ts`).
- 2026-07-03: Krok 15 `implemented` a `tested`. Pridan sandbox enforcement pro verify command (`sudo`/network command guard) a path guard proti write-outside-repo, kryto testy policy scenaru v `apps/worker/src/workflow.test.ts`.
- 2026-07-03: Krok 16 `implemented` a `tested`. Webhook route zpracovava strukturovane event payloady (issues/issue_comment/pull_request/check_run/check_suite), ma deduplikaci podle delivery id a testy mappingu/idempotence (`apps/studio-api/src/routes.test.ts`, `apps/studio-api/src/webhook.test.ts`).
- 2026-07-03: Krok 17 `implemented` a `tested`. API endpoint `/api/metrics` vraci Prometheus-like operacni metriky (task lifecycle, queue wait, approvals, run durations, provider/budget/limit failure counters), kryto route testem a dokumentaci v `docs/architecture.md`.
- 2026-07-03: Krok 18 `implemented` a `tested`. API prijima rich task metadata (`priority`, `scopeFiles`, `acceptanceCriteria`, `runtimeSummary`) a serializuje je do strukturovaneho promptu; mobilni formulare tato pole odesilaji a route test overuje mapovani.
- 2026-07-03: Krok 19 `implemented` a `tested`. PWA ma PushManager subscription lifecycle (`subscribe/unsubscribe`) s API persistenci a SW push handlingem; Studio API triggeruje push pro `needs_approval`, `completed` a failure statusy pres worker event bridge, testy prosly: `npx vitest run apps/studio-api/src/notifications.test.ts apps/studio-api/src/routes.test.ts`.
- 2026-07-03: Krok 20 `implemented` a `tested`. GitHub issue body renderer je README-compliant (`Cil/Kontext/Omezeni/Akceptacni kriteria/Rezim/Limity`), umi parsovat rich metadata ze structured promptu a ma snapshot testy pro rich i empty-optional scenar; overeno: `npx vitest run packages/github/src/index.test.ts`.
- 2026-07-03: Krok 21 `implemented` a `tested`. Pridan representative integration test v `apps/studio-api/src/routes.test.ts` pokryvajici tok API create/start -> worker `runWorkerTask` -> GitHub issue/PR fields -> mobilni read-model projekce z `/api/tasks`; overeno: `npx vitest run apps/studio-api/src/routes.test.ts`.
- 2026-07-03: Krok 22 `implemented` a `tested`. Pridan parity checklist (`docs/readme-parity.md`) + README cross-reference sekce a acceptance validacni prikazy; overeno: `npm run build`, `npm test`.

## Definice `implemented` + `tested` pro nejblizsi milnik (kroky 17-20)

1. API expose metriky task lifecycle/fronta/approvals/provider failures + dokumentace metrik.
2. Mobilni task formulare/detail dorovnaji README field richness a validacni tok.
3. Push notifikace budou fungovat end-to-end od subscription po trigger.
4. GitHub issue body bude generovan podle README sablony vcetne omezeni a akceptacnich kriterii.
