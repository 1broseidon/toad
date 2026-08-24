import { useEffect, useRef, useState } from "react";
import type { Backend, Persona, PersonaDraft } from "../../shared/types";
import { BackendOptions } from "../backends";
import { webClient } from "../platform";
import { api, on } from "./../rpc";
import { FaceIcon } from "./FaceIcon";
import { InfoIcon } from "./icons";

/** The in-repo spec, until published docs exist. Deliberately not a bare
 * domain: linking a domain nobody here owns hands the info icon to whoever
 * registers it. */
const COMPUTER_DOCS_URL = "https://github.com/1broseidon/toad/blob/main/docs/computer.md";

/**
 * Creating a teammate, as a window of its own.
 *
 * Two screens. The first is the form: name, harness, model, persona — the
 * things the person decides. The second is the hatch: a narrated wait while
 * the new agent is spawned and asked to choose its own face. The face is
 * deliberately not choosable here: the agent makes it for itself, and the
 * person gets to meet it. (Identity offers a re-roll later, once they have
 * lived with it.)
 */

type Props = {
	backends: Backend[];
	defaultBackendId?: string;
	onCreate(draft: PersonaDraft): Promise<Persona>;
	onFaceChosen(persona: Persona): void;
	/** Close, leaving the new teammate in the roster unselected. */
	onClose(): void;
	/** Close into the new teammate's conversation. */
	onChat(personaId: string): void;
};

/* The narration. Lines appear in order as the work behind them actually
 * happens: `setting up` on create, `testing` while the hidden session spawns
 * (that is what starting it proves), `building my persona` for the turn in
 * which the agent chooses. */
const LINES = {
	spawning: ["setting up", "testing"],
	asking: ["setting up", "testing", "building my persona"],
	done: ["setting up", "testing", "building my persona"],
} as const;

type Stage =
	| { kind: "form" }
	| { kind: "hatching"; persona: Persona; lines: readonly string[] }
	| { kind: "hatched"; persona: Persona };

