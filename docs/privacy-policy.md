# Toad Privacy Policy

**Last updated: 24 August 2026**

Toad has no account, no sign-up, and no server that holds your conversations.
Your agent team runs on your own computer, and the Toad app on your phone is a
window onto it over your own network. This policy describes what that means in
practice, and it is short because there genuinely is not much to describe.

## The short version

- **We do not collect your data.** Toad has no analytics, no telemetry, no
  crash reporting, no advertising, and no tracking of any kind.
- **Your conversations stay on your computer.** They are not uploaded to us,
  because there is no "us" to upload them to.
- **There is no account.** No email address, no password, no profile.
- **We do not sell or share anything**, because we do not have anything.

## What Toad actually is

Toad runs on your computer and drives coding agents you have already installed
there — Claude Code, Cursor, or any other harness you have set up. Those agents
do their work on your machine, in your files.

The iPhone app pairs with that computer and shows you the same conversations,
so you can watch and reply from the couch instead of the desk. The phone is a
view onto your computer. It is not a client of any service we operate.

## How the phone connects to your computer

You pair once by pointing your phone's camera at a QR code shown on your
computer. That code is a one-time secret. Your phone trades it for its own
private token, and your computer records the phone in a list you can see and
revoke at any time.

After pairing, the phone talks **directly to your computer over your own local
network** (or your own VPN). The connection does not pass through any server we
run. If your phone and your computer are not on the same network, the phone
simply cannot reach it — there is no intermediary that would let it.

Because your computer is reachable only at a local network address, that
connection is not encrypted with a public certificate the way a website is. It
stays inside the network you control and never crosses the public internet. We
mention it plainly rather than implying more protection than exists.

## What the camera is used for

Only for reading the pairing QR code. The image is decoded on your phone, is
used for nothing else, and is never stored or transmitted. Toad does not access
your photo library except when you explicitly pick a photo of a QR code
yourself, or when you deliberately share something into the app.

## What the app stores on your phone

- The pairing token for each computer you have linked, and that computer's name
  and identifier, so it can reconnect.
- A small cache of the most recent part of each conversation — roughly the last
  couple of screens — so the app shows you something the instant you open it
  instead of a loading spinner. It is replaced by live data as soon as your
  computer answers.
- Small preferences, such as whether haptics are on.

All of this lives in the app's own private storage on your device. Deleting the
app deletes it. Unlinking a computer removes its token and its cached
conversation.

## Notifications

If you turn notifications on, Apple gives your phone a device token, and your
phone hands that token to your paired computer over the connection it already
trusts. Your computer then sends notifications **directly to Apple's Push
Notification service** using push credentials you supply. They do not pass
through any server we operate.

A notification is a doorbell, not a transport. The full conversation always
arrives over the direct connection to your computer, never in the notification
itself. What the notification carries is a short display line so the lock
screen reads like a real message: which teammate it is about, and a brief
status such as that it finished, or a one-line summary of what it is asking
you for. It never carries the conversation.

Apple necessarily handles notifications in transit, under
[Apple's privacy policy](https://www.apple.com/legal/privacy/). You can turn
notifications off entirely in iOS Settings, or per event type inside Toad.

## Sharing into Toad

When you use the iOS share sheet to send something to Toad, that content is
handed to the app and then to your paired computer, so you can hand it to an
agent. It goes nowhere else.

## The AI providers you have configured

Toad reaches AI models in two ways, and both use credentials that live on your
own computer.

Most teammates run an agent tool you installed yourself — Claude Code,
`cursor-agent`, `opencode` and the like. Those sign in on their own; Toad holds
no credentials for them and could not.

Toad also has a built-in agent, and that one calls a model provider's API
directly using a key **you** configure. That key is stored on your computer, in
Toad's own data directory or in an existing configuration file you already had.
It is never sent anywhere except to the provider it belongs to, and never to us.

Either way, what you type goes to whichever provider is behind that teammate —
Anthropic, OpenAI, or another — exactly as it would if you had used that tool
directly. Those messages are covered by that provider's privacy policy and
terms, not this one. Toad neither adds a destination nor removes one.

## Children

Toad is a developer tool and is not directed at children under 13. We do not
knowingly collect information from anyone, including children.

## Your control and your choices

- **Revoke a phone** from the device list on your computer at any time. Its
  connection drops immediately, not at some later refresh.
- **Unlink a computer** from the phone to erase its token and cached data.
- **Turn off notifications** in iOS Settings or per event type in Toad.
- **Delete the app** to remove everything it stored on your phone.

There is no data deletion request to file with us, because we are not holding
anything to delete.

## If this ever changes

If a future version of Toad introduces an optional service that would handle
your data — for example, a notification relay for people who cannot supply
their own push credentials — this policy will be updated before that version
ships, and any such service will be designed so that it cannot read the content
it carries.

## Contact

Questions about this policy: **<support@toad.team>**
