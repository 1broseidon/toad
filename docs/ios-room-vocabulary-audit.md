# iOS app — room vocabulary audit

A screen-by-screen pass over the phone app, checking what it *says* against
the model the control plane actually implements. Written to be worked
through and deleted, not kept.

**Gathered** 2026-08-27, iPhone 16 Pro simulator (`6F70BA67`), Debug build of
`main` at the room-copy pass, joined to the headless `hack/mobile-desk.ts`
desk over the typed address path. Screens captured to `/tmp/toad-audit/`.

**Not covered.** A phone in two rooms at once (needs a second desk), a
legacy `direct link` row (needs a pre-room pairing), and the camera join
path (the simulator has no camera, so the typed path stood in).

---

## The vocabulary this should converge on

From [control-plane.md](./control-plane.md) "Target: federated ownership"
and [federation.md](./federation.md) §2, the terms that already have
meaning in the code:

| Term | What it names | Who says it |
| --- | --- | --- |
| **room** | the whole fleet under one name; desktops and phones join *it*, not each other | user-facing |
| **desktop** | a node with store + executor + gateway capability | user-facing, as detail |
| **gateway** | the desktop a phone currently rides through | internal; "via <desk>" user-facing |
| **member** / **membership** | the phone's admitted record in a room | internal only |
| **grant** | the desk allow-list projected as the phone's room view | internal only |
| **node key** | a participant's `NodeIdentity` fingerprint | user-facing, pick one name |
| **teammate** | a persona | user-facing |

The rule the audit applies: **the room is the world, a desktop is
plumbing, and "membership" / "instance" / "node" are words the user never
reads.**

Today the app mixes three vocabularies. Room language (new, correct),
machine language (the old one-phone-one-computer model), and developer
language leaking straight through (`Instances`, `membership`). Findings are
grouped by screen, in the order you walk them.

---

## A · First launch — no room yet

`instances/InstancesScreen.tsx` · `01-first-launch.png`

| | |
| --- | --- |
| **A1** | Titled **"Room"** with subtitle **"Connections in this room."** when there is no room and no connections. The page describes a thing that does not exist yet. Worst first impression in the app, and it is a regression from the copy pass — the old "Desktops / Desktops this phone is linked to" was at least true of an empty list. Wants a different screen, not a different noun: mark, one line, one button. |
| **A2** | Says **"Join a room to get started."** in the body *and* **"Join a room"** on the button. The instruction and the control are the same words twice. |

## B · Join a room

`instances/LinkInstance.tsx` · `02-join.png`, `03-filled.png`

| | |
| --- | --- |
| **B1** | Instructions send you to **Settings → General → Web access → "Add device"**. That is the desktop's *old* label for this act, and the desktop's own Room pane already describes it differently ("A phone joins by scanning this desktop's Web access code", `settings/app/Room.tsx:267`). Three surfaces, three names for one QR. Fixing the phone's sentence alone leaves the user hunting for a button called something else. |
| **B2** | Nothing on this screen names the room you are about to join — reasonably, since the code has not been spent yet. But nothing names it *after* either: the join lands straight on the roster with no "you're in Toad Room now". The one moment the app could teach the whole model, it says nothing. |
| **B3** | Field label is now bare **"Address"**. Fine, but it is the gateway's address, and the placeholder (`192.168.1.20`) is the only hint of that. |

## C · Roster and banners

`App.tsx` · `05-team.png`, `17-lost.png`

| | |
| --- | --- |
| **C1** | **The loudest leftover in the app.** Wire down shows: *"Looking for Georges-Mac-mini.local… **Instances**"* (`App.tsx:373`). `Instances` is a raw identifier from the codebase printed in the shipped UI, as a tappable link. It also frames the outage as a missing *machine* when the room is what the user cares about and failover is the app's own job. Wants: the room's name, and the action labeled for the room. |
| **C2** | Version skew reads **"This desktop runs Toad 0.2.0…"** (`App.tsx:382`). From a phone, "this desktop" points at nothing — the phone is not on a desktop. It means "the desktop you are currently riding". Name it, or say "your room's desktop". |

