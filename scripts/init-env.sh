#!/usr/bin/env sh
# Create a production .env with random secrets. Refuses to overwrite an existing file.
set -eu

cd "$(dirname "$0")/.."
if [ -e .env ]; then
  echo ".env already exists; not overwriting." >&2
  exit 1
fi

rand() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }

USER_KEY=$(rand)
ADMIN_KEY=$(rand)
DOCKER_GID=$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock 2>/dev/null || echo 999)

umask 077
cat > .env <<EOF
NODE_ENV=production
REDIS_PASSWORD=$(rand)
API_AUTH_ENABLED=true
API_KEYS=${USER_KEY}
ADMIN_API_KEYS=${ADMIN_KEY}
DOCKER_GID=${DOCKER_GID}
GRAFANA_PASSWORD=$(rand)
WORKER_CONCURRENCY=4
EOF

echo "Wrote .env (mode 600)."
echo "  User API key:  ${USER_KEY}"
echo "  Admin API key: ${ADMIN_KEY}"
echo "Start with: docker compose up -d --build"
