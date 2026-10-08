#!/usr/bin/env bash
# install.sh: installs agent-usage-dashboard on Ubuntu/Debian or Arch and sets up how it runs.
#
#   curl -fsSL https://raw.githubusercontent.com/ronaldoflima/agent-usage-dashboard/main/install.sh | bash
#   ./install.sh --mode systemd --port 8787 --timezone America/Sao_Paulo
#
# Modes: systemd (user service, starts on login/boot, needed for in-app update+restart),
#        launcher (command in ~/.local/bin, run it yourself), foreground (run now in this terminal).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ronaldoflima/agent-usage-dashboard.git}"
SERVICE="agent-usage-dashboard"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

MODE=""
PORT="8787"
HOST="127.0.0.1"
TIMEZONE=""
INSTALL_DIR="${INSTALL_DIR:-}"
LINGER=0
PACEBAR=0
ASSUME_YES=0
UNINSTALL=0

usage() {
  cat <<EOF
Usage: install.sh [options]

  --mode MODE        systemd | launcher | foreground (asked interactively when omitted;
                     defaults to systemd without a terminal)
  --port N           dashboard port (default: 8787)
  --host ADDR        bind address (default: 127.0.0.1)
  --timezone TZ      IANA timezone (default: detected from the system, else UTC)
  --dir PATH         checkout location (default: this checkout, or
                     ~/.local/share/agent-usage-dashboard when piped from curl)
  --linger           keep the systemd user service running without an active login
  --pacebar          link scripts/pacebar into ~/.local/bin
  -y, --yes          do not ask before installing system packages with sudo
  --uninstall        remove the service and launcher (keeps the checkout and .cache/)
  -h, --help         show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --timezone) TIMEZONE="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --linger) LINGER=1; shift ;;
    --pacebar) PACEBAR=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

has_tty() { [[ -r /dev/tty && -w /dev/tty ]] && { : </dev/tty; } 2>/dev/null; }

ask() {
  local prompt="$1" default="$2" answer
  if ! has_tty; then echo "$default"; return; fi
  read -r -p "$prompt" answer </dev/tty || true
  echo "${answer:-$default}"
}

uninstall() {
  if command -v systemctl >/dev/null 2>&1 && [[ -f "$UNIT_DIR/$SERVICE.service" ]]; then
    systemctl --user disable --now "$SERVICE.service" 2>/dev/null || true
    rm -f "$UNIT_DIR/$SERVICE.service"
    systemctl --user daemon-reload || true
    info "Removed systemd user service"
  fi
  rm -f "$BIN_DIR/$SERVICE"
  [[ -L "$BIN_DIR/pacebar" ]] && rm -f "$BIN_DIR/pacebar"
  info "Removed launcher. Checkout and .cache/ were kept; delete them manually if you want."
}

if [[ $UNINSTALL -eq 1 ]]; then uninstall; exit 0; fi

detect_distro() {
  local id="" like=""
  if [[ -r /etc/os-release ]]; then
    id="$(. /etc/os-release; echo "${ID:-}")"
    like="$(. /etc/os-release; echo "${ID_LIKE:-}")"
  fi
  case " $id $like " in
    *" arch "*) echo arch ;;
    *" debian "*|*" ubuntu "*) echo debian ;;
    *) echo unknown ;;
  esac
}

python_ok() { command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))'; }

ensure_packages() {
  local missing=()
  python_ok || missing+=(python3)
  command -v git >/dev/null 2>&1 || missing+=(git)
  [[ ${#missing[@]} -eq 0 ]] && return

  local distro cmd
  distro="$(detect_distro)"
  case "$distro" in
    debian) cmd=(sudo apt-get install -y python3 git) ;;
    arch) cmd=(sudo pacman -S --needed --noconfirm python git) ;;
    *) die "Missing: ${missing[*]} (Python 3.10+ and git required). Install them and rerun." ;;
  esac
  [[ "$distro" == debian ]] && cmd=(bash -c "sudo apt-get update && ${cmd[*]}")
  if [[ $ASSUME_YES -eq 0 ]]; then
    [[ "$(ask "Missing ${missing[*]}. Install with: ${cmd[*]} ? [Y/n] " y)" =~ ^[Yy] ]] || die "Aborted."
  fi
  "${cmd[@]}"
  python_ok || die "Python 3.10+ is required; found $(python3 --version 2>&1 || echo none)."
}

