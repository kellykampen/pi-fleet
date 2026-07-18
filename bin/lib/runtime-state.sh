#!/usr/bin/env bash
# Shared shell runtime paths. Source this file; functions print paths only.

# Validate every existing component of one normalized absolute path without following symlinks.
pi_fleet_assert_no_symlink_path() {
	local path="$1" boundary="${2:-$1}"
	python3 - "$path" "$boundary" <<'PY'
import os, stat, sys
path, boundary = sys.argv[1:]
if not os.path.isabs(path) or path == os.path.sep or os.path.normpath(path) != path or "//" in path:
    raise SystemExit("runtime path must be normalized, absolute, and non-root")
if not os.path.isabs(boundary) or os.path.normpath(boundary) != boundary or "//" in boundary:
    raise SystemExit("runtime boundary must be normalized and absolute")
if os.path.commonpath((path, boundary)) != boundary:
    raise SystemExit("runtime path escapes validation boundary")
current = boundary
components = [""] + os.path.relpath(path, boundary).split(os.path.sep)
for component in components:
    if component not in ("", "."):
        current = os.path.join(current, component)
    try:
        mode = os.lstat(current).st_mode
    except FileNotFoundError:
        continue
    if stat.S_ISLNK(mode):
        raise SystemExit(f"runtime path contains a symlink: {current}")
PY
}

pi_fleet_runtime_root() {
	local root="${PI_FLEET_HOME:-$HOME/.pi-fleet}"
	case "$root" in /*) ;; *)
		echo "PI_FLEET_HOME must be absolute" >&2
		return 2
		;;
	esac
	case "$root" in / | *'/../'* | */.. | *'/./'* | */. | *'//'* )
		echo "PI_FLEET_HOME must be a normalized, non-root path" >&2
		return 2
		;;
	esac
	# Resolve configured ancestry once so later retargeting of an ancestor symlink cannot redirect writes.
	root="$(python3 - "$root" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)" || return 2
	[[ "$root" != / ]] || { echo "PI_FLEET_HOME must resolve below the filesystem root" >&2; return 2; }
	pi_fleet_assert_no_symlink_path "$root" || return 2
	printf '%s\n' "$root"
}

pi_fleet_runtime_path() {
	local root boundary part
	root="$(pi_fleet_runtime_root)" || return
	boundary="$root"
	for part in "$@"; do
		case "$part" in '' | . | .. | /* | */*)
			echo "unsafe runtime path component" >&2
			return 2
			;;
		esac
		root="$root/$part"
	done
	pi_fleet_assert_no_symlink_path "$root" "$boundary" || return 2
	printf '%s\n' "$root"
}

pi_fleet_ensure_runtime_root() {
	local root
	root="$(pi_fleet_runtime_root)" || return
	mkdir -p "$root"
	pi_fleet_assert_no_symlink_path "$root"
	chmod 700 "$root"
}
