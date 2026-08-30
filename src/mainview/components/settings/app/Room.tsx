import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type {
	ClientEnrollmentInfo,
	ClientSeatInfo,
	IncomingNodeRequestInfo,
	NearbyNodeInfo,
	NodeIdentity,
	NodeInvite,
	NodeMemberInfo,
	OutgoingNodeRequestInfo,
	RoomInfo,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { Field, Section } from "../../fields";
import { LockIcon, UnlockedIcon } from "../../icons";

const POLL_MS = 2_000;

function shortFingerprint(value: string): string {
	return value.match(/.{1,4}/g)?.slice(0, 4).join(" ") ?? value;
}

/**
 * How much longer an enrollment code is worth reading out.
 *
 * A code with eight seconds left looks exactly like a fresh one, and the
 * operator is the one walking to another machine to type it. The number is
 * what tells them to press the button again rather than to debug the agent.
 */
function remaining(expiresAt: number, now: number): string {
	const left = Math.max(0, expiresAt - now);
	if (left === 0) return "expired";
	const minutes = Math.floor(left / 60_000);
	const seconds = Math.floor((left % 60_000) / 1_000);
	return minutes > 0 ? `${minutes}m ${seconds}s left` : `${seconds}s left`;
}

/** When something joined, in the room's words rather than a timestamp's. */
function joined(at: number, now: number): string {
	const ago = Math.max(0, now - at);
	if (ago < 60_000) return "joined just now";
	if (ago < 3_600_000) return `joined ${Math.floor(ago / 60_000)}m ago`;
	if (ago < 86_400_000) return `joined ${Math.floor(ago / 3_600_000)}h ago`;
	return `joined ${new Date(at).toLocaleDateString()}`;
}

export function Room() {
	const [identity, setIdentity] = useState<NodeIdentity | null>(null);
	const [room, setRoom] = useState<RoomInfo | null>(null);
	const [roomDraft, setRoomDraft] = useState<string | null>(null);
	const [peers, setPeers] = useState<NodeMemberInfo[]>([]);
	const [nearby, setNearby] = useState<NearbyNodeInfo[]>([]);
	const [incoming, setIncoming] = useState<IncomingNodeRequestInfo[]>([]);
	const [outgoing, setOutgoing] = useState<OutgoingNodeRequestInfo[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [note, setNote] = useState("");
	const [invite, setInvite] = useState<NodeInvite | null>(null);
	const [advancedOrigin, setAdvancedOrigin] = useState("");
	const [advancedCode, setAdvancedCode] = useState("");
	/* The code a phone scans or types to join this room. Same one-time code
	 * the plain-browser "Web access" pairing mints — a phone's `/node/join`
	 * spends it exactly like a browser's `/pair` does — so this is a second
	 * front door onto machinery that already exists, not a new one. */
	const [roomInvite, setRoomInvite] = useState<{ qr: string; code: string } | null>(null);
	/* An outside agent's way in. Same ceremony as the phone invite above — a
	 * short code the operator reads off this screen — but typed into a config
	 * on another machine rather than scanned, so it is shown as text with the
	 * address and the certificate it needs to get here. */
	const [seats, setSeats] = useState<ClientSeatInfo[]>([]);
	const [enrollment, setEnrollment] = useState<ClientEnrollmentInfo | null>(null);
	/* A clock, because a code's remaining life and an agent's "joined 3m ago"
	 * are facts about now rather than about the last answer the desk gave. */
	const [now, setNow] = useState(() => Date.now());

	const refresh = useCallback(async () => {
		const [nextPeers, nextNearby, nextIncoming, nextOutgoing, nextRoom, nextSeats, nextCode] =
			await Promise.all([
				api.nodeMembers(),
				api.nodeNearby(),
				api.nodeIncoming(),
				api.nodeOutgoing(),
				api.roomInfo(),
				api.listClientSeats(),
				api.currentClientEnrollment(),
			]);
		setPeers(nextPeers);
		setNearby(nextNearby);
		setIncoming(nextIncoming);
		setOutgoing(nextOutgoing);
		setRoom(nextRoom);
		setSeats(nextSeats);
		/* Read back rather than remembered, so a code that expired or was spent
		 * stops being on screen — a code the desk still shows and the room no
		 * longer honours is the one thing this pane must never do. */
		setEnrollment(nextCode);
	}, []);

	useEffect(() => {
		void api.nodeInfo().then(setIdentity, () => undefined);
		void refresh().catch(() => undefined);
		const timer = window.setInterval(() => void refresh().catch(() => undefined), POLL_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);

	/* Its own tick, because a countdown has to move every second and the desk
	 * has nothing new to say that often. */
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, []);

	const desks = useMemo(() => peers.filter((peer) => !peer.mobile), [peers]);
	const phones = useMemo(() => peers.filter((peer) => peer.mobile), [peers]);
	const linked = useMemo(() => new Set(desks.map((peer) => peer.id)), [desks]);
	const requests = useMemo(
		() => new Map(outgoing.map((request) => [request.nodeId, request])),
		[outgoing],
	);
	const candidates = nearby.filter((node) => !linked.has(node.id));

	/* The desks a grant can name: this one, then every linked desk. */
	const grantable = useMemo(
		() => [
			...(identity ? [{ id: identity.id, name: `${identity.name} (this desktop)` }] : []),
			...desks.map((desk) => ({ id: desk.id, name: desk.name })),
		],
		[identity, desks],
	);

	const toggleGrant = async (phone: NodeMemberInfo, deskId: string) => {
		const current = phone.grant ?? [];
		const next = current.includes(deskId)
			? current.filter((id) => id !== deskId)
			: [...current, deskId];
		setBusy(phone.id);
		const result = await api
			.memberSetGrant(phone.id, next)
			.catch(() => ({ ok: false, error: "Could not change that phone's access." }));
		setBusy(null);
		if (!result.ok) setNote(result.error ?? "Could not change that phone's access.");
		await refresh().catch(() => undefined);
	};

	const toggleSeatGrant = async (seat: ClientSeatInfo, deskId: string) => {
		const next = seat.grant.includes(deskId)
			? seat.grant.filter((id) => id !== deskId)
			: [...seat.grant, deskId];
		setBusy(seat.clientId);
		const result = await api
			.memberSetGrant(seat.clientId, next)
			.catch(() => ({ ok: false, error: "Could not change that agent's access." }));
		setBusy(null);
		if (!result.ok) setNote(result.error ?? "Could not change that agent's access.");
		await refresh().catch(() => undefined);
	};

	const removeSeat = async (seat: ClientSeatInfo) => {
		setBusy(seat.clientId);
		const result = await api
			.memberRevoke(seat.clientId)
			.catch(() => ({ revoked: false, error: "Could not remove that agent." }));
		setBusy(null);
		setNote(
			result.revoked
				? "Agent removed. Its tokens stopped working now; rejoining needs a new enrollment code."
				: (result.error ?? "That agent was already gone."),
		);
		await refresh().catch(() => undefined);
	};

	const showEnrollment = async () => {
		const next = await api.createClientEnrollment().catch(() => null);
		if (!next?.mcpUrl) {
			setNote(
				"An agent joins over HTTPS, and this desk has no certificate yet — turn Web access on in Settings → General.",
			);
			return;
		}
		setEnrollment(next);
		setNote("");
	};

	const hideEnrollment = async () => {
		await api.cancelClientEnrollment().catch(() => undefined);
		setEnrollment(null);
	};

	const removePhone = async (phone: NodeMemberInfo) => {
		setBusy(phone.id);
		const result = await api
			.memberRevoke(phone.id)
			.catch(() => ({ revoked: false, error: "Could not remove that phone." }));
		setBusy(null);
		setNote(
			result.revoked
				? "Phone removed. Every linked desktop learns this; re-admitting needs a new code from here."
				: (result.error ?? "That phone was already gone."),
		);
		await refresh().catch(() => undefined);
	};

	const saveRoomName = async () => {
		const name = (roomDraft ?? "").trim();
		if (!name || name === room?.name) {
			setRoomDraft(null);
			return;
		}
		const result = await api
			.roomRename(name)
			.catch(() => ({ ok: false as const, error: "Could not rename the room." }));
		if (result.ok) {
			setRoomDraft(null);
			setNote(room ? "Room renamed — every member learns it." : "Room named.");
		} else {
			setNote(result.error ?? "Could not rename the room.");
		}
		await refresh().catch(() => undefined);
	};

	const unlink = async (id: string) => {
		setBusy(id);
		const { revoked } = await api.fleetRevoke(id).catch(() => ({ revoked: false }));
		setBusy(null);
		setNote(revoked ? "Node unlinked." : "That node was already gone.");
		await refresh().catch(() => undefined);
	};

	const request = async (node: NearbyNodeInfo) => {
		setBusy(node.id);
		setNote("");
		const result = await api
			.nodeRequest(node.id, node.name, node.origin)
			.catch(() => ({ ok: false, error: "Could not reach the local node service." }));
		setBusy(null);
		setNote(result.ok ? `Waiting for ${node.name} to accept.` : result.error ?? "Request failed.");
		await refresh().catch(() => undefined);
	};

	const decide = async (id: string, decision: "accept" | "deny") => {
		setBusy(id);
		setNote("");
		const result = await api
			.nodeDecide(id, decision)
			.catch(() => ({ ok: false, error: "Could not answer that request." }));
		setBusy(null);
		setNote(
			result.ok
				? decision === "accept"
					? "Node linked."
					: "Request denied."
				: result.error ?? "Could not answer that request.",
		);
		await refresh().catch(() => undefined);
	};

	const showRoomInvite = async () => {
		const { url, code } = await api
			.createWebPairing()
			.catch(() => ({ url: null, code: "" }));
		if (!url) {
			/* Same door `/node/join` answers behind: no code without the plain
			 * HTTP server up, which General's "Serve Toad on the local network"
			 * switch is what starts. Silent here is how General.tsx leaves it,
			 * but that button sits right beside the server switch it depends on
			 * — this one does not, so the note has to say where to look. */
			setNote("Could not create an invite code — check Web access is on in Settings → General.");
			return;
		}
		const qr = await QRCode.toDataURL(url, {
			width: 220,
			margin: 1,
			color: { dark: "#edeef0", light: "#040405" },
		});
		setRoomInvite({ qr, code });
		setNote("");
	};

	const showInvite = async () => {
		const result = await api.nodeInvite().catch(() => ({ error: "Could not create a node token." }));
		if ("error" in result) {
			setNote(result.error);
			return;
		}
		setInvite(result);
		setNote("");
	};

	const joinAdvanced = async () => {
		setBusy("advanced");
		setNote("");
		const result = await api
			.nodeJoin(advancedOrigin, advancedCode)
			.catch(() => ({ ok: false as const, error: "Could not reach the local node service." }));
		setBusy(null);
		if (result.ok) {
			setAdvancedOrigin("");
			setAdvancedCode("");
			setNote(`${result.peer.name} linked.`);
		} else {
			setNote(result.error);
		}
		await refresh().catch(() => undefined);
	};

	const editable = room === null || room.editable;
	return (
		<Section
			title="Room"
			hint="The room is your whole fleet under one name — desktops and phones join it, not each other. Everything below is who is in it and how something new gets in."
		>
			<Field
				label="Name"
				hint={
					room && !room.editable
						? "Renamed on the desktop that founded it."
						: "What an invitation says you are joining."
				}
			>
				{editable ? (
					<div className="flex min-w-0 items-center gap-xs">
						<input
							className="field text-sm"
							aria-label="Room name"
							placeholder="Toad Room"
							value={roomDraft ?? room?.name ?? ""}
							onChange={(event) => setRoomDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void saveRoomName();
							}}
						/>
						{roomDraft !== null && roomDraft.trim() !== (room?.name ?? "") && (
							<button type="button" className="btn-outline shrink-0" onClick={() => void saveRoomName()}>
								{room ? "Rename" : "Name it"}
							</button>
						)}
					</div>
				) : (
					<p className="m-0 text-sm text-ink">{room?.name}</p>
				)}
			</Field>

			<Field
				label="Invite"
				hint={`A phone scans or types this to join ${room?.name || "this room"}. Codes expire after two minutes.`}
			>
				{roomInvite ? (
					<div className="flex flex-col items-start gap-xs">
						<img
							src={roomInvite.qr}
							alt="Invite QR code"
							className="rounded-md border border-rule"
							width={220}
							height={220}
						/>
						<p className="m-0 font-mono text-sm tracking-wide text-ink">{roomInvite.code}</p>
						<button type="button" className="btn-ghost" onClick={() => setRoomInvite(null)}>
							Done
						</button>
					</div>
				) : (
					<button type="button" className="btn-outline" onClick={() => void showRoomInvite()}>
						Show invite code
					</button>
				)}
			</Field>

			{identity && (
				<Field label="This desktop" hint="Its key fingerprint is stable across address changes.">
					<div className="min-w-0">
						<p className="m-0 text-sm text-ink">{identity.name}</p>
						<p className="m-0 truncate font-mono text-2xs text-ink-3">
							{shortFingerprint(identity.fingerprint)}
						</p>
					</div>
				</Field>
			)}

			<Field label="Desktops">
				{desks.length === 0 ? (
					<p className="m-0 text-xs leading-relaxed text-ink-3">No other desktops in this room.</p>
				) : (
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{desks.map((peer) => (
							<li key={peer.id} className="flex items-center gap-sm py-xs">
								<span className="min-w-0 flex-1">
									<span className="block text-sm text-ink">{peer.name}</span>
									<span
										className="flex min-w-0 items-center gap-2xs"
										title={
											peer.wire?.up
												? peer.wire.encrypted
													? "The live link rides TLS."
													: "The live link is not encrypted."
												: undefined
										}
									>
										{/* The wire's own word on its transport, not the stored
										    origin's scheme — an incoming link rides this desk's
										    listener, whatever the row says. No wire, no claim. */}
										{peer.wire?.up &&
											(peer.wire.encrypted ? (
												<LockIcon className="h-3 w-3 shrink-0 text-ink-3" />
											) : (
												<UnlockedIcon className="h-3 w-3 shrink-0 text-warn" />
											))}
										{peer.wire?.up && (
											<span className="sr-only">
												{peer.wire.encrypted ? "Encrypted link." : "Unencrypted link."}
											</span>
										)}
										{/* The link is the currency. A desk that serves no port
										    of its own but dials in is connected — its stored
										    origin is a dial hint, never its status. */}
										<span className={`truncate text-2xs ${peer.wire?.up ? "text-ink-2" : "text-ink-3"}`}>
											{peer.wire?.up
												? peer.wire.direction === "incoming"
													? "Connected — dials in to this desk"
													: "Connected"
												: "No link right now"}
										</span>
									</span>
									<span
										className="block truncate font-mono text-2xs text-ink-3"
										title="The address this desk would dial to reach it; not a statement that it answers there."
									>
										{peer.origin}
									</span>
									<span className="block font-mono text-2xs text-ink-3">
										{peer.fingerprint
											? shortFingerprint(peer.fingerprint)
											: "legacy link — no key fingerprint recorded"}
									</span>
								</span>
								<button
									type="button"
									className="btn-ghost shrink-0"
									disabled={busy === peer.id}
									onClick={() => void unlink(peer.id)}
								>
									Unlink
								</button>
							</li>
						))}
					</ul>
				)}
			</Field>

			<Field
				label="Phones"
				hint="Members of the plane, not devices of one desktop. The checkboxes are which desktops each phone may list and open."
			>
				{phones.length === 0 ? (
					<p className="m-0 text-xs leading-relaxed text-ink-3">
						No phones have joined. A phone joins by scanning this room's invite code.
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{phones.map((phone) => {
							const mine = identity !== null && phone.ownerNode === identity.id;
							const ownerName =
								desks.find((desk) => desk.id === phone.ownerNode)?.name ?? phone.ownerNode;
							return (
								<li key={phone.id} className="flex flex-col gap-2xs py-xs">
									<span className="flex items-center gap-sm">
										<span className="min-w-0 flex-1">
											<span className="block text-sm text-ink">{phone.name}</span>
											<span className="block truncate font-mono text-2xs text-ink-3">
												{phone.fingerprint ? shortFingerprint(phone.fingerprint) : phone.id}
											</span>
										</span>
										{mine ? (
											<button
												type="button"
												className="btn-ghost shrink-0"
												disabled={busy === phone.id}
												onClick={() => void removePhone(phone)}
											>
												Remove
											</button>
										) : (
											<span className="shrink-0 text-2xs text-ink-3">managed on {ownerName}</span>
										)}
									</span>
									<span className="flex flex-wrap gap-sm">
										{grantable.map((desk) => (
											<label key={desk.id} className="flex items-center gap-2xs text-xs text-ink-2">
												<input
													type="checkbox"
													checked={(phone.grant ?? []).includes(desk.id)}
													disabled={!mine || busy === phone.id}
													onChange={() => void toggleGrant(phone, desk.id)}
												/>
												{desk.name}
											</label>
										))}
									</span>
								</li>
							);
						})}
					</ul>
				)}
			</Field>

			<Field
				label="Agents"
				hint="MCP clients outside Toad — a Claude Code session, a script, an agent on another machine. Members of the room like a phone: their own name, and the checkboxes are which desktops each may reach. An agent can see the teammates on those desktops, read their conversations and message them; every message it sends carries its name and the desktop it came in through."
			>
				<div className="flex min-w-0 flex-col gap-sm">
					{enrollment ? (
						<div className="flex flex-col items-start gap-2xs">
							<p className="m-0 flex items-baseline gap-xs">
								<span className="font-mono text-sm tracking-wide text-ink">{enrollment.code}</span>
								<span className="text-2xs text-ink-3">
									{remaining(enrollment.expiresAt, now)}
								</span>
							</p>
							{/* Two doors, and the operator should not have to know which
							    one their agent takes. An app with a browser is pointed at
							    the room and asks for this code itself; a headless one is
							    handed it. Both spend the same code, once. */}
							<p className="m-0 text-2xs text-ink-3">
								Point the agent at <span className="font-mono">{enrollment.mcpUrl}</span>. If it opens
								a browser to connect, this code goes on the page it lands on. If it has no browser, it
								registers at <span className="font-mono">{enrollment.registrationEndpoint}</span> with
								this code as its bearer token. One use, and this desk stops honouring it when the time
								above runs out.
							</p>
							{enrollment.certPath && (
								<p className="m-0 text-2xs text-ink-3">
									This room's certificate is self-signed — point the agent's machine at{" "}
									<span className="font-mono">{enrollment.certPath}</span> to trust it.
								</p>
							)}
							<button type="button" className="btn-ghost" onClick={() => void hideEnrollment()}>
								Done
							</button>
						</div>
					) : (
						<button type="button" className="btn-outline self-start" onClick={() => void showEnrollment()}>
							Show enrollment code
						</button>
					)}

					{seats.length === 0 ? (
						<p className="m-0 text-xs leading-relaxed text-ink-3">
							No agents have joined. An agent joins by registering with an enrollment code from here.
						</p>
					) : (
						<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
							{seats.map((seat) => {
								const mine = identity !== null && seat.ownerNode === identity.id;
								const ownerName =
									desks.find((desk) => desk.id === seat.ownerNode)?.name ?? seat.ownerNode;
								return (
									<li key={seat.clientId} className="flex flex-col gap-2xs py-xs">
										<span className="flex items-center gap-sm">
											<span className="min-w-0 flex-1">
												<span className="block text-sm text-ink">{seat.name}</span>
												<span className="block truncate font-mono text-2xs text-ink-3">
													{seat.clientId}
												</span>
												<span className="block text-2xs text-ink-3">
													{/* What it is and when it arrived — an agent's row has no
													    fingerprint to recognize it by, and a name it chose
													    for itself is not enough to tell two apart. */}
													{seat.connected ? "Connected to this desktop" : "Not connected here"}
													{" · "}
													{joined(seat.admittedAt, now)}
													{seat.software && ` · ${seat.software.id} ${seat.software.version}`}
												</span>
											</span>
											{mine ? (
												<button
													type="button"
													className="btn-ghost shrink-0"
													disabled={busy === seat.clientId}
													onClick={() => void removeSeat(seat)}
												>
													Remove
												</button>
											) : (
												<span className="shrink-0 text-2xs text-ink-3">managed on {ownerName}</span>
											)}
										</span>
										<span className="flex flex-wrap gap-sm">
											{grantable.map((desk) => (
												<label
													key={desk.id}
													className="flex items-center gap-2xs text-xs text-ink-2"
												>
													<input
														type="checkbox"
														checked={seat.grant.includes(desk.id)}
														disabled={!mine || busy === seat.clientId}
														onChange={() => void toggleSeatGrant(seat, desk.id)}
													/>
													{desk.name}
												</label>
											))}
										</span>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</Field>

			{incoming.length > 0 && (
				<Field label="Incoming requests" hint="Accept only a desktop and fingerprint you recognize.">
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{incoming.map((request) => (
							<li key={request.id} className="flex items-center gap-sm py-xs">
								<span className="min-w-0 flex-1">
									<span className="block text-sm text-ink">{request.node.name}</span>
									<span className="block truncate font-mono text-2xs text-ink-3">
										{shortFingerprint(request.node.fingerprint)}
									</span>
								</span>
								<button
									type="button"
									className="btn-outline shrink-0"
									disabled={busy === request.id}
									onClick={() => void decide(request.id, "deny")}
								>
									Deny
								</button>
								<button
									type="button"
									className="btn-primary shrink-0"
									disabled={busy === request.id}
									onClick={() => void decide(request.id, "accept")}
								>
									Accept
								</button>
							</li>
						))}
					</ul>
				</Field>
			)}

			<Field label="Nearby desktops" hint="Toad desktops advertising on this local network.">
				{candidates.length === 0 ? (
					<p className="m-0 text-xs text-ink-3">No unjoined desktops nearby.</p>
				) : (
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{candidates.map((node) => {
							const sent = requests.get(node.id);
							const compatible = node.protocol === 1;
							const waiting = sent?.status === "pending";
							return (
								<li key={node.id} className="flex items-center gap-sm py-xs">
									<span className="min-w-0 flex-1">
										<span className="block text-sm text-ink">{node.name}</span>
										<span className="block truncate font-mono text-2xs text-ink-3">
											{node.origin}
										</span>
										{sent && sent.status !== "pending" && (
											<span className="block text-2xs text-ink-3">
												{sent.error ?? sent.status}
											</span>
										)}
									</span>
									<button
										type="button"
										className="btn-outline shrink-0"
										disabled={!compatible || waiting || busy === node.id}
										onClick={() => void request(node)}
									>
										{!compatible ? "Update required" : waiting ? "Waiting…" : "Request link"}
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</Field>

			<Field
				label="Advanced linking"
				hint="Use an address and one-time token when discovery cannot cross your network."
			>
				<div className="flex min-w-0 flex-col gap-xs">
					{invite ? (
						<div className="rounded-md border border-rule p-sm">
							<p className="m-0 text-xs text-ink-3">Enter these on the other desktop within two minutes.</p>
							<p className="mt-xs break-all font-mono text-xs text-ink">{invite.origin}</p>
							<p className="mt-2xs font-mono text-sm tracking-wide text-ink">{invite.code}</p>
							<button type="button" className="btn-ghost mt-xs" onClick={() => setInvite(null)}>
								Done
							</button>
						</div>
					) : (
						<button type="button" className="btn-outline self-start" onClick={() => void showInvite()}>
							Show address and token
						</button>
					)}

					<input
						className="field font-mono text-xs"
						aria-label="Node address"
						placeholder="192.168.1.20 or host:4681"
						value={advancedOrigin}
						onChange={(event) => setAdvancedOrigin(event.target.value)}
					/>
					<input
						className="field font-mono text-xs tracking-wide"
						aria-label="One-time node token"
						placeholder="one-time token"
						value={advancedCode}
						onChange={(event) => setAdvancedCode(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void joinAdvanced();
						}}
					/>
					<button
						type="button"
						className="btn-primary self-start"
						disabled={busy === "advanced" || !advancedOrigin.trim() || !advancedCode.trim()}
						onClick={() => void joinAdvanced()}
					>
						Link node
					</button>
				</div>
			</Field>

			{note && <p className="m-0 text-xs text-ink-3">{note}</p>}
		</Section>
	);
}
