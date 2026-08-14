# Raspberry Pi Production Migration

This runbook moves the existing ForgeMind production stack from OCI to the ARM64 Raspberry Pi host. It preserves the PostgreSQL database, encrypted integration credentials, Codex login state, and worker workspaces. Do not generate a new `FORGEMIND_CREDENTIAL_KEY`; the existing value is required to decrypt provider and GitHub credentials after restore.

## Target

- Host: `100.98.107.4` over Tailscale
- User: `filip`
- Architecture: `linux/arm64`
- Application root: `/home/filip/forgemind`
- Local web upstream: `http://127.0.0.1:8080`
- Tailnet HTTPS name: `https://forgemind.tail50677a.ts.net`

The Raspberry workflow is manual-only. A push to `main` cannot switch production accidentally.
The OCI workflow is also manual-only during and after the migration. This prevents a regular
push from restarting the rollback host or deploying two production copies unintentionally.

## 1. Bootstrap Raspberry Pi

Copy `infra/deploy/bootstrap-debian-13-raspberry.sh` to the target and run it interactively as `filip`. The script installs Docker Engine and Compose, grants the deploy user Docker access, creates the application directories, and allows `filip` to manage Tailscale Serve.

Log out and back in after bootstrap, then verify:

```bash
docker version
docker compose version
test -w /home/filip/forgemind/shared
```

Configure the private HTTPS endpoint after the web container is available:

```bash
tailscale serve --bg http://127.0.0.1:8080
tailscale serve status
```

Only devices in the same tailnet can reach this endpoint. Port `8080` remains bound to loopback and must not be opened on the LAN router.

## 2. Configure GitHub

Create the `raspberry-production` GitHub environment with these secrets:

- `RPI_DEPLOY_HOST=100.98.107.4`
- `RPI_DEPLOY_USER=filip`
- `RPI_DEPLOY_SSH_KEY_B64`
- `RPI_DEPLOY_PORT` (optional, defaults to `22`)
- `TS_OAUTH_CLIENT_ID`
- `TS_OAUTH_SECRET`

The Tailscale OAuth client must be allowed to create ephemeral devices with the `tag:ci` tag. Tailnet ACLs must allow `tag:ci` to reach `forgemind:22`. The GitHub-hosted runner needs this connection because `100.98.107.4` is not publicly routable.

The `Deploy to Raspberry Pi` workflow builds dedicated ARM64 images. It does not replace the existing AMD64 OCI tags.

## 3. Preserve Production Configuration

Copy the existing OCI `/opt/forgemind/shared/server.env` to `/home/filip/forgemind/shared/server.env` with mode `0600`. Do not print the file or commit it.

Keep these values unchanged during migration:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `FORGEMIND_CREDENTIAL_KEY`
- provider, GitHub, webhook, and VAPID secrets

Update public callback values to the tailnet HTTPS URL where applicable, for example:

```dotenv
GITHUB_CALLBACK_URL=https://forgemind.tail50677a.ts.net/api/auth/github/callback
```

## 4. Create A Consistent OCI Backup

Pause the ForgeMind queue and wait for the active task to finish. Then stop all application writers while keeping PostgreSQL running:

```bash
cd /opt/forgemind/app
compose=(docker compose -p forgemind --env-file /opt/forgemind/shared/server.env -f infra/docker-compose.prod.yml)
"${compose[@]}" stop worker api codex-oauth-relay web
```

Create the database and volume archives:

```bash
mkdir -p /tmp/forgemind-migration
"${compose[@]}" exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > /tmp/forgemind-migration/database.dump

docker run --rm \
  -v forgemind_codex_home:/data:ro \
  -v /tmp/forgemind-migration:/backup \
  alpine tar -C /data -czf /backup/codex-home.tar.gz .

docker run --rm \
  -v forgemind_worker_workspaces:/data:ro \
  -v /tmp/forgemind-migration:/backup \
  alpine tar -C /data -czf /backup/worker-workspaces.tar.gz .

sha256sum /tmp/forgemind-migration/* > /tmp/forgemind-migration/SHA256SUMS
```

Transfer all artifacts through the trusted workstation to `/home/filip/forgemind/migration`. Verify `sha256sum -c SHA256SUMS` on the Raspberry Pi before restoring.

If export or transfer fails, restart the unchanged OCI stack immediately:

```bash
"${compose[@]}" up -d api codex-oauth-relay worker web
```

## 5. Restore On Raspberry Pi

Deploy the application once to create the Compose volumes, then stop its writers:

```bash
cd /home/filip/forgemind/app
export FORGEMIND_ENV_FILE=/home/filip/forgemind/shared/server.env
compose=(docker compose -p forgemind \
  --env-file /home/filip/forgemind/shared/server.env \
  -f infra/docker-compose.prod.yml \
  -f infra/docker-compose.raspberry.yml)
"${compose[@]}" stop worker api codex-oauth-relay web
"${compose[@]}" up -d postgres
```

Restore PostgreSQL into an empty application database:

```bash
"${compose[@]}" exec -T postgres sh -c \
  'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'

"${compose[@]}" exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < /home/filip/forgemind/migration/database.dump
```

Restore persistent files while their consumers are stopped:

```bash
docker run --rm \
  -v forgemind_codex_home:/data \
  -v /home/filip/forgemind/migration:/backup:ro \
  alpine sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C /data -xzf /backup/codex-home.tar.gz'

docker run --rm \
  -v forgemind_worker_workspaces:/data \
  -v /home/filip/forgemind/migration:/backup:ro \
  alpine sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C /data -xzf /backup/worker-workspaces.tar.gz'
```

Run `infra/deploy/remote-deploy.sh` through the Raspberry workflow again. It applies any newer Prisma migrations before starting API, worker, OAuth relay, and web.

## 6. Acceptance And Cutover

Do not resume the queue until all checks pass:

1. `curl http://127.0.0.1:8080/health` succeeds on Raspberry Pi.
2. `https://forgemind.tail50677a.ts.net/health` succeeds from a tailnet client.
3. Projects, tasks, approvals, provider connections, and GitHub settings match OCI.
4. Codex login status is connected; reauthenticate only if the copied login is rejected.
5. A read-only GitHub connection check succeeds.
6. One small test task completes through implementation, validation, review, and delivery.
7. Database and volume backups remain available until the new host is stable.

Keep OCI stopped but intact during the rollback window. Resume it only if Raspberry acceptance fails; never run both workers against independent copies of the production database at the same time.
