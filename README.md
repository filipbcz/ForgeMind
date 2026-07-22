# ForgeMind – zadávací dokumentace projektu

Verze dokumentu: 0.1
Stav: návrh pro MVP a navazující vývoj
Název platformy: **ForgeMind**
Produktová řada: **ForgeMind Studio**, **ForgeMind Agent**, **ForgeMind Mobile**

## 1. Účel projektu

Cílem projektu ForgeMind je vytvořit vlastní platformu pro řízení autonomních AI vývojových agentů. Platforma má umožnit zadávat komplexní programátorské úkoly z mobilního telefonu, spouštět nad nimi AI vývojáře, integrovat výsledek s GitHubem a bezpečně řídit celý životní cyklus od zadání přes implementaci, testování, review až po draft pull request.

ForgeMind nesmí být pevně navázán pouze na jednoho AI providera. Primárním providerem bude Codex, ale architektura musí umožnit připojení dalších providerů, například GitHub Copilot cloud agentu nebo jiného modelu/API. Codex SDK je vhodný kandidát pro vlastní serverové workflow, protože oficiální dokumentace uvádí použití pro CI/CD, interní workflow, vlastní agenty a integraci do aplikace.

Platforma se skládá ze tří hlavních produktových částí:

```text
ForgeMind Studio   – webové administrační a vývojové rozhraní
ForgeMind Mobile   – mobilní PWA pro zadávání úkolů a schvalování
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
4. Připraví plán implementace.
5. Spustí vybraného AI providera.
6. Nechá provést změny v repozitáři.
7. Spustí build, testy, lint a další validační příkazy.
8. Pokud testy selžou, předá chybu zpět agentovi a nechá ji opravit.
9. Hlí­dá počet iterací, rozpočet, čas a změněné soubory.
10. Provede AI review změn.
11. Bezpečná vylepšení může provést automaticky.
12. Rizikové změny předloží ke schválení do telefonu.
13. Pushne branch na GitHub.
14. Otevře draft pull request.
15. Do PR vloží shrnutí, test report, rizika a spotřebu.
16. Po schválení umožní merge nebo další iteraci.

## 3. Základní principy

ForgeMind musí být navržen jako řídicí systém, ne jen jako jednoduchý wrapper nad AI CLI. Hlavní hodnotou systému je orchestrace, bezpečnost, audit, opakovatelnost a kontrola dokončení.

Základní principy:

```text
GitHub je zdroj pravdy.
AI provider je vyměnitelný.
Každý úkol má měřitelné akceptační kritérium.
Každý běh má limity.
Každý výsledek končí v branchi nebo draft PR.
Každá riziková změna vyžaduje schválení.
Agent nesmí mít nekontrolovaný přístup k systému.
```

Codex podporuje projektové instrukce přes `AGENTS.md`, které čte před zahájením práce, takže ForgeMind má pro každý repozitář generovat nebo udržovat tento soubor jako součást projektových instrukcí.

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
* vyžádání schválení při rizikové změně,
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
* plně autonomní rozhodování bez schvalování,
* vlastní trénování modelu,
* nahrazení GitHubu,
* podpora Windows/Delphi workeru,
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
* schvalování navýšení limitu,
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
AGENTS.md
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
  model_profile: "balanced"

limits:
  max_iterations: 15
  max_runtime_minutes: 90
  max_changed_files: 25
  max_diff_lines: 2000
  max_repeated_error_count: 3
  max_budget_usd: 5.00
  soft_budget_threshold_percent: 75
  hard_budget_threshold_percent: 100

commands:
  install: "npm ci"
  lint: "npm run lint"
  build: "npm run build"
  test_unit: "npm test"
  test_e2e: "npm run test:e2e"
  verify: "npm run lint && npm test && npm run build"

approval:
  required_for:
    - new_dependency
    - database_migration
    - nginx_config_change
    - systemd_change
    - github_workflow_change
    - delete_files
    - deploy
    - merge_pr
    - budget_increase
    - write_outside_repo

  auto_allowed:
    - docs_update
    - test_update
    - lint_fix
    - refactor_without_behavior_change
    - small_ui_fix

sandbox:
  allow_network: false
  allow_sudo: false
  writable_paths:
    - "/workspace"
    - "/tmp/forgemind"
  forbidden_paths:
    - "/etc"
    - "/root"
    - "/home/*/.ssh"
    - "/var/run/docker.sock"

github:
  issue_label: "ai-task"
  branch_prefix: "ai/"
  pr_draft: true
  require_ci_green: true
```

### 8.2 `AGENTS.md`

Ukázka:

