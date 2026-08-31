import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	PluginEventSpec,
	PluginGrants,
	PluginManifest,
	PluginToolSpec,
} from "../../shared/types";

/**
 * `toad-plugin.json`, read strictly.
 *
 * The manifest is authoritative: it is the tool list Toad answers `tools/list`
 * from, so a plugin whose live server disagrees with it does not install. That
 * inversion is the thing that makes a plugin's tools enumerable before the
 * process is awake, and enumerable is the whole design — a tool absent for a
 * named reason instead of absent in silence.
 *
 * So this file refuses rather than repairs. Every other normalizer in the tree
 * (`normalizeServers`, `normalizePolicy`) drops what it cannot read, because
 * those read a file a person edits by hand and one bad entry should cost one
 * server. A manifest is a contract from a third party. Half of one is not a
 * smaller contract; it is a plugin whose tool list nobody agreed to.
 */

export const PLUGIN_MANIFEST_FILE = "toad-plugin.json";

export type ManifestResult =
	| { ok: true; manifest: PluginManifest }
	| { ok: false; problems: string[] };

/**
 * Payload fields a plugin may not declare.
 *
 * Every first-hand guarantee in this tree comes from the receiving side
 * stamping provenance itself and never reading it off the frame. A plugin that
 * could declare a `from` in its own payload would be handing its author a
 * field that looks authoritative and is not — the fastest possible route to a
 * plugin becoming a relay for unsigned assertions. Refused at validation, so
 * the mistake cannot be made rather than being caught later.
 */
const RESERVED_PAYLOAD_FIELDS = ["from", "src", "desk", "node"];

/** Reverse-DNS, and legal as a filesystem component and a URL path segment. */
const ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** MCP tool names, and the same set `pi/mcp.ts` will not have to mangle. */
const TOOL_PATTERN = /^[a-zA-Z0-9_-]{1,60}$/;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Any property named like a provenance field, at any depth of a JSON Schema. */
function reservedFieldsIn(schema: unknown, found = new Set<string>()): Set<string> {
	const node = object(schema);
	if (!node) return found;
	const properties = object(node.properties);
	if (properties) {
		for (const key of Object.keys(properties)) {
			if (RESERVED_PAYLOAD_FIELDS.includes(key)) found.add(key);
		}
	}
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) for (const item of value) reservedFieldsIn(item, found);
		else if (value && typeof value === "object") reservedFieldsIn(value, found);
	}
	return found;
}

function readTools(value: unknown, problems: string[]): PluginToolSpec[] {
	if (!Array.isArray(value) || value.length === 0) {
		problems.push("`tools` must be a non-empty array; a plugin with no tools is an MCP server");
		return [];
	}
	const tools: PluginToolSpec[] = [];
	const seen = new Set<string>();
	for (const [index, raw] of value.entries()) {
		const entry = object(raw);
		const name = str(entry?.name);
		if (!entry || !name) {
			problems.push(`tools[${index}] has no name`);
			continue;
		}
		if (!TOOL_PATTERN.test(name)) {
			problems.push(`tools[${index}] name "${name}" must match ${TOOL_PATTERN}`);
			continue;
		}
		if (seen.has(name)) {
			problems.push(`tools[${index}] repeats the name "${name}"`);
			continue;
		}
		seen.add(name);
		const description = str(entry.description);
		if (!description) {
			problems.push(`tools[${index}] "${name}" has no description; the model reads it`);
			continue;
		}
		const inputSchema = object(entry.inputSchema);
		if (!inputSchema) {
			problems.push(`tools[${index}] "${name}" has no inputSchema (JSON Schema object)`);
			continue;
		}
		if (typeof entry.subagentInherits !== "boolean") {
			problems.push(
				`tools[${index}] "${name}" must declare subagentInherits: true or false — there is no default, because whether a subagent may use a tool is a decision and not an oversight`,
			);
			continue;
		}
		tools.push({ name, description, inputSchema, subagentInherits: entry.subagentInherits });
	}
	return tools;
}

function readEvents(value: unknown, problems: string[]): PluginEventSpec[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		problems.push("`events` must be an array");
		return [];
	}
	const events: PluginEventSpec[] = [];
	for (const [index, raw] of value.entries()) {
		const entry = typeof raw === "string" ? { name: raw } : object(raw);
		const name = str(entry?.name);
		if (!name) {
			problems.push(`events[${index}] has no name`);
			continue;
		}
		const payload = object((entry as Record<string, unknown>).payload);
		if (payload) {
			const reserved = [...reservedFieldsIn(payload)];
			if (reserved.length > 0) {
				problems.push(
					`events[${index}] "${name}" declares ${reserved.join(", ")} in its payload; provenance is stamped by the receiving desk and is never a field a plugin may set`,
				);
				continue;
			}
		}
		events.push(payload ? { name, payload } : { name });
	}
	return events;
}

