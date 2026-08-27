# toad.computer

A containerized Linux desktop a teammate drives over MCP: Xvfb + fluxbox,
mouse/keyboard via xdotool, screen capture with an AT-SPI accessibility tree,
OCR fallback, Playwright-managed Chromium, shell and file tools, and a VNC
feed. The design and the security posture live in
[`docs/computer.md`](../docs/computer.md).

The contract is what this desktop offers. Point cursor-agent (or any MCP
client) at `/mcp` — toad.team is optional.

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
- VNC: port 5999; `TOAD_COMPUTER_VNC_PASSWORD` to protect it.

## Verify

```sh
TOAD_COMPUTER_TOKEN=$TOKEN bun scripts/verify-computer.ts
```

## Use from toad.team

Settings → MCP servers → add an HTTP server:

- URL: `http://127.0.0.1:8787/mcp`
- Header: `Authorization: Bearer <token>`

Or enable Computer on a teammate and let toad.team wake the published image.

## Watch the screen

```sh
vncviewer 127.0.0.1:5999
```
