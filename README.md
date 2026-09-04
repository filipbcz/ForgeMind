# ForgeMind – zadávací dokumentace projektu

Verze dokumentu: 0.1
Stav: návrh pro MVP a navazující vývoj
Název platformy: **ForgeMind**
Produktová řada: **ForgeMind Studio**, **ForgeMind Agent**, **ForgeMind Mobile**

## Aktuální autonomní orchestrace

Původní návrh MVP počítal s příkazovým allowlistem, runtime sandbox policy a schvalováním rizikových operací. Aktuální implementace tento model zjednodušuje a následující pravidla mají přednost před staršími návrhovými pasážemi v tomto dokumentu:

1. Task vstupuje přímo do implementace. Jeho prompt obsahuje pouze zadání aktuálního kroku; akceptační kritéria jsou uložena a předávána samostatně. AI analyzuje aktuální repozitář, provede změny a ve stejné odpovědi navrhne autoritativní sadu spustitelných validačních příkazů.
2. Validační příkazy nesmí pocházet z `agent.config.yaml`, plánování ani projektové architektury. Worker spustí všechny neprázdné lokální příkazy bez obsahového allowlistu nebo sandbox filtru. Kontroly výslovně vyžadující Windows zařadí jako neblokující externí validaci přesného dodaného commitu.
3. Při selhání validace dostane implementační AI celý příkaz, exit code, stdout a stderr. Opraví implementaci nebo navrhne odpovídající novou validaci.
4. Review má read-only přístup k repozitáři a posuzuje pouze to, zda výsledek odpovídá zadání a akceptačním kritériím. Nativní Codex review si stav načte přímo z repozitáře a ForgeMind mu neposílá celý diff ani projektovou architekturu. Validaci neopakuje. Blocker vrací v plném znění implementační AI.
5. Po úspěšném review následuje GitHub delivery. Retry pokračuje od první nedokončené fáze a neopakuje hotové externí operace ani platné validační checkpointy.
6. Runtime approval mechanismus byl odstraněn. Autentizace, autorizace API, oprávnění uložených integrací, audit a izolace hostitelského worker prostředí zůstávají zachovány.

Aktuální mapování konfigurace je v `docs/project-config.md`, runtime tok v `docs/architecture.md` a implementační evidence v `docs/readme-parity.md`.

## 1. Účel projektu

Cílem projektu ForgeMind je vytvořit vlastní platformu pro řízení autonomních AI vývojových agentů. Platforma má umožnit zadávat komplexní programátorské úkoly z mobilního telefonu, spouštět nad nimi AI vývojáře, integrovat výsledek s GitHubem a bezpečně řídit celý životní cyklus od zadání přes implementaci, testování, review až po draft pull request.

ForgeMind nesmí být pevně navázán pouze na jednoho AI providera. Primárním providerem bude Codex, ale architektura musí umožnit připojení dalších providerů, například GitHub Copilot cloud agentu nebo jiného modelu/API. Codex SDK je vhodný kandidát pro vlastní serverové workflow, protože oficiální dokumentace uvádí použití pro CI/CD, interní workflow, vlastní agenty a integraci do aplikace.

Platforma se skládá ze tří hlavních produktových částí:

```text
ForgeMind Studio   – webové administrační a vývojové rozhraní
ForgeMind Mobile   – mobilní PWA pro zadávání úkolů a sledování běhů
ForgeMind Agent    – Linux worker, který vykonává úkoly nad repozitáři
```

## 2. Hlavní vize

Uživatel zadá z telefonu například:

```text
V projektu STARPANT uprav galerii fotek tak, aby seskupovala obrázky podle dne vytvoření, měla fullscreen náhled, šipky pro přepínání a fungovala čistě přes nginx bez backendu. Hotovo je, až bude build bez chyby a nebude chyba v konzoli.
```

ForgeMind následně:

1. Vytvoří GitHub issue.
2. Načte konfiguraci projektu.
3. Založí pracovní branch.
4. Spustí vybraného AI providera nad aktuálním repozitářem a zadáním.
5. Nechá provést změny a od stejné implementační AI získá validační příkazy.
6. Příkazy spustí a při chybě vrátí kompletní výstup implementační AI.
7. Po úspěšné validaci provede read-only AI review proti zadání.
8. Blocker vrátí implementaci; bez blockeru pokračuje do GitHub delivery.
9. Pushne branch, otevře pull request a zapíše shrnutí, validační důkazy a spotřebu.

## 3. Základní principy

ForgeMind musí být navržen jako řídicí systém, ne jen jako jednoduchý wrapper nad AI CLI. Hlavní hodnotou systému je orchestrace, bezpečnost, audit, opakovatelnost a kontrola dokončení.

Základní principy:

