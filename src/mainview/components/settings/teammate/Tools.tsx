import type { McpServerConfig, Persona } from "../../../../shared/types";
import { Field, Section } from "../../fields";

/**
 * Which of the app's MCP servers this teammate is given.
 *
 * A capability is a property of the teammate rather than of the app: the one
 * that files tickets should not also be able to deploy just because both
 * servers happen to be configured. The choice is deliberately three options and
 * not a free-for-all — a roster that shares its tools is the common case, and
 * "all" should not require re-ticking every box each time a server is added.
 */

type Props = {
	persona: Persona;
	servers: McpServerConfig[] | null;
	running: boolean;
	onPatch(patch: Partial<Persona>): Promise<unknown>;
};

const MODES = [
	{ id: "all", label: "Every server", hint: "Including any added later" },
	{ id: "some", label: "Only the ones I pick", hint: undefined },
	{ id: "none", label: "None", hint: "Just the agent's own tools" },
] as const;

export function Tools({ persona, servers, running, onPatch }: Props) {
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

	return (
		<Section title="Tools">
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
								? "This teammate is running. Tools are fixed when a session starts, so changes apply on its next restart."
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
