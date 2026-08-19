import { useState } from "react";
import type { AppSettings as Settings, McpServerConfig } from "../../../../shared/types";
import { Field, Section } from "../../fields";

/**
 * The MCP servers Toad knows about, defined once for the whole app.
 *
 * Servers live here rather than on each teammate because a server is a piece of
 * infrastructure — a command, a URL, often a token — and which teammate may use
 * it is a separate question, answered per teammate under Tools.
 */

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

	return (
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
	);
}
