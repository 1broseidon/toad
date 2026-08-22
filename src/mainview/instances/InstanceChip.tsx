import { monogramOf, vitalOf } from "./marks";
import type { LinkedInstance } from "./store";
import type { InstanceStatus } from "./useInstances";

/**
 * Which desktop this is, at the foot of the roster.
 *
 * The roster is a list of teammates on one machine, and on a phone that
 * machine is a choice — so the rail says which one, in the place a desktop
 * app would put an account. The whole chip is the button: there is one thing
 * to do here and it is not worth a second target.
 */
export function InstanceChip({
	instance,
	status,
	onClick,
}: {
	instance: LinkedInstance;
	status: InstanceStatus;
	onClick(): void;
}) {
	const vital = vitalOf(instance, true, status);

	return (
		<button
			type="button"
			className="flex w-full items-center gap-xs border-t border-rule-2 px-xs py-2xs text-left"
			onClick={onClick}
		>
			<span
				aria-hidden="true"
				className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-paper-3 font-display text-2xs text-ink-2"
			>
				{monogramOf(instance.name)}
			</span>
			<span className="min-w-0 flex-1 truncate font-display text-sm text-ink-2">
				{instance.name}
			</span>
			<span aria-hidden="true" className={`h-dot w-dot shrink-0 rounded-pill ${vital.className}`} />
			<span className="sr-only">{vital.label}</span>
		</button>
	);
}
