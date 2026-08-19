import { isAbsolute, relative } from "node:path";
import type { ToolOutput } from "../../shared/types";

/** Where each built-in tool keeps the thing it is acting on. */
const PATH_KEYS = ["path", "file_path", "filePath", "file"];

function pathOf(args: Record<string, unknown> | undefined): string | undefined {
	for (const key of PATH_KEYS) {
		const value = args?.[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function trim(value: string, max = 72): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What a tool call is doing, in a few words.
 *
 * ACP backends send a human-written title with every call; pi sends the tool
 * name and its arguments, which is more honest but not a sentence. The
 * transcript shows one line per call, so this is that line — the file being
 * touched or the command being run, because that is the part anyone reading
 * the conversation actually wants to see.
 */
export function describeTool(toolName: string, args: Record<string, unknown> | undefined): string {
	const path = pathOf(args);
	const name = path?.split("/").pop();

	switch (toolName) {
		case "bash": {
			const command = args?.command;
			return typeof command === "string" ? `Run ${trim(command)}` : "Run a command";
		}
		case "read":
			return name ? `Read ${name}` : "Read a file";
		case "write":
			return name ? `Write ${name}` : "Write a file";
		case "edit":
			return name ? `Edit ${name}` : "Edit a file";
		case "grep": {
			const pattern = args?.pattern;
			return typeof pattern === "string" ? `Search for ${trim(pattern, 40)}` : "Search";
		}
		case "find":
			return "Find files";
		case "ls":
			return name ? `List ${name}` : "List files";
		default: {
			/* An MCP tool is named `<server>__<tool>` so the model has one flat
			 * namespace; the transcript is not the model, and reads better with the
			 * server it came from set apart from the thing it did. */
			const [server, ...rest] = toolName.split("__");
			if (server && rest.length > 0) return `${server}: ${rest.join("__").replace(/_/g, " ")}`;
			return name ? `${toolName} — ${name}` : toolName;
		}
	}
}

/** The file a call touched, relative to the workspace where that reads better. */
export function locationsOf(
	cwd: string,
	args: Record<string, unknown> | undefined,
): string[] | undefined {
	const path = pathOf(args);
	if (!path) return undefined;
	if (!isAbsolute(path)) return [path];
	const inside = relative(cwd, path);
	return [inside.startsWith("..") ? path : inside];
}

type ToolResult = {
	content?: Array<{ type?: string; text?: string }>;
	details?: { patch?: unknown; diff?: unknown; path?: unknown; oldText?: unknown; newText?: unknown };
};

const MAX_OUTPUT = 8_000;

/**
 * A tool result as transcript output.
 *
 * `edit` and `write` carry structured before/after text in `details`, which the
 * transcript can render as a real diff; everything else is text. Long output is
 * cut here rather than at render time, because this is what gets written to
 * disk and replayed on every launch forever.
 */
export function outputOf(result: unknown): ToolOutput[] | undefined {
	const typed = result as ToolResult | undefined;
	const out: ToolOutput[] = [];

	const details = typed?.details;
	if (details && typeof details.newText === "string" && typeof details.path === "string") {
		out.push({
			type: "diff",
			path: details.path,
			oldText: typeof details.oldText === "string" ? details.oldText : null,
			newText: details.newText,
		});
	}

	for (const block of typed?.content ?? []) {
		if (block?.type !== "text" || typeof block.text !== "string" || block.text.length === 0) {
			continue;
		}
		out.push({
			type: "text",
			text:
				block.text.length > MAX_OUTPUT
					? `${block.text.slice(0, MAX_OUTPUT)}\n… (${block.text.length - MAX_OUTPUT} more characters)`
					: block.text,
		});
	}

	return out.length > 0 ? out : undefined;
}
