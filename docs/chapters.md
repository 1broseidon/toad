# Chapters

A teammate is one long conversation, and that is right: nobody should have to
open a new chat to ask the next thing. But an agent's context cannot be that
long. A day of conversation fits a modern model comfortably; a week in one
window is where it starts confusing last Tuesday's task with today's. So the
conversation is divided into **chapters**, and each chapter is one working
context for the agent.

Nothing about this is visible as a second thread. The transcript stays one
tape per teammate; a chapter is a marker in it.

## The three layers

| Layer | What it is | Where it lives |
| --- | --- | --- |
| The tape | What you see: every message, forever | `transcripts/<persona>.jsonl` |
| The working context | What the model sees: one chapter | pi session file / ACP session id |
| The notes | What survives both: a handoff note per chapter, and a search index | chapter markers in the tape; `index.sqlite` |

The tape and the working context were already separate files in Toad — the
transcript is Toad's own record, and the session checkpoint is the agent's —
which is what makes chapters an additive change rather than a rewrite.

## A chapter marker

```json
{ "kind": "chapter", "id": "…", "ts": 1724300000000, "backendId": "toad-agent",
  "sessionId": "…/pi/sessions/….jsonl",
  "endedAt": 1724340000000, "title": "Container stress test",
  "note": "Goal: …\nOutcome: …\nOpen loops:\n- …", "status": "in-progress",
  "tags": ["docker", "playwright", "stress"], "closedBy": "idle" }
```

Written once when the chapter opens and superseded by id when it closes, the
way a tool call moves from `pending` to `completed`. `sessionId` is the agent's
memory of that stretch, so a chapter can be reopened rather than merely
summarised. A transcript written before chapters existed has no markers and
reads as one implicit chapter.

## When a chapter closes

- **Idle.** The teammate has said nothing for `chapterIdleHours` (Settings →
  General; eight by default, never under one). The timer fires while nobody is
  waiting, so the note is written before anyone comes back to read it. If a
  turn is running at the mark it looks again ten minutes later.
- **Asked.** "Start a new chapter" in the search drawer or the teammate's
  Session settings. Takes effect at once.
- **The agent decides.** The `new_chapter` tool, for when the subject has
  clearly changed. Takes effect at the next message, since the agent is
  mid-turn when it asks.
- **Startup.** A chapter that went stale while Toad was closed is closed a
  few seconds after launch, in the background.

Closing writes the note onto the marker and withdraws the backend's session
checkpoint — only that one; a newer checkpoint is left alone. Nothing reaches
into the live session. The next message finds a closed chapter, stops the
session that belonged to it, starts a fresh one, and opens a new marker.

A chapter in which nothing was said closes without a title and the UI leaves
it out, so an idle teammate does not collect empty rules.

In the transcript all of this is one quiet line: the date stamp that already
appears after a gap, with the chapter's name on it once it has one. No badge,
nothing to click, and nothing at all where a chapter was reopened — to the
person it is one conversation continuing, and the marker is Toad's
bookkeeping. The notes live in the search drawer.

## The note

Generated from Toad's transcript slice by Toad Agent's runtime — the
teammate's own model if it is a pi model, otherwise the first available one —
so every chapter's note has the same shape whichever harness the teammate runs
on, and an ACP backend, whose context Toad never sees, gets one too:

```
Goal: …
Outcome: …
Open loops:
- …
Decisions:
- …
Files: …
```

plus a title of at most six words, `status` (`in-progress` or `done`), and
five to ten search tags including synonyms the conversation never used. If no
model is set up or the call fails, the chapter still closes with a title taken
from the first message and no note.

## Waking up

A fresh context is told, hidden from the tape (a system prompt for Toad Agent,
a content block ahead of the first message for ACP):

1. the current time and how long ago the previous chapter ended;
2. the previous chapter's note;
3. the last four messages, for tone;
4. when teammate tools are attached, what `resume_chapter`, `search_thread`
   and `new_chapter` do — and to ask once when a one-word message after a
   long gap could mean either continuing or starting something new.

This is the same `conversationHandoffBlock` that bridged a changed backend
before; without a note it still quotes the last dozen messages as it always
did.

## Restore, in three tiers

1. **The note** — free, always there. Enough for "continue from yesterday"
   most of the time.
2. **`resume_chapter`** — reopens the previous chapter's full context in
   place of the current one. For work that was mid-flight: the old context has
   the file contents and the exact state a note cannot carry. Only the chapter
   immediately before is offered; a context from three weeks ago brings back
   nothing but sludge. Toad stops the current session, points the checkpoint
   back at the previous chapter, starts the restored session (pi opens the
   file; ACP walks `resume → load`), and hands it the messages the user sent in
   the meantime as a nudge — Toad's words, not a line of the tape — so it
   answers them. The interim chapter closes as "Back to: …" and the reopened
   one carries the earlier note under `resumedFrom`. If the restore does not
   work, the new session reads that note instead. Only the conversation with
   the user has chapters; a peer thread cannot rotate it.
3. **`search_thread`** — SQLite FTS5 over chapter notes and messages, chapter
   hits first. Every word becomes a prefix term, ANDed, then ORed if nothing
   matched. The same index powers the search drawer (⌘F / Ctrl+F), whose empty
   state is the table of contents: every chapter, its date, and its note on a
   click. The JSONL stays the source of truth; the index is rebuilt from any
   transcript whose size or mtime differs from what was last indexed, and can
   be deleted.

Embeddings are deliberately not here. Toad runs against providers that have no
embeddings endpoint, a local model is a large download for a feature that must
feel instant, and the notes are already semantic compression with explicit
tags. If searches demonstrably miss, the place to add them is over chapter
notes only — a few hundred vectors per teammate.

## ACP backends

The same mechanism, with two seams: `session/new` rather than a pi session file
for a fresh context, and the wake block as a first-message prefix rather than a
system prompt. Tools reach an ACP backend over the MCP sidecar like every other
teammate tool. A backend without `loadSession` never gets tier 2; the existing
*Restored / Fresh* badge already says which happened.

## What this deliberately is not

- A threads sidebar for humans. Teammates are the organising unit; several
  threads per teammate is how you get amnesia *and* a tidy-up chore.
- A recap injected into the chat. The wake block is machinery and stays off
  the tape.
- A re-summary of the whole history on every wake. That is "remember
  everything" wearing a costume.