```markdown
# AGENTS.md

## Účel projektu

Tento repozitář obsahuje statickou webovou galerii pro STARPANT.

## Pravidla pro AI agenta

- Neměň konfigurační soubory nginx bez schválení.
- Nepřidávej nové npm dependency bez schválení.
- Nepoužívej sudo.
- Neměň soubory mimo repozitář.
- Po každé změně spusť validační příkazy z agent.config.yaml.
- Pokud testy selžou, oprav chybu a spusť je znovu.
- Pokud se stejná chyba opakuje 3×, zastav práci a požádej o zásah.

## Done when

Úkol je hotový pouze tehdy, když:

- build skončí exit code 0,
- lint skončí exit code 0,
- testy skončí exit code 0,
- změny odpovídají zadání,
- nevznikly změny mimo scope,
- je vytvořen draft pull request,
- PR obsahuje shrnutí změn, test report a rizika.
```

## 9. Režimy autonomie

ForgeMind musí podporovat tři režimy.

### 9.1 Safe mode

Výchozí režim.

Agent smí:

* číst repozitář,
* vytvořit branch,
* měnit soubory ve workspace,
* spouštět povolené příkazy,
* vytvořit draft PR.

Agent nesmí bez schválení:

* přidat dependency,
* měnit CI/CD,
* měnit databázové migrace,
* měnit systemd/nginx,
* mazat větší množství souborů,
* nasadit změnu,
* mergovat PR.

### 9.2 Auto mode

Agent navíc smí:

* provést bezpečná AI navržená vylepšení,
* aktualizovat PR,
* pushovat průběžné commity,
* reagovat na komentáře v PR.

Stále nesmí:

* merge,
* deploy do produkce,
* měnit secrets,
* zvyšovat oprávnění,
* měnit infrastrukturu bez schválení.

### 9.3 Full-auto mode

Určeno až pro budoucí použití. V MVP pouze připravit datový model a konfiguraci, ale nepovolovat automatický produkční deploy.

## 10. Životní cyklus úkolu

### 10.1 Stavový automat

```text
draft
  ↓
submitted
  ↓
planning
  ↓
waiting_for_plan_approval?  [volitelné]
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
improving
  ↓
needs_approval?             [volitelné]
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
budget_exceeded
iteration_limit_reached
repeated_error_detected
approval_rejected
provider_failed
validation_failed
```

### 10.2 Iterační smyčka

```text
1. Načti task.
2. Načti project config.
3. Vytvoř plán.
4. Vytvoř branch.
5. Spusť AI implementaci.
6. Získej diff.
7. Spusť validace.
8. Pokud validace selže, pošli chybu zpět AI.
9. Pokud se chyba opakuje, zastav.
10. Pokud validace projde, spusť AI review.
11. Pokud review najde blocker, vrať do implementace.
12. Pokud review navrhne bezpečné vylepšení, proveď ho.
13. Pokud review navrhne rizikovou změnu, vyžádej schválení.
14. Pushni branch.
15. Otevři draft PR.
16. Zapiš shrnutí a výsledek.
```

## 11. Limity a ochrana proti zacyklení

Každý task musí mít limity:

```text
max_iterations
max_runtime_minutes
max_changed_files
max_diff_lines
max_repeated_error_count
max_budget_usd
max_input_tokens
max_output_tokens
max_auto_improvements
```

Agent musí zastavit, pokud:

* překročí počet iterací,
* překročí časový limit,
* spotřebuje rozpočet,
* stejná chyba se objeví 3×,
* diff roste bez zjevného pokroku,
* mění zakázané soubory,
* potřebuje nepovolený shell příkaz,
* chce přidat dependency bez schválení,
* chce zapisovat mimo workspace.

Diff a changed-files limity jsou review guardrails: při překročení se task přepne do schválení, ne do tvrdého selhání. Tvrdým stop signálem zůstává zacyklení, budget, runtime a opakované chyby.

Při dosažení soft limitu například 75 % rozpočtu musí ForgeMind poslat notifikaci:

```text
Úkol dosáhl 75 % rozpočtu. Agent navrhuje pokračovat ještě 3 iterace.
[Schválit] [Zastavit] [Upravit zadání]
```

## 12. Schvalování z telefonu

Schvalování musí být dostupné ve ForgeMind Mobile.

Typy schválení:

```text
approval_type:
  - budget_increase
  - continue_after_iteration_limit
  - new_dependency
  - risky_refactor
  - database_migration
  - config_change
  - deploy_staging
  - deploy_production
  - merge_pr
  - delete_files
```

Každá žádost o schválení musí obsahovat:

