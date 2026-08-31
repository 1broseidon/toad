import { useEffect, useState } from "react";
import type {
	PluginInfo,
	PluginManifest,
	PluginReachRow,
	PluginState,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { Field, Section } from "../../fields";

/**
 * The way in, the way out, and the way to see it.
 *
 * A plugin is a process this desk runs and a set of tools every teammate on it
 * can call, so all three have to be one screen: what is installed, what state
 * it is in and why, what it may reach, and a button that removes it. A feature
 * you can only add is a one-way door.
 *
 * The install is two steps on purpose. `previewPlugin` reads the manifest and
 * answers with the tool list and the grants; `installPlugin` takes the person's
 * yes. Folding them into one call with a dialog inside would make the grant
 * screen decorative, which is how a permission prompt becomes a click-through.
 * The reach list beside it is not written here — it comes back from the same
 * decision function that will refuse the calls, so what this screen predicts
 * and what the gate does cannot drift apart.
 */

const STATE_LABEL: Record<PluginState, string> = {
	installed: "Installed",
	running: "Running",
	stopped: "Stopped",
	failed: "Failed",
};

const STATE_DOT: Record<PluginState, string> = {
	installed: "bg-amber-500",
	running: "bg-emerald-500",
	stopped: "bg-rule-2",
	failed: "bg-rose-500",
};

type Preview =
	| { ok: true; manifest: PluginManifest; reach: PluginReachRow[] }
	| { ok: false; problems: string[] };

function ReachList({ reach }: { reach: PluginReachRow[] }) {
	return (
		<ul className="flex flex-col gap-2xs">
			{reach.map((row) => (
				<li key={`${row.action}-${row.target}`} className="flex gap-xs text-xs">
					<span className={row.allowed ? "text-ink-2" : "text-ink-3"}>{row.allowed ? "yes" : "no"}</span>
					<span className="min-w-0 flex-1">
						<span className="font-mono text-ink-2">
							{row.action}
							{row.target ? ` ${row.target}` : ""}
						</span>
						<span className="ml-xs text-ink-3">{row.reason}</span>
					</span>
				</li>
			))}
		</ul>
	);
}

export function Plugins() {
	const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
	const [source, setSource] = useState("");
	const [preview, setPreview] = useState<Preview | null>(null);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");

	const reload = async () => setPlugins(await api.listPlugins());

	useEffect(() => {
		void reload();
	}, []);

	const look = async () => {
		setNote("");
		setBusy(true);
		try {
			setPreview(await api.previewPlugin(source.trim()));
		} finally {
			setBusy(false);
		}
	};

	const install = async () => {
		setBusy(true);
		setNote("");
		try {
			const result = await api.installPlugin(source.trim(), true);
			if (result.ok) {
				setPreview(null);
				setSource("");
				setNote(`${result.plugin.name} is installed. Running teammates restart to pick up its tools.`);
			} else {
				setNote(result.problems.join("\n"));
			}
			await reload();
		} finally {
			setBusy(false);
		}
	};

	const uninstall = async (plugin: PluginInfo) => {
		setBusy(true);
		try {
			const report = await api.uninstallPlugin(plugin.id);
			const touched =
				report.teammates.length > 0
					? ` ${report.teammates.length} teammate${report.teammates.length === 1 ? "" : "s"} lost its tools.`
					: "";
			setNote(
				report.removed
					? `${plugin.name} was removed.${touched}${report.pending.length > 0 ? ` Not finished: ${report.pending.join("; ")}` : ""}`
					: report.pending.join("; "),
			);
			await reload();
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Section
				title="Plugins"
				hint="A plugin is a process this desk supervises, speaking MCP. Toad stands between it and your teammates: it answers their tool list from the manifest and sees every call, so a plugin's tools are enumerable on every agent — the built-in one and every ACP backend alike."
			>
				{plugins === null ? null : plugins.length === 0 ? (
					<p className="text-xs leading-relaxed text-ink-3">
						No plugins are installed on this desk.
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{plugins.map((plugin) => (
							<li key={plugin.id} className="flex flex-col gap-xs py-sm">
								<div className="flex items-baseline gap-xs">
									<span
										className={`mt-[0.4rem] h-[0.4rem] w-[0.4rem] shrink-0 rounded-full ${STATE_DOT[plugin.state]}`}
										aria-hidden
									/>
									<span className="min-w-0 flex-1">
										<span className="block text-sm text-ink">
											{plugin.name}{" "}
											<span className="text-2xs text-ink-3">
												{plugin.version} · {STATE_LABEL[plugin.state]}
											</span>
										</span>
										<span className="block font-mono text-2xs text-ink-3">{plugin.id}</span>
									</span>
									<button
										type="button"
										className="text-xs text-ink-2 hover:text-ink"
										disabled={busy}
										onClick={() =>
											void (plugin.state === "running"
												? api.stopPlugin(plugin.id)
												: api.startPlugin(plugin.id)
											).then(reload)
										}
									>
										{plugin.state === "running" ? "Stop" : "Start"}
									</button>
									<button
										type="button"
										className="text-xs text-ink-3 hover:text-ink"
										disabled={busy}
										onClick={() => void uninstall(plugin)}
									>
										Uninstall
									</button>
								</div>

								<p className="text-xs leading-relaxed text-ink-3">{plugin.reason}</p>

								<div className="flex flex-col gap-2xs">
									<p className="text-2xs uppercase tracking-wide text-ink-3">Tools</p>
									{plugin.tools.map((tool) => (
										<p key={tool.name} className="text-xs text-ink-3">
											<span className="font-mono text-ink-2">{tool.name}</span> — {tool.description}
											{tool.subagentInherits ? " · subagents inherit it" : " · subagents do not"}
										</p>
									))}
								</div>

								<div className="flex flex-col gap-2xs">
									<p className="text-2xs uppercase tracking-wide text-ink-3">May reach</p>
									<ReachList reach={plugin.reach} />
								</div>

								{plugin.stderr.length > 0 && (
									<details>
										<summary className="cursor-pointer text-2xs uppercase tracking-wide text-ink-3">
											Last output
										</summary>
										<pre className="mt-2xs max-h-40 overflow-auto whitespace-pre-wrap font-mono text-2xs text-ink-3">
											{plugin.stderr.slice(-40).join("\n")}
										</pre>
									</details>
								)}
							</li>
						))}
					</ul>
				)}
			</Section>

			<Section title="Install a plugin">
				<Field
					label="Directory"
					hint="A folder holding toad-plugin.json and its entry point. Toad reads the manifest, starts the process once, and refuses the install if what it serves is not what the manifest declares."
				>
					<div className="flex gap-xs">
						<input
							className="min-w-0 flex-1 font-mono text-sm"
							value={source}
							placeholder="/path/to/plugin"
							onChange={(event) => {
								setSource(event.target.value);
								setPreview(null);
							}}
						/>
						<button
							type="button"
							className="text-xs text-ink-2 hover:text-ink"
							disabled={busy || !source.trim()}
							onClick={() => void look()}
						>
							Read it
						</button>
					</div>
				</Field>

				{preview && !preview.ok && (
					<ul className="flex flex-col gap-2xs">
						{preview.problems.map((problem) => (
							<li key={problem} className="text-xs leading-relaxed text-ink-2">
								{problem}
							</li>
						))}
					</ul>
				)}

				{preview?.ok && (
					<Field
						label={`${preview.manifest.name} ${preview.manifest.version}`}
						hint="Everything this plugin would add, and everything it asks to reach. Nothing is installed until you agree."
					>
						<div className="flex flex-col gap-xs">
							<div className="flex flex-col gap-2xs">
								{preview.manifest.tools.map((tool) => (
									<p key={tool.name} className="text-xs text-ink-3">
										<span className="font-mono text-ink-2">{tool.name}</span> — {tool.description}
									</p>
								))}
							</div>
							<ReachList reach={preview.reach} />
							<div>
								<button
									type="button"
									className="text-xs text-ink-2 hover:text-ink"
									disabled={busy}
									onClick={() => void install()}
								>
									Install and grant these
								</button>
							</div>
						</div>
					</Field>
				)}

				{note && <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-2">{note}</p>}
			</Section>
		</>
	);
}
