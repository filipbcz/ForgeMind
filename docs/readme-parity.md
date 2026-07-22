# README Parity Checklist

Posledni aktualizace: 2026-07-03

Tento dokument mapuje hlavni pozadavky z README na implementaci v kodu nebo na vedome odlozeni mimo MVP scope.

## 1) Implementovane README pozadavky

| README oblast | Stav | Implementace |
| --- | --- | --- |
| API task lifecycle (`POST /api/tasks`, `GET /api/tasks`, `POST /api/tasks/:id/start`, approvals, webhook, notifications) | SPLNENO | `apps/studio-api/src/routes.ts`, `apps/studio-api/src/routes.test.ts` |
| Worker orchestrator (issue -> branch -> provider -> verify -> draft PR) | SPLNENO | `apps/worker/src/workflow.ts`, `apps/worker/src/db-worker.ts`, `apps/worker/src/mvp-scenario.test.ts` |
| GitHub adapter kontrakt (`createIssue/createBranch/commitAndPush/createDraftPullRequest/commentOnIssue/readCheckStatus`) | SPLNENO | `packages/github/src/index.ts`, `packages/github/src/index.test.ts` |
| Provider abstraction + Codex primary + fallback | SPLNENO | `packages/providers/src/provider.ts`, `packages/providers/src/codex-provider.ts`, `apps/worker/src/db-worker.ts` |
| Runtime policy (safe/auto/full_auto), approvals, limits, retry/backoff | SPLNENO | `apps/worker/src/workflow.ts`, `packages/core/src/limits.ts`, `packages/db/src/repository.ts` |
| Queue persistence + claim/finalize/recovery + audit | SPLNENO | `packages/db/src/repository.ts`, `apps/worker/src/db-worker.ts` |
| Monitoring metrics endpoint | SPLNENO | `packages/db/src/repository.ts`, `apps/studio-api/src/routes.ts`, `docs/architecture.md` |
| Mobile task/approval/settings flow + rich task fields | SPLNENO | `apps/mobile-pwa/src/App.tsx`, `apps/mobile-pwa/src/api.ts`, `apps/mobile-pwa/src/types.ts` |
| Push notifications end-to-end (subscription + trigger events) | SPLNENO | `apps/mobile-pwa/src/pwa.ts`, `apps/mobile-pwa/public/sw.js`, `apps/studio-api/src/notifications.ts`, `apps/studio-api/src/server.ts` |
| GitHub issue body README template parity | SPLNENO | `packages/github/src/index.ts`, `packages/github/src/index.test.ts` |
| E2E representative pipeline (API -> worker -> GitHub -> mobile read model payload) | SPLNENO | `apps/studio-api/src/routes.test.ts` |

## 2) Vedome odlozene mimo MVP

Tyto body odpovidaji README sekci "Co neni cilem MVP" a zustavaji odlozene:

- automaticky deploy do produkce
- automaticky merge do `main`
- plne autonomni rozhodovani bez schvalovani
- vlastni trenovani modelu
- komplexni multi-user enterprise sprava prav

## 3) Acceptance zdroje pravdy

- Implementacni sled a verifikace kroku: `docs/implementation-tracker.md`
- Architektura a runtime mapovani: `docs/architecture.md`, `docs/project-config.md`, `docs/security.md`
- Finalni validace monorepa: `npm run build`, `npm test`
