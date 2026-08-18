import type { AppInfo } from "../../../../shared/types";
import { Detail, Section } from "../../fields";

type Props = { info: AppInfo | null };

export function About({ info }: Props) {
	return (
		<Section title="About">
			<dl className="flex flex-col gap-3xs text-xs text-ink-3">
				<Detail term="Version" value={info?.version || "unreleased build"} />
				<Detail term="Channel" value={info?.channel || "dev"} />
				{info?.identifier && <Detail term="Identifier" value={info.identifier} mono />}
			</dl>
		</Section>
	);
}
