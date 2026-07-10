#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${E2B_API_KEY:-}" ]]; then
	echo "E2B_API_KEY is required to publish the pi-fleet E2B template." >&2
	exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_NAME="${1:-${FLEET_E2B_TEMPLATE_NAME:-pi-fleet-node22}}"
READY_CMD='node --version && git --version && gh --version && pi --version && outfitter --version'

e2b template create "$TEMPLATE_NAME" \
	--path "$SCRIPT_DIR" \
	--dockerfile e2b.Dockerfile \
	--ready-cmd "$READY_CMD"

cat <<EOF

If the build succeeded, export the template id/name for project-lead sessions:
  export FLEET_E2B_TEMPLATE=$TEMPLATE_NAME

Record the published template id/name on Linear issue FLT-1 before checking that AC.
EOF
