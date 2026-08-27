# Push

Notifications arrive in Toad, sent by your desktop, through Apple's Push
Notification service. No second app to install, no third party holding a
token, no account to make.

This document is the spec. The desktop-direct slice ships first — your Mac
signs and sends its own pushes with your own key. The relay at
`push.toad.team` is the same sender code deployed elsewhere, and is filed
here rather than built, because it is a strangers-install-Toad problem.

## Shape

- **Pairing is the identity.** The phone and desktop already have an
  authenticated relationship: a device record in `web.json`, minted by the
  QR flow, holding a per-device revocable token. Push registration is one
  more attribute on that record — the APNs device token the phone gets from
  Apple, handed to its paired desktop over the wire it already trusts. There
  is no account, no discovery, and no server-side notion of who you are.
- **The desktop is the sender.** Turn finished, permission needed, teammate
  blocked — every moment worth a buzz already crosses the supervisor's
  `Broadcast` seam. One notifier subscribes there; no hooks are scattered
  through the session code.
- **The wire is the source of truth.** A push is a doorbell. The transcript
  syncs over the WebSocket as it always has, so a push that never arrives
  costs you a buzz and never a message. This is not defensive design, it is
  the only correct design — see *Why push is not a transport* below.
- **Secrets live bun-side.** `AppSettings` is a file a person edits; the
  `.p8` is not in it. The key sits beside `web.json` and `web-tls/` under
  the Toad root, in the same place and for the same reason as the wire
  token.

## Why push is not a transport

APNs allows a 4,096-byte payload (5,120 for VoIP), which is more than enough
room for a message. It is still the wrong place to put one, and Apple says
so directly: *"Because the delivery of remote notifications is not
guaranteed, never include sensitive data or data that can be retrieved by
other means in your payload."*

The specific failure is store-and-forward. APNs holds **exactly one** pending
notification per device per app, and a new one **discards** the previous. A
phone that is off for an hour during a busy session does not receive a queue;
it receives the last notification, with no error and no way to know what it
missed. Silent pushes (`content-available`) are worse — iOS budgets them,
throttles them, and defers them entirely in Low Power Mode.

So the payload carries **display** content, never state. It may say what the
message was, so the lock screen reads like a real message instead of a
generic ping; it may never be the only place that text exists.

## Payload privacy

Putting message text in a payload means, once the relay exists, that
conversation content transits `toad.team`. The fix needs no new
cryptography: the phone and desktop **already share a secret from pairing**.
Derive a separate key from it with HKDF, encrypt the preview, and let the
relay forward ciphertext it cannot read; a Notification Service Extension
decrypts on-device before iOS renders it. Same approach as Signal and
WhatsApp, with the key exchange already done.

Until the relay exists this is optional — a desktop pushing directly to
Apple is already the only party that has read the message. Build the NSE
when the relay lands, not before.

## Etiquette

- No push for a conversation you are actively looking at on a live wire. A
  buzz about the screen in your hand is noise.
- The notification names the teammate and carries its persona id; tapping it
  opens that conversation.
- Per-event toggles, defaulting to all three on. A teammate that finished is
  not the same event as a teammate that is stuck, and people will disagree
  about which deserves a buzz at midnight.

---

# Desktop notifications

The same three moments — turn ended, permission needed, blocked — surface
when the news is a teammate this desktop is running and the window is
unfocused, hidden, or on another Space. This is not push: no APNs, no key,
no wire. `observeSession` and `observeTranscript` still decide what is
worth saying; `deliverDesktop()` is one more listener on that envelope,
beside the phones `dispatch()` already loops over.

The toast is display only. Tapping a phone notification opens the
conversation; a desktop toast does not. The wire remains the source of
truth, same as push.

## Attention

A toast about the conversation already in hand is noise. The desktop
answers that the way a phone does, with two signals the window title must
not share:

- **Shown** is bun-side. Closing hides the window rather than quitting, and
  that hide is the one moment the webview may not fire `visibilitychange`.
- **Focused** is the view's report — another app, another Space, a blur.

Either off, or a different teammate selected, and the toast may fire.
`setActivePersona` still drives the title and must not be cleared on blur,
which is why attention is a separate RPC (`setDesktopAttentive`).

## Why bun talks to the OS

Electrobun ships three webview backends, and the Web Notification API is
not one implementation across them. WKWebView would post to Notification
Center on its own; WebKitGTK typically needs
`WebKitNotificationPermissionRequest` handling that Electrobun does not
wire. A macOS-only toggle that silently did nothing on Linux would be
worse than no section at all.

