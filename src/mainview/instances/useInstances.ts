import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	activeOf,
	EMPTY_JAR,
	forget,
	type InstanceJar,
	type LinkedInstance,
	loadJar,
	markSeen,
	markUnlinked,
	type PairedInstance,
	saveJar,
	setActive,
	upsertFromPair,
} from "./store";

/**
 * The jar, as React state, plus how the active desktop's wire is doing.
 *
 * Every change is written through on the spot. There is no other copy to
 * reconcile with — the jar on disk is what the next launch reads — and the
 * changes are all single acts a person just performed, so there is nothing
 * to batch and nothing worth risking to a backgrounded app.
 */

export type InstanceStatus = "idle" | "connecting" | "open" | "reconnecting";

export function useInstances() {
	const [jar, setJar] = useState<InstanceJar>(EMPTY_JAR);
	/* Whether the store has answered. Until it has, an empty jar is not the
	 * same statement as "no desktops linked" and must not be drawn as one. */
	const [loaded, setLoaded] = useState(false);
	const [status, setStatus] = useState<InstanceStatus>("idle");

	/* Mutations read the jar they are changing from here rather than from a
	 * render, so two of them in the same tick do not each start from the
	 * version the other has already replaced. */
	const held = useRef(jar);
	held.current = jar;

	useEffect(() => {
		let alive = true;
		void loadJar().then((stored) => {
			if (!alive) return;
			held.current = stored;
			setJar(stored);
			setLoaded(true);
		});
		return () => {
			alive = false;
		};
	}, []);

	const commit = useCallback((change: (jar: InstanceJar) => InstanceJar) => {
		const next = change(held.current);
		if (next === held.current) return next;
		held.current = next;
		setJar(next);
		void saveJar(next);
		return next;
	}, []);

	/* Linking is two facts at once: this desktop exists, and it is the one
	 * being looked at. Nobody links a desktop in order to not use it. */
	const link = useCallback(
		(paired: PairedInstance) => commit((current) => setActive(upsertFromPair(current, paired), paired.id)),
		[commit],
	);

	const choose = useCallback((id: string | null) => commit((current) => setActive(current, id)), [commit]);

	const drop = useCallback((id: string) => commit((current) => forget(current, id)), [commit]);

	const unlink = useCallback((id: string) => commit((current) => markUnlinked(current, id)), [commit]);

	const seen = useCallback(
		(id: string, version: string | null) => commit((current) => markSeen(current, id, version)),
		[commit],
	);

	const active: LinkedInstance | null = useMemo(() => activeOf(jar), [jar]);

	return useMemo(
		() => ({
			loaded,
			jar,
			instances: jar.instances,
			active,
			status,
			setStatus,
			link,
			choose,
			drop,
			unlink,
			seen,
		}),
		[loaded, jar, active, status, link, choose, drop, unlink, seen],
	);
}

export type Instances = ReturnType<typeof useInstances>;
