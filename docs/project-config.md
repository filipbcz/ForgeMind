# Project Configuration

Projektova konfigurace se nacita z `agent.config.yaml` pres `packages/config`.

Klicove oblasti:

- `project`: identita projektu, repo a default branch.
- `workflow`: rezim autonomie a povolene workflow kroky.
- `ai`: primarni, fallback a review provider.
- `limits`: rozpocty, iterace a ochrana proti zacykleni.
- `commands`: validacni prikazy.
- `approval`: rizikove akce a bezpecne automaticke zmeny.
- `sandbox`: zapisovatelne a zakazane cesty.
- `github`: label, prefix branche a draft PR nastaveni.

Parser vraci validovany objekt a helper `toCoreLimits()` prevadi YAML limity do domenoveho modelu z `packages/core`.

