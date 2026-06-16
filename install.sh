#!/bin/sh
# Loom one-line installer — macOS / Linux / WSL.
#
#   curl -fsSL https://loom.example/install.sh | sh
#
# HOSTING the script on a trusted HTTPS domain is an OWNER action (see the README "One-line install"
# section). Until that domain exists, this file is a repo artifact — run it from a local checkout:
#
#   sh install.sh                 # interactive (prompts before registering autostart)
#   sh install.sh --service       # also register autostart, non-interactively
#   sh install.sh --no-start      # install only; don't launch the daemon
#
# What it does (IDEMPOTENT — safe to re-run; `npm i -g` upgrades in place):
#   1. Ensure Node 22+ is on PATH. It DETECTS Node and, if missing/too old, prints a guide and exits
#      (it does NOT download or bundle a pinned Node — that is a deferred future enhancement).
#   2. `npm i -g loomctl` — installs/upgrades the `loom` command.
#   3. Optionally `loom service install` — register autostart (prompted, or via --service / env).
#   4. Start Loom in the background and open the cockpit (unless --no-start).
#
# Flags (also settable via env for the piped `curl | sh` path, which has no TTY to prompt on):
#   --service / --no-service   LOOM_INSTALL_SERVICE=1|0   register autostart (default: ask if a TTY)
#   --no-start                 LOOM_INSTALL_START=0       skip launching the daemon
#   --source <spec>            LOOM_INSTALL_SOURCE=<spec> npm spec to install (default: loomctl;
#                                                         used for verifying a local .tgz)
#   --port <n>                 LOOM_PORT=<n>              port (default 4317)

set -eu
# pipefail is not POSIX (dash lacks it) but bash/zsh/busybox-sh support it. Enable it best-effort so a
# failure in `… | …` still aborts, without breaking under a strict POSIX sh.
# shellcheck disable=SC3040
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

NODE_MIN_MAJOR=22
PORT="${LOOM_PORT:-4317}"
SOURCE="${LOOM_INSTALL_SOURCE:-loomctl}"
WANT_SERVICE=ask   # ask | yes | no
WANT_START=yes

# --- helpers ---------------------------------------------------------------------------------------
info()  { printf '\033[36m[loom]\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m[loom]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[loom]\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[31m[loom] error:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Loom installer (macOS / Linux / WSL)

Usage: sh install.sh [options]

Options:
  --service        Register autostart (loom service install), non-interactively
  --no-service     Do not register autostart
  --no-start       Install only; do not launch the daemon
  --source <spec>  npm install spec (default: loomctl; e.g. a local ./loomctl-X.Y.Z.tgz)
  --port <n>       Port to use (default 4317; or env LOOM_PORT)
  -h, --help       Show this help and exit

Env equivalents (for `curl … | sh`, which cannot prompt):
  LOOM_INSTALL_SERVICE=1|0   LOOM_INSTALL_START=0   LOOM_INSTALL_SOURCE=<spec>   LOOM_PORT=<n>
EOF
}

# Major version of the `node` on PATH, or empty if node is absent / unparseable.
node_major() {
  command -v node >/dev/null 2>&1 || return 0
  v=$(node --version 2>/dev/null) || return 0   # e.g. v22.16.0
  v=${v#v}                                       # strip leading "v"
  printf '%s' "${v%%.*}"                          # major component
}

guide_install_node() {
  warn "Loom needs Node ${NODE_MIN_MAJOR}+ (with npm). $1"
  cat >&2 <<EOF

Install Node ${NODE_MIN_MAJOR}+ with one of:
  • nvm      : https://github.com/nvm-sh/nvm  →  nvm install ${NODE_MIN_MAJOR}
  • fnm      : https://github.com/Schniz/fnm  →  fnm install ${NODE_MIN_MAJOR}
  • Official : https://nodejs.org/  (download the current LTS)
  • Homebrew (macOS): brew install node@${NODE_MIN_MAJOR}
  • Debian/Ubuntu  : https://github.com/nodesource/distributions

Then re-run this installer.
EOF
  exit 1
}

# --- parse env + args ------------------------------------------------------------------------------
case "${LOOM_INSTALL_SERVICE:-}" in
  1|yes|true)  WANT_SERVICE=yes ;;
  0|no|false)  WANT_SERVICE=no ;;
