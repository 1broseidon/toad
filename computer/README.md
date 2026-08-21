# toad-computer

A containerized Linux desktop a Toad teammate drives over MCP: Xvfb +
fluxbox, mouse/keyboard via xdotool, screen capture with an AT-SPI
accessibility tree, OCR fallback, Playwright-managed Chromium, shell and
file tools, and a view-only VNC feed. Ported from vhd; the design and the
security posture live in [`docs/computer.md`](../docs/computer.md).

## Build

```sh
docker build -t toad-computer:dev computer/
```

## Run (hardened — this is the supported shape)

```sh
TOKEN=$(openssl rand -hex 24)
docker run -d --name toad-computer-test \
  --cap-drop=ALL --security-opt no-new-privileges \
  --memory 2g --pids-limit 512 --shm-size 1g \
  -p 127.0.0.1:8787:8787 -p 127.0.0.1:5999:5999 \
  -e TOAD_COMPUTER_TOKEN=$TOKEN \
  toad-computer:dev
```

The image needs no capabilities. If a guide tells you to add some, the guide
is wrong.

- MCP (streamable HTTP): `http://127.0.0.1:8787/mcp`, bearer token required
  when `TOAD_COMPUTER_TOKEN` is set. `/health` stays open for probes.
- VNC (view-only): port 5999; `TOAD_COMPUTER_VNC_PASSWORD` to protect it.

## Verify

```sh
TOAD_COMPUTER_TOKEN=$TOKEN bun hack/verify-computer.ts
```

## Use from Toad (v0)

Settings → MCP servers → add an HTTP server:

- URL: `http://127.0.0.1:8787/mcp`
- Header: `Authorization: Bearer <token>`

Any teammate whose MCP policy includes the server gets the computer's tools
on its next session start.

## Watch the screen

```sh
# any VNC viewer against 127.0.0.1:5999, e.g.
vncviewer 127.0.0.1:5999
```
