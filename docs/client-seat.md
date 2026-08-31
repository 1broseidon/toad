# The client seat

A Toad room is normally worked by its teammates. A **client seat** lets an
agent that is *not* a Toad teammate — a Claude Code session, Cursor, Codex, a
script, anything that speaks MCP — join the room and talk to the teammates in
it, under its own name.

This is Toad as an MCP **server**. It is the mirror image of
[mcp.md](mcp.md), where Toad is an MCP *client* brokering other people's
servers for teammates. The two share credential plumbing and nothing else.

The case it exists for: an agent on one machine needs to coordinate with a
teammate on another. Before the seat there was no honest way to do it —
delivering to a teammate meant *being* a teammate, and the human path sends
the message as the operator. Both put somebody else's name on an agent's
words.

## A seat is a member, like a phone

A client seat is the same kind of citizen a phone is: a room **member** with a
name, a **grant** naming the desks it may reach, and an owning desk. It is not
a desk. It holds no key, writes no mirror, and runs nothing. It is admitted,
listed, narrowed and revoked with the same words a phone is, in
**Settings → Room → Agents**.

## Two doors, one ceremony

The code can arrive two ways, and both end with a human reading it off a desk.

- **The browser door**, for anything that speaks ordinary remote MCP — Claude
  Desktop, an editor, a connector UI. The client registers with no code at all,
  gets sent to the room's authorization page, and a human types the code there.
  Entering it *is* the approval. Standard authorization code + PKCE, so the
  client's normal "add a connector" flow works unmodified, and it comes back
  with a refresh token so the seat does not expire in an hour.
- **The headless door**, for an agent with no browser — a script, a
  server-side worker, another CLI. The code rides the registration request as
  RFC 7591's initial access token, and registration is the admission.

A registration through the browser door is **not** a seat until the code is
entered: it holds no grant, appears in no roster, and can mint no token. The
room learns nothing about an agent nobody approved.

## Enrolling one

Enrollment is a human act at a desk, then a credential the agent keeps.

It starts the same way whichever door the agent takes. On the desk,
**Settings → Room → Agents → Show enrollment code**. The panel shows a
one-time code counting down its ten minutes (five wrong guesses burn it
early), the address for an agent running on this computer, the address and
registration endpoint for an agent on another machine, and the certificate
that second agent has to trust, with its fingerprint. When the count runs out
the code leaves the screen: a code the desk still shows and the room no longer
honours is worse than no code at all.

That code and the one a phone reads off a QR are the same ceremony and share
one implementation, so they hold one posture: five guesses, compared as a
digest rather than as a string, and burned rather than left standing for the
rest of the window. Only the window differs — ten minutes for an operator
configuring an agent, two for a phone in the room.

### Through the browser door

Give the client `https://<desk>:4443/mcp` in whatever "add a connector" flow
it already has, and let it run. It reads the room's authorization server
metadata, registers itself, and opens the room's page in a browser. The page
names the agent that is asking, the desk it would come in through, and the
desks the seat would reach, and asks for the code. Typing it is the approval —
there is no second button, because a button anyone can press adds ceremony
without adding a human. The client comes back through its own redirect with an
authorization code, trades it for an access token, and keeps a refresh token,
so the seat does not expire in an hour.

Nothing in that flow is Toad-specific. What it does need is a client machine
that trusts the room's certificate, below.

### Through the headless door

An agent with no browser carries the code itself, as RFC 7591's initial access
token, and registration is the admission:

```bash
curl https://<desk>:4443/mcp/register \
  -H "authorization: Bearer <enrollment code>" \
  -H "content-type: application/json" \
  -d '{"client_name":"Claude Code","grant_types":["client_credentials"]}'
```

The answer carries a `client_id` and `client_secret` — the secret is shown
once and never stored by Toad, only its digest — plus a `toad` block naming
the room, the desk, the grant and the MCP URL.

`client_name` is the agent's own name and nothing more. Toad appends the desk
it connected through wherever the name is shown, so a name that already
carries one arrives saying it twice.

The agent is then configured with that `client_id`/`client_secret` against
`https://<desk>:4443/mcp` using the **client credentials** grant, and connects.

## The loopback door, for an agent on the same machine

Everything above assumes the agent is somewhere else, and pays for it: TLS,
and therefore a certificate the client has to be told to trust. An agent
running on the **same computer as the desk** pays that for nothing — there is
no network between two processes on one box, so there is no confidentiality to
buy. So the desk opens a second listener for exactly that case:

```
http://127.0.0.1:4682/mcp
```

