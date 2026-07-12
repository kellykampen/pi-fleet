import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import { loadE2BSdk, resolveSandboxApi } from "./sdk.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Regression for FLT-4: pi loads this extension through jiti, whose CJS/ESM
 * interop leaves e2b's esbuild `__toESM(require("platform"))` default undefined,
 * so e2b's top-level getRuntime() crashes reading `platform.default.version`
 * ("Cannot read properties of undefined (reading 'version')"). Every real cast
 * failed pre-sandbox with that opaque error. loadE2BSdk() must load e2b outside
 * jiti's transform (native createRequire) so the real Sandbox API is available
 * under the pi host loader — not just under plain Node.
 */
test("loadE2BSdk survives the jiti host loader that crashed a raw e2b import", async () => {
	const jiti = createJiti(join(HERE, "sdk.ts"), { moduleCache: false });

	// Baseline: a raw import of e2b through jiti reproduces the opaque crash the
	// lead hit. This asserts the hazard is real, so the fix below is meaningful.
	await assert.rejects(
		() => jiti.import("e2b"),
		/reading '?version'?/,
		"expected the raw jiti e2b import to reproduce the opaque version crash",
	);

	// The fix: loadE2BSdk (run through jiti, exactly as the extension is loaded)
	// loads e2b's CJS build natively and exposes the real Sandbox API.
	const sdkModule = (await jiti.import(join(HERE, "sdk.ts"))) as {
		loadE2BSdk: typeof loadE2BSdk;
		resolveSandboxApi: typeof resolveSandboxApi;
	};
	const e2b = sdkModule.loadE2BSdk();
	assert.equal(
		typeof sdkModule.resolveSandboxApi(e2b, "create").create,
		"function",
	);
	assert.equal(
		typeof sdkModule.resolveSandboxApi(e2b, "connect").connect,
		"function",
	);
});

test("loadE2BSdk exposes the Sandbox API under the plain test runtime", () => {
	const e2b = loadE2BSdk();
	assert.equal(typeof resolveSandboxApi(e2b, "create").create, "function");
	assert.equal(typeof resolveSandboxApi(e2b, "connect").connect, "function");
});
