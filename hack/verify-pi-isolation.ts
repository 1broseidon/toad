/**
 * Proves Toad Agent does not inherit personal home-dir skills or a home-dir
 * AGENTS.md, and still sees workspace ones.
 *
 * Run: bun hack/verify-pi-isolation.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
	contextFilesInWorkspace,
	withoutHomeAgentsSkills,
} from "../src/bun/pi/isolation";

const home = mkdtempSync(join(tmpdir(), "toad-iso-home-"));
process.env.HOME = home;

const workspace = mkdtempSync(join(tmpdir(), "toad-iso-cwd-"));
const agentDir = mkdtempSync(join(tmpdir(), "toad-iso-pi-"));

function skill(dir: string, name: string, description: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
	);
}

skill(join(home, ".agents", "skills", "personal"), "personal-home", "must not load");
skill(join(workspace, ".agents", "skills", "workspace"), "workspace-local", "must load");
writeFileSync(join(home, "AGENTS.md"), "# home agents\n");
writeFileSync(join(workspace, "AGENTS.md"), "# workspace agents\n");

const git = Bun.spawnSync(["git", "init"], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
if (git.exitCode !== 0) {
	console.error(git.stderr.toString());
	process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};

const loader = new DefaultResourceLoader({
	cwd: workspace,
	agentDir,
	skillsOverride: ({ skills, diagnostics }) => ({
		skills: withoutHomeAgentsSkills(skills),
		diagnostics,
	}),
	agentsFilesOverride: ({ agentsFiles }) => ({
		agentsFiles: contextFilesInWorkspace(agentsFiles, workspace, agentDir),
	}),
});
await loader.reload();

const skills = loader.getSkills().skills.map((skill) => skill.name).sort();
const files = loader.getAgentsFiles().agentsFiles.map((file) => file.path);

check("workspace skill is present", skills.includes("workspace-local"), skills);
check("home-dir skill is absent", !skills.includes("personal-home"), skills);
check(
	"workspace AGENTS.md is present",
	files.some((path) => path === join(workspace, "AGENTS.md")),
	files,
);
check(
	"home-dir AGENTS.md is absent",
	!files.some((path) => path === join(home, "AGENTS.md") || dirname(path) === home),
	files,
);

const parent = mkdtempSync(join(tmpdir(), "toad-iso-parent-"));
const nested = join(parent, "workspace");
mkdirSync(nested);
const clamped = contextFilesInWorkspace(
	[
		{ path: join(parent, "AGENTS.md") },
		{ path: join(nested, "AGENTS.md") },
		{ path: join(agentDir, "AGENTS.md") },
	],
	nested,
	agentDir,
).map((file) => file.path);
check(
	"without a git repo, parent AGENTS.md is dropped",
	!clamped.includes(join(parent, "AGENTS.md")) &&
		clamped.includes(join(nested, "AGENTS.md")) &&
		clamped.includes(join(agentDir, "AGENTS.md")),
	clamped,
);

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
