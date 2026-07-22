#!/usr/bin/env bash
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-ubuntu}}"
APP_ROOT="${APP_ROOT:-/opt/forgemind}"

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "Deploy user '${DEPLOY_USER}' does not exist." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git rsync

if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

sudo usermod -aG docker "${DEPLOY_USER}"

sudo install -d -m 0755 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
  "${APP_ROOT}" \
  "${APP_ROOT}/app" \
  "${APP_ROOT}/releases" \
  "${APP_ROOT}/shared"

if [ ! -f "${APP_ROOT}/shared/server.env" ]; then
  sudo install -m 0640 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" /dev/null "${APP_ROOT}/shared/server.env"
fi

if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -qi "Status: active"; then
  sudo ufw allow OpenSSH
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw allow 8443/tcp
fi

echo "Bootstrap finished."
echo "Fill ${APP_ROOT}/shared/server.env, then log out and back in before the first deploy."
