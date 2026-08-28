# Teammates — the model, the memory, and the trust story

How a teammate is put together, what "remembering" actually means, and what
Toad does and does not promise about containment. This is the deep version of
what the [README](../README.md) says in a paragraph.

## Two kinds of agent

A teammate runs on one of two kinds of agent. **Toad Agent** is built in: it
lives in Toad's own process, brings its own tool set, and needs nothing
installed — only a model key. Everything else is an external harness driven
over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP):
`cursor-agent`, `opencode`, Claude Code and the rest, each bringing its own
login and its own agent loop.

The difference you feel is startup. An ACP backend is a child process that has
to boot and negotiate a protocol before it can hear you; Toad Agent is a
function call. The difference that matters more is trust: Toad holds no
credentials for an ACP backend and cannot, since those agents sign in
themselves — but Toad Agent calls a model API, so for that one Toad does own a
key, a tool set and an agent loop.

## How a teammate is defined

A teammate ("persona") is four independent axes. What each one is made of is
the same either way; how it reaches the agent is not.

| Axis | Stored as | Toad Agent | ACP backend |
| --- | --- | --- | --- |
| Identity | `goal` | the system prompt | `AGENTS.md` written into the working directory |
| Workspace | `cwd` | the session's working directory | the `cwd` argument to `session/new` |
| Capability | `mcpPolicy` | `read`, a shell, `edit`, `write`, plus the MCP tools Toad connects | its own tools, plus the MCP servers Toad hands it at session start |
| Disposition | `modelId`, `modeId` | model, and thinking level as the mode | `session/set_model`, `session/set_mode` |

Identity reaches an ACP backend through a file because ACP has no system-prompt
parameter. `AGENTS.md` is a channel agents already read, which makes the working
directory *be* the persona rather than just bookkeeping. Toad only overwrites
files that carry its own marker, so a hand-written `AGENTS.md` in a real
repository is safe.

The shell is `bash` everywhere except Windows, where a stock machine has none.
There Toad Agent always gets pi's `powershell` tool, and gets `bash` as well
whenever a real one is installed — Git for Windows, Cygwin, MSYS2, or anything
named `bash.exe` on `PATH`. Both are attached when both exist, so the model
picks per command rather than translating every line it already knows. When
only PowerShell is there, the teammate says so on its first line and names
`winget install Git.Git`. ACP backends bring their own shell and are not
affected.

Toad Agent has a system prompt, so it gets the goal directly — along with the
house style, and a bounded summary of the conversation so far when a teammate
arrives from another harness. Toad still writes the `AGENTS.md`, and the agent
still reads it as a context file, so a persona's goal reaches it twice. That is
harmless and it keeps one teammate's workspace legible to whichever agent opens
it next.

Disposition is switchable mid-conversation. For an ACP backend the model and
mode lists arrive from the agent at session creation and are re-applied on
restart; for Toad Agent the models are whichever providers you are
authenticated with, and the modes are thinking levels — off, low, medium, high,
max.

Capability is the one axis that is answered in two places. MCP servers are
defined once for the whole app, under Settings → MCP servers, because a server
is infrastructure: a command, a URL and an authentication policy. Credentials
live outside app settings; [MCP servers](mcp.md) describes that boundary and
OAuth provisioning. Which teammate may use
one is a different question, answered per teammate under Tools — every server,
none, or a chosen few. The default is every server, which changes nothing until
you add one, and a teammate that references a server you later delete simply
stops seeing it rather than failing to start.

The two kinds of agent reach those servers differently, and the difference is
not cosmetic. An ACP backend is handed the list and does its own connecting, so
whether your servers add to its native tools or replace them is its decision —
`src/bun/mcp/compat.ts` keeps a hand-verified list of backends observed to
merge rather than replace. Toad Agent has no MCP of its own, so Toad is the
client: it connects, lists the tools, and hands them to the agent as ordinary
tools. It builds that array itself, so there is nothing to guess. OAuth HTTP
servers currently attach only to Toad Agent: ACP cannot consume Toad's refresh
provider, and receives no dead static bearer in its place.

