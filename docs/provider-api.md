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
- `OpenAIProvider` vola OpenAI chat completions API pres `OPENAI_API_KEY`, `OPENAI_API_BASE_URL` a `OPENAI_MODEL`.
- `CodexProvider` je samostatny provider adapter pro primarni Codex flow pres `CODEX_API_KEY`, `CODEX_API_BASE_URL` a `CODEX_MODEL`.
- Worker umi vybrat primarni provider z konfigurace nebo `FORGEMIND_PROVIDER` a pouzit fallback z konfigurace nebo `FORGEMIND_FALLBACK_PROVIDER`.

`github_copilot` a `local` zustavaji zatim jen rezervovane hodnoty kontraktu pro dalsi fazi. `createProvider()` je zamerne odmita, dokud nebudou mit vlastni adapter a testy.
