# App Store listing — Toad for iOS

Copy-paste source for App Store Connect. Character limits are noted beside
each field and every string below has been counted against them.

---

## App Name — 30 char limit

**Toad — Your Agent Team** *(22)*

Fallbacks if the name is contested:

- `Toad: Agent Team` *(16)*
- `Toad — Coding Agent Team` *(24)*

## Subtitle — 30 char limit

**iMessage for your agent team** *(28)*

Alternates:

- `Your agent team, from anywhere` *(30)*
- `Watch your coding agents work` *(29)*

## Promotional Text — 170 char limit

> Your coding agents keep working when you walk away. Toad puts the whole team
> in your pocket — see who finished, who's stuck, and answer them from the
> couch. *(156)*

## Keywords — 100 char limit

```
coding agent,claude code,cursor,ai,developer,remote,pair,terminal,devtools,notify,acp,team
```

*(90)* — no spaces after commas; App Store Connect counts them.

## Description — 4000 char limit

> Most AI coding tools give you one chat with one assistant. Toad gives you a
> team.
>
> On your computer, Toad runs a roster of coding agents side by side. Each one
> has its own name, its own project directory, and its own conversation that
> keeps going whether or not you are watching. Some run Toad's built-in agent.
> Others drive tools you already have — Claude Code, cursor-agent, opencode —
> each in its own lane.
>
> This app is the rest of that. Pair your phone once and the whole roster comes
> with you.
>
> **It reads like a group chat, because that is what it is**
> A list of teammates, each with an unread badge and a last line. Tap one and
> you are in the conversation — scroll back through what it did, type a reply,
> answer the question it is blocked on. No dashboards, no graphs, no widgets to
> arrange. Just the team, talking.
>
> **Know the moment something needs you**
> A teammate finishes a turn. A teammate hits a permission prompt and stops. A
> teammate errors out. Your phone buzzes for exactly those moments, with the
> teammate's name on the lock screen, and tapping the notification opens that
> conversation. Each kind of alert has its own switch, so midnight can be
> quieter than noon.
>
> **Pair by pointing your camera at your Mac**
> Your computer shows a QR code. You scan it. That is the entire setup — no
> account, no email, no password, no cloud service to sign up for. The phone
> appears in a list on your computer, and you can revoke it from there any
> time.
>
> **Your machine, your network**
> After pairing, your phone talks straight to your own computer over your own
> network. Your conversations, your code, and your API keys stay on the machine
> they already live on. Nothing routes through a server we run — there isn't
> one.
>
> **Send things to your team**
> Share a link, a screenshot, or a snippet from any app straight into a
> teammate's conversation with the iOS share sheet.
>
> **Harness-neutral by design**
> Toad does not care which agent you prefer. Run the built-in one, run Claude
> Code, run cursor-agent, run all three at once as different teammates on
> different projects. They sit next to each other in the same roster.
>
> ---
>
> Toad for iOS is a companion to the Toad desktop app, which runs on macOS,
> Linux, and Windows. You will need it installed and running on the same
> network to pair.
>
> No accounts. No analytics. No telemetry. Nothing collected.

*(2,348 characters — well inside the limit, with room for feature additions.)*

## What's New — first release

> First release. Pair your phone to your Toad desktop with a QR code, watch
> your agent team work, get a buzz when one finishes or gets stuck, and answer
> from anywhere on your network.

## Fields to fill in

| Field | Value |
| --- | --- |
| Primary category | Developer Tools |
| Secondary category | Productivity |
| Age rating | 4+ |
| Support URL | `https://toad.team/support` *(placeholder — must resolve before submit)* |
| Marketing URL | `https://toad.team` *(optional)* |
| Privacy Policy URL | `https://toad.team/privacy` *(host `docs/privacy-policy.md` here)* |
| Copyright | 2026 |
| Price | Free |

**App Privacy questionnaire:** answer **Data Not Collected** for every
category. Verified against the source — there is no analytics, telemetry,
crash reporting, or third-party SDK in the codebase.

---

# Notes for App Review

*Paste into the "Notes" field in App Store Connect. This is the part that
decides whether the build gets approved, so it is written for a reviewer who
has never heard of Toad.*

## ⚠️ Read this first: the app needs a desktop to pair with

Toad for iOS is a companion to the Toad desktop application. Without a paired
desktop on the same local network, the app opens to its pairing screen and
cannot proceed — there is no cloud service it could connect to instead,
because the product's entire premise is that your data never leaves your own
machine.

Pairing is deliberately restricted to the local network, so we cannot provide
a remote desktop for the review team to pair against. **We have therefore
attached a full demo video** showing the complete flow end to end: the desktop
showing its QR code, the phone's camera scanning it, the roster appearing, a
conversation being read and replied to, a push notification arriving on the
lock screen, and the share sheet sending a link into a conversation.

If the review team would prefer to run the desktop app directly, we will
supply a signed build and setup instructions on request, and we are happy to
walk through it on a call.

## Guideline 4.2 — Minimum Functionality

Toad for iOS is not a website in a wrapper. It uses iOS platform capabilities
that a browser cannot reach, and each is load-bearing rather than decorative:

1. **Camera pairing.** The app drives the camera as a live QR viewfinder to
   read the one-time pairing secret off the user's desktop screen. This is the
   only way into the app, and it is the reason for
   `NSCameraUsageDescription`. A browser tab cannot be the thing you point at
   your own machine to establish a trusted device identity.

2. **Push notifications.** The app registers with APNs and receives remote
   notifications sent by the user's own desktop. This is the core of the
   product: the reason to have Toad on your phone at all is to be told, while
   the phone is locked and the app is closed, that an agent finished or got
   stuck. It declares `UIBackgroundModes: remote-notification` and uses the
   notification's payload to route a tap to the right conversation. A web page
   cannot deliver a lock-screen alert from a machine on your LAN.

3. **Share extension.** Toad ships a native share extension (`ToadShare`)
   that appears in the system share sheet system-wide, receiving links, text,
   and images from any other app and passing them through a shared App Group
   container into a teammate's conversation. This is an iOS extension point
   with no web equivalent.

4. **Local network access.** The app connects directly to hardware on the
   user's own network, declared with `NSLocalNetworkUsageDescription` and
   subject to the iOS local network permission prompt.

5. **Haptics** on message and state transitions, and a native launch and
   scene lifecycle.

The app is also not a repackaged desktop UI: it is a distinct
conversation-first interface built for one-handed phone use, which is the
positioning of the listing above.

## Guideline 5.1.1 — Data collection

Toad collects nothing. There is no account system, no analytics, no telemetry,
and no third-party SDK. The privacy policy at the URL above describes exactly
what is stored locally on the device and nothing more.

## What the reviewer will see without a desktop

Launching the app shows the "Link a desktop" screen with a camera viewfinder
and a manual entry field for an address and pairing code. Entering anything
that is not a live Toad desktop returns a clear failure message. This is
expected behaviour, not a crash.
