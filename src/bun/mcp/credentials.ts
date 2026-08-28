import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
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
import { MCP_CREDENTIALS_FILE, ensureLayout } from "../paths";

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

function read(): CredentialFile {
	ensureLayout();
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
	ensureLayout();
	const temporary = `${MCP_CREDENTIALS_FILE}.${process.pid}.tmp`;
	const handle = openSync(temporary, "w", 0o600);
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
