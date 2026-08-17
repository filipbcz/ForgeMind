# ForgeMind - Plan rizeni kvality projektove roadmapy

Datum zalozeni: 2026-08-07
Stav: aktivni implementacni plan
Vlastnik toku: ForgeMind roadmap, worker a AI provider adaptery

## 1. Cil

ForgeMind nesmi povazovat projekt za hotovy jen proto, ze byly dokonceny a slouceny vsechny vygenerovane tasky. Dokonceni musi znamenat, ze aktualni stav repozitare prokazatelne splnuje projektove zadani.

Pozadovany vysledek:

- projektovy brief je preveden na verzovany, strukturovany kontrakt,
- roadmap work itemy jsou male, konkretni a dohledatelne ke kontraktnim pozadavkum,
- task, work item, pozadavek a cely roadmap cyklus maji oddelene dokoncovaci podminky,
- validace poskytuje technicke dukazy, review kontroluje konkretni zmenu a nezavisly audit kontroluje celou schopnost,
- chybejici implementace vytvori pouze konkretni gap work itemy,
- rozsireni projektu se navrhuje az po prokazatelnem splneni puvodniho kontraktu,
- kontext pro AI je dostatecny, ale neposila se opakovane cely brief ani cely repozitar.

## 2. Zavazna rozhodnuti

1. `Task completed` neznamena `contract requirement satisfied`.
2. Dokumentace, interface, fixture, placeholder, synteticka data nebo JSON s hodnotou `pass` nejsou dukazem funkcni produkcni schopnosti, pokud to kontrakt vyslovne nepozaduje.
3. Implementacni AI nesmi sama autoritativne rozhodnout, ze milestone je hotovy.
4. Audit je read-only provider operace s vlastnim strukturovanym kontraktem.
5. Automaticky se opravuji pouze blokujici mezery. Volitelna vylepseni se nespousteji.
6. Uspesne task faze a validacni prikazy se pri retry neopakuji.
7. GitHub Copilot provider zustava zakonzervovany. Novy auditni kontrakt bude implementovan pro Codex a OpenAI.
8. Existujici data se nemazou ani zpetne neoznaci za overena bez auditu.

## 3. Cilovy domenovy model

### 3.1 ProjectContract

Verzovany kontrakt odvozeny z briefu:

- `version`
- `summary`
- `invariants[]`
- `prohibitedSubstitutes[]`
- `requirements[]`
- `releaseCriteria[]`
- `sourceBriefHash`

Kazdy requirement ma stabilni `REQ-*` identifikator, popis a vlastni akceptacni kriteria.

### 3.2 Roadmap work item

`ProjectImplementationStep` zustane vykonnym work itemem. Musi obsahovat:

- vazbu `requirementIds[]`,
- konkretni `deliverables[]`,
- omezeny rozsah vhodny pro jeden pull request,
- vlastni automatizovatelna akceptacni kriteria,
- nejvyse tri kontraktni pozadavky.

Kontraktni requirement predstavuje milestone/capability. Samostatna milestone tabulka zatim neni nutna; stav capability lze odvodit z kontraktu, work itemu a auditnich vysledku. Pokud se ukaze potreba samostatneho vlastnictvi nebo paralelizace, prida se az na zaklade konkretniho pouziti.

### 3.3 AcceptanceEvidence

Nova perzistentni entita bude vazana na requirement a kriterium:

- `projectId`, `cycleId`, `requirementId`, `criterionKey`,
- `source`: `validation_command`, `github_check`, `repository_audit`, `artifact`,
- `status`: `passed`, `failed`, `blocked`,
- `commitSha`, `command`, `exitCode`, `detailsUrl`,
- omezeny strukturovany payload a cas vzniku,
- identifikace tasku a runu, ktery dukaz vytvoril.

AI text nebo soubor vytvoreny implementacnim taskem nebude sam o sobe duveryhodny zdroj stavu `passed`.

### 3.4 Stavy capability a cyklu

Capability se vyhodnocuje jako:

- `pending`: prace nezacala,
- `implementing`: existuje aktivni work item,
- `verifying`: work itemy jsou hotove a probiha nezavisly audit,
- `partial`: audit nasel konkretni implementacni mezery,
- `blocked`: pozadavek nelze automaticky dokoncit kvuli externi prekazce,
- `satisfied`: vsechna povinna kriteria maji platny dukaz.

Roadmap cyklus muze prejit do `completed` pouze tehdy, kdyz jsou vsechny requirements `satisfied` a release audit prosel.

## 4. Cilovy workflow

1. Uzivatel ulozi nebo zmeni brief.
2. AI jednim planovacim volanim vytvori `ProjectContract` a trasovatelne work itemy.
3. ForgeMind provede deterministickou kontrolu uplnosti, unikatnosti IDs, pokryti a velikosti work itemu.
4. Worker implementuje pouze aktualni work item.
5. AI navrhne minimalni validacni prikazy; worker posoudi policy a prikazy skutecne spusti.
6. Review zkontroluje pouze diff, regresni rizika a splneni work itemu.
7. Po zelenych GitHub checks muze dojit k merge a task/work item se oznaci jako completed.
8. Jakmile jsou work itemy requirementu hotove, capability prejde do `verifying`.
9. Novy read-only audit porovna aktualni repozitar, kontrakt a duveryhodne dukazy.
10. `satisfied`: requirement se uzavre. `partial`: vytvori se pouze gap work itemy. `blocked`: fronta se zastavi pro tento requirement a GUI ukaze duvod.
11. Po splneni vsech requirements probehne release audit nad celym kontraktem.
12. Teprve potom se cyklus dokonci a AI muze navrhnout dalsi rozsireni.

