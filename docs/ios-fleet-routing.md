# iOS fleet routing

Status: draft specification for discussion. No implementation is approved by this document.

## Summary

The iOS app should connect to a Toad fleet rather than treating one selected desktop as the permanent gateway to everything.

A desktop remains authoritative for the agents, sessions, transcripts, computers, files, and other resources it owns. The phone may have several physical paths to that authority:

1. directly to the owning desktop;
2. through another linked desktop;
3. eventually through a relay when no local or private-network path is available.

Toad should select a healthy path automatically, preserve affinity while it remains healthy, and fail over without changing the logical conversation or duplicating mutations.

This is multipath routing and failover, not round-robin load balancing.

## The distributed agent control plane

This spec is one part of a larger frame. What the codebase has loosely called
"the mesh" is better named the **distributed agent control plane**: mesh
describes the wiring; control plane describes the promise. The promise is
decentralization in the critical places:

- **Authority stays where the agent lives.** A desktop owns its teammates'
  sessions, transcripts, files, and computers. Nothing here replicates or
  migrates authority.
- **Every critical service is servable from any seat.** Message delivery,
  the merged roster, request routing, and push notification each work
  regardless of which machine a capability (a phone pairing, an APNs key,
  a network path) happens to sit on.
- **No elected coordinators.** No desktop is the master of anything. Where
  two desks could both serve a request, the design converges instead of
  coordinating — idempotency keys, collapse ids, publish-on-change.
- **Eligibility is the room.** The trust boundary is the fleet: mutually
  linked desktops and the devices paired to them. Teams (the human grouping)
  span desks freely inside that boundary; they are organization, not trust.

Push shipped first as the worked example of the pattern — see
"Precedent: push as a control-plane service" below. The routing model this
document specifies should follow the same shape.

## Current behavior

The phone stores multiple paired Toad desktops but selects one active desktop. That desktop becomes the phone's path into the app. If the selected desktop can see remote fleet agents, requests for those agents may traverse its fleet links.

This has several consequences:

- An unhealthy selected desktop can make the entire fleet appear unavailable.
- A request may relay through Wi-Fi even when the phone has a healthier direct path to the owner.
- Desktop selection exposes network topology as a product decision.
- A notification from another desktop may open against the currently selected desktop without enough identity to route correctly.
- Changing desktops feels like changing rooms even when both desktops belong to one logical team.

## Product statement

**The phone connects to the fleet. Toad selects the best available path to the desktop that owns the resource.**

Desktop selection remains available as a manual pin and diagnostic override, not the default operating model.

## Goals

- Keep the whole fleet usable when one desktop is slow, restarting, asleep, or offline.
- Prefer a direct route to a resource's owning desktop when it is healthy.
- Fall back through another linked desktop when direct access is unavailable.
- Select routes from measured health rather than assumptions about Ethernet, Wi-Fi, or machine type.
- Preserve conversation continuity, ordering, authorization, and mutation idempotency across route changes.
- Make route state visible enough to diagnose without making topology normal user work.
- Respect iOS foreground, suspension, battery, and networking constraints.
- Reuse Toad fleet identity, pairing, and transport primitives rather than creating a separate mesh.

## Non-goals

- Moving an agent or its authoritative state between desktops.
- Replicating transcripts or workspaces across the fleet.
- Sending arbitrary requests round-robin across interchangeable servers.
- Maintaining several permanent background WebSockets while iOS is suspended.
- Consensus between desktops.
- Hiding offline ownership by serving a writable stale replica.
- Building an internet relay in the first version.

## Terminology

**Fleet:** A set of mutually linked Toad desktops and paired client devices.

**Authority / owner:** The desktop that owns a resource and decides its authoritative state.

**Path:** A physical route from the phone to an authority. A path can be direct or relayed through a linked desktop.

**Entry desktop:** The first desktop reached by the phone on a relayed path.

**Route affinity:** Keeping a logical resource on its current healthy path rather than switching on every small metric change.

