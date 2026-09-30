# Provider API

Provider adapter je v `packages/providers`.

Minimalni kontrakt:

- `plan()` pripravi kroky a akceptacni kriteria.
- `implement()` provede nebo simuluje zmenu ve workspace.
- `review()` vrati blokery, bezpecna vylepseni a rizikove zmeny.
- `estimateCost()` vrati tokeny a odhad nakladu.
- `supportsLocalRepo()` rika, jestli provider pracuje nad lokalnim worktree.
- `supportsGitHubNativeFlow()` rika, jestli provider umi nativni cloud workflow nad GitHubem.

Aktualni implementace:

- `MockProvider` slouzi pro lokalni testy, deterministicke E2E scenare a vyvoj bez externich kredencialu.
- `OpenAIProvider` vola OpenAI Responses API pres projektovy `OPENAI_API_KEY`, `OPENAI_API_BASE_URL` a `OPENAI_MODEL`.
- `CodexProvider` pouziva stejny OpenAI API key; v lokalnim tool-runtime rezimu spousti Codex CLI s `OPENAI_API_KEY`, nikdy s ChatGPT OAuth session.
- `model_profile` je vykonna routing policy: `balanced` smeruje scoped praci na Luna, bezny vyvoj na GPT-6.1 Sol a kriticke audity na Astra; `fast` posouva praci o uroven nize a `deep` o uroven vyse.
- `FORGEMIND_MODEL_ECONOMY`, `FORGEMIND_MODEL_STANDARD` a `FORGEMIND_MODEL_CRITICAL` mohou modelove aliasy centralne zmenit bez zasahu do orchestrace.
- Provider usage uklada skutecne input/output/cached tokeny, cenu podle verzovaneho ceniku a OpenAI/client request ID.
- `GitHubCopilotProvider` je kompatibilitni placeholder pro historicky ulozene connectiony; runtime SDK se nedistribuuje a provider nelze pouzit pro nove ani existujici tasky.
- Worker umi vybrat primarni provider z konfigurace nebo `FORGEMIND_PROVIDER` a pouzit fallback z konfigurace nebo `FORGEMIND_FALLBACK_PROVIDER`.
- Worker umi primarni i fallback provider navazat na konkretni ulozene provider connection pres `FORGEMIND_PROVIDER_CONNECTION_ID` a `FORGEMIND_FALLBACK_PROVIDER_CONNECTION_ID` nebo pres `ai.primary_connection_id` a `ai.fallback_connection_id` v `agent.config.yaml`.
- Fallback muze byt i stejny provider typ (napr. `codex`) pokud pouziva odlisny connection kontext.
- Review pouziva samostatnou instanci `ai.reviewer_provider`, volitelne `ai.reviewer_connection_id`, a nikdy neprebira implementacni provider session.
- Vysledek `already_satisfied` musi obsahovat `evidenceFiles` a spustitelne validacni prikazy. Worker nacte pouze uvedene sledovane soubory do omezeneho evidence packetu a nezavisly reviewer vrati verdikt pro kazde akceptacni kriterium. Bez uplnych dukazu se task vraci do implementace s konkretnimi blockery.
- Uspesny audit existujiciho stavu se uklada s hashem Git stromu, pracovniho diffu, zadani, kriterii a evidence souboru. Po restartu se znovu pouzije jen tehdy, pokud se auditni vstup nezmenil.

`github_copilot` je zakonzervovany: existujici connectiony zustavaji citelne kvuli kompatibilite dat, ale vsechny runtime operace vrati explicitni chybu a Studio nepovoluje vytvareni novych connectionu. `local` zustava rezervovana hodnota kontraktu pro dalsi fazi.
