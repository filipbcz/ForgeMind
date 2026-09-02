# Project Configuration

Projektova konfigurace se nacita z `agent.config.yaml` pres `packages/config` (`parseAgentConfigYaml`). Podporovana pole se validuji schematem. Odstranene top-level sekce `commands`, `approval` a `sandbox` se kvuli kompatibilite starych projektu ignoruji a nemaji zadny vliv na runtime.

## Podporovana struktura

### project

- `id`
- `name`
- `repo`
- `default_branch` (default `main`)
- `type` (default `unknown`)
- `runtime` (default `node`)

### workflow

- `default_mode`: `safe | auto | full_auto`
- `create_issue` (default `true`)
- `create_branch` (default `true`)
- `create_draft_pr` (default `true`)
- `auto_push` (default `true`)
- `auto_merge` (default `false`)
- `allow_ai_auto_improvements` (default `true`)

Rezim zustava projektovym nastavenim chovani, ale nezapina command allowlist ani runtime approval. Kazdy task pouziva stejny autonomni implementacni a validacni tok.

### ai

- `primary_provider`: `codex | github_copilot | openai`
- `fallback_provider`: stejny vycet (optional)
- `primary_connection_id`: ID ulozene provider connection (optional)
- `fallback_connection_id`: ID ulozene fallback connection (optional)
- `reviewer_provider`: `codex | github_copilot | openai`
- `reviewer_connection_id`: ID ulozene reviewer connection (optional)
- `model_profile`: `fast | balanced | deep`

### resources

- `min_free_space_mb` (default `0`)
- `retention_days` (default `14`)

Resource policy pred taskem kontroluje volne misto a uklizi stare workspace podle retention. Neupravuje ani neomezuje prikazy AI.

### github

- `issue_label` (default `ai-task`)
- `branch_prefix` (default `ai/`)
- `pr_draft` (default `true`)

## Validace

Validacni prikazy nejsou soucasti konfigurace ani architektury projektu. Autoritativni sadu prikazu vraci implementacni AI az po provedeni zmen, kdy zna skutecny stav repozitare a pozadavky tasku.

GitHub Actions nejsou automatickou podminkou dokonceni tasku. Pokud jsou pro konkretni zadani relevantni, musi jejich spusteni nebo kontrolu zahrnout implementacni AI do navrzene validace stejne jako jakykoli jiny overovaci krok.

Worker:

1. spusti vsechny neprazdne prikazy presne v poradi navrzenem AI,
2. neaplikuje command allowlist, sandbox filtr ani capability odklad,
3. zachova checkpoint kazdeho uspesneho prikazu pro stejny otisk workspace,
4. pri chybe preda implementacni AI cely prikaz, exit code, stdout a stderr,
5. po zmene workspace spusti znovu jen kontroly, jejichz predchozi dukaz uz neodpovida aktualnimu obsahu.

Manualni kriterium se nevytvari ani automaticky nevyhodnocuje. Pokud AI nevrati spustitelnou kontrolu, validation faze se oznaci jako preskocena a tuto skutecnost uchova audit.

## Approval a prikazova omezeni

Runtime approval mechanismus byl z workflow odstranen. Provider outcome, validace, review ani Git operace nevytvareji approval zaznam a task se kvuli nim neprepina do `needs_approval`.

ForgeMind soucasne neomezuje AI prikazy podle jejich obsahu. Ochrannou hranici tvori autentizace ForgeMind API, opravneni ulozenych integraci, operacni system a kontejner/ucet, pod kterym worker bezi. Tyto provozni hranice nejsou soucasti `agent.config.yaml`.

Historicke approval tabulky a statusy mohou po migraci zustat citelne kvuli auditu starych behu, ale aktivni runtime je nevytvari ani nespotrebovava.

## Metriky a technicky timeout

Tokeny, cena, pocet souboru, velikost diffu a cas behu jsou pouze telemetrie. Chyba odhadu ceny nezastavi task ani neaktivuje fallback provider. Codex subprocess ma desetihodinovy technicky timeout proti opustenemu procesu; tento timeout neni soucasti projektove konfigurace ani rozhodovaciho workflow.

## Queue nastaveni

Tyto promenne nejsou soucasti YAML:

- `FORGEMIND_QUEUE_CLAIM_TIMEOUT_MINUTES`
- `FORGEMIND_QUEUE_MAX_ATTEMPTS`
- `FORGEMIND_QUEUE_RETRY_BACKOFF_SECONDS`

Retry je phase-aware. Dokoncene externi operace a uspesne validacni prikazy nad nezmenenym workspace se neopakuji.
