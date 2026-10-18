#!/usr/bin/env bash
#
# install.sh — Automated installer for FREE GW
#
# Sets up Node.js, PostgreSQL + Redis (via Docker), and builds/migrates/runs
# the backend as a single systemd service. The backend also serves the
# dashboard frontend directly (same origin, same port) — so there is only
# ONE port to expose, which makes reverse proxies and tunnels (Cloudflare
# Tunnel, ngrok, Nginx, etc.) trivial: point them at this one port and both
# the dashboard and the API work automatically on whatever domain you use,
# with no Base URL to configure.
#
# Usage:
#   sudo ./install.sh [options]
#
# Options:
#   --port <port>          Port for the backend (serves dashboard + API,
#                          default: 3000)
#   --cors-origin <url>    Allowed browser origin, comma-separated for
#                          multiple (default: * — fine for same-origin
#                          setups; tighten this if you serve the frontend
#                          from a different origin)
#   --skip-docker          Do not install/start Docker; assume PostgreSQL
#                          and Redis are already running and reachable via
#                          DATABASE_URL / REDIS_URL you set manually later
#   --yes                  Non-interactive mode (accept all defaults)
#   -h, --help              Show this help text
#
# If the requested port is already in use, the script automatically picks
# the next free port instead of failing (a warning is printed when this
# happens).
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
BLUE="\033[1;34m"; GREEN="\033[1;32m"; YELLOW="\033[1;33m"; RED="\033[1;31m"; NC="\033[0m"
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[FAIL]${NC} $1" >&2; }
die()   { err "$1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

PORT=3000
CORS_ORIGIN="*"
SKIP_DOCKER=0
NONINTERACTIVE=0

# ---------------------------------------------------------------------------
# Argument parsing (also accepts the old --backend-port/--frontend-port
# flags for anyone with muscle memory from the previous two-service setup —
# --frontend-port is now a no-op since there's only one port.)
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|--backend-port) PORT="$2"; shift 2 ;;
    --frontend-port) warn "--frontend-port is no longer used (single-port mode) — ignoring"; shift 2 ;;
    --cors-origin) CORS_ORIGIN="$2"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --yes) NONINTERACTIVE=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^#//'; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Please run this script as root (sudo ./install.sh)"
[[ -d "$BACKEND_DIR" ]] || die "backend/ not found next to install.sh — run this from the project root"
[[ -d "$FRONTEND_DIR" ]] || die "frontend/ not found next to install.sh — run this from the project root"

# Stop any previously-installed FREE GW services first, so the port-conflict
# check below reflects *other* applications, not our own prior install
# (this makes re-running install.sh after a failed attempt safe/idempotent).
# Also stops the old freegw-frontend service from earlier versions, if present.
for svc in freegw-backend freegw-frontend; do
  systemctl is-active --quiet "$svc" 2>/dev/null && systemctl stop "$svc" 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# Port availability check — auto-pick the next free port on conflict
# ---------------------------------------------------------------------------
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[.:]${port}\$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[.:]${port}\$"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null && { exec 3<&- 3>&-; return 0; } || return 1
  fi
}

find_free_port() {
  local port="$1"
  local original="$port"
  while port_in_use "$port"; do
    port=$((port + 1))
  done
  if [[ "$port" != "$original" ]]; then
    warn "Port ${original} is already in use — using ${port} instead" >&2
  fi
  echo "$port"
}

PORT="$(find_free_port "$PORT")"

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -z "$SERVER_IP" ]] && SERVER_IP="127.0.0.1"

info "Installing FREE GW"
info "  Port         : $PORT  (serves both the dashboard and the API)"
info "  CORS origin  : $CORS_ORIGIN"
info "  Docker mode  : $([[ $SKIP_DOCKER -eq 1 ]] && echo 'skipped (manual DB/Redis)' || echo 'enabled')"
echo

