/**
 * Process-local mesh counters: counts, bytes, reset, and the unique-key cap.
 *
 * Run: bun hack/verify-mesh-metrics.ts
 */
import { meshCount, meshReset, meshSnapshot } from "../src/bun/fleet/metrics";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};

meshReset();
const t0 = meshSnapshot();
check("reset starts empty", Object.keys(t0.totals).length === 0 && Object.keys(t0.bytes).length === 0);
check("startedAt is a unix ms timestamp", Number.isFinite(t0.startedAt) && t0.startedAt > 0);

meshCount("send", "personasChanged");
meshCount("send", "personasChanged");
meshCount("webBroadcast", "personasChanged", { bytes: 120 });
meshCount("webBroadcast", "sessionInfoChanged", { bytes: 40 });
meshCount("onPeerPush", "transcriptAppended", { nodeId: "desk-a" });
meshCount("onPeerPushDrop", "personasChanged", { nodeId: "desk-a" });
meshCount("mergePeerRecords", "activity");
meshCount("wireCall", "listPersonas", { nodeId: "desk-b" });
meshCount("wireCallLocal", "listPersonas");

const snap = meshSnapshot();
check("send:personasChanged counted twice", snap.totals["send:personasChanged"] === 2);
check("webBroadcast keys are distinct by name", snap.totals["webBroadcast:personasChanged"] === 1);
check("webBroadcast:sessionInfoChanged counted", snap.totals["webBroadcast:sessionInfoChanged"] === 1);
check("onPeerPush counted", snap.totals["onPeerPush:transcriptAppended"] === 1);
check("onPeerPushDrop counted", snap.totals["onPeerPushDrop:personasChanged"] === 1);
check("mergePeerRecords counted", snap.totals["mergePeerRecords:activity"] === 1);
check("wireCall counted", snap.totals["wireCall:listPersonas"] === 1);
check("wireCallLocal counted", snap.totals["wireCallLocal:listPersonas"] === 1);
check("bytes accumulate on the kind:name key", snap.bytes["webBroadcast:personasChanged"] === 120);
check("bytes for a second name stay separate", snap.bytes["webBroadcast:sessionInfoChanged"] === 40);
check("counts without bytes leave no byte key", snap.bytes["send:personasChanged"] === undefined);
check("nodeId is not a snapshot dimension", Object.keys(snap.totals).every((k) => !k.includes("desk-")));
check("startedAt is stable across counts", snap.startedAt === t0.startedAt);

meshCount("webBroadcast", "personasChanged", { bytes: 30 });
check("repeat count adds bytes on the same key", meshSnapshot().bytes["webBroadcast:personasChanged"] === 150);

const beforeCap = meshSnapshot();
for (let i = 0; i < 400; i++) meshCount("send", `cap-${i}`);
const capped = meshSnapshot();
const totalKeys = Object.keys(capped.totals).length;
const byteKeys = Object.keys(capped.bytes).length;
check("unique keys stop at 256", totalKeys === 256);
check("byte map cannot outgrow the same cap", byteKeys <= 256);
check("keys admitted before the flood are kept", capped.totals["send:personasChanged"] === beforeCap.totals["send:personasChanged"]);
check("a name past the cap is dropped", capped.totals["send:cap-399"] === undefined);

const admitted = Object.keys(capped.totals).filter((k) => k.startsWith("send:cap-")).length;
check("cap admits new keys until the limit, then refuses", admitted === 256 - Object.keys(beforeCap.totals).length);

meshReset();
const after = meshSnapshot();
check("reset clears totals", Object.keys(after.totals).length === 0);
check("reset clears bytes", Object.keys(after.bytes).length === 0);
check("reset advances startedAt", after.startedAt >= snap.startedAt);

meshCount("peerBroadcast", "personasChanged");
check("peerBroadcast is a live kind after reset", meshSnapshot().totals["peerBroadcast:personasChanged"] === 1);
meshCount("nodePeerBroadcast", "personasChanged");
check(
	"nodePeerBroadcast is a live kind after reset",
	meshSnapshot().totals["nodePeerBroadcast:personasChanged"] === 1,
);

console.log(fail === 0 ? `\nmesh-metrics: ${pass} ok` : `\nmesh-metrics: ${fail} failed`);
if (fail) process.exit(1);
