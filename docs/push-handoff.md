# Push — handoff

> **Picked up and completed.** The iOS half described below as "left" was
> built in the session that received this handoff — entitlement, capability,
> `@capacitor/push-notifications`, registration, and tap routing all landed.
> Kept for the loose threads at the bottom, which are still open.

State as of the last commit `13be7a4` plus uncommitted work. Everything
desktop-side is built and verified; the iOS half is untouched. Read
`docs/push.md` first — it is the spec, and the decisions in it are settled.
This file is only *where things stand and what to do next*.

## Done, uncommitted, typechecks clean

| Piece | Where |
| --- | --- |
| APNs sender — ES256 JWT, HTTP/2, one session per environment | `src/bun/push/apns.ts` |
| Which moments buzz, and the restraint about it | `src/bun/push/notify.ts` |
| Push token on the paired device record | `src/bun/web/devices.ts` |
| Device-scoped RPC (`registerPushDevice`, per-device `setActivePersona`) | `src/bun/web/server.ts` |
| Supervisor wiring, `getPushStatus` / `installPushKey` / `clearPushKey` | `src/bun/index.ts` |
| Key directory, owner-locked | `src/bun/paths.ts` (`PUSH_DIR`) |
| Settings → Notifications pane | `src/mainview/components/settings/app/Notifications.tsx` |
| Types and RPC contract | `src/shared/types.ts`, `src/shared/rpc.ts`, `src/mainview/rpc.ts` |
| Verification | `hack/verify-push.ts` |

Verified: `bun hack/verify-push.ts` drives the real sender against Apple with
a self-generated P-256 key and requires `InvalidProviderToken` — which proves
config read, JOSE `r||s` signing, h2 to APNs, and error parsing. It also
asserts that a bad *key* is never misread as a bad *device token*.
`bun hack/verify-web-pair.ts` still passes. `hutch run typecheck` is clean.

## The one human step

Nobody can do this for George: developer.apple.com → Certificates,
Identifiers & Profiles → **Keys** → new key with *Apple Push Notifications
service* checked → download the `.p8`, note the **Key ID**. Team ID is
`F3E8V88BVB`. One key serves sandbox and production forever.

Then Settings → Notifications → choose the `.p8`, paste Key ID and Team ID,
turn "Send push notifications" on. No restart needed; the key is read per
send.

## What is left: the iOS half

All of it. Nothing in the app asks iOS for a notification token yet, so
`pushTargets()` is empty on every desktop and no push has ever been sent to a
real device.

1. **Entitlement + capability.** `aps-environment` in the App target's
   entitlements, Push Notifications capability in `ios/App/App.xcodeproj`.
   Bundle id is `team.toad.ios`, which is also the APNs topic the sender
   defaults to (`DEFAULT_TOPIC` in `push/apns.ts`).
2. **`@capacitor/push-notifications`.** `bun add` it, `cap sync ios`. The
   other Capacitor plugins in `package.json` are the pattern to copy.
3. **Ask, then register.** Request permission somewhere honest — not at cold
   start. On the `registration` event, call `api.registerPushDevice({ token,
   environment })` over the existing wire. **Call it on every launch**, not
   once at install: APNs re-mints tokens whenever it likes and a stale one is
   a notification that silently goes nowhere. `setDevicePush` already
   short-circuits when nothing changed.
4. **Environment matters and is not a preference.** A dev-signed build's
   token is only valid against `sandbox`; TestFlight and App Store builds are
   `production`. Send the one the build actually is — a mismatch comes back
   as `BadDeviceToken`, which the desktop reads as dead and prunes.
5. **Tap routing.** The payload carries `personaId` and `kind` at the top
   level. On `pushNotificationActionPerformed`, select that teammate. This is
   where the orphaned `toad://` scheme item could land if it is wanted.
6. **`registerPushDevice` is web-mode only.** It is answered by
   `deviceScoped()` in `src/bun/web/server.ts`, because that is the only
   layer that knows which device is asking. The copy in `index.ts` returns
   `{ registered: false }` on purpose — the desktop has no phone to speak for.

## Running and restarting

The previous agent on this work was running *as a teammate inside Toad* and
could not restart the desktop without killing itself. If you can, you have
the advantage — use it.

```bash
bun install
hutch run typecheck
hutch run dev              # build and launch the desktop
hutch run ios              # vite build + cap sync ios
bun hack/verify-push.ts    # the sender, against Apple, no key needed
bun hack/verify-web-pair.ts
```

Note `hutch run <script>` executes under Cottontail, which cannot load the
built-in agent's dependency tree — scripts touching it use the raw shell
runner. `verify-push.ts` is unaffected.

**Two traps the earlier session hit.** The Capacitor CLI needs Node ≥22 and
George's default `node` is v20.14.0 — prefix
`PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. And `devicectl install` over an
existing app has reported success twice while the phone kept running old
content; the reliable loop is `hutch run ios` → `xcodebuild` → **uninstall**
→ install.

## Do not re-litigate

These were argued out at length. `docs/push.md` carries the reasoning.

- **No second app.** ntfy was evaluated and rejected because it requires
  installing the ntfy app. That is the product bar.
- **Not Tailscale**, for the same reason.
- **Push is a doorbell, not a transport.** APNs stores exactly one pending
  notification per device and a new one discards the previous. The wire stays
  the source of truth. Payload text is display only.
- **The relay is filed, not in scope.** Cloudflare Worker, no Durable Object,
  learn-dead-tokens-from-Apple instead of an HMAC pass. It matters at App
  Store time, not for making George's phone buzz. The sender module runs
  unchanged in both places, which is the point.

## Loose threads, for whoever gets there

- `activePersonaId` in `src/bun/index.ts` is one global shared by desktop and
  phone. Fine for a window title, wrong for "don't buzz about the screen in
  my hand" — so `push/notify.ts` keeps its own per-device map, fed by the web
  server. Worth unifying someday; deliberately not now.
- Nothing prunes `announced` in `push/notify.ts` when a permission request
  expires without a decision. Bounded by process lifetime, so it leaks a
  string per abandoned request.
- The Notification Service Extension for encrypted previews is only needed
  when the relay lands. Do not build it early.
- `wrangler` on this machine is unauthenticated (expired OAuth token at
  `~/Library/Preferences/.wrangler/config/default.toml`) and needs Node ≥22.
  Only relevant when the relay starts.
