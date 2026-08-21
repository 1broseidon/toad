# syntax=docker/dockerfile:1
#
# The Toad computer: a containerized Linux desktop a teammate drives over
# MCP. See docs/computer.md in the repo root for the contract and the
# security posture; the short version is that this image expects to be run
# with every capability dropped, and the container is the sandbox.

# ── Build stage ──────────────────────────────────────────────────────────
FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /computer-agent ./cmd/computer-agent

# ── Desktop stage ────────────────────────────────────────────────────────
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core display
    xvfb \
    fluxbox \
    # VNC server for the screen view
    x11vnc \
    # Input & window control
    xdotool \
    xclip \
    wmctrl \
    # Screenshots
    scrot \
    # OCR fallback
    tesseract-ocr \
    # Accessibility tree
    at-spi2-core \
    dbus dbus-x11 \
    # Fonts
    fonts-liberation \
    fonts-noto-color-emoji \
    # Suppress the fluxbox wallpaper nag
    x11-xserver-utils \
    # Utilities
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Node 22 from NodeSource — Debian bookworm's node 18 is below Playwright's
# floor (>= 20).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. The container is the security boundary; inside it the agent
# is free, but it is not root.
RUN useradd -m -s /bin/bash agent

# Playwright CLI globally (as root, so it lands on PATH), Chromium's system
# deps via Playwright's canonical method, then the browser itself as the
# agent user so it lives in their home.
RUN npm install -g @playwright/cli@latest \
    && rm -rf /root/.npm
RUN npx playwright install-deps chromium 2>/dev/null; rm -rf /var/lib/apt/lists/*
USER agent
WORKDIR /home/agent
# The trailing cleanup ignores root-owned droppings from the npm layer; this
# stage runs as the agent user and cannot (and need not) remove them.
RUN playwright-cli install \
    && (rm -rf /tmp/* 2>/dev/null || true)
USER root

COPY --from=build /computer-agent /usr/local/bin/computer-agent
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Fluxbox: the toad-dark theme, bottom taskbar, UTC clock — plus the
# terminal palette and the desktop wallpaper (the Toad mark on paper,
# rendered by hack/render-desktop.mjs and committed, so the image build
# needs no browser).
COPY rootfs/fluxbox /home/agent/.fluxbox
COPY rootfs/Xresources /home/agent/.Xresources
RUN chown -R agent:agent /home/agent/.fluxbox /home/agent/.Xresources
COPY rootfs/wallpaper.png /usr/share/toad/wallpaper.png

# No-op fbsetbg so fluxbox does not nag about wallpaper via xmessage.
COPY rootfs/fbsetbg /usr/local/bin/fbsetbg
RUN chmod +x /usr/local/bin/fbsetbg

# The human's browser is the agent's browser: same Chromium, same flags.
COPY rootfs/bin/toad-browser /usr/local/bin/toad-browser
RUN chmod +x /usr/local/bin/toad-browser

EXPOSE 8787 5999
USER agent
ENTRYPOINT ["/entrypoint.sh"]

# The working surface, in its own late layer so adding a small tool does not
# rebuild the browser layers above. A desktop without a terminal is a kiosk;
# a terminal without git, ripgrep, and jq is an apology. xwallpaper is the
# one image-capable root-window setter (xsetroot is solid colours only).
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    xterm \
    xwallpaper \
    git \
    ripgrep \
    jq \
    tree \
    less \
    && rm -rf /var/lib/apt/lists/*
USER agent
