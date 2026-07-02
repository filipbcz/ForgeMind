# Security Notes

MVP musi zustat konzervativni:

- Worker nesmi bezet jako root a nesmi pouzivat `sudo`.
- Produkcni deploy a merge do `main` nejsou soucasti MVP.
- Rizikove zmeny musi vytvorit approval.
- Secrets nesmi byt posilane do promptu, logu, issue ani PR.
- Kazdy task musi mit limity na iterace, rozpocet, cas, pocet souboru a velikost diffu.
- Worker zapisuje pouze do izolovaneho workspace.
- Systemd unit pouziva `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict` a omezeny `ReadWritePaths`.

Soucasny worker ma ochranu proti zjevne rizikovym validacnim prikazum. Pred realnym provozem musi vzniknout pevny allowlist prikazu z projektove konfigurace a redakce logu.

