/**
 * Screenshots and screen recordings of the built Linux app, for the repo.
 *
 * Toad draws its own titlebar, so a bare X server is enough to photograph it:
 * no window manager, no desktop, no login. That is what makes this runnable
 * unattended — Xvfb for the screen, the launcher for the app, xdotool for the
 * beats, ffmpeg for the pixels. The default display is a throwaway Xvfb this
 * script starts and kills, so a capture never steals the pointer from whoever
 * is using the real desktop.
 *
 * Two decisions keep the output from looking like a failed UI test:
 *
 *   - The roster is seeded on disk (hack/seed-capture.ts), not typed in. The
 *     app renders the transcript it is given, so the screenshots show a real
 *     conversation without a model key, and without a click that lands one
 *     pixel off after a layout change.
 *   - The beats are the app's own keyboard shortcuts, which are window-level
 *     listeners and do not care where anything is drawn. The pointer is parked
 *     off the furniture and never appears in a frame.
 *
 * Captures crop to the window rather than the screen, so what lands in the
 * repo is the app and nothing else.
 *
 * Needs: Xvfb, xdotool, ffmpeg, and a build (`hutch run build`).
 *
 * Run: bun hack/capture-app.ts stills          # the still set, into assets/screens
 *      bun hack/capture-app.ts video           # one mp4 of the same tour
 *      bun hack/capture-app.ts shot out.png    # one frame of whatever is up
 *      bun hack/capture-app.ts stills --display :1 --attach   # a session you can watch
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "assets/screens");

/* The profile a person actually uses on this machine. --live borrows its
 * credentials so the agent in the capture is the real one; nothing else is
 * read from it, and nothing is ever written back. */
const LIVE_AUTH = join(homedir(), ".local/share/toad/pi/auth.json");

/* The window the app asks for, and a screen with room to hold it. */
const WINDOW_W = 1280;
const WINDOW_H = 860;
const SCREEN_W = 1600;
const SCREEN_H = 1000;

/* Two launchers, because the first run of a fresh build is an installer that
 * unpacks itself into ~/.local/share and exits. The app starts on the next. */
const BUILT = join(ROOT, "build/stable-linux-x64/Toad/bin/launcher");
const INSTALLED = join(homedir(), ".local/share/sh.toad.desktop/stable/app/bin/launcher");

// ---------------------------------------------------------------- small shell