Tools are attached when a teammate starts. Changing them reaches a running
teammate on its next restart.

## Two kinds of memory

Toad keeps its own append-only JSONL transcript per teammate, folded on load so
that a tool call which moves from `pending` to `completed` collapses to one
entry rather than growing forever.

That is **not** the same as the agent remembering. On restart Toad reopens the
agent's own memory where it can — `session/load` or `session/resume` for an ACP
backend, the session file it wrote last time for Toad Agent — and tells you
which happened: *Restored* means the agent genuinely recalls the conversation,
*Fresh* means you are looking at saved history the agent has never seen. Replay
during `session/load` is suppressed, otherwise every restart would duplicate the
entire history into the transcript.

A teammate keeps one checkpoint per agent, so moving between harnesses and back
does not throw either conversation away. When a restore is not possible, the
first message carries a bounded summary of recent turns instead — enough to
continue, and clearly not the same thing as remembering.

The conversation is one long thread; the agent's context is not. The tape is
divided into **chapters** — each one working context — closed after a long
idle (eight hours by default), on request, or when the agent decides the
subject has changed. Closing writes a handoff note onto the chapter marker and
lets go of the checkpoint, so the next message starts fresh, reading the note.
The agent can reopen the previous chapter's full context with `resume_chapter`
when work was mid-flight, and search every chapter with `search_thread`; ⌘F
opens the same search for you, with the chapters as its table of contents. See
[chapters.md](chapters.md).

## Agents

**Toad Agent** is built on the [pi](https://github.com/earendil-works/pi) coding
agent SDK, running inside Toad's main process and used by default. Settings →
Agents leads with it rather than presenting it as one backend among forty, and
Configure drills into its provider pane from there — the agent list and its
setup are one destination, not two rail entries for the same thing.
Subscription OAuth comes first — Claude
Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, Kimi, OpenRouter, Radius and xAI at
time of writing — followed by searchable API-key providers. Those lists come
from pi's live provider metadata rather than from a Toad-maintained table.

Provider-owned login flows can open a browser, display a device code, or ask
follow-up questions in Toad. Credential values are stored by pi and are not read
back into the settings webview. Sign-out and key removal use the same SDK.

Toad points pi's config directory at Toad's own data directory rather than
`~/.pi/agent`, so extensions you installed for the pi CLI are not loaded and
executed inside a desktop app that never asked for them. Credentials are the
deliberate exception: a login is a fact about you, not about either program, so
if `~/.pi/agent/auth.json` exists Toad reads it and you are already signed in.

Toad Agent still picks up **workspace** skills — `.agents/skills` in the
teammate's working directory and, when that directory is a git repo, ancestors
up to the repository root, plus `cwd/.pi/skills`. Personal `~/.agents/skills`
are not loaded. The same clamp applies to `AGENTS.md` / `CLAUDE.md`: files in
the workspace (or its repository) reach the teammate; a file sitting in your
home directory does not.

Below Toad Agent, **Additional compatible agents** are ACP harnesses. Their
list is data, not code: it comes from the
[ACP registry](https://github.com/agentclientprotocol/registry) (38 agents at
time of writing), cached for a day, merged with a probe for locally installed
binaries. A local binary is always preferred, since it carries your existing
login.

Verified working here: **Cursor** (28 models, 3 modes, `session/load` restores
real context). **GitHub Copilot** 1.0.80 completes an ACP handshake via
`npx @github/copilot@1.0.80 --acp` — note that versions below 1.0 have no
`--acp` at all.

## A word on containment

Toad renders permission requests as first-class, non-dismissable transcript
entries. But with an ACP backend it does not get to decide whether the agent
asks. That is the backend's configuration. If Cursor is set to
`approvalMode: "unrestricted"`, the agent edits and executes without asking and
Toad's prompt never fires — so Toad detects this and says so on session start.

**Toad Agent does not ask at all.** Its tools run when the model calls them.
Toad owns that gate now and has not built it yet, which is a plainer answer
than the ACP one but not a safer one.

**The per-teammate working directory is a starting point, not a sandbox.**
