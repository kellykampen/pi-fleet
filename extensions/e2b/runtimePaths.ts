import { existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	parse,
	resolve,
	sep,
} from "node:path";

/** Resolve symlinks in the nearest existing ancestor while preserving missing suffixes. */
function canonicalizePath(path: string): string {
	const suffix: string[] = [];
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		suffix.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		current = parent;
	}
	return resolve(realpathSync.native(current), ...suffix);
}

const canonicalRoots = new Map<string, string>();

/** Return the sole pi-fleet-owned runtime root, pinned per configured value for this process. */
export function fleetRuntimeRoot(): string {
	const configured = process.env.PI_FLEET_HOME;
	const requested = configured === undefined || configured === ""
		? join(homedir(), ".pi-fleet")
		: configured;
	if (
		!isAbsolute(requested) ||
		requested === parse(requested).root ||
		normalize(requested) !== requested ||
		requested.includes("//")
	)
		throw new Error(
			"PI_FLEET_HOME must be a normalized, absolute, non-root path",
		);
	const cached = canonicalRoots.get(requested);
	if (cached) return cached;
	const root = canonicalizePath(requested);
	if (root === parse(root).root)
		throw new Error("PI_FLEET_HOME must resolve below the filesystem root");
	canonicalRoots.set(requested, root);
	return root;
}

/** Resolve a path below the runtime root, rejecting escape attempts. */
export function runtimePath(...parts: string[]): string {
	const root = fleetRuntimeRoot();
	const target = resolve(root, ...parts);
	if (target !== root && !target.startsWith(`${root}${sep}`))
		throw new Error("runtime path escapes PI_FLEET_HOME");
	return target;
}

/** Reject a symlink in any existing component of a canonical runtime path. */
export async function assertRuntimePathNoSymlinks(path: string): Promise<void> {
	const root = fleetRuntimeRoot();
	if (!isAbsolute(path)) throw new Error("runtime path must be absolute");
	const target = resolve(path);
	if (target !== root && !target.startsWith(`${root}${sep}`))
		throw new Error("runtime path escapes PI_FLEET_HOME");
	let current = parse(root).root;
	for (const part of root.slice(current.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Runtime path contains a symlink: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	for (const part of target.slice(root.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Runtime path contains a symlink: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
