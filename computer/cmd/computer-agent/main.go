// computer-agent: the daemon inside a Toad computer.
// Serves the MCP tools over HTTP, manages the virtual display, and bridges
// VNC connections.
//
// Usage (called by entrypoint.sh, not directly by users):
//
//	computer-agent init [--name NAME] [--display N] [--res WxH]
//	computer-agent serve [--port PORT]
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	var err error
	switch os.Args[1] {
	case "init":
		err = runInit(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	default:
		usage()
		os.Exit(1)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: computer-agent <command> [args]

commands:
  init [--name NAME] [--display N] [--res WxH]   initialize virtual display and window manager
  serve [--port PORT]                             start MCP HTTP server (default: 8787)`)
}
