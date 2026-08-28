import { useEffect, useState } from "react";
import type {
	AppSettings as Settings,
	McpAuthStatus,
	McpServerConfig,
	WebSearchKeys,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { Field, Section, SettingsToggle } from "../../fields";

/**
 * The desk's tool chest: Toad's own first-class tools, then the MCP servers.
 *
 * Web search lives here, not on any teammate — a capability of the desk, one
 * config for everyone, with the master switch that cuts every outbound query.
 * MCP servers likewise are defined once for the whole app: a server is a
 * piece of infrastructure — a command, a URL and an auth policy — and which
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
	onUpdateSettings(patch: Partial<Settings>): void | Promise<void>;
};

type Draft = {
	name: string;
	kind: "stdio" | "http";
	command: string;
	url: string;
	authMode: "none" | "static" | "oauth";
	headerName: string;
	headerValue: string;
	scopes: string;
	resource: string;
	clientId: string;
	clientSecret: string;
	clientAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
};

const EMPTY: Draft = {
	name: "",
	kind: "stdio",
	command: "",
	url: "",
	authMode: "none",
	headerName: "Authorization",
	headerValue: "",
	scopes: "",
	resource: "",
	clientId: "",
	clientSecret: "",
	clientAuthMethod: "none",
};

export function Mcp({ settings, onUpdateSettings }: Props) {
	const [draft, setDraft] = useState<Draft>(EMPTY);
	const [statuses, setStatuses] = useState<McpAuthStatus[]>([]);
	const [authBusy, setAuthBusy] = useState<string>();
	const [authError, setAuthError] = useState("");
	const servers = settings?.mcpServers ?? [];

	useEffect(() => {
		void api.getMcpAuthStatuses().then(setStatuses);
	}, [servers.map((server) => `${server.id}:${server.type === "http" ? server.auth.mode : "stdio"}`).join("|")]);

	const authReady =
		draft.authMode !== "static"
			? draft.authMode !== "oauth" || !draft.clientId || draft.clientAuthMethod === "none" || Boolean(draft.clientSecret)
			: Boolean(draft.headerName.trim() && draft.headerValue);
	const ready =
		draft.name.trim().length > 0 &&
		(draft.kind === "stdio" ? draft.command.trim().length > 0 : draft.url.trim().length > 0 && authReady);

	const add = async () => {
		if (!ready) return;
		/* The command is split on spaces the way a shell would, because that is
		 * how these are written down everywhere else — in a README, in another
		 * app's config — and asking someone to separate the arguments by hand
		 * invites them to get it wrong. */
		const [command, ...args] = draft.command.trim().split(/\s+/);
		const id = crypto.randomUUID();
		const scopes = draft.scopes.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
		const server: McpServerConfig =
			draft.kind === "stdio"
				? { id, type: "stdio", name: draft.name.trim(), command: command ?? "", args }
				: {
						id,
						type: "http",
						name: draft.name.trim(),
						url: draft.url.trim(),
						auth:
							draft.authMode === "static"
								? { mode: "static", headerNames: [draft.headerName.trim()].filter(Boolean) }
								: draft.authMode === "oauth"
									? {
											mode: "oauth",
											scopes,
											...(draft.resource.trim() ? { resource: draft.resource.trim() } : {}),
											...(draft.clientId.trim()
												? {
														client: {
															clientId: draft.clientId.trim(),
															tokenEndpointAuthMethod: draft.clientAuthMethod,
														},
													}
												: {}),
										}
									: { mode: "none" },
					};
		await onUpdateSettings({ mcpServers: [...servers, server] });
		if (server.type === "http" && server.auth.mode === "static" && draft.headerName.trim()) {
			setStatuses(await api.setMcpStaticHeaders(server.id, { [draft.headerName.trim()]: draft.headerValue }));
		}
		if (server.type === "http" && server.auth.mode === "oauth" && server.auth.client && draft.clientSecret) {
			setStatuses(await api.setMcpOAuthClientSecret(server.id, draft.clientSecret));
		}
		setDraft(EMPTY);
	};

	const remove = async (id: string) => {
		await api.disconnectMcpServer(id).catch(() => undefined);
		await onUpdateSettings({ mcpServers: servers.filter((server) => server.id !== id) });
		setStatuses((current) => current.filter((status) => status.serverId !== id));
	};

	const authorize = async (serverId: string) => {
		setAuthBusy(serverId);
		setAuthError("");
		try {
			setStatuses(await api.authorizeMcpServer(serverId));
		} catch (error) {
			setAuthError(error instanceof Error ? error.message : "Authorization failed");
			setStatuses(await api.getMcpAuthStatuses());
		} finally {
			setAuthBusy(undefined);
		}
	};

	const disconnect = async (serverId: string) => {
		setAuthBusy(serverId);
		try {
			setStatuses(await api.disconnectMcpServer(serverId));
		} finally {
			setAuthBusy(undefined);
		}
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
					<SettingsToggle
						label="Enable web search"
						checked={searchOn}
						onChange={(event) => setSearch({ enabled: event.target.checked })}
					/>
				</Field>

				{/* The providers are a sub-list of the switch above, not settings of
				  * their own: full width, so switch, name and key stay in columns. */}
				{searchOn && (
					<div className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{SEARCH_PROVIDERS.map((provider) => (
							<div key={provider.id} className="flex items-center gap-sm py-xs">
								<label className="flex w-32 shrink-0 items-center gap-xs text-sm text-ink-2">
									<SettingsToggle
										label={provider.name}
										checked={settings?.webSearch?.[provider.id] !== false}
										onChange={(event) => setSearch({ [provider.id]: event.target.checked })}
									/>
									<span>{provider.name}</span>
								</label>
								{provider.keyed ? (
									<input
										type="password"
										autoComplete="off"
										aria-label={`${provider.name} API key`}
										placeholder="Optional API key"
										className="field min-w-0 flex-1 font-mono text-2xs"
										value={settings?.webSearchKeys?.[provider.id] ?? ""}
										onChange={(event) => setSearchKey(provider.id, event.target.value)}
									/>
								) : (
									/* Shaped like the key inputs it stands in for, so a keyless
									 * row keeps the row height and the column edge. */
									<span className="field pointer-events-none flex min-w-0 flex-1 items-center border-transparent bg-transparent text-2xs text-ink-3">
										No key needed
									</span>
								)}
							</div>
						))}
					</div>
				)}

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
					{servers.map((server) => {
						const status = statuses.find((entry) => entry.serverId === server.id);
						const oauth = server.type === "http" && server.auth.mode === "oauth";
						const connected = status?.state === "authorized";
						return (
							<li key={server.id} className="flex items-center gap-sm py-xs">
								<span className="min-w-0 flex-1">
									<span className="block text-sm text-ink">{server.name}</span>
									<span className="block truncate font-mono text-2xs text-ink-3">
										{server.type === "stdio" ? [server.command, ...server.args].join(" ") : server.url}
									</span>
									{oauth && (
										<span className="block text-2xs text-ink-3">
											{status?.state === "authorizing" || authBusy === server.id
												? "Waiting for browser authorization…"
												: connected
													? `Authorized${status.grantedScopes?.length ? ` · ${status.grantedScopes.join(" ")}` : ""}`
													: status?.state === "error"
														? status.error
														: "Authorization required"}
										</span>
									)}
								</span>
								{oauth && (
									<button
										type="button"
										className="btn-outline shrink-0"
										disabled={authBusy === server.id}
										onClick={() => (connected ? disconnect(server.id) : authorize(server.id))}
									>
										{connected ? "Disconnect" : "Authorize"}
									</button>
								)}
								<button
									type="button"
									className="btn-ghost shrink-0"
									aria-label={`Remove ${server.name}`}
									onClick={() => remove(server.id)}
								>
									Remove
								</button>
							</li>
						);
					})}
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
						<div className="flex flex-col gap-xs">
							<input
								className="field font-mono text-2xs"
								aria-label="URL"
								placeholder="https://example.com/mcp"
								value={draft.url}
								onChange={(event) => setDraft({ ...draft, url: event.target.value })}
							/>
							<select
								className="field"
								aria-label="Authentication"
								value={draft.authMode}
								onChange={(event) => setDraft({ ...draft, authMode: event.target.value as Draft["authMode"] })}
							>
								<option value="none">No authentication</option>
								<option value="static">Static header</option>
								<option value="oauth">OAuth 2.1</option>
							</select>
							{draft.authMode === "static" && (
								<div className="flex gap-xs">
									<input
										className="field w-40 font-mono text-2xs"
										aria-label="Header name"
										placeholder="Authorization"
										value={draft.headerName}
										onChange={(event) => setDraft({ ...draft, headerName: event.target.value })}
									/>
									<input
										type="password"
										autoComplete="off"
										className="field min-w-0 flex-1 font-mono text-2xs"
										aria-label="Header value"
										placeholder="Bearer …"
										value={draft.headerValue}
										onChange={(event) => setDraft({ ...draft, headerValue: event.target.value })}
									/>
								</div>
							)}
							{draft.authMode === "oauth" && (
								<>
									<div className="flex gap-xs">
										<input
											className="field min-w-0 flex-1 font-mono text-2xs"
											aria-label="OAuth scopes"
											placeholder="Scopes (space separated)"
											value={draft.scopes}
											onChange={(event) => setDraft({ ...draft, scopes: event.target.value })}
										/>
										<input
											className="field min-w-0 flex-1 font-mono text-2xs"
											aria-label="OAuth resource"
											placeholder="Resource (optional)"
											value={draft.resource}
											onChange={(event) => setDraft({ ...draft, resource: event.target.value })}
										/>
									</div>
									<div className="flex gap-xs">
										<input
											className="field min-w-0 flex-1 font-mono text-2xs"
											aria-label="OAuth client ID"
											placeholder="Client ID (blank uses DCR)"
											value={draft.clientId}
											onChange={(event) => setDraft({ ...draft, clientId: event.target.value })}
										/>
										{draft.clientId && (
											<select
												className="field w-44"
												aria-label="Token endpoint client authentication"
												value={draft.clientAuthMethod}
												onChange={(event) => setDraft({ ...draft, clientAuthMethod: event.target.value as Draft["clientAuthMethod"] })}
											>
												<option value="none">Public client</option>
												<option value="client_secret_basic">Secret (Basic)</option>
												<option value="client_secret_post">Secret (POST)</option>
											</select>
										)}
										{draft.clientId && draft.clientAuthMethod !== "none" && (
											<input
												type="password"
												autoComplete="off"
												className="field min-w-0 flex-1 font-mono text-2xs"
												aria-label="OAuth client secret"
												placeholder="Client secret"
												value={draft.clientSecret}
												onChange={(event) => setDraft({ ...draft, clientSecret: event.target.value })}
											/>
										)}
									</div>
									<p className="text-2xs text-ink-3">Authorization opens on this desktop. Leave Client ID blank for Dynamic Client Registration.</p>
								</>
							)}
						</div>
					)}

					{authError && <p className="text-xs text-danger">{authError}</p>}
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
