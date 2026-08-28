/**
 * Provider auth without touching the user's real credentials.
 *
 * Exercises provider discovery, an SDK-owned API-key prompt, persistence,
 * status refresh, and logout under a temporary HOME/TOAD_DATA_DIR, then the
 * user-defined providers that share the same runtime. OAuth is enumerated but
 * not completed because it requires a real external account.
 *
 * Run: bun scripts/verify-provider-auth.ts
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "toad-auth-home-"));
process.env.HOME = home;
process.env.TOAD_DATA_DIR = join(home, "toad");
process.env.TOAD_PI_AUTH_PATH = join(home, "auth.json");

const auth = await import("../src/bun/pi/auth");
const custom = await import("../src/bun/pi/custom-providers");
const runtime = await import("../src/bun/pi/runtime");

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};

const providers = await auth.listProviderAuth();
const oauth = providers.filter((provider) => provider.oauth);
const apiKeys = providers.filter((provider) => provider.apiKey);
check("OAuth providers are discovered from pi", oauth.length >= 7, oauth.map((p) => p.name).join(", "));
check("API-key providers are discovered from pi", apiKeys.length >= 30, `${apiKeys.length} providers`);
check("provider responses contain no secret values", !JSON.stringify(providers).includes("sk-"));

const anthropic = providers.find((provider) => provider.id === "anthropic");
check("Anthropic offers API-key setup", Boolean(anthropic?.apiKey), anthropic?.apiKey?.name);

if (anthropic) {
	let flow = await auth.startProviderLogin({
		providerId: anthropic.id,
		method: "api_key",
		openUrl: () => {},
	});
	for (let i = 0; i < 40 && flow.status === "running"; i++) {
		await Bun.sleep(25);
		flow = auth.getProviderLogin(flow.id) ?? flow;
	}
	check("the SDK asked its own key question", flow.status === "prompt", flow.prompt?.type);
	check("the key prompt is secret", flow.prompt?.type === "secret", flow.prompt?.type);

	flow = auth.answerProviderLogin(flow.id, "sk-ant-toad-verification-only");
	for (let i = 0; i < 80 && ["running", "prompt"].includes(flow.status); i++) {
		await Bun.sleep(25);
		flow = auth.getProviderLogin(flow.id) ?? flow;
	}
	check("API-key setup completed", flow.status === "success", flow.error);

	const afterLogin = await auth.listProviderAuth();
	check(
		"the provider reports configured",
		afterLogin.find((provider) => provider.id === anthropic.id)?.configured === true,
	);
	check(
		"the key was persisted outside the webview",
		existsSync(process.env.TOAD_PI_AUTH_PATH),
	);
	check("the flow response does not echo the key", !JSON.stringify(flow).includes("verification-only"));

	/* While a built-in is genuinely configured: pointing it at a proxy is a
	 * custom entry, but it is not a Custom provider — the heading that tells the
	 * user how they are billed has to survive. */
	await custom.saveCustomProvider({
		id: anthropic.id,
		baseUrl: "https://proxy.invalid/v1",
		api: "anthropic-messages",
		models: ["claude-verify-proxied"],
	});
	const proxied = (await runtime.availableModels()).find(
		(model) => model.id === `${anthropic.id}/claude-verify-proxied`,
	);
	check("a proxied built-in is offered", Boolean(proxied), proxied?.group);
	check("a proxied built-in keeps its own heading", proxied?.group !== "Custom", proxied?.group);
	await custom.removeCustomProvider(anthropic.id);

	const afterLogout = await auth.logoutProvider(anthropic.id);
	check(
		"logout removes the credential",
		afterLogout.find((provider) => provider.id === anthropic.id)?.configured === false,
	);
}

/* The engine half: pi reads models.json when the runtime is created and again
 * on refresh, never on the way to getAvailable(). Everything below runs against
 * the one long-lived runtime the app has, because "do the models appear without
 * restarting Toad" is the question the settings screen answers out loud. */
const CUSTOM = "toad-verify-endpoint";
const before = await runtime.availableModels();
check(
	"a provider nobody defined has no models",
	!before.some((model) => model.id.startsWith(`${CUSTOM}/`)),
);

await custom.saveCustomProvider({
	id: CUSTOM,
	name: "Verification endpoint",
	baseUrl: "http://127.0.0.1:1/v1",
	api: "openai-completions",
	models: ["tiny-1", "tiny-2"],
	compat: { supportsDeveloperRole: false },
});

const file = readFileSync(custom.customModelsPath(), "utf8");
check("the definition lands in Toad's own models.json", file.includes(CUSTOM));
check(
	"the pi CLI's own models file is untouched",
	!existsSync(join(process.env.HOME!, ".pi", "agent", "models.json")),
);
if (platform() !== "win32") {
	check(
		"the definitions file is owner-only",
		(statSync(custom.customModelsPath()).mode & 0o777) === 0o600,
	);
}

const added = await runtime.availableModels();
const mine = added.filter((model) => model.id.startsWith(`${CUSTOM}/`));
check("its models appear without recreating the runtime", mine.length === 2, mine.map((m) => m.id));
check("they are grouped as Custom", mine.every((model) => model.group === "Custom"), mine[0]?.group);

await custom.saveCustomProvider({
	id: CUSTOM,
	baseUrl: "http://127.0.0.1:1/v1",
	api: "openai-completions",
	models: ["tiny-1", "tiny-2"],
	apiKey: "sk-toad-verification-only",
});
const keyed = readFileSync(custom.customModelsPath(), "utf8");
check("a real key never reaches the definitions file", !keyed.includes("verification-only"));
const listed = await custom.listCustomProviders();
check(
	"the key went to pi's credential store",
	listed.find((provider) => provider.id === CUSTOM)?.auth === "credential",
);
check("the listing does not echo the key", !JSON.stringify(listed).includes("verification-only"));

await custom.removeCustomProvider(CUSTOM);
check(
	"removing the definition removes its models",
	!(await runtime.availableModels()).some((model) => model.id.startsWith(`${CUSTOM}/`)),
);

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
