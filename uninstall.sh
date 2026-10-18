#!/usr/bin/env bash
#
# uninstall.sh — Completely removes FREE GW from a Linux server
#
# By default this is a FULL, CLEAN removal: stops and removes the systemd
# services, closes the firewall ports install.sh opened, deletes the
# PostgreSQL/Redis Docker containers AND their data volumes, and finally
# deletes the entire project folder itself (backend/, frontend/, this
# script, everything) — nothing is left behind.
#
# Usage:
#   sudo ./uninstall.sh [options]
#
# Options:
#   --keep-data    Don't touch Docker volumes (Postgres/Redis data) — just
#                  stop the containers, so a later install.sh run can pick
#                  up where you left off (WhatsApp sessions, message logs,
#                  API keys all preserved)
#   --keep-files   Don't delete the project folder itself — only stop
#                  services/containers and (unless --keep-data) wipe data
#   --purge        Deprecated, kept for backward compatibility: full wipe
#                  is now the default, so this flag is a no-op
#   --yes          Non-interactive mode (skip confirmation prompts)
#   -h, --help     Show this help text
#
set -euo pipefail

BLUE="\033[1;34m"; GREEN="\033[1;32m"; YELLOW="\033[1;33m"; RED="\033[1;31m"; NC="\033[0m"
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
die()   { echo -e "${RED}[FAIL]${NC} $1" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
STATE_FILE="$SCRIPT_DIR/.freegw-install-state"

KEEP_DATA=0
KEEP_FILES=0
NONINTERACTIVE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-data) KEEP_DATA=1; shift ;;
    --keep-files) KEEP_FILES=1; shift ;;
    --purge) shift ;; # no-op: full wipe is now the default behavior
    --yes) NONINTERACTIVE=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^#//'; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Please run this script as root (sudo ./uninstall.sh)"

if [[ $NONINTERACTIVE -eq 0 ]]; then
  echo -e "${YELLOW}This will remove FREE GW from this server:${NC}"
  echo "  - Stop & delete systemd services (freegw-backend, freegw-frontend)"
  echo "  - Close the firewall ports install.sh opened"
  if [[ $KEEP_DATA -eq 1 ]]; then
    echo "  - Stop Postgres/Redis containers (data volumes KEPT — you passed --keep-data)"
  else
    echo "  - Delete Postgres/Redis containers AND their data volumes"
    echo "    (ALL WhatsApp sessions, message logs, and API keys will be lost)"
  fi
  if [[ $KEEP_FILES -eq 1 ]]; then
    echo "  - Project folder KEPT at: $SCRIPT_DIR (you passed --keep-files)"
  else
    echo "  - Delete the entire project folder: $SCRIPT_DIR"
  fi
  echo
  read -rp "Type 'yes' to confirm: " CONFIRM
  [[ "$CONFIRM" == "yes" ]] || die "Aborted by user"
fi

# ---------------------------------------------------------------------------
# 0. Figure out which ports were actually used, so we close the right
#    firewall rules. Prefer the state file written by install.sh; fall back
#    to parsing the still-installed systemd units / .env if it's missing.
# ---------------------------------------------------------------------------
BACKEND_PORT=""
FRONTEND_PORT=""

if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
fi

if [[ -z "$BACKEND_PORT" && -f "$BACKEND_DIR/.env" ]]; then
  BACKEND_PORT="$(grep -E '^PORT=' "$BACKEND_DIR/.env" | tail -1 | cut -d= -f2)"
fi
if [[ -z "$FRONTEND_PORT" && -f /etc/systemd/system/freegw-frontend.service ]]; then
  FRONTEND_PORT="$(grep -oP '(?<=-l )\d+' /etc/systemd/system/freegw-frontend.service || true)"
fi

[[ -n "$BACKEND_PORT" ]] && info "Detected backend port: ${BACKEND_PORT}"
[[ -n "$FRONTEND_PORT" ]] && info "Detected frontend port: ${FRONTEND_PORT}"

# ---------------------------------------------------------------------------
# 1. Stop & remove systemd services
# ---------------------------------------------------------------------------
for svc in freegw-backend freegw-frontend; do
  if systemctl list-unit-files | grep -q "^${svc}.service"; then
    info "Stopping and disabling ${svc}..."
    systemctl stop "$svc" 2>/dev/null || true
    systemctl disable "$svc" 2>/dev/null || true
    rm -f "/etc/systemd/system/${svc}.service"
    ok "${svc} removed"
  else
    warn "${svc}.service not found, skipping"
  fi
