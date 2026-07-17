import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, resolve } from "node:path";

/** Return the sole pi-fleet-owned runtime root. */
export function fleetRuntimeRoot(): string {
	const configured = process.env.PI_FLEET_HOME?.trim();
	const root = configured || join(homedir(), ".pi-fleet");
	if (!isAbsolute(root) || root === parse(root).root || normalize(root) !== root || root.includes("//"))
		throw new Error("PI_FLEET_HOME must be a normalized, absolute, non-root path");
	return root;
}

/** Resolve a path below the runtime root, rejecting escape attempts. */
export function runtimePath(...parts: string[]): string {
	const root = fleetRuntimeRoot();
	const target = resolve(root, ...parts);
	if (target !== root && !target.startsWith(`${root}/`))
		throw new Error("runtime path escapes PI_FLEET_HOME");
	return target;
}