**Connection generation:** A monotonically changing identity for a physical connection, used to reject late responses and pushes from an obsolete route.

## Conceptual topology

```text
iPhone
 ├── direct → Mac mini → Frank
 ├── direct → Linux → Boris
 ├── direct → MacBook → Nancy
 └── via Linux → Mac mini → Frank       fallback
```

The resource identity does not change when the path changes:

```text
owner node: mac-mini
persona: frank
absolute target: mac-mini/frank
```

The route is transport metadata, not part of the conversation identity.

## Route-selection policy

Routes should be scored from observed behavior:

- direct versus relayed path;
- recent request round-trip time;
- connection and application-level response health;
- jitter and timeout rate;
- time since last successful response;
- reconnect frequency;
- current reachability of the destination through the entry desktop;
- transport class such as LAN, private VPN, or relay;
- bandwidth and queue pressure for bulk or streaming surfaces;
- optional battery or metered-network cost.

Do not infer quality from labels alone. A wired desktop is preferable only when its measured path is healthier than the alternatives.

### Affinity and hysteresis

A healthy current route should remain selected. A candidate should replace it only when:

- the current route fails a health threshold;
- the destination becomes unreachable through it; or
- the candidate remains materially better for several observations.

This avoids route flapping caused by small latency variations.

Initial policy should be deliberately simple:

1. Prefer a healthy direct-owner route.
2. Otherwise prefer the healthy entry desktop with the lowest stable application RTT to the owner.
3. Keep the selected route until it fails or exceeds a sustained degradation threshold.
4. Preserve a manual pin until the user returns to Auto or the pinned path is impossible.

Exact scoring constants require measurement and should not be embedded in the product specification prematurely.

## Health is application-level

A successful ping or TCP handshake does not mean Toad is healthy. A desktop may accept TCP while its application event loop cannot answer RPC.

Path health must include a small authenticated application request with a bounded response deadline. The result should distinguish:

- network unreachable;
- TCP/TLS failure;
- authentication failure;
- connected but application-unresponsive;
- destination unavailable through this entry desktop;
- healthy response with measured latency.

Passive measurements from real requests should be preferred. Active probes should be infrequent, jittered, and suspended when iOS background policy requires it.

## Routing model

Every routable resource uses an absolute identity containing its authority node. The phone maintains a route table resembling:

```text
destination: mac-mini

paths:
  direct mac-mini
    state: degraded
    applicationRtt: 850ms
    recentTimeouts: 2

  via beastie-linux
    state: healthy
    applicationRtt: 38ms
    recentTimeouts: 0

selected: via beastie-linux
connectionGeneration: 14
```

A request contains or derives:

- destination node;
- resource identity;
- operation identity when it can mutate state;
- caller/device identity;
- connection generation or route attempt identity;
- optional ordering key for the resource stream.

The entry desktop forwards to the destination authority. It does not become authoritative and does not rewrite the resource identity.

## Correctness across failover

### Reads

Reads may retry through another route after a timeout. A response from an obsolete route must not overwrite a newer snapshot or push.

Responses should identify:

- authority node;
- resource revision when available;
- connection/attempt generation;
- whether the response was direct or relayed.

### Mutations

Every retryable mutation needs an idempotency key. If the phone submits an operation through one path, loses the response, and retries through another path, the authority must return the original result rather than execute the operation twice.

Examples include:

- sending or steering a prompt;
- answering a permission;
- cancelling a turn;
- editing settings;
- scheduling or cancelling work;
- uploading an attachment reference;
- future task-board claims and updates.

### Ordering

Operations affecting one conversation or resource need a stable ordering key. Route changes must not allow a later request to overtake an earlier accepted request silently.

The first version may enforce one in-flight mutation per resource from the phone. More concurrency should be added only with explicit authority-side sequencing.

### Pushes

Pushes must identify their authority node and resource. The phone discards duplicates and ignores late pushes from obsolete connection generations when a newer authoritative revision is known.

Missed pushes are repaired through authoritative snapshots after reconnect. The push stream is a notification mechanism, not the only copy of state.

