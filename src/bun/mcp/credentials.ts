import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { platform } from "node:os";
import type {
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { MCP_AUTH_DIR, MCP_CREDENTIALS_FILE, ensureLayout } from "../paths";

type OAuthCredential = {
	clients: Record<string, StoredOAuthClientInformation>;
	tokens: Record<string, StoredOAuthTokens>;
	tokenSavedAt?: Record<string, number>;
	latestIssuer?: string;
	state?: string;
	nonce?: string;
	codeVerifier?: string;
	discovery?: OAuthDiscoveryState;
	resourceUrl?: string;
	preRegisteredClientSecret?: string;
};

type ServerCredential = {
	staticHeaders?: Record<string, string>;
	oauth?: OAuthCredential;
};

type CredentialFile = {
	version: 1;
	servers: Record<string, ServerCredential>;
};

const EMPTY = (): CredentialFile => ({ version: 1, servers: {} });
let layoutSecured = false;

/** This directory is the credential boundary, including on Windows where chmod is meaningless. */
function ensureCredentialLayout(): void {
	ensureLayout();
	if (!layoutSecured) {
		if (existsSync(MCP_AUTH_DIR)) {
			const stat = lstatSync(MCP_AUTH_DIR);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new Error(`${MCP_AUTH_DIR} must be a real directory owned by this user`);
			}
		} else {
			mkdirSync(MCP_AUTH_DIR, { recursive: false, mode: 0o700 });
		}
		if (platform() === "win32") hardenWindowsAcl();
		else chmodSync(MCP_AUTH_DIR, 0o700);
		layoutSecured = true;
	}
	if (existsSync(MCP_CREDENTIALS_FILE)) {
		const stat = lstatSync(MCP_CREDENTIALS_FILE);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(`${MCP_CREDENTIALS_FILE} must be a regular owner-only file`);
		}
	}
}

function hardenWindowsAcl(): void {
	try {
		const output = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
			encoding: "utf8",
			windowsHide: true,
		});
		const sid = output.match(/,\s*"(S-[^"]+)"/i)?.[1];
		if (!sid) throw new Error("current user SID was not reported");
		execFileSync(
			"icacls",
			[MCP_AUTH_DIR, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
			{ stdio: "ignore", windowsHide: true },
		);
	} catch (error) {
		throw new Error(
			`Could not make ${MCP_AUTH_DIR} private to the current Windows user; MCP credentials were not written`,
			{ cause: error },
		);
	}
}

function read(): CredentialFile {
	ensureCredentialLayout();
	if (!existsSync(MCP_CREDENTIALS_FILE)) return EMPTY();
	try {
		const parsed = JSON.parse(readFileSync(MCP_CREDENTIALS_FILE, "utf8")) as Partial<CredentialFile>;
		if (parsed.version !== 1 || !parsed.servers || typeof parsed.servers !== "object") {
			throw new Error("unsupported MCP credential file");
		}
		return { version: 1, servers: parsed.servers };
	} catch {
		throw new Error(
			`${MCP_CREDENTIALS_FILE} is not valid JSON. Fix or remove it; Toad will not overwrite MCP credentials it cannot read.`,
		);
	}
}