## D · Settings home

`components/settings/PhoneSettings.tsx` (`AppHome`) · `06-settings.png`

| | |
| --- | --- |
| **D1** | **Notifications sits under "THIS PHONE"**, but its own screen admits the switches are not the phone's: *"These switches are shared with it."* A shared, desk-stored setting filed under the one heading that promises local scope. |
| **D2** | The active room's detail truncates to **"via Georges-Mac…"** — the gateway name is exactly what gets cut, so the one piece of connection detail the row carries is unreadable. Design pass. |
| **D3** | Footnote: *"Agents, tools, storage, and push signing are configured on the desktop."* (`:599`) — **"the desktop"**, definite and singular, in a room that may hold five. Wants "on any desktop in the room" or, more honest, "on the desktop that owns them". |
| **D4** | The **About** row's detail shows `appInfo.version` — the *desk's* version (`mobile-desk` in the capture) — under a heading reading **"TOAD"**, while the screen it opens leads with the phone's own version (`1.0 (1)`). The row previews a different subject than the screen it opens. |

## E · Room manage — tap the active room

`instances/InstancesScreen.tsx` · `07-manage.png`

This is the screen the design pass is for; recording it here so the copy
and the shape are argued from the same list.

| | |
| --- | --- |
| **E1** | The primary, full-width, accent-colored button on the screen that manages *the room you are in* is **"Join a room"** — i.e. the loudest control on the page leaves for a different room. On the empty screen that button is right; here it is the rarest act given the most weight. |
| **E2** | Rows are still machine rows — monogram, truncated hostname, bare IP, a chooser tap target — and **nothing marks which one you are actually riding**. The "via <desk>" fact exists one screen up in Settings and is absent on the screen about connections. |
| **E3** | Nothing on the room screen is about the room: no name you can edit, no count of desktops or phones, no sense of who else is in it. The title is the only room-level fact. |
| **E4** | Subtitle **"Connections in this room."** is true and thin — it labels the list rather than telling you anything (which desk, how healthy, why you would care). |

## F · Leaving

`instances/InstancesScreen.tsx` · `08-rowmenu.png`, `09-leave-confirm.png`

| | |
| --- | --- |
| **F1** | Confirm body: *"Every desktop in this membership leaves this phone. The membership itself stays on the desktops…"* Two problems. **"membership"** is internal control-plane vocabulary, used twice, in the one dialog where the user must understand what they are agreeing to. And the subject is inverted — desktops leaving a phone, when the act is *this phone leaving a room*. |
| **F2** | **Behavior bug, not copy.** The sheet says "this membership", but `leaveRoom()` (`instances/store.ts:306`) drops every row with `auth === "node"` — *every* room. A phone in a personal room and a work room that leaves one leaves both. This is the feature the whole reframe is for, so the bug is load-bearing. |
| **F3** | The confirm never names the room being left. "Leave the room?" with a room name available two lines up in the title. |

## G · About

`components/settings/PhoneSettings.tsx` (`PhoneAbout`) · `11-about.png`

| | |
| --- | --- |
| **G1** | Two sections: **"THIS PHONE"** and **"GEORGES-MAC-MINI.LOCAL"**. A hostname is given equal billing with the phone, and the room is not mentioned at all — on the one screen that explains what this app is attached to. Wants the room named, with the desk as its subtitle. |
| **G2** | The phone's fingerprint is labeled **"Node key"** here; the desktop's Room pane calls the same value a **"key fingerprint"** (`settings/app/Room.tsx:221`). One value, two names, across two surfaces the user compares aloud when confirming a join. |

## H · Notifications

`components/settings/PhoneSettings.tsx` (`PhoneNotifications`) · `12-notifications.png`