if [[ $NONINTERACTIVE -eq 0 ]]; then
  read -rp "Continue with these settings? [Y/n] " CONFIRM
  CONFIRM=${CONFIRM:-Y}
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || die "Aborted by user"
fi

# ---------------------------------------------------------------------------
# Detect package manager
# ---------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  PKG_MANAGER="apt"
elif command -v yum >/dev/null 2>&1; then
  PKG_MANAGER="yum"
elif command -v dnf >/dev/null 2>&1; then
  PKG_MANAGER="dnf"
else
  die "No supported package manager found (expected apt, yum, or dnf)"
fi
info "Detected package manager: $PKG_MANAGER"

pkg_install() {
  case "$PKG_MANAGER" in
    apt) apt-get install -y "$@" ;;
    yum) yum install -y "$@" ;;
    dnf) dnf install -y "$@" ;;
  esac
}

# ---------------------------------------------------------------------------
# 1. Node.js 20.x
# ---------------------------------------------------------------------------
install_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$NODE_MAJOR" -ge 20 ]]; then
      ok "Node.js $(node -v) already installed"
      return
    fi
    warn "Node.js $(node -v) is too old (Baileys requires Node.js >=20); upgrading"
  fi

  info "Installing Node.js 20.x..."
  case "$PKG_MANAGER" in
    apt)
      apt-get update -y
      pkg_install curl ca-certificates gnupg
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      pkg_install nodejs
      ;;
    yum|dnf)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      pkg_install nodejs
      ;;
  esac

  hash -r
  command -v node >/dev/null 2>&1 || die "Node.js installation failed"
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  [[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js is still $(node -v) after install attempt — upgrade manually and re-run this script"
  ok "Node.js $(node -v) installed"
}

# ---------------------------------------------------------------------------
# 2. Docker + Compose plugin (for PostgreSQL + Redis)
# ---------------------------------------------------------------------------
install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker + Compose plugin already installed"
    return
  fi
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  command -v docker >/dev/null 2>&1 || die "Docker installation failed"
  ok "Docker installed"
}

install_node

if [[ $SKIP_DOCKER -eq 0 ]]; then
  install_docker

  # Docker credentials live in a root-level .env next to docker-compose.yml
  # (compose reads it automatically). Never hardcode the password here.
  COMPOSE_ENV_FILE="$SCRIPT_DIR/.env"
  if [[ ! -f "$COMPOSE_ENV_FILE" ]]; then
    # Reinstall case: reuse the password already in backend/.env so an
    # existing data volume keeps matching. Fresh install: random password.
    PG_PASSWORD="$(sed -nE 's#^postgres://[^:]+:([^@]+)@.*#\1#p' "$BACKEND_DIR/.env" 2>/dev/null | tail -1)"
    [[ -n "$PG_PASSWORD" ]] || PG_PASSWORD="$(openssl rand -hex 16)"
    OLD_UMASK="$(umask)"
    umask 077
    cat > "$COMPOSE_ENV_FILE" <<EOF
POSTGRES_USER=freegw
POSTGRES_PASSWORD=${PG_PASSWORD}
POSTGRES_DB=freegw_gateway
EOF
    umask "$OLD_UMASK"
    ok "Generated $COMPOSE_ENV_FILE with a Postgres password (mode 600)"
  fi
  # shellcheck disable=SC1090
  . "$COMPOSE_ENV_FILE"
  PG_USER="${POSTGRES_USER:-freegw}"
  PG_DB="${POSTGRES_DB:-freegw_gateway}"

  info "Starting PostgreSQL + Redis containers..."
  (cd "$SCRIPT_DIR" && docker compose up -d)

  info "Waiting for PostgreSQL to become healthy..."
  for i in $(seq 1 30); do
    if docker exec freegw_postgres pg_isready -U "$PG_USER" >/dev/null 2>&1; then
      ok "PostgreSQL is ready"
      break
    fi
    sleep 2
    [[ $i -eq 30 ]] && die "PostgreSQL did not become ready in time"
  done
  DATABASE_URL="postgres://${PG_USER}:${POSTGRES_PASSWORD:?Missing POSTGRES_PASSWORD in $COMPOSE_ENV_FILE}@localhost:5432/${PG_DB}"
  REDIS_URL="redis://localhost:6379"
