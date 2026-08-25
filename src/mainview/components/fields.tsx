import type { ChangeEvent, ReactNode } from "react";
import { webClient } from "../platform";
import { RevealIcon } from "./icons";

/**
 * The field vocabulary settings sections are built from.
 *
 * A setting should not look like a different sort of control depending on its
 * section or whether it belongs to a teammate or to the app.
 */

/** A group of related settings, headed so the screen can be scanned. */
export function Section({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: ReactNode;
}) {
	if (webClient()) {
		return (
			<section className="flex flex-col gap-md">
				<div>
					<h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">{title}</h3>
					{hint && <p className="mt-2xs text-xs leading-relaxed text-ink-3">{hint}</p>}
				</div>
				{children}
			</section>
		);
	}

	return (
		<section className="settings-section flex flex-col gap-md">
			<div className="settings-section-heading">
				<h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">{title}</h3>
				{hint && <p className="mt-2xs text-xs leading-relaxed text-ink-3">{hint}</p>}
			</div>
			<div className="settings-group flex flex-col gap-md">{children}</div>
		</section>
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	if (webClient()) {
		return (
			<div>
				<p className="label">{label}</p>
				{children}
				{hint && <p className="mt-2xs text-xs leading-relaxed text-ink-3">{hint}</p>}
			</div>
		);
	}

	return (
		<div className="settings-field">
			<div className="settings-field-copy">
				<p className="label">{label}</p>
				{hint && <p className="settings-field-hint mt-2xs text-xs leading-relaxed text-ink-3">{hint}</p>}
			</div>
			<div className="settings-field-control">{children}</div>
		</div>
	);
}

/** A native switch on desktop without changing the phone's labelled control. */
export function SettingsToggle({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange(event: ChangeEvent<HTMLInputElement>): void;
}) {
	const phone = webClient();
	const input = (
		<input
			type="checkbox"
			role={phone ? undefined : "switch"}
			aria-label={phone ? undefined : label}
			checked={checked}
			disabled={disabled}
			onChange={onChange}
		/>
	);

	return phone ? (
		<label className="flex items-center gap-xs text-sm text-ink-2">
			{input}
			<span>{label}</span>
		</label>
	) : input;
}

/** A term and its value, for facts that are read rather than edited. */
export function Detail({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
	return (
		<div className="flex gap-sm">
			<dt className="w-20 shrink-0">{term}</dt>
			<dd className={`min-w-0 truncate text-ink-2 ${mono ? "font-mono" : ""}`}>{value}</dd>
		</div>
	);
}

/**
 * A path, shown whole and openable.
 *
 * Read-only and selectable rather than plain text: a path is something people
 * copy into a terminal, and it is the one value here that is useless truncated.
 */
export function PathRow({
	label,
	path,
	onReveal,
	children,
}: {
	label: string;
	path: string;
	onReveal(): void;
	children?: ReactNode;
}) {
	return (
		<div className="flex gap-xs">
			<input
				readOnly
				aria-label={label}
				className="field min-w-0 flex-1 font-mono text-2xs text-ink-2"
				value={path}
			/>
			{/* Finder is a desktop; the phone shows the path and stops there. */}
			{!webClient() && (
				<button
					type="button"
					className="btn-outline shrink-0 !px-xs"
					aria-label={`Reveal ${label.toLowerCase()} in Finder`}
					title="Reveal in Finder"
					onClick={onReveal}
				>
					<RevealIcon />
				</button>
			)}
			{children}
		</div>
	);
}
