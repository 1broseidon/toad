import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { PI_DIR } from "../paths";

/**
 * The file half of custom providers.
 *
 * Everything works on `PI_DIR/models.json` — the throwaway one the test preload
 * hands the process. The runtime is stubbed rather than built: creating a real
 * `ModelRuntime` restores every provider catalog and opens the user's own
 * credential file, which a unit test has no business doing. What is left is the
 * part worth pinning — what lands on disk, what never does, and what comes back.
 */

/** Keys handed to pi's auth store, which is where the real ones are supposed to go. */
const storedKeys: Array<[string, string]> = [];
let refreshes = 0;
/** Providers the stubbed runtime claims a credential for. */
const credentialed = new Set<string>();

mock.module("./runtime", () => ({
	piRuntime: async () => ({
		hasConfiguredAuth: (id: string) => credentialed.has(id),
		setRuntimeApiKey: async (id: string, key: string) => {
			storedKeys.push([id, key]);
		},
		refresh: async () => {
			refreshes += 1;
			return { aborted: false, errors: new Map() };
		},
	}),
}));

const {
	customModelsPath,
	customProviderIds,
	listCustomProviders,
	removeCustomProvider,
	saveCustomProvider,
} = await import("./custom-providers");

const path = () => customModelsPath();

function seed(providers: Record<string, unknown>): void {
	mkdirSync(PI_DIR, { recursive: true });
	writeFileSync(path(), `${JSON.stringify({ providers }, null, 2)}\n`);
}

beforeEach(() => {
	storedKeys.length = 0;
	credentialed.clear();
	refreshes = 0;
});

afterEach(() => {
	rmSync(path(), { force: true });
});

describe("customProviderIds", () => {
	test("is empty when no file was ever written", () => {
		expect(existsSync(path())).toBe(false);
		expect([...customProviderIds()]).toEqual([]);
	});

	test("names every provider in the file", () => {
		seed({ ollama: { baseUrl: "http://localhost:11434/v1" }, vllm: {} });
		expect([...customProviderIds()].sort()).toEqual(["ollama", "vllm"]);
	});

	/* The model picker must still render when the file is broken; only writing stops. */
	test("survives a file that will not parse", () => {
		mkdirSync(PI_DIR, { recursive: true });
		writeFileSync(path(), "{ not json");
		expect([...customProviderIds()]).toEqual([]);
	});
});

