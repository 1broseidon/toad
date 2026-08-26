import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	IncomingNodeRequestInfo,
	NearbyNodeInfo,
	NodeIdentity,
	NodeInvite,
	NodeMemberInfo,
	OutgoingNodeRequestInfo,
} from "../../../../shared/types";
import { api } from "../../../rpc";
import { setMergedRoom, useMergedRoom } from "../../../prefs";
import { Field, Section, SettingsToggle } from "../../fields";

const POLL_MS = 2_000;

function shortFingerprint(value: string): string {
	return value.match(/.{1,4}/g)?.slice(0, 4).join(" ") ?? value;
}

export function Nodes() {
	const [identity, setIdentity] = useState<NodeIdentity | null>(null);
	const [peers, setPeers] = useState<NodeMemberInfo[]>([]);
	const [nearby, setNearby] = useState<NearbyNodeInfo[]>([]);
	const [incoming, setIncoming] = useState<IncomingNodeRequestInfo[]>([]);
	const [outgoing, setOutgoing] = useState<OutgoingNodeRequestInfo[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [note, setNote] = useState("");
	const [invite, setInvite] = useState<NodeInvite | null>(null);
	const [advancedOrigin, setAdvancedOrigin] = useState("");
	const [advancedCode, setAdvancedCode] = useState("");
	const merged = useMergedRoom();

	const refresh = useCallback(async () => {
		const [nextPeers, nextNearby, nextIncoming, nextOutgoing] = await Promise.all([
			api.nodeMembers(),
			api.nodeNearby(),
			api.nodeIncoming(),
			api.nodeOutgoing(),
		]);
		setPeers(nextPeers);
		setNearby(nextNearby);
		setIncoming(nextIncoming);
		setOutgoing(nextOutgoing);
	}, []);

	useEffect(() => {
		void api.nodeInfo().then(setIdentity, () => undefined);
		void refresh().catch(() => undefined);
		const timer = window.setInterval(() => void refresh().catch(() => undefined), POLL_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);

	const linked = useMemo(() => new Set(peers.map((peer) => peer.id)), [peers]);
	const requests = useMemo(
		() => new Map(outgoing.map((request) => [request.nodeId, request])),
		[outgoing],
	);
	const candidates = nearby.filter((node) => !linked.has(node.id));

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

	return (
		<Section
			title="Nodes"
			hint="Control-plane members are linked here. Nearby discovery only finds an address; the receiving desktop still approves the request."
		>
			{identity && (
				<Field label="This node" hint="Its key fingerprint is stable across address changes.">
					<div className="min-w-0">
						<p className="m-0 text-sm text-ink">{identity.name}</p>
						<p className="m-0 truncate font-mono text-2xs text-ink-3">
							{shortFingerprint(identity.fingerprint)}
						</p>
					</div>
				</Field>
			)}

			<Field label="One room" hint="Show every linked node's teammates in the rail.">
				<SettingsToggle
					label="Merge every linked node into one room"
					checked={merged}
					onChange={(event) => setMergedRoom(event.target.checked)}
				/>
			</Field>

			<Field label="Linked nodes">
				{peers.length === 0 ? (
					<p className="m-0 text-xs leading-relaxed text-ink-3">Not linked to any other nodes.</p>
				) : (
					<ul className="flex flex-col divide-y divide-rule-2 border-y border-rule-2">
						{peers.map((peer) => (
							<li key={peer.id} className="flex items-center gap-sm py-xs">
								<span className="min-w-0 flex-1">
									<span className="block text-sm text-ink">{peer.name}</span>
									<span className="block truncate font-mono text-2xs text-ink-3">{peer.origin}</span>
									<span className="block font-mono text-2xs text-ink-3">
										{peer.fingerprint
											? shortFingerprint(peer.fingerprint)
											: "legacy link — no node key recorded"}
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

			<Field label="Nearby nodes" hint="Toad desktops advertising on this local network.">
				{candidates.length === 0 ? (
					<p className="m-0 text-xs text-ink-3">No unlinked nodes nearby.</p>
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
