# ForgeMind Architecture

ForgeMind je monorepo se tremi aplikacemi a sdilenymi balicky:

- `apps/studio-api` poskytuje REST API pro projekty, tasky a approvals.
- `apps/mobile-pwa` je mobilni PWA pro zadavani tasku a schvalovani rizikovych kroku.
- `apps/worker` orchestruje beh agenta nad workspace a provider adapterem.
- `packages/core` drzi domenove typy, limity, approval policy a stavovy automat.
- `packages/providers` definuje jednotne `AIProvider` rozhrani a prvni `MockProvider`.
- `packages/github` definuje GitHub adapter a helpery pro issue, branch a PR body.
- `packages/config` parsuje `agent.config.yaml`.
- `packages/db` obsahuje Prisma schema pro PostgreSQL.

Prvni implementace pouziva in-memory API store a mock integrace. Prisma schema, provider rozhrani a GitHub adapter jsou pripravene tak, aby dalsi krok mohl nahradit mocky realnymi implementacemi bez zmen v UI kontraktu.

