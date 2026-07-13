import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildAppJwt,
	GITHUB_APP_ID_ENV,
	GITHUB_APP_INSTALLATION_ID_ENV,
	GITHUB_APP_PRIVATE_KEY_ENV,
	GITHUB_APP_PRIVATE_KEY_PATH_ENV,
	githubAppEnvPresent,
	mintInstallationToken,
	resolveGithubAppConfig,
} from "./githubApp.ts";

const ORIGINAL_ENV = { ...process.env };

function clearAppEnv() {
	delete process.env[GITHUB_APP_ID_ENV];
	delete process.env[GITHUB_APP_INSTALLATION_ID_ENV];
	delete process.env[GITHUB_APP_PRIVATE_KEY_ENV];
	delete process.env[GITHUB_APP_PRIVATE_KEY_PATH_ENV];
}

function restoreEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) delete process.env[key];
	}
	Object.assign(process.env, ORIGINAL_ENV);
}

test.beforeEach(() => {
	clearAppEnv();
});

test.afterEach(() => {
	restoreEnv();
});

// Throwaway RSA keypair generated fresh in-process — never a real App secret,
// so App-token minting is fully testable without live GitHub App credentials.
function testKeyPair() {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	});
}

test("resolveGithubAppConfig returns undefined when no App env vars are set", () => {
	assert.equal(resolveGithubAppConfig(), undefined);
	assert.equal(githubAppEnvPresent(), false);
});

test("resolveGithubAppConfig throws a clear error listing what's missing when partially configured", () => {
	process.env[GITHUB_APP_ID_ENV] = "123";
	// installationId and private key deliberately left unset.

	assert.throws(() => resolveGithubAppConfig(), (err: Error) => {
		assert.match(err.message, /partially configured/i);
		assert.match(err.message, new RegExp(GITHUB_APP_INSTALLATION_ID_ENV));
		assert.match(err.message, new RegExp(GITHUB_APP_PRIVATE_KEY_ENV));
		return true;
	});
	assert.equal(githubAppEnvPresent(), true);
});

test("resolveGithubAppConfig returns the resolved config when app id, installation id, and inline private key are all set", () => {
	const { privateKey } = testKeyPair();
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
	process.env[GITHUB_APP_PRIVATE_KEY_ENV] = privateKey;

	const config = resolveGithubAppConfig();
	assert.ok(config);
	assert.equal(config?.appId, "123");
	assert.equal(config?.installationId, "456");
	// Env values are trimmed (stray leading/trailing whitespace is common when
	// PEMs are pasted into env files), so compare against the trimmed form.
	assert.equal(config?.privateKey, privateKey.trim());
});

