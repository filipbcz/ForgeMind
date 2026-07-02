# Provider API

Provider adapter je v `packages/providers`.

Minimalni kontrakt:

- `plan()` pripravi kroky a akceptacni kriteria.
- `implement()` provede nebo simuluje zmenu ve workspace.
- `review()` vrati blokery, bezpecna vylepseni a rizikove zmeny.
- `estimateCost()` vrati tokeny a odhad nakladu.
- `supportsLocalRepo()` rika, jestli provider pracuje nad lokalnim worktree.
- `supportsGitHubNativeFlow()` rika, jestli provider umi nativni cloud workflow nad GitHubem.

`MockProvider` je prvni implementace pro testy a end-to-end prurez. CodexProvider ma vzniknout az po stabilizaci workflow workeru, approvalu a PR vystupu.

