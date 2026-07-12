import { createRequire } from "node:module";

type SandboxOperation = "connect" | "create";

/**
 * pi loads this extension through jiti (see the coding-agent extension loader),
 * whose CJS/ESM interop leaves e2b's esbuild-compiled `__toESM(require("platform"))`
 * default undefined. e2b then crashes at module-evaluation time inside its
 * top-level `getRuntime()`, which reads `platform.default.version` — surfacing as
 * the opaque "Cannot read properties of undefined (reading 'version')" that failed
 * every real cast (FLT-4). A plain `await import("e2b")` runs through jiti's
 * transform and hits that crash; a native `createRequire()` loads e2b's CJS build
 * outside jiti, exactly as plain Node does (where the SDK loads fine). Resolved
 * relative to this module so it finds extensions/e2b/node_modules/e2b under jiti,
 * tsx (tests), and vanilla Node alike.
 */
const requireE2B = createRequire(import.meta.url);

/** Load the e2b SDK outside the host loader's ESM transform. See requireE2B. */
export function loadE2BSdk(): unknown {
	return requireE2B("e2b");
}

interface SandboxStaticLike {
	connect?(sandboxId: string, options: Record<string, unknown>): Promise<unknown>;
	create?(template: string, options: Record<string, unknown>): Promise<unknown>;
}

/**
 * Resolve E2B's Sandbox class across native ESM and CJS-interoperability import
 * shapes. Some extension harnesses wrap the package under one or more `default`
 * properties, so assuming only `module.Sandbox` can make Sandbox.connect appear
 * undefined even though the installed SDK supports it.
 */
export function resolveSandboxApi(
	moduleValue: unknown,
	operation: SandboxOperation,
): SandboxStaticLike {
	let current = moduleValue;
	const seen = new Set<unknown>();

	for (let depth = 0; depth < 4 && current && !seen.has(current); depth += 1) {
		seen.add(current);
		const value = current as Record<string, unknown>;
		const named = value.Sandbox as SandboxStaticLike | undefined;
		if (typeof named?.[operation] === "function") return named;

		const direct = current as SandboxStaticLike;
		if (typeof direct[operation] === "function") return direct;
		current = value.default;
	}

	throw new Error(
		`E2B SDK import does not expose Sandbox.${operation}; check the installed e2b package version/import shape`,
	);
}

export async function connectE2BSandbox<T>(sandboxId: string): Promise<T> {
	const apiKey = process.env.E2B_API_KEY?.trim();
	if (!apiKey) throw new Error("E2B_API_KEY is not set");
	const sdk = loadE2BSdk();
	return resolveSandboxApi(sdk, "connect").connect?.(sandboxId, {
		apiKey,
	}) as Promise<T>;
}

export async function createE2BSandbox<T>(
	template: string,
	options: { timeoutMs: number; apiKey: string },
): Promise<T> {
	const sdk = loadE2BSdk();
	return resolveSandboxApi(sdk, "create").create?.(
		template,
		options,
	) as Promise<T>;
}