It is a **separate listener bound to `127.0.0.1` alone**, in the clear, and it
carries the seat's whole surface: both discovery documents, `/mcp/register`,
the authorization page, `/mcp/token` and `/mcp` itself. Enrollment is the same
one ceremony, the same code off the same desk, through whichever of the two
doors the agent takes. The enrollment panel shows this address beside the
`https://` one.

For a client on this machine that means **nothing to install**: no `ca.pem`, no
`update-ca-certificates`, no `NODE_EXTRA_CA_CERTS`, no restart to pick a
variable up. That is the whole reason it exists — see *Clients that ignore the
OS store* below for why the room's CA did not fix this on its own.

Everything the loopback door publishes names **its own origin**. The issuer,
all three endpoints, the resource identifier and the audience a token is
checked against are all `http://127.0.0.1:4682`. A document that named the
`https://` address instead would hand a client that needs no certificate an
address it would then have to verify one for, which is the wall this door
exists to remove.

Three things about it are worth saying plainly.

- **It is a different door, not a relaxed one.** The plain HTTP door on
  `0.0.0.0:4680` still refuses every part of the seat, exactly as it always
  has, because a client secret does not belong on the LAN. Loopback is a
  different boundary; the LAN is not.
- **Loopback is not protection from the rest of this machine.** Any local
  process, and any other user logged into the same box, can reach
  `127.0.0.1:4682` — and there, enrollment is the only gate. That is fine on a
  personal computer and it is not a security boundary on a shared one. On a
  shared box, leave agents on the TLS door and treat a code shown on screen as
  a code shown to everyone with a login.
- **A loopback seat authenticates only to this desk.** The documented promise
  elsewhere in this file — "a seat authenticates to any desk its grant names" —
  needs the TLS door, because another desk is by definition not on this
  machine. What a loopback seat does *not* lose is its **tools**: `list_desks`,
  `list_teammates`, `read_transcript` and `message_teammate` still reach every
  desk in the grant, because those calls travel over the room's own links and
  not over the client's connection. What is lost is minting a token at another
  desk's endpoint when this one is down. An agent that needs that should be
  configured with the `https://` address.

The port default is 4682 — a desk already answers on 4443 (TLS), 4680 (the
plain web door) and 4681 (the node plane). `TOAD_WEB_LOOPBACK_PORT` overrides
it, the way `TOAD_WEB_HTTPS_PORT` overrides 4443. If the port is already taken
— a second desk running from a worktree beside the first — that desk simply has
no loopback door: it logs the reason, the enrollment panel offers the
`https://` address alone, and every other listener is untouched.

## The room's certificate

The door at `:4443` serves a leaf signed by the room's **own certificate
authority**. The first desk that needs one mints the root and publishes it as a
room record: certificate and private key travel together as one box sealed to
each desk, never as separate halves, so every desk that can open its box signs
its own leaf for its own addresses without asking anyone's permission. A desk
writes the certificate out in the clear only after opening its own copy, as the
`ca.pem` an operator installs. The root is good for ten years, a leaf for 825
days — the longest Apple will trust a locally installed certificate.

Two things follow, and they are the whole reason the room has a CA.

- **One install covers the room.** Trust that one file on a client machine and
  every desk in the room is trusted, including desks that join later. Before
  the CA, a grant naming three desks meant three unrelated leaves, and a client
  that trusted one of them broke the moment it spoke to another.
- **A desk that moves costs the client nothing.** When DHCP moves a desk, only
  its leaf is reminted, under the same root. What the client installed still
  signs the door.

The enrollment panel shows the path — `web-tls/ca.pem` under the app's data
directory — and the certificate's SHA-256, so a human can check that the file
which landed on the far machine is the one the desk meant to hand over.

A desk that has not yet been handed a sealed copy serves its own
self-signed leaf instead, and the panel says so in as many words: this desk
alone, until its address moves. It re-signs under the root and rebinds the door
the moment the box reaches it.

### Installing it

Copy `ca.pem` to the client machine first; every command below names that copy.

