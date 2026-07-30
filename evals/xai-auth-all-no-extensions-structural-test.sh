#!/usr/bin/env bash
# Structural: every fleet seat that passes --no-extensions re-includes pi-xai-oauth
# so --provider xai-auth works for Grok casts under the GPT usage guard.
#
# FLT-70: also covers pi-provider-kimi-code (kimi-coding / k3). Prefer the broader
# evals/provider-packages-all-no-extensions-structural-test.sh for both packages;
# this script remains as the xai-focused entrypoint and still asserts kimi wiring.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/evals/provider-packages-all-no-extensions-structural-test.sh"
