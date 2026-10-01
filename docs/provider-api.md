# Provider API

Provider adapter je v `packages/providers`.

Minimalni kontrakt:

- `routeTask()` jednou klasifikuje task a vrati model i reasoning effort pro implementaci, nezavisly review a pripadnou eskalaci.
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
- Implementacni task nema tri pevne urovne. Nizkonakladovy router (vychozi GPT-6.1 Sol s low reasoning) zvoli presny model a reasoning effort z usporadaneho poolu, rozhodnuti se ulozi k tasku a implementace i review je znovu pouziji. Nova volba se nedela pri kazdem turnu; po vecnem selhani se pouzije predem zvolena eskalace.
- Connection muze ulozit vlastni serazeny pool modelu. Pro environment-managed connection jej urcuji `FORGEMIND_MODEL_ROUTER` a carkami oddeleny `FORGEMIND_MODEL_POOL`.
- `model_profile` a `FORGEMIND_MODEL_ECONOMY`, `FORGEMIND_MODEL_STANDARD`, `FORGEMIND_MODEL_CRITICAL` zustavaji pro netaskove operace, napr. roadmapu a audity.
- Provider usage uklada skutecne input/output/cached tokeny, cenu podle verzovaneho ceniku a OpenAI/client request ID.
- `GitHubCopilotProvider` je kompatibilitni placeholder pro historicky ulozene connectiony; runtime SDK se nedistribuuje a provider nelze pouzit pro nove ani existujici tasky.
- Worker umi vybrat primarni provider z konfigurace nebo `FORGEMIND_PROVIDER` a pouzit fallback z konfigurace nebo `FORGEMIND_FALLBACK_PROVIDER`.
- Worker umi primarni i fallback provider navazat na konkretni ulozene provider connection pres `FORGEMIND_PROVIDER_CONNECTION_ID` a `FORGEMIND_FALLBACK_PROVIDER_CONNECTION_ID` nebo pres `ai.primary_connection_id` a `ai.fallback_connection_id` v `agent.config.yaml`.
- Fallback muze byt i stejny provider typ (napr. `codex`) pokud pouziva odlisny connection kontext.
- Review pouziva samostatnou instanci `ai.reviewer_provider`, volitelne `ai.reviewer_connection_id`, a nikdy neprebira implementacni provider session.
- Vysledek `already_satisfied` musi obsahovat `evidenceFiles` a spustitelne validacni prikazy. Worker nacte pouze uvedene sledovane soubory do omezeneho evidence packetu a nezavisly reviewer vrati verdikt pro kazde akceptacni kriterium. Bez uplnych dukazu se task vraci do implementace s konkretnimi blockery.
- Uspesny audit existujiciho stavu se uklada s hashem Git stromu, pracovniho diffu, zadani, kriterii a evidence souboru. Po restartu se znovu pouzije jen tehdy, pokud se auditni vstup nezmenil.

`github_copilot` je zakonzervovany: existujici connectiony zustavaji citelne kvuli kompatibilite dat, ale vsechny runtime operace vrati explicitni chybu a Studio nepovoluje vytvareni novych connectionu. `local` zustava rezervovana hodnota kontraktu pro dalsi fazi.
