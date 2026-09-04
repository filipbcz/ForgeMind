# ForgeMind Architecture

Aktualni architektura je PostgreSQL-backed orchestrator s worker polling modelem.

Statusy v tomto dokumentu maji stejny vyznam jako v `docs/readme-parity.md`: `implemented`, `tested`, `production-verified` a `deferred`.

## 1) Monorepo komponenty

- apps/studio-api: REST orchestrator pro projekty, tasky, worker status/events, chat a webhooky.
- apps/mobile-pwa: mobilni PWA pro task lifecycle, queue, projekty a AI Chat.
- apps/worker: worker process (single run nebo daemon polling), ktery claimuje queue joby a provadi workflow.
- packages/db: Prisma schema + repository vrstva, zdroj pravdy pro task state, queue, runs a audit.
- packages/core: domenove typy, limity a stavovy automat.
- packages/providers: AIProvider kontrakt a implementace provideru.
- packages/github: GitHub adapter (issue/branch/push/PR/check status) a helpery.
- packages/config: parser agent.config.yaml + prevod limitu do core modelu.

## 2) Datovy model a source of truth

Primarni source of truth je PostgreSQL (packages/db/prisma/schema.prisma). Klicove entity:

- tasks: lifecycle tasku od draft po ready_for_user_review nebo fail stavy.
- task_queue_jobs: queue backlog a claim/retry metadata (status, attempt_count, next_attempt_at, claimed_at).
- task_runs: vykonove behy workeru (queued/running/succeeded/failed/cancelled).
- task_iterations: detailni iterace (planning/implementation/validation/review) vcetne diff a validation payloadu.
- approvals a chat_approvals: historicke zaznamy starych behu, ktere aktivni runtime uz nevytvari ani nespotrebovava.
- chat_threads, chat_messages a chat_runs: perzistentni konverzace, jednotlive behy a provider session.
- audit_log: auditovatelny event stream pro stavove prechody, queue a GitHub operace.
- auth_sessions: hashe nahodnych browser session tokenu, expirace a odvolani; vazba na overenou Google identitu uzivatele.
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
- /api/chat/* spravuje vlakna, zpravy a retry/cancel. Detail vlakna vraci zpravy, behy, zmeny a auditni aktivitu.
- /api/webhooks/github overuje x-hub-signature-256 proti GITHUB_WEBHOOK_SECRET.

### Autentizace a autorizace

- Jediny interaktivni login je Google OAuth 2.0/OIDC authorization-code flow se `state`, PKCE a scopes `openid email profile`.
- Google ucet musi mit overeny email a presne odpovidat `FORGEMIND_GOOGLE_ALLOWED_EMAIL`. Overena identita se navaze na existujiciho lokalniho ownera, takze migrace autentizace nemeni vlastnictvi projektu ani ulozenych integraci.
- Browser dostane pouze nahodny `HttpOnly`, `SameSite=Lax` session token. PostgreSQL uchovava jen jeho SHA-256 hash; logout session odvola a restart API ji zachova.
- Vsechny `/api/*` read i write endpointy vyzaduji platnou session. Verejne jsou pouze session bootstrap, start/callback Google OAuth a GitHub webhook, ktery ma vlastni HMAC autentizaci. `/health` zustava verejny pro orchestrator.
- Citlive provider, GitHub, queue-control a metrics operace navic vyzaduji roli `owner`. Browser mutace soucasne prochazeji origin a CSRF ochranou. Samostatny runtime approval gate se nepouziva.
- WebSocket upgrade overuje stejnou databazovou session a konkretni task/chat subscription dale kontroluje proti vlastnikovi.

## 4) Queue a worker runtime flow

Chatovy worker pouziva stejnou globalni queue pause a pred claimem tasku zpracuje nejstarsi pripraveny `chat_run`. Kazde vlakno ma perzistentni workspace pod `workspace/chat/<thread-id>` a vlastni branch. Provider session se obnovi jen pri shode provideru, modelu a konkretniho ulozeneho pripojeni; jinak se kontext sestavi z PostgreSQL, projektoveho kontraktu a historie zprav. Aktivita, validace, chyby a Git operace se zapisuji do `audit_log` s vazbou na vlakno a beh a pres WebSocket se posilaji pouze prihlasenemu klientovi. Stary heartbeat vrati preruseny beh do fronty nad stejnym workspace. Obecny task retention adresar `workspace/chat` nikdy neodstrani.

Worker flow (apps/worker/src/db-worker.ts):

1. Globalni worker_control umoznuje persistentne pozastavit frontu. Aktivni task dobehne a dalsi claim je atomicky zablokovan do obnoveni fronty.
2. recoverStuckQueueJobs vrati zasekle claimed joby zpet do pending.
3. claimNextSubmittedTask claimne nejstarsi pending job, ktery je ready podle next_attempt_at.
4. provider estimate se ulozi pro reporting; provider fail zastavi aktualni provider krok a queue retry navaze nad checkpointem.
5. implementacni provider provede zmeny a ve stejne odpovedi vrati minimalni autoritativni sadu spustitelnych `validationChecks`. Plan, projektova konfigurace ani architektura validacni prikazy nedodavaji.
6. worker bez command allowlistu, sandbox filtru nebo capability odkladu spusti vsechny neprazdne prikazy. Pri chybe preda implementacni AI kompletni prikaz, exit code, stdout a stderr; AI opravi implementaci nebo navrhne opravenou validacni sadu.
7. po uspesne validaci dostane read-only reviewer zadani a aktualni repozitar. Vrati pouze verdikt, shrnuti, blockers a pokryti kriterii. Validaci neopakuje ani neposuzuje jeji prikazy.
8. review blocker se v plnem zneni vrati implementacni AI. Bez blockeru workflow pokracuje do GitHub delivery. Ve stejne implementacni odpovedi provider vraci malou `architectureUpdate` deltu, takze nevznika dalsi AI volani.
9. runWorkerTask provede implementation/validation/review/GitHub kroky.
10. hooks zapisuji status prechody, iteration data, GitHub IDs a audit eventy.
11. finalizeQueueJob pouzije retry/backoff semantiku:
- failed a attempt < max -> task submitted + queue reason phase_retry + pending s exponential backoff do next_attempt_at
- failed po limitu -> final failed
- succeeded/cancelled -> final stav

Retry a obnova workeru jsou phase-aware. Z iteration checkpointu a audit udalosti se urci posledni nedokoncena faze. Implementation, validation, review a delivery se obnovuji samostatne; uspesne predchozi faze ani dokoncene commit/push operace se neopakuji. U validacni sady se zachovaji jednotlive uspesne prikazy nad stejnym otiskem workspace. Selhana validace nebo review vraci task do implementace s plnym chybovym vystupem, ale neopakuje pripravu repozitare ani dokoncene externi operace.

Validacni prostredi:

1. AI podle skutecneho repozitare sama zvoli setup, instalaci zavislosti, build, databazove, API, browser a smoke prikazy, ktere task potrebuje.
2. Worker je obsahove nefiltruje a nesklada k nim vlastni deterministickou sadu.
3. Kazdy prikaz ma checkpoint s otiskem skutecneho workspace. Restart nad nezmenenym workspace uspesny prikaz neprovede znovu; zmena relevantniho workspace zneplatni stary dukaz.
4. Prazdna sada se eviduje jako preskocena validace. Manualni kriterium ForgeMind automaticky nevyhodnocuje.
5. Pokud implementacni AI oznaci kontrolu jako `target: windows`, Linux worker ji nespousti ani kvuli ni neblokuje task. Po doruceni konkretniho commitu ulozi odlozeny acceptance evidence a zaradi kontrolu pro autentizovany Windows runner.
6. Claim vyzaduje aktivni lokalni Windows session a probed capabilities. Provider muze k Windows validation checku pridat strukturovany `windowsAdapter`; worker jej beze zmeny prenese do packetu v2. Fixture nebo Unreal profil se provede pres existujici adapter proti lokalne povolenym/pinned executable a presnym argumentum; obecny AI shell zustane `deferred/manual-local`. Legacy nebo poskozeny ulozeny packet repository pri claimu karantenizuje do neexecutable v2 deferred packetu, aby runner odeslal korelovany vysledek a uzavrel lease. Pouze pred skutecnym adapterem runner klonuje a overi presny commit. Vysledek znovu nespousti implementaci; je vstupem pro pozdejsi projektovy audit.

Trvale checkpointy a idempotence:

1. `task_checkpoints` uklada stav `started/completed/failed`, fazi, stabilni klic operace, otisk vstupu a omezeny vystup pro validaci a externi efekty.
2. Commit, push, vytvoreni PR a merge se pri phase retry obnovuji pouze od prvni nedokoncene operace.
3. GitHub adapter pred vytvorenim PR vyhleda otevreny PR pro stejnou head/base branch a merge jiz slouceneho PR vraci jako uspesny. Opakovani po vypadku proto nevytvari duplicitni PR ani merge.
4. Validacni prikazy pouzivaji stejne checkpointy jako ostatni operace. Project audit ma unikatni job na roadmap cyklus. Dokonceni posledniho implementacniho kroku audit automaticky nespousti; uzivatel jej spusti rucne az po kontrole rozsahu. Pokud audit prida opravne kroky, jejich dokonceni opet ceka na dalsi rucni audit.

Project architecture lifecycle:

1. Roadmap plan inicializuje architektonicke moduly, databazova schemata a hranice a ulozi prvni nemenny snapshot.
2. Roadmap cyklus i task odkazuji na konkretni snapshot; worker pri claimu pouzije verzi tasku a dostane jen relevantni moduly a globalni pravidla v omezenem kontextu.
3. Implementace vrati architectureUpdate deltu; review ji porovna s diffem a existujicimi hranicemi.
4. Po dokonceni tasku repository deltu slouci bez duplicit, idempotentne vytvori novou verzi a zachova auditni vazbu rozhodnuti na task.
5. Architektura poskytuje kontext a invarianty, nikoliv prikazy. Implementacni AI z nich odvozuje potrebne kontroly pro konkretni task.
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
11. Roadmap krok nese `changeRationale`, explicitni zavislosti na drivejsich krocich a `validationFocus`. Pri regeneraci se z cyklu vybrane zakladni contract verze prenesou vsechny nedokoncene kroky; novy cyklus musi vedle delty pokryt i vsechny jejich stale aktivni `REQ-*`. Pred ulozenim se deterministicky kontroluje pokryti, duplicita, poradi zavislosti a strukturalni limity kroku.
12. Strukturalne platnou roadmapu posoudi v cerstvem kontextu nezavisle AI quality review proti zadani a relevantni casti contractu. Kontroluje uplnost vlastniho zadani kazdeho kroku, rozpory, prekryvy, skutecnou velikost, overitelnost kriterii, zavislosti a oddeleni implementace od manualnich release operaci. Konkretni blockery se vrati cilenemu roadmap repair a opraveny vysledek znovu projde strukturalni i vyznamovou kontrolou. Bez uspesneho review se cyklus ani prvni task nevytvori.
13. Vytvoreni nahradniho cyklu atomicky oznaci vsechny dosud `pending` kroky starsich cyklu jako `cancelled`, zachova jejich tasky a historii a zapise auditni vazbu na novy cyklus.

## 5) Runtime rozhodovani

- Tokeny a cena se zaznamenavaji jako metriky, bez budget stopu.
- Provider exception se eviduje jako `provider_failed`; queue retry navaze od nedokoncene faze.
- Validacni chyba se s kompletnim vystupem vraci implementacni AI.
- Review blocker se v kompletnim zneni vraci implementacni AI.
- GitHub operation failure vytvori audit event `task_github_operation_failed` a retry navaze od selhane GitHub operace.
- Runtime approval a obsahove omezeni prikazu nejsou soucasti orchestrace.

## 6) Integracni hranice

- GitHub adapter je zapojen pres packages/github.
- Provider vrstva je zapojena pres packages/providers.
- Worker i API sdileji domenove typy z packages/core.

## 7) Aktualni omezeni

1. Single-worker model (queue-ready, ale bez multi-worker koordinace).
2. Worker spousti AI navrzene prikazy bez obsahoveho filtru. Izolace je proto odpovednost provozniho uctu, kontejneru a hostitele.
3. Representative pipeline coverage je `tested` ve workflow a API integračních testech. Produkcni E2E overeni realneho GitHubu, realneho providera a nasazene PWA zustava `deferred`.

## 8) Evidence map

| Oblast | Status | Evidence |
| --- | --- | --- |
| REST orchestrator, task lifecycle, webhooky a notifications | `implemented`, `tested` | `apps/studio-api/src/routes.ts`; `apps/studio-api/src/routes.test.ts`; `apps/studio-api/src/webhook.test.ts`; `apps/studio-api/src/notifications.test.ts` |
| Worker runtime, retry, AI validace, read-only review a delivery checkpointy | `implemented`, `tested` | `apps/worker/src/workflow.ts`; `apps/worker/src/db-worker.ts`; `apps/worker/src/workflow.test.ts`; `apps/worker/src/db-worker.test.ts` |
| PostgreSQL queue, project contract, acceptance evidence, architecture versions | `implemented`, `tested` | `packages/db/prisma/schema.prisma`; `packages/db/src/repository.ts`; `packages/db/src/repository.task-run.test.ts`; `packages/core/src` |
| GitHub adapter boundary | `implemented`, `tested` | `packages/github/src/index.ts`; `packages/github/src/index.test.ts` |
| Provider adapter boundary | `implemented`, `tested` | `packages/providers/src/provider.ts`; `packages/providers/src/codex-provider.ts`; `packages/providers/src/openai-provider.test.ts`; `apps/worker/src/db-worker.test.ts` |
| Persistent repository chat, realtime activity and retry | `implemented`, `tested` | `apps/mobile-pwa/src/ChatPanel.tsx`; `apps/studio-api/src/routes/chat-routes.ts`; `apps/worker/src/chat-worker.ts`; `packages/db/prisma/schema.prisma`; `apps/studio-api/src/chat-routes.test.ts`; `apps/worker/src/chat-worker.test.ts`; `packages/providers/src/chat-prompt.test.ts` |
| Neblokujici Windows validace, credentialed runner a evidence nad presnym commitem | `implemented`, `tested` | `apps/windows-runner/src/executor.ts`; `apps/studio-api/src/routes/windows-runner-routes.ts`; `packages/db/src/windows-worker-repository.ts`; `apps/windows-runner/src/executor.test.ts`; `apps/studio-api/src/routes/windows-runner-routes.integration.test.ts` |
| Production verification of full platform behavior | `deferred` | `docs/roadmap-quality-implementation-plan.md`; `docs/deploy-raspberry.md` |

## 9) Monitoring metriky

Aktualni endpoint `/api/metrics` publikuje agregovane metriky z DB snapshotu:

- task lifecycle metriky (`forgemind_tasks_*`) vcetne `provider_failed` a `validation_failed`.
- queue metriky (`forgemind_queue_jobs_*`, `forgemind_queue_wait_seconds_*`).
- run metriky (`forgemind_runs_*`, `forgemind_run_duration_seconds_*`).
- cas generovani snapshotu (`forgemind_metrics_generated_at_unix`).

## 10) Push notifikace

- Mobile PWA registruje Service Worker a vytvari PushManager subscription pres VAPID public key (`/api/notifications/vapid-public-key`).
- Subscription metadata se uklada do `notification_subscriptions`, user preference do `notification_settings`.
- Studio API ma event bridge, ktery polluje `getRecentWorkerEvents` a pri `task_status_completed` a failure status eventech odesila push payloady na aktivni subscriptions.