```text
GitHub je zdroj pravdy.
AI provider je vyměnitelný.
Každý úkol má měřitelné akceptační kritérium.
Každý běh je auditovatelný a obnovitelný z checkpointu.
Každý výsledek končí v branchi nebo draft PR.
AI má volnost zvolit implementaci i validační příkazy potřebné ke splnění cíle.
Provozní oprávnění vymezuje účet, kontejner a uložené integrace workeru.
```

Prompt implementačního tasku obsahuje pouze název, popis a požadované výstupy aktuálního kroku. Akceptační kritéria jsou samostatná strukturovaná data. Projektový brief, roadmapa, paměť ani architektonický souhrn se do promptu automaticky nepřidávají; aktuální stav projektu je zdrojem přímo v pracovním repozitáři.

Vygenerovaná roadmapa před uložením prochází samostatným AI quality review proti aktuálnímu zadání a relevantní části project contractu. Review odmítne významové rozpory, překryvy, příliš široké kroky, neověřitelná kritéria nebo manuální release operace vydávané za implementaci; provider následně opraví pouze konkrétní blockery a opravená roadmapa se znovu zkontroluje. Při regeneraci jsou nedokončené kroky starších cyklů zachovány v historii jako `cancelled`, nikoli ponechány jako zdánlivě aktivní `pending` práce.

Strukturální ani významové opravy roadmapy nemají pevný limit počtu pokusů. Kandidát, poslední review a další fáze se ukládají do auditních checkpointů; technická chyba, odpojení požadavku nebo restart API nepřijdou o již uložený návrh. Opakované potvrzení generování naváže na poslední checkpoint, pokud se nezměnilo zadání, kontrakt, stav roadmapy, architektura, provider nebo model. Schválený návrh čekající na uložení cyklu se znovu nereviewuje. Změněné vstupy vyžadují nový návrh; stará historie se nemaže. Checkpointy neobsahují surové provider prompty/odpovědi a používají stávající redakci secrets. Jedna instance API odmítá souběžné generování stejného projektu; zrušení požadavku se předává i do probíhající opravy/review. Stejné navázání platí pro potvrzené rozšíření projektu. Návrhy z neúspěšných běhů před zavedením checkpointů se automaticky neimportují z interních provider logů.

## 4. Hlavní cíle

### 4.1 Funkční cíle

ForgeMind musí umožnit:

* přihlášení uživatele,
* výběr GitHub repozitáře,
* zadání komplexního vývojového úkolu,
* vytvoření GitHub issue,
* vytvoření pracovní branche,
* spuštění AI agenta nad repozitářem,
* opakované iterace implementace,
* spouštění validačních příkazů,
* sledování limitů,
* zobrazení průběhu na mobilu,
* vytvoření draft pull requestu,
* zápis výsledků do PR,
* historii běhů,
* přepínání AI providerů,
* projektovou konfiguraci chování agenta.

### 4.2 Nefunkční cíle

Systém musí být:

* bezpečný,
* auditovatelný,
* rozšiřitelný,
* provozovatelný na Linux serveru,
* vhodný pro více repozitářů,
* vhodný pro použití z telefonu,
* připravený na limity AI služeb,
* odolný proti zacyklení,
* navržený tak, aby šel časem rozšířit o více workerů.

## 5. Co není cílem MVP

V první verzi není cílem:

* automatický deploy do produkce,
* automatický merge do `main`,
* vlastní trénování modelu,
* nahrazení GitHubu,
* vlastní IDE,
* komplexní multi-user enterprise správa práv.

Tyto funkce mohou být řešeny až ve verzích v1/v2.

## 6. Cílové prostředí

Primární cílové prostředí:

```text
OS: Linux server
Backend: Node.js + TypeScript
Frontend: React + Vite
Mobilní aplikace: PWA
Databáze: PostgreSQL
Fronta: Redis + BullMQ nebo PostgreSQL queue
Repozitáře: GitHub
Worker: Linux proces / systemd služba
Volitelný validační worker: ručně aktivovaná Windows stanice
AI provider: Codex SDK/CLI jako první provider
```

PWA je vhodná volba pro mobilní část, protože progresivní webová aplikace běží z jedné codebase na více platformách, může se chovat podobně jako nativní aplikace a může být instalovatelná do zařízení.

## 7. Architektura systému

### 7.1 Přehled

```text
+----------------------+
| ForgeMind Mobile     |
| PWA v telefonu       |
+----------+-----------+
           |
           v
+----------------------+
| ForgeMind Studio API |
| Backend orchestrator |
+----------+-----------+
           |
           +-------------------+
           |                   |
           v                   v
+------------------+    +------------------+
| PostgreSQL       |    | Queue            |
| stav, audit      |    | tasky, běhy      |
+------------------+    +--------+---------+
                                  |
                                  v
                       +--------------------+
                       | ForgeMind Agent    |
                       | Linux worker       |
                       +---------+----------+
                                 |
              +------------------+------------------+
              |                  |                  |
              v                  v                  v
       +-------------+    +--------------+    +-------------+
       | GitHub API  |    | AI Provider  |    | Build/Test  |
       | issue/PR    |    | Codex/Copilot|    | shell cmds  |
       +-------------+    +--------------+    +-------------+
```

