package main

import (
	"crypto/subtle"
	"fmt"
	"image/png"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"toad.sh/computer/internal/dock"
	"toad.sh/computer/internal/mcptools"
	"toad.sh/computer/internal/platform"
	"toad.sh/computer/internal/screenshot"
	"toad.sh/computer/internal/vnc"
	"toad.sh/computer/internal/workspace"
)

func runServe(args []string) error {
	port := 8787
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--port" {
			n, err := strconv.Atoi(args[i+1])
			if err != nil {
				return fmt.Errorf("--port must be an integer")
			}
			port = n
		}
	}

	// Ensure the agent display is active.
	if err := workspace.SetDisplay(); err != nil {
		return err
	}

	p, err := platform.New()
	if err != nil {
		return err
	}

	// Start the status dock on the virtual display.
	statusDock, err := dock.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: dock failed to start: %v\n", err)
	}

	// Wire dock lease notifications so the status bar shows control state.
	if statusDock != nil {
		mcptools.LeaseNotify = statusDock.SetLeaseState
	}

	server := mcp.NewServer(
		&mcp.Implementation{Name: "toad-computer", Version: "0.1.0"},
		nil,
	)
	// The grouped surface (eight nouns) is the contract; the vhd-era granular
	// surface (fifty verbs) stays behind an env flag for debugging and for
	// callers written against the old names.
	if os.Getenv("TOAD_COMPUTER_GRANULAR_TOOLS") != "" {
		mcptools.Register(server, p)
		mcptools.RegisterFileTools(server)
		mcptools.RegisterBrowserTools(server)
		mcptools.RegisterControlTools(server)
		mcptools.RegisterStateTools(server)
		mcptools.RegisterSnapshotTools(server)
	} else {
		mcptools.RegisterGrouped(server, p)
	}

	handler := mcp.NewStreamableHTTPHandler(
		func(r *http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true},
	)

	addr := fmt.Sprintf(":%d", port)
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcptools.RunQueueMiddleware(mcptools.GatewayMiddleware(handler)))
	mux.Handle("/files/", mcptools.FileHandler())

	// WebSocket-to-VNC bridge for noVNC viewers.
	// Derive VNC port from display number.
	vncPort := 5999
	if n, err := strconv.Atoi(strings.TrimPrefix(workspace.Display(), ":")); err == nil {
		vncPort = 5900 + n
	}
	vncAddr := fmt.Sprintf("127.0.0.1:%d", vncPort)
	vncHandler := vnc.Handler(vncAddr)
	mux.Handle("/vnc", vncHandler)

	// One PNG of the desktop as it looks right now, for Toad's computer
	// drawer. Cheaper than a VNC session when all the user wants is a glance,
	// and behind the same bearer token as everything else.
	mux.HandleFunc("/screenshot", func(w http.ResponseWriter, r *http.Request) {
		img, err := screenshot.Capture()
		if err != nil {
			http.Error(w, fmt.Sprintf("capture: %v", err), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		if err := png.Encode(w, img); err != nil {
			log.Printf("screenshot encode: %v", err)
		}
	})

	// Health check for Docker/load balancers.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// Info endpoint: advertise display and VNC port for remote discovery.
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		display := workspace.Display()
		vncPort := 5999
		numStr := strings.TrimPrefix(display, ":")
		if n, err := strconv.Atoi(numStr); err == nil {
			vncPort = 5900 + n
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"display":%q,"vnc_port":%d}`, display, vncPort)
	})

	fmt.Fprintf(os.Stderr, "computer-agent MCP server listening on %s\n", addr)
	fmt.Fprintf(os.Stderr, "  MCP endpoint: http://localhost%s/mcp\n", addr)
	fmt.Fprintf(os.Stderr, "  Health:       http://localhost%s/health\n", addr)
	if statusDock != nil {
		fmt.Fprintf(os.Stderr, "  Dock:         active on %s\n", os.Getenv("DISPLAY"))
	}

	log.Fatal(http.ListenAndServe(addr, tokenAuth(mux)))
	return nil
}

// tokenAuth requires `Authorization: Bearer $TOAD_COMPUTER_TOKEN` on every
// route except /health, which stays open so an orchestrator can probe
// readiness without holding the secret. With the env unset all requests pass:
// that is the bare `docker run` developer case, where the port binding
// (127.0.0.1) is the only caller anyway. Toad always sets the token.
func tokenAuth(next http.Handler) http.Handler {
	token := os.Getenv("TOAD_COMPUTER_TOKEN")
	if token == "" {
		return next
	}
	expect := "Bearer " + token
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expect)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