```text
- název úkolu,
- projekt,
- branch,
- důvod schválení,
- riziko,
- dotčené soubory,
- odhad další spotřeby,
- doporučení AI,
- tlačítka Schválit / Zamítnout / Upravit instrukci.
```

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
Čekající schválení
```

### 13.4 Schválení

Zobrazit jednoduchou kartu:

```text
Agent žádá o schválení

Důvod:
Přidání nové dependency "sharp".

Riziko:
Nová produkční dependency, možný dopad na build a deployment.

Doporučení:
Schválit pouze pokud je nutné generovat náhledy serverově.

[Schválit] [Zamítnout] [Napsat instrukci]
```

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
* předávat prompt se zadáním,
* předávat relevantní kontext,
* respektovat `AGENTS.md`,
* běžet bez `sudo`,
* běžet v sandboxovaném workspace.

Sandbox je důležitý, protože Codex dokumentace jej popisuje jako hranici, která umožňuje autonomní práci bez neomezeného přístupu k počítači; sandbox určuje například zapisovatelné soubory a síťový přístup, zatímco approval policy určuje, kdy se má agent zastavit a zeptat.

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
* simulovat potřebu schválení.

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
max_iterations
max_budget_usd
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

### 16.6 Tabulka `approvals`

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

### 17.4 Approvals

```http
GET    /api/approvals
GET    /api/approvals/:id
POST   /api/approvals/:id/approve
POST   /api/approvals/:id/reject
POST   /api/approvals/:id/comment
```

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

Výchozí režim:

```text
network_default: deny
```

Povolit jen nutné domény podle projektu, například:

```text
github.com
api.github.com
registry.npmjs.org
api.openai.com
```

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
approval_requested
approval_resolved
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
forgemind_approvals_pending
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
* approval rules,
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
* žádost o approval.

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
1. Provider navrhne přidat dependency.
2. Systém zastaví běh.
3. V mobilu se zobrazí approval.
4. Uživatel schválí.
5. Agent pokračuje.
```

Třetí scénář:

```text
1. Build selže.
2. Agent opraví chybu.
3. Build selže stejnou chybou 3×.
4. Systém zastaví task jako repeated_error_detected.
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
approval workflow
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
* approval z mobilu funguje,
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
* ruční schválení merge mimo ForgeMind.

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
approvals
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
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
```

### Krok 4: Worker

Implementovat jednoduchý worker:

```text
1. vezme task z fronty,
2. vytvoří workspace,
3. naklonuje repo,
4. založí branch,
5. zavolá MockProvider,
6. spustí verify command,
7. pushne branch,
8. vytvoří draft PR.
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
Approval detail
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
9. Pokud narazí na rizikovou změnu, požádá o potvrzení.
10. Uživatel potvrdí z telefonu.
11. Agent pokračuje.
12. Agent vytvoří draft PR.
13. V PR je shrnutí, test report, diff summary a spotřeba.
14. Uživatel může otevřít PR v GitHubu.
```

## 28. Kritické požadavky

Tyto požadavky nesmí být vynechány:

```text
- Žádný nekontrolovaný sudo/root přístup.
- Žádný automatický produkční deploy v MVP.
- Všechny změny přes Git branch.
- Každý task má limity.
- Každý běh má audit.
- Každé schválení je dohledatelné.
- AI provider je vyměnitelný.
- Projektová pravidla jsou konfigurovatelná.
- GitHub je hlavní zdroj pravdy.
- Mobilní schvalování je součást MVP.
```

## 29. Shrnutí

ForgeMind má být vlastní řídicí platforma pro AI vývojáře. Nemá být jen chat s AI, ale systém, který umí přijmout komplexní úkol, rozpadnout ho, nechat AI pracovat v bezpečných hranicích, opakovaně validovat výsledek, hlídat náklady, žádat o schválení a předat hotovou práci přes GitHub pull request.

Základní produktová struktura:

```text
ForgeMind Studio – řízení a administrace
ForgeMind Mobile – telefonní ovládání a schvalování
ForgeMind Agent  – Linux worker pro autonomní práci
```

První verze má být bezpečná, auditovatelná a prakticky použitelná. Automatizace se bude rozšiřovat postupně až po ověření, že workflow funguje spolehlivě.

## 30. README parity a acceptance

Aktualni parity status mezi README pozadavky a implementaci je veden v:

- `docs/readme-parity.md` (mapovani pozadavek -> implementace/odlozeni)
- `docs/implementation-tracker.md` (krokovy stav + prubezne overeni)

Finalni acceptance validace pro MVP delta:

- `npm run build`
- `npm test`
