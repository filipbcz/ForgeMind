# Security Guide

Tento dokument je provozni baseline pro ForgeMind MVP. Cilem je mit jasne hranice bezpecnosti pro worker, API a jejich integrace.

## 1) Security baseline (plati vzdy)

1. Worker nesmi bezet jako root a nesmi pouzivat sudo.
2. Automaticky deploy do produkce a automaticky merge do main jsou mimo scope MVP.
3. Rizikove zmeny musi byt zastaveny do stavu needs_approval.
4. Secrets nesmi byt zapisovany do promptu, logu, issue, PR ani audit payloadu.
5. Kazdy task musi mit limity: iterace, runtime, diff, pocet souboru, opakovane chyby a rozpocet.
6. Worker smi zapisovat pouze do vyhrazenych workspace cest.

## 2) Co je implementovane ted

1. Worker bezi v oddelene service identite (systemd user/group forgemind-agent).
2. Queue je persistovana v PostgreSQL a ma claim/recovery/retry semantiku.
3. Worker policy enforcement je aktivni:
- budget overrun zastavi beh (budget_exceeded)
- opakovane stejne chyby zastavi beh (repeated_error_detected)
- max iterace zastavi beh (iteration_limit_reached)
- provider selhani je mapovano na provider_failed
4. GitHub webhook endpoint overuje podpis pomoci x-hub-signature-256.
5. Risky outcome vytvari approval a beh se zastavi ve stavu needs_approval.

## 3) Secrets handling standard

1. Secrets smi byt predavany pouze pres environment promennne, tajne uloziste hostingu nebo sifrovany credential store.
2. Zakazane je vkladat secrets do:
- AGENTS instructions
- provider promptu
- audit log payloadu
- PR/issue tel
- error stack trace vracenych do API odpovedi
3. Pri logovani chyb pouzivat redakci citlivych tokenu (GitHub tokeny, OpenAI API key, webhook secret).
4. Doporucene minimum pro produkci:
- GITHUB_TOKEN pouze s nejmensimi nutnymi scopes
- oddelene tokeny pro API a worker
- rotace secrets alespon jednou za 90 dni
5. Persistentni GitHub connection uklada token v DB pouze sifrovane. V produkci musi byt nastaven `FORGEMIND_CREDENTIAL_KEY`; lokalni development si pri prvnim ulozeni umi vytvorit ignorovany klic v `.forgemind/credential-key`.

## 4) Workspace isolation a retention

1. Workspace root workeru musi byt dedikovana cesta mimo systemove adresare.
2. ReadWrite musi byt omezen jen na:
- worker runtime data
- log adresar
- dočasne workspace
3. Po dokonceni tasku se ma workspace archivovat nebo mazat podle retention policy.
4. Retention policy (MVP doporuceni):
- failed runs: uchovat 14 dni
- succeeded runs: uchovat 7 dni
- approvals/audit: uchovat 90 dni

## 5) Validation command sandbox

1. Validation command nesmi byt libovolny shell text bez kontroly.
2. Pred produkci musi byt zavedena allowlist politika prikazu z projektove konfigurace.
3. Zakazane command patterns:
- sudo
- rm -rf /
- curl|bash vzdalenych skriptu
- write operace mimo repo/workspace
4. Pri poruseni pravidla musi worker skoncit ve failed/provider_failed podle typu chyby a zapsat audit event.

## 6) systemd hardening profil

Aktualni unit uz ma:
1. NoNewPrivileges=true
2. PrivateTmp=true
3. ProtectSystem=strict
4. ProtectHome=true
5. ReadWritePaths omezeny na runtime cesty

Doporucene doplneni pred produkci:
1. PrivateDevices=true
2. ProtectKernelTunables=true
3. ProtectKernelModules=true
4. ProtectControlGroups=true
5. RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
6. MemoryMax a CPUQuota limity podle kapacity serveru

## 7) API security guardrails

1. CORS nesmi zustat otevrene pro vsechny originy v produkci.
2. Auth endpointy musi mit rate limiting.
3. Webhook endpoint musi odmitnout request bez raw body nebo bez podpisu.
4. Audit udalosti z webhooku nesmi obsahovat cele payloady s citlivymi daty.

## 8) Incident response minimum

1. Kazdy provider/github fail musi zapsat audit event s operation typem.
2. Pri opakovanych selhanich queue jobu po limitu pokusu zustane job ve failed a musi byt viditelny v operacnim feedu.
3. Pri incidentu musi byt dohledatelne:
- task id
- task run id
- queue job id
- provider/model
- operation phase

## 9) Done criteria pro security krok

Krok je povazovan za hotovy, pokud:
1. Tento dokument odpovida aktualnimu runtime chovani API a workeru.
2. Je zde jasne oddeleno co je implementovane a co je povinne pred produkci.
3. Systemd, secrets, sandbox a retention maji konkretni provozni pravidla.
