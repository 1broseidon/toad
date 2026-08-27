/**
 * Emits the Rooms design-pass cards: one self-contained HTML file per
 * screen, in the app's own tokens, for the claude.ai design project.
 *
 *   bun hack/rooms-design/build.ts   → hack/rooms-design/out/
 *
 * Working material for one review, like the audit it answers.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "out");
mkdirSync(OUT, { recursive: true });

const CSS = `
:root{
--paper:oklch(11% .002 250);--paper2:oklch(16% .003 250);--paper3:oklch(20% .003 250);--paper4:oklch(24.5% .004 250);
--ink:oklch(95% .002 250);--ink2:oklch(80% .003 250);--ink3:oklch(67% .003 250);
--rule:oklch(26% .003 250);--rule2:oklch(21% .003 250);
--accent:oklch(76% .17 142);--accent-ink:oklch(16% .02 150);--accent-wash:oklch(76% .17 142/.1);--accent-edge:oklch(76% .17 142/.32);
--warn:oklch(80% .14 78);--warn-wash:oklch(80% .14 78/.09);
--danger:oklch(72% .16 25);--danger-wash:oklch(72% .16 25/.12);
--blue:oklch(72% .12 250);--blue-wash:oklch(72% .12 250/.12);
}
*{box-sizing:border-box;margin:0}
body{background:oklch(8% .002 250);color:var(--ink);font:14px/1.55 -apple-system,system-ui,sans-serif;padding:20px}
.grid{display:flex;gap:22px;align-items:flex-start}
h1{font-size:19px;letter-spacing:-.01em;margin-bottom:2px}
.sub{color:var(--ink3);font-size:13px;margin-bottom:16px}
.chip{display:inline-block;background:var(--paper3);border:1px solid var(--rule);border-radius:99px;padding:1px 9px;font-size:11px;color:var(--ink2);margin-right:4px}
.chip.fix{background:var(--accent-wash);border-color:var(--accent-edge);color:var(--accent)}
.notes{flex:1;min-width:0}
.notes h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);margin:14px 0 6px}
.notes p,.notes li{font-size:13px;color:var(--ink2)}
.notes ul{padding-left:18px;display:flex;flex-direction:column;gap:5px}
.was{border-left:3px solid var(--rule);padding:2px 10px;color:var(--ink3);font-size:12.5px;font-style:italic}
.now{border-left:3px solid var(--accent);padding:2px 10px;color:var(--ink);font-size:12.5px}
code{font-family:ui-monospace,SF Mono,monospace;font-size:.92em;color:var(--ink2)}
/* ------------------------------------------------------------ phone frame */
.phone{width:300px;flex:none;background:var(--paper);border:1px solid var(--rule);border-radius:34px;padding:12px 12px 16px;box-shadow:0 18px 50px rgb(0 0 0/.5)}
.phone .screen{border-radius:24px;overflow:hidden;background:var(--paper);min-height:520px;display:flex;flex-direction:column;position:relative}
.statusbar{display:flex;justify-content:space-between;padding:8px 18px 2px;font-size:11px;color:var(--ink2);font-weight:600}
.big{font-size:24px;font-weight:700;letter-spacing:-.02em;padding:14px 16px 4px}
.pagesub{color:var(--ink3);font-size:12.5px;padding:0 16px 10px}
.label{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);padding:14px 16px 5px}
.pcard{background:var(--paper2);border-radius:13px;margin:0 12px}
.row{display:flex;align-items:center;gap:10px;padding:10px 12px;min-height:44px}
.row+.row{border-top:1px solid var(--rule2)}
.row .ic{width:26px;height:26px;border-radius:7px;background:var(--paper3);display:flex;align-items:center;justify-content:center;font-size:13px;flex:none}
.row .tx{flex:1;min-width:0}
.row .tt{display:block;font-size:14px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .dd{display:block;font-size:11.5px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .dd.on{color:var(--accent)}
.row .end{flex:none;font-size:12px;color:var(--ink3)}
.row .end.on{color:var(--accent)}
.chev{color:var(--ink3);flex:none;font-size:14px}
.foot{color:var(--ink3);font-size:11px;line-height:1.5;padding:7px 16px 0}
.dot{width:7px;height:7px;border-radius:99px;flex:none}
.dot.on{background:var(--accent)}
.dot.off{border:1.4px solid var(--ink3)}
.dot.warn{background:var(--warn)}
.badge{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex:none}
.badge.moss{background:var(--accent-wash);color:var(--accent);border:1px solid var(--accent-edge)}
.badge.blue{background:var(--blue-wash);color:var(--blue);border:1px solid oklch(72% .12 250/.32)}
.badge.grey{background:var(--paper3);color:var(--ink3);border:1px solid var(--rule)}
.btn{display:block;text-align:center;background:var(--accent);color:var(--accent-ink);font-weight:600;border-radius:12px;padding:11px;margin:10px 14px 0;font-size:14px}
.btn.ghost{background:none;color:var(--ink3);font-weight:500}
.btn.danger{background:var(--danger-wash);color:var(--danger)}
.spacer{flex:1}
.pill{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:oklch(20% .003 250/.85);border:1px solid var(--rule);border-radius:99px;padding:6px 12px;backdrop-filter:blur(8px)}
.pill .plus{width:34px;height:34px;border-radius:99px;background:var(--accent);color:var(--accent-ink);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px}
.pill .item{display:flex;flex-direction:column;align-items:center;font-size:9px;color:var(--ink2);gap:1px;position:relative}
.pill .item .g{font-size:15px}
.pill .item .pd{position:absolute;top:-1px;right:-5px;width:6px;height:6px;border-radius:99px;background:var(--accent)}
.banner{margin:8px 12px;background:var(--paper2);border:1px solid var(--rule);border-radius:11px;padding:8px 12px;font-size:12px;color:var(--ink2);text-align:center}
.banner b{color:var(--ink)}
.banner .act{color:var(--accent)}
.sheet{margin-top:auto;background:var(--paper2);border-radius:20px 20px 0 0;padding:12px 14px 16px;border-top:1px solid var(--rule)}
.sheet .grab{width:34px;height:4px;border-radius:99px;background:var(--paper4);margin:0 auto 10px}
.sheet h3{text-align:center;font-size:15px;margin-bottom:4px}
.sheet p{text-align:center;font-size:12.5px;color:var(--ink3);margin-bottom:12px}
.mono{font-family:ui-monospace,SF Mono,monospace;font-size:11px;color:var(--ink3)}
.field{background:var(--paper2);border:1px solid var(--rule);border-radius:10px;padding:9px 11px;margin:4px 14px 0;font-size:13px;color:var(--ink3)}
.field b{color:var(--ink);font-weight:500;font-family:ui-monospace,monospace}
table{border-collapse:collapse;width:100%;font-size:12.5px}
td,th{border:1px solid var(--rule);padding:6px 10px;text-align:left;vertical-align:top}
th{color:var(--ink3);font-size:11px;letter-spacing:.05em;text-transform:uppercase}
td{color:var(--ink2)}
`;

function page(title: string, body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function phone(inner: string): string {
	return `<div class="phone"><div class="screen"><div class="statusbar"><span>10:07</span><span>&#xF8FF;&#65038; ●●●</span></div>${inner}</div></div>`;
}

const write = (name: string, html: string) => Bun.write(join(OUT, name), html);

/* ---------------------------------------------------------- 00 overview */
await write("00-overview.html", page("Overview", `
<h1>Rooms — the mobile pass</h1>
<p class="sub">Answers docs/ios-room-vocabulary-audit.md (20 findings, A–K). One rule everywhere: <b>the room is the world, a desktop is plumbing, and "instance / membership / node" are words the user never reads.</b></p>
<div class="grid"><div class="notes">
<h2>The model, in the words the app will use</h2>
<ul>
<li>You <b>join a room</b> — never a computer. The invite QR lives on the desktop's <b>Room</b> settings.</li>
<li>A room shows its <b>whole team</b> from any of its desktops; the app picks a healthy desktop by itself and says which one as a detail: <i>"via Georges-Mac-mini"</i>.</li>
<li>Every teammate <b>lives on</b> exactly one desktop (the owner). That's the only reason a desktop's name ever appears in primary UI.</li>
<li>Rooms are <b>contexts</b>: personal fleet, work fleet. Switching rooms switches everything. Leaving one room touches only that room.</li>
<li>Identity is a <b>key fingerprint</b> — one name for it on every surface, phone and desktop.</li>
</ul>
<h2>Fix map</h2>
<ul>
<li><span class="chip fix">F2</span> behavior bug — leave drops every room → scoped to one. Ships first, no design needed.</li>
<li><span class="chip fix">C1 C2</span> banners — "Instances" leak + "this desktop" → card 05.</li>
<li><span class="chip fix">A1 A2</span> first launch → card 02.</li>
<li><span class="chip fix">E1–E4</span> the room screen redesign → card 07 (the centerpiece).</li>
<li><span class="chip fix">D1–D4</span> settings home → card 06.</li>
<li><span class="chip fix">B1 G2</span> cross-surface naming (needs one desktop-side edit) → cards 03, 09.</li>
<li><span class="chip fix">D3 H1 I1</span> "the desktop" singulars → the owner rule, card 12.</li>
<li><span class="chip fix">K1 K2</span> dead DesktopsSheet + dead pin → deleted, no design.</li>
</ul>
</div></div>`));

/* --------------------------------------------------------- 01 identity */
await write("01-identity.html", page("Room & node identity", `
<h1>How a room and its nodes are drawn</h1>
<p class="sub">The visual system for the namespace and its members — used on every card that follows.</p>
<div class="grid">
${phone(`
<div class="label">Rooms are badges</div>
<div class="pcard">
<div class="row"><span class="badge moss">TR</span><span class="tx"><span class="tt">Toad Room</span><span class="dd on">via Georges-Mac-mini</span></span><span class="dot on"></span></div>
<div class="row"><span class="badge blue">AC</span><span class="tx"><span class="tt">Acme Corp</span><span class="dd">2 desktops</span></span><span class="chev">›</span></div>
</div>
<div class="foot">A room's badge takes its monogram and a steady hue from the room's id — the same room is the same color on every screen and every device. The active room carries the wire dot and its gateway.</div>
<div class="label">Desktops are detail rows</div>
<div class="pcard">
<div class="row"><span class="dot on"></span><span class="tx"><span class="tt">Georges-Mac-mini</span><span class="dd on">your connection</span></span><span class="mono">0e30 5ea7</span></div>
<div class="row"><span class="dot off"></span><span class="tx"><span class="tt">beastie-linux</span><span class="dd">last seen 2m ago</span></span><span class="mono">79fc e114</span></div>
</div>
<div class="foot">Moss dot = the desktop you're riding now. Hollow = in the room, not your connection. Fingerprints show as four groups and are called <b>key fingerprint</b> everywhere.</div>
<div class="label">This phone is a member</div>
<div class="pcard">
<div class="row"><span class="ic">☎︎</span><span class="tx"><span class="tt">iPhone</span><span class="dd">key fingerprint 8cbf 2feb</span></span></div>
</div>
`)}
<div class="notes">
<h2>Rules</h2>
<ul>
<li><b>Room badge</b>: rounded square, monogram, deterministic hue from room id (moss stays reserved-ish for the wire; room hues avoid reading as status). Appears in Rooms list, room screen header, About, and the join-confirmation moment.</li>
<li><b>Status dots</b> keep the app's existing vocabulary: moss = live wire, hollow = known & quiet, amber = looking. Never a room-hue dot — hue is identity, dot is health.</li>
<li><b>"via &lt;desk&gt;"</b> is the only place the gateway is named in primary UI, always as a caption, never a title.</li>
<li><b>Key fingerprint</b> (G2): one term, phone and desktop. Desktop's Room pane relabels "key fingerprint"→ same words.</li>
<li>Other <b>phones in the room</b>: not shown on the phone in v1 (no RPC for it); the desktop's Room pane stays the roster of members. Marked "later", not designed around.</li>
</ul>
</div></div>`));

/* ---------------------------------------------------------- 02 welcome */
await write("02-welcome.html", page("First launch", `
<h1>02 · First launch — no room yet</h1>
<p class="sub"><span class="chip fix">A1</span><span class="chip fix">A2</span> A welcome, not an empty manager.</p>
<div class="grid">
${phone(`
<div class="spacer"></div>
<div style="text-align:center;padding:0 26px">
<div style="font-size:40px;margin-bottom:10px">▄▄</div>
<div style="font-size:20px;font-weight:700;margin-bottom:8px">Toad</div>
<p style="font-size:13.5px;color:var(--ink2)">A room is your team of agents across all your computers. Join one to get started.</p>
</div>
<div class="spacer"></div>
<a class="btn">Join a room</a>
<div class="foot" style="text-align:center;padding-bottom:14px">The invite is on any desktop in the room:<br>Settings → Room → Invite</div>
`)}
<div class="notes">
<h2>Today</h2>
<p class="was">"Room" / "Connections in this room." — a manager screen for a thing that doesn't exist, then "Join a room to get started" twice.</p>
<h2>Proposed</h2>
<ul>
<li>A distinct welcome state: mark, one sentence that teaches the model, one button. No list chrome, no title claiming a room.</li>
<li>The instruction under the button names where the invite lives — same words the desktop uses (see card 03).</li>
<li>This screen renders only when the phone holds zero memberships and zero legacy links; the manager screen (card 07) is never shown empty.</li>
</ul>
</div></div>`));

/* ------------------------------------------------------------- 03 join */
await write("03-join.html", page("Join a room", `
<h1>03 · Join a room</h1>
<p class="sub"><span class="chip fix">B1</span><span class="chip fix">B3</span> One name for the invite, on both surfaces.</p>
<div class="grid">
${phone(`
<div class="big">Join a room</div>
<div class="pagesub">On a desktop in the room, open <b style="color:var(--ink)">Settings → Room</b> and press <b style="color:var(--ink)">Invite</b>, then scan the code.</div>
<div style="margin:4px 14px;border:1px solid var(--rule);border-radius:14px;background:var(--paper2);aspect-ratio:8/5;display:flex;align-items:center;justify-content:center;color:var(--ink3);font-size:12px">camera</div>
<div class="label">Or type it</div>
<div class="field">Desktop address · <b>192.168.1.20</b></div>
<div class="field">Invite code · <b>a6c5daf5</b></div>
<a class="btn">Join</a>
<div class="spacer"></div>
`)}
<div class="notes">
<h2>Today</h2>
<p class="was">"On the desktop, open Settings → General → Web access and press 'Add device'." — the desktop's old label; three surfaces name this QR three ways.</p>
<h2>Proposed</h2>
<ul>
<li>Phone says <b>Settings → Room → Invite</b>. Requires the matching desktop edit: the Room pane's QR affordance is titled <b>Invite</b> (it can keep living on the web-access machinery underneath until Phase 7).</li>
<li>Fields: <b>Desktop address</b> (names whose address it is — B3) and <b>Invite code</b> (not "code").</li>
<li>Button: <b>Join</b> — the screen title already said what you're joining.</li>
</ul>
</div></div>`));

/* ----------------------------------------------------------- 04 joined */
await write("04-joined.html", page("The arrival", `
<h1>04 · Arriving in a room</h1>
<p class="sub"><span class="chip fix">B2</span> The one moment that can teach the whole model, currently silent.</p>
<div class="grid">
${phone(`
<div class="big">Team</div>
<div class="pcard" style="opacity:.45">
<div class="row"><span class="badge grey">P</span><span class="tx"><span class="tt">Patch</span><span class="dd">stopped</span></span></div>
<div class="row"><span class="badge grey">N</span><span class="tx"><span class="tt">Nimbus</span><span class="dd">idle</span></span></div>
</div>
<div class="spacer"></div>
<div class="sheet">
<div class="grab"></div>
<div style="display:flex;justify-content:center;margin-bottom:8px"><span class="badge moss" style="width:44px;height:44px;font-size:16px">TR</span></div>
<h3>You're in Toad Room</h3>
<p>2 desktops share this team. The app stays connected through whichever one answers fastest — right now that's Georges-Mac-mini.</p>
<a class="btn">Meet the team</a>
</div>
`)}
<div class="notes">
<h2>Proposed</h2>
<ul>
<li>A one-time sheet after a successful join (not on re-join of a known room): room badge, room name, one sentence of how connection works.</li>
<li>Dismiss lands on the roster. Never shown again for that room.</li>
<li>Cheap to build — the join answer already carries room name + desk count.</li>
</ul>
</div></div>`));

/* ---------------------------------------------------------- 05 banners */
await write("05-banners.html", page("Banners", `
<h1>05 · Wire-lost and version-skew banners</h1>
<p class="sub"><span class="chip fix">C1</span><span class="chip fix">C2</span> The loudest leftover: <code>Instances</code> in shipped UI.</p>
<div class="grid">
${phone(`
<div class="banner"><b>Toad Room</b> — finding a desktop… <span class="act">Rooms</span></div>
<div class="big">Team</div>
<div class="pcard" style="opacity:.5">
<div class="row"><span class="badge grey">K</span><span class="tx"><span class="tt">King Pin</span><span class="dd">…</span></span></div>
<div class="row"><span class="badge grey">A</span><span class="tx"><span class="tt">Ada</span><span class="dd">…</span></span></div>
</div>
<div class="banner" style="margin-top:14px;border-color:oklch(80% .14 78/.34);background:var(--warn-wash)">Georges-Mac-mini runs Toad <b>0.3.0</b> — this app was built from 0.2.0. Some things may not line up.</div>
<div class="spacer"></div>
`)}
<div class="notes">
<h2>Today</h2>
<p class="was">"Looking for Georges-Mac-mini.local… <b>Instances</b>" — raw identifier as a link, and the outage framed as a missing machine.</p>
<p class="was">"This desktop runs Toad 0.2.0…" — from a phone, "this desktop" points at nothing.</p>
<h2>Proposed</h2>
<ul>
<li>Wire lost: <b>the room's name</b> and what the app is doing about it — "finding a desktop…" — because failover is its job. The action opens <b>Rooms</b> in Settings.</li>
<li>Only if the whole room stays dark past the retry window does the copy harden: "No desktop in Toad Room is answering."</li>
<li>Skew names the desk it means: "<b>Georges-Mac-mini</b> runs Toad 0.3.0…".</li>
</ul>
</div></div>`));

/* ---------------------------------------------------- 06 settings home */
await write("06-settings-home.html", page("Settings home", `
<h1>06 · Settings home</h1>
<p class="sub"><span class="chip fix">D1</span><span class="chip fix">D2</span><span class="chip fix">D3</span><span class="chip fix">D4</span></p>
<div class="grid">
${phone(`
<div class="label">Rooms</div>
<div class="pcard">
<div class="row"><span class="badge moss">TR</span><span class="tx"><span class="tt">Toad Room</span><span class="dd on">via Georges-Mac-mini</span></span><span class="dot on"></span><span class="chev">›</span></div>
<div class="row"><span class="badge blue">AC</span><span class="tx"><span class="tt">Acme Corp</span><span class="dd">2 desktops</span></span><span class="chev">›</span></div>
<div class="row"><span class="ic">＋</span><span class="tx"><span class="tt">Join a room</span></span><span class="chev">›</span></div>
</div>
<div class="foot">A room is your whole team, from any of its desktops — the app finds a healthy one on its own. Tap a room to switch; tap the active one to open it.</div>
<div class="label">Room-wide</div>
<div class="pcard">
<div class="row"><span class="ic">🔔</span><span class="tx"><span class="tt">Notifications</span></span><span class="end">on</span><span class="chev">›</span></div>
</div>
<div class="foot">Shared across the room — any of its desktops can buzz this phone.</div>
<div class="label">This phone</div>
<div class="pcard">
<div class="row"><span class="ic">〰️</span><span class="tx"><span class="tt">Haptics</span></span><span class="end on">on</span></div>
<div class="row"><span class="ic">ⓘ</span><span class="tx"><span class="tt">About</span></span><span class="end">1.0 (1)</span><span class="chev">›</span></div>
</div>
<div style="height:70px"></div>
<div class="spacer"></div>
<div class="pill"><span class="plus">+</span><span class="item"><span class="g">⚙︎</span>Settings<span class="pd"></span></span></div>
`)}
<div class="notes">
<h2>Changes</h2>
<ul>
<li><b>Rooms first.</b> The room is the app's most important object; it opens the screen.</li>
<li>Room rows are <b>two-line</b>: badge + name, caption "via …" — the gateway never truncates into "Georges-Mac…" (D2). Wire dot on the right.</li>
<li><b>Notifications moves out of This Phone</b> into a Room-wide group with an honest footnote (D1, H1). Haptics is what's genuinely local.</li>
<li><b>About previews the phone's version</b>, matching the screen it opens (D4). The desk's version lives inside About as room detail.</li>
<li>Footnotes that said "the desktop" say the room, or the owner (D3): <i>"Agents, tools, storage, and push signing are configured on the desktop that owns them."</i></li>
</ul>
</div></div>`));

/* ------------------------------------------------------------- 07 room */
await write("07-room.html", page("The room screen", `
<h1>07 · The room screen — the centerpiece</h1>
<p class="sub"><span class="chip fix">E1</span><span class="chip fix">E2</span><span class="chip fix">E3</span><span class="chip fix">E4</span> Tap the active room. Finally about the room.</p>
<div class="grid">
${phone(`
<div style="display:flex;align-items:center;gap:12px;padding:16px 16px 4px">
<span class="badge moss" style="width:44px;height:44px;font-size:16px">TR</span>
<div><div style="font-size:20px;font-weight:700">Toad Room</div>
<div style="font-size:11.5px;color:var(--ink3)">2 desktops · joined Aug 27</div></div>
</div>
<div class="label">Connection</div>
<div class="pcard">
<div class="row"><span class="dot on"></span><span class="tx"><span class="tt">Georges-Mac-mini</span><span class="dd on">your connection · 12ms</span></span><span class="mono">0e30 5ea7</span></div>
<div class="row"><span class="dot off"></span><span class="tx"><span class="tt">beastie-linux</span><span class="dd">last seen 2m ago</span></span><span class="mono">79fc e114</span></div>
</div>
<div class="foot">Automatic — the app rides whichever desktop answers and walks when one goes quiet.</div>
<div class="label">This phone</div>
<div class="pcard">
<div class="row"><span class="ic">☎︎</span><span class="tx"><span class="tt">iPhone</span><span class="dd">key fingerprint 8cbf 2feb 5c5a faf9</span></span></div>
</div>
<div class="foot">What this room's desktops list you as. Manage which desktops this phone may see from any desktop's Room settings.</div>
<div class="spacer"></div>
<a class="btn ghost danger" style="margin-bottom:12px">Leave Toad Room</a>
`)}
<div class="notes">
<h2>Today</h2>
<p class="was">Machine rows with bare IPs, no marker for the desk you're riding, and the loudest button is "Join a room" — leaving for a different room from the screen that manages this one.</p>
<h2>Proposed</h2>
<ul>
<li><b>Header is the room</b>: badge, name, desk count, joined date. (Rename stays a desktop act in v1 — the founder desk owns the record; the header says so if tapped.)</li>
<li><b>Connection section</b> replaces the machine list: the riding desk marked live with latency, the rest with last-seen. IPs demoted to the row's detail on tap, not the face of it (E2).</li>
<li>Rows are no longer a chooser — connection is automatic, said plainly. (A per-room pin can return here later; the dead <code>setConnectionPin</code> is deleted until it has this UI.)</li>
<li><b>This phone</b>: the membership identity, fingerprint in the unified words.</li>
<li><b>Leave Toad Room</b> is the screen's one destructive act, named, at the foot. "Join a room" lives only on Settings → Rooms (E1).</li>
</ul>
</div></div>`));

/* ------------------------------------------------------------ 08 leave */
await write("08-leave.html", page("Leaving", `
<h1>08 · Leaving a room</h1>
<p class="sub"><span class="chip fix">F1</span><span class="chip fix">F2</span><span class="chip fix">F3</span> Scoped in behavior and in words.</p>
<div class="grid">
${phone(`
<div class="big" style="opacity:.4">Toad Room</div>
<div class="pcard" style="opacity:.35"><div class="row"><span class="dot on"></span><span class="tx"><span class="tt">Georges-Mac-mini</span></span></div></div>
<div class="spacer"></div>
<div class="sheet">
<div class="grab"></div>
<h3>Leave Toad Room?</h3>
<p>This phone disconnects from Toad Room and its desktops. Your place in the room is kept — scan any of its invites to come back. Other rooms aren't touched.</p>
<a class="btn" style="background:var(--danger);color:#fff">Leave Toad Room</a>
<a class="btn ghost">Cancel</a>
</div>
`)}
<div class="notes">
<h2>Today</h2>
<p class="was">"Every desktop in this membership leaves this phone. The membership itself stays on the desktops…" — internal vocabulary, inverted subject, and <b>the code drops every room, not this one</b> (F2).</p>
<h2>Proposed</h2>
<ul>
<li><b>F2 first, as code:</b> <code>leaveRoom(roomKey)</code> drops only that room's rows. Ships before any copy.</li>
<li>The sheet names the room in title and action (F3).</li>
<li>Subject is the phone leaving a room; "membership" never appears — "your place in the room is kept" carries the same fact (F1).</li>
<li>The last sentence states the scoping so the multi-room promise is explicit.</li>
</ul>
</div></div>`));

/* ------------------------------------------------------------ 09 about */
await write("09-about.html", page("About", `
<h1>09 · About</h1>
<p class="sub"><span class="chip fix">G1</span><span class="chip fix">G2</span> The room gets billing; the hostname stops getting it.</p>
<div class="grid">
${phone(`
<div class="big">About</div>
<div class="label">This phone</div>
<div class="pcard">
<div class="row"><span class="tx"><span class="tt">Version</span></span><span class="end">1.0 (1)</span></div>
<div class="row"><span class="tx"><span class="tt">Key fingerprint</span></span><span class="end mono">8cbf 2feb 5c5a faf9</span></div>
</div>
<div class="label">Toad Room</div>
<div class="pcard">
<div class="row"><span class="badge moss">TR</span><span class="tx"><span class="tt">Toad Room</span><span class="dd">2 desktops</span></span></div>
<div class="row"><span class="tx"><span class="tt">Connected via</span></span><span class="end">Georges-Mac-mini · Toad 0.2.0</span></div>
</div>
<div class="spacer"></div>
`)}
<div class="notes">
<h2>Today</h2>
<p class="was">"THIS PHONE" and "GEORGES-MAC-MINI.LOCAL" as equal sections; the room absent from the one screen explaining what the app is attached to. Fingerprint labeled "Node key" here, "key fingerprint" on the desktop.</p>
<h2>Proposed</h2>
<ul>
<li>Two subjects: <b>this phone</b> (its version, its key) and <b>the room</b> (badge, name, size), with the desk and its Toad version as a line of room detail.</li>
<li><b>Key fingerprint</b> everywhere (G2) — the phrase people compare aloud during a join.</li>
</ul>
</div></div>`));

/* ---------------------------------------------------- 10 notifications */
await write("10-notifications.html", page("Notifications", `
<h1>10 · Notifications copy</h1>
<p class="sub"><span class="chip fix">H1</span><span class="chip fix">H2</span> The one-computer sentence, retired.</p>
<div class="grid">
${phone(`
<div class="big">Notifications</div>
<div class="pcard">
<div class="row"><span class="tx"><span class="tt">When a teammate finishes</span></span><span class="end on">on</span></div>
<div class="row"><span class="tx"><span class="tt">When a teammate needs you</span></span><span class="end on">on</span></div>
</div>
<div class="foot">Any desktop in Toad Room can send these. The switches are shared across the room, so every desktop honors them.</div>
<div class="spacer"></div>
`)}
<div class="notes">
<h2>Today</h2>
<p class="was">"Your desktop signs and sends every buzz." / "These switches are shared with it." — the code registers this phone's token with <i>every</i> desk on purpose.</p>
<h2>Proposed</h2>
<ul><li>Name the room, plural the desks, and let "shared" mean the true thing: room-scoped settings.</li></ul>
</div></div>`));

/* --------------------------------------------------- 11 new teammate */
await write("11-new-teammate.html", page("New teammate", `
<h1>11 · New teammate — the owner question</h1>
<p class="sub"><span class="chip fix">J1</span><span class="chip fix">J2</span> Ask where it lives, not "which desktop".</p>
<div class="grid">
${phone(`
<div class="big">New teammate</div>
<div class="field">Name · <b>Biscuit</b></div>
<div class="field">Goal · <b>QA on the release branch</b></div>
<div class="label">Lives on</div>
<div class="pcard">
<div class="row"><span class="dot on"></span><span class="tx"><span class="tt">Georges-Mac-mini</span><span class="dd on">your connection</span></span><span class="end on">✓</span></div>
<div class="row"><span class="dot off"></span><span class="tx"><span class="tt">beastie-linux</span></span></div>
</div>
<div class="foot">A teammate runs on one desktop and is reachable from the whole room.</div>
<a class="btn">Create Biscuit</a>
<div class="spacer"></div>
`)}
<div class="notes">
<h2>Today</h2>
<p class="was">Section "Desktop", first option "This desktop" — from a phone that's whichever desk failover parked you on. Unreachable target answers with <code>window.alert(…)</code>.</p>
<h2>Proposed</h2>
<ul>
<li>Section is <b>Lives on</b> — the owner question, which is real and the user's to make. Default: the current gateway, marked "your connection" so the default explains itself.</li>
<li>The footnote teaches ownership in one sentence.</li>
<li>Failures arrive as the app's own sheet, never a JS alert (J2).</li>
</ul>
</div></div>`));

/* ------------------------------------------------------ 12 vocabulary */
await write("12-vocabulary.html", page("Vocabulary", `
<h1>12 · The words, settled</h1>
<p class="sub">The whole pass in one table — what every surface says, and what none may.</p>
<table>
<tr><th>Say</th><th>For</th><th>Never say</th></tr>
<tr><td><b>room</b> · "Toad Room"</td><td>the named thing everything joins</td><td>instance, control plane, mesh, fleet</td></tr>
<tr><td><b>desktop</b>, by name</td><td>a machine in the room, as detail</td><td>node, peer, gateway (as UI text)</td></tr>
<tr><td><b>via &lt;desktop&gt;</b> / "your connection"</td><td>the desk the phone is riding</td><td>hub, active instance</td></tr>
<tr><td><b>join / leave a room</b> · "your place in the room is kept"</td><td>membership acts</td><td>membership, admission, grant, pair</td></tr>
<tr><td><b>invite</b> / <b>invite code</b></td><td>the QR and its code, both surfaces</td><td>"Add device", "Web access", pairing code</td></tr>
<tr><td><b>lives on &lt;desktop&gt;</b> / "the desktop that owns them"</td><td>ownership (agents, tools, workspace, push key)</td><td>"the desktop", bare and singular</td></tr>
<tr><td><b>key fingerprint</b></td><td>identity verification, phone & desktop</td><td>node key, NodeIdentity</td></tr>
<tr><td><b>direct link</b></td><td>a legacy pre-room pairing, until removed</td><td>legacy, token</td></tr>
</table>
<div class="notes"><h2>The owner rule (D3 · H1 · I1)</h2>
<p>Where the old copy said "the desktop", the true sentence is one of exactly two: a <b>room</b> sentence ("any desktop in the room can…", for push, reachability, invites) or an <b>owner</b> sentence ("the desktop that owns/runs them", for agents, tools, workspace, push signing). Pick per sentence; never the bare singular again.</p>
<h2>Desktop-side edits this pass requires</h2>
<p>Two, both small: the Room pane's QR affordance titled <b>Invite</b> with the phone's sentence beside it (B1), and "key fingerprint" as the label wherever the fingerprint shows (G2).</p>
</div>`));

console.log("cards written to", OUT);