### 7.2 Komponenty

#### ForgeMind Mobile

Mobilní PWA pro:

* zadávání promptů,
* výběr projektu,
* sledování běžících úkolů,
* potvrzování rizikových změn,
* sledování metrik a historie pokusů,
* otevření PR v GitHubu,
* čtení logů a výsledků testů.

#### ForgeMind Studio

Webové rozhraní pro desktop/tablet:

* správa projektů,
* správa providerů,
* správa limitů,
* přehled tasků,
* audit,
* konfigurace GitHub integrace,
* monitoring.

#### ForgeMind Studio API

Backendová služba:

* autentizace,
* REST API,
* GitHub webhook receiver,
* správa tasků,
* správa projektů,
* správa providerů,
* fronta úkolů,
* auditní log,
* notifikace.

#### ForgeMind Agent

Linux worker:

* klonuje repozitář,
* vytváří worktree,
* spouští AI providera,
* aplikuje změny,
* spouští build/test/lint,
* sbírá logy,
* počítá iterace,
* kontroluje limity,
* pushuje branch,
* vytváří PR.

#### AI Provider Adapter

Vrstva pro výměnu AI motorů:

```text
AIProvider
├── CodexProvider
├── GitHubCopilotProvider
├── OpenAIProvider
├── LocalProvider
└── MockProvider
```

#### GitHub Adapter

Vrstva pro:

* vytvoření issue,
* vytvoření branche,
* commit,
* push,
* vytvoření PR,
* komentáře v PR,
* čtení CI statusů,
* příjem webhooků.

GitHub App je preferovaný způsob integrace, protože GitHub Apps mají jemně nastavitelná oprávnění, kontrolu nad přístupnými repozitáři a krátkodobé tokeny.

## 8. Projektová konfigurace

Každý repozitář musí mít vlastní konfiguraci chování agenta. Doporučené soubory:

```text
agent.config.yaml
.github/ISSUE_TEMPLATE/ai-task.yml
.github/PULL_REQUEST_TEMPLATE/ai-agent.md
```

### 8.1 `agent.config.yaml`

Ukázka:

```yaml
project:
  id: "starpant-gallery"
  name: "STARPANT Gallery"
  repo: "github.com/company/starpant-gallery"
  default_branch: "main"
  type: "frontend-static"
  runtime: "node"

workflow:
  default_mode: "safe"
  create_issue: true
  create_branch: true
  create_draft_pr: true
  auto_push: true
  auto_merge: false
  allow_ai_auto_improvements: true

ai:
  primary_provider: "codex"
  fallback_provider: "github_copilot"
  reviewer_provider: "codex"
  # reviewer_connection_id: "provider-connection-id"
  model_profile: "balanced"

github:
  issue_label: "ai-task"
  branch_prefix: "ai/"
  pr_draft: true
```

## 9. Režimy autonomie

Hodnoty `safe`, `auto` a `full_auto` zůstávají kompatibilním projektovým nastavením pro produktové chování a GitHub delivery. Neaktivují příkazový allowlist ani approval gate. Implementace, AI validace a read-only review mají ve všech režimech stejný jednoduchý feedback loop.

## 10. Životní cyklus úkolu

### 10.1 Stavový automat

```text
draft
  ↓
submitted
  ↓
creating_github_issue
  ↓
creating_branch
  ↓
running_ai
  ↓
validating
  ↓
reviewing
  ↓
creating_pr
  ↓
ready_for_user_review
  ↓
completed
```

Chybové stavy:

```text
failed
cancelled
provider_failed
validation_failed
```

### 10.2 Iterační smyčka

```text
1. Načti task.
2. Načti project config.
3. Připrav repozitář, issue a branch podle projektového nastavení.
4. Spusť AI implementaci nad zadáním a aktuálním repozitářem.
5. Získej diff, shrnutí a sadu validačních příkazů od implementační AI.
6. Spusť všechny navržené příkazy bez obsahového omezení.
7. Pokud validace selže, pošli implementační AI celý příkaz, exit code, stdout a stderr.
8. AI opraví implementaci nebo validační sadu; platné checkpointy nad nezměněným workspace se neopakují.
9. Pokud lokální validace projde, spusť read-only AI review pouze proti zadání a akceptačním kritériím; případné Windows kontroly označ jako odložené, nikoli jako úspěšné.
10. Pokud review najde blocker, vrať jeho celé znění implementační AI.
11. Bez blockeru pushni branch, otevři pull request a zapiš shrnutí a výsledek.
```

## 11. Metriky a obnova

