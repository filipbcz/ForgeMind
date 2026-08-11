# Reference-project qualification

This qualification drives ForgeMind through four real roadmap cycles and 15-25 autonomous tasks. It creates a private GitHub repository and uses the configured default Codex connection.

```powershell
npm run qualify:reference -- provision
npm run qualify:reference -- monitor
npm run qualify:reference -- status
npm run qualify:reference -- restart-snapshot
# Restart the worker while the selected roadmap task is still active.
npm run qualify:reference -- restart-verify
npm run qualify:reference -- verify
```

The monitor approves three fixed, contract-preserving extensions and rejects the proposal after cycle 4. It fails on terminal task errors or unexpected approvals. The hidden verifier clones the final repository and independently checks the root quality commands, real HTTP API, PostgreSQL data, role enforcement, workflow, reports, Chrome UI and Docker preview.

Run state is written below `.forgemind/qualification` and is intentionally not committed. Set `FORGEMIND_API_URL`, `FORGEMIND_QUALIFICATION_GITHUB_OWNER`, `FORGEMIND_QUALIFICATION_TIMEOUT_HOURS`, `FORGEMIND_QUALIFICATION_PREVIEW_URL` or `FORGEMIND_QUALIFICATION_CHROME` only when the defaults do not match the environment.
