# AI Chat s pristupem k repozitarum

## Cil

ForgeMind poskytne samostatnou sekci AI Chat pro dlouhodobe konverzace s AI. AI muze odpovidat textem a po pripojeni repozitare take cist a menit soubory, spoustet prikazy a testy a pracovat s Gitem. Chatova vlakna nejsou povinne navazana na projekty ForgeMindu.

## Funkcni rozsah

- Uzivatel muze vytvorit, pojmenovat, prejmenovat, archivovat a odstranit vlakno.
- Historie zprav, provider session, behy a technicka aktivita zustanou zachovane po restartu sluzeb.
- Kazda uzivatelska zprava vytvori samostatny perzistentni chatovy beh.
- Behem behu se zobrazuje ziva aktivita providera a zmeny workspace.
- Neuspesny nebo preruseny beh lze obnovit bez ztraty historie.
- Vlakno muze existovat bez projektu a bez repozitare; v tomto rezimu AI pouze komunikuje a planuje.
- Vlakno muze mit prave jeden aktivni repozitar: repozitar projektu ForgeMindu nebo jiny repozitar dostupny pres ulozene GitHub pripojeni.
- Volitelne pripojeni projektu prida do kontextu specifikaci, kontrakt a architekturu projektu.
- Vlakno pouziva vybranou ulozenou AI provider connection a jeji model.

## Prace nad repozitarem

- Kazde vlakno pouziva izolovany perzistentni workspace a vlastni pracovni branch.
- AI muze cist, vytvaret, menit a mazat soubory a spoustet prikazy uvnitr workspace.
- Stav branche a zmenene soubory jsou viditelne v UI.
- Commit, push, pull request, merge, zapis mimo workspace a dalsi rizikove operace respektuji approval policy.
- Zmena repozitare nebo branche je explicitni, viditelna a auditovana.
- Repozitar je zdroj pravdy; provider session pouze snizuje opakovane posilani kontextu.

## Kontext a dlouha vlakna

- Provider dostane relevantni historii, ulozeny souhrn vlakna, stav repozitare a volitelny projektovy kontext.
- Kompatibilni provider session se obnovuje mezi zpravami.
- Pri ztrate session se novy kontext sestavi z databaze a aktualniho repozitare.
- Dlouha historie muze byt komprimovana do strukturovaneho souhrnu; puvodni zpravy zustanou ulozene a zobrazitelne.

## Webove rozhrani

- Seznam vlaken a akce pro vytvoreni, prejmenovani, archivaci a odstraneni.
- Historie uzivatelskych a AI zprav s Markdown obsahem.
- Editor zpravy s odeslanim a zastavenim aktivniho behu.
- Vyber provider connection, projektu, repozitare a branche.
- Zivy, strucny prehled aktivity; technicke vystupy jsou rozbalitelne.
- Prehled zmenenych souboru a diff.
- Chyba a retry jsou zobrazeny u konkretniho behu.
- Approval je zobrazen primo v konverzaci.

## Perzistence a obnova

- PostgreSQL uklada vlakna, zpravy, behy, aktivity, provider session a approvals.
- Rozpracovany workspace je deterministicky vazan na vlakno a prezije restart workeru.
- Stary claimed beh se po timeoutu oznaci jako preruseny a lze jej znovu zaradit.
- Retry pokracuje nad stejnym workspace a historii a neopakuje dokoncene externi operace.

## Bezpecnost a audit

- Vsechny mutace vyzaduji autentizovanou session a CSRF ochranu.
- Secrets, tokeny a prihlasovaci udaje se nesmi ulozit do zpravy ani aktivity.
- Kazda zprava, zmena stavu, provider beh, approval a Git operace jsou auditovatelne.
- Operace mimo workspace jsou zakazane bez explicitniho approval.
- Existujici taskove a roadmap workflow zustane funkcni beze zmeny.

## Akceptacni kriteria

1. Lze vytvorit vice nezavislych vlaken a jejich historie prezije restart API, workeru a databazoveho spojeni.
2. AI odpovi ve vlakne bez pripojeneho repozitare.
3. Po pripojeni GitHub repozitare AI dokaze upravit soubor a zmena se zobrazi v diffu.
4. Provider aktivita se zobrazuje behem behu bez pollingu cele historie.
5. Selhani providera se zobrazi cele a retry zachova kontext i workspace.
6. Provider session se obnovi, ale jeji ztrata nezpusobi ztratu konverzace.
7. Rizikova operace se zastavi na approval a po schvaleni navaze.
8. Archivovane vlakno lze znovu otevrit; odstraneni vyzaduje explicitni potvrzeni.
9. Vsechny chatove mutace a operace jsou auditovatelne a redigovane.
10. Build, unit testy, API integracni testy a browser smoke test projdou.

## Mimo rozsah prvni verze

- Hlasovy chat a multimodalni prilohy.
- Sdileni vlaken mezi vice uzivateli.
- Soucasny zasah do vice repozitaru v jednom vlakne.
- Automaticke spousteni roadmap workflow z chatu.
