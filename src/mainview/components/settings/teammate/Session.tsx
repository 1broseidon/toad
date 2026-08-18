import type { SessionInfo } from "../../../../shared/types";
import { Detail, Section } from "../../fields";

type Props = { info: SessionInfo | null };

export function Session({ info }: Props) {
	return (
		<Section
			title="Session"
			hint="Toad keeps its own transcript. This is the agent's own memory of the conversation, which it restores when it can."
		>
			{info?.sessionId ? (
				<dl className="flex flex-col gap-3xs text-xs text-ink-3">
					<Detail term="Id" value={info.sessionId} mono />
					<Detail term="Context" value={info.contextRestored ? "Restored" : "Fresh"} />
					<Detail
						term="Restore"
						value={
							info.capabilities.resume
								? "resume"
								: info.capabilities.loadSession
									? "load"
									: "not supported"
						}
					/>
				</dl>
			) : (
				<p className="text-xs leading-relaxed text-ink-3">
					No session yet. One starts when you send a message.
				</p>
			)}
		</Section>
	);
}