async function run(cmd: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawn(cmd, {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${err.trim() || out.trim()}`);
	return out.trim();
}

async function have(bin: string) {
	const proc = Bun.spawn(["sh", "-c", `command -v ${bin}`], { stdout: "ignore", stderr: "ignore" });
	return (await proc.exited) === 0;
}

// -------------------------------------------------------------------- display

function freeDisplay(): string {
	for (let n = 90; n < 130; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`;
	throw new Error("no free X display between :90 and :129");
}

async function startXvfb(display: string) {
	const proc = Bun.spawn(
		["Xvfb", display, "-screen", "0", `${SCREEN_W}x${SCREEN_H}x24`, "-nolisten", "tcp"],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
	for (let i = 0; i < 100; i++) {
		if (existsSync(socket)) return proc;
		await Bun.sleep(100);
	}
	proc.kill();
	throw new Error(`Xvfb never came up on ${display}`);
}

// ------------------------------------------------------------------------ app

/** The window is titled "Toad" until a teammate is selected, then "Name — Toad". */
async function findWindow(display: string): Promise<string | null> {
	const proc = Bun.spawn(["xdotool", "search", "--name", "Toad$"], {
		env: { ...process.env, DISPLAY: display },
		stdout: "pipe",
		stderr: "ignore",
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim().split("\n").filter(Boolean).at(-1) ?? null;
}

async function waitForWindow(display: string, seconds: number) {
	for (let i = 0; i < seconds * 10; i++) {
		const id = await findWindow(display);
		if (id) return id;
		await Bun.sleep(100);
	}
	return null;
}

async function geometry(display: string, id: string) {
	const shell = await run(["xdotool", "getwindowgeometry", "--shell", id], { DISPLAY: display });
	const g = Object.fromEntries(
		shell.split("\n").map((line) => {
			const [k, v] = line.split("=");
			return [k, Number(v)];
		}),
	);
	return { x: g.X, y: g.Y, w: g.WIDTH, h: g.HEIGHT };
}

async function seed(dataDir: string) {
	await run(["bun", join(ROOT, "hack/seed-capture.ts")], { TOAD_DATA_DIR: dataDir });
}

/** A port the kernel just told us was free, for a plane nobody else shares. */
function freePort(): number {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = probe.port;
	probe.stop(true);
	return port;
}

async function launchApp(display: string, dataDir: string) {
	const launcher = existsSync(INSTALLED) ? INSTALLED : BUILT;
	if (!existsSync(launcher)) throw new Error(`no launcher at ${launcher} — run \`hutch run build\``);

	/* The node plane binds 4681 by default, so a capture run beside a real Toad
	 * takes the port away from one of them. Both get to keep running if the
	 * throwaway one is told to listen somewhere nobody is. */
	const env = {
		DISPLAY: display,
		TOAD_DATA_DIR: dataDir,
		TOAD_NODE_PORT: String(freePort()),
		TOAD_WEB_HTTPS_PORT: String(freePort()),
	};
	const spawn = (bin: string) =>
		Bun.spawn([bin], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });

	let proc = spawn(launcher);
	let id = await waitForWindow(display, 30);
	if (!id) {
		// That run was the installer. The real one is next.
		proc = spawn(INSTALLED);
		id = await waitForWindow(display, 30);
	}
	if (!id) throw new Error("the app never opened a window");
	return { proc, id };
}

// ------------------------------------------------------------------- capturing

async function shot(
	display: string,
	out: string,
	crop?: { x: number; y: number; w: number; h: number },
) {
	mkdirSync(dirname(out), { recursive: true });
	await run([
		"ffmpeg", "-y", "-loglevel", "error",
		"-f", "x11grab", "-draw_mouse", "0",
		"-video_size", crop ? `${crop.w}x${crop.h}` : `${SCREEN_W}x${SCREEN_H}`,
		"-i", crop ? `${display}+${crop.x},${crop.y}` : display,
		"-frames:v", "1", out,
	]);
	return out;
}

function record(
	display: string,
	out: string,
	fps: number,
	crop: { x: number; y: number; w: number; h: number },
) {
	mkdirSync(dirname(out), { recursive: true });
	const proc = Bun.spawn(
		[
			"ffmpeg", "-y", "-loglevel", "error",
			"-f", "x11grab", "-draw_mouse", "0", "-framerate", String(fps),
			"-video_size", `${crop.w}x${crop.h}`, "-i", `${display}+${crop.x},${crop.y}`,
			// yuv420p wants even dimensions, and every player wants yuv420p.
			"-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
			"-pix_fmt", "yuv420p", "-movflags", "+faststart",
			out,
		],
		{ stdin: "pipe", stdout: "ignore", stderr: "ignore" },
	);
	return async () => {
		// "q" on stdin, so ffmpeg writes its trailer instead of losing the file.
		proc.stdin.write("q");
		await proc.stdin.flush();
		await proc.exited;
	};
}

// ---------------------------------------------------------------------- input

function keyboard(display: string, win: { x: number; y: number; w: number; h: number }, id: string) {
	const env = { DISPLAY: display };
	return {
		/**
		 * The app's shortcuts are ordinary `keydown` listeners on the page, so
		 * they only fire once the WebKit widget inside the GTK window holds the
		 * keyboard — and it takes that from a click, not from the pointer merely
		 * resting there. Typing into a field you just clicked works without this;
		 * every accelerator silently does not. So: click an inert stretch of the
		 * transcript, once, before any of them are sent.
		 */
		async focus() {
			const x = String(win.x + Math.round(win.w * 0.72));
			const y = String(win.y + 70);
			await run(["xdotool", "windowactivate", id], env).catch(() => {});
			await run(["xdotool", "mousemove", x, y], env);
			await Bun.sleep(250);
			await run(["xdotool", "click", "1"], env);
			await Bun.sleep(400);
		},
		async press(combo: string, settle = 900) {
			await run(["xdotool", "key", "--clearmodifiers", combo], env);
			await Bun.sleep(settle);
		},
		async title() {
			return await run(["xdotool", "getwindowname", id], env);
		},
		/** The one place a pointer is unavoidable: the composer has no shortcut. */
		async say(text: string) {
			await run(
				["xdotool", "mousemove", String(win.x + Math.round(win.w * 0.6)), String(win.y + win.h - 44)],
				env,
			);
			await Bun.sleep(250);
			await run(["xdotool", "click", "1"], env);
			await Bun.sleep(400);
			await run(["xdotool", "type", "--delay", "45", text], env);
			await Bun.sleep(500);
			await run(["xdotool", "key", "Return"], env);
			// Back off the furniture so no hover state is left in the frame.
			await run(["xdotool", "mousemove", String(win.x + Math.round(win.w * 0.72)), String(win.y + 70)], env);
		},
	};
}

/**
 * A turn is over when the agent says so, and it says so in the transcript: one
 * `turn` event per completed turn, on disk. Counting those beats watching the
 * pixels, which cannot tell "still thinking" from "finished quietly".
 */
async function turnCount(dataDir: string) {
	const dir = JSON.stringify(join(dataDir, "transcripts"));
	const out = await run(["sh", "-c", `grep -ho '"kind":"turn"' -r ${dir} 2>/dev/null | wc -l`]);
	return Number(out.trim());
}

async function waitForTurn(dataDir: string, since: number, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await turnCount(dataDir)) > since) return true;
		await Bun.sleep(1_000);
	}
	return false;
}

/**
 * Ready is not "the window exists" — it is "the roster arrived". Selecting the
 * first teammate renames the window to "Wren — Toad", so the title is a
 * readiness signal that comes from the data rather than from a guessed delay.
 * (On Linux a stalled view sits on "Loading…" forever, and that state is
 * perfectly stable, so waiting for the pixels to stop moving would pass.)
 */
async function waitForRoster(kb: ReturnType<typeof keyboard>, seconds: number) {
	for (let i = 0; i < seconds; i++) {
		await kb.focus();
		await kb.press("ctrl+1", 400);
		if ((await kb.title()).startsWith("Wren")) {
			await Bun.sleep(600);
			return true;
		}
		await Bun.sleep(600);
	}
	return false;
}

/**
 * The view's socket to the main process sometimes never completes on Linux and
 * the window sits on "Loading…" for good — the same race hutch.config.ts works
 * around in dev by serving the view over localhost. There is nothing to wait
 * for when it happens, so a stuck launch is thrown away and relaunched. It has
 * always come up within a couple of tries.
 */
async function bringUp(display: string, dataDir: string, tries = 4) {
	for (let attempt = 1; attempt <= tries; attempt++) {
		const app = await launchApp(display, dataDir);
		const win = await geometry(display, app.id);
		const kb = keyboard(display, win, app.id);
		if (await waitForRoster(kb, 20)) return { app, win, kb };

		console.log(`  (attempt ${attempt} came up on Loading… — relaunching)`);
		app.proc.kill();
		await Bun.sleep(1_500);
	}
	throw new Error(`the view never left Loading… in ${tries} launches`);
}

// ----------------------------------------------------------------------- tour

/**
 * The five surfaces worth showing, each reached by the shortcut a user would
 * use. `beat` is handed the name so stills can write a file and the video can
 * simply hold still for a moment.
 */
async function tour(
	kb: ReturnType<typeof keyboard>,
	beat: (name: string) => Promise<void>,
	live: { dataDir: string; ask: string } | null,
) {
	await beat("chat");

	if (live) {
		const before = await turnCount(live.dataDir);
		await kb.say(live.ask);
		await beat("thinking");
		if (!(await waitForTurn(live.dataDir, before, 180_000))) {
			throw new Error("the agent never finished a turn — is the provider key still good?");
		}
		await Bun.sleep(1_200);
		await beat("answer");
	}

	await kb.press("ctrl+f"); // search this teammate's whole thread
	await beat("search");
	await kb.press("Escape");

	await kb.press("ctrl+i"); // the teammate's own settings
	await beat("teammate");
	await kb.press("ctrl+i");

	await kb.press("ctrl+2"); // a teammate who has not said anything yet
	await beat("roster");

	await kb.press("ctrl+comma"); // app settings
	await beat("settings");
}

// ----------------------------------------------------------------------- main

const args = process.argv.slice(2);
const command = args[0] ?? "stills";
const positional = args[1]?.startsWith("--") ? undefined : args[1];
const flag = (name: string, fallback?: string) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const has = (name: string) => args.includes(`--${name}`);

for (const bin of ["ffmpeg", "xdotool"]) {
	if (!(await have(bin))) throw new Error(`${bin} is not installed`);
}

const givenDisplay = flag("display");
if (!givenDisplay && !(await have("Xvfb"))) throw new Error("Xvfb is not installed");

const display = givenDisplay ?? freeDisplay();
const xvfb = givenDisplay ? null : await startXvfb(display);

/* --attach photographs an app that is already running, which is how you
 * capture a session a human is driving. Otherwise this owns the app, and the
 * profile it runs against is a throwaway seeded a moment before launch. */
const attach = has("attach");
const dataDir = attach ? null : mkdtempSync(join(tmpdir(), "toad-capture-"));

/* --live lends the throwaway profile the real one's provider credentials, so
 * the agent answering on camera is the agent, not a fixture. The copy lives
 * and dies in /tmp; the key is never rendered, because the settings screen
 * does not read credential values back. */
const wantLive = has("live");
if (wantLive && !attach) {
	if (!existsSync(LIVE_AUTH)) throw new Error(`--live wants credentials at ${LIVE_AUTH}`);
	mkdirSync(join(dataDir as string, "pi"), { recursive: true });
	copyFileSync(LIVE_AUTH, join(dataDir as string, "pi/auth.json"));
}
const live =
	wantLive && !attach
		? {
				dataDir: dataDir as string,
				ask: flag("ask", "In one sentence: what is this app for?") as string,
			}
		: null;

let app: { proc: Bun.Subprocess; id: string } | null = null;
try {
	let win: { x: number; y: number; w: number; h: number };
	let kb: ReturnType<typeof keyboard>;

	if (attach) {
		const found = await findWindow(display);
		if (!found) throw new Error(`no Toad window on ${display}`);
		win = await geometry(display, found);
		kb = keyboard(display, win, found);
	} else if (command === "shot" || has("empty")) {
		if (!has("empty")) await seed(dataDir as string);
		app = await launchApp(display, dataDir as string);
		win = await geometry(display, app.id);
		kb = keyboard(display, win, app.id);
		await Bun.sleep(3_000);
	} else {
		await seed(dataDir as string);
		const up = await bringUp(display, dataDir as string);
		app = up.app;
		win = up.win;
		kb = up.kb;
	}

	await kb.focus();

	if (command === "shot") {
		console.log(await shot(display, resolve(positional ?? join(OUT_DIR, "toad.png")), win));
	} else if (command === "stills") {
		const dir = resolve(positional ?? OUT_DIR);
		console.log(`capturing on ${display}:`);
		await tour(
			kb,
			async (name) => {
				await shot(display, join(dir, `${name}.png`), win);
				console.log(`  ${join(dir, `${name}.png`).replace(`${ROOT}/`, "")}`);
			},
			live,
		);
	} else if (command === "video") {
		const out = resolve(positional ?? join(OUT_DIR, "tour.mp4"));
		console.log(`recording on ${display}:`);
		const stop = record(display, out, Number(flag("fps", "24")), win);
		await Bun.sleep(1_200);
		// Long enough to read the surface, short enough to keep watching. A live
		// turn sets its own pace, so those beats only pause for the cut.
		await tour(kb, (name) => Bun.sleep(name === "thinking" ? 400 : 2_600), live);
		await Bun.sleep(1_000);
		await stop();
		console.log(`  ${out.replace(`${ROOT}/`, "")}`);
	} else {
		throw new Error(`unknown command: ${command}`);
	}
} finally {
	app?.proc.kill();
	if (app) await Bun.sleep(500);
	xvfb?.kill();
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
