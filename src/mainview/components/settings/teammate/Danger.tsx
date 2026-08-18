import { Section } from "../../fields";

type Props = { onDelete(): void };

export function Danger({ onDelete }: Props) {
	return (
		<Section title="Danger">
			<button type="button" className="btn-danger" onClick={onDelete}>
				Remove teammate
			</button>
		</Section>
	);
}
