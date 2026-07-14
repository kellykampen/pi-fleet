#!/usr/bin/env bash
# setup.sh — one-copy onboarding for pi-fleet: checks/installs the quick-start dependencies,
# wires local config via bin/pi-fleet-bootstrap (idempotent, never clobbers existing config),
# and guides external-service auth (gh, Linear, pi provider, optional E2B). Safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVIEW_TOOL_DIR="${PI_FLEET_INTERVIEW_TOOL_DIR:-$REPO_DIR/tools/agent-interview-cli}"
INTERVIEW_BIN="$INTERVIEW_TOOL_DIR/node_modules/.bin/interview"
YES=0
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Usage: setup.sh [--check] [--yes] [--help]

  --check   Report dependency/config/auth status only. Makes no changes (no installs, does not
            run bin/pi-fleet-bootstrap). Exits 0 if nothing needs attention, 1 otherwise.
  --yes     Non-interactive: auto-confirm installs for dependencies this script knows how to
            install (git/gh/node via Homebrew, outfitter via npm, repo-local pinned tools via
            `npm ci`, and pi-fleet's global pi packages via `pi install npm:...`). Without --yes
            and without a terminal to prompt on, missing installable deps are reported with the
            exact command to run yourself.
  --help    Show this help and exit 0.

Safe to re-run: every install step is skipped once its dependency is already present, and
bin/pi-fleet-bootstrap backs up (never overwrites) any pre-existing config it would replace.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --yes) YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "setup.sh: unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ISSUES=0
note_issue() { ISSUES=$((ISSUES + 1)); }
have() { command -v "$1" >/dev/null 2>&1; }
have_pinned_interview_cli() {
  [ -x "$INTERVIEW_BIN" ] && [ "$("$INTERVIEW_BIN" --version 2>/dev/null)" = "0.1.0" ]
}

# maybe_install <label> <present_cmd> <install_cmd|""> <guidance>
# present_cmd/install_cmd are eval'd shell snippets (fixed strings we author below, not user
# input). In --check mode, or when no install_cmd is known, this only ever reports status.
maybe_install() {
  local label="$1" present_cmd="$2" install_cmd="$3" guidance="$4"
  if eval "$present_cmd" >/dev/null 2>&1; then
    echo "  [OK]      $label"
    return 0
  fi
  if [ "$CHECK_ONLY" = "1" ] || [ -z "$install_cmd" ]; then
    echo "  [MISSING] $label — $guidance"
    note_issue
    return 0
  fi
  local do_install=0
  if [ "$YES" = "1" ]; then
    do_install=1
  elif [ -t 0 ]; then
    local reply=""
    read -r -p "  $label not found. Install now with: $install_cmd ? [y/N] " reply || reply=""
    case "$reply" in [yY]*) do_install=1 ;; esac
  fi
  if [ "$do_install" = "1" ]; then
    echo "  Installing $label: $install_cmd"
    if eval "$install_cmd"; then
      echo "  [OK]      $label installed"
    else
      echo "  [FAILED]  $label — install command failed; $guidance"
      note_issue
    fi
  else
    echo "  [MISSING] $label — $guidance"
    note_issue
  fi
  return 0
}

echo "pi-fleet setup"
echo "=============="

HAVE_BREW=0
if [ "$(uname -s)" = "Darwin" ] && have brew; then
  HAVE_BREW=1
fi

echo
echo "-- Core CLIs --"
if [ "$HAVE_BREW" = "1" ]; then
  maybe_install "git" "have git" "brew install git" "install via your OS package manager or https://git-scm.com"
  maybe_install "gh (GitHub CLI)" "have gh" "brew install gh" "install from https://cli.github.com"
  maybe_install "node/npm" "have node && have npm" "brew install node" "install from https://nodejs.org"
else
  maybe_install "git" "have git" "" "install via your OS package manager or https://git-scm.com"
  maybe_install "gh (GitHub CLI)" "have gh" "" "install from https://cli.github.com"
  maybe_install "node/npm" "have node && have npm" "" "install from https://nodejs.org"
fi
maybe_install "pi (coding agent)" "have pi" "" "install from https://pi.dev — no automated installer available here"
maybe_install "outfitter" "have outfitter" "npm install -g @ai-outfitter/outfitter" \
  "npm install -g @ai-outfitter/outfitter (needs npm), or see https://pi.dev/packages/@ai-outfitter/outfitter"
maybe_install "linear-cli" "have linear-cli" "" "install from https://github.com/schpet/linear-cli"
maybe_install "cmux" "have cmux" "" "install from https://cmux.io"

