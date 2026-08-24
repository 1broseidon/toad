import type { Persona } from "./types";

/** The normalized label that determines which roster section owns a teammate. */
export function personaTeam(persona: Persona): string | undefined {
	return persona.team?.trim() || undefined;
}

/**
 * The visible roster order: unteamed teammates first, followed by each team in
 * order of first appearance. Shortcut producers and consumers must use this.
 */
export function flattenTeamRoster(personas: readonly Persona[]): Persona[] {
	const unteamed: Persona[] = [];
	const teams = new Map<string, Persona[]>();
	for (const persona of personas) {
		const team = personaTeam(persona);
		if (!team) {
			unteamed.push(persona);
			continue;
		}
		const members = teams.get(team);
		if (members) members.push(persona);
		else teams.set(team, [persona]);
	}
	return [...unteamed, ...[...teams.values()].flat()];
}