done
systemctl daemon-reload || warn "systemctl daemon-reload failed (continuing anyway)"
systemctl reset-failed 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Firewall — close the ports install.sh opened
# ---------------------------------------------------------------------------
FIREWALLD_TOUCHED=0

close_firewall_port() {
  local port="$1"
  [[ -z "$port" ]] && return
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw delete allow "${port}/tcp" >/dev/null 2>&1 || true
    ok "Closed UFW rule for port ${port}/tcp"
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --permanent --remove-port="${port}/tcp" >/dev/null 2>&1 || true
    FIREWALLD_TOUCHED=1
    ok "Closed firewalld rule for port ${port}/tcp"
  fi
}

info "Closing firewall ports opened by install.sh..."
close_firewall_port "$BACKEND_PORT"
close_firewall_port "$FRONTEND_PORT"
if [[ "$FIREWALLD_TOUCHED" -eq 1 ]]; then
  firewall-cmd --reload >/dev/null 2>&1 || warn "firewall-cmd --reload failed (continuing anyway)"
fi
if [[ -z "$BACKEND_PORT" && -z "$FRONTEND_PORT" ]]; then
  warn "Could not determine which ports to close (no state file, .env, or systemd unit found). If you opened ports manually, close them yourself, e.g.: sudo ufw delete allow <port>/tcp"
fi

# ---------------------------------------------------------------------------
# 3. Docker containers (PostgreSQL + Redis)
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/docker-compose.yml" ]]; then
  if [[ $KEEP_DATA -eq 1 ]]; then
    info "Stopping containers (data volumes preserved, --keep-data set)..."
    (cd "$SCRIPT_DIR" && docker compose stop) || warn "docker compose stop failed (containers may already be gone)"
    ok "Containers stopped. Data preserved — run 'docker compose up -d' to resume, or re-run install.sh."
  else
    info "Stopping containers and deleting volumes (Postgres + Redis data)..."
    (cd "$SCRIPT_DIR" && docker compose down -v) || warn "docker compose down -v failed (containers may already be gone)"
    ok "Containers and volumes removed"
  fi
else
  warn "Docker or docker-compose.yml not found, skipping container cleanup"
fi

# ---------------------------------------------------------------------------
# 4. Backend build artifacts / env / install state (unless --keep-data)
# ---------------------------------------------------------------------------
if [[ $KEEP_DATA -eq 0 ]]; then
  info "Removing backend build artifacts and configuration..."
  rm -rf "${BACKEND_DIR}/node_modules" "${BACKEND_DIR}/dist" "${BACKEND_DIR}/.env"
  rm -f "$STATE_FILE"
  ok "Backend artifacts, .env, and install state removed"
fi

# ---------------------------------------------------------------------------
# 5. Project folder itself (unless --keep-files)
# ---------------------------------------------------------------------------
if [[ $KEEP_FILES -eq 0 ]]; then
  echo
  echo -e "${GREEN}=====================================================${NC}"
  echo -e "${GREEN} FREE GW fully removed.${NC}"
  if [[ $KEEP_DATA -eq 1 ]]; then
    echo " Services, containers, and firewall rules were cleaned up."
    echo " Database/session data was preserved (--keep-data)."
  else
    echo " Services, containers, volumes, firewall rules, and all"
    echo " generated data have been cleaned up."
  fi
  echo " Deleting project folder: $SCRIPT_DIR"
  echo -e "${GREEN}=====================================================${NC}"
  echo
  # Move out of the directory we're about to delete (including this very
  # script) — this is safe on Linux: the running script's inode stays open
  # until the process exits, even after its directory entry is removed.
  cd /
  rm -rf "$SCRIPT_DIR"
  exit 0
fi

echo
echo -e "${GREEN}=====================================================${NC}"
echo -e "${GREEN} FREE GW fully removed (project folder kept).${NC}"
if [[ $KEEP_DATA -eq 1 ]]; then
  echo " Services, containers, and firewall rules were cleaned up."
  echo " Database/session data was preserved (--keep-data)."
  echo " Re-run install.sh from $SCRIPT_DIR to bring it back up."
else
  echo " Services, containers, volumes, firewall rules, and all"
  echo " generated data have been cleaned up."
  echo " Project files remain at $SCRIPT_DIR — re-run install.sh"
  echo " there for a fresh install, or delete the folder manually."
fi
echo -e "${GREEN}=====================================================${NC}"
echo