else
  warn "Skipping Docker setup. Make sure DATABASE_URL and REDIS_URL in backend/.env point to a reachable PostgreSQL and Redis instance before continuing."
  DATABASE_URL="${DATABASE_URL:-postgres://freegw:freegw@localhost:5432/freegw_gateway}"
  REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
fi

# ---------------------------------------------------------------------------
# 3. Backend: .env, npm install, build, migrate
# ---------------------------------------------------------------------------
info "Configuring backend/.env"
ENV_FILE="$BACKEND_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  ok ".env already exists — keeping existing MASTER_KEY/DATABASE_URL/REDIS_URL"
else
  cp "$BACKEND_DIR/.env.example" "$ENV_FILE"
  MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

  sed -i "s#^NODE_ENV=.*#NODE_ENV=production#" "$ENV_FILE"
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=${DATABASE_URL}#" "$ENV_FILE"
  sed -i "s#^REDIS_URL=.*#REDIS_URL=${REDIS_URL}#" "$ENV_FILE"
  sed -i "s#^MASTER_KEY=.*#MASTER_KEY=${MASTER_KEY}#" "$ENV_FILE"

  ok "Generated backend/.env with a fresh MASTER_KEY"
fi

# Always reflect the port/origin used on THIS run, even on a re-install.
sed -i "s#^PORT=.*#PORT=${PORT}#" "$ENV_FILE"
sed -i "s#^CORS_ORIGIN=.*#CORS_ORIGIN=${CORS_ORIGIN}#" "$ENV_FILE"
ok "Synced PORT=${PORT} and CORS_ORIGIN=${CORS_ORIGIN} into .env"

info "Installing backend dependencies (npm install)..."
NODE_MARKER="$BACKEND_DIR/node_modules/.freegw-node-version"
CURRENT_NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [[ -d "$BACKEND_DIR/node_modules" ]]; then
  PREV_NODE_MAJOR="$(cat "$NODE_MARKER" 2>/dev/null || echo "")"
  if [[ "$PREV_NODE_MAJOR" != "$CURRENT_NODE_MAJOR" ]]; then
    warn "Node.js version changed (was: ${PREV_NODE_MAJOR:-unknown}, now: ${CURRENT_NODE_MAJOR}) — removing node_modules to avoid stale native-addon builds..."
    rm -rf "$BACKEND_DIR/node_modules"
  fi
fi
(cd "$BACKEND_DIR" && npm install --no-audit --no-fund)
mkdir -p "$BACKEND_DIR/node_modules" && echo "$CURRENT_NODE_MAJOR" > "$NODE_MARKER"

info "Building backend (TypeScript -> dist/)..."
(cd "$BACKEND_DIR" && npm run build)

info "Running database migration..."
(cd "$BACKEND_DIR" && npm run migrate)
ok "Database schema is up to date"

# Leave config.js at its repo default (null) — the dashboard now defaults
# to same-origin automatically since the backend serves it directly, which
# works correctly through any domain, IP, or tunnel with zero config.
if [[ -f "$FRONTEND_DIR/assets/js/config.js" ]]; then
  cat > "$FRONTEND_DIR/assets/js/config.js" <<'EOF'
// Left at its default (null) on purpose: the backend now serves this
// frontend directly (same origin, same port), so the dashboard's own JS
// defaults to same-origin automatically — this works correctly whether you
// access it via LAN IP, a custom domain, or a tunnel (Cloudflare Tunnel,
// ngrok, etc.), with no Base URL to configure.
window.FREEGW_DEFAULT_API_BASE = null;
EOF
fi

