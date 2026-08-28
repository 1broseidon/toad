/* Hallmark · component: settings detail pane · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus-visible · active · disabled · loading · error · success · empty
 * contrast: pass (40–41)
 */
import { useEffect, useState } from "react";
import type {
	CustomProviderApi,
	CustomProviderInfo,
	CustomProviderInput,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { Field, Section } from "../../fields";

/**
 * Providers Toad has no built-in knowledge of: a URL and a list of model names.
 *
 * This is the whole difference between the section above and this one. There,
 * the provider owns the questions and pi asks them; here there are no questions
 * to own, because nobody has met this endpoint before. So it is a plain form —
 * and the presets exist because four of the five endpoints anyone adds are the
 * same four, and typing `http://localhost:11434/v1` from memory is where this
 * goes wrong.
 *
 * The key field is write-only in both directions: what the user types is never
 * read back, and a stored key is described but never shown.
 */

type Props = {
	/** Refreshes the sign-in list above, which gains a row when a key is stored. */
	onCredentialsChanged(): Promise<unknown>;
};

type Draft = {
	id: string;
	baseUrl: string;
	api: CustomProviderApi;
	models: string;
	apiKey: string;
	lenient: boolean;
};

const API_LABELS: Array<{ id: CustomProviderApi; label: string }> = [
	{ id: "openai-completions", label: "OpenAI chat completions" },
	{ id: "openai-responses", label: "OpenAI responses" },
	{ id: "anthropic-messages", label: "Anthropic messages" },
	{ id: "google-generative-ai", label: "Google generative AI" },
];

/**
 * `lenient` is one switch over two pi flags because they fail together: a server
 * that rejects the `developer` role is the same server that rejects
 * `reasoning_effort`, and asking a user which of the two their llama.cpp build
 * dislikes is asking them to read a stack trace.
 */
const PRESETS: Array<{ id: string; label: string } & Partial<Draft>> = [
	{ id: "blank", label: "Custom…" },
	{
		id: "ollama",
		label: "Ollama (local)",
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		lenient: true,
	},
	{
		id: "ollama-cloud",
		label: "Ollama Cloud",
		baseUrl: "https://ollama.com/v1",
		api: "openai-completions",
	},
	{
		id: "lmstudio",
		label: "LM Studio",
		baseUrl: "http://localhost:1234/v1",
		api: "openai-completions",
		lenient: true,
	},
	{
		id: "vllm",
		label: "vLLM",
		baseUrl: "http://localhost:8000/v1",
		api: "openai-completions",
		lenient: true,
	},
];

const EMPTY: Draft = {
	id: "",
	baseUrl: "",
	api: "openai-completions",
	models: "",
	apiKey: "",
	lenient: false,
};

/** Commas, spaces and newlines all mean "next model": people paste all three. */
function parseModels(text: string): string[] {
	return text
		.split(/[\s,]+/)
		.map((model) => model.trim())
		.filter(Boolean);
}

function authLine(provider: CustomProviderInfo): string {
	switch (provider.auth) {
		case "credential":
			return "Key stored by Toad";
		case "environment":
			return "Key read from your environment";
		case "local":
			return "No key needed";
		case "literal":
			return "Key written in models.json";
		case "none":
			return "No key yet — its models stay hidden until there is one";
	}
}

export function CustomProviders({ onCredentialsChanged }: Props) {
	const [providers, setProviders] = useState<CustomProviderInfo[] | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [busy, setBusy] = useState<"save" | string | null>(null);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState("");

	useEffect(() => {
		void reload();
	}, []);

	const reload = async () => {
		setError("");
		try {
			setProviders(await api.listCustomProviders());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setProviders([]);
		}
	};

	const ready = draft.id.trim() && draft.baseUrl.trim() && parseModels(draft.models).length > 0;

	const applyPreset = (presetId: string) => {
		const preset = PRESETS.find((entry) => entry.id === presetId);
		if (!preset || preset.id === "blank") return;
		setDraft((current) => ({
			...current,
			id: current.id || preset.id,
			baseUrl: preset.baseUrl ?? current.baseUrl,
			api: preset.api ?? current.api,
			lenient: preset.lenient ?? current.lenient,
		}));
	};

	const edit = (provider: CustomProviderInfo) => {
		setEditing(provider.id);
		setOpen(true);
		setError("");
		setSaved("");
		setDraft({
			id: provider.id,
			baseUrl: provider.baseUrl,
			api: provider.api,
			models: provider.models.join("\n"),
			/* Never prefilled: this pane cannot read a key back, and an input that
			 * looked full would make "leave it alone" indistinguishable from
			 * "replace it with these bullets". */
			apiKey: "",
			lenient: false,
		});
	};

	const cancel = () => {
		setOpen(false);
		setEditing(null);
		setDraft(EMPTY);
		setError("");
	};

	const save = async () => {
		if (!ready || busy) return;
		setBusy("save");
		setError("");
		setSaved("");
		const provider: CustomProviderInput = {
			id: draft.id.trim(),
			baseUrl: draft.baseUrl.trim(),
			api: draft.api,
			models: parseModels(draft.models),
			apiKey: draft.apiKey.trim() || undefined,
			...(draft.lenient
				? { compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }
				: {}),
		};
		try {
			setProviders(await api.saveCustomProvider(provider));
			setSaved(provider.id);
			setDraft(EMPTY);
			setOpen(false);
			setEditing(null);
			if (provider.apiKey && !provider.apiKey.startsWith("$")) await onCredentialsChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const remove = async (provider: CustomProviderInfo) => {
		setBusy(provider.id);
		setError("");
		setSaved("");
		try {
			setProviders(await api.removeCustomProvider(provider.id));
			if (editing === provider.id) cancel();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	return (
		<Section
			title="Your own providers"
			hint="Anything that speaks one of these APIs at a URL: Ollama, LM Studio, vLLM, a gateway of your own. Toad keeps these definitions in its own folder and never edits the pi CLI's."
		>
			{error && (
				<p
					role="alert"
					className="border-y border-danger-edge bg-danger-wash px-md py-xs text-xs text-danger"
				>
					{error}
				</p>
			)}

			{providers === null ? (
				<p className="text-xs text-ink-3">Reading your providers…</p>
			) : providers.length === 0 ? (
				<p className="text-xs leading-relaxed text-ink-3">
					None yet. Add one and its models join the picker under Custom.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
					{providers.map((provider) => (
						<li key={provider.id} className="flex items-center gap-sm py-xs">
							<span
								aria-hidden="true"
								className={`h-dot w-dot shrink-0 rounded-pill ${
									provider.auth === "none" ? "bg-rule-strong" : "bg-accent"
								}`}
							/>
							<span className="min-w-0 flex-1">
								<span className="block text-sm text-ink">{provider.name}</span>
								<span className="block truncate font-mono text-2xs text-ink-3">
									{provider.baseUrl} · {provider.models.length}{" "}
									{provider.models.length === 1 ? "model" : "models"}
								</span>
								<span className="block truncate text-2xs text-ink-3">
									{authLine(provider)}
									{provider.advanced && " · has settings this form does not show"}
								</span>
							</span>
							<button
								type="button"
								className="btn-ghost shrink-0"
								disabled={busy !== null}
								onClick={() => edit(provider)}
							>
								Edit
							</button>
							<button
								type="button"
								className="btn-ghost shrink-0"
								aria-label={`Remove ${provider.name}`}
								disabled={busy !== null}
								onClick={() => void remove(provider)}
							>
								{busy === provider.id ? "Removing…" : "Remove"}
							</button>
						</li>
					))}
				</ul>
			)}

			{saved && !open && (
				<p aria-live="polite" className="text-xs leading-relaxed text-ink-2">
					Saved. {saved}'s models are in the picker now; a teammate that is already running
					lists them the next time it starts.
				</p>
			)}

			{!open ? (
				<div>
					<button type="button" className="btn-outline" onClick={() => setOpen(true)}>
						Add a provider
					</button>
				</div>
			) : (
				<Field
					label={editing ? `Edit ${editing}` : "Add a provider"}
					hint="Model names are whatever the server calls them — `ollama list` or the endpoint's own /v1/models."
				>
					<div className="flex flex-col gap-xs">
						{!editing && (
							<select
								className="field"
								aria-label="Start from"
								defaultValue="blank"
								onChange={(event) => applyPreset(event.target.value)}
							>
								{PRESETS.map((preset) => (
									<option key={preset.id} value={preset.id}>
										{preset.label}
									</option>
								))}
							</select>
						)}

						<div className="flex gap-xs">
							<input
								className="field min-w-0 flex-1"
								aria-label="Provider name"
								placeholder="ollama"
								autoComplete="off"
								value={draft.id}
								onChange={(event) => setDraft({ ...draft, id: event.target.value })}
							/>
							<select
								className="field w-48 shrink-0"
								aria-label="API"
								value={draft.api}
								onChange={(event) =>
									setDraft({ ...draft, api: event.target.value as CustomProviderApi })
								}
							>
								{API_LABELS.map((entry) => (
									<option key={entry.id} value={entry.id}>
										{entry.label}
									</option>
								))}
							</select>
						</div>

						<input
							className="field font-mono text-2xs"
							aria-label="Base URL"
							placeholder="http://localhost:11434/v1"
							autoComplete="off"
							value={draft.baseUrl}
							onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
						/>

						<textarea
							className="field min-h-16 font-mono text-2xs"
							aria-label="Models"
							placeholder={"llama3.1:8b\nqwen2.5-coder:7b"}
							value={draft.models}
							onChange={(event) => setDraft({ ...draft, models: event.target.value })}
						/>

						<input
							type="password"
							className="field font-mono text-2xs"
							aria-label="API key"
							autoComplete="off"
							placeholder={
								editing ? "New key, or leave blank to keep the current one" : "API key, or $ENV_VAR"
							}
							value={draft.apiKey}
							onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
						/>
						<p className="text-2xs leading-relaxed text-ink-3">
							A key is kept with your other logins, never in the provider file. Write{" "}
							<code className="font-mono">$MY_KEY</code> instead to read one from the
							environment, or leave it empty for a local server that ignores keys.
						</p>

						<label className="flex items-start gap-xs text-xs leading-relaxed text-ink-2">
							<input
								type="checkbox"
								className="mt-3xs shrink-0"
								checked={draft.lenient}
								onChange={(event) => setDraft({ ...draft, lenient: event.target.checked })}
							/>
							<span>
								This server is strict about OpenAI fields — send a system role and no
								reasoning effort. Usual for Ollama, LM Studio and vLLM.
							</span>
						</label>

						<div className="flex items-center gap-xs">
							<button
								type="button"
								className="btn-primary"
								disabled={!ready || busy !== null}
								onClick={() => void save()}
							>
								{busy === "save" ? "Saving…" : editing ? "Save changes" : "Add provider"}
							</button>
							<button
								type="button"
								className="btn-ghost"
								disabled={busy !== null}
								onClick={cancel}
							>
								Cancel
							</button>
						</div>
					</div>
				</Field>
			)}
		</Section>
	);
}
