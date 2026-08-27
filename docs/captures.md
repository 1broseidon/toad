# Captures

The pictures of Toad in this repository are generated, not taken. One command
builds a screen, launches the app on it, walks the app through five surfaces
and writes the frames:

```bash
hutch run build          # once, or whenever the app changed
bun hack/capture-app.ts stills    # assets/screens/*.png
bun hack/capture-app.ts video     # assets/screens/tour.mp4
```

Nothing is watching that screen and nothing needs to be. This document is why
that works and what it costs.

## Why it can run unattended

Toad draws its own titlebar on Linux — Electrobun's GTK menu bar is a no-op
there, so the window owns its chrome. A photograph of the window is therefore
a photograph of the whole application: there is no window manager decoration
to crop out, and no window manager to install. `Xvfb` is enough. The rig
starts one on a free display in the nineties, kills it at the end, and never
touches a display a human is using.

The pieces are all already on a Linux box: `Xvfb` for the screen, `xdotool`
for the input, `ffmpeg` for the pixels. There is no browser automation in the
loop, because the thing being photographed is not a browser.

## Why the roster is seeded rather than typed

The obvious way to get a populated app on camera is to drive the UI: click
the `+`, type a name, press the button. That was the first attempt and it is
the wrong one. It depends on where things are drawn, so it breaks silently
when the layout moves — the click lands on nothing, the run continues, and
the output is five identical screenshots of an empty app that nobody looks at
until they are already in the README.

`hack/seed-capture.ts` writes the roster and one finished conversation
straight into a throwaway `TOAD_DATA_DIR`. The app renders the transcript on
disk; it has no opinion about who wrote it. So the frames show a real
conversation with no model key, no network, and no dependence on a model
saying the same thing twice.

The thinking, tool calls and plan in that seed do not appear in the picture.
The thread is deliberately kept at conversation altitude — those events drive
the activity indicator instead of drawing rows — and the seed writes them
anyway, because a transcript without them is not the shape the app reads.

## Why the beats are shortcuts

Once the app is up, the tour moves with `Ctrl+F`, `Ctrl+I`, `Ctrl+1`, `Ctrl+,`
— the same accelerators a person uses, listened for on the page because
Linux has no menu bar to bind them. They do not care where anything is drawn.

One click is unavoidable and it is not for navigation: **the WebKit widget
takes the keyboard from a click, not from the pointer resting on it.** Typing
into a field you just clicked works; every accelerator sent before that first
click is silently dropped. The rig clicks one inert stretch of the transcript
before it sends anything, and the pointer then parks off the furniture for
the rest of the run. No cursor appears in any frame.

## Three things that will bite the next person

- **The packaged launcher's first run is an installer.** It unpacks the app
  into `~/.local/share/sh.toad.desktop/stable/app` and exits without opening
  a window. The app starts on the run after that.
- **One Toad per data folder, enforced by a pid in `toad.lock`.** The
  launcher is a shim, so killing it leaves the real process — and its window
  — alive. A relaunch then quits on the lock while its predecessor's window
  is still on screen, which is indistinguishable from the relaunch failing.
  The rig kills the profile, by finding whoever declared it, and waits for
  the window to go before starting anything.
- **The view sometimes never finishes loading.** On Linux the page's socket
  to the main process occasionally never completes and the window sits on
  *Loading…* for good — the same race `hutch.config.ts` works around in dev
  by serving the view over localhost. It is a launch-time coin flip, not a
  slow start, so there is nothing to wait for. The rig detects it and
  relaunches, up to four times. **This is a real bug in the app, not in the
  rig**; the workaround is here because the capture had to survive it.

Readiness is checked against the data, not the pixels: selecting the first
teammate renames the window to `Wren — Toad`, so the window title says
whether the roster arrived. A *Loading…* screen is perfectly stable, so
waiting for the pixels to stop moving would happily photograph one.

## Live captures

`--live` lends the throwaway profile the credentials from the real profile at
`~/.local/share/toad/pi/auth.json`, types a question into the composer and
waits for the agent to actually answer:

```bash
bun hack/capture-app.ts stills /tmp/shots --live --ask "In one sentence, what are you for?"
```

The copy lives and dies in `/tmp`, and no credential value is ever on screen:
the settings pane does not read them back.

Waiting is done against the transcript rather than the screen — one `turn`
event per completed turn, on disk. Pixels cannot tell *still thinking* from
*finished quietly*. `--turns 2` sits through a second one, which is what a
teammate messaging another teammate costs: the sender's turn ends when the
message is away, and the reply arrives as a turn of its own.

`assets/screens/teammates.png` came from exactly that, and it is the one
image here that a model wrote. Everything else is reproducible without a key;
that one is not, and it is worth the exception because two agents talking is
the thing this app is for.

A live tour makes a poor **video**, though. The clip's length becomes the
model's latency, most of it dead air, and a two-agent exchange can take
minutes or take a different route entirely. `tour.mp4` is the seeded tour for
that reason: same five surfaces, twenty seconds, identical every time.

## Capturing a session someone is driving

`--attach` photographs an app that is already running instead of launching
one, which is how you get a picture of a real session rather than a staged
one:

```bash
bun hack/capture-app.ts shot /tmp/now.png --display :1 --attach
```
