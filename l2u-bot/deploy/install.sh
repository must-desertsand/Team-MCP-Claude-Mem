#!/usr/bin/env bash
# Generate and install the launchd agent for l2u-bot.
#
#   ./deploy/install.sh            # install and start
#   ./deploy/install.sh --print    # print the generated plist without installing
#
# Run `pnpm doctor` first. This script does not verify the environment.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.must.l2u-bot"
TEMPLATE="$PROJECT_DIR/deploy/$LABEL.plist.template"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

PNPM_PATH="$(command -v pnpm || true)"
if [[ -z "$PNPM_PATH" ]]; then
  echo "pnpm not found in PATH. Install it first: npm i -g pnpm" >&2
  exit 1
fi

GH_TOKEN_VALUE="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "$GH_TOKEN_VALUE" ]]; then
  echo "Warning: GH_TOKEN is not set." >&2
  echo "  A LaunchAgent inherits no keychain access in some configurations, and a" >&2
  echo "  LaunchDaemon never has it. Set GH_TOKEN before installing if GitHub" >&2
  echo "  lookups must keep working unattended." >&2
fi

rendered="$(sed \
  -e "s|__PNPM_PATH__|$PNPM_PATH|g" \
  -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
  -e "s|__GH_TOKEN__|$GH_TOKEN_VALUE|g" \
  "$TEMPLATE")"

if [[ "${1:-}" == "--print" ]]; then
  echo "$rendered"
  exit 0
fi

mkdir -p "$PROJECT_DIR/logs" "$HOME/Library/LaunchAgents"
chmod 700 "$PROJECT_DIR/logs"
echo "$rendered" > "$TARGET"
chmod 600 "$TARGET"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" || true
fi
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl kickstart -p "gui/$(id -u)/$LABEL"

echo "Installed $TARGET"
echo "Logs:   $PROJECT_DIR/logs/l2u-bot.out.log"
echo "Stop:   launchctl bootout gui/$(id -u)/$LABEL"
echo "Status: launchctl print gui/$(id -u)/$LABEL | head -20"
