import type {
	AppSettings,
	McpServerConfig,
	Persona,
	WebSearchKeys,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { Field, Section, SettingsToggle } from "../../fields";
import { InfoIcon } from "../../icons";

/**
 * Which of the app's MCP servers this teammate is given.
 *
 * A capability is a property of the teammate rather than of the app: the one
 * that files tickets should not also be able to deploy just because both
 * servers happen to be configured. The choice is deliberately three options and
 * not a free-for-all — a roster that shares its tools is the common case, and
 * "all" should not require re-ticking every box each time a server is added.
 *
 * The computer sits above the servers and outside the policy: it is not one
 * of the app's servers a policy selects from, but a machine this teammate
 * either has or does not.
 */

/** The in-repo spec, until published docs exist. Deliberately not a bare
 * domain: linking a domain nobody here owns hands the info icon to whoever
 * registers it. */
const COMPUTER_DOCS_URL = "https://github.com/1broseidon/toad/blob/main/docs/computer.md";

type Props = {
	persona: Persona;
	servers: McpServerConfig[] | null;
	appSettings: AppSettings | null;
	running: boolean;
	onPatch(patch: Partial<Persona>): Promise<unknown>;
	onUpdateAppSettings(patch: Partial<AppSettings>): Promise<unknown>;
};

const MODES = [
	{ id: "all", label: "Every server", hint: "Including any added later" },
	{ id: "some", label: "Only the ones I pick", hint: undefined },
	{ id: "none", label: "None", hint: "Just the agent's own tools" },
] as const;

const SEARCH_PROVIDERS = [
	{ id: "parallel", name: "Parallel", keyed: false },
	{ id: "exa", name: "Exa", keyed: true },
	{ id: "firecrawl", name: "Firecrawl", keyed: true },
	{ id: "keenable", name: "Keenable", keyed: true },
] as const;

export function Tools({
	persona,
	servers,
	appSettings,
	running,
	onPatch,
	onUpdateAppSettings,
}: Props) {
	const policy = persona.mcpPolicy;
	const available = servers ?? [];

	const setMode = (mode: "all" | "some" | "none") => {
		void onPatch({ mcpPolicy: { ...policy, mode } });
	};

	const toggle = (id: string) => {
		const serverIds = policy.serverIds.includes(id)
			? policy.serverIds.filter((item) => item !== id)
			: [...policy.serverIds, id];
		void onPatch({ mcpPolicy: { ...policy, serverIds } });
	};

	const setComputer = (enabled: boolean) => {
		void onPatch({ computer: { ...persona.computer, enabled } });
	};

	const setSearchProvider = (id: (typeof SEARCH_PROVIDERS)[number]["id"], enabled: boolean) => {
		void onPatch({ webSearch: { ...persona.webSearch, [id]: enabled } });
	};

	const setSearchKey = (id: keyof WebSearchKeys, value: string) => {
		void onUpdateAppSettings({
			webSearchKeys: { ...appSettings?.webSearchKeys, [id]: value || undefined },
		});
	};

	return (
		<Section title="Tools">
			<Field
				label="Computer"
				hint={
					persona.computer?.enabled
						? running
							? "Toad restarts this teammate while idle, or waits for its current reply to finish, so the computer tools attach without interrupting work. The machine sleeps when idle and wakes on the first tool call."
							: "A containerized desktop this teammate drives through its tools: screen, mouse and keyboard, a browser, a shell, files. It wakes on the first tool call."
						: "Give this teammate its own containerized desktop: screen, mouse and keyboard, a browser, a shell, files."
				}
			>
				<div className="flex items-center gap-xs">
					<SettingsToggle
						label="Enable computer"
						checked={persona.computer?.enabled ?? false}
						onChange={(event) => setComputer(event.target.checked)}
					/>
					<button
						type="button"
						className="flex items-center text-ink-3 hover:text-ink-2"
						aria-label="About teammate computers"
						title="About teammate computers"
						onClick={() => void api.openLink(COMPUTER_DOCS_URL)}
					>
						<InfoIcon />
					</button>
				</div>
			</Field>

			<Field
				label="Web search"
				hint={
					running
						? "Provider changes apply when this teammate next restarts. Keys are optional and shared across teammates."
						: "Searches the public web. Providers are tried in rotation; optional keys are shared across teammates."
				}
			>
				<div className="flex min-w-64 flex-col divide-y divide-rule-2 border-y border-rule-2">
					{SEARCH_PROVIDERS.map((provider) => (
						<div key={provider.id} className="flex items-center gap-sm py-xs">
							<label className="flex min-w-24 items-center gap-xs text-sm text-ink-2">
								<input
									type="checkbox"
									role="switch"
									checked={persona.webSearch?.[provider.id] !== false}
									onChange={(event) => setSearchProvider(provider.id, event.target.checked)}
								/>
								<span>{provider.name}</span>
							</label>
							{provider.keyed && (
								<input
									type="password"
									autoComplete="off"
									aria-label={`${provider.name} API key`}
									placeholder="Optional API key"
									className="field min-w-0 flex-1 font-mono text-2xs"
									value={appSettings?.webSearchKeys?.[provider.id] ?? ""}
									onChange={(event) => setSearchKey(provider.id, event.target.value)}
								/>
							)}
						</div>
					))}
				</div>
			</Field>

			{available.length === 0 ? (
				<p className="text-xs leading-relaxed text-ink-3">
					No MCP servers are configured yet. Add one under Settings → MCP servers, and it becomes
					available to teammates here.
				</p>
			) : (
				<>
					<Field
						label="MCP servers"
						hint={
							running
								? "Toad restarts this teammate while idle, or waits for its current reply to finish, so tool changes apply without interrupting work."
								: "Tools are attached when the teammate starts."
						}
					>
						<div className="flex flex-col gap-2xs">
							{MODES.map((mode) => (
								<label key={mode.id} className="flex items-center gap-xs text-sm text-ink-2">
									<input
										type="radio"
										name={`mcp-mode-${persona.id}`}
										checked={policy.mode === mode.id}
										onChange={() => setMode(mode.id)}
									/>
									<span>{mode.label}</span>
									{mode.hint && <span className="text-2xs text-ink-3">{mode.hint}</span>}
								</label>
							))}
						</div>
					</Field>

					{policy.mode === "some" && (
						<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
							{available.map((server) => (
								<li key={server.id} className="py-xs">
									<label className="flex items-center gap-xs">
										<input
											type="checkbox"
											role="switch"
											checked={policy.serverIds.includes(server.id)}
											onChange={() => toggle(server.id)}
										/>
										<span className="min-w-0 flex-1">
											<span className="block text-sm text-ink">{server.name}</span>
											<span className="block truncate font-mono text-2xs text-ink-3">
												{server.type === "stdio"
													? [server.command, ...server.args].join(" ")
													: server.url}
											</span>
										</span>
									</label>
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</Section>
	);
}
