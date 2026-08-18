import type { Backend } from "../../../../shared/types";
import { Section } from "../../fields";

type Props = {
	backends: Backend[];
	refreshing: boolean;
	onRefresh(): void;
};

export function Backends({ backends, refreshing, onRefresh }: Props) {
	/* Two very different things share one list everywhere else in the app. A
	 * built-in backend is a CLI you installed and signed into; a registry entry
	 * is something npx would download the first time you picked it. Both are
	 * launchable, so both are "available", and stacking thirty of them together
	 * buries the five that are actually yours. */
	const own = backends.filter((backend) => backend.source === "builtin");
	const fetchable = backends.filter(
		(backend) => backend.source !== "builtin" && backend.available,
	);

	return (
		<Section
			title="Backends"
			hint="Agents Toad can drive. Toad finds the CLI you already have and signed into — it does not install anything or hold any credentials of its own."
		>
			<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
				{own.map((backend) => (
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
									: (backend.unavailableReason ?? "not installed")}
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
					{own.filter((backend) => backend.available).length} of {own.length} set up here
				</span>
			</div>

			{fetchable.length > 0 && (
				<p className="text-xs leading-relaxed text-ink-3">
					{fetchable.length} more agents from the ACP registry are in the backend picker. Toad has
					not checked those — picking one downloads it through npx the first time it runs, and
					whether it works depends on its own sign-in.
				</p>
			)}
		</Section>
	);
}
