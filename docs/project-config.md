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
- max_budget_usd
- soft_budget_threshold_percent
- hard_budget_threshold_percent

### commands

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
3. commands.verify (fallback commands.build) urcuje validacni prikaz.
4. limits jsou mapovany pres toCoreLimits() do evaluateLimits policy toku.
5. task.maxIterations a task.maxBudgetUsd maji prednost jako runtime override nad globalnimi limity.

## 3) Aktualni chovani limitu

Limit evaluation v workeru aktualne aktivne vynucuje:

1. budget_exceeded (vcetne pre-run estimate gate).
2. iteration_limit_reached.
3. repeated_error_detected na opakovanou stejnou validation/review chybu.
4. soft budget signal je warning, ne hard stop.

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
2. Pro kriticke repozitare snizit max_budget_usd a max_iterations.
3. Vynutit explicitni commands.verify misto implicitniho fallbacku.
4. U risky domen mit approval.required_for naplnene konkretnimi akcemi.

## 7) Kompatibilita

Parser je strict schema validation. Nezname nebo nevalidni hodnoty maji vyhodit validacni chybu pri nacitani konfigurace.

