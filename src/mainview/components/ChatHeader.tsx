import { isUp } from "../../shared/session";
import type { Backend, PeerThreadSummary, Persona, ScheduledJob, SessionInfo } from "../../shared/types";
import { insetLights, shortcutLabel } from "../platform";
import { Toolbar } from "./Toolbar";
import { SchedulesPill } from "./SchedulesPill";
import { ThreadsButton } from "./ThreadsButton";
import { CaretIcon, ComputerIcon, RosterIcon, SlidersIcon } from "./icons";

type Props = {
	persona: Persona;
	backend?: Backend;
	info: SessionInfo;
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
	onStart(): void;
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
	onStart,
	onSetModel,
	onSetMode,
	onSetConfig,
	onToggleSettings,
	settingsActive,
}: Props) {
	const running = isUp(info.state);

	return (
		<>
			{/* The right edge is the window's own corner, so the last control holds
			    it the way a native toolbar's does — its padding is the only inset,
			    rather than the gutter the conversation below is measured with. */}
			<Toolbar
				as="header"
				className={`gap-xs pr-3xs ${onOpenRail && insetLights() ? "pl-lights" : "pl-gutter"}`}
				scrolled={scrolled}
			>
				{onOpenRail && (
					<button
						type="button"
						onClick={onOpenRail}
						aria-label="Show teammates"
						title="Show teammates"
						className="btn-ghost -ml-3xs shrink-0 !px-xs"
					>
						<RosterIcon />
					</button>
				)}

				{/* One line, on the traffic lights' centre line: who this is and what
				    it runs on. */}
				<div className="flex min-w-0 flex-1 items-baseline gap-xs">
					<h2 className="min-w-0 truncate text-sm font-medium text-ink">{persona.name}</h2>
					<span className="shrink-0 text-2xs text-ink-3">
						{backend?.name ?? persona.backendId}
						{info.agentVersion ? ` ${info.agentVersion}` : ""}
					</span>
				</div>

				<SchedulesPill jobs={jobs} onCancel={onCancelSchedule} />

				{/* Disposition, read as one phrase: which model, then how hard it is
				    being asked to think. That is the order the sentence goes in —
				    "Grok 4.6, on High" — and the dial means nothing without the thing
				    it is set on. Both are switchable while the session is live. */}
				{running && info.models.length > 0 && (
					<Picker
						label={info.modelLabel ?? "Model"}
						value={info.currentModelId ?? ""}
						options={info.models}
						onChange={onSetModel}
					/>
				)}
				{running && info.modes.length > 0 && (
					<Picker
						label={info.modeLabel ?? "Mode"}
						value={info.currentModeId ?? ""}
						options={info.modes}
						onChange={onSetMode}
					/>
				)}
				{running &&
					(info.configs ?? []).map((picker) => (
						<Picker
							key={picker.id}
							label={picker.name}
							value={picker.currentId ?? ""}
							options={picker.options}
							onChange={(value) => onSetConfig(picker.id, value)}
						/>
					))}

				<ThreadsButton
					threads={threads}
					seenAt={threadsSeenAt}
					open={threadsOpen}
					onOpen={onOpenThreads}
				/>

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
					aria-expanded={settingsActive}
					aria-label="Teammate settings"
					title={`Teammate settings (${shortcutLabel("I")})`}
					className={`btn-ghost !px-xs ${settingsActive ? "bg-paper-4 text-ink" : ""}`}
					onClick={onToggleSettings}
				>
					<SlidersIcon />
				</button>
			</Toolbar>

			{/* Sessions start themselves, so the only time starting is a decision
			    the user has to make is when it has already failed once. */}
			{info.error && (
				<div className="callout-danger mx-gutter mt-xs flex items-start gap-sm">
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