So the poster lives in `push/desktop.ts` and never asks the view:
`notify-send` on Linux, `osascript` `display notification` on macOS, a
Windows toast via PowerShell. Failures are swallowed the same way a missed
APNs send is — a dropped toast, not a failed turn.

## Settings

"On this desktop" and "On a paired phone" share `NotifyPrefs`: one
`enabled` and three kind toggles. Phone push stays off until `enabled`.
Desktop toasts default on when `desktop` is absent — there is no key to
install, and the attention rule already keeps a toast off the conversation
in your hand. A test button on the desktop half skips that rule, for the
same reason the phone test does.

# The relay — filed, not built

Everything below is settled design awaiting a build. It is not needed for
the desktop-direct slice, and nothing in that slice changes when it lands:
the sender module is identical whether it runs on your Mac or on a Worker.

## Why a relay is unavoidable at App Store time

Apple binds push credentials to an app's identity. An App-Store-installed
Toad can only receive pushes signed by the **toad.team** APNs key. A user's
own key cannot push to it — wrong team, Apple rejects it — and the key
cannot ship inside the desktop app, because extracted once is spam for every
Toad user forever.

So the primary lane requires the relay: desktop → `push.toad.team` → APNs.
"BYO" shrinks to what it honestly always was — a lane for people who
*build* the app with their own signing. A dev-community courtesy, not the
product.

## Worker, not a VPS

A `$5` VPS was the earlier recommendation, on the argument that the relay
needs state and that a Worker would mean a second implementation of the
signer. Both premises turned out to be wrong.

**It needs no durable state.** The relay does not verify tokens; it *learns*
from Apple. An unknown token is forwarded once, and `400 BadDeviceToken` /
`410 Unregistered` is the answer. That removes the HMAC "push pass" entirely
— along with its chicken-and-egg problem, since the phone hands its token to
the desktop, not to the relay, and nothing needs to be issued. Rate limits
live on the native Rate Limiting binding: in-colo, no Durable Object for a
flood to instantiate, no per-operation billing.

**The signer barely diverges.** Bun's `node:crypto` and a Worker's
`crypto.subtle.sign("ECDSA", …)` differ by roughly fifteen lines; claims,
the ~50-minute token cache, the POST, and the status handling are shared.

**The cost shape is the cheapest Cloudflare sells.** Subrequests are not
billed, so the call to Apple is free; you pay only for the inbound POST.
At ~50 pushes/day per busy desktop, roughly 6,000 users fit inside the 10M
requests included with the $5 plan. A sustained 1,000 req/s flood costs
about $23 for a full day, and most of it dies at the rate limiter for
near-zero CPU. The Cloudflare bills that become horror stories come from
per-operation storage billing — Durable Object duration, D1 rows read, KV
reads, R2 class-A ops — and this design has none of it.

If a harder floor is ever wanted, WAF rate limiting rules block at the edge
*before* the Worker runs, and those are not billed as requests at all.

## Relay contract

```
POST /push
  { token, kind, ... }   →   rate limit → sign → APNs → return Apple's status
```

The desktop drops a `pushToken` from the device record when the relay hands
back `410`. That is the whole feedback loop — synchronous, in the HTTP
response, no callback channel and no queue. It is also why the relay needs
no dead-token memory of its own: real dead tokens get pruned at the source,
and junk floods die at the rate limiter.

## Open questions

- **Provisioning.** Nothing about the relay knows which desktops are real.
  Learning-from-Apple bounds the damage but does not authorize anyone. Worth
  revisiting before the App Store, not before your own phone works.
- **Payload level.** Name-in-payload ("Nancy needs you") is the default
  worth shipping; a content-free mode is the strict alternative, and the
  encrypted-preview design above makes the choice mostly moot.
- **BYO fallback, logged for later.** For someone self-hosting Toad who
  doesn't want to run the Worker at all, Pushy.me is the closest hosted
  analog to this relay — upload the `.p8`, they hold the connection to
  APNs, and they already document a Capacitor integration. It sees payload
  content and delivery telemetry as part of its product (dashboard,
  insights), which is exactly what the encrypted-preview design above
  exists to avoid — so it's a courtesy lane for BYO builds, never a
  substitute for `push.toad.team`.

## Related: the gateway

Push and remote reachability unlock each other, but they are separate
systems and should stay that way. The gateway design — a named Cloudflare
Tunnel giving the phone a stable public hostname, pairing kept on the LAN,
the tunnel retiring `web/tls.ts`'s self-signed-certificate onboarding wart —
belongs in its own document. The one thing it shares with this one is the
account question: tunnel credentials belong to whoever owns the Cloudflare
account, which is why BYO is a *complete* product for the gateway in a way
it can never be for push.