function readGrants(value: unknown, problems: string[]): PluginGrants {
	const empty: PluginGrants = {
		room: [],
		fleet: { log: [], rpc: { call: false, serve: [] }, events: false, blobs: false },
		acceptFrom: "none",
	};
	const grants = object(value);
	if (!grants) return empty;

	const room = strings(grants.room) ?? [];
	const badRoom = room.filter((entry) => entry !== "desks" && entry !== "teammates");
	if (badRoom.length > 0) {
		problems.push(`grants.room may only name "desks" or "teammates"; got ${badRoom.join(", ")}`);
	}

	const fleet = object(grants.fleet) ?? {};
	const rpc = object(fleet.rpc) ?? {};
	const acceptRaw = grants.acceptFrom;
	const acceptFrom: PluginGrants["acceptFrom"] =
		acceptRaw === "members" || acceptRaw === "none"
			? acceptRaw
			: (strings(acceptRaw) ?? "none");

	return {
		room: room.filter((entry): entry is "desks" | "teammates" => entry === "desks" || entry === "teammates"),
		fleet: {
			log: strings(fleet.log) ?? [],
			rpc: {
				call: fleet.rpc !== undefined && rpc.call === true,
				serve: strings(rpc.serve) ?? [],
			},
			events: fleet.events === true,
			blobs: fleet.blobs === true,
		},
		acceptFrom,
	};
}

export function validateManifest(raw: unknown): ManifestResult {
	const problems: string[] = [];
	const source = object(raw);
	if (!source) return { ok: false, problems: ["the manifest is not a JSON object"] };

	const id = str(source.id);
	if (!id) problems.push("`id` is required and is the plugin's one namespace root");
	else if (!ID_PATTERN.test(id)) {
		problems.push(
			`\`id\` "${id}" must be lowercase reverse-DNS (com.example.board): it names a directory, a URL path segment, a tool prefix and a log space`,
		);
	}

	const version = str(source.version);
	if (!version) problems.push("`version` is required");
	else if (!SEMVER_PATTERN.test(version)) problems.push(`\`version\` "${version}" is not semver`);

	const name = str(source.name) ?? id;
	const description = str(source.description);

	const serve = object(source.serve);
	const command = str(serve?.command);
	if (!command) problems.push("`serve.command` is required: a plugin is a process Toad supervises");
	const args = strings(serve?.args) ?? [];
	if (serve?.args !== undefined && strings(serve.args) === undefined) {
		problems.push("`serve.args` must be an array of strings");
	}

	if (source.env !== undefined) {
		problems.push(
			"`env` is refused in v1: the only place a plugin secret could land today is plaintext beside a mature sealed credential store that MCP does not use",
		);
	}
	if (source.ui !== undefined) {
		problems.push("`ui` is refused in v1: a plugin gets a settings row and the plugin page, no panes");
	}

	const tools = readTools(source.tools, problems);
	const events = readEvents(source.events, problems);
	const logs = strings(source.logs) ?? [];
	if (source.logs !== undefined && strings(source.logs) === undefined) {
		problems.push("`logs` must be an array of log ids");
	}
	const rpcServes = strings(object(source.rpc)?.serves) ?? [];
	for (const method of rpcServes) {
		const reserved = [...reservedFieldsIn(object(source.rpc)?.[method])];
		if (reserved.length > 0) problems.push(`rpc.${method} declares ${reserved.join(", ")}`);
	}
	const grants = readGrants(source.grants, problems);

	/* A grant is a promise about a thing the manifest names. Granting a log the
	 * manifest never declares is not a wider grant, it is a typo, and the only
	 * moment anyone will read this file closely is right now. */
	for (const logId of grants.fleet.log) {
		if (!logs.includes(logId)) problems.push(`grants.fleet.log names "${logId}", which \`logs\` does not declare`);
	}
	for (const method of grants.fleet.rpc.serve) {
		if (!rpcServes.includes(method)) {
			problems.push(`grants.fleet.rpc.serve names "${method}", which \`rpc.serves\` does not declare`);
		}
	}

	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		manifest: {
			id: id!,
			version: version!,
			name: name!,
			...(description ? { description } : {}),
			serve: { command: command!, args },
			tools,
			logs,
			rpc: { serves: rpcServes },
			events,
			grants,
		},
	};
}

/** The manifest in a directory, or why there is not one. */
export function readManifest(dir: string): ManifestResult {
	let resolved = dir;
	try {
		if (!existsSync(resolved)) return { ok: false, problems: [`${resolved} does not exist`] };
		if (!statSync(resolved).isDirectory()) {
			return { ok: false, problems: [`${resolved} is not a directory`] };
		}
	} catch (error) {
		return { ok: false, problems: [`${resolved} could not be read: ${(error as Error).message}`] };
	}
	const file = join(resolved, PLUGIN_MANIFEST_FILE);
	if (!existsSync(file)) return { ok: false, problems: [`no ${PLUGIN_MANIFEST_FILE} in ${resolved}`] };
	try {
		return validateManifest(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		return { ok: false, problems: [`${file} is not valid JSON: ${(error as Error).message}`] };
	}
}

/**
 * Whether a live `tools/list` says what the manifest says.
 *
 * Not "is it a superset": exactly the same set, by name. The manifest is what
 * Toad answers `tools/list` from before the process is awake, so a plugin that
 * really serves something else has made Toad lie to every teammate on the desk.
 * Descriptions and schemas are allowed to drift — the manifest wins on those,
 * and a stale sentence is not worth refusing an install over.
 */
export function toolListDisagreement(
	manifest: PluginManifest,
	live: ReadonlyArray<{ name: string }>,
): string[] {
	const declared = new Set(manifest.tools.map((tool) => tool.name));
	const served = new Set(live.map((tool) => tool.name));
	const problems: string[] = [];
	for (const name of declared) {
		if (!served.has(name)) problems.push(`the manifest declares "${name}" and the plugin does not serve it`);
	}
	for (const name of served) {
		if (!declared.has(name)) problems.push(`the plugin serves "${name}" and the manifest does not declare it`);
	}
	return problems;
}
