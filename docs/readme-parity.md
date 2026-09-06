# README Parity Checklist

Posledni aktualizace: 2026-09-06

Tento dokument mapuje aktualni README pozadavky na runtime implementaci a executable test evidence.

- `implemented`: existuje runtime implementace nebo dokumentovana konfigurace.
- `tested`: existuje executable test nebo validacni prikaz.
- `production-verified`: existuje explicitni produkcni overeni.
- `deferred`: oblast ceka na rucni nebo produkcni overeni.

## Commit-bound baseline

- Review date: `2026-09-06`
- Current reviewed commit (squash): `c2f3befb976679e652fb82fa32f82932d8bbeb16`
- Historical proposal commit (not current): `0fe5ec6aabdf6938a8896cc24fc7db01f915f49c`
- Merge base: `0808319a973072d91b6987b9ff33646106dc7e79`

The historical proposal and the current squash commit diverge from their merge base. The proposal SHA is retained only as historical planning provenance; it is not the current reviewed state. The current squash commit carries the post-proposal qualification corrections on its separate history.

### Repository-backed correction ledger

| Commit | Correction area | Repository evidence | Evidence classification |
| --- | --- | --- | --- |
| `c2f3befb976679e652fb82fa32f82932d8bbeb16` | Windows authoring checkout integrity and recovery | `apps/windows-runner/src/authoring-executor.ts`; `apps/windows-runner/src/authoring-executor.test.ts`; `apps/worker/src/workflow.test.ts` | Executable synthetic/fixture qualification: checks readable writable checkout ownership, corrupt resumed artifacts, and checkpoint-safe workflow recovery. Not physical-device or production evidence. |
| `c2f3befb976679e652fb82fa32f82932d8bbeb16` | Windows repository qualification boundary | `packages/db/src/windows-worker-repository.ts`; `packages/db/src/windows-worker-repository.flying-qualification.test.ts` | Executable in-memory fixture qualification of repository and evidence reconciliation boundaries. Not physical BOREK-FILIP production verification. |
| `c2f3befb976679e652fb82fa32f82932d8bbeb16` | Qualification scenario catalog | `qualification/platform-scenarios/README.md`; `qualification/platform-scenarios/evidence-sample.json`; `qualification/platform-scenarios/evidence-schema.json`; `qualification/platform-scenarios/scenarios.mjs` | Synthetic Flying-shaped scenario/catalog evidence. It exercises production interfaces but remains non-physical fixture evidence and does not establish BOREK-FILIP readiness, Unreal production content, or production verification. |

Physical BOREK-FILIP verification remains `deferred`; none of the ledger entries above reclassifies it as `production-verified`.

## Pozadavky a evidence

| Oblast | Runtime | Test | Produkce | Evidence |
| --- | --- | --- | --- | --- |
| API task lifecycle, webhook a notifications | `implemented` | `tested` | `deferred` | `apps/studio-api/src/routes.ts`; `apps/studio-api/src/routes.test.ts` |
| Worker flow implementation -> AI validation -> read-only review -> GitHub delivery | `implemented` | `tested` | `deferred` | `apps/worker/src/workflow.ts`; `apps/worker/src/workflow.test.ts`; `apps/worker/src/db-worker.test.ts` |
| Validační prikazy vyhradne z implementacni AI, bez command filtru | `implemented` | `tested` | `deferred` | `packages/providers/src/provider.ts`; `apps/worker/src/validation.ts`; `apps/worker/src/validation.test.ts` |
| Plna chyba validace a review blocker zpet do implementace | `implemented` | `tested` | `deferred` | `apps/worker/src/workflow.ts`; `apps/worker/src/db-worker/checkpoints.ts`; `apps/worker/src/workflow.test.ts` |
| Phase-aware retry a checkpointy bez opakovani uspesnych operaci | `implemented` | `tested` | `deferred` | `apps/worker/src/db-worker/checkpoints.ts`; `packages/db/src/repository.ts`; `apps/worker/src/db-worker.test.ts` |
| Runtime bez approval vetvi; historicke approval zaznamy pouze pro audit | `implemented` | `tested` | `deferred` | `apps/studio-api/src/routes.ts`; `apps/worker/src/workflow.ts`; `packages/db/prisma/migrations/20260831150000_remove_runtime_approvals/migration.sql` |
| Selektivni reuse validace podle workspace a semantic impact provenance | `implemented` | `tested` | `deferred` | `apps/worker/src/workflow.ts`; `apps/worker/src/validation.ts`; `apps/worker/src/workflow.test.ts`; `apps/worker/src/validation.test.ts` |
| Technicky retry bez budget/iteration/retry capu | `implemented` | `tested` | `deferred` | `packages/db/src/repository.ts`; `packages/db/src/repository.task-run.test.ts`; `apps/worker/src/db-worker.test.ts` |
| Delivery-only recovery bez opakovani implementace a platne validace | `implemented` | `tested` | `deferred` | `apps/worker/src/db-worker.ts`; `apps/worker/src/db-worker.test.ts`; `packages/github/src/index.test.ts` |
| Repository-grounded planning a nezavisle review roadmapy | `implemented` | `tested` | `deferred` | `apps/studio-api/src/roadmap.ts`; `apps/studio-api/src/roadmap.test.ts`; `apps/studio-api/src/roadmap-resume.test.ts`; `packages/providers/src/roadmap-review-prompt.test.ts` |
| Audit gap proposals zustavaji neaktivni do review a rozhodnuti | `implemented` | `tested` | `deferred` | `apps/worker/src/db-worker.ts`; `packages/db/src/repository.ts`; `apps/worker/src/db-worker.test.ts`; `apps/studio-api/src/routes.test.ts` |
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
- Root/CI test foundation: `npm run build`, `npm run typecheck`, `npm test`, `npm run test:migrations`. Tyto prikazy a migracni matrix zustavaji dostupne pro release/CI; nejsou automaticky predepsanou validation sadou kazdeho tasku. Autoritativni task checks voli implementacni AI podle konkretni zmeny.
