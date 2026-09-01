<!-- Agents: before working in this repository, read AGENTS.md. It is the
     contract for changes here; this README is the product story. -->

# Toad

**A local-first room for your team of coding agents.**

Most AI coding tools give you one chat, with one assistant, welded to one
computer. Toad gives you a room: a named roster of teammates that belongs to
you — not to a machine, and not to a cloud.

## A team, not a tab

On your computer, Toad runs coding agents side by side. Each teammate has its
own name, its own project directory, and its own conversation that keeps going
whether or not you are watching.

Some teammates run Toad's built-in agent — nothing to install, signed in with
a subscription you already pay for (Claude Pro/Max, ChatGPT, GitHub Copilot
and more) or any model API key. Others drive the tools you already have —
Claude Code, `cursor-agent`, `opencode` — each in its own lane. Toad does not
care which agent you prefer. Run all of them at once, as different teammates
on different projects, in one roster.

## The room

The room is the durable unit, not the machine. Each desktop owns and runs its
own teammates; the room is what they share. You can speak to one teammate or
address the whole room, agents included — hand work across desks, pick up on
your laptop what you started at your desk, and let the team keep collaborating
while you are somewhere else entirely.

Phones join the room, not a computer. Pair once and the whole roster comes
with you.

## It reads like a group chat, because that is what it is

A rail of teammates, each with an unread badge and a last line. Open one and
you are in the conversation — scroll back through what it did, type a reply,
answer the question it is blocked on. No dashboards, no graphs, no widgets to
arrange. Just the team, talking.

Conversations are durable, and Toad is honest about what that means: when a
teammate comes back, *Restored* means the agent genuinely recalls the
conversation; *Fresh* means you are looking at saved history it has never
seen. It never pretends.

## It keeps working when you walk away

A teammate finishes. A teammate hits a permission prompt and stops. A teammate
errors out. Your phone buzzes for exactly those moments, with the teammate's
name on the lock screen — tap it and you are in that conversation, answering
from the couch. Each kind of alert has its own switch, so midnight can be
quieter than noon.

## Pairing is pointing your camera

Your computer shows a QR code. You scan it. That is the entire setup — no
account, no email, no password, no cloud service to sign up for. The phone
appears in a list on your computer, and you can revoke it there any time.

## Yours, on your machines

Your conversations, your code, and your API keys stay on the hardware they
already live on. Nothing routes through a server we run — there isn't one. No
accounts, no analytics, no telemetry, nothing collected. And the external
agents you attach sign in themselves: Toad never holds their credentials, by
design.

## Get Toad

Signed, self-updating apps for **macOS**, **Windows**, and **Linux**, and
**Toad for iOS** to put the room in your pocket:

**[toad.team](https://toad.team)**

## How it works

The deeper story lives in [docs/](docs/): how a teammate is put together and
what Toad promises about memory and containment
([teammates.md](docs/teammates.md)), how one long conversation stays workable
([chapters.md](docs/chapters.md)), how an agent that is not a Toad teammate
joins the room and talks to the ones that are
([client-seat.md](docs/client-seat.md)), how a teammate is given MCP servers
([mcp.md](docs/mcp.md)), and how to build and hack on Toad itself
([development.md](docs/development.md)).
