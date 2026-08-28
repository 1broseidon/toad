import { useEffect, useState } from "react";
import type { AppInfo, FleetRolloutProgress, UpdateStatus } from "../../../../shared/types";
import { api, on } from "../../../rpc";
import { Detail, Section } from "../../fields";

type Props = { info: AppInfo | null };

export function About({ info }: Props) {
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	const [pending, setPending] = useState<"check" | "download" | "apply" | null>(null);
	const [peerCount, setPeerCount] = useState(0);
	const [rollout, setRollout] = useState<FleetRolloutProgress | null>(null);

	useEffect(() => {
		let cancelled = false;
		void api.getUpdateStatus().then(
			(next) => {
				if (!cancelled) setStatus(next);
			},
			() => {
				/* An older desktop will not know this method. */
			},
		);
		void api.fleetPeers().then(
			(peers) => {
				if (!cancelled) setPeerCount(peers.length);
			},
			() => undefined,
		);
		const off = on("updateStatusChanged", setStatus);
		const offRollout = on("fleetRolloutChanged", setRollout);
		return () => {
			cancelled = true;
			off();
			offRollout();
		};
	}, []);

	const run = async (kind: "check" | "download" | "apply", action: () => Promise<UpdateStatus>) => {
		setPending(kind);
		try {
			setStatus(await action());
		} catch (error) {
			setStatus({
				phase: "error",
				message: error instanceof Error ? error.message : String(error),
				currentVersion: info?.version ?? "",
				currentHash: "",
			});
		} finally {
			setPending(null);
		}
	};

	const phase = status?.phase ?? "idle";
	const checking = pending === "check" || phase === "checking";
	const downloading = pending === "download" || phase === "downloading";
	const applying = pending === "apply" || phase === "applying";

	/* The build actually running. The live status re-reads it on every event,
	 * where `info` was read once when the pane opened — same source, but only
	 * one of them is still being asked. */
	const running = status?.currentVersion || info?.version || "";
	const failed = status?.failedUpdate;
	/* Two lines the failure line already covers: `idle` ("You're on 0.2.2." —
	 * true, and empty), and the updater's own error, which says the same thing
	 * without naming the build we are still on. Everything else — a server we
	 * could not reach, a download in flight — is news a past failure does not
	 * carry, so it keeps its line. */
	const redundant =
		Boolean(failed) &&
		(phase === "idle" ||
			Boolean(failed?.reason && status?.message.includes(failed.reason)));

	return (
		<Section title="About">
			<dl className="flex flex-col gap-3xs text-xs text-ink-3">
				<Detail term="Running" value={running || "unreleased build"} />
				<Detail term="Channel" value={info?.channel || "dev"} />
				{info?.identifier && <Detail term="Identifier" value={info.identifier} mono />}
			</dl>
			<div className="flex flex-col items-start gap-2xs">
				{!redundant && (
					<p className="text-xs leading-relaxed text-ink-3">
						{status?.message ?? "Installed releases check toad.team for a newer build."}
					</p>
				)}
				{failed && (
					<p className="text-xs leading-relaxed text-accent">
						{`Still on ${running || "this build"} — the update to ${failed.version} failed`}
						{failed.phase ? ` at ${failed.phase}` : ""}
						{failed.reason ? `: ${failed.reason}` : "."}
					</p>
				)}
				{phase === "downloading" && status?.progress != null && (
					<div
						className="h-1 w-full overflow-hidden rounded-full bg-paper-3"
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={status.progress}
					>
						<div className="h-full bg-ink-2" style={{ width: `${status.progress}%` }} />
					</div>
				)}
				{phase === "available" ? (
					<button
						type="button"
						className="btn-outline"
						disabled={Boolean(pending)}
						onClick={() => void run("download", () => api.downloadUpdate())}
					>
						{downloading ? "Downloading…" : "Download update"}
					</button>
				) : phase === "ready" || phase === "blocked" ? (
					<button
						type="button"
						className="btn-primary"
						disabled={Boolean(pending) || applying}
						onClick={() => void run("apply", () => api.applyUpdate())}
					>
						{applying ? "Restarting…" : "Restart to update"}
					</button>
				) : phase === "downloading" || phase === "applying" ? null : (
					<button
						type="button"
						className="btn-outline"
						disabled={Boolean(pending) || checking}
						onClick={() => void run("check", () => api.checkForUpdate())}
					>
						{checking ? "Checking…" : "Check for updates"}
					</button>
				)}
			</div>
			{/* A lone desk already has the button above; the room only appears
			    when there is one. */}
			{peerCount > 0 && (
				<div className="flex flex-col items-start gap-2xs border-t border-rule pt-sm">
					<p className="text-xs leading-relaxed text-ink-3">
						{rollout?.message ??
							`Update all ${peerCount + 1} desks, one at a time. Each waits for its teammates to finish working.`}
					</p>
					{rollout && rollout.desks.length > 0 && (
						<ul className="flex w-full flex-col gap-3xs text-xs text-ink-3">
							{rollout.desks.map((desk) => (
								<li key={desk.nodeId} className="flex items-baseline justify-between gap-sm">
									<span className="text-ink-2">{desk.name}</span>
									<span className={desk.step === "failed" ? "text-accent" : undefined}>
										{desk.detail ?? desk.step}
									</span>
								</li>
							))}
						</ul>
					)}
					<button
						type="button"
						className="btn-outline"
						disabled={Boolean(pending) || Boolean(rollout?.running)}
						onClick={() => {
							setRollout({ running: true, desks: [], message: "Starting…" });
							/* The call outlives the answer: a rollout runs for minutes
							 * and ends by restarting this desk, so the reply usually
							 * never lands. Progress arrives on the event instead, and a
							 * late transport failure must not erase it. */
							void api.startFleetUpdate().then(setRollout, (error: unknown) =>
								setRollout((current) =>
									current && current.desks.length > 0
										? current
										: {
												running: false,
												desks: [],
												message: error instanceof Error ? error.message : String(error),
											},
								),
							);
						}}
					>
						{rollout?.running ? "Updating the room…" : "Update every desk"}
					</button>
				</div>
			)}
		</Section>
	);
}
