import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ConfigChoice } from "../../shared/types";
import { PI_DIR, ensureLayout } from "../paths";
import { customProviderIds } from "./custom-providers";

/**
 * Where credentials come from.
 *
 * Toad isolates pi's *code* (extensions, skills) into its own directory, but
 * deliberately shares its *credentials* with the user's own pi install when
 * there is one. A person already signed in through the pi CLI should not have
 * to sign in again to use the same models here, and a login is a fact about
 * them rather than about either program.
 */
function authPath(): string {
	/* Test harnesses need a path that cannot depend on os.homedir(), which some
	 * runtimes cache before a script can replace HOME. Not user-facing; it keeps
	 * credential verification physically incapable of opening the real file. */
	if (process.env.TOAD_PI_AUTH_PATH) return process.env.TOAD_PI_AUTH_PATH;
	const shared = join(homedir(), ".pi", "agent", "auth.json");
	return existsSync(shared) ? shared : join(PI_DIR, "auth.json");
}

let runtime: Promise<ModelRuntime> | undefined;

/**
 * The model runtime, created once for the whole app.
 *
 * This is the only part of pi with a real startup cost — it restores the
 * provider catalogs — and it is not per-teammate, so it is paid once and shared.
 * Sessions built on top of it cost single-digit milliseconds, which is the
 * entire reason a teammate can be an in-process session rather than a spawned
 * harness.
 */
export function piRuntime(): Promise<ModelRuntime> {
	if (!runtime) {
		ensureLayout();
		/* pi loads each OAuth flow through a computed import specifier, on purpose:
		 * it keeps Node-only login code out of browser bundles. The cost is that a
		 * bundler cannot follow it either, so in a packaged app every OAuth provider
		 * fails at the moment of use — and fails quietly, as a stopReason on the
		 * assistant message rather than a thrown error. This is pi's own answer to
		 * that: static imports of every flow, registered before anything asks for
		 * one. Without it, Toad works from source and ships broken. */
		registerBunOAuthFlows();
		runtime = ModelRuntime.create({
			authPath: authPath(),
			modelsPath: join(PI_DIR, "models.json"),
			modelsStorePath: join(PI_DIR, "models-store.json"),
		});
	}
	return runtime;
}

/** `provider/id`, so a model choice survives two providers sharing a name. */
export function modelChoiceId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** Every model with working authentication, as the UI's generic choice shape. */
export async function availableModels(): Promise<ConfigChoice[]> {
	const models = await (await piRuntime()).getAvailable();
	const flavors = await providerFlavors();
	const custom = customProviderIds();
	const builtin = new Set<string>(getBuiltinProviders());
	return models.map((model) => ({
		id: modelChoiceId(model),
		name: model.name,
		description: model.provider,
		/* Custom wins over the flavor, and being a built-in wins over both. pi
		 * composes a user-defined provider into the same shape as a shipped one,
		 * so the flavor line would otherwise announce a free local Ollama as "pay
		 * per use" — while an entry that merely proxies Anthropic really is
		 * Anthropic, billed exactly as its own heading says. */
		group:
			custom.has(model.provider) && !builtin.has(model.provider)
				? "Custom"
				: (flavors.get(model.provider) ?? model.provider),
	}));
}

/**
 * "Anthropic — subscription" vs "OpenRouter — API key": the same model name
 * can be served both ways at very different prices, and the picker's section
 * header is where the user learns which one they are about to pay for.
 */
async function providerFlavors(): Promise<Map<string, string>> {
	try {
		const { listProviderAuth } = await import("./auth");
		const flavors = new Map<string, string>();
		for (const provider of await listProviderAuth()) {
			if (!provider.configured) continue;
			/* The section label answers the question that costs money: is this
			 * the plan you already pay for, or metered usage? */
			const flavor = provider.credentialType
				? provider.oauth?.subscription
					? "subscription"
					: "pay per use"
				: undefined;
			flavors.set(provider.id, flavor ? `${provider.name} — ${flavor}` : provider.name);
		}
		return flavors;
	} catch {
		return new Map();
	}
}

/*
 * Thinking levels, presented as modes, live in `./thinking`.
 *
 * ACP backends advertise modes (Cursor: agent, plan, ask) and pi has thinking
 * levels; both are "the same teammate, dialled differently", both are
 * switchable mid-conversation, and the UI already renders that axis as a list
 * of choices. Reusing the slot means the composer and the settings pane need to
 * know nothing about which kind of agent they are looking at. The ladder itself
 * sits in its own module because which rungs exist is a fact about pi and about
 * the current model, not about this file's model runtime.
 */