# ---------------------------------------------------------------------------
# 4. systemd service: single backend process (serves dashboard + API)
# ---------------------------------------------------------------------------
info "Registering systemd service: freegw-backend"
cat > /etc/systemd/system/freegw-backend.service <<EOF
[Unit]
Description=FREE GW - Backend API + Dashboard
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=${BACKEND_DIR}
EnvironmentFile=${BACKEND_DIR}/.env
ExecStart=$(command -v node) ${BACKEND_DIR}/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=freegw-backend

[Install]
WantedBy=multi-user.target
EOF

# Remove the old separate frontend service, if this is an upgrade from a
# previous two-service install — everything is served by freegw-backend now.
if systemctl list-unit-files | grep -q "^freegw-frontend.service"; then
  info "Removing obsolete freegw-frontend service (dashboard is now served by freegw-backend)..."
  systemctl disable freegw-frontend 2>/dev/null || true
  rm -f /etc/systemd/system/freegw-frontend.service
fi

# ---------------------------------------------------------------------------
# 5. Firewall — open the port we just registered, if a firewall manager
# is active. This is the #1 cause of ERR_CONNECTION_TIMED_OUT when the
# service is running fine but unreachable from another machine.
# ---------------------------------------------------------------------------
configure_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    info "UFW firewall is active — opening port ${PORT}/tcp"
    ufw allow "${PORT}/tcp" >/dev/null
    ok "UFW rule added for port ${PORT}"
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    info "firewalld is active — opening port ${PORT}/tcp"
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null 2>&1 || warn "firewall-cmd --reload failed (continuing anyway)"
    ok "firewalld rule added for port ${PORT}"
  else
    warn "No active local firewall (ufw/firewalld) detected. If the dashboard is still unreachable from other machines, check your router / cloud security group / hypervisor firewall for port ${PORT}."
  fi
}
configure_firewall
echo "BACKEND_PORT=${PORT}" > "$SCRIPT_DIR/.freegw-install-state"

systemctl daemon-reload || warn "systemctl daemon-reload failed (continuing anyway)"
systemctl enable --now freegw-backend

sleep 2
if systemctl is-active --quiet freegw-backend; then
  ok "freegw-backend is running"
else
  err "freegw-backend failed to start — check: journalctl -u freegw-backend -n 50"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo
echo -e "${GREEN}=====================================================${NC}"
echo -e "${GREEN} FREE GW installed successfully!${NC}"
echo -e "${GREEN}=====================================================${NC}"
echo
echo "  Dashboard + API : http://${SERVER_IP}:${PORT}  (health: /health)"
echo
echo "  Next step: open the URL above. You'll land on a login screen —"
echo "  since this is a fresh install, it will ask you to CREATE a dashboard"
echo "  password (this protects the UI itself, separate from API keys)."
echo "  After logging in, go to Settings and click 'Buat API Key Pertama'"
echo "  to bootstrap your first API key for sending messages."
echo
echo "  Using a tunnel (Cloudflare Tunnel, ngrok, etc.) or reverse proxy?"
echo "  Point it at this single port (${PORT}) — the dashboard will work"
echo "  automatically on whatever domain the tunnel gives you, no Base URL"
echo "  configuration needed."
echo
echo "  Useful commands:"
echo "    systemctl status freegw-backend"
echo "    journalctl -u freegw-backend -f"
echo
if [[ $SKIP_DOCKER -eq 0 ]]; then
  echo "  PostgreSQL/Redis are running as Docker containers (freegw_postgres,"
  echo "  freegw_redis) managed via: docker compose -f ${SCRIPT_DIR}/docker-compose.yml"
  echo
fi
echo "  Remember to open port ${PORT} in your firewall/security group if"
echo "  accessing from outside this server (skip this if you're only using"
echo "  a tunnel, which doesn't need an inbound firewall rule)."
echo
