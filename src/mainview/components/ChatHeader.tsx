import { useEffect, useState } from "react";
import { isUp } from "../../shared/session";
import type { Backend, PeerThreadSummary, Persona, ScheduledJob, SessionInfo } from "../../shared/types";
import { insetLights, shortcutLabel, webClient } from "../platform";
import { FaceIcon } from "./FaceIcon";
import { SessionSheet } from "./SessionSheet";
import { Toolbar } from "./Toolbar";
import { SchedulesPill } from "./SchedulesPill";
import { ThreadsButton } from "./ThreadsButton";
import { BackIcon, CaretIcon, ComputerIcon, RosterIcon, SearchIcon, SlidersIcon } from "./icons";

type Props = {
	persona: Persona;
	backend?: Backend;
	info: SessionInfo;
	searchOpen: boolean;
	onOpenSearch(): void;
	threads: PeerThreadSummary[];
	/** When this teammate's threads were last looked at, for the button's badge. */
	threadsSeenAt: number;
	threadsOpen: boolean;
	onOpenThreads(): void;
	jobs: ScheduledJob[];
	onCancelSchedule(id: string): void;
	/** Shown only when this teammate's computer is enabled. */
	computerOpen: boolean;
	onOpenComputer(): void;
	scrolled: boolean;
	/**
	 * Present only while the roster is folded away, which is also when the
	 * traffic lights are inlaid over this band rather than over the rail.
	 */
	onOpenRail?: () => void;
	/** True while the roster is in front of this pane on the phone's stack. */
	covered?: boolean;
	onStart(): void;
	onStop(): void;
	onSetModel(modelId: string): void;
	onSetMode(modeId: string): void;
	onSetConfig(configId: string, value: string): void;
	onToggleSettings(): void;
	settingsActive: boolean;
};

/**
 * The right-hand segment of the window's unified toolbar. It carries the
 * teammate in focus and its disposition — nothing here starts or stops a
 * session, because sending a message does that on its own.
 *
 * What it does not carry is the working directory. A path is a setting, not a
 * fact about the person you are talking to, and it was the widest thing in a
 * band that has to survive a narrow window.
 */