/** Atomic, owner-only persistence. Deliberately no backup retains rotated/revoked tokens. */
function write(file: CredentialFile): void {
	ensureCredentialLayout();
	const temporary = `${MCP_CREDENTIALS_FILE}.${process.pid}.tmp`;
	// A crash may leave our own temporary name behind. Removing the directory
	// entry is safe even if it was replaced with a symlink; `wx` then refuses
	// any race instead of following it.
	rmSync(temporary, { force: true });
	const handle = openSync(temporary, "wx", 0o600);
	try {
		writeSync(handle, `${JSON.stringify(file, null, 2)}\n`);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	// Tokens are recoverable by authorizing again; retaining rotated or revoked
	// credentials in a backup is a worse failure mode than requiring that step.
	rmSync(`${MCP_CREDENTIALS_FILE}.bak`, { force: true });
	renameSync(temporary, MCP_CREDENTIALS_FILE);
	if (platform() !== "win32") chmodSync(MCP_CREDENTIALS_FILE, 0o600);
}

function updateServer(serverId: string, mutate: (record: ServerCredential) => void): void {
	const file = read();
	const record = file.servers[serverId] ?? {};
	mutate(record);
	if (!record.staticHeaders && !record.oauth) delete file.servers[serverId];
	else file.servers[serverId] = record;
	write(file);
}

function oauth(record: ServerCredential): OAuthCredential {
	return (record.oauth ??= { clients: {}, tokens: {} });
}

export function staticHeaders(serverId: string): Record<string, string> | undefined {
	const headers = read().servers[serverId]?.staticHeaders;
	return headers ? { ...headers } : undefined;
}

export function saveStaticHeaders(serverId: string, headers: Record<string, string>): void {
	updateServer(serverId, (record) => {
		record.staticHeaders = { ...headers };
	});
}

export function removeStaticHeaders(serverId: string): void {
	updateServer(serverId, (record) => {
		delete record.staticHeaders;
	});
}

/** Moves legacy inline values once; an existing secure value always wins. */
export function migrateStaticHeaders(serverId: string, headers: Record<string, string>): void {
	const file = read();
	if (file.servers[serverId]?.staticHeaders) return;
	const record = file.servers[serverId] ?? {};
	record.staticHeaders = { ...headers };
	file.servers[serverId] = record;
	write(file);
}

export function newAuthorizationAttempt(serverId: string): { state: string; nonce: string } {
	const state = randomBytes(32).toString("base64url");
	const nonce = randomBytes(32).toString("base64url");
	updateServer(serverId, (record) => {
		const value = oauth(record);
		value.state = state;
		value.nonce = nonce;
		delete value.codeVerifier;
	});
	return { state, nonce };
}

export function authorizationState(serverId: string): { state?: string; nonce?: string } {
	const value = read().servers[serverId]?.oauth;
	return { state: value?.state, nonce: value?.nonce };
}

export function saveCodeVerifier(serverId: string, verifier: string): void {
	updateServer(serverId, (record) => {
		oauth(record).codeVerifier = verifier;
	});
}

export function codeVerifier(serverId: string): string {
	const verifier = read().servers[serverId]?.oauth?.codeVerifier;
	if (!verifier) throw new Error("The MCP authorization attempt has no PKCE verifier");
	return verifier;
}

export function clientInformation(
	serverId: string,
	issuer?: string,
): StoredOAuthClientInformation | undefined {
	const value = read().servers[serverId]?.oauth;
	const key = issuer ?? value?.latestIssuer;
	return key ? value?.clients[key] : undefined;
}

export function saveClientInformation(
	serverId: string,
	issuer: string,
	client: StoredOAuthClientInformation,
): void {
	updateServer(serverId, (record) => {
		const value = oauth(record);
		value.clients[issuer] = client;
		value.latestIssuer = issuer;
	});
}

export function tokens(serverId: string, issuer?: string): StoredOAuthTokens | undefined {
	const value = read().servers[serverId]?.oauth;
	const key = issuer ?? value?.latestIssuer;
	return key ? value?.tokens[key] : undefined;
}

export function saveTokens(serverId: string, issuer: string, next: StoredOAuthTokens): void {
	updateServer(serverId, (record) => {
		const value = oauth(record);
		value.tokens[issuer] = next;
		(value.tokenSavedAt ??= {})[issuer] = Date.now();
		value.latestIssuer = issuer;
	});
}

export function tokenSavedAt(serverId: string, issuer?: string): number | undefined {
	const value = read().servers[serverId]?.oauth;
	const key = issuer ?? value?.latestIssuer;
	return key ? value?.tokenSavedAt?.[key] : undefined;
}

export function saveDiscovery(serverId: string, discovery: OAuthDiscoveryState): void {
	updateServer(serverId, (record) => {
		oauth(record).discovery = discovery;
	});
}

export function discovery(serverId: string): OAuthDiscoveryState | undefined {
	return read().servers[serverId]?.oauth?.discovery;
}

export function saveResourceUrl(serverId: string, resourceUrl: string): void {
	updateServer(serverId, (record) => {
		oauth(record).resourceUrl = resourceUrl;
	});
}

export function resourceUrl(serverId: string): string | undefined {
	return read().servers[serverId]?.oauth?.resourceUrl;
}

export function savePreRegisteredClientSecret(serverId: string, secret: string | undefined): void {
	updateServer(serverId, (record) => {
		const value = oauth(record);
		if (secret) value.preRegisteredClientSecret = secret;
		else delete value.preRegisteredClientSecret;
	});
}

export function preRegisteredClientSecret(serverId: string): string | undefined {
	return read().servers[serverId]?.oauth?.preRegisteredClientSecret;
}

export function invalidateOAuth(
	serverId: string,
	scope: "all" | "client" | "tokens" | "verifier" | "discovery",
): void {
	updateServer(serverId, (record) => {
		const value = record.oauth;
		if (!value) return;
		if (scope === "all") {
			delete record.oauth;
			return;
		}
		if (scope === "client") value.clients = {};
		if (scope === "tokens") {
			value.tokens = {};
			value.tokenSavedAt = {};
		}
		if (scope === "verifier") {
			delete value.codeVerifier;
			delete value.state;
			delete value.nonce;
		}
		if (scope === "discovery") delete value.discovery;
	});
}

export function removeServerCredentials(serverId: string): void {
	const file = read();
	if (!(serverId in file.servers)) return;
	delete file.servers[serverId];
	write(file);
}