Metriky tokenů, ceny, času a velikosti změn slouží pouze k reportingu a nikdy nezastavují task. O obnově po chybě rozhodují checkpointy fáze: worker pokračuje od selhané operace a neopakuje již dokončenou přípravu, GitHub delivery ani platné validační příkazy. Codex subprocess má desetihodinový technický timeout proti opuštěnému procesu; nejde o task budget ani o rozhodovací limit orchestrace.

## 12. Autorizace bez runtime approval

Všechny API operace vyžadují platnou Google session a odpovídající roli. Browser mutace chrání origin a CSRF. Worker používá pouze oprávnění provozního účtu a konkrétních uložených integrací. Samostatná žádost o schválení uprostřed tasku se nevytváří.

## 13. Mobilní aplikace ForgeMind Mobile

ForgeMind Mobile bude PWA.

Hlavní obrazovky:

### 13.1 Přehled projektů

* seznam projektů,
* stav posledních tasků,
* počet otevřených PR,
* spotřeba AI rozpočtu.

### 13.2 Nový úkol

Pole:

```text
Projekt
Název úkolu
Komplexní zadání
Režim autonomie
Max. rozpočet
Max. počet iterací
Priorita
Volitelné soubory / oblasti projektu
```

### 13.3 Detail úkolu

Zobrazit:

```text
Stav
Aktuální krok
Plán
Iterace
Spotřeba
Poslední log
Výsledek testů
Diff summary
Odkaz na issue
Odkaz na PR
Chyba aktuální fáze a historie pokusů
```

### 13.4 Historie pokusů

Detail ukazuje aktivní fázi, průběžnou aktivitu, výsledek každého pokusu a plnou chybu posledního selhání. Nový pokus nesmí zaměňovat starou chybu za chybu aktuálního pokusu.

Push notifikace v PWA musí využívat service worker; Push API vyžaduje aktivní service worker a subscription přes PushManager.

## 14. GitHub integrace

ForgeMind musí být primárně integrován s GitHubem.

### 14.1 GitHub App

Vytvořit GitHub App:

```text
ForgeMind GitHub App
```

Minimální oprávnění:

```text
Repository metadata: read
Contents: read/write
Issues: read/write
Pull requests: read/write
Checks: read
Actions: read
Commit statuses: read
```

Webhook eventy:

```text
issues
issue_comment
pull_request
pull_request_review
push
check_suite
workflow_run
```

### 14.2 GitHub Issue

Při zadání tasku vytvořit issue:

```text
[AI] Přidat galerii fotek podle dne
```

Issue body musí obsahovat:

```markdown
## Cíl
...

## Kontext
...

## Omezení
...

## Akceptační kritéria
...

## Režim
safe

## Limity
- max iterací:
- max rozpočet:
```

### 14.3 Branch naming

Formát branche:

```text
ai/<issue-number>-<slug>
```

Příklad:

```text
ai/123-gallery-by-date
```

### 14.4 Pull request

PR musí být draft.

PR body:

```markdown
## Shrnutí změn

## Splněná akceptační kritéria

## Testy

## Rizika

## Co agent automaticky vylepšil

## Co vyžaduje lidské review

## Spotřeba

## Rollback
```

GitHub Copilot cloud agent je relevantní fallback nebo alternativní provider, protože podle GitHub dokumentace umí plánovat, dělat změny na branchi, iterovat a otevřít pull request v prostředí poháněném GitHub Actions.

## 15. AI Provider API

Interně musí ForgeMind pracovat s jednotným rozhraním.

```ts
export type ProviderKind =
  | 'codex'
  | 'github_copilot'
  | 'openai'
  | 'local'
  | 'mock';

export interface AIProvider {
  kind: ProviderKind;

  plan(input: PlanInput): Promise<PlanResult>;

  implement(input: ImplementInput): Promise<ImplementResult>;

  review(input: ReviewInput): Promise<ReviewResult>;

  estimateCost(input: CostEstimateInput): Promise<CostEstimateResult>;

  supportsLocalRepo(): boolean;

  supportsGitHubNativeFlow(): boolean;
}
```

### 15.1 CodexProvider

První implementovaný provider.

Požadavky:

* použít Codex SDK nebo CLI,
* pracovat nad lokálním worktree,
* předávat jako obsah tasku pouze zadání aktuálního kroku,
* běžet bez `sudo`,
* běžet v provozně izolovaném worker prostředí.

ForgeMind nefiltruje AI příkazy podle jejich obsahu. Bezpečnostní hranici proto musí poskytovat účet a kontejner workeru, oprávnění uložených integrací a oddělený workspace. Tato provozní izolace není součástí validační orchestrace.

### 15.2 GitHubCopilotProvider

Druhá fáze.

Možnosti:

* vytvořit task pro Copilot cloud agent,
* propojit task s issue,
* sledovat PR vytvořený Copilotem,
* importovat výsledek zpět do ForgeMind historie.