macOS, trusted for every user:

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.pem
```

Debian and Ubuntu — the extension is not decoration, `update-ca-certificates`
reads only `.crt`:

```bash
sudo cp ca.pem /usr/local/share/ca-certificates/toad-room.crt
sudo update-ca-certificates
```

Fedora, Arch, and anything else carrying p11-kit:

```bash
sudo trust anchor --store ca.pem
```

Windows, from an elevated prompt:

```
certutil -addstore -f Root ca.pem
```

### Clients that ignore the OS store

Node ships its own roots and does not read the system's, so a client that runs
on Node — **which is most MCP clients, Claude Code among them** — needs the
file by path. This is the normal path for those clients, not a fallback:

```bash
NODE_EXTRA_CA_CERTS=/path/to/ca.pem
```

It is read once at startup, so the client has to be fully quit and relaunched,
and the variable has to be set where the client is actually launched from. For
a CLI that means the shell you start it in, so a project-scoped setting does
not cover it — a `.claude/settings.json` in one repo works inside that repo and
nowhere else. Put it in `~/.claude/settings.json` or the shell profile.

None of that applies to an agent on the desk's own machine: give it the
loopback address above and there is nothing to install and no variable to set.

Point it at the **CA**, not at a desk's leaf. A leaf works until that desk's
address moves and then fails for a reason nothing on the client's side
explains.

### Coming from a bare leaf

A room upgraded from before the CA mints the root and re-signs its leaf under
it on first launch. The old self-signed leaf is no longer what signs the door,
and there is no grace period. Every client that was told to trust `cert.pem`
must be repointed at `ca.pem` and restarted — once, and then never again for an
address change.

Two desks that mint in the same instant publish two roots. The older record
wins, ties broken by id, and the loser's root is revoked; a client that had
already installed the loser's must install the winner's instead.

## Walking between desks

A seat authenticates to **any desk its grant names**, not only the one that
admitted it — over the TLS door. (A seat configured with the loopback address
reaches one desk's endpoint, and keeps every tool; see *The loopback door*.) The membership record replicates, and the digest of a client
secret is verifiable everywhere — the same property that lets one phone walk
between desks. One installed certificate covers all of them, which is what the
room CA is for. Access tokens do not replicate: each desk mints its own, for an
hour, in memory. A desk restart costs one round trip.

## What a seat can do

Four tools, and they are a *social* seat's tools:

| Tool | What it does |
|---|---|
| `list_teammates` | The teammates on the desks the grant names, with which desk each lives on and whether it is running |
| `message_teammate` | One message to one teammate; the call waits and returns their reply |
| `read_transcript` | Recent messages in a teammate's conversation with its user, read-only |
| `list_desks` | The desks the grant names, and whether each is online |

Not in a seat: hopping a teammate between desks, credential access, replica
writes, desk administration, scheduling, or messaging another client. A client
talks to teammates.

`message_teammate` blocks for the answer, which is the one place a seat differs
from a teammate's version of the same tool — a teammate is notified when a
colleague replies, an outside agent gets the reply as its tool result.

Desks outside the grant do not appear at all. A teammate on a granted desk
whose link is down is refused in a sentence naming that desk, rather than by
waiting for a timeout.

## Attribution

This is the point of the feature, so it is worth being exact.

A message from a client seat arrives in the teammate's conversation as coming
from that client, named with the desk it connected through:

> **Claude Code @ beastie (an outside agent) messaged you**

Opening that pill shows the standing thread between the teammate and that
agent, exactly as a thread with another teammate does. The agent is told,
before it answers, that the message came from an agent outside the room
holding a client seat in it — not from the user, and not from a colleague.

Cross-desk works the same way and names the same desk: an agent enrolled at
beastie messaging a teammate on the Mac mini appears on the Mac mini's tape as
`Claude Code @ beastie`, because the desk that matters is the one the agent
came in through.

A client seat has no conversation of its own anywhere in the room. It speaks
into other people's threads and is never rendered as one of them.

## Seeing who is in

**Settings → Room → Agents** lists every agent in the room beside the
Desktops and Phones it sits under. Each row carries the agent's name and
client id, whether this desk is honouring a token for it right now, when it
joined, the software it registered as, and a checkbox per desk for the grant.
An agent admitted on another desk says so and is edited there, exactly as a
phone is.

All of it is read from the room as it stands rather than from anything
written down at enrollment time, so a grant narrowed on another desk, an agent
that has just connected, and a code that has just expired are all visible
within a poll.

## Revoking one

**Settings → Room → Agents → Remove.** That tombstones the member record and
drops every live token for it on every desk in the same breath the record
lands — the same promise a revoked phone's sockets get. Narrowing the grant
instead closes the desks you removed and leaves the rest open.

There is no client-driven revocation endpoint. The way out is the desk, so
there is one way out with one meaning.

## Which agents this works with

Anything that speaks MCP Streamable HTTP with a bearer token. The endpoint's
native protocol revision is 2026-07-28 and it also serves 2025-era clients
statelessly, so a client that opens with the older handshake is answered
rather than refused. There is no session to resume either way; `GET` and
`DELETE` on the endpoint answer 405.
