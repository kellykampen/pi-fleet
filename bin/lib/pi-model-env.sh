#!/usr/bin/env bash
# Shared model/provider env override support for pi-fleet wrappers.
# Precedence, highest first:
#   1. Explicit CLI flags passed to the wrapper (--provider/--model or --provider=.../--model=...)
#   2. Role-specific env: PI_<ROLE>_PROVIDER / PI_<ROLE>_MODEL (hyphens become underscores)
#   3. Optional role aliases supplied by the wrapper, e.g. PI_LEAD_MODEL
#   4. Generic env: PI_PROVIDER / PI_MODEL
# If neither env nor CLI supplies a value, outfitter uses the documented profile default.

pi_arg_present() {
  local flag="$1" arg
  shift
  for arg in "$@"; do
    case "$arg" in
      "$flag"|"$flag="*) return 0 ;;
    esac
  done
  return 1
}

pi_env_key_part() {
  printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'
}

pi_first_env_value() {
  local key
  for key in "$@"; do
    if [ -n "${!key-}" ]; then
      printf '%s' "${!key}"
      return 0
    fi
  done
  return 1
}

pi_model_override_args() {
  local role="$1" aliases="${2:-}" role_key alias alias_key provider="" model=""
  shift 2 || true

  role_key="$(pi_env_key_part "$role")"

  if ! pi_arg_present --provider "$@"; then
    provider="$(pi_first_env_value "PI_${role_key}_PROVIDER" || true)"
    if [ -z "$provider" ] && [ -n "$aliases" ]; then
      for alias in $aliases; do
        alias_key="$(pi_env_key_part "$alias")"
        provider="$(pi_first_env_value "PI_${alias_key}_PROVIDER" || true)"
        [ -n "$provider" ] && break
      done
    fi
    [ -n "$provider" ] || provider="$(pi_first_env_value PI_PROVIDER || true)"
  fi

  if ! pi_arg_present --model "$@"; then
    model="$(pi_first_env_value "PI_${role_key}_MODEL" || true)"
    if [ -z "$model" ] && [ -n "$aliases" ]; then
      for alias in $aliases; do
        alias_key="$(pi_env_key_part "$alias")"
        model="$(pi_first_env_value "PI_${alias_key}_MODEL" || true)"
        [ -n "$model" ] && break
      done
    fi
    [ -n "$model" ] || model="$(pi_first_env_value PI_MODEL || true)"
  fi

  if [ -n "$provider" ]; then printf -- '--provider %s' "$provider"; fi
  if [ -n "$model" ]; then
    [ -n "$provider" ] && printf ' '
    printf -- '--model %s' "$model"
  fi
}