export function NewTeammate({
	backends,
	defaultBackendId,
	onCreate,
	onFaceChosen,
	onClose,
	onChat,
}: Props) {
	const [name, setName] = useState("");
	/* The phone leads with the built-in harness — Toad Agent is the first-class
	 * lane there, "Other" is the door to the full list. */
	const [backendId, setBackendId] = useState(
		defaultBackendId ??
			(webClient() && backends.some((backend) => backend.id === "pi")
				? "pi"
				: backends[0]?.id ?? "cursor"),
	);
	const [modelId, setModelId] = useState("");
	const [goal, setGoal] = useState("");
	const [computer, setComputer] = useState(false);
	const [busy, setBusy] = useState(false);
	const [stage, setStage] = useState<Stage>({ kind: "form" });

	/* The compose call outlives this component if the person closes mid-hatch;
	 * a ref keeps the finished face from landing in unmounted state. */
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	// The bun side narrates over faceProgress; each stage extends the lines.
	const personaId = stage.kind === "hatching" ? stage.persona.id : null;
	useEffect(() => {
		if (!personaId) return;
		return on("faceProgress", ({ personaId: id, stage: s }) => {
			if (id !== personaId || s === "done") return;
			setStage((current) =>
				current.kind === "hatching" && current.persona.id === id
					? { ...current, lines: LINES[s] }
					: current,
			);
		});
	}, [personaId]);

	// Escape backs out of the form. The hatch is not cancellable from here —
	// the teammate already exists, and the face always resolves.
	useEffect(() => {
		if (stage.kind !== "form") return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [stage.kind, onClose]);

	const submit = async () => {
		const trimmed = name.trim();
		if (!trimmed || busy) return;
		setBusy(true);
		try {
			const persona = await onCreate({
				name: trimmed,
				backendId,
				goal: goal.trim() || undefined,
				modelId: modelId.trim() || undefined,
				computer: computer ? { enabled: true } : undefined,
			});
			setStage({
				kind: "hatching",
				persona,
				lines: LINES.spawning.slice(0, 1),
			});
			const { face } = await api.composeFace(persona.id);
			const hatched = { ...persona, face };
			onFaceChosen(hatched);
			if (alive.current) setStage({ kind: "hatched", persona: hatched });
		} catch {
			// The teammate exists even when composing failed outright; it simply
			// keeps the initial. Land in the roster rather than an error screen.
			if (alive.current) onClose();
		} finally {
			setBusy(false);
		}
	};

	/* The phone asks with a sheet, not a page of form controls: the platform's
	 * own grammar for "make a thing". The hatch that follows still takes the
	 * whole screen — meeting the new face is a moment, not a row. */
	if (webClient() && stage.kind === "form") {
		const others = backends.filter((backend) => backend.id !== "pi");
		const toadAgent = backends.some((backend) => backend.id === "pi");
		const onToad = backendId === "pi";
		const trimmed = name.trim();
		return (
			<div className="sheet-holder" role="dialog" aria-label="New teammate">
				<button type="button" className="sheet-scrim animate-fade-in" aria-label="Cancel" onClick={onClose} />
				<section className="sheet-panel nt-sheet">
					<div className="sheet-grab" aria-hidden="true" />
					<header className="nt-sheet-bar">
						<button type="button" className="nt-cancel" onClick={onClose}>
							Cancel
						</button>
						<h2 className="nt-sheet-title">New teammate</h2>
					</header>
					<div className="nt-sheet-scroll">
						<div className="nt-hatch-hint">
							<div className="nt-egg animate-throat" aria-hidden="true" />
							<p>They'll choose their own face once they exist.</p>
						</div>

						<div className="pset-card nt-fields">
							<div className="nt-frow">
								<label className="nt-flabel" htmlFor="nt-name">
									Name
								</label>
								<input
									id="nt-name"
									className="nt-input"
									placeholder="Who joins?"
									value={name}
									onChange={(e) => setName(e.target.value)}
									enterKeyHint="done"
								/>
							</div>
							<div className="nt-frow">
								<label className="nt-flabel" htmlFor="nt-goal">
									Brief <span className="nt-opt">· optional</span>
								</label>
								<textarea
									id="nt-goal"
									className="nt-input nt-area"
									rows={3}
									placeholder="What are they for?"
									value={goal}
									onChange={(e) => setGoal(e.target.value)}
								/>
							</div>
						</div>

						<p className="pset-label">Runs on</p>
						{toadAgent && (
							<div className="nt-seg" role="radiogroup" aria-label="Runs on">
								<button
									type="button"
									aria-pressed={onToad}
									onClick={() => setBackendId("pi")}
								>
									Toad Agent
								</button>
								<button
									type="button"
									aria-pressed={!onToad}
									onClick={() => {
										if (onToad) setBackendId(others[0]?.id ?? backendId);
									}}
								>
									Other
								</button>
							</div>
						)}
						{(!onToad || !toadAgent) && (
							<div className="pset-card nt-others">
								{others.map((backend) => (
									<button
										key={backend.id}
										type="button"
										className="pset-row"
										onClick={() => setBackendId(backend.id)}
									>
										<span className="pset-row-label">{backend.name}</span>
										{backendId === backend.id && <span className="nt-check">✓</span>}
									</button>
								))}
							</div>
						)}
						<p className="pset-foot nt-runfoot">
							{onToad
								? "Toad Agent is the built-in harness. Model and tools can change any time in their settings."
								: "Runs whatever the harness runs. Model and tools can change any time in their settings."}
						</p>

						<div className="pset-card">
							<div className="pset-row">
								<span className="pset-row-label">Computer</span>
								<button
									type="button"
									role="switch"
									aria-checked={computer}
									aria-label="Computer"
									className={`pset-switch${computer ? " on" : ""}`}
									onClick={() => setComputer((current) => !current)}
								>
									<i />
								</button>
							</div>
						</div>
						<p className="pset-foot">A desktop of their own, in a container on your machine.</p>
					</div>
					<div className="nt-create-anchor">
						<button
							type="button"
							className="nt-create"
							disabled={!trimmed || busy}
							onClick={() => void submit()}
						>
							{busy ? "Creating…" : trimmed ? `Add ${trimmed} to the team` : "Add to the team"}
						</button>
					</div>
				</section>
			</div>
		);
	}

	return (
		/* Centred while there is room and scrollable when there is not: a phone
		   with the keyboard up has half the height it started with, and a form
		   that stays centred through that is a form cropped at both ends. */
		<div className="absolute inset-0 z-overlay animate-fade-in overflow-y-auto bg-paper">
			<div className="safe-head safe-foot flex min-h-full items-center justify-center">
				{stage.kind === "form" && (
					<div className="w-full max-w-md px-lg">
						<h1 className="mb-3xs text-xl font-semibold tracking-display text-ink">New teammate</h1>
						<p className="mb-lg text-sm text-ink-3">
							Name it, pick what runs it, tell it who it is. It takes the rest from there.
						</p>

						<label className="label" htmlFor="nt-name">
							Name
						</label>
						<input
							id="nt-name"
							autoFocus
							className="field mb-md"
							placeholder="Teammate name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void submit();
							}}
						/>

						<label className="label" htmlFor="nt-backend">
							Harness
						</label>
						<select
							id="nt-backend"
							className="field mb-md"
							value={backendId}
							onChange={(e) => setBackendId(e.target.value)}
						>
							<BackendOptions backends={backends} />
						</select>

						<label className="label" htmlFor="nt-model">
							Model
						</label>
						<input
							id="nt-model"
							className="field mb-md"
							placeholder="Harness default"
							value={modelId}
							onChange={(e) => setModelId(e.target.value)}
						/>

						<label className="label" htmlFor="nt-goal">
							Persona
						</label>
						<textarea
							id="nt-goal"
							className="field mb-md min-h-24 resize-y leading-relaxed"
							placeholder="Who is this teammate? What do they care about? This becomes their standing brief — and how they choose their own face."
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
						/>

						<div className="mb-lg flex items-center gap-xs">
							<label className="flex items-center gap-xs text-sm text-ink-2">
								<input type="checkbox" checked={computer} onChange={(e) => setComputer(e.target.checked)} />
								<span>Enable computer</span>
							</label>
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

						<div className="actions">
							<button type="button" className="btn-ghost" onClick={onClose}>
								Cancel
							</button>
							<button
								type="button"
								className="btn-primary"
								disabled={!name.trim() || busy}
								onClick={() => void submit()}
							>
								{busy ? "Creating…" : "Create teammate"}
							</button>
						</div>
					</div>
				)}

				{stage.kind === "hatching" && (
					<div className="flex flex-col items-center gap-lg px-lg">
						{/* The disc it will hatch into, empty while it decides. */}
						<div
							className="h-24 w-24 rounded-pill border border-dashed border-rule-strong animate-throat"
							aria-hidden="true"
						/>
						<div className="flex flex-col items-center gap-2xs" aria-live="polite">
							{stage.lines.map((line, i) => (
								<p
									key={line}
									className={`m-0 animate-strike font-mono text-xs ${
										i === stage.lines.length - 1 ? "text-ink-2" : "text-ink-3"
									}`}
								>
									{line}
									{i === stage.lines.length - 1 ? "…" : ""}
								</p>
							))}
						</div>
						<p className="m-0 max-w-xs text-center text-xs text-ink-3">
							{stage.persona.name} is finding its vibe.
						</p>
					</div>
				)}

				{stage.kind === "hatched" && stage.persona.face && (
					<div className="flex flex-col items-center gap-lg px-lg">
						<div className="animate-poof">
							<FaceIcon face={stage.persona.face} size={96} />
						</div>
						<div className="text-center">
							<h1 className="m-0 text-xl font-semibold tracking-display text-ink">{stage.persona.name}</h1>
							<p className="m-0 mt-2xs text-sm text-ink-3">made this face for itself.</p>
						</div>
						<div className="actions w-full">
							<button type="button" className="btn-ghost" onClick={onClose}>
								Done
							</button>
							<button type="button" className="btn-primary" onClick={() => onChat(stage.persona.id)}>
								Start chatting
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
