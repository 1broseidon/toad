import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Same home pi uses when it attaches `~/.agents/skills` as user skills.
 * `HOME` first, because that is what the package manager reads, and because
 * tests replace HOME rather than mocking os.homedir().
 */
export function piHomeDir(): string {
	return process.env.HOME || homedir();
}

export function isUnder(path: string, root: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	if (resolvedPath === resolvedRoot) return true;
	const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
	return resolvedPath.startsWith(prefix);
}

/** Nearest directory containing `.git`, walking toward the filesystem root. */
export function gitRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Drop skills that came from the user's personal `~/.agents` tree.
 *
 * Workspace `.agents/skills`, `cwd/.pi/skills`, and Toad's own `PI_DIR/skills`
 * stay. Filter on `filePath`: the resource loader's override runs before
 * sourceInfo is attached.
 */
export function withoutHomeAgentsSkills<T extends { filePath: string }>(skills: T[]): T[] {
	const homeAgents = join(piHomeDir(), ".agents");
	return skills.filter((skill) => !isUnder(skill.filePath, homeAgents));
}

/**
 * Keep context files that belong to this teammate: Toad's agentDir, and
 * anything at or under the workspace's git root (or cwd, if there is no repo).
 *
 * pi walks cwd ancestors all the way to `/`, so a default workspace under
 * `$HOME` would otherwise inherit `~/AGENTS.md`.
 */
export function contextFilesInWorkspace<T extends { path: string }>(
	files: T[],
	cwd: string,
	agentDir: string,
): T[] {
	const root = gitRoot(cwd) ?? resolve(cwd);
	return files.filter((file) => isUnder(file.path, agentDir) || isUnder(file.path, root));
}
