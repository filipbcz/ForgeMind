export const qualificationManifest = {
  name: 'ForgeMind Qualification OpsBoard',
  slugPrefix: 'forgemind-qualification-opsboard',
  repositoryPrefix: 'forgemind-qualification-opsboard',
  expectedCycles: 4,
  minTasks: 15,
  maxTasks: 41,
  initialObjective: `Build cycle 1 of a production-ready application named OpsBoard. This cycle establishes only the executable foundation and must return five or six focused implementation steps.

The repository is a Node.js 22 npm workspace monorepo. It contains a React 19 + TypeScript + Vite SPA, a TypeScript Fastify API, and PostgreSQL accessed through Prisma migrations. Docker Compose is the authoritative local runtime. Keep shared contracts in a dedicated workspace and keep browser, API, domain, and persistence boundaries explicit.

Cycle 1 scope:
- workspace scaffolding, strict TypeScript, lint, unit-test and build scripts;
- PostgreSQL schema and committed Prisma migrations for User and Role, with ADMIN, MANAGER and AGENT roles;
- deterministic seed users admin@example.test, manager@example.test and agent@example.test, all using password Admin123! only in local and test environments;
- POST /api/auth/login returning a bearer token and user, GET /api/auth/me, and GET /api/health;
- a React login screen and authenticated application shell using stable data-testid attributes login-email, login-password, login-submit and current-user;
- Docker Compose services named db, api and web. The web service is available at http://localhost:18080 and reverse proxies /api to the API. PostgreSQL is internal and must not require a host port.

Out of scope for this cycle: work-item workflow, reporting, exports, CI and production deployment. Do not add placeholder implementations for later cycles. Every step must add executable tests for its own behavior and preserve one coherent architecture.`,
  extensions: [
    `Build cycle 2 of OpsBoard as five or six focused implementation steps. Add the main work-request workflow without changing the cycle 1 architecture.

Add a WorkItem aggregate with immutable id and createdAt, title, optional description, status OPEN | IN_PROGRESS | DONE, creator and optional assignee. Add committed migration and repository/domain services. Expose POST /api/work-items, GET /api/work-items with status and assignee filters, GET /api/work-items/:id, PATCH /api/work-items/:id/assignee and PATCH /api/work-items/:id/status. AGENT can create and view work items; MANAGER and ADMIN can assign and transition them. Invalid transitions and unauthorized mutations return useful 4xx responses and never change data. Persist an AuditEvent for every successful assignment and status transition.

Add the authenticated React workflow: list/filter work items, create form, detail panel, assignment and status actions according to role. Use stable data-testid attributes work-item-title, work-item-create, work-item-list, work-item-status and work-item-assignee. Add API integration tests, persistence tests, role tests and browser-oriented component tests. Do not add reporting or deployment work in this cycle.`,
    `Build cycle 3 of OpsBoard as five or six focused implementation steps. Add reporting and operational visibility while preserving all authentication, role and workflow contracts.

Expose GET /api/reports/summary for MANAGER and ADMIN only. It returns exact numeric total, open, inProgress and done fields plus arrays byAssignee and recentTransitions. Support optional createdFrom and createdTo ISO-date filters. Add a read-only dashboard at /reports with summary counters, status distribution, assignee table and recent transition list. Use stable data-testid attributes report-total, report-open, report-in-progress, report-done and report-assignees. Add CSV export at GET /api/reports/work-items.csv with deterministic columns and ordering. Reporting queries must use persisted PostgreSQL data, not fixtures or duplicated in-memory state.

Add focused API, authorization, database and React tests. Add regression coverage proving cycle 1 login and cycle 2 work-item workflows remain valid. Do not add preview deployment or CI in this cycle.`,
    `Build cycle 4 of OpsBoard as five or six focused implementation steps and make the repository release-candidate ready.

Complete the Docker preview deployment at http://localhost:18080 with production builds, health checks, dependency readiness and automatic Prisma migration plus deterministic local/test seed. Add a GitHub Actions workflow that runs npm ci, lint, typecheck, tests, production build and a Docker Compose smoke test. Add structured API request logging and health/readiness endpoints without exposing secrets. Add independent end-to-end tests covering login, role enforcement, work-item creation, assignment, status transition and reporting through real HTTP and a real browser. Document architecture, local setup, seeded accounts, API contracts, migrations, validation and preview operation.

The final root commands npm test, npm run lint, npm run typecheck and npm run build must pass. docker compose up -d --build must become healthy without manual steps. Do not add unrelated product features. Preserve the established module boundaries and remove any temporary placeholder left by earlier cycles.`
  ]
};
