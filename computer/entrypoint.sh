#!/bin/bash
set -e

# UTC so the desktop clock and agent tools agree on time.
export TZ=UTC

# A restart arrives with the previous boot's droppings still in /tmp — the rw
# layer survives `docker stop` — and stale X lock files make init believe
# display :99 is taken, so it would drift to :100 and port 8788, which the
# container does not publish. This is one machine with one desktop: clear the
# runtime state (the PIDs in it mean nothing in a fresh PID namespace) and
# pin the display so the MCP port is 8787 every boot, as the contract says.
rm -rf /tmp/toad-computer /tmp/.X*-lock /tmp/.X11-unix

# A D-Bus session — required for the AT-SPI2 accessibility tree.
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS

# Start the virtual desktop (Xvfb + fluxbox + MCP server + dock).
# The pinned display comes first so an explicit `--display` in "$@" wins.
computer-agent init --display 99 "$@"

# Terminal palette and font (rootfs/Xresources) — xterm reads the resource
# database at launch, so merging once here styles every terminal after it.
display=$(cat /tmp/toad-computer/*.display 2>/dev/null | head -1)
if [ -n "$display" ] && [ -f "$HOME/.Xresources" ]; then
    xrdb -merge -display ":${display}" "$HOME/.Xresources" || true
fi

# The wallpaper is set here, once, and owned here: fluxbox runs with
# `background: none` everywhere (overlay and style), which means it never
# repaints the root window — not even via rootCommand, which is why setting
# it through fluxbox silently did nothing.
if [ -n "$display" ]; then
    DISPLAY=":${display}" xwallpaper --zoom /usr/share/toad/wallpaper.png \
        || DISPLAY=":${display}" xsetroot -solid "#040405" || true
fi

# x11vnc for the screen view. Interactive: Toad's in-app pane is the owner's
# own hands on their teammate's machine, not an unaudited side channel — the
# bearer token on /vnc means only Toad's proxy can reach it anyway. Set
# TOAD_COMPUTER_VNC_VIEWONLY=1 to run a look-but-don't-touch machine.
display=$(cat /tmp/toad-computer/*.display 2>/dev/null | head -1)
if [ -n "$display" ]; then
    vnc_args="-display :${display} -rfbport 5999 -forever -shared -quiet"
    if [ -n "$TOAD_COMPUTER_VNC_VIEWONLY" ]; then
        vnc_args="$vnc_args -viewonly"
    fi
    if [ -n "$TOAD_COMPUTER_VNC_PASSWORD" ]; then
        vnc_args="$vnc_args -passwd $TOAD_COMPUTER_VNC_PASSWORD"
    else
        vnc_args="$vnc_args -nopw"
    fi
    x11vnc $vnc_args &
fi

# init spawns everything in the background and exits; the container lives as
# long as the MCP server's log does.
log="/tmp/toad-computer/default.serve.log"

for i in $(seq 1 10); do
    [ -f "$log" ] && break
    sleep 0.5
done

echo "toad-computer ready — MCP at http://localhost:8787/mcp"

exec tail -f "$log"
