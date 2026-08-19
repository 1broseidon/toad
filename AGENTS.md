<!-- managed by Toad -->
# Pace probe

_No goal set yet._

## Cursor Cloud specific instructions

Toad is an Electrobun desktop app. The main process runs on **Bun** (not Cottontail),
built/launched via the **Hutch** CLI. See `README.md` and `hutch.config.ts` for the
canonical script list; the notes below are the non-obvious bits for this environment.

- **Toolchain lives in `$HOME`** (baked into the VM snapshot): Bun at `~/.bun/bin`,
  Hutch at `~/.hutch/bin` (both added to `~/.bashrc`). If a non-login shell can't find
  them, call them by absolute path. The startup update script only runs `bun install`.
- **`hutch electrobun sync` is a prerequisite for `hutch run typecheck`.** It generates
  `.hutch/devkit` (gitignored), which `tsconfig.json` extends and `vite.config.ts`
  imports; without it typecheck fails with `Cannot find module 'electrobun/main'`. The
  `dev`, `dev:hmr`, and `build` scripts run `sync` automatically, so this only bites bare
  `typecheck`.
- **Do not run `hutch electrobun sync` / `dev` / `build` while the app is already
  running** — it blocks indefinitely on `.hutch/locks/electrobun-build.lock`. Stop the
  running app first.
- **Running the GUI** needs a live X display and, on Linux, the system WebKitGTK webview:
  packages `libwebkit2gtk-4.1-0`, `libjavascriptcoregtk-4.1-0`, `libayatana-appindicator3-1`
  (in the snapshot). Use the executor's `DISPLAY=:1`. The app prints harmless
  `libEGL ... DRI3` / `X11 Error: GLXBadWindow` warnings under software rendering — these
  are not failures. `hutch run start` builds + launches without the file watcher;
  `hutch run dev` adds `--watch`.
- **What runs offline vs. what needs credentials/backends:** `hutch run verify:auth`
  (built-in agent provider auth) and `bun hack/verify-mcp-sidecar.ts --check-only` pass
  with no secrets. A real agent turn — `verify`, `verify:mcp`, `verify:mcp-servers`,
  `verify:pi`, and any teammate reply in the GUI — needs either an ACP backend CLI on
  `PATH` (e.g. `cursor-agent`) or a model provider key (configured under
  Settings → Agents, or via `~/.pi/agent/auth.json`). Without one, sessions fail at
  "session reached ready / cursor-agent not found on PATH".
