import { useEffect, useState } from "react";
import type { TeammateToolLedger, ToolLedgerRow } from "../../../../shared/types";
import { api } from "../../../rpc";
import { Section } from "../../fields";

/**
 * What this teammate actually has, rather than what it was meant to have.
 *
 * The pane above this one is the intent — servers picked, computer on, search
 * narrowed. This is the outcome, and they are not the same thing: on Windows a
 * supplied tool allowlist once deleted every tool Toad provides while the
 * intent screen and the system prompt both went on describing them. So this
 * list is deliberately not a filtered "what is missing" view. Present tools
 * carry their origin and absent tools carry their cause, side by side, because
 * the question people arrive with is "where did my tool go" and the answer is
 * only legible next to the ones that made it.
 */

const STATE_LABEL: Record<ToolLedgerRow["state"], string> = {
	verified: "Loaded",
	declared: "Handed over",
	absent: "Not loaded",
};

const STATE_CLASS: Record<ToolLedgerRow["state"], string> = {
	verified: "text-ink-2",
	declared: "text-ink-3",
	absent: "text-ink-3",
};

const STATE_DOT: Record<ToolLedgerRow["state"], string> = {
	verified: "bg-emerald-500",
	declared: "bg-amber-500",
	absent: "bg-rule-2",
};

const SOURCE_LABEL: Record<ToolLedgerRow["source"], string> = {
	builtin: "Agent",
	toad: "Toad",
	mcp: "MCP",
	computer: "Computer",
	search: "Search",
	subagent: "Subagent",
	plugin: "Plugin",
};

function order(row: ToolLedgerRow): number {
	return row.state === "absent" ? 0 : row.state === "declared" ? 1 : 2;
}

export function ToolLedgerList({ personaId, running }: { personaId: string; running: boolean }) {
	const [ledger, setLedger] = useState<TeammateToolLedger | null | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		setLedger(undefined);
		void api.teammateTools(personaId).then((next) => {
			if (!cancelled) setLedger(next);
		});
		return () => {
			cancelled = true;
		};
	}, [personaId, running]);

	if (ledger === undefined) return null;

	if (ledger === null) {
		return (
			<Section title="What it actually has">
				<p className="text-xs leading-relaxed text-ink-3">
					This teammate has not started yet, so Toad has not watched a tool list arrive. Start it and
					this becomes a line per tool, with a reason for anything missing.
				</p>
			</Section>
		);
	}

	const rows = [...ledger.rows].sort(
		(a, b) => order(a) - order(b) || a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
	);
	const missing = rows.filter((row) => row.state === "absent").length;

	return (
		<Section
			title="What it actually has"
			hint={
				ledger.agentKind === "acp"
					? `Recorded when this teammate last started on ${ledger.backendId}. An ACP backend spawns its own MCP servers and never reports what it loaded, so a tool Toad handed over reads "Handed over" until it is seen arriving on a Toad-owned endpoint.`
					: "Recorded when this teammate last started. Toad builds the built-in agent's tool array itself, so anything loaded here is loaded."
			}
		>
			{missing > 0 && (
				<p className="text-xs leading-relaxed text-ink-2">
					{missing} tool{missing === 1 ? " is" : "s are"} not loaded. Each one says why.
				</p>
			)}
			<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
				{rows.map((row) => (
					<li key={`${row.source}-${row.origin}-${row.name}`} className="flex gap-xs py-xs">
						<span
							className={`mt-[0.4rem] h-[0.4rem] w-[0.4rem] shrink-0 rounded-full ${STATE_DOT[row.state]}`}
							aria-hidden
						/>
						<span className="min-w-0 flex-1">
							<span className="flex flex-wrap items-baseline gap-2xs">
								<span className="font-mono text-sm text-ink">{row.name}</span>
								<span className="text-2xs uppercase tracking-wide text-ink-3">
									{SOURCE_LABEL[row.source]}
									{row.origin && row.origin !== SOURCE_LABEL[row.source] ? ` · ${row.origin}` : ""}
								</span>
								<span className={`text-2xs ${STATE_CLASS[row.state]}`}>{STATE_LABEL[row.state]}</span>
							</span>
							<span className="mt-2xs block text-xs leading-relaxed text-ink-3">{row.reason}</span>
						</span>
					</li>
				))}
			</ul>
		</Section>
	);
}
