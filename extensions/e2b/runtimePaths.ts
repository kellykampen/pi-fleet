import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, resolve, sep } from "node:path";

/** Return the sole pi-fleet-owned runtime root. */
export function fleetRuntimeRoot(): string {
	const configured = process.env.PI_FLEET_HOME?.trim();
	const root = configured || join(homedir(), ".pi-fleet");
	if (!isAbsolute(root) || root === parse(root).root || normalize(root) !== root || root.includes("//"))
		throw new Error("PI_FLEET_HOME must be a normalized, absolute, non-root path");
	try {
		if (lstatSync(root).isSymbolicLink())
			throw new Error("PI_FLEET_HOME must not be a symlink");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
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

/** Reject a symlink in any existing component at or below the runtime root. */
export async function assertRuntimePathNoSymlinks(path: string): Promise<void> {
	const root = fleetRuntimeRoot();
	if (path !== root && !path.startsWith(`${root}${sep}`))
		throw new Error("runtime path escapes PI_FLEET_HOME");
	let current = root;
	for (const part of ["", ...path.slice(root.length).split(sep).filter(Boolean)]) {
		if (part) current = join(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Runtime path contains a symlink: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
