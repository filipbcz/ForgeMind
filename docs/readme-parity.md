# README Parity Checklist

Posledni aktualizace: 2026-09-01

Tento dokument mapuje aktualni README pozadavky na runtime implementaci a executable test evidence.

- `implemented`: existuje runtime implementace nebo dokumentovana konfigurace.
- `tested`: existuje executable test nebo validacni prikaz.
- `production-verified`: existuje explicitni produkcni overeni.
- `deferred`: oblast ceka na rucni nebo produkcni overeni.

## Pozadavky a evidence

| Oblast | Runtime | Test | Produkce | Evidence |
| --- | --- | --- | --- | --- |
| API task lifecycle, webhook a notifications | `implemented` | `tested` | `deferred` | `apps/studio-api/src/routes.ts`; `apps/studio-api/src/routes.test.ts` |
| Worker flow implementation -> AI validation -> read-only review -> GitHub delivery | `implemented` | `tested` | `deferred` | `apps/worker/src/workflow.ts`; `apps/worker/src/workflow.test.ts`; `apps/worker/src/db-worker.test.ts` |
| Validační prikazy vyhradne z implementacni AI, bez command filtru | `implemented` | `tested` | `deferred` | `packages/providers/src/provider.ts`; `apps/worker/src/validation.ts`; `apps/worker/src/validation.test.ts` |
| Plna chyba validace a review blocker zpet do implementace | `implemented` | `tested` | `deferred` | `apps/worker/src/workflow.ts`; `apps/worker/src/db-worker/checkpoints.ts`; `apps/worker/src/workflow.test.ts` |
| Phase-aware retry a checkpointy bez opakovani uspesnych operaci | `implemented` | `tested` | `deferred` | `apps/worker/src/db-worker/checkpoints.ts`; `packages/db/src/repository.ts`; `apps/worker/src/db-worker.test.ts` |
| Runtime bez approval vetvi; historicke approval zaznamy pouze pro audit | `implemented` | `tested` | `deferred` | `apps/studio-api/src/routes.ts`; `apps/worker/src/workflow.ts`; `packages/db/prisma/migrations/20260831150000_remove_runtime_approvals/migration.sql` |
| GitHub adapter kontrakt a idempotentni delivery | `implemented` | `tested` | `deferred` | `packages/github/src/index.ts`; `packages/github/src/index.test.ts` |
| Provider abstraction, Codex primary a fallback | `implemented` | `tested` | `deferred` | `packages/providers/src/provider.ts`; `packages/providers/src/codex-provider.ts`; `apps/worker/src/db-worker.test.ts` |
| Queue persistence, pause, claim/finalize/recovery a audit | `implemented` | `tested` | `deferred` | `packages/db/src/repository.ts`; `apps/worker/src/db-worker.ts`; `packages/db/src/repository.task-run.test.ts` |
| Mobile task, project, queue a settings flow | `implemented` | `tested` | `deferred` | `apps/mobile-pwa/src/App.tsx`; `apps/mobile-pwa/src/types.ts`; `apps/studio-api/src/routes.test.ts` |
| Neblokujici Windows validacni worker nad AI navrzenymi prikazy a presnym commitem | `implemented` | `tested` | `deferred` | `apps/windows-runner/src/executor.ts`; `packages/db/src/windows-worker-repository.ts`; `apps/studio-api/src/routes/windows-runner-routes.integration.test.ts` |
| Perzistentni multi-thread AI Chat s repozitarem, realtime aktivitou, retry a diffem | `implemented` | `tested` | `deferred` | `apps/mobile-pwa/src/ChatPanel.tsx`; `apps/studio-api/src/routes/chat-routes.ts`; `apps/worker/src/chat-worker.ts`; `apps/worker/src/chat-worker.test.ts` |
| Versioned project contract, capability evidence, release audit a completion gate | `implemented` | `tested` | `deferred` | `packages/core/src`; `packages/db/src`; `apps/worker/src/db-worker.ts`; `apps/studio-api/src/routes.test.ts` |
| ARM64 Raspberry Pi deployment workflow platformy | `implemented` | `deferred` | `deferred` | `.github/workflows/deploy-raspberry.yml`; `infra/docker-compose.raspberry.yml`; `docs/deploy-raspberry.md` |

## Vedome odlozene

- automaticky deploy spravovaneho projektu do jeho produkce
- vlastni trenovani modelu
- komplexni multi-user enterprise sprava prav
- produkcni E2E realneho providera, GitHubu a nasazene PWA jako soucast lokalni test suite

Automaticky deploy samotne platformy ForgeMind na Raspberry Pi je samostatna CI/CD funkce. Neprokazuje produkcni chovani projektu, nad kterym ForgeMind pracuje.

## Representative coverage

Workflow testy overuji happy path, selhani validace s navratem kompletni chyby, review blocker s navratem do implementace, resume checkpointy a GitHub delivery. API integrační test v `apps/studio-api/src/routes.test.ts` pokryva tok create/start -> worker -> GitHub pole -> mobilni read model.

Tato coverage je `tested`, ne `production-verified`.

## Acceptance zdroje pravdy

- Architektura a runtime: `docs/architecture.md`, `docs/project-config.md`, `docs/security.md`
- AI Chat: `docs/ai-chat-specification.md`
- Implementacni historie: `docs/implementation-tracker.md`
- Autoritativni root validace: `npm run build`, `npm run typecheck`, `npm test`, `npm run test:migrations`