export function ChatHeader({
	persona,
	backend,
	info,
	searchOpen,
	onOpenSearch,
	threads,
	threadsSeenAt,
	threadsOpen,
	onOpenThreads,
	jobs,
	onCancelSchedule,
	computerOpen,
	onOpenComputer,
	scrolled,
	onOpenRail,
	covered,
	onStart,
	onStop,
	onSetModel,
	onSetMode,
	onSetConfig,
	onToggleSettings,
	settingsActive,
}: Props) {
	const running = isUp(info.state);
	/* The session sheet, phone only — the toolbar there has no room for a
	 * model name, so the disposition lives a tap away instead of nowhere. */
	const [sheet, setSheet] = useState(false);
	const phone = webClient();

	/* The pane outlives both the teammate on it and its place at the front of
	 * the stack; the sheet outlives neither. */
	useEffect(() => setSheet(false), [persona.id, covered]);

	const model = info.models.find((m) => m.id === info.currentModelId)?.name;
	const mode = info.modes.find((m) => m.id === info.currentModeId)?.name;
	/* One line under the name: what this teammate is, right now. Running, that
	 * is its disposition; otherwise it is the session's own word. */
	const subtitle = running
		? [model, mode].filter(Boolean).join(" · ") || (backend?.name ?? persona.backendId)
		: info.state === "error"
			? "error — tap to see"
			: info.state === "starting"
				? "starting…"
				: "asleep — a message wakes it";

	return (
		<>
			{/* The right edge is the window's own corner, so the last control holds
			    it the way a native toolbar's does — its padding is the only inset,
			    rather than the gutter the conversation below is measured with. */}
			<Toolbar
				as="header"
				className={`gap-xs pr-3xs ${onOpenRail && insetLights() ? "pl-lights" : "pl-gutter"}`}
				scrolled={scrolled}
				glass
			>
				{onOpenRail && (
					<button
						type="button"
						onClick={onOpenRail}
						aria-label="Show the team"
						title="Show the team"
						className="btn-ghost -ml-3xs shrink-0 !px-xs"
					>
						{webClient() ? <BackIcon /> : <RosterIcon />}
					</button>
				)}

				{/* One line, on the traffic lights' centre line: who this is and what
				    it runs on. On the phone it is two stacked lines with the face —
				    a contact header, and tapping the contact opens their settings,
				    the way every messaging app's header does. The session sheet
				    keeps the sliders button. */}
				{phone ? (
					<button
						type="button"
						className="flex min-w-0 flex-1 items-center gap-xs text-left"
						aria-label={`${persona.name}'s settings`}
						onClick={onToggleSettings}
					>
						{persona.face && (
							<span className="shrink-0" aria-hidden="true">
								<FaceIcon face={persona.face} size={32} />
							</span>
						)}
						<span className="min-w-0 flex-1">
							<span className="block truncate text-md font-medium leading-tight text-ink">
								{persona.name}
							</span>
							<span className="block truncate text-2xs leading-tight text-ink-3">{subtitle}</span>
						</span>
					</button>
				) : (
					<div className="flex min-w-0 flex-1 items-baseline gap-xs">
						<h2 className="min-w-0 truncate text-lg font-medium text-ink">{persona.name}</h2>
						<span className="shrink-0 text-2xs text-ink-3">
							{backend?.name ?? persona.backendId}
							{info.agentVersion ? ` ${info.agentVersion}` : ""}
						</span>
					</div>
				)}

				{/* On the desk the pill lives here; on the phone schedules moved
				    into the session sheet — the header collapses to the contact
				    and one card. */}
				{!phone && <SchedulesPill jobs={jobs} onCancel={onCancelSchedule} />}

				{/* Disposition, read as one phrase: which model, then how hard it is
				    being asked to think. That is the order the sentence goes in —
				    "Grok 4.6, on High" — and the dial means nothing without the thing
				    it is set on. Both are switchable while the session is live. */}
				{!phone && running && info.models.length > 0 && (
					<Picker
						label={info.modelLabel ?? "Model"}
						value={info.currentModelId ?? ""}
						options={info.models}
						onChange={onSetModel}
					/>
				)}
				{!phone && running && info.modes.length > 0 && (
					<Picker
						label={info.modeLabel ?? "Mode"}
						value={info.currentModeId ?? ""}
						options={info.modes}
						onChange={onSetMode}
					/>
				)}
				{!phone &&
					running &&
					(info.configs ?? []).map((picker) => (
						<Picker
							key={picker.id}
							label={picker.name}
							value={picker.currentId ?? ""}
							options={picker.options}
							onChange={(value) => onSetConfig(picker.id, value)}
						/>
					))}

				{!webClient() && (
					<ThreadsButton
						threads={threads}
						seenAt={threadsSeenAt}
						open={threadsOpen}
						onOpen={onOpenThreads}
					/>
				)}
				{webClient() && threads.length > 0 && (
					<ThreadsButton
						threads={threads}
						seenAt={threadsSeenAt}
						open={threadsOpen}
						onOpen={onOpenThreads}
					/>
				)}

				{/* Search is the team's, not this conversation's; the phone reaches
				    it from the Team screen and this header stays collapsed. */}
				{!phone && (
					<button
						type="button"
						aria-expanded={searchOpen}
						aria-label="Search"
						title={`Search (${shortcutLabel("F")})`}
						className={`btn-ghost !px-xs ${searchOpen ? "bg-paper-4 text-ink" : ""}`}
						onClick={onOpenSearch}
					>
						<SearchIcon />
					</button>
				)}

				{persona.computer?.enabled && (
					<button
						type="button"
						aria-expanded={computerOpen}
						aria-label="Computer"
						title="Computer"
						className={`btn-ghost !px-xs ${computerOpen ? "bg-paper-4 text-ink" : ""}`}
						onClick={onOpenComputer}
					>
						<ComputerIcon />
					</button>
				)}

				<button
					type="button"
					aria-expanded={phone ? sheet : settingsActive}
					aria-label={phone ? "Session" : "Teammate settings"}
					title={phone ? "Session" : `Teammate settings (${shortcutLabel("I")})`}
					className={`btn-ghost !px-xs ${(phone ? sheet : settingsActive) ? "bg-paper-4 text-ink" : ""}`}
					onClick={phone ? () => setSheet(true) : onToggleSettings}
				>
					<SlidersIcon />
				</button>
			</Toolbar>

			{sheet && (
				<SessionSheet
					name={persona.name}
					backend={backend}
					info={info}
					jobs={jobs}
					onCancelSchedule={onCancelSchedule}
					onSetModel={onSetModel}
					onSetMode={onSetMode}
					onSetConfig={onSetConfig}
					onStart={onStart}
					onStop={onStop}
					onClose={() => setSheet(false)}
				/>
			)}

			{/* Sessions start themselves, so the only time starting is a decision
			    the user has to make is when it has already failed once. */}
			{info.error && (
				<div className="callout-danger beside-bar mx-gutter flex items-start gap-sm">
					<p className="min-w-0 flex-1">{info.error}</p>
					<button type="button" className="btn-outline shrink-0" onClick={onStart}>
						Try again
					</button>
				</div>
			)}
		</>
	);
}

/**
 * A disposition control: the current value, a caret, and a native menu.
 *
 * The label is ordinary text and the `select` is stretched invisibly over it. The
 * select is still the control — it has the accessible name, it takes the focus,
 * and it opens the platform's own menu — but it cannot be the thing you see,
 * because a `select` is as wide as its widest option however it is styled, and a
 * model list with one long name in it would set the width of every entry.
 */
function Picker({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: Array<{ id: string; name: string }>;
	onChange(id: string): void;
}) {
	const current = options.find((option) => option.id === value);

	return (
		<span className="picker">
			<span className="picker-text" aria-hidden="true">
				{current?.name ?? value}
			</span>
			<CaretIcon className="picker-caret" />
			<select
				aria-label={label}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="picker-native"
			>
				{options.map((option) => (
					<option key={option.id} value={option.id}>
						{option.name}
					</option>
				))}
			</select>
		</span>
	);
}
