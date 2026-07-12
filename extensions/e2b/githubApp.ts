/**
 * pi-fleet E2B extension — GitHub App installation token minting (FLT-6).
 *
 * When a GitHub App is configured, each non-dry-run cast mints a fresh,
 * installation-scoped, short-lived (GitHub expires these ~1h) access token
 * instead of injecting a long-lived personal access token into the sandbox.
 * The App private key never leaves the host process — only the minted token
 * (already time-boxed by GitHub) is ever forwarded to a sandbox.
 */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

export const GITHUB_APP_ID_ENV = "FLEET_GITHUB_APP_ID";
export const GITHUB_APP_INSTALLATION_ID_ENV = "FLEET_GITHUB_APP_INSTALLATION_ID";
export const GITHUB_APP_PRIVATE_KEY_ENV = "FLEET_GITHUB_APP_PRIVATE_KEY";
export const GITHUB_APP_PRIVATE_KEY_PATH_ENV = "FLEET_GITHUB_APP_PRIVATE_KEY_PATH";

const GITHUB_APP_ENV_KEYS = [
	GITHUB_APP_ID_ENV,
	GITHUB_APP_INSTALLATION_ID_ENV,
	GITHUB_APP_PRIVATE_KEY_ENV,
	GITHUB_APP_PRIVATE_KEY_PATH_ENV,
] as const;

export interface GithubAppConfig {
	appId: string;
	installationId: string;
	privateKey: string;
}

/** True if any GitHub App env var is set — distinguishes "unconfigured" (fall back to PAT) from "misconfigured" (fail loudly). */
export function githubAppEnvPresent(): boolean {
	return GITHUB_APP_ENV_KEYS.some((key) => Boolean(process.env[key]?.trim()));
}

/**
 * Resolves + validates the GitHub App config from env. Returns undefined when
 * no App env var is set at all (the caller should fall back to
 * FLEET_GITHUB_TOKEN/GH_TOKEN). Throws a single clear error naming every
 * missing piece when *some* but not all App env vars are set — a partially
 * configured App must never silently fall back to a PAT, since that would
 * mask a broken setup as "working as before".
 */
export function resolveGithubAppConfig(): GithubAppConfig | undefined {
	const appId = process.env[GITHUB_APP_ID_ENV]?.trim();
	const installationId = process.env[GITHUB_APP_INSTALLATION_ID_ENV]?.trim();
	const privateKeyInline = process.env[GITHUB_APP_PRIVATE_KEY_ENV]?.trim();
	const privateKeyPath = process.env[GITHUB_APP_PRIVATE_KEY_PATH_ENV]?.trim();

	if (!appId && !installationId && !privateKeyInline && !privateKeyPath) {
		return undefined;
	}

	const missing: string[] = [];
	if (!appId) missing.push(GITHUB_APP_ID_ENV);
	if (!installationId) missing.push(GITHUB_APP_INSTALLATION_ID_ENV);
	if (!privateKeyInline && !privateKeyPath) {
		missing.push(`${GITHUB_APP_PRIVATE_KEY_ENV} or ${GITHUB_APP_PRIVATE_KEY_PATH_ENV}`);
	}
	if (missing.length > 0) {
		throw new Error(
			`GitHub App is partially configured: missing ${missing.join(", ")}. ` +
				`Set all of ${GITHUB_APP_ID_ENV}, ${GITHUB_APP_INSTALLATION_ID_ENV}, and ` +
				`${GITHUB_APP_PRIVATE_KEY_ENV} (or ${GITHUB_APP_PRIVATE_KEY_PATH_ENV}) to mint ` +
				`GitHub App installation tokens, or unset all of them to fall back to ` +
				`FLEET_GITHUB_TOKEN/GH_TOKEN.`,
		);
	}

	let privateKey = privateKeyInline ?? "";
	if (!privateKey && privateKeyPath) {
		try {
			privateKey = readFileSync(privateKeyPath, "utf8");
		} catch (err) {
			throw new Error(
				`Could not read ${GITHUB_APP_PRIVATE_KEY_PATH_ENV} at ${privateKeyPath}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	// Some secret managers deliver PEMs with literal "\n" escapes instead of
	// real newlines; normalize so createSign() sees a valid PEM either way.
	if (privateKey.includes("\\n") && !privateKey.includes("\n")) {
		privateKey = privateKey.replace(/\\n/g, "\n");
	}

	return { appId: appId as string, installationId: installationId as string, privateKey };
}

export function githubAppConfigured(): boolean {
	return resolveGithubAppConfig() !== undefined;
}

function base64url(input: Buffer | string): string {
	return (Buffer.isBuffer(input) ? input : Buffer.from(input))
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Builds the short-lived App JWT GitHub requires to mint an installation
 * token. iat is backdated 60s to tolerate clock drift; exp stays under
 * GitHub's 10-minute ceiling for App JWTs.
 */
export function buildAppJwt(
	config: Pick<GithubAppConfig, "appId" | "privateKey">,
	now: () => Date = () => new Date(),
): string {
	const nowSec = Math.floor(now().getTime() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: config.appId };

	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const signature = createSign("RSA-SHA256").update(signingInput).sign(config.privateKey);
	return `${signingInput}.${base64url(signature)}`;
}

export interface InstallationToken {
	token: string;
	expiresAt: string;
}

export type FetchLike = typeof fetch;

export interface MintInstallationTokenOptions {
	fetchImpl?: FetchLike;
	now?: () => Date;
}

/**
 * Mints a fresh installation access token from GitHub. Network access is
 * injectable so this is fully testable without real App secrets — tests pass
 * a fake fetch and a throwaway RSA key.
 */
export async function mintInstallationToken(
	config: GithubAppConfig,
	opts: MintInstallationTokenOptions = {},
): Promise<InstallationToken> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const jwt = buildAppJwt(config, opts.now);

	const res = await fetchImpl(
		`https://api.github.com/app/installations/${config.installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`GitHub App installation token request failed (${res.status}): ${body.slice(0, 300)}`,
		);
	}

	const data = (await res.json()) as { token?: string; expires_at?: string };
	if (!data.token) {
		throw new Error("GitHub App installation token response did not include a token");
	}
	return { token: data.token, expiresAt: data.expires_at ?? "" };
}
