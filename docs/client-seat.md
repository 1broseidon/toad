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

## Enrolling one

Enrollment is a human act at a desk, then a credential the agent keeps.

1. On the desk, **Settings → Room → Agents → Show enrollment code**. The panel
   shows a one-time code counting down its ten minutes (five wrong guesses
   burn it early), the room's MCP URL, the registration endpoint, and the path
   to the room's TLS certificate. When the count runs out the code leaves the
   screen: a code the desk still shows and the room no longer honours is worse
   than no code at all.
2. The agent registers once, presenting the code as an RFC 7591 initial access
   token:

   ```bash
   curl https://<desk>:4443/mcp/register \
     -H "authorization: Bearer <enrollment code>" \
     -H "content-type: application/json" \
     -d '{"client_name":"Claude Code","grant_types":["client_credentials"]}'
   ```

   The answer carries a `client_id` and `client_secret` — the secret is shown
   once and never stored by Toad, only its digest — plus a `toad` block naming
   the room, the desk, the grant and the MCP URL.

   `client_name` is the agent's own name and nothing more. Toad appends the
   desk it connected through wherever the name is shown, so a name that
   already carries one arrives saying it twice.
3. The agent is configured with that `client_id`/`client_secret` against
   `https://<desk>:4443/mcp` using the **client credentials** grant, and
   connects.

Everything is served over the room's TLS door only; the plain HTTP door
refuses every part of it, because a client secret does not belong there. The
certificate is self-signed unless you have replaced it, so an agent on another
machine has to be told to trust it — point `NODE_EXTRA_CA_CERTS` at the path
the enrollment panel shows.

### There is no browser flow

Toad publishes an authorization endpoint because every MCP client's metadata
schema requires the field, and it exists only to say there is none: the human
act already happened at the desk, so the grant is `client_credentials` and the
endpoint refuses in words. An MCP client's fully automatic OAuth dance will
not enroll a seat on its own — it defaults to authorization-code registration
and sends no initial access token. Registration is the one-shot step above;
after it, the client's own client-credentials support does the rest.

## Walking between desks

A seat authenticates to **any desk its grant names**, not only the one that
admitted it. The membership record replicates, and the digest of a client
secret is verifiable everywhere — the same property that lets one phone walk
between desks. Access tokens do not replicate: each desk mints its own, for an
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