detect_timezone() {
  local tz=""
  command -v timedatectl >/dev/null 2>&1 && tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  [[ -z "$tz" && -L /etc/localtime ]] && tz="$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')"
  [[ -z "$tz" && -r /etc/timezone ]] && tz="$(head -n1 /etc/timezone)"
  echo "${tz:-UTC}"
}

resolve_checkout() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [[ -z "$INSTALL_DIR" && -n "$here" && -f "$here/app.py" && -d "$here/.git" ]]; then
    INSTALL_DIR="$here"
  fi
  INSTALL_DIR="${INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/$SERVICE}"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Using checkout at $INSTALL_DIR"
  else
    info "Cloning $REPO_URL into $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  fi
}

choose_mode() {
  [[ -n "$MODE" ]] && return
  if ! has_tty; then MODE=systemd; return; fi
  cat >/dev/tty <<EOF

How do you want to run the dashboard?
  1) systemd user service: starts automatically, restarts after in-app updates (recommended)
  2) launcher command only: run '$SERVICE' yourself when you need it
  3) foreground: start it now in this terminal (Ctrl+C to stop)
EOF
  case "$(ask "Choice [1]: " 1)" in
    1|systemd) MODE=systemd ;;
    2|launcher) MODE=launcher ;;
    3|foreground) MODE=foreground ;;
    *) die "Invalid choice." ;;
  esac
}

server_args() {
  local args=(--host "$HOST" --port "$PORT" --timezone "$TIMEZONE")
  local codex
  codex="$(command -v codex 2>/dev/null || true)"
  [[ -n "$codex" ]] && args+=(--codex-bin "$codex")
  printf '%q ' "${args[@]}"
}

install_launcher() {
  mkdir -p "$BIN_DIR"
  cat >"$BIN_DIR/$SERVICE" <<EOF
#!/usr/bin/env bash
exec $(command -v python3) $(printf '%q' "$INSTALL_DIR/app.py") $(server_args)"\$@"
EOF
  chmod +x "$BIN_DIR/$SERVICE"
  info "Launcher: $BIN_DIR/$SERVICE"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not in PATH; add it to your shell profile." ;; esac
  if [[ $PACEBAR -eq 1 ]]; then
    ln -sf "$INSTALL_DIR/scripts/pacebar" "$BIN_DIR/pacebar"
    info "pacebar: $BIN_DIR/pacebar"
  fi
}

install_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found; use --mode launcher."
  systemctl --user show-environment >/dev/null 2>&1 \
    || die "No systemd user session (common over 'su' or in containers). Log in directly or use --mode launcher."
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$SERVICE.service" <<EOF
[Unit]
Description=Claude + Codex usage dashboard
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$BIN_DIR/$SERVICE
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE.service" >/dev/null
  systemctl --user restart "$SERVICE.service"
  info "systemd user service enabled: $SERVICE.service"
  if [[ $LINGER -eq 1 ]]; then
    loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"
    info "Linger enabled: the service keeps running after logout and starts at boot"
  elif [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != yes ]]; then
    warn "The service only runs while you are logged in. Rerun with --linger to keep it running on servers."
  fi
}

ensure_packages
resolve_checkout
TIMEZONE="${TIMEZONE:-$(detect_timezone)}"
choose_mode
install_launcher

URL="http://$HOST:$PORT"
case "$MODE" in
  systemd)
    install_systemd
    cat <<EOF

Dashboard: $URL  (open it and click "Sync now" to populate data)
  status   systemctl --user status $SERVICE
  logs     journalctl --user -u $SERVICE -f
  restart  systemctl --user restart $SERVICE
  remove   $INSTALL_DIR/install.sh --uninstall
EOF
    ;;
  launcher)
    cat <<EOF

Run '$SERVICE' and open $URL (extra flags are passed to app.py, e.g. '$SERVICE --port 8788').
Background without systemd: nohup $SERVICE >/dev/null 2>&1 &
EOF
    ;;
  foreground)
    info "Starting on $URL (Ctrl+C to stop)"
    exec "$BIN_DIR/$SERVICE"
    ;;
  *) die "Unknown mode: $MODE (use systemd, launcher or foreground)" ;;
esac
