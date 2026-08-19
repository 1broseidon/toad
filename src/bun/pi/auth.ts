import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type {
	ProviderAuthFlow,
	ProviderAuthInfo,
	ProviderAuthNotice,
	ProviderAuthPrompt,
} from "../../shared/types";
import { piRuntime } from "./runtime";

type PendingPrompt = {
	resolve(value: string): void;
	reject(error: Error): void;
};

type LiveFlow = {
	view: ProviderAuthFlow;
	abort: AbortController;
	pending?: PendingPrompt;
};

const flows = new Map<string, LiveFlow>();
const MAX_FLOWS = 12;

/**
 * Provider authentication for the settings UI.
 *
 * Login is provider-owned and not always one textbox: a flow may open a browser,
 * show a device code, ask for a GitHub Enterprise domain, or request several
 * provider-specific values. The SDK expresses that as callbacks. This module
 * turns them into a small, pollable wizard without exposing credentials in RPC
 * responses or keeping answers after they have been handed back to pi.
 */
export async function listProviderAuth(): Promise<ProviderAuthInfo[]> {
	const runtime = await piRuntime();
	const providers = runtime.getProviders();
	const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(10_000) });
	const stored = new Map(credentials.map((credential) => [credential.providerId, credential.type]));
	const checks = await Promise.all(
		providers.map(async (provider) => {
			try {
				return await runtime.checkAuth(provider.id, { signal: AbortSignal.timeout(10_000) });
			} catch {
				return undefined;
			}
		}),
	);

	return providers
		.map((provider, index): ProviderAuthInfo => {
			const check = checks[index];
			return {
				id: provider.id,
				name: provider.name,
				configured: Boolean(check),
				stored: stored.has(provider.id),
				source: check?.source,
				credentialType: stored.get(provider.id) ?? check?.type,
				...(provider.auth.oauth
					? {
							oauth: {
								name: provider.auth.oauth.name,
								loginLabel: provider.auth.oauth.loginLabel ?? `Sign in with ${provider.name}`,
								subscription: Boolean(provider.auth.oauth.isSubscription),
							},
						}
					: {}),
				...(provider.auth.apiKey?.login
					? { apiKey: { name: provider.auth.apiKey.name } }
					: {}),
			};
		})
		.filter((provider) => provider.oauth || provider.apiKey)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function startProviderLogin(input: {
	providerId: string;
	method: "oauth" | "api_key";
	openUrl(url: string): void;
}): Promise<ProviderAuthFlow> {
	const runtime = await piRuntime();
	const provider = runtime.getProvider(input.providerId);
	if (!provider) throw new Error(`Unknown provider ${input.providerId}`);
	if (input.method === "oauth" && !provider.auth.oauth) {
		throw new Error(`${provider.name} does not offer OAuth`);
	}
	if (input.method === "api_key" && !provider.auth.apiKey?.login) {
		throw new Error(`${provider.name} does not offer API-key setup`);
	}

	pruneFlows();
	const id = randomUUID();
	const live: LiveFlow = {
		abort: new AbortController(),
		view: {
			id,
			providerId: provider.id,
			providerName: provider.name,
			method: input.method,
			status: "running",
			notices: [],
		},
	};
	flows.set(id, live);

	void runtime
		.login(provider.id, input.method, {
			signal: live.abort.signal,
			prompt: (prompt) => waitForPrompt(live, prompt),
			notify: (event) => notify(live, event, input.openUrl),
		})
		.then(() => {
			live.pending = undefined;
			live.view = { ...live.view, status: "success", prompt: undefined };
		})
		.catch((error) => {
			live.pending = undefined;
			if (live.abort.signal.aborted) {
				live.view = { ...live.view, status: "cancelled", prompt: undefined };
				return;
			}
			live.view = {
				...live.view,
				status: "error",
				prompt: undefined,
				error: short(error),
			};
		});

	return snapshot(live.view);
}

