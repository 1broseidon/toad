/* Hallmark · component: settings pane · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus-visible · active · disabled · loading · error · empty
 * contrast: pass (40–41)
 */
import type { Backend } from "../../../../shared/types";
import { unavailableOf } from "../../../backends";
import { Section } from "../../fields";

type Props = {
	backends: Backend[];
	/** Null until the app's preferences have been read. */
	isDefault: boolean;
	/** Connected provider count for the built-in agent; null while unknown. */
	connectedProviders: number | null;
	refreshing: boolean;
	onRefresh(): void;
	onConfigureToadAgent(): void;
};

/**
 * Which agent a teammate can run on.
 *
 * The built-in agent leads and everything else follows, because that is the
 * actual shape of the choice: one agent ships with the app and the rest are
 * harnesses you already installed. Configuring it opens a pane from here rather
 * than a second entry in the rail — the earlier version had both, which made
 * one thing look like two.
 */
export function Agents({
	backends,
	isDefault,
	connectedProviders,
	refreshing,
	onRefresh,
	onConfigureToadAgent,
}: Props) {
	const toad = backends.find((backend) => backend.id === "pi");
	const harnesses = backends.filter(
		(backend) => backend.id !== "pi" && backend.source === "builtin",
	);
	const registry = backends.filter(
		(backend) => backend.id !== "pi" && backend.source === "registry" && backend.available,
	);

	return (
		<div className="flex flex-col gap-2xl">
			<Section title="Built in">
				<div className="flex flex-wrap items-start gap-md border-y border-rule bg-paper-2 px-md py-md">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-baseline gap-x-xs gap-y-3xs">
							<h3 className="text-base font-medium text-ink">{toad?.name ?? "Toad Agent"}</h3>
							{isDefault && (
								<span className="font-mono text-2xs uppercase tracking-wide text-ink-3">
									default for new teammates
								</span>
							)}
						</div>
						<p className="mt-2xs max-w-prose text-xs leading-relaxed text-ink-3">
							Runs inside Toad, so there is no CLI to install and nothing to start. It uses your own
							model provider.
						</p>
						<p className="mt-xs flex items-center gap-xs text-xs">
							<span
								aria-hidden="true"
								className={`h-dot w-dot shrink-0 rounded-pill ${
									connectedProviders === null
										? "border-2 border-ink-3"
										: connectedProviders > 0
											? "bg-accent"
											: "border-2 border-ink-3"
								}`}
							/>
							<span className={connectedProviders === 0 ? "text-ink-2" : "text-ink-3"}>
								{connectedProviders === null
									? "Checking providers…"
									: connectedProviders > 0
										? `${connectedProviders} provider${connectedProviders === 1 ? "" : "s"} connected`
										: "No provider connected yet"}
							</span>
						</p>
					</div>
					<button
						type="button"
						className="btn-outline shrink-0 whitespace-nowrap"
						onClick={onConfigureToadAgent}
					>
						{connectedProviders === 0 ? "Set up" : "Configure"}
					</button>
				</div>
			</Section>

			<Section
				title="Other agents"
				hint="External harnesses spoken to over the Agent Client Protocol. Toad uses the login their CLI already holds; it installs nothing and stores no credentials for them."
			>
				<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
					{harnesses.map((backend) => (
						<li key={backend.id} className="flex gap-sm py-xs">
							<span
								aria-hidden="true"
								className={`mt-[0.4rem] h-dot w-dot shrink-0 rounded-pill ${
									backend.available ? "bg-accent" : "border-2 border-ink-3"
								}`}
							/>
							<span className="min-w-0 flex-1">
								<span className="block text-sm text-ink">{backend.name}</span>
								<span className="block text-2xs leading-relaxed text-ink-3">
									{backend.available
										? (backend.description ?? backend.id)
										: unavailableOf(backend)}
								</span>
							</span>
						</li>
					))}
				</ul>

				<div className="flex items-center gap-xs">
					<button type="button" className="btn-outline" disabled={refreshing} onClick={onRefresh}>
						{refreshing ? "Checking…" : "Check again"}
					</button>
					<span className="text-xs text-ink-3">
						{harnesses.filter((backend) => backend.available).length} of {harnesses.length} set up
						here
					</span>
				</div>

				{registry.length > 0 && (
					<p className="text-xs leading-relaxed text-ink-3">
						{registry.length} more are in the teammate's agent picker, from the ACP registry. Toad has
						not checked those — picking one downloads it through npx the first time it runs.
					</p>
				)}
			</Section>
		</div>
	);
}