echo
echo "-- Repo-local tools --"
maybe_install "agent-interview-cli@0.1.0 (repo-local)" "have_pinned_interview_cli" \
  "npm ci --prefix \"$INTERVIEW_TOOL_DIR\" --omit=dev --ignore-scripts" \
  "run: npm ci --prefix \"$INTERVIEW_TOOL_DIR\" --omit=dev --ignore-scripts"

echo
echo "-- Global pi packages --"
maybe_install "pi-mcp-adapter (pi package)" \
  "have pi && pi list 2>/dev/null | grep -q pi-mcp-adapter" "pi install npm:pi-mcp-adapter" \
  "requires pi to be installed first; then run: pi install npm:pi-mcp-adapter"
maybe_install "pi-subagents (pi package)" \
  "have pi && pi list 2>/dev/null | grep -q pi-subagents" "pi install npm:pi-subagents" \
  "requires pi to be installed first; then run: pi install npm:pi-subagents"
maybe_install "@gotgenes/pi-permission-system (pi package)" \
  "have pi && pi list 2>/dev/null | grep -q pi-permission-system" "pi install npm:@gotgenes/pi-permission-system" \
  "requires pi to be installed first; then run: pi install npm:@gotgenes/pi-permission-system"

echo
echo "-- Optional: E2B remote casts (extensions/e2b) --"
if [ -d "$REPO_DIR/extensions/e2b/node_modules" ]; then
  echo "  [OK]      extensions/e2b npm deps installed"
else
  echo "  [OPTIONAL] extensions/e2b npm deps not installed — run: (cd extensions/e2b && npm install)"
fi
if [ -n "${E2B_API_KEY:-}" ]; then
  echo "  [OK]      E2B_API_KEY is set"
else
  echo "  [OPTIONAL] E2B_API_KEY not set — only needed for E2B remote casts (see docs/e2b-v0.md)"
fi
if [ -n "${FLEET_GITHUB_TOKEN:-}" ]; then
  echo "  [OK]      FLEET_GITHUB_TOKEN is set"
else
  echo "  [OPTIONAL] FLEET_GITHUB_TOKEN not set — only needed for E2B remote casts"
fi

echo
echo "-- pi-fleet config (bin/pi-fleet-bootstrap) --"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [ "$CHECK_ONLY" = "1" ]; then
  for pair in "mcp.json:$REPO_DIR/mcp.json" \
              "agents:$REPO_DIR/agents" \
              "extensions/pi-permission-system/config.json:$REPO_DIR/permission-system/config.json"; do
    link="${pair%%:*}"
    target="${pair#*:}"
    linkpath="$AGENT_DIR/$link"
    if [ -L "$linkpath" ] && [ "$(readlink "$linkpath")" = "$target" ]; then
      echo "  [OK]      $linkpath -> $target"
    else
      echo "  [MISSING] $linkpath — not yet linked to $target (run setup.sh without --check)"
      note_issue
    fi
  done
else
  echo "  Running bin/pi-fleet-bootstrap (idempotent; never overwrites existing config, backs it up instead)..."
  "$REPO_DIR/bin/pi-fleet-bootstrap"
fi

echo
echo "-- External auth --"
if have gh; then
  if gh auth status >/dev/null 2>&1; then
    echo "  [OK]      gh (GitHub CLI) authenticated"
  else
    echo "  [MISSING] gh (GitHub CLI) not authenticated — run: gh auth login"
    note_issue
  fi
else
  echo "  [SKIPPED] gh auth check — gh not installed (see Core CLIs above)"
fi

if have linear-cli; then
  echo "  [INFO]    linear-cli installed — first run will prompt for auth if needed (see https://github.com/schpet/linear-cli)"
else
  echo "  [SKIPPED] linear-cli auth check — linear-cli not installed (see Core CLIs above)"
fi

if have pi; then
  if [ -f "$AGENT_DIR/auth.json" ]; then
    echo "  [OK]      pi has a provider auth file ($AGENT_DIR/auth.json)"
  else
    echo "  [MISSING] pi has no provider authenticated yet — run \`pi\` and complete a provider login (see README Requirements)"
    note_issue
  fi
else
  echo "  [SKIPPED] pi provider auth check — pi not installed (see Core CLIs above)"
fi

echo
echo "-- Summary --"
if [ "$ISSUES" -eq 0 ]; then
  echo "All checks passed. Next steps:"
  echo "  export PATH=\"$REPO_DIR/bin:\$PATH\"   # add the wrappers to PATH (persist in your shell rc)"
  echo "  cd ~/your/project && pi-reviewer      # launch a read-only reviewer seat"
  exit 0
else
  echo "$ISSUES item(s) need attention — see the [MISSING]/[FAILED] lines above for exact remediation."
  echo "Re-run setup.sh (or setup.sh --check) after resolving them."
  exit 1
fi
