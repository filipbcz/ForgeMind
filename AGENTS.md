# AGENTS.md

## Ucel projektu

ForgeMind je TypeScript monorepo pro platformu, ktera ridi autonomni AI vyvojove agenty nad GitHub repozitari.

## Pravidla pro praci

- Drz se konkretniho ukolu a nemen nesouvisejici soubory.
- Nepouzivej `sudo`, nespoustej produkcni deploy a nemen secrets.
- Nove produkcni integrace navrhuj pres adaptery, aby zustal AI provider vymenitelny.
- Rizikove operace musi mit explicitni approval workflow.
- Backend, worker i UI musi sdilet domenove typy z `packages/core`.
- Po zmenach spust relevantni validaci: minimalne `npm run build` a podle dopadu take `npm test`.

## Done when

Ukol je hotovy pouze tehdy, kdyz:

- build projde bez chyby,
- typy jsou konzistentni napric workspaces,
- zmeny odpovidaji README a nemaji nesouvisejici rozsah,
- zustava zachovana auditovatelnost tasku, behu a approvalu.