describe("saveCustomProvider", () => {
	const base = {
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions" as const,
		models: ["llama3.1:8b"],
	};

	test("rejects the shapes that would corrupt a model choice", async () => {
		/* `provider/model` is split at the first slash, so a slash in the id would
		 * silently rename the model. */
		await expect(saveCustomProvider({ ...base, id: "my/provider" })).rejects.toThrow(
			/provider name/i,
		);
		await expect(saveCustomProvider({ ...base, id: "-leading" })).rejects.toThrow(/provider name/i);
		await expect(saveCustomProvider({ ...base, id: "" })).rejects.toThrow(/provider name/i);
		/* Parses, but as a URL whose scheme is `localhost` — the commonest typo. */
		await expect(
			saveCustomProvider({ ...base, id: "ok", baseUrl: "localhost:11434/v1" }),
		).rejects.toThrow(/http or https/i);
		await expect(saveCustomProvider({ ...base, id: "ok", baseUrl: "not a url" })).rejects.toThrow(
			/http or https/i,
		);
		await expect(
			saveCustomProvider({ ...base, id: "ok", baseUrl: "file:///etc/passwd" }),
		).rejects.toThrow(/http or https/i);
		await expect(
			saveCustomProvider({ ...base, id: "ok", models: ["", "  "] }),
		).rejects.toThrow(/at least one/i);
		expect(existsSync(path())).toBe(false);
	});

	test("refuses to write over a file it could not read", async () => {
		mkdirSync(PI_DIR, { recursive: true });
		writeFileSync(path(), "{ not json");
		await expect(saveCustomProvider({ ...base, id: "ollama" })).rejects.toThrow(/not valid JSON/);
		expect(readFileSync(path(), "utf8")).toBe("{ not json");
	});

	test("writes a local provider pi can load, owner-only, with no secret in it", async () => {
		await saveCustomProvider({
			id: "ollama",
			name: "Ollama",
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			models: ["llama3.1:8b", "qwen2.5-coder:7b", " llama3.1:8b "],
			compat: { supportsDeveloperRole: false },
		});

		expect(JSON.parse(readFileSync(path(), "utf8")).providers.ollama).toEqual({
			name: "Ollama",
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			models: [{ id: "llama3.1:8b" }, { id: "qwen2.5-coder:7b" }],
			compat: { supportsDeveloperRole: false },
			/* A server that ignores keys still needs one, because pi gates models on
			 * auth. The placeholder is pi's documented answer, and is not a secret. */
			apiKey: "toad-local",
		});
		if (platform() !== "win32") expect(statSync(path()).mode & 0o777).toBe(0o600);
		/* pi only re-reads models.json on refresh, so the write is only half of it. */
		expect(refreshes).toBe(1);
	});

	test("keeps a $VAR reference in the file and a literal key out of it", async () => {
		await saveCustomProvider({
			...base,
			id: "cloud",
			baseUrl: "https://ollama.com/v1",
			apiKey: "$OLLAMA_API_KEY",
		});
		expect(JSON.parse(readFileSync(path(), "utf8")).providers.cloud.apiKey).toBe(
			"$OLLAMA_API_KEY",
		);
		expect(storedKeys).toEqual([]);

		await saveCustomProvider({
			...base,
			id: "cloud",
			baseUrl: "https://ollama.com/v1",
			apiKey: "sk-a-real-secret",
		});
		const text = readFileSync(path(), "utf8");
		expect(text).not.toContain("sk-a-real-secret");
		/* Absent rather than replaced by the placeholder: removing the credential
		 * must take the models with it, not leave them failing against a dummy. */
		expect(JSON.parse(text).providers.cloud.apiKey).toBeUndefined();
		expect(storedKeys).toEqual([["cloud", "sk-a-real-secret"]]);
	});

	test("an edit keeps the pi settings the form cannot show", async () => {
		seed({
			proxy: {
				baseUrl: "https://old.example.com/v1",
				api: "anthropic-messages",
				headers: { "x-portkey-api-key": "$PORTKEY" },
				modelOverrides: { "claude-sonnet-4": { contextWindow: 1_050_000 } },
				models: [{ id: "claude-sonnet-4" }],
			},
		});

		await saveCustomProvider({
			id: "proxy",
			baseUrl: "https://new.example.com/v1",
			api: "anthropic-messages",
			models: ["claude-opus-4-7"],
		});

		const entry = JSON.parse(readFileSync(path(), "utf8")).providers.proxy;
		expect(entry.baseUrl).toBe("https://new.example.com/v1");
		expect(entry.models).toEqual([{ id: "claude-opus-4-7" }]);
		expect(entry.headers).toEqual({ "x-portkey-api-key": "$PORTKEY" });
		expect(entry.modelOverrides).toEqual({ "claude-sonnet-4": { contextWindow: 1_050_000 } });
	});

	test("does not call a signed-in provider keyless when its key is left blank", async () => {
		credentialed.add("cloud");
		seed({ cloud: { baseUrl: "https://ollama.com/v1", models: [{ id: "deepseek-v4-pro" }] } });
		await saveCustomProvider({ ...base, id: "cloud", baseUrl: "https://ollama.com/v1" });
		expect(JSON.parse(readFileSync(path(), "utf8")).providers.cloud.apiKey).toBeUndefined();
		expect((await listCustomProviders())[0]?.auth).toBe("credential");
	});

	test("leaves other providers alone, including ones written by hand", async () => {
		seed({ handwritten: { baseUrl: "http://elsewhere/v1", apiKey: "sk-theirs" } });
		await saveCustomProvider({ ...base, id: "mine", baseUrl: "http://localhost:8000/v1" });
		const providers = JSON.parse(readFileSync(path(), "utf8")).providers;
		expect(Object.keys(providers).sort()).toEqual(["handwritten", "mine"]);
		expect(providers.handwritten.apiKey).toBe("sk-theirs");
	});

	test("round-trips through its own reader", async () => {
		await saveCustomProvider({
			id: "vllm",
			name: "Workstation vLLM",
			baseUrl: "https://gpu.lan:8000/v1",
			api: "openai-completions",
			models: ["qwen3-coder", "gpt-oss:120b"],
		});
		expect(await listCustomProviders()).toEqual([
			{
				id: "vllm",
				name: "Workstation vLLM",
				baseUrl: "https://gpu.lan:8000/v1",
				api: "openai-completions",
				models: ["qwen3-coder", "gpt-oss:120b"],
				auth: "local",
				advanced: false,
			},
		]);
	});
});