| | |
| --- | --- |
| **H1** | *"Your desktop signs and sends every buzz."* — **factually incomplete**, and the code says so: `App.tsx:352` registers this phone's APNs token with *every* linked desk precisely so "any desk holding a push key can then buzz this pocket". The copy describes the one-computer model that no longer exists. |
| **H2** | *"These switches are shared with it."* — "it" is a desktop that the sentence has already mis-singularized. Shared with the room is the intent. |

## I · Teammate settings

`components/settings/PhoneSettings.tsx` (`TeammateHome`)

| | |
| --- | --- |
| **I1** | Footnote *"Tools and Workspace live on the desktop."* (`:506`) — same singular "the desktop". This one has a canonical answer rather than a vaguer one: control-plane says every mutable resource has exactly one owner node, so the true sentence is "on the desktop that runs this teammate". |

## J · New teammate

`components/NewTeammate.tsx` · `15-new-teammate.png`

| | |
| --- | --- |
| **J1** | With more than one desk in the room, the sheet shows a section labeled **"Desktop"** whose first option is **"This desktop"** (`:257`, `:259`). From a phone, "this desktop" is whichever desk failover happens to have parked you on — the app asking the user to make a choice out of the exact thing the room model promises to handle. The real question is which node *owns* the new teammate. Also appears as a `<label>Desktop</label>` on the wide layout (`:427`). |
| **J2** | Unreachable target reports via `window.alert("That desktop is not reachable right now")` (`:169`) — a system JS alert on a phone, in an app that has its own sheets for every other refusal. |

---

## Code-level vocabulary, not user-facing

The user never reads these, but the next person to work here does, and
right now the files argue for the old model.

| | |
| --- | --- |
| **K1** | `instances/DesktopsSheet.tsx` is **dead** — nothing mounts it. It is also the purest surviving statement of the old model ("Desktops", "Link a desktop", "Manage desktops", "your desktops haven't met — link them into one room"). Delete it, or it will be read as current. |
| **K2** | `prefs.ts` exports `setConnectionPin` with **no callers** — the manual gateway override has a reader (`App.tsx:113`) and no writer. A dead switch that, if it ever grew a UI, would contradict "which desk is plumbing the app handles on its own". |
| **K3** | The whole module is named for the old noun: `instances/`, `InstancesScreen`, `LinkInstance`, `LinkedInstance`, `useInstances`, `instanceChip`, plus `onManageDesktops` and the `myDesktops` RPC. Renaming is mechanical but wide; worth doing once the sheet's shape settles rather than twice. |
| **K4** | `marks.ts` and `InstanceChip.tsx` still open with "How a desktop is drawn in a list" / "Which desktop this is, at the foot of the roster" — file-level docs that teach the old model to whoever reads them first. |

---

## Already correct — leave it alone

Worth stating so the cleanup does not churn what landed:

- The native pill is **+ and Settings**, with the wire dot on Settings
  (`FloatingChromePlugin.swift`, `chrome.ts`) — no Desktop item, no sheet.
- Settings has a **Rooms** section; the active row reads **"via <desk>"**,
  inactive rows switch context, legacy rows say **"direct link"**.
- The room footnote in Settings is the clearest statement of the model
  anywhere in the app: *"A room is your whole fleet, from any of its
  desktops — the phone finds a healthy one on its own."*
- Join is membership-first (`joinAsNode`), with the per-desk pairing only
  as a legacy fallback.
- Failover stays inside the current room (`App.tsx:136`).
- The row menu already says **"Leave the room"**.

---

## Suggested order

1. **F2** — the two-room leave bug. Only real data loss here, and it
   breaks the feature the reframe exists for.
2. **C1** — `Instances` in shipped UI.
3. **A1** — first-launch screen claims a room that does not exist.
4. **E1–E4** — the manage screen's shape (the design pass).
5. **D3, H1, I1** — the "the desktop" singulars, which all want the same
   decision about how to name an owner versus the room.
6. **B1** + **G2** — cross-surface naming, needs desktop-side edits too.
7. **K1, K2** — delete the dead sheet and the dead pin.