## iOS lifecycle

### Foreground

The app may evaluate several candidate desktops while foregrounded. It does not necessarily need to keep every path fully connected:

- maintain the active route;
- keep one warm standby when worthwhile;
- probe other candidates at a low rate;
- open direct-owner connections on demand;
- close idle paths to control battery and socket pressure.

A small fleet may justify direct connections to all reachable owners. This should be measured rather than assumed.

### Background and suspension

Persistent multipath WebSockets cannot be treated as reliable while iOS suspends the app.

APNs remains the background doorbell. A notification includes enough identity to locate the authority when the app resumes:

- fleet/installation identity if necessary;
- authority node ID;
- persona or resource ID;
- notification kind;
- opaque navigation reference where appropriate.

On tap, the app wakes, evaluates current paths, connects through the best available route, then opens the resource. It must not assume the desktop that was selected before suspension is still the correct path.

## User experience

The normal connection setting becomes:

```text
Connection
  Auto — Best available        default
  Mac mini — Direct            manual pin
  Beastie Linux — Direct       manual pin
  MacBook — Direct             manual pin
```

Normal conversation UI should not expose route churn. Diagnostics may show:

```text
Frank · Mac mini
Connected through Beastie Linux · 38 ms
```

Useful states include:

- Direct
- Relayed through <desktop>
- Switching path
- Owner offline
- Connected but owner unavailable
- Pinned path unavailable; using fallback

The user should be able to pin a desktop for debugging and return to Auto without repairing devices.

## Security model

Multipath routing must not broaden trust accidentally.

- The authority validates the originating phone/device identity and its permission, not merely the relay desktop.
- A relay receives only the capability necessary to forward the request class.
- Revoking a phone or desktop invalidates derived credentials and active paths.
- Requests cannot spoof their authority node, caller, or resource identity.
- Relays must not gain unrestricted access to another desktop's general RPC surface merely because they can route fleet traffic.
- Sensitive payloads should eventually be end-to-end protected from relays when relays are not intended to read them.
- Path metrics and diagnostics must not expose bearer tokens or private addresses in ordinary logs.

The current fleet credential and revocation model must pass the reliability/security audit before general multipath relay is enabled.

## Transport behavior

One fleet transport can carry multiple semantic classes, but they require different guarantees:

- presence: ephemeral, last-writer-wins, snapshot-repaired;
- control requests: acknowledged, bounded, typed failures;
- mutations: idempotent and authority-ordered;
- watch events: revisioned or sequence-aware, snapshot-repaired;
- streaming text: flow-controlled and scoped to interested viewers;
- bulk artifacts: referenced on control channels and transferred separately.

Per-token and thought deltas must not be broadcast indiscriminately to every desktop. Route health must account for queue pressure, and slow consumers must not block unrelated presence or control traffic.

## Precedent: push as a control-plane service

Shipped ahead of this spec, and the template for it. The APNs key was the
last centralized organ — only its holder's teammates could reach a pocket.
Now:

- The authority observes its own teammate (turn ended, needs a human,
  stopped on an error) and mints an **envelope**: kind, persona, title,
  body, authority node.
- The authority sends locally if it holds a key and phone pairings, and
  offers the envelope to every linked desktop over the fleet trust. A desk
  with capability sends it on with the authority's name attached; a desk
  without declines quietly. No notifier is elected and no capability is
  gossiped.
- Envelopes carry node-qualified collapse ids, so two capable desks
  converge at Apple into one buzz instead of coordinating.
- The payload names its authority, and the phone resolves the teammate
  against its own hub — bare when they match, node-qualified when not — so
  a tap opens the right conversation whichever desktop the phone is wired
  to. This satisfies the notification-identity requirement in Phase 1.

The routing work should reuse this shape: observe at the authority,
describe the fact in an envelope, let any capable seat serve it, converge
by construction.

## Precedents and cautions from the first week live