describe("listCustomProviders", () => {
	test("says how a provider authenticates without naming the secret", async () => {
		credentialed.add("signedIn");
		seed({
			local: { baseUrl: "http://localhost:11434/v1", apiKey: "toad-local", models: [{ id: "a" }] },
			fromEnv: { baseUrl: "https://x/v1", apiKey: "$SOME_KEY", models: [{ id: "b" }] },
			handwritten: { baseUrl: "https://y/v1", apiKey: "sk-theirs", models: [{ id: "c" }] },
			signedIn: { baseUrl: "https://z/v1", models: [{ id: "d" }] },
			bare: { baseUrl: "https://w/v1", models: [{ id: "e" }] },
		});

		const list = await listCustomProviders();
		expect(Object.fromEntries(list.map((provider) => [provider.id, provider.auth]))).toEqual({
			local: "local",
			fromEnv: "environment",
			handwritten: "literal",
			signedIn: "credential",
			bare: "none",
		});
		expect(JSON.stringify(list)).not.toContain("sk-theirs");
	});

	test("flags an entry larger than the form, and defaults a missing api", async () => {
		seed({
			plain: { baseUrl: "https://x/v1", api: "openai-responses", models: [{ id: "a" }] },
			rich: { baseUrl: "https://y/v1", headers: { "x-a": "1" }, models: [{ id: "b" }] },
		});
		const byId = Object.fromEntries((await listCustomProviders()).map((p) => [p.id, p]));
		expect(byId.plain?.advanced).toBe(false);
		expect(byId.plain?.api).toBe("openai-responses");
		expect(byId.rich?.advanced).toBe(true);
		expect(byId.rich?.api).toBe("openai-completions");
	});

	test("reports a damaged file rather than an empty one", async () => {
		mkdirSync(PI_DIR, { recursive: true });
		writeFileSync(path(), "{ not json");
		await expect(listCustomProviders()).rejects.toThrow(/not valid JSON/);
	});
});

describe("removeCustomProvider", () => {
	test("drops one entry, keeps the rest, and tells pi", async () => {
		seed({ a: { baseUrl: "https://a/v1" }, b: { baseUrl: "https://b/v1" } });
		await removeCustomProvider("a");
		expect(Object.keys(JSON.parse(readFileSync(path(), "utf8")).providers)).toEqual(["b"]);
		expect(refreshes).toBe(1);
	});

	test("removing what is not there changes nothing", async () => {
		seed({ a: { baseUrl: "https://a/v1" } });
		await removeCustomProvider("nope");
		expect(Object.keys(JSON.parse(readFileSync(path(), "utf8")).providers)).toEqual(["a"]);
		expect(refreshes).toBe(0);
	});
});
