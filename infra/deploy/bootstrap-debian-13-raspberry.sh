#!/usr/bin/env bash
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-filip}"
APP_ROOT="${APP_ROOT:-/home/${DEPLOY_USER}/forgemind}"

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "Deploy user '${DEPLOY_USER}' does not exist." >&2
  exit 1
fi

. /etc/os-release
if [ "${ID:-}" != "debian" ]; then
  echo "This bootstrap expects Debian; detected '${ID:-unknown}'." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg rsync

if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  printf '%s\n' \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

sudo usermod -aG docker "${DEPLOY_USER}"
sudo install -d -m 0750 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
  "${APP_ROOT}" \
  "${APP_ROOT}/app" \
  "${APP_ROOT}/releases" \
  "${APP_ROOT}/shared" \
  "${APP_ROOT}/migration"

if [ ! -f "${APP_ROOT}/shared/server.env" ]; then
  sudo install -m 0600 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" /dev/null "${APP_ROOT}/shared/server.env"
fi

if command -v tailscale >/dev/null 2>&1; then
  sudo tailscale set --operator="${DEPLOY_USER}"
fi

echo "Bootstrap finished. Log out and back in before using Docker as ${DEPLOY_USER}."
echo "ForgeMind root: ${APP_ROOT}"
