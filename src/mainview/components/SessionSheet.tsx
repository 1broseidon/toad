import type { Backend, SessionInfo } from "../../shared/types";
import { isUp } from "../../shared/session";
import { CaretIcon, CloseIcon } from "./icons";

/**
 * The session's disposition, as a sheet the thumb can reach.
 *
 * On the desktop the model and mode pickers live in the toolbar, where a
 * pointer can be precise about them. A phone toolbar has no room for a
 * model name, so the phone got nothing at all — this sheet is that gap
 * closed. Everything on it is the session's own state: which model, which
 * mode, whatever dials the agent exposes, and the one lifecycle act
 * (start or stop) that is ever a decision.
 *
 * The selects are the platform's own — a native picker is the one control
 * iOS users already know how to leave.
 */

type Props = {
	name: string;
	backend?: Backend;
	info: SessionInfo;
	onSetModel(modelId: string): void;
	onSetMode(modeId: string): void;
	onSetConfig(configId: string, value: string): void;
	onStart(): void;
	onStop(): void;
	onClose(): void;
};

const STATE_WORD: Record<string, string> = {
	idle: "idle",
	starting: "starting…",
	ready: "ready",
	thinking: "working",
	error: "error",
	stopped: "stopped",
};

export function SessionSheet({
	name,
	backend,
	info,
	onSetModel,
	onSetMode,
	onSetConfig,
	onStart,
	onStop,
	onClose,
}: Props) {
	const running = isUp(info.state);

	return (
		<div className="sheet-holder" role="dialog" aria-label={`${name}'s session`}>
			<button type="button" className="sheet-scrim animate-fade-in" aria-label="Close" onClick={onClose} />
			<section className="sheet-panel">
				<div className="sheet-grab" aria-hidden="true" />
				<header className="flex items-center gap-xs px-gutter pb-2xs">
					<h2 className="min-w-0 flex-1 truncate text-lg font-medium text-ink">Session</h2>
					<span className="text-xs text-ink-3">{STATE_WORD[info.state] ?? info.state}</span>
					<button type="button" className="btn-ghost !px-xs" aria-label="Close" onClick={onClose}>
						<CloseIcon />
					</button>
				</header>

				<div className="px-gutter pb-sm">
					{running && info.models.length > 0 && (
						<SheetPicker
							label={info.modelLabel ?? "Model"}
							value={info.currentModelId ?? ""}
							options={info.models}
							onChange={onSetModel}
						/>
					)}
					{running && info.modes.length > 0 && (
						<SheetPicker
							label={info.modeLabel ?? "Mode"}
							value={info.currentModeId ?? ""}
							options={info.modes}
							onChange={onSetMode}
						/>
					)}
					{running &&
						(info.configs ?? []).map((picker) => (
							<SheetPicker
								key={picker.id}
								label={picker.name}
								value={picker.currentId ?? ""}
								options={picker.options}
								onChange={(value) => onSetConfig(picker.id, value)}
							/>
						))}

					{!running && (
						<p className="py-sm text-sm leading-relaxed text-ink-3">
							{info.state === "error"
								? "The session hit an error. Start it again to keep talking."
								: "No session running. Sending a message starts one on its own."}
						</p>
					)}

					<div className="mt-sm flex items-center gap-sm border-t border-rule-2 pt-sm">
						<p className="min-w-0 flex-1 truncate text-xs text-ink-3">
							{backend?.name ?? "—"}
							{info.agentVersion ? ` ${info.agentVersion}` : ""}
						</p>
						{running ? (
							<button type="button" className="btn-outline shrink-0" onClick={onStop}>
								Stop session
							</button>
						) : (
							<button type="button" className="btn-outline shrink-0" onClick={onStart}>
								Start session
							</button>
						)}
					</div>
				</div>
			</section>
		</div>
	);
}

/**
 * A labelled row whose whole width is the platform's own select. The visible
 * value is ordinary text; the select is stretched invisibly over the row so
 * the tap target is the row and the menu is the system's.
 */
function SheetPicker({
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
		<span className="sheet-row">
			<span className="text-md text-ink-2">{label}</span>
			<span className="sheet-row-value" aria-hidden="true">
				{current?.name ?? (value || "—")}
			</span>
			<CaretIcon className="picker-caret shrink-0" />
			<select
				aria-label={label}
				value={value}
				onChange={(event) => onChange(event.target.value)}
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
