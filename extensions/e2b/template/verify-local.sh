#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DOCKERFILE="$SCRIPT_DIR/e2b.Dockerfile"
IMAGE_TAG="${FLEET_E2B_LOCAL_IMAGE:-pi-fleet-e2b-template:local}"

if [[ ! -f "$DOCKERFILE" ]]; then
	echo "missing template Dockerfile: $DOCKERFILE" >&2
	exit 1
fi

required_patterns=(
	"setup_22.x"
	"cli.github.com"
	"@earendil-works/pi-coding-agent"
	"@ai-outfitter/outfitter"
)

for pattern in "${required_patterns[@]}"; do
	if ! grep -Fq "$pattern" "$DOCKERFILE"; then
		echo "Dockerfile missing required pattern: $pattern" >&2
		exit 1
	fi
done

if ! command -v docker >/dev/null 2>&1; then
	echo "docker not found; static template checks passed"
	exit 0
fi

if ! docker info >/dev/null 2>&1; then
	echo "docker daemon unavailable; static template checks passed"
	exit 0
fi

docker build -t "$IMAGE_TAG" -f "$DOCKERFILE" "$SCRIPT_DIR"
docker run --rm "$IMAGE_TAG" bash -lc '
  set -euo pipefail
  node --version | grep -E "^v22\."
  git --version
  gh --version
  pi --version
  outfitter --version
'