## 5. Implementacni etapy

### Etapa 0 - Baseline a ochrana rozpracovanych zmen

Stav: HOTOVO

- [x] Zmapovat aktualni roadmap API, repository, worker completion a provider review.
- [x] Zachovat rozpracovane GitHub Checks, CI feedback a phase-aware retry zmeny.
- [x] Potvrdit, ze existujici schema ma vazbu jednoho tasku na roadmap step a automaticke dokonceni cyklu.

Overeni: scope znamy, zadne uzivatelske zmeny nebyly vraceny.

### Etapa 1 - Projektovy kontrakt a trasovatelne work itemy

Stav: HOTOVO

- [x] Pridat sdilene typy `ProjectContract` a requirementu do `packages/core`.
- [x] Ulozit kontrakt do `projects.project_contract`.
- [x] Pridat `requirement_ids` a `deliverables` do roadmap work itemu.
- [x] Rozsirit Codex a OpenAI plan output o kontrakt a trasovatelnost.
- [x] Vynutit uplne pokryti requirements a maximalni velikost work itemu.
- [x] Posilat workeru kompaktni relevantni cast kontraktu.
- [x] Zobrazit kontrakt a requirement IDs v projektu.
- [x] Doplnit `sourceBriefHash` a invalidaci kontraktu pri zmene briefu.

Akceptace:

- roadmap bez kontraktu nebo s nepokrytym requirementem je odmitnuta,
- jeden work item ma nejvyse tri requirements, tri deliverables, pet kriterii a pet in-scope polozek,
- stary projekt bez kontraktu lze nacist,
- build a dotcene testy prochazeji.

### Etapa 2 - Perzistentni evidence a capability read model

Stav: HOTOVO

- [x] Pridat tabulku `acceptance_evidence` a odpovidajici core typy.
- [x] Ukladat jednotlive vysledky validacnich prikazu a GitHub checks s task/run/commit vazbou.
- [x] Vytvorit read model capability stavu bez AI volani.
- [x] Vyloucit dukaz z jine verze kontraktu.
- [x] Pri repository auditu potvrdit, ze auditni evidence odpovida aktualnimu commitu; realizovano v etape 3 pres read-only workspace `HEAD` a `commitSha` evidenci.
- [x] Pridat repository/API read model dukazu podle requirementu.

Akceptace:

- zadny `passed` dukaz nevznikne pouze parsovanim AI textu,
- opakovany beh je idempotentni,
- auditni payload je omezeny a neobsahuje secrets ani neomezene logy.

### Etapa 3 - Nezavisly read-only audit capability

Stav: HOTOVO

- [x] Pridat do `AIProvider` metodu `auditCapability` s vlastnim schema outputu.
- [x] Implementovat Codex audit v read-only sandboxu pro OAuth CLI; API key varianta vyzaduje cileny repository packet.
- [x] Implementovat OpenAI audit nad cilenym repository packetem.
- [x] Pro GitHub Copilot vratit explicitni `unsupported`, bez dalsiho rozvoje provideru.
- [x] Auditovat aktualni repository state, ne pouze posledni diff.
- [x] Vracet verdict po jednotlivych kriteriich: `passed`, `failed`, `blocked` a souhrnne `satisfied`, `partial`, `blocked`.
- [x] Ukladat audit jako `repository_audit` evidenci a audit log udalost.

Tokenova pravidla:

- neposilat cely brief, ale kontraktni invariants a jeden requirement,
- neposilat cely diff historie,
- nejprve poslat manifest relevantnich souboru a existujici evidence,
- obsah souboru nacitat providerem cilene v read-only workspace,
- znovu auditovat jen failed/missing kriteria.

Akceptace:

- implementacni provider response nemuze audit obejit,
- pass-valued JSON bez overitelneho zdroje je odmitnut,
- audit nema opravneni menit workspace,
- auditni retry neopakuje jiz satisfied kriteria; orchestrace tohoto bodu bude zapojena v etape 4.

### Etapa 4 - Gap work itemy a completion gate

Stav: HOTOVO

- [x] Zrusit prime `task completed -> roadmap cycle completed` pro kontraktni roadmapy.
- [x] Po dokonceni work itemu spustit audit relevantnich requirements pred dalsim requirementem.
- [x] Z auditnich `missing` vysledku vytvorit male gap work itemy s prednosti pred puvodnimi pending kroky.
- [x] Deduplicovat gap work itemy podle requirementu, deliverables a normalizovaneho popisu.
- [x] Nespoustet `safeImprovements` ani obecna doporuceni automaticky.
- [x] Po `blocked` nezakladat nekonecne retry; zobrazit konkretni externi prekazku.
- [x] Zachovat phase-aware resume, perzistentni audit job a vsechny uspesne checkpointy.

