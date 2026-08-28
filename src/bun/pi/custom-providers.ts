import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type {
	CustomProviderApi,
	CustomProviderInfo,
	CustomProviderInput,
} from "../../shared/types";
import { PI_DIR, ensureLayout } from "../paths";

/**
 * Model providers the user defines: Ollama, LM Studio, vLLM, any OpenAI-shaped URL.
 *
 * pi already knows how to talk to these; the only thing missing was a file
 * saying they exist. That file is `models.json`, and *which* one is the whole
 * design question here.
 *
 * Toad writes its own — `PI_DIR/models.json` — and never the pi CLI's
 * `~/.pi/agent/models.json`, not even to read it. That breaks the symmetry with
 * `authPath()` in ./runtime, which deliberately shares the CLI's `auth.json`,
 * and the asymmetry is the point. `auth.json` holds credentials: facts about
 * the person, identical in both programs, and inert. `models.json` holds
 * behaviour. Its `apiKey` and `headers` fields accept `"!some command"`, which
 * pi executes at request time, and a provider entry may override a *built-in*
 * provider's `baseUrl` — so inheriting the file would let a line typed into a
 * terminal config redirect where a desktop app sends the user's Anthropic
 * token, or run a command, with nothing on screen having changed. That is the
 * same reason `PI_DIR` is not `~/.pi/agent` at all (see src/bun/paths.ts): pi's
 * config directory can carry code, and Toad only inherits the parts that
 * cannot. A user who wants their CLI provider here can retype four fields; that
 * is a smaller cost than a silent channel between the two programs.
 *
 * Secrets follow the credential rule rather than the config rule: a real key is
 * handed to pi's auth store, and this file records only that one is expected.
 */

