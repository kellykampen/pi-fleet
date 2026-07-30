#!/usr/bin/env bash
# Shared argv helpers for pi-fleet wrappers (FLT-67 always-YOLO hardening).
#
# Outfitter/Pi resolve repeated flags last-wins. Callers must not be able to
# widen or disable the wrapper's security boundary via passthrough "$@".
# Source this file, call pi_sanitize_passthrough_args "$@", then expand:
#   ${PI_PASSTHROUGH_ARGS[@]+"${PI_PASSTHROUGH_ARGS[@]}"}

pi_sanitize_passthrough_args() {
  PI_PASSTHROUGH_ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --approve|--no-extensions)
        shift
        ;;
      --tools|--extension)
        shift
        if [ "$#" -gt 0 ] && [[ "$1" != -* ]]; then
          shift
        fi
        ;;
      --tools=*|--extension=*)
        shift
        ;;
      *)
        PI_PASSTHROUGH_ARGS+=("$1")
        shift
        ;;
    esac
  done
  return 0
}