test("resolveGithubAppConfig reads the private key from a file path when FLEET_GITHUB_APP_PRIVATE_KEY_PATH is set", async () => {
	const { privateKey } = testKeyPair();
	const dir = await mkdtemp(join(tmpdir(), "pi-fleet-app-key-"));
	const keyPath = join(dir, "app.pem");
	await writeFile(keyPath, privateKey, "utf8");

	try {
		process.env[GITHUB_APP_ID_ENV] = "123";
		process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
		process.env[GITHUB_APP_PRIVATE_KEY_PATH_ENV] = keyPath;

		const config = resolveGithubAppConfig();
		assert.equal(config?.privateKey, privateKey);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolveGithubAppConfig throws a clear error when FLEET_GITHUB_APP_PRIVATE_KEY_PATH does not point to a readable file", () => {
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
	process.env[GITHUB_APP_PRIVATE_KEY_PATH_ENV] = "/nonexistent/app-key.pem";

	assert.throws(
		() => resolveGithubAppConfig(),
		/Could not read FLEET_GITHUB_APP_PRIVATE_KEY_PATH/,
	);
});

test("resolveGithubAppConfig converts a literal-\\n PEM (common in secret managers) into real newlines", () => {
	const { privateKey } = testKeyPair();
	process.env[GITHUB_APP_ID_ENV] = "123";
	process.env[GITHUB_APP_INSTALLATION_ID_ENV] = "456";
	process.env[GITHUB_APP_PRIVATE_KEY_ENV] = privateKey.replace(/\n/g, "\\n");

	const config = resolveGithubAppConfig();
	assert.equal(config?.privateKey, privateKey);
});

test("buildAppJwt signs a JWT verifiable with the corresponding public key and short expiry", () => {
	const { privateKey, publicKey } = testKeyPair();
	const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

	const jwt = buildAppJwt({ appId: "999", privateKey }, fixedNow);
	const [headerB64, payloadB64, sigB64] = jwt.split(".");

	const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
	assert.equal(header.alg, "RS256");

	const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
	assert.equal(payload.iss, "999");
	const nowSec = Math.floor(fixedNow().getTime() / 1000);
	assert.ok(payload.iat <= nowSec);
	// GitHub rejects App JWTs with exp more than 10 minutes out; stay under that.
	assert.ok(payload.exp - nowSec <= 10 * 60);

	const signingInput = `${headerB64}.${payloadB64}`;
	const verifier = createVerify("RSA-SHA256");
	verifier.update(signingInput);
	const valid = verifier.verify(publicKey, Buffer.from(sigB64, "base64url"));
	assert.equal(valid, true);
});

test("mintInstallationToken posts to the GitHub installation access_tokens endpoint and returns the minted token", async () => {
	const { privateKey } = testKeyPair();
	let capturedUrl: string | undefined;
	let capturedAuth: string | undefined;

	const token = await mintInstallationToken(
		{ appId: "999", installationId: "42", privateKey },
		{
			fetchImpl: (async (url: string, init: RequestInit) => {
				capturedUrl = url;
				capturedAuth = (init.headers as Record<string, string>).Authorization;
				return new Response(
					JSON.stringify({
						token: "ghs_mintedInstallationTokenValue",
						expires_at: "2026-01-01T01:00:00Z",
					}),
					{ status: 201 },
				);
			}) as typeof fetch,
		},
	);

	assert.equal(capturedUrl, "https://api.github.com/app/installations/42/access_tokens");
	assert.match(capturedAuth ?? "", /^Bearer /);
	assert.equal(token.token, "ghs_mintedInstallationTokenValue");
	assert.equal(token.expiresAt, "2026-01-01T01:00:00Z");
});

test("mintInstallationToken omits a request body when no repositories are given (mints with the installation's full access, previous behavior)", async () => {
	const { privateKey } = testKeyPair();
	let capturedBody: string | undefined;
	let capturedContentType: string | undefined;

	await mintInstallationToken(
		{ appId: "999", installationId: "42", privateKey },
		{
			fetchImpl: (async (_url: string, init: RequestInit) => {
				capturedBody = init.body as string | undefined;
				capturedContentType = (init.headers as Record<string, string>)["Content-Type"];
				return new Response(
					JSON.stringify({ token: "ghs_full", expires_at: "2026-01-01T01:00:00Z" }),
					{ status: 201 },
				);
			}) as typeof fetch,
		},
	);

	assert.equal(capturedBody, undefined);
	assert.equal(capturedContentType, undefined);
});

test("mintInstallationToken scopes the request to the given repositories (FLT-12 per-repo path)", async () => {
	const { privateKey } = testKeyPair();
	let capturedBody: string | undefined;
	let capturedContentType: string | undefined;

	const token = await mintInstallationToken(
		{ appId: "999", installationId: "42", privateKey },
		{
			repositories: ["pi-fleet"],
			fetchImpl: (async (_url: string, init: RequestInit) => {
				capturedBody = init.body as string | undefined;
				capturedContentType = (init.headers as Record<string, string>)["Content-Type"];
				return new Response(
					JSON.stringify({ token: "ghs_scoped", expires_at: "2026-01-01T01:00:00Z" }),
					{ status: 201 },
				);
			}) as typeof fetch,
		},
	);

	assert.equal(capturedContentType, "application/json");
	assert.deepEqual(JSON.parse(capturedBody ?? "{}"), { repositories: ["pi-fleet"] });
	assert.equal(token.token, "ghs_scoped");
});

test("mintInstallationToken throws a clear error (without leaking the private key) when GitHub responds with an error status", async () => {
	const { privateKey } = testKeyPair();

	await assert.rejects(
		() =>
			mintInstallationToken(
				{ appId: "999", installationId: "42", privateKey },
				{
					fetchImpl: (async () =>
						new Response("installation not found", { status: 404 })) as typeof fetch,
				},
			),
		(err: Error) => {
			assert.match(err.message, /404/);
			assert.match(err.message, /installation not found/);
			assert.equal(err.message.includes(privateKey), false);
			return true;
		},
	);
});

test("mintInstallationToken adds an actionable installation-reachability hint when a repositories-scoped request fails (FLT-12 review fix)", async () => {
	const { privateKey } = testKeyPair();

	await assert.rejects(
		() =>
			mintInstallationToken(
				{ appId: "999", installationId: "42", privateKey },
				{
					repositories: ["some-other-repo"],
					fetchImpl: (async () =>
						new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as typeof fetch,
				},
			),
		(err: Error) => {
			assert.match(err.message, /404/);
			// Actionable: names the installation and the repo(s) that weren't
			// reachable, and points at fixing App repository access rather than
			// implying arbitrary cross-installation/org support exists.
			assert.match(err.message, /installation \(id 42\)/);
			assert.match(err.message, /some-other-repo/);
			assert.match(err.message, /Repository access/);
			return true;
		},
	);
});

test("mintInstallationToken omits the reachability hint when no repositories scope was requested", async () => {
	const { privateKey } = testKeyPair();

	await assert.rejects(
		() =>
			mintInstallationToken(
				{ appId: "999", installationId: "42", privateKey },
				{
					fetchImpl: (async () =>
						new Response("installation not found", { status: 404 })) as typeof fetch,
				},
			),
		(err: Error) => {
			assert.equal(/installation \(id/.test(err.message), false);
			return true;
		},
	);
});