/** The API shapes pi can speak. Ordered as the picker shows them. */
const APIS: readonly CustomProviderApi[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

/**
 * What a local server gets instead of a key.
 *
 * pi treats every model as auth-gated, so a keyless Ollama would load and then
 * stay invisible in the picker. Its docs answer this with a dummy value. A
 * stored credential outranks it, so this never shadows a real key the user
 * adds later for the same provider.
 */
const LOCAL_PLACEHOLDER = "toad-local";

type ProviderEntry = {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: Array<{ id?: string; name?: string }>;
	compat?: Record<string, unknown>;
	/* Anything else pi understands — headers, modelOverrides, per-model cost —
	 * which this form does not show and therefore must not discard. */
	[key: string]: unknown;
};

type ModelsFile = { providers?: Record<string, ProviderEntry> };

export function customModelsPath(): string {
	return join(PI_DIR, "models.json");
}

/**
 * The file, or a refusal.
 *
 * A models.json that will not parse is somebody's hand-edited work. Reporting
 * it as empty would invite the next save to write over it, so callers get an
 * error and the screen says so.
 */
function readFile(): ModelsFile {
	const path = customModelsPath();
	if (!existsSync(path)) return {};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : error}`);
	}
	if (!text.trim()) return {};
	try {
		const parsed = JSON.parse(text) as ModelsFile;
		if (!parsed || typeof parsed !== "object") throw new Error("not an object");
		return parsed;
	} catch {
		throw new Error(
			`${path} is not valid JSON. Fix or delete it; Toad will not overwrite a file it cannot read.`,
		);
	}
}

/** Whole or not at all, and owner-only: the file names endpoints and env vars. */
function writeFile(file: ModelsFile): void {
	ensureLayout();
	const path = customModelsPath();
	const temporary = `${path}.${process.pid}.tmp`;
	const handle = openSync(temporary, "w", 0o600);
	try {
		writeSync(handle, `${JSON.stringify(file, null, 2)}\n`);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	renameSync(temporary, path);
	/* openSync's mode is masked by umask; this is the one that actually holds. */
	if (platform() !== "win32") chmodSync(path, 0o600);
}

function entryApi(entry: ProviderEntry): CustomProviderApi {
	const api = entry.api as CustomProviderApi | undefined;
	return api && APIS.includes(api) ? api : "openai-completions";
}

/**
 * How this provider proves who it is — never what with.
 *
 * `configured` is asked of the runtime rather than of the file because a key
 * added through the sign-in pane lives in pi's auth store, where this file
 * cannot see it and should not look.
 */
function describeAuth(
	entry: ProviderEntry,
	configured: boolean,
): CustomProviderInfo["auth"] {
	const key = entry.apiKey?.trim();
	if (!key) return configured ? "credential" : "none";
	if (key === LOCAL_PLACEHOLDER) return "local";
	if (key.startsWith("$")) return "environment";
	/* A literal secret sitting in the file — pi's own CLI writes these. Toad
	 * never adds one, and reports it so the user can move it. */
	return "literal";
}

/** The fields the settings form knows how to show. Anything else is `advanced`. */
const FORM_FIELDS = new Set(["name", "baseUrl", "api", "apiKey", "models", "compat"]);

function toInfo(id: string, entry: ProviderEntry, configured: boolean): CustomProviderInfo {
	return {
		id,
		name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
		baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
		api: entryApi(entry),
		models: (entry.models ?? [])
			.map((model) => (typeof model?.id === "string" ? model.id : ""))
			.filter(Boolean),
		auth: describeAuth(entry, configured),
		/* Editing through the form rewrites the fields it shows and keeps the
		 * rest, but the user deserves to know the entry is larger than the form. */
		advanced: Object.keys(entry).some((key) => !FORM_FIELDS.has(key)),
	};
}

/**
 * Provider ids Toad defines, for grouping the picker.
 *
 * Deliberately synchronous and forgiving: a damaged file must not stop the
 * model list from rendering, it only stops a *write*. See `availableModels`.
 */
export function customProviderIds(): Set<string> {
	try {
		return new Set(Object.keys(readFile().providers ?? {}));
	} catch {
		return new Set();
	}
}

export async function listCustomProviders(): Promise<CustomProviderInfo[]> {
	const providers = readFile().providers ?? {};
	const ids = Object.keys(providers);
	if (ids.length === 0) return [];

	const { piRuntime } = await import("./runtime");
	const runtime = await piRuntime();
	return ids
		.map((id) => toInfo(id, providers[id] ?? {}, runtime.hasConfiguredAuth(id)))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything wrong with a draft, said in the words the form used. */
function validate(input: CustomProviderInput): {
	id: string;
	entry: Pick<ProviderEntry, "name" | "baseUrl" | "api" | "models" | "compat">;
} {
	const id = input.id?.trim() ?? "";
	/* No slash: a model choice travels as `provider/model` and is split at the
	 * first one, so a slash in the provider would rename the model. */
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
		throw new Error(
			"A provider name may use letters, digits, dot, dash and underscore, and must start with a letter or digit.",
		);
	}

	const baseUrl = input.baseUrl?.trim() ?? "";
	/* One message for both failures on purpose: `localhost:11434/v1` parses as a
	 * URL whose scheme is `localhost`, so "not a URL" and "wrong scheme" are the
	 * same typo to the person making it. */
	let scheme = "";
	try {
		scheme = new URL(baseUrl).protocol;
	} catch {
		/* Falls through to the same complaint. */
	}
	if (scheme !== "http:" && scheme !== "https:") {
		throw new Error(
			"The base URL must be a full http or https URL, for example http://localhost:11434/v1",
		);
	}

	if (!APIS.includes(input.api)) throw new Error(`${input.api} is not an API shape pi speaks.`);

	const models: string[] = [];
	for (const raw of input.models ?? []) {
		const model = raw?.trim();
		if (!model) continue;
		if (!models.includes(model)) models.push(model);
	}
	if (models.length === 0) throw new Error("Name at least one model this endpoint serves.");

	const compat = input.compat
		? Object.fromEntries(
				Object.entries(input.compat).filter(([, value]) => typeof value === "boolean"),
			)
		: undefined;

	return {
		id,
		entry: {
			name: input.name?.trim() || undefined,
			baseUrl,
			api: input.api,
			models: models.map((model) => ({ id: model })),
			...(compat && Object.keys(compat).length > 0 ? { compat } : {}),
		},
	};
}

/**
 * Writes a provider definition, and puts any real key where keys live.
 *
 * Three ways to authenticate, and no secret in the file under any of them:
 *
 *  - a literal key goes to pi's auth store through `setRuntimeApiKey`, the same
 *    store the sign-in pane fills, and `apiKey` is left out of the file so that
 *    removing the credential correctly hides the models again;
 *  - a `$VAR` reference is the name of a secret rather than one, so it is
 *    written as given and resolved by pi at request time;
 *  - nothing at all means a local server, which gets the placeholder.
 */
export async function saveCustomProvider(input: CustomProviderInput): Promise<CustomProviderInfo[]> {
	const { id, entry } = validate(input);
	const key = input.apiKey?.trim() ?? "";
	const secret = key.length > 0 && !key.startsWith("$");

	const { piRuntime } = await import("./runtime");
	const runtime = await piRuntime();

	const file = readFile();
	const providers = { ...(file.providers ?? {}) };
	const previous = providers[id] ?? {};

	/* Merged over what was there: a `headers` block or `modelOverrides` this
	 * form cannot show is the user's, and an edit here is not consent to lose it. */
	const next: ProviderEntry = { ...previous, ...entry };
	if (secret) delete next.apiKey;
	else if (key) next.apiKey = key;
	/* The placeholder is for a provider with nothing else to offer. One whose key
	 * is already in pi's store needs none, and giving it one would make the
	 * screen call a signed-in provider keyless. */
	else if (!next.apiKey && !runtime.hasConfiguredAuth(id)) next.apiKey = LOCAL_PLACEHOLDER;

	providers[id] = next;
	writeFile({ ...file, providers });

	if (secret) await runtime.setRuntimeApiKey(id, key);

	/* pi reads models.json when the runtime is created and again on refresh —
	 * never on the way to `getAvailable()`. Without this the provider would
	 * appear only after a restart of the whole app. Measured, not assumed. */
	await runtime.refresh({ allowNetwork: false });
	return listCustomProviders();
}

/**
 * Forgets a provider definition, and keeps its credential.
 *
 * Same principle as signing in: the key is a fact about the user, not about
 * this entry. Removing it belongs to the sign-in pane, where removing a key is
 * what the button says it does.
 */
export async function removeCustomProvider(id: string): Promise<CustomProviderInfo[]> {
	const file = readFile();
	const providers = { ...(file.providers ?? {}) };
	if (!(id in providers)) return listCustomProviders();
	delete providers[id];
	writeFile({ ...file, providers });

	const { piRuntime } = await import("./runtime");
	await (await piRuntime()).refresh({ allowNetwork: false });
	return listCustomProviders();
}
