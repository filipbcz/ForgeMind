# Project Configuration

Projektova konfigurace se nacita z agent.config.yaml pres packages/config (parseAgentConfigYaml).

## 1) Podporovana struktura

### project

- id
- name
- repo
- default_branch (default main)
- type (default unknown)
- runtime (default node)

### workflow

- default_mode: safe | auto | full_auto
- create_issue (default true)
- create_branch (default true)
- create_draft_pr (default true)
- auto_push (default true)
- auto_merge (default false)
- allow_ai_auto_improvements (default true)

### ai

- primary_provider: codex | github_copilot | openai | local | mock
- fallback_provider: codex | github_copilot | openai | local | mock (optional)
- reviewer_provider: codex | github_copilot | openai | local | mock
- model_profile: fast | balanced | deep

### limits

- max_iterations
- max_runtime_minutes
- max_changed_files
- max_diff_lines
- max_repeated_error_count

### commands

`commands.install` instaluje pouze zavislosti deklarovane repozitarem a bezi pred validacnimi prikazy. Systemove build nastroje se neinstaluji za behu tasku; musi byt soucasti verzovaneho ForgeMind runtime image. Zakladni produkcni image obsahuje Node.js, Git, CMake/CTest, Ninja, GNU C/C++ toolchain, pkg-config a ripgrep.

- install (optional)
- lint (optional)
- build (optional)
- test_unit (optional)
- test_e2e (optional)
- verify (optional)

### approval

- required_for: string[]
- auto_allowed: string[]

### sandbox

- allow_network (default false)
- allow_sudo (default false)
- writable_paths (default /workspace)
- forbidden_paths (default /etc, /root, /home/*/.ssh, /var/run/docker.sock)

### github

- issue_label (default ai-task)
- branch_prefix (default ai/)
- pr_draft (default true)
- require_ci_green (default true)

## 2) Runtime mapovani konfigurace

Worker pouziva konfiguraci takto:

1. workflow.create_issue/create_branch/create_draft_pr/auto_push ridi GitHub kroky.
2. github.issue_label a github.branch_prefix ridi issue label a naming branche.
3. Implementacni AI navrhne po provedeni zmen minimalni sadu autoritativnich spustitelnych validacnich kontrol ve stejne odpovedi jako vysledek implementace. Manualni kontroly se nevyhodnocuji a do sady se nezarazuji.
4. commands.verify (fallback commands.build) je explicitni projektovy override AI navrhu.
5. limits jsou mapovany pres toCoreLimits() do evaluateLimits policy toku.
6. task.maxIterations ma prednost jako runtime override nad globalnimi limity.

## 3) Aktualni chovani limitu

Limit evaluation v workeru aktualne aktivne vynucuje:

1. iteration_limit_reached.
2. repeated_error_detected na opakovanou stejnou validation/review chybu.
3. runtime, velikost diffu a pocet zmenenych souboru podle workflow pravidel.

Spotreba tokenu a cena se meri pro reporting, ale nezastavuji task ani provider volani.

## 4) Approval a resume semantika

1. Provider outcome s requestedApprovals zastavi task ve stavu needs_approval.
2. Schvaleni posledni pending approval automaticky obnovi task a znovu ho enqueuje.
3. Pokud pending approvals zustavaji, task zustava pozastaven.

## 5) Queue navazane nastaveni (env)

Nize uvedene promenne nejsou soucasti YAML, ale ovlivnuji runtime queue:

1. FORGEMIND_QUEUE_CLAIM_TIMEOUT_MINUTES (recovery zaseklych claimed jobu)
2. FORGEMIND_QUEUE_MAX_ATTEMPTS (max retry pokusu queue jobu)
3. FORGEMIND_QUEUE_RETRY_BACKOFF_SECONDS (zakladni backoff pro retry)

## 6) Doporuceni pro projektove configy

1. MVP: workflow.auto_merge drzet false.
2. Pro kriticke repozitare snizit max_iterations a runtime/diff limity.
3. Explicitni commands.verify pouzit pouze tehdy, kdyz projekt vyzaduje stabilni administrativne urceny prikaz; jinak validaci navrhuje implementacni AI podle vysledneho repozitare.
4. U risky domen mit approval.required_for naplnene konkretnimi akcemi.

## 7) Kompatibilita

Parser je strict schema validation. Nezname nebo nevalidni hodnoty maji vyhodit validacni chybu pri nacitani konfigurace.