Akceptace:

- task muze byt completed, zatimco capability je partial,
- dalsi puvodni roadmap work item se nespusti pres nevyresenou povinnou mezeru,
- gap retry neopakuje planning, implementaci ani validaci, ktere uz uspesne probehly,
- stejna mezera nevytvari duplicitni tasky.

### Etapa 5 - Release audit a rozsireni projektu

Stav: HOTOVO

- [x] Pred dokoncenim cyklu auditovat vsechny release criteria a global invariants.
- [x] Kontrolovat vazby mezi capabilities a end-to-end funkcnost.
- [x] Stav `completed` povolit pouze pri vsech `satisfied` vysledcich a uspesnem release auditu.
- [x] Navrh rozsireni generovat az po uspesnem release auditu.
- [x] Schvalene rozsireni vytvori novou verzi kontraktu a novy roadmap cyklus.

Akceptace:

- pocet sloucenych PR neni completion signal,
- prazdne, synteticke nebo zastarale evidence cyklus neuzavrou,
- extension proposal se neobjevi pro partial/blocked projekt.

### Etapa 6 - GUI a provozni prehled

Stav: HOTOVO

- [x] Zobrazit souhrn kontraktu a requirement IDs work itemu.
- [x] Zobrazit requirements jako hlavni milestones vcetne odvozeneho stavu a poctu evidenci.
- [x] U kazdeho zobrazit stav, pokryti kriterii, evidence a navazane work itemy.
- [x] Zobrazit plnou auditni chybu se zalamovanim dlouheho textu.
- [x] Odstranit mateni mezi completed taskem a partial capability oddelenymi stavy.
- [x] Pridat akci pro opakovani pouze failed/blocked auditu.

Akceptace: uzivatel z jedne obrazovky pozna, co je implementovano, co je prokazano, co chybi a co se prave deje.

### Etapa 7 - Migrace existujicich projektu a rollout

Stav: IMPLEMENTACE HOTOVA, CEKA NA PRODUKCNI ROLLOUT

- [x] Pripravit nedestruktivni schema migrace bez mazani roadmap, tasku nebo auditu.
- [x] Existujici completed kroky bez kontraktu ponechat historicky completed bez zpetneho prepisu.
- [x] Negenerovat zpetne falesnou evidenci.
- [x] Umoznit uzivateli vytvorit kontrakt a novy auditovatelny cyklus pregenerovanim roadmapy stareho projektu.
- [ ] Nasadit nejprve na jeden testovaci projekt, pote na produkcni roadmapy.
- [ ] Po deployi overit worker resume, queue a jeden cely projektovy requirement.

## 6. Testovaci matice

Povinne testy pred uzavrenim planu:

- unit: normalizace kontraktu, unikatni IDs, uplne pokryti a sizing work itemu,
- unit: evidence provenance, freshness a deduplikace,
- unit: capability/cycle state transitions,
- provider: Codex/OpenAI audit schema, malformed output a timeout,
- worker: task completion nezavre requirement bez auditu,
- worker: partial audit vytvori jen chybejici gap work item,
- worker: retry znovu nespusti uspesne faze ani satisfied kriteria,
- integration: roadmap generation -> implementace -> validace -> merge -> audit -> dalsi work item,
- integration: vsechny requirements satisfied -> release audit -> cycle completed,
- migration: stary projekt bez kontraktu zustane citelny a nedostane falesny pass,
- root: `npm run build` a `npm test`.

## 7. Definition of Done

Tento plan je dokoncen pouze kdyz:

1. ForgeMind nemuze uzavrit kontraktni roadmap cyklus bez nezavisleho release auditu.
2. Kazde povinne kriterium ma aktualni duveryhodny dukaz nebo explicitni blocked stav.
3. Chybejici implementace vytvori konkretni gap work item a ne obecnou dalsi iteraci.
4. UI odlisuje task, work item, capability a projektove dokonceni.
5. Existujici projekty jsou migrovany bez ztraty dat a bez falesneho overeni.
6. Kompletni build, testy a jeden realny end-to-end projektovy tok projdou.

## 8. Poradi dalsi prace

Implementace etap 1-6 a migracni kod etapy 7 jsou hotove. Dalsi prace je provozni a pokracuje v tomto poradi:

1. Potvrdit, ze automaticky deploy uspesne aplikoval pripravene databazove migrace; pokud ne, dokoncit je podle runbooku.
2. Overit po deployi obnovu workeru, stav fronty a zachovani existujicich projektu bez falesne evidence.
3. Spustit jeden testovaci projektovy requirement pres implementaci, validaci, merge a capability audit.
4. Overit release audit a completion gate na celem testovacim roadmap cyklu.
5. Teprve po uspesne akceptaci rozsirit rollout na produkcni roadmapy.

Raspberry workflow se spousti automaticky po pushi do `main`; samotna aplikace migraci a obnoveni
produkcnich roadmap vsak musi respektovat runbook a explicitni provozni kontrolu z
`docs/deploy-raspberry.md`.
