import { useState } from "react";
import type { AppSettings as Settings, McpServerConfig, WebSearchKeys } from "../../../../shared/types";
import { Field, Section, SettingsToggle } from "../../fields";

/**
 * The desk's tool chest: Toad's own first-class tools, then the MCP servers.
 *
 * Web search lives here, not on any teammate — a capability of the desk, one
 * config for everyone, with the master switch that cuts every outbound query.
 * MCP servers likewise are defined once for the whole app: a server is a
 * piece of infrastructure — a command, a URL, often a token — and which
 * teammate may use it is a separate question, answered per teammate.
 */

const SEARCH_PROVIDERS = [
	{ id: "parallel", name: "Parallel", keyed: false },
	{ id: "exa", name: "Exa", keyed: true },
	{ id: "firecrawl", name: "Firecrawl", keyed: true },
	{ id: "keenable", name: "Keenable", keyed: true },
] as const;

type Props = {
	settings: Settings | null;
	onUpdateSettings(patch: Partial<Settings>): void;
};

type Draft = { name: string; kind: "stdio" | "http"; command: string; url: string };

const EMPTY: Draft = { name: "", kind: "stdio", command: "", url: "" };

export function Mcp({ settings, onUpdateSettings }: Props) {
	const [draft, setDraft] = useState<Draft>(EMPTY);
	const servers = settings?.mcpServers ?? [];

	const ready =
		draft.name.trim().length > 0 &&
		(draft.kind === "stdio" ? draft.command.trim().length > 0 : draft.url.trim().length > 0);

	const add = () => {
		if (!ready) return;
		/* The command is split on spaces the way a shell would, because that is
		 * how these are written down everywhere else — in a README, in another
		 * app's config — and asking someone to separate the arguments by hand
		 * invites them to get it wrong. */
		const [command, ...args] = draft.command.trim().split(/\s+/);
		const server: McpServerConfig =
			draft.kind === "stdio"
				? { id: crypto.randomUUID(), type: "stdio", name: draft.name.trim(), command: command ?? "", args }
				: { id: crypto.randomUUID(), type: "http", name: draft.name.trim(), url: draft.url.trim() };
		onUpdateSettings({ mcpServers: [...servers, server] });
		setDraft(EMPTY);
	};

	const remove = (id: string) => {
		onUpdateSettings({ mcpServers: servers.filter((server) => server.id !== id) });
	};

	const searchOn = settings?.webSearch?.enabled !== false;
	const setSearch = (patch: Partial<NonNullable<Settings["webSearch"]>>) => {
		onUpdateSettings({ webSearch: { ...settings?.webSearch, ...patch } });
	};
	const setSearchKey = (id: keyof WebSearchKeys, value: string) => {
		onUpdateSettings({
			webSearchKeys: { ...settings?.webSearchKeys, [id]: value || undefined },
		});
	};

	return (
		<div className="flex flex-col gap-2xl">
			<Section title="Toad tools">
				<Field
					label="Web search"
					hint="Every Toad Agent teammate can search the public web. Providers are tried in rotation; keys are optional. The switch cuts every outbound query at once."
				>
					<div className="flex min-w-64 flex-col gap-xs">
						<div className="flex items-center gap-xs">
							<SettingsToggle
								label="Enable web search"
								checked={searchOn}
								onChange={(event) => setSearch({ enabled: event.target.checked })}
							/>
							<span className="text-sm text-ink-2">{searchOn ? "On" : "Off"}</span>
						</div>
						{searchOn && (
							<div className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
								{SEARCH_PROVIDERS.map((provider) => (
									<div key={provider.id} className="flex items-center gap-sm py-xs">
										<label className="flex min-w-24 items-center gap-xs text-sm text-ink-2">
											<SettingsToggle
												label={provider.name}
												checked={settings?.webSearch?.[provider.id] !== false}
												onChange={(event) => setSearch({ [provider.id]: event.target.checked })}
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
												value={settings?.webSearchKeys?.[provider.id] ?? ""}
												onChange={(event) => setSearchKey(provider.id, event.target.value)}
											/>
										)}
									</div>
								))}
							</div>
						)}
					</div>
				</Field>

				<Field
					label="Computer"
					hint="A containerized desktop each teammate can drive — screen, browser, shell, files. Switched on per teammate, under their own Tools."
				>
					<span className="text-sm text-ink-3">Per teammate</span>
				</Field>
			</Section>

			<Section
				title="MCP servers"
				hint="Tools any teammate can be given. Added here once; which teammates get them is set per teammate, under Tools."
			>
			{servers.length > 0 && (
				<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
					{servers.map((server) => (
						<li key={server.id} className="flex items-center gap-sm py-xs">
							<span className="min-w-0 flex-1">
								<span className="block text-sm text-ink">{server.name}</span>
								<span className="block truncate font-mono text-2xs text-ink-3">
									{server.type === "stdio"
										? [server.command, ...server.args].join(" ")
										: server.url}
								</span>
							</span>
							<button
								type="button"
								className="btn-ghost shrink-0"
								aria-label={`Remove ${server.name}`}
								onClick={() => remove(server.id)}
							>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}

			{servers.length === 0 && (
				<p className="text-xs leading-relaxed text-ink-3">
					No servers yet. Teammates run with their agent's own tools until you add one.
				</p>
			)}

			<Field label="Add a server" hint="Changes reach a teammate the next time it starts.">
				<div className="flex flex-col gap-xs">
					<div className="flex gap-xs">
						<input
							className="field min-w-0 flex-1"
							aria-label="Server name"
							placeholder="Name"
							value={draft.name}
							onChange={(event) => setDraft({ ...draft, name: event.target.value })}
						/>
						<select
							className="field w-28 shrink-0"
							aria-label="Server type"
							value={draft.kind}
							onChange={(event) =>
								setDraft({ ...draft, kind: event.target.value as Draft["kind"] })
							}
						>
							<option value="stdio">Command</option>
							<option value="http">HTTP</option>
						</select>
					</div>

					{draft.kind === "stdio" ? (
						<input
							className="field font-mono text-2xs"
							aria-label="Command"
							placeholder="npx -y @modelcontextprotocol/server-filesystem /some/path"
							value={draft.command}
							onChange={(event) => setDraft({ ...draft, command: event.target.value })}
						/>
					) : (
						<input
							className="field font-mono text-2xs"
							aria-label="URL"
							placeholder="https://example.com/mcp"
							value={draft.url}
							onChange={(event) => setDraft({ ...draft, url: event.target.value })}
						/>
					)}

					<div className="flex items-center gap-xs">
						<button type="button" className="btn-outline" disabled={!ready} onClick={add}>
							Add server
						</button>
						<span className="text-xs text-ink-3">
							{servers.length} configured
						</span>
					</div>
				</div>
			</Field>
			</Section>
		</div>
	);
}
