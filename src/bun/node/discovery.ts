import { isIP } from "node:net";
import Bonjour from "bonjour-service";
import type { NearbyNodeInfo } from "../../shared/types";
import { nodeIdentity } from "./identity";

const SERVICE_TYPE = "toad-node";
const nearby = new Map<string, NearbyNodeInfo>();

let bonjour: Bonjour | null = null;
let browser: Bonjour.Browser | null = null;

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return "";
}

function hostForUrl(host: string): string {
	const clean = host.replace(/\.$/, "");
	return isIP(clean) === 6 ? `[${clean}]` : clean;
}

function readService(service: Bonjour.Service): NearbyNodeInfo | null {
	const id = text(service.txt?.id);
	const name = text(service.txt?.name) || service.name;
	const protocol = Number(text(service.txt?.protocol));
	const me = nodeIdentity();
	if (!id || id === me.id || !name || !Number.isFinite(protocol) || !service.port) return null;

	const addresses = service.addresses ?? [];
	const address =
		addresses.find((candidate) => isIP(candidate) === 4 && !candidate.startsWith("127.")) ??
		service.referer?.address ??
		addresses[0] ??
		service.host;
	if (!address) return null;
	return {
		id,
		name,
		origin: `http://${hostForUrl(address)}:${service.port}`,
		protocol,
		lastSeenAt: Date.now(),
	};
}

function remember(service: Bonjour.Service): void {
	const node = readService(service);
	if (node) nearby.set(node.id, node);
}

export function startNodeDiscovery(port: number): void {
	if (bonjour || process.env.TOAD_DISABLE_MDNS === "1") return;
	const identity = nodeIdentity();
	try {
		bonjour = new Bonjour({}, (error: Error) => {
			console.warn("node discovery:", error.message);
		});
		const published = bonjour.publish({
			// Two Toad profiles can share one hostname. The service instance must
			// still be unique even though the human-facing TXT name stays plain.
			name: `${identity.name} ${identity.id.slice(-6)}`,
			type: SERVICE_TYPE,
			protocol: "tcp",
			port,
			txt: {
				id: identity.id,
				name: identity.name,
				protocol: String(identity.protocol),
				pairing: "available",
			},
		});
		published.on("error", (error) => console.warn("node advertisement:", error));
		browser = bonjour.find({ type: SERVICE_TYPE, protocol: "tcp" }, remember);
		browser.on("down", (service) => {
			const id = text(service.txt?.id);
			if (id) nearby.delete(id);
		});
		browser.on("srv-update", (service) => remember(service));
		browser.on("txt-update", (service) => remember(service));
	} catch (error) {
		console.warn("node discovery failed to start:", error);
		browser = null;
		bonjour?.destroy();
		bonjour = null;
	}
}

export function listNearbyNodes(): NearbyNodeInfo[] {
	const staleBefore = Date.now() - 2 * 60_000;
	for (const [id, node] of nearby) {
		if (node.lastSeenAt < staleBefore) nearby.delete(id);
	}
	return [...nearby.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function stopNodeDiscovery(): void {
	browser?.stop();
	browser = null;
	const active = bonjour;
	bonjour = null;
	if (active) active.unpublishAll(() => active.destroy());
	nearby.clear();
}