### 15.3 MockProvider

Nutný pro testování.

Mock provider musí umět:

* vrátit statický plán,
* vytvořit umělý diff,
* simulovat chybu buildu,
* simulovat překročení rozpočtu,
* simulovat chybu validace a review blocker.

## 16. Datový model

### 16.1 Tabulka `users`

```sql
id
email
name
github_user_id
role
created_at
updated_at
```

### 16.2 Tabulka `projects`

```sql
id
name
slug
github_owner
github_repo
default_branch
config_yaml
is_active
created_at
updated_at
```

### 16.3 Tabulka `tasks`

```sql
id
project_id
created_by_user_id
title
prompt
mode
status
github_issue_number
github_issue_url
branch_name
pull_request_number
pull_request_url
created_at
updated_at
started_at
finished_at
```

### 16.4 Tabulka `task_runs`

```sql
id
task_id
provider
model
status
iteration_count
input_tokens
output_tokens
estimated_cost_usd
started_at
finished_at
summary
error_message
```

### 16.5 Tabulka `task_iterations`

```sql
id
task_run_id
iteration_number
phase
prompt
result_summary
diff_stat_json
validation_result_json
created_at
```

### 16.6 Historické tabulky `approvals`

Tabulky zůstávají pouze kvůli čitelnosti auditu starých běhů. Aktivní runtime nové approval záznamy nevytváří ani neřeší.

```sql
id
task_id
type
status
requested_by
approved_by_user_id
title
description
risk_level
payload_json
created_at
resolved_at
```

### 16.7 Tabulka `provider_usage`

```sql
id
task_id
task_run_id
provider
model
input_tokens
output_tokens
cached_tokens
credits
estimated_cost_usd
created_at
```

### 16.8 Tabulka `audit_log`

```sql
id
actor_type
actor_id
event_type
project_id
task_id
payload_json
created_at
```

## 17. Backend API

### 17.1 Auth

```http
POST /api/auth/github/login
GET  /api/auth/github/callback
POST /api/auth/logout
GET  /api/me
```

### 17.2 Projects

```http
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
GET    /api/projects/:id/config
PUT    /api/projects/:id/config
```

### 17.3 Tasks

```http
GET    /api/tasks
POST   /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/start
POST   /api/tasks/:id/cancel
POST   /api/tasks/:id/retry
GET    /api/tasks/:id/logs
GET    /api/tasks/:id/diff
GET    /api/tasks/:id/usage
```

### 17.4 Runtime approvals

Aktivní approval API bylo odstraněno. Autorizovaný uživatel provádí podporované mutace přímo; každá operace se nadále zapisuje do auditu.

### 17.5 GitHub webhook

```http
POST /api/webhooks/github
```

Webhook musí ověřit podpis a odmítnout neplatný payload.

### 17.6 Notifications

```http
POST /api/notifications/subscribe
POST /api/notifications/unsubscribe
GET  /api/notifications/settings
PUT  /api/notifications/settings
```

## 18. Bezpečnostní požadavky

### 18.1 Worker

ForgeMind Agent musí běžet jako samostatný Linux uživatel, například:

```text
forgemind-agent
```

Nesmí mít:

```text
sudo
root
přístup k produkčním secrets
přístup k /root
přístup k /home/*/.ssh
přístup k /var/run/docker.sock
```

### 18.2 systemd hardening

Doporučený základ:

```ini
[Service]
User=forgemind-agent
Group=forgemind-agent
WorkingDirectory=/opt/forgemind/agent
ExecStart=/usr/bin/node dist/worker.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/forgemind/workspaces /var/lib/forgemind /var/log/forgemind
```

### 18.3 Workspace izolace

Každý task musí mít vlastní pracovní adresář:

```text
/opt/forgemind/workspaces/<task-id>/
```

Po dokončení:

* zachovat diff,
* zachovat logy,
* workspace smazat podle retention policy,
* nikdy nemazat mimo workspace.

### 18.4 Secrets

Secrets nesmí být:

* v promptu,
* v logu,
* v PR,
* v issue,
* v repozitáři.

Musí být redakce logů:

```text
OPENAI_API_KEY=***
GITHUB_TOKEN=***
```

### 18.5 Síť

Validační workflow síťové příkazy neblokuje. Případná síťová izolace se nastavuje na úrovni hostitele nebo kontejneru workeru a nesmí měnit význam AI navržené validace.

## 19. Monitoring a logování

### 19.1 Logy

Logovat:

```text
task_created
task_started
plan_created
branch_created
provider_started
provider_finished
validation_started
validation_failed
validation_passed
pr_created
task_completed
task_failed
```

### 19.2 Metriky

Minimální metriky:

```text
forgemind_tasks_total
forgemind_tasks_running
forgemind_tasks_failed_total
forgemind_task_duration_seconds
forgemind_provider_cost_usd_total
forgemind_provider_tokens_total
forgemind_iterations_total
forgemind_validation_failures_total
```

### 19.3 Audit

Každá akce musí být auditovatelná:

```text
kdo
kdy
co
nad jakým projektem
nad jakým taskem
s jakým výsledkem
```

## 20. Testovací strategie

### 20.1 Unit testy

Testovat:

* parsování konfigurace,
* validaci limitů,
* stavový automat,
* budget tracker,
* phase-aware checkpoint a retry pravidla,
* provider adapter interface,
* GitHub payload parser.

### 20.2 Integrační testy

Testovat:

* vytvoření issue,
* vytvoření branche,
* vytvoření PR,
* zpracování webhooku,
* simulace provider běhu,
* simulace selhání buildu,
* navrácení plné validační chyby implementační AI.

### 20.3 E2E testy

Scénáře:

```text
1. Uživatel zadá jednoduchý task.
2. Systém vytvoří issue a branch.
3. Mock provider vytvoří změnu.
4. Validace projde.
5. Systém vytvoří draft PR.
6. Mobilní aplikace zobrazí "ready for review".
```

Druhý scénář:

```text
1. Validace selže.
2. Worker předá AI celý příkaz, exit code, stdout a stderr.
3. AI opraví implementaci nebo validační sadu.
4. Worker neopakuje dříve platné checkpointy nad nezměněným workspace.
5. Validace projde a workflow pokračuje do review.
```

Třetí scénář:

```text
1. Build selže.
2. Agent opraví chybu.
3. AI dostane úplný výstup chyby a zvolí jinou opravu implementace nebo validace.
4. Již úspěšné checkpointy nad nezměněným workspace se znovu nespouštějí.
```

## 21. MVP rozsah

MVP musí obsahovat:

```text
ForgeMind Studio API
ForgeMind Mobile PWA
ForgeMind Agent worker
PostgreSQL databázi
GitHub App integraci
CodexProvider nebo MockProvider + připravené rozhraní pro Codex
projektovou konfiguraci
task lifecycle
phase-aware retry a audit
draft PR workflow
základní logy a audit
základní budget/iteration limity
```

### 21.1 MVP user story

```text
Jako uživatel chci z telefonu zadat úkol nad GitHub repozitářem, aby ForgeMind vytvořil branch, spustil AI agenta, provedl změny, otestoval je a vytvořil draft PR.
```

### 21.2 MVP akceptační kritéria

MVP je hotové, když:

* lze se přihlásit,
* lze přidat GitHub projekt,
* lze vytvořit task,
* task vytvoří GitHub issue,
* task vytvoří branch,
* worker spustí provider,
* worker spustí validační příkaz,
* systém uloží logy,
* systém hlídá max iterace,
* systém vytvoří draft PR,
* mobilní UI zobrazí stav,
* validace a review vrací úplnou zpětnou vazbu implementaci,
* konfigurace projektu se načítá z YAML,
* systém odmítne zakázanou akci.

## 22. Roadmapa

### Fáze 1 – MVP

* jeden uživatel,
* jeden Linux worker,
* GitHub App,
* základní PWA,
* CodexProvider nebo MockProvider,
* draft PR,
* ruční merge mimo ForgeMind,

### Fáze 2 – v1

* více projektů,
* plnohodnotný CodexProvider,
* GitHubCopilotProvider,
* detailní cost tracking,
* Telegram notifikace,
* lepší diff viewer,
* AI review,
* auto safe improvements,
* projektové šablony.

### Fáze 3 – v2

* více workerů,
* plánování fronty,
* role a oprávnění,
* multi-agent režim,
* staging deploy,
* metriky v Grafaně,
* pokročilý audit,
* policy engine,
* marketplace providerů.

### Fáze 4 – budoucí enterprise verze

* organizace/týmy,
* SSO,
* audit export,
* on-prem režim,
* vlastní registry pravidel,
* více Git providerů,
* integrace Jira/Linear,
* schvalovací workflow podle týmů.

## 23. Doporučená struktura repozitáře ForgeMind

```text
forgemind/
├── apps/
│   ├── studio-api/
│   ├── mobile-pwa/
│   └── worker/
├── packages/
│   ├── core/
│   ├── github/
│   ├── providers/
│   ├── config/
│   ├── db/
│   └── shared/
├── infra/
│   ├── docker-compose.yml
│   ├── systemd/
│   └── nginx/
├── docs/
│   ├── architecture.md
│   ├── security.md
│   ├── provider-api.md
│   └── project-config.md
└── README.md
```

## 24. Doporučený technologický stack

