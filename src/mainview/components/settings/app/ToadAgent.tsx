/* Hallmark · component: settings detail pane · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus-visible · active · disabled · loading · error · success · empty
 * contrast: pass (40–41)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	ProviderAuthFlow,
	ProviderAuthInfo,
	ProviderAuthNotice,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { BackIcon } from "../../icons";
import { Section } from "../../fields";
import { CustomProviders } from "./CustomProviders";

type Method = "oauth" | "api_key";

type Props = {
	providers: ProviderAuthInfo[] | null;
	error: string;
	onReload(): Promise<unknown>;
	onBack(): void;
};

/**
 * Providers for the built-in agent.
 *
 * Reached by drilling in from Agents, so it opens with a way back rather than
 * repeating the panel you came from. What is already working comes first — the
 * question on arriving is usually "am I set up?" — then the two ways to add
 * one. Subscriptions lead because signing in is less work than finding a key.
 *
 * Every flow is provider-owned: pi asks the questions, this only renders them.
 * That is what keeps GitHub Enterprise domains, device codes and Cloudflare's
 * several fields correct without a bespoke form per provider.
 */
export function ToadAgent({ providers, error, onReload, onBack }: Props) {
	const [flow, setFlow] = useState<ProviderAuthFlow | null>(null);
	const [answer, setAnswer] = useState("");
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const live = useRef<ProviderAuthFlow | null>(null);
	live.current = flow;

	/* A flow runs in the main process, so leaving this pane while one is waiting
	 * would strand it holding a prompt nobody can answer. */
	useEffect(
		() => () => {
			const current = live.current;
			if (current && ["running", "prompt"].includes(current.status)) {
				void api.cancelProviderLogin(current.id);
			}
		},
		[],
	);

	useEffect(() => {
		if (!flow || !["running", "prompt"].includes(flow.status)) return;
		const timer = window.setInterval(() => {
			void api.getProviderLogin(flow.id).then((next) => {
				if (!next) return;
				setFlow(next);
				if (next.status !== "running" && next.status !== "prompt") setBusy(null);
				if (next.status === "success") void onReload();
			});
		}, 450);
		return () => window.clearInterval(timer);
	}, [flow?.id, flow?.status]);

	const connected = useMemo(
		() => (providers ?? []).filter((provider) => provider.configured),
		[providers],
	);
	const oauth = useMemo(
		() => (providers ?? []).filter((provider) => provider.oauth && !provider.configured),
		[providers],
	);
	const keys = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const all = (providers ?? []).filter((provider) => provider.apiKey && !provider.configured);
		return needle
			? all.filter((provider) => provider.name.toLowerCase().includes(needle))
			: all;
	}, [providers, query]);

	const begin = async (provider: ProviderAuthInfo, method: Method) => {
		setBusy(provider.id);
		setAnswer("");
		try {
			setFlow(await api.startProviderLogin(provider.id, method));
		} catch (err) {
			setBusy(null);
			setFlow({
				id: "unstarted",
				providerId: provider.id,
				providerName: provider.name,
				method,
				status: "error",
				notices: [],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const disconnect = async (provider: ProviderAuthInfo) => {
		setBusy(provider.id);
		try {
			await api.logoutProvider(provider.id);
			await onReload();
		} finally {
			setBusy(null);
		}
	};

	const dismissFlow = async () => {
		if (flow && flow.id !== "unstarted" && ["running", "prompt"].includes(flow.status)) {
			await api.cancelProviderLogin(flow.id);
		}
		setFlow(null);
		setBusy(null);
		setAnswer("");
	};

	return (
		<div className="flex flex-col gap-2xl">
			<div>
				<button type="button" className="btn-ghost -ml-3xs gap-2xs !px-xs" onClick={onBack}>
					<BackIcon />
					<span>Agents</span>
				</button>
				<p className="mt-xs max-w-prose text-xs leading-relaxed text-ink-3">
					Connect a provider and every Toad Agent teammate can use it. Credentials are stored
					locally, outside this screen; their values are never read back.
				</p>
			</div>

			{error && (
				<p className="border-y border-danger-edge bg-danger-wash px-md py-xs text-xs text-danger">
					Could not read providers: {error}
				</p>
			)}

			{flow && (
				<LoginFlow
					flow={flow}
					answer={answer}
					onAnswer={setAnswer}
					onSubmit={async (value = answer) => {
						setAnswer("");
						setFlow(await api.answerProviderLogin(flow.id, value));
					}}
					onDismiss={() => void dismissFlow()}
				/>
			)}

			{connected.length > 0 && (
				<Section title="Connected">
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{connected.map((provider) => (
							<li key={provider.id} className="flex items-center gap-sm py-xs">
								<span aria-hidden="true" className="h-dot w-dot shrink-0 rounded-pill bg-accent" />
								<span className="min-w-0 flex-1">
									<span className="block text-sm text-ink">{provider.name}</span>
									<span className="block truncate text-2xs text-ink-3">
										{provider.credentialType === "oauth" ? "Signed in" : "API key"}
										{provider.source ? ` · ${provider.source}` : ""}
										{!provider.stored && " · from your environment"}
									</span>
								</span>
								{provider.stored ? (
									<button
										type="button"
										className="btn-ghost shrink-0 whitespace-nowrap"
										disabled={busy === provider.id}
										onClick={() => void disconnect(provider)}
									>
										{provider.credentialType === "oauth" ? "Sign out" : "Remove"}
									</button>
								) : (
									<span className="shrink-0 text-2xs text-ink-3">not managed here</span>
								)}
							</li>
						))}
					</ul>
				</Section>
			)}

			<Section
				title="Sign in"
				hint="The quickest route if you already pay for one of these. Your browser opens, or the provider shows a code to enter."
			>
				<ProviderRows
					providers={oauth}
					loading={providers === null}
					busy={busy}
					empty="Every provider that supports signing in is already connected."
					labelFor={(provider) => provider.oauth?.loginLabel ?? `Sign in with ${provider.name}`}
					detailFor={(provider) => provider.oauth?.name ?? ""}
					onPick={(provider) => void begin(provider, "oauth")}
				/>
			</Section>

			<Section
				title="API keys"
				hint="For providers you pay per token, or that have no subscription sign-in."
			>
				<input
					className="field"
					aria-label="Filter API key providers"
					placeholder="Filter by name…"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<ProviderRows
					providers={keys}
					loading={providers === null}
					busy={busy}
					empty={query ? "No provider matches that." : "Every key provider is already connected."}
					labelFor={() => "Add key"}
					detailFor={(provider) => provider.apiKey?.name ?? ""}
					onPick={(provider) => void begin(provider, "api_key")}
				/>
			</Section>

			{/* Last, because it is the only route that asks the user to know
			  * something — a URL and the model names — rather than to recognise a
			  * name they already pay for. */}
			<CustomProviders onCredentialsChanged={onReload} />
		</div>
	);
}

function ProviderRows({
	providers,
	loading,
	busy,
	empty,
	labelFor,
	detailFor,
	onPick,
}: {
	providers: ProviderAuthInfo[];
	loading: boolean;
	busy: string | null;
	empty: string;
	labelFor(provider: ProviderAuthInfo): string;
	detailFor(provider: ProviderAuthInfo): string;
	onPick(provider: ProviderAuthInfo): void;
}) {
	if (loading) return <p className="text-xs text-ink-3">Reading providers…</p>;
	if (providers.length === 0) return <p className="text-xs text-ink-3">{empty}</p>;

	return (
		<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
			{providers.map((provider) => (
				<li key={provider.id} className="flex items-center gap-sm py-xs">
					<span className="min-w-0 flex-1">
						<span className="block text-sm text-ink">{provider.name}</span>
						<span className="block truncate text-2xs text-ink-3">{detailFor(provider)}</span>
					</span>
					<button
						type="button"
						className="btn-outline shrink-0 whitespace-nowrap"
						disabled={busy === provider.id}
						onClick={() => onPick(provider)}
					>
						{busy === provider.id ? "Starting…" : labelFor(provider)}
					</button>
				</li>
			))}
		</ul>
	);
}

function LoginFlow({
	flow,
	answer,
	onAnswer,
	onSubmit,
	onDismiss,
}: {
	flow: ProviderAuthFlow;
	answer: string;
	onAnswer(value: string): void;
	onSubmit(value?: string): void;
	onDismiss(): void;
}) {
	const settled = flow.status === "success" || flow.status === "error" || flow.status === "cancelled";

	return (
		<section
			aria-live="polite"
			className={`border-y px-md py-md ${
				flow.status === "error" ? "border-danger-edge bg-danger-wash" : "border-rule bg-paper-2"
			}`}
		>
			<div className="flex items-start gap-sm">
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium text-ink">
						{flow.method === "oauth" ? "Signing in to" : "Adding a key for"} {flow.providerName}
					</p>
					<p className={`mt-2xs text-xs ${flow.status === "error" ? "text-danger" : "text-ink-3"}`}>
						{statusLine(flow)}
					</p>
				</div>
				<button type="button" className="btn-ghost shrink-0" onClick={onDismiss}>
					{settled ? "Done" : "Cancel"}
				</button>
			</div>

			{flow.notices.length > 0 && (
				<div className="mt-sm flex flex-col gap-xs border-t border-rule-2 pt-sm">
					{flow.notices.map((notice, index) => (
						<Notice key={`${notice.type}-${index}`} notice={notice} />
					))}
				</div>
			)}

			{flow.status === "prompt" && flow.prompt && (
				<div className="mt-sm border-t border-rule-2 pt-sm">
					<p className="label">{flow.prompt.message}</p>
					{flow.prompt.type === "select" ? (
						<div className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
							{flow.prompt.options.map((option) => (
								<button
									key={option.id}
									type="button"
									className="flex items-center justify-between gap-sm py-xs text-left"
									onClick={() => onSubmit(option.id)}
								>
									<span className="text-sm text-ink">{option.label}</span>
									{option.description && (
										<span className="shrink-0 text-2xs text-ink-3">{option.description}</span>
									)}
								</button>
							))}
						</div>
					) : (
						<form
							className="flex gap-xs"
							onSubmit={(event) => {
								event.preventDefault();
								if (answer.trim()) onSubmit();
							}}
						>
							{/* eslint-disable-next-line jsx-a11y/no-autofocus -- the pane exists to ask this */}
							<input
								autoFocus
								type={flow.prompt.type === "secret" ? "password" : "text"}
								className="field min-w-0 flex-1 font-mono text-2xs"
								placeholder={flow.prompt.placeholder}
								value={answer}
								onChange={(event) => onAnswer(event.target.value)}
							/>
							<button type="submit" className="btn-primary shrink-0" disabled={!answer.trim()}>
								Continue
							</button>
						</form>
					)}
				</div>
			)}
		</section>
	);
}

function Notice({ notice }: { notice: ProviderAuthNotice }) {
	if (notice.type === "device_code") {
		return (
			<div className="flex flex-wrap items-center gap-xs text-xs text-ink-2">
				<span>Enter this code:</span>
				<code className="select-all border border-rule bg-paper px-xs py-3xs font-mono text-sm text-ink">
					{notice.userCode}
				</code>
				<button
					type="button"
					className="btn-outline whitespace-nowrap"
					onClick={() => void api.openLink(notice.verificationUri)}
				>
					Open page
				</button>
			</div>
		);
	}

	if (notice.type === "auth_url") {
		return (
			<p className="text-xs leading-relaxed text-ink-2">
				{notice.instructions ?? "Your browser was opened to finish signing in."}{" "}
				<button
					type="button"
					className="underline decoration-rule-strong underline-offset-2"
					onClick={() => void api.openLink(notice.url)}
				>
					Open it again
				</button>
			</p>
		);
	}

	return (
		<p className="text-xs leading-relaxed text-ink-2">
			{notice.message}
			{notice.type === "info" &&
				notice.links?.map((link) => (
					<button
						key={link.url}
						type="button"
						className="ml-xs underline decoration-rule-strong underline-offset-2"
						onClick={() => void api.openLink(link.url)}
					>
						{link.label ?? "Open"}
					</button>
				))}
		</p>
	);
}

function statusLine(flow: ProviderAuthFlow): string {
	switch (flow.status) {
		case "running":
			return "Waiting for the provider…";
		case "prompt":
			return "One more detail is needed.";
		case "success":
			return "Connected. Every Toad Agent teammate can use it now.";
		case "cancelled":
			return "Cancelled.";
		case "error":
			return flow.error ?? "The provider could not finish signing in.";
	}
}
