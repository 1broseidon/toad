/**
 * Provider auth without touching the user's real credentials.
 *
 * Exercises provider discovery, an SDK-owned API-key prompt, persistence,
 * status refresh, and logout under a temporary HOME/TOAD_DATA_DIR. OAuth is
 * enumerated but not completed because it requires a real external account.
 *
 * Run: bun hack/verify-provider-auth.ts
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "toad-auth-home-"));
process.env.HOME = home;
process.env.TOAD_DATA_DIR = join(home, "toad");
process.env.TOAD_PI_AUTH_PATH = join(home, "auth.json");

const auth = await import("../src/bun/pi/auth");

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

	const afterLogout = await auth.logoutProvider(anthropic.id);
	check(
		"logout removes the credential",
		afterLogout.find((provider) => provider.id === anthropic.id)?.configured === false,
	);
}

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
