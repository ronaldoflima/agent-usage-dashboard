#!/usr/bin/env bash
# install.sh: installs agent-usage-dashboard on Ubuntu/Debian, Arch or macOS and sets up how it runs.
#
#   curl -fsSL https://raw.githubusercontent.com/ronaldoflima/agent-usage-dashboard/main/install.sh | bash
#   ./install.sh --mode service --port 8787 --timezone America/Sao_Paulo
#
# Modes: service (systemd user service on Linux, launchd agent on macOS; starts on login/boot and
#        restarts after in-app updates), launcher (command in ~/.local/bin, run it yourself),
#        foreground (run now in this terminal).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ronaldoflima/agent-usage-dashboard.git}"
SERVICE="agent-usage-dashboard"
LAUNCHD_LABEL="io.github.agent-usage-dashboard"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
LOG_FILE="$HOME/Library/Logs/$SERVICE.log"
OS="$(uname -s)"

MODE=""
PORT="8787"
HOST="127.0.0.1"
TIMEZONE=""
INSTALL_DIR="${INSTALL_DIR:-}"
PYTHON=""
LINGER=0
PACEBAR=0
ASSUME_YES=0
UNINSTALL=0
UPDATE=1

usage() {
  cat <<EOF
Usage: install.sh [options]

  --mode MODE        service | launcher | foreground (asked interactively when omitted;
                     defaults to service without a terminal). service = systemd on Linux,
                     launchd on macOS; 'systemd' and 'launchd' are accepted as aliases.
  --port N           dashboard port (default: 8787)
  --host ADDR        bind address (default: 127.0.0.1)
  --timezone TZ      IANA timezone (default: detected from the system, else UTC)
  --dir PATH         checkout location (default: this checkout, or
                     ~/.local/share/agent-usage-dashboard when piped from curl)
  --linger           Linux: keep the systemd user service running without an active login
  --pacebar          link scripts/pacebar into ~/.local/bin
  --no-update        reuse an existing checkout as is (by default it is fast-forwarded to origin/main)
  -y, --yes          do not ask before installing missing packages
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
    --no-update) UPDATE=0; shift ;;
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

launchd_target() { echo "gui/$(id -u)"; }

uninstall() {
  if [[ "$OS" == Darwin ]]; then
    if [[ -f "$PLIST" ]]; then
      launchctl bootout "$(launchd_target)/$LAUNCHD_LABEL" 2>/dev/null || true
      rm -f "$PLIST"
      info "Removed launchd agent"
    fi
  elif command -v systemctl >/dev/null 2>&1 && [[ -f "$UNIT_DIR/$SERVICE.service" ]]; then
    systemctl --user disable --now "$SERVICE.service" 2>/dev/null || true
    rm -f "$UNIT_DIR/$SERVICE.service"
    systemctl --user daemon-reload || true
    info "Removed systemd user service"
  fi
  rm -f "$BIN_DIR/$SERVICE"
  if [[ -L "$BIN_DIR/pacebar" ]]; then rm -f "$BIN_DIR/pacebar"; fi
  info "Removed launcher. Checkout and .cache/ were kept; delete them manually if you want."
}

if [[ $UNINSTALL -eq 1 ]]; then uninstall; exit 0; fi

detect_platform() {
  local id="" like=""
  if [[ "$OS" == Darwin ]]; then echo macos; return; fi
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

find_python() {
  local candidate
  for candidate in "$(command -v python3 2>/dev/null || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if [[ -n "$candidate" && -x "$candidate" ]] \
      && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
      PYTHON="$candidate"
      return 0
    fi
  done
  return 1
}

brew_bin() {
  command -v brew 2>/dev/null || { [[ -x /opt/homebrew/bin/brew ]] && echo /opt/homebrew/bin/brew; } \
    || { [[ -x /usr/local/bin/brew ]] && echo /usr/local/bin/brew; } || true
}

ensure_packages() {
  local missing=() platform brew
  find_python || missing+=(python3)
  git --version >/dev/null 2>&1 || missing+=(git)
  if [[ ${#missing[@]} -eq 0 ]]; then return; fi

  platform="$(detect_platform)"
  local cmd=()
  case "$platform" in
    debian) cmd=(bash -c "sudo apt-get update && sudo apt-get install -y python3 git") ;;
    arch) cmd=(sudo pacman -S --needed --noconfirm python git) ;;
    macos)
      brew="$(brew_bin)"
      [[ -n "$brew" ]] || die "Missing: ${missing[*]}. Install Homebrew (https://brew.sh) and rerun, or install Python 3.10+ and git yourself."
      cmd=("$brew" install python git) ;;
    *) die "Missing: ${missing[*]} (Python 3.10+ and git required). Install them and rerun." ;;
  esac
  if [[ $ASSUME_YES -eq 0 ]]; then
    [[ "$(ask "Missing ${missing[*]}. Install with: ${cmd[*]} ? [Y/n] " y)" =~ ^[Yy] ]] || die "Aborted."
  fi
  "${cmd[@]}"
  find_python || die "Python 3.10+ is required; found $(python3 --version 2>&1 || echo none)."
}

detect_timezone() {
  local tz=""
  if command -v timedatectl >/dev/null 2>&1; then tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"; fi
  if [[ -z "$tz" && -L /etc/localtime ]]; then tz="$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')"; fi
  if [[ -z "$tz" && -r /etc/timezone ]]; then tz="$(head -n1 /etc/timezone)"; fi
  echo "${tz:-UTC}"
}

