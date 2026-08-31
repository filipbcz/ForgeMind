# OCI Deployment

GitHub Actions builds immutable ForgeMind container images, publishes them to GitHub Container Registry (GHCR), uploads a release archive over SSH and asks the remote script to update the Docker Compose stack.

## Production services

- `web`: internal Caddy serving the PWA and proxying API/WebSocket traffic
- `api`: ForgeMind Studio API
- `worker`: persistent ForgeMind worker daemon
- `postgres`: application database
- `migrate`: one-shot Prisma migration runner used during deployment

Persistent Docker volumes keep PostgreSQL data, Codex login data and worker workspaces across releases. The Compose project is explicitly named `forgemind`, so its containers, network and volumes cannot collide with `Running`.

The `web` service does not publish host ports. It is reachable only as `forgemind-web` on the external `shared-edge` Docker network. The existing Caddy container from `Running` remains the only process bound to host ports `80` and `443`.

## Server preparation

The target is an Ubuntu 24.04 server with inbound ports `22`, `80`, `443` and `8443` allowed. Running continues to use standard HTTPS on `443`; ForgeMind is exposed as `https://myrunning.duckdns.org:8443`.

Run once on the server from a repository checkout:

```bash
chmod +x infra/deploy/bootstrap-ubuntu-24.04.sh
./infra/deploy/bootstrap-ubuntu-24.04.sh
```

Log out and back in so the deploy user receives Docker group membership.

Create `/opt/forgemind/shared/server.env` from `infra/deploy/server.env.example`. At minimum, replace:

- `POSTGRES_PASSWORD` in both `POSTGRES_PASSWORD` and `DATABASE_URL`
- `FORGEMIND_CREDENTIAL_KEY`
- `FORGEMIND_AUTH_SESSION_SECRET`, Google OAuth client credentials, exact HTTPS callback URL, and `FORGEMIND_GOOGLE_ALLOWED_EMAIL`
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` when push notifications are enabled

Generate the credential key with:

```bash
openssl rand -base64 32
```

Generate the VAPID pair with:

```bash
node -e "const webpush = require('web-push'); console.log(JSON.stringify(webpush.generateVAPIDKeys(), null, 2));"
```

Do not commit `server.env`.

## Shared HTTPS edge

Create the shared network once; the ForgeMind deploy script also creates it when missing:

```bash
docker network create shared-edge
```

In the `Running` production Compose file, attach its `caddy` service to both its default network and the shared edge network:

```yaml
services:
  caddy:
    networks:
      default:
      shared-edge:

networks:
  shared-edge:
    external: true
    name: shared-edge
```

Publish the additional HTTPS port from the `Running` Caddy service:

```yaml
services:
  caddy:
    ports:
      - "80:80"
      - "443:443"
      - "8443:8443"
```

Add a second site to the `Running` Caddyfile:

```caddyfile
https://myrunning.duckdns.org:8443 {
  encode zstd gzip
  reverse_proxy forgemind-web:80
}
```

Recreate the `Running` Caddy container after changing its Compose file and Caddyfile. Caddy reuses the certificate for `myrunning.duckdns.org`, TLS termination remains in one place, and neither application exposes database, API or worker ports on the host.

Allow inbound TCP port `8443` in the OCI security list or network security group. The ForgeMind bootstrap script also allows it when UFW is active.

## GitHub repository configuration

Create a `production` environment in the ForgeMind repository and add these environment secrets:

- `OCI_DEPLOY_HOST`
- `OCI_DEPLOY_USER`
- `OCI_DEPLOY_SSH_KEY_B64`
- `OCI_DEPLOY_PORT` (optional, defaults to `22`)

The secret names intentionally match the `Running` repository, but personal repository secrets must be configured separately. Encode the private key in PowerShell with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.ssh\forgemind_oci_deploy"))
```

Add the corresponding public key to `~/.ssh/authorized_keys` for the deploy user on the server.

The workflow uses its short-lived `GITHUB_TOKEN` to publish images and authenticate the OCI host to GHCR for the duration of the deployment. No persistent registry password or additional repository secret is required.

## Deployment

Deployment runs automatically after a push to `main` or manually through the `Deploy to OCI` workflow. The workflow:

1. builds the stable `runtime-base` image only when dependencies, the Dockerfile, or the Prisma schema change,
2. builds the small application `runtime` layer and the `web` image on the GitHub-hosted runner,
3. publishes immutable dependency and commit-SHA tags plus moving `main` tags to GHCR,
4. uploads an immutable Git archive,
5. synchronizes it to `/opt/forgemind/app`,
6. stops the worker so an active task is requeued before image downloads,
7. reuses the pinned runtime base and pulls the exact commit-SHA application images,
8. applies Prisma migrations only when their checksum or the database migration state changed,
9. starts the API, worker and web proxy,
10. waits for the API health check.

The OCI host does not run `npm ci` or compile the monorepo during deployment. The `main` image tags are defaults for manual Compose inspection; automated deployment always passes immutable SHA tags.
Each deployment prints `docker system df` before and after cleanup. The runtime base remains a build-only GHCR artifact and is not downloaded to the production host; only deployable runtime and web images consume production disk space.

## Provider configuration

Configure GitHub and the AI provider in the deployed ForgeMind UI. Encrypted credentials use `FORGEMIND_CREDENTIAL_KEY` and are stored in PostgreSQL.

Codex browser OAuth is started by the API container and stores its state in the persistent `codex_home` volume. The production stack exposes its callback relay only on the server loopback interface (`127.0.0.1:1455`); it is not publicly reachable and port `1455` must not be opened in UFW or the OCI security list.

When the browser runs on another computer, start this tunnel before opening the Codex OAuth authorization URL, then keep it running until the browser reports success:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 1455:127.0.0.1:1455 ubuntu@myrunning.duckdns.org
```

The browser's fixed `http://localhost:1455/auth/callback` redirect is forwarded through SSH to the loopback-only relay, which forwards it to the Codex CLI listener inside the API container.

## Operations

On the server:

```bash
cd /opt/forgemind/app
docker compose --env-file /opt/forgemind/shared/server.env -f infra/docker-compose.prod.yml ps
docker compose --env-file /opt/forgemind/shared/server.env -f infra/docker-compose.prod.yml logs -f api worker
```
