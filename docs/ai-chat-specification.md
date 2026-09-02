# AI Chat s pristupem k repozitarum

## Cil

ForgeMind poskytuje samostatnou sekci AI Chat pro dlouhodobe konverzace. AI muze odpovidat textem a po pripojeni repozitare take cist a menit soubory, spoustet prikazy a testy a pracovat s Gitem. Chatova vlakna nemusi byt navazana na projekt ForgeMindu.

## Funkcni rozsah

- Uzivatel muze vytvorit, pojmenovat, prejmenovat, archivovat a odstranit vlakno.
- Historie zprav, provider session, behy a technicka aktivita preziji restart sluzeb.
- Kazda uzivatelska zprava vytvori samostatny perzistentni chatovy beh.
- Behem behu se zobrazuje ziva aktivita providera a zmeny workspace.
- Neuspesny nebo preruseny beh lze obnovit bez ztraty historie.
- Vlakno muze existovat bez projektu a repozitare; AI v tomto rezimu komunikuje a planuje.
- Vlakno muze mit jeden aktivni repozitar a volitelny projektovy kontext.
- Vlakno pouziva vybranou ulozenou AI provider connection a model.

## Prace nad repozitarem

- Kazde vlakno pouziva perzistentni workspace a vlastni pracovni branch.
- AI muze cist, vytvaret, menit a mazat soubory a spoustet potrebne prikazy.
- Stav branche, zmenene soubory a diff jsou viditelne v UI.
- AI muze provadet dostupne Git a ForgeMind operace jmenem prihlaseneho uzivatele bez druheho runtime approval kroku.
- Zmena repozitare nebo branche je explicitni, viditelna a auditovana.
- Repozitar je zdroj pravdy; provider session pouze omezuje opakovane posilani kontextu.

## Kontext a dlouha vlakna

- Provider dostane relevantni historii, ulozeny souhrn vlakna, stav repozitare a volitelny projektovy kontext.
- Kompatibilni provider session se obnovuje mezi zpravami.
- Pri ztrate session se kontext znovu sestavi z databaze a aktualniho repozitare.
- Dlouha historie muze byt komprimovana do strukturovaneho souhrnu; puvodni zpravy zustanou ulozene.

## Webove rozhrani

- Seznam vlaken a akce pro vytvoreni, prejmenovani, archivaci a odstraneni.
- Historie uzivatelskych a AI zprav s Markdown obsahem.
- Editor zpravy s odeslanim a zastavenim aktivniho behu.
- Vyber provider connection, projektu, repozitare a branche.
- Zivy strucny prehled aktivity a rozbalitelny technicky vystup.
- Prehled zmenenych souboru a diff.
- Chyba a retry jsou zobrazeny u konkretniho behu.

## Perzistence a obnova

- PostgreSQL uklada vlakna, zpravy, behy, aktivity a provider session.
- Rozpracovany workspace je deterministicky vazan na vlakno a prezije restart workeru.
- Stary claimed beh se po timeoutu vrati k dokonceni nad stejnym workspace.
- Retry neopakuje dokoncene externi operace.

## Autentizace a audit

- Vsechny read i write API operace vyzaduji platnou Google session; browser mutace pouzivaji origin a CSRF ochranu.
- Operace AI Chatu pouzivaji opravneni prihlaseneho uzivatele a konkretni ulozene integrace.
- Secrets, tokeny a prihlasovaci udaje se nesmi ulozit do zpravy ani aktivity.
- Kazda zprava, zmena stavu, provider beh a Git/ForgeMind operace jsou auditovatelne.
- Runtime approval podsystém se nepouziva; historicke approval zaznamy mohou zustat pouze pro audit starych behu.

## Akceptacni kriteria

1. Vice nezavislych vlaken a jejich historie prezije restart API, workeru a databazoveho spojeni.
2. AI odpovi i bez pripojeneho repozitare.
3. Po pripojeni repozitare AI upravi soubor a zmena se zobrazi v diffu.
4. Provider aktivita se zobrazuje behem behu bez pollingu cele historie.
5. Selhani providera se zobrazi cele a retry zachova kontext i workspace.
6. Ztrata provider session nezpusobi ztratu konverzace.
7. Autentizovany uzivatel muze pres chat provest podporovane ForgeMind a repository operace bez approval pauzy.
8. Archivovane vlakno lze znovu otevrit; odstraneni vyzaduje explicitni UI potvrzeni.
9. Vsechny chatove mutace a operace jsou auditovatelne a redigovane.
10. Build, unit testy, API integracni testy a browser smoke test projdou.

## Mimo rozsah

- Hlasovy chat a multimodalni prilohy.
- Sdileni vlaken mezi vice uzivateli.
- Soucasny zasah do vice repozitaru v jednom vlakne.
- Automaticke spousteni roadmap workflow z chatu.