update_checkout() {
  local git=(git -C "$INSTALL_DIR") branch before
  branch="$("${git[@]}" branch --show-current 2>/dev/null || true)"
  if [[ "$branch" != main ]]; then
    warn "Checkout is on '${branch:-detached HEAD}', not main; skipping update."
    return
  fi
  if [[ -n "$("${git[@]}" status --porcelain --untracked-files=no)" ]]; then
    warn "Checkout has local changes; skipping update."
    return
  fi
  before="$("${git[@]}" rev-parse --short HEAD)"
  if ! "${git[@]}" fetch --quiet --tags origin || ! "${git[@]}" merge --ff-only --quiet origin/main; then
    warn "Could not fast-forward to origin/main; keeping $before."
    return
  fi
  if [[ "$("${git[@]}" rev-parse --short HEAD)" == "$before" ]]; then
    info "Checkout already up to date ($before)"
  else
    info "Updated checkout: $before -> $("${git[@]}" rev-parse --short HEAD)"
  fi
}

resolve_checkout() {
  local here=""
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || here=""
  if [[ -z "$INSTALL_DIR" && -n "$here" && -f "$here/app.py" && -d "$here/.git" ]]; then
    INSTALL_DIR="$here"
  fi
  INSTALL_DIR="${INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/$SERVICE}"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Using checkout at $INSTALL_DIR"
    if [[ $UPDATE -eq 1 ]]; then update_checkout; fi
  else
    info "Cloning $REPO_URL into $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  fi
}

service_name() { if [[ "$OS" == Darwin ]]; then echo "launchd agent"; else echo "systemd user service"; fi; }

choose_mode() {
  case "$MODE" in systemd|launchd) MODE=service ;; esac
  if [[ -n "$MODE" ]]; then return; fi
  if ! has_tty; then MODE=service; return; fi
  cat >/dev/tty <<EOF

How do you want to run the dashboard?
  1) $(service_name): starts automatically, restarts after in-app updates (recommended)
  2) launcher command only: run '$SERVICE' yourself when you need it
  3) foreground: start it now in this terminal (Ctrl+C to stop)
EOF
  case "$(ask "Choice [1]: " 1)" in
    1|service|systemd|launchd) MODE=service ;;
    2|launcher) MODE=launcher ;;
    3|foreground) MODE=foreground ;;
    *) die "Invalid choice." ;;
  esac
}

server_args() {
  local args=(--host "$HOST" --port "$PORT" --timezone "$TIMEZONE")
  local codex
  codex="$(command -v codex 2>/dev/null || true)"
  if [[ -n "$codex" ]]; then args+=(--codex-bin "$codex"); fi
  printf '%q ' "${args[@]}"
}

install_launcher() {
  mkdir -p "$BIN_DIR"
  cat >"$BIN_DIR/$SERVICE" <<EOF
#!/usr/bin/env bash
exec $(printf '%q' "$PYTHON") $(printf '%q' "$INSTALL_DIR/app.py") $(server_args)"\$@"
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

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

install_launchd() {
  local target path
  target="$(launchd_target)"
  path="$(dirname "$PYTHON"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG_FILE")"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(xml_escape "$BIN_DIR/$SERVICE")</string></array>
  <key>WorkingDirectory</key><string>$(xml_escape "$INSTALL_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$path")</string>
    <key>USAGE_DASHBOARD_SUPERVISED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
EOF
  launchctl bootout "$target/$LAUNCHD_LABEL" 2>/dev/null || true
  local attempt
  for attempt in 1 2 3; do
    launchctl bootstrap "$target" "$PLIST" 2>/dev/null && break
    [[ $attempt -eq 3 ]] && launchctl bootstrap "$target" "$PLIST"
    sleep 1
  done
  launchctl enable "$target/$LAUNCHD_LABEL"
  info "launchd agent loaded: $LAUNCHD_LABEL (starts at login)"
}

ensure_packages
resolve_checkout
TIMEZONE="${TIMEZONE:-$(detect_timezone)}"
choose_mode
install_launcher

URL="http://$HOST:$PORT"
case "$MODE" in
  service)
    if [[ "$OS" == Darwin ]]; then
      install_launchd
      cat <<EOF

Dashboard: $URL  (open it and click "Sync now" to populate data)
  status   launchctl print $(launchd_target)/$LAUNCHD_LABEL | head -20
  logs     tail -f $LOG_FILE
  restart  launchctl kickstart -k $(launchd_target)/$LAUNCHD_LABEL
  remove   $INSTALL_DIR/install.sh --uninstall
EOF
    else
      install_systemd
      cat <<EOF

Dashboard: $URL  (open it and click "Sync now" to populate data)
  status   systemctl --user status $SERVICE
  logs     journalctl --user -u $SERVICE -f
  restart  systemctl --user restart $SERVICE
  remove   $INSTALL_DIR/install.sh --uninstall
EOF
    fi
    ;;
  launcher)
    cat <<EOF

Run '$SERVICE' and open $URL (extra flags are passed to app.py, e.g. '$SERVICE --port 8788').
Background without a service: nohup $SERVICE >/dev/null 2>&1 &
EOF
    ;;
  foreground)
    info "Starting on $URL (Ctrl+C to stop)"
    exec "$BIN_DIR/$SERVICE"
    ;;
  *) die "Unknown mode: $MODE (use service, launcher or foreground)" ;;
esac