export function getProviderLogin(flowId: string): ProviderAuthFlow | null {
	const flow = flows.get(flowId);
	return flow ? snapshot(flow.view) : null;
}

export function answerProviderLogin(flowId: string, value: string): ProviderAuthFlow {
	const flow = flows.get(flowId);
	if (!flow) throw new Error("That sign-in flow no longer exists");
	if (!flow.pending || flow.view.status !== "prompt") {
		throw new Error("That sign-in flow is not waiting for an answer");
	}
	const pending = flow.pending;
	flow.pending = undefined;
	flow.view = { ...flow.view, status: "running", prompt: undefined };
	pending.resolve(value);
	return snapshot(flow.view);
}

export function cancelProviderLogin(flowId: string): void {
	const flow = flows.get(flowId);
	if (!flow) return;
	flow.abort.abort();
	flow.pending?.reject(new Error("Sign-in cancelled"));
	flow.pending = undefined;
	flow.view = { ...flow.view, status: "cancelled", prompt: undefined };
}

export async function logoutProvider(providerId: string): Promise<ProviderAuthInfo[]> {
	await (await piRuntime()).logout(providerId, { signal: AbortSignal.timeout(15_000) });
	return listProviderAuth();
}

function waitForPrompt(flow: LiveFlow, prompt: AuthPrompt): Promise<string> {
	flow.pending?.reject(new Error("Superseded by the next sign-in question"));
	const viewPrompt = normalizePrompt(prompt);
	flow.view = { ...flow.view, status: "prompt", prompt: viewPrompt };

	return new Promise<string>((resolve, reject) => {
		flow.pending = { resolve, reject };
		const abort = () => {
			if (flow.pending?.reject !== reject) return;
			flow.pending = undefined;
			reject(new Error("Sign-in cancelled"));
		};
		flow.abort.signal.addEventListener("abort", abort, { once: true });
		prompt.signal?.addEventListener("abort", abort, { once: true });
	});
}

function notify(flow: LiveFlow, event: AuthEvent, openUrl: (url: string) => void): void {
	const notice = normalizeNotice(event);
	const notices = [...flow.view.notices, notice].slice(-8);
	flow.view = { ...flow.view, notices };

	if (event.type === "auth_url") openSafe(event.url, openUrl);
	if (event.type === "device_code") openSafe(event.verificationUri, openUrl);
}

function normalizePrompt(prompt: AuthPrompt): ProviderAuthPrompt {
	if (prompt.type === "select") {
		return {
			type: "select",
			message: prompt.message,
			options: prompt.options.map((option) => ({ ...option })),
		};
	}
	return {
		type: prompt.type,
		message: prompt.message,
		placeholder: prompt.placeholder,
	};
}

function normalizeNotice(event: AuthEvent): ProviderAuthNotice {
	switch (event.type) {
		case "auth_url":
			return { type: "auth_url", url: event.url, instructions: event.instructions };
		case "device_code":
			return {
				type: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				expiresInSeconds: event.expiresInSeconds,
			};
		case "progress":
			return { type: "progress", message: event.message };
		case "info":
			return {
				type: "info",
				message: event.message,
				links: event.links?.map((link) => ({ ...link })),
			};
	}
}

function openSafe(url: string, openUrl: (url: string) => void): void {
	try {
		if (["http:", "https:"].includes(new URL(url).protocol)) openUrl(url);
	} catch {
		/* A malformed provider URL stays visible in the flow and is not opened. */
	}
}

function snapshot(flow: ProviderAuthFlow): ProviderAuthFlow {
	return JSON.parse(JSON.stringify(flow)) as ProviderAuthFlow;
}

function pruneFlows(): void {
	if (flows.size < MAX_FLOWS) return;
	for (const [id, flow] of flows) {
		if (flow.view.status === "running" || flow.view.status === "prompt") continue;
		flows.delete(id);
		if (flows.size < MAX_FLOWS) return;
	}
}

function short(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
