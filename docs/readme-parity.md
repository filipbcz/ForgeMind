# README Parity Checklist

Posledni aktualizace: 2026-09-01

Tento dokument mapuje hlavni pozadavky z README na skutecnou implementaci, executable test evidence nebo vedome odlozeni. Pouziva pouze tyto statusy:

- `implemented`: existuje runtime implementace nebo dokumentovana konfigurace v repozitari.
- `tested`: existuje executable test reference nebo validacni prikaz, ktery danou oblast overuje.
- `production-verified`: existuje explicitni produkcni overeni dolozene repozitarovym runbookem nebo provoznim zaznamem.
- `deferred`: oblast je vedome mimo aktualni scope nebo ceka na rucni/produkci schopne overeni.

## 1) README pozadavky a evidence

| README oblast | Runtime status | Test status | Production status | Evidence |
| --- | --- | --- | --- | --- |
| API task lifecycle (`POST /api/tasks`, `GET /api/tasks`, `POST /api/tasks/:id/start`, approvals, webhook, notifications) | `implemented` | `tested` | `deferred` | `apps/studio-api/src/routes.ts`; `apps/studio-api/src/routes.test.ts` |
| Worker orchestrator (issue -> branch -> provider -> verify -> draft PR) | `implemented` | `tested` | `deferred` | `apps/worker/src/workflow.ts`; `apps/worker/src/db-worker.ts`; `apps/worker/src/mvp-scenario.test.ts` |
| GitHub adapter kontrakt (`createIssue/createBranch/commitAndPush/createDraftPullRequest/commentOnIssue/readCheckStatus`) | `implemented` | `tested` | `deferred` | `packages/github/src/index.ts`; `packages/github/src/index.test.ts` |
| Provider abstraction + Codex primary + fallback | `implemented` | `tested` | `deferred` | `packages/providers/src/provider.ts`; `packages/providers/src/codex-provider.ts`; `apps/worker/src/db-worker.test.ts` |
| Runtime policy (safe/auto/full_auto), approvals, limits, retry/backoff | `implemented` | `tested` | `deferred` | `apps/worker/src/workflow.ts`; `packages/core/src/limits.ts`; `packages/db/src/repository.ts`; `apps/worker/src/workflow.test.ts`; `apps/worker/src/db-worker.test.ts`; `packages/db/src/repository.task-run.test.ts` |
| Queue persistence + claim/finalize/recovery + audit | `implemented` | `tested` | `deferred` | `packages/db/src/repository.ts`; `apps/worker/src/db-worker.ts`; `packages/db/src/repository.task-run.test.ts`; `apps/worker/src/db-worker.test.ts` |
| Monitoring metrics endpoint | `implemented` | `tested` | `deferred` | `apps/studio-api/src/routes.ts`; `packages/db/src/repository.ts`; `apps/studio-api/src/routes.test.ts`; `docs/architecture.md` |
| Mobile task/approval/settings flow + rich task fields | `implemented` | `tested` | `deferred` | `apps/mobile-pwa/src/App.tsx`; `apps/mobile-pwa/src/api.ts`; `apps/mobile-pwa/src/types.ts`; `apps/studio-api/src/routes.test.ts` |
| Persistent multi-thread AI chat with optional repository, realtime activity, retry, diff and approvals | `implemented` | `tested` | `deferred` | `apps/mobile-pwa/src/ChatPanel.tsx`; `apps/studio-api/src/routes/chat-routes.ts`; `apps/worker/src/chat-worker.ts`; `packages/db/prisma/schema.prisma`; `apps/studio-api/src/chat-routes.test.ts`; `apps/worker/src/chat-worker.test.ts` |
| Push notifications subscription + trigger events | `implemented` | `tested` | `deferred` | `apps/mobile-pwa/src/pwa.ts`; `apps/mobile-pwa/public/sw.js`; `apps/studio-api/src/notifications.ts`; `apps/studio-api/src/server.ts`; `apps/studio-api/src/notifications.test.ts`; `apps/studio-api/src/routes.test.ts` |
| GitHub issue body README template parity | `implemented` | `tested` | `deferred` | `packages/github/src/index.ts`; `packages/github/src/index.test.ts` |
| Representative pipeline coverage (API -> worker -> GitHub adapter -> mobile read model payload) | `implemented` | `tested` | `deferred` | `apps/studio-api/src/routes.test.ts`; `apps/worker/src/mvp-scenario.test.ts` |
| Versioned project contract, capability evidence, release audit, and completion gate | `implemented` | `tested` | `deferred` | `packages/core/src`; `packages/db/src`; `apps/worker/src/db-worker.ts`; `apps/studio-api/src/routes.ts`; `apps/worker/src/db-worker.test.ts`; `apps/studio-api/src/routes.test.ts`; `docs/roadmap-quality-implementation-plan.md` |
| ARM64 Raspberry Pi deployment workflow for ForgeMind platform | `implemented` | `deferred` | `deferred` | `.github/workflows/deploy-raspberry.yml`; `infra/docker-compose.raspberry.yml`; `docs/deploy-raspberry.md` |
| vNext Windows validation control plane + manual CLI + safe fixture executor + pinned Unreal adapter | `implemented` | `tested` | `deferred` | `packages/core/src/windows-worker.ts`; `apps/studio-api/src/routes/windows-runner-routes.ts`; `apps/windows-runner/src`; `packages/db/src/windows-worker-repository.ts`; `apps/studio-api/src/routes/windows-runner-routes.integration.test.ts`; `apps/windows-runner/src/*.test.ts` |
| Realna BOREK-FILIP Unreal validace | `deferred` | `deferred` | `deferred` | Ceka na lokalni manualni session, samostatny approval dlouhe prace, pinned/probed Unreal tooling a realnou evidence; fixture test ji nenahrazuje |