```text
Frontend:
- React
- Vite
- TypeScript
- TanStack Query
- PWA service worker

Backend:
- Node.js
- TypeScript
- Fastify nebo Express
- Zod
- Prisma
- PostgreSQL

Worker:
- Node.js
- TypeScript
- child_process / execa
- simple-git
- provider adapters

Queue:
- BullMQ + Redis
  nebo
- PostgreSQL based queue pro jednodušší MVP

GitHub:
- GitHub App
- Octokit

AI:
- Codex SDK/CLI
- provider adapter interface
- později GitHub Copilot cloud agent

Monitoring:
- strukturované JSON logy
- Prometheus metrics
- OpenTelemetry později
```

## 25. První implementační kroky pro AI programátora

### Krok 1: Vytvořit monorepo

Vytvořit základ:

```text
apps/studio-api
apps/mobile-pwa
apps/worker
packages/core
packages/github
packages/providers
packages/config
packages/db
packages/shared
```

### Krok 2: Databáze

Vytvořit Prisma schema pro:

```text
users
projects
tasks
task_runs
task_iterations
provider_usage
audit_log
```

### Krok 3: Backend API

Implementovat:

```text
POST /api/tasks
GET /api/tasks
GET /api/tasks/:id
POST /api/tasks/:id/start
POST /api/tasks/:id/retry
POST /api/tasks/:id/cancel
```

### Krok 4: Worker

Implementovat jednoduchý worker:

```text
1. vezme task z fronty,
2. vytvoří workspace,
3. naklonuje repo,
4. založí branch,
5. zavolá implementační AI provider,
6. spustí validační příkazy vrácené implementační AI,
7. předá případnou plnou chybu zpět implementaci,
8. provede read-only review proti zadání,
9. pushne branch a vytvoří pull request.
```

### Krok 5: GitHub adapter

Implementovat:

```text
createIssue()
createBranch()
commitAndPush()
createDraftPullRequest()
commentOnIssue()
readCheckStatus()
```

### Krok 6: Mobile PWA

Implementovat obrazovky:

```text
Tasks list
New task
Task detail
AI Chat
Settings
```

### Krok 7: CodexProvider

Po dokončení základního workflow nahradit MockProvider skutečným CodexProviderem.

## 26. Ukázkové zadání pro první testovací task

```text
Projekt: demo-static-gallery

Cíl:
Přidej do statické HTML galerie seskupování obrázků podle dne.

Kontext:
Repozitář obsahuje jednoduché HTML, CSS a JavaScript soubory.
Galerie běží přes nginx bez backendu.
Obrázky jsou načítány ze statické složky.

Omezení:
Nepřidávej backend.
Nepřidávej npm dependency.
Neměň nginx konfiguraci.
Neměň deployment.

Akceptační kritéria:
- Galerie zobrazí fotky seskupené podle dne.
- Kliknutí otevře fullscreen náhled.
- Šipky vlevo/vpravo přepínají fotky.
- Esc zavře náhled.
- Mobilní zobrazení je použitelné.
- npm run build skončí bez chyby.
- V konzoli prohlížeče není chyba.

Režim:
safe

Limity:
max 10 iterací
max 20 změněných souborů
max rozpočet 2 USD
```

## 27. Definice hotovo pro ForgeMind MVP

Projekt ForgeMind MVP je hotový, pokud lze provést tento scénář:

```text
1. Uživatel otevře ForgeMind Mobile.
2. Vybere GitHub projekt.
3. Zadá komplexní prompt.
4. ForgeMind vytvoří GitHub issue.
5. ForgeMind založí branch.
6. ForgeMind Agent spustí AI providera.
7. Agent provede změny.
8. Agent spustí testy/build.
9. Při chybě validace předá kompletní výstup AI a nechá ji problém opravit.
10. Read-only review potvrdí soulad se zadáním, nebo vrátí blocker implementaci.
11. Agent vytvoří pull request.
12. V PR je shrnutí, test report, diff summary a spotřeba.
13. Uživatel může otevřít PR v GitHubu.
```

## 28. Kritické požadavky

Tyto požadavky nesmí být vynechány:

```text
- Žádný nekontrolovaný sudo/root přístup.
- Žádný automatický produkční deploy v MVP.
- Všechny změny přes Git branch.
- Každý task má limity.
- Každý běh má audit.
- Každý retry naváže od první nedokončené operace.
- AI provider je vyměnitelný.
- Projektová pravidla jsou konfigurovatelná.
- GitHub je hlavní zdroj pravdy.
- Validační příkazy navrhuje pouze implementační AI.
```

## 29. Shrnutí

ForgeMind má být vlastní řídicí platforma pro AI vývojáře. Nemá být jen chat s AI, ale systém, který přijme komplexní úkol, nechá AI implementovat řešení, spustí AI navrženou validaci, vrátí úplnou chybu k opravě, provede nezávislé read-only review a předá hotovou práci přes GitHub pull request.

Základní produktová struktura:

```text
ForgeMind Studio – řízení a administrace
ForgeMind Mobile – telefonní ovládání a sledování
ForgeMind Agent  – Linux worker pro autonomní práci
```

První verze má být bezpečná, auditovatelná a prakticky použitelná. Automatizace se bude rozšiřovat postupně až po ověření, že workflow funguje spolehlivě.

## 30. README parity a acceptance

Aktualni parity status mezi README pozadavky a implementaci je veden v:

- `docs/readme-parity.md` (mapovani pozadavek -> implementace/odlozeni)
- `docs/implementation-tracker.md` (krokovy stav + prubezne overeni)

Statusy v dokumentaci jsou:

- `implemented`: existuje runtime implementace nebo dokumentovana konfigurace v repozitari.
- `tested`: existuje executable test reference nebo validacni prikaz.
- `production-verified`: existuje explicitni produkcni overeni.
- `deferred`: oblast je vedome mimo aktualni scope nebo ceka na rucni/produkci schopne overeni.

Aktualni stav tohoto repozitare:

- README runtime parity je `implemented` a reprezentativni pipeline coverage je `tested`; evidence je v `docs/readme-parity.md`, workflow testech a `apps/studio-api/src/routes.test.ts`.
- Produkcni overeni realneho GitHubu, realneho providera a nasazene PWA je `deferred`.
- Automaticky produkcni deploy projektu spravovanych ForgeMindem zustava `deferred` a mimo aktualni scope.

### Windows validation worker (vNext)

- `implemented`: uzce omezeny Windows CLI runner, odchozi Studio API transport, manualni session, capability probe, lease/cancel/result flow, bezpecny fixture executor, upload logu a artefaktu a pinned Unreal command adapter jsou v `apps/windows-runner/src`, `apps/studio-api/src/routes/windows-runner-routes.ts`, `packages/core/src/windows-worker.ts` a `packages/db/src/windows-worker-repository.ts`.
- `tested`: schema a policy testy jsou v `packages/core/src/windows-worker.test.ts`; runner testy v `apps/windows-runner/src/*.test.ts`; API a fake-runner tok v `apps/studio-api/src/routes/windows-runner-routes.test.ts` a `apps/studio-api/src/routes/windows-runner-routes.integration.test.ts`; persistence lease toku v `packages/db/src/windows-worker-repository.test.ts` a `packages/db/src/windows-worker-repository.integration.test.ts`.
- `production-verified`: zadna cast Windows/Unreal rollout zatim tento status nema.
- `deferred`: realna BOREK-FILIP Unreal validace vyzaduje lokalni rucni session, samostatne schvaleni dlouhe Unreal prace a lokalne pripnute/probed tooling. Jeji provedeni i manualni finalni audit jsou dalsi rucne spoustene kroky; fixture ani staticka evidence je nenahrazuji.

Windows runner je pouze validacni executor pro presny commit SHA a verzovane schema z `packages/core`. Neni obecny remote shell: nesmi planovat ani implementovat, pouzivat Git push, merge, PR nebo deploy, pristupovat primo do databaze, provozovat Docker, bezet bezobsluzne jako sluzba ani menit UAC, restart nebo security konfiguraci.

Lokalni adapter policy se runneru predava v `FORGEMIND_WINDOWS_ADAPTER_POLICY` jako JSON s poli `allowedFixtureExecutablePaths`, `pinnedUnrealTools` a `approvedUnrealProfiles`. Prazdna nebo chybejici policy nic nespusti. Velky Unreal profil navic vyzaduje interaktivni TTY potvrzeni a diskovy preflight; server nema approval frontu.

Autoritativni release validace pro MVP delta:

- `npm run build`
- `npm run typecheck`
- `npm test`

## 31. Produkcni provoz ForgeMind

Samotnou platformu ForgeMind lze nasadit na OCI/Ubuntu server pomoci Docker Compose a GitHub Actions. Produkcni stack izoluje API, worker, PostgreSQL, Codex data a pracovni adresare pod Compose projektem `forgemind`. Verejny HTTPS vstup lze sdilet s jinymi aplikacemi pres externi Docker sit `shared-edge` bez kolize host portu. Na spolecnem serveru s projektem Running je ForgeMind dostupny na `https://myrunning.duckdns.org:8443`.

Kompletni priprava serveru, secrets a deployment workflow jsou popsane v `docs/deploy-oci.md`.

Migrace existujici produkce na ARM64 Raspberry Pi pres Tailscale je popsana v `docs/deploy-raspberry.md`. Raspberry workflow nasazuje automaticky po pushi do `main` a lze jej spustit i rucne; OCI workflow zustava rucni jako rollback cesta. Raspberry pouziva samostatne ARM64 image tagy, aby neovlivnil OCI nasazeni.

Nasazeni platformy je oddelene od GitHub delivery a produkcniho deploye projektu spravovanych ForgeMindem.
