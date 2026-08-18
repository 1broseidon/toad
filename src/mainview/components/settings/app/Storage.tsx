import type { AppInfo } from "../../../../shared/types";
import { api } from "../../../rpc";
import { Field, PathRow, Section } from "../../fields";

type Props = { info: AppInfo | null };

export function Storage({ info }: Props) {
	return (
		<Section
			title="Storage"
			hint="Conversations, teammates and attachments are files on this machine. Nothing is sent anywhere except to the agent you are talking to."
		>
			<Field label="Data folder">
				<PathRow
					label="Data folder"
					path={info?.dataDir ?? "…"}
					onReveal={() => void api.revealDataFolder()}
				/>
			</Field>
			<Field label="Teammates file">
				<PathRow
					label="Teammates file"
					path={info?.configFile ?? "…"}
					onReveal={() => void api.revealDataFolder()}
				/>
			</Field>
		</Section>
	);
}