- **First-hand facts only, and publish on change.** Two meshed desktops
  re-announcing each other's rosters produced an infinite publish
  ping-pong that froze a desktop inside AppKit menu teardown. The shipped
  damper — drop anything already node-qualified, publish only when the
  roster actually changed — is the established answer to this spec's open
  question about learning routes without transitive loops. Any transitive
  route gossip must converge the same way.
- **Application-level health is not optional.** The same freeze kept TCP
  alive while the event loop starved; a modal dialog on a desk freezes
  every wire it serves while looking connected. This spec's insistence on
  authenticated application probes is validated, not theoretical.
- **Garnish must be bounded.** Merged previews and activity fetches are
  capped at four seconds per peer so a sick desk cannot hold the roster
  hostage. Route probing should inherit the same principle: nothing
  decorative may block anything structural.
- **Trust granularity gap (open audit item).** Today a fleet peer that
  asks receives a full standing wire credential (`webAccess`) — coarser
  than this spec's "a relay receives only the capability necessary to
  forward the request class." Current state and target diverge here; the
  relay phases must not ship on the current grant.

## Incremental delivery

### Phase 1: automatic gateway failover

- Keep one active phone-to-desktop connection.
- Maintain health data for every paired candidate.
- Automatically move to another healthy entry desktop when the current one fails.
- Preserve the existing manual desktop selection as a pin.
- Include authority node identity in notification navigation. *(Shipped:
  push envelopes carry the authority node and the phone resolves it
  against its hub.)*

This removes the largest single-gateway availability failure without requiring several live connections.

### Phase 2: direct-owner routing

- Connect directly to a resource's owner when reachable.
- Maintain route affinity per owner/resource.
- Retry safe reads and idempotent mutations through another entry desktop.
- Show route diagnostics.

### Phase 3: full fleet multipath

- Maintain direct and relayed candidate routes.
- Select routes from stable application-level metrics.
- Add warm standby paths where battery and reliability measurements justify them.
- Introduce an external relay only if LAN/private-network reachability proves insufficient.

## Acceptance scenarios

1. The selected Mac becomes application-unresponsive while Linux remains healthy. The phone continues to show the fleet and reaches Mac-owned agents through Linux.
2. The phone can reach an agent's owner directly and stops taking an unnecessary relay path.
3. A request times out after being accepted. Retrying through another path does not send the prompt twice.
4. A late snapshot from an old path cannot overwrite newer conversation state.
5. A notification generated by a non-active desktop opens the correct agent through the best current path.
6. A pinned desktop becomes unavailable. The UI explains the fallback and remains usable.
7. The app resumes after suspension with no valid old socket and reconstructs routes from current health.
8. A relay is revoked while connected. Derived access and active paths stop working.
9. One slow path cannot starve presence or control traffic on another path.
10. Two available paths alternate in latency without causing visible route flapping.

## Measurements required before implementation

- Foreground battery cost of one, two, and several active desktop connections.
- Application RTT distribution for direct and relayed calls.
- Failure detection time and false-positive rate.
- Frequency and volume of current pushes, especially streaming deltas.
- Queue growth under a slow or stalled desktop.
- iOS suspension/resume behavior with the current Capacitor transport.
- Route-switch time for an open conversation.
- Duplicate-operation behavior during forced connection loss.

## Open questions

- Is authority selected per resource, per project, or strictly per owning desktop?
- Should Auto keep one warm standby or connect on demand?
- What is the first authenticated health request, and can it avoid mutating persistent peer state?
- Which mutation APIs already have idempotency and which require protocol changes?
- Can a relay see conversation contents, or should routing become end-to-end encrypted?
- How should the phone learn that an entry desktop has a route to an owner without creating transitive roster loops?
- How long should a manual pin survive failure or app restart?
- Should attachments choose a different path from conversation control traffic?
- What diagnostics belong in normal settings versus a developer panel?

## Further additions

This document intentionally stops at the initial routing model. Product behavior, trust boundaries, relay design, and iOS interaction details can be expanded here before implementation begins.
