#!/usr/bin/env bash
# Shared shell runtime paths. Source this file; functions print paths only.
pi_fleet_runtime_root() {
	local root="${PI_FLEET_HOME:-$HOME/.pi-fleet}"
	case "$root" in /*) ;; *)
		echo "PI_FLEET_HOME must be absolute" >&2
		return 2
		;;
	esac
	case "$root" in / | *'/../'* | */.. | *'/./'* | */. | *'//'*)
		echo "PI_FLEET_HOME must be a normalized, non-root path" >&2
		return 2
		;;
	esac
	if [[ -L "$root" ]]; then
		echo "PI_FLEET_HOME must not be a symlink" >&2
		return 2
	fi
	printf '%s\n' "$root"
}
pi_fleet_runtime_path() {
	local root part
	root="$(pi_fleet_runtime_root)" || return
	for part in "$@"; do
		case "$part" in '' | . | .. | /* | */*)
			echo "unsafe runtime path component" >&2
			return 2
			;;
		esac
		root="$root/$part"
	done
	printf '%s\n' "$root"
}
pi_fleet_ensure_runtime_root() {
	local root
	root="$(pi_fleet_runtime_root)" || return
	mkdir -p "$root" && chmod 700 "$root"
}