esac
case "${LOOM_INSTALL_START:-}" in
  0|no|false)  WANT_START=no ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --service)     WANT_SERVICE=yes ;;
    --no-service)  WANT_SERVICE=no ;;
    --no-start)    WANT_START=no ;;
    --source)      shift; [ $# -gt 0 ] || die "--source needs a value"; SOURCE="$1" ;;
    --source=*)    SOURCE="${1#--source=}" ;;
    --port)        shift; [ $# -gt 0 ] || die "--port needs a value"; PORT="$1" ;;
    --port=*)      PORT="${1#--port=}" ;;
    -h|--help)     usage; exit 0 ;;
    *)             warn "unknown option '$1'"; usage; exit 2 ;;
  esac
  shift
done

# Validate port (1-65535).
case "$PORT" in
  ''|*[!0-9]*) die "invalid port '$PORT' (expected 1-65535)" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "invalid port '$PORT' (expected 1-65535)"
export LOOM_PORT="$PORT"   # loom + `loom service install` read this for the bound port

URL="http://127.0.0.1:${PORT}"

# --- 1. ensure Node 22+ ----------------------------------------------------------------------------
info "Checking for Node ${NODE_MIN_MAJOR}+ …"
major=$(node_major)
if [ -z "$major" ]; then
  guide_install_node "Node was not found on your PATH."
elif [ "$major" -lt "$NODE_MIN_MAJOR" ]; then
  guide_install_node "Found Node $(node --version) — too old."
fi
command -v npm >/dev/null 2>&1 || guide_install_node "Found Node $(node --version) but no npm alongside it."
ok "Node $(node --version) with npm $(npm --version) — good."

# --- 2. install / upgrade loomctl ------------------------------------------------------------------
info "Installing the Loom CLI (npm i -g ${SOURCE}) …"
if ! npm i -g "$SOURCE"; then
  warn "Global install failed. On some systems npm's global prefix needs elevated permissions."
  die "Re-run with sudo (sudo sh install.sh), or set a user-writable npm prefix (npm config set prefix ~/.npm-global)."
fi

# Resolve the `loom` command (the global bin should already be on PATH).
if command -v loom >/dev/null 2>&1; then
  LOOM=loom
else
  warn "'loom' is not on your PATH yet — falling back to 'npx loomctl' for this run."
  warn "Add npm's global bin (npm bin -g) to your PATH so 'loom' works in new shells."
  LOOM="npx loomctl"
fi
ok "Installed: $($LOOM --version 2>/dev/null || echo '?') ($SOURCE)"

# --- 3. optional autostart -------------------------------------------------------------------------
if [ "$WANT_SERVICE" = ask ]; then
  if [ -t 0 ]; then
    printf '\033[36m[loom]\033[0m Register Loom to autostart on login? [y/N] '
    read -r answer || answer=""
    case "$answer" in [Yy]*) WANT_SERVICE=yes ;; *) WANT_SERVICE=no ;; esac
  else
    WANT_SERVICE=no
    info "Non-interactive (piped) install — skipping autostart. Add it later with: loom service install"
  fi
fi
if [ "$WANT_SERVICE" = yes ]; then
  info "Registering autostart (loom service install) …"
  if $LOOM service install; then ok "Autostart registered."; else warn "Autostart registration failed — you can retry with 'loom service install'."; fi
fi

# --- 4. start ---------------------------------------------------------------------------------------
started=no
if [ "$WANT_START" = yes ]; then
  info "Starting Loom in the background …"
  # --detach returns once the daemon is answering; it opens the browser itself.
  if $LOOM start --detach; then started=yes; else warn "Could not start the daemon — start it yourself with 'loom'."; fi
else
  info "Skipping launch (--no-start). Start Loom any time with: loom"
fi

# --- final summary ----------------------------------------------------------------------------------
if [ "$started" = yes ]; then
  ok "Loom is running at ${URL}"
else
  ok "Loom installed. Start it with 'loom' — it will run at ${URL}"
fi
info "Commands: loom status | loom stop | loom restart | loom open | loom service status"