## 2) Vedome odlozene mimo MVP

Tyto body odpovidaji README sekci "Co neni cilem MVP" a zustavaji `deferred`:

- automaticky deploy projektu spravovanych ForgeMindem do jejich produkce
- automaticky merge do `main`
- plne autonomni rozhodovani bez schvalovani
- vlastni trenovani modelu
- komplexni multi-user enterprise sprava prav

Puvodni MVP nepocital s Windows workerem. vNext uzce omezeny validation executor je nyni `implemented` a repository toky jsou `tested`, ale nejde o obecny Windows/Delphi worker ani autonomniho agenta. Jeho produkcni rollout a BOREK-FILIP jsou stale `deferred`.

Automaticky deploy samotne platformy ForgeMind na Raspberry Pi je provozni CI/CD funkce platformy a v tomto checklistu je oznacena pouze jako `implemented`, protoze repozitar obsahuje workflow a runbook. Produkcni overeni zustava `deferred`, dokud neni dolozeno rizenym produkcnim overenim. Tato platformni CI/CD funkce neznamena automaticky produkcni deploy projektu, nad kterymi ForgeMind pracuje; ten zustava mimo MVP a pod explicitnim approval workflow.

## 3) Representative E2E coverage

Repozitar obsahuje reprezentativni executable coverage pro hlavni pipeline ve dvou urovnich:

- `apps/worker/src/mvp-scenario.test.ts` overuje README happy path od tasku po draft PR a approval pause/resume.
- `apps/studio-api/src/routes.test.ts` obsahuje scenar API create/start -> worker `runWorkerTask` -> GitHub issue/PR fields -> mobile read-model projekce z `/api/tasks`.

Toto je `tested` representative pipeline coverage. Neni to produkcni E2E overeni realneho GitHubu, realneho providera a nasazene PWA; tato cast zustava `deferred`.

## 4) Acceptance zdroje pravdy

- Implementacni sled a verifikace kroku: `docs/implementation-tracker.md`
- Architektura a runtime mapovani: `docs/architecture.md`, `docs/project-config.md`, `docs/security.md`
- Cilena evidence reprezentativni pipeline: `apps/worker/src/mvp-scenario.test.ts`, `apps/studio-api/src/routes.test.ts`
- Autoritativni root validace monorepa pro release kandidat: `npm run build`, `npm run typecheck`, `npm test`
