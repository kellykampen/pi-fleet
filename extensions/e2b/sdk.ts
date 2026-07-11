type SandboxOperation = "connect" | "create";

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
	const sdk = await import("e2b");
	return resolveSandboxApi(sdk, "connect").connect?.(sandboxId, {
		apiKey,
	}) as Promise<T>;
}

export async function createE2BSandbox<T>(
	template: string,
	options: { timeoutMs: number; apiKey: string },
): Promise<T> {
	const sdk = await import("e2b");
	return resolveSandboxApi(sdk, "create").create?.(
		template,
		options,
	) as Promise<T>;
}
