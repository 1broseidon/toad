package mcptools

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	defaultLeaseDuration = 300 // seconds
	maxLeaseDuration     = 600 // seconds
)

// controlLease tracks an active human control lease for a desktop.
type controlLease struct {
	expiresAt time.Time
	timer     *time.Timer
}

var (
	leaseMu      sync.Mutex
	activeLeases = map[string]*controlLease{} // keyed by desktopKey

	// LeaseNotify is called when lease state changes.
	// Set by the dock to receive updates.
	LeaseNotify func(active bool, remaining time.Duration)
)

// leaseActive returns true and the remaining time if a control lease is active
// for the given desktop key.
func leaseActive(desktop string) (bool, time.Duration) {
	key := desktopKey(desktop)
	leaseMu.Lock()
	defer leaseMu.Unlock()
	lease, ok := activeLeases[key]
	if !ok {
		return false, 0
	}
	remaining := time.Until(lease.expiresAt)
	if remaining <= 0 {
		delete(activeLeases, key)
		return false, 0
	}
	return true, remaining
}

// humanAtScreen is set while at least one VNC client is connected. Two
// pointers on one fluxbox is how loops look like work: while a person is at
// the screen, the agent's hands wait \u2014 automatically, not by a lease anyone
// has to remember to take.
var (
	humanMu       sync.Mutex
	humansAtScreen int
)

// SetHumanAtScreen tracks VNC viewer arrivals and departures (delta \u00b11).
func SetHumanAtScreen(delta int) {
	humanMu.Lock()
	humansAtScreen += delta
	if humansAtScreen < 0 {
		humansAtScreen = 0
	}
	present := humansAtScreen > 0
	humanMu.Unlock()
	if present {
		notifyLease(true, 24*time.Hour)
	} else if active, remaining := leaseActive(""); active {
		notifyLease(true, remaining)
	} else {
		notifyLease(false, 0)
	}
}

func humanPresent() bool {
	humanMu.Lock()
	defer humanMu.Unlock()
	return humansAtScreen > 0
}

// checkLease returns an error if a human holds the desktop \u2014 by an explicit
// control lease, or simply by being connected to the screen.
func checkLease(desktop string) error {
	if humanPresent() {
		return fmt.Errorf("a human is at the screen (VNC connected) \u2014 your input waits until they disconnect; watching with capture is fine")
	}
	active, remaining := leaseActive(desktop)
	if !active {
		return nil
	}
	mins := int(remaining.Minutes())
	secs := int(remaining.Seconds()) % 60
	return fmt.Errorf("desktop under human control \u2014 lease expires in %dm %ds", mins, secs)
}

// grantLease activates a human control lease for the given desktop.
func grantLease(desktop string, duration int) (time.Time, error) {
	if duration <= 0 {
		duration = defaultLeaseDuration
	}
	if duration > maxLeaseDuration {
		return time.Time{}, fmt.Errorf("max lease duration is %d seconds", maxLeaseDuration)
	}

	key := desktopKey(desktop)
	leaseMu.Lock()
	defer leaseMu.Unlock()

	if existing, ok := activeLeases[key]; ok {
		remaining := time.Until(existing.expiresAt)
		if remaining > 0 {
			return time.Time{}, fmt.Errorf("control lease already active, expires in %ds", int(remaining.Seconds()))
		}
		existing.timer.Stop()
		delete(activeLeases, key)
	}

	dur := time.Duration(duration) * time.Second
	expiresAt := time.Now().Add(dur)

	// The lease is an advisory mutex plus a dock light — it blocks the
	// agent's mutating tools while a person drives. It deliberately does NOT
	// touch x11vnc: input policy is fixed at boot (interactive unless
	// TOAD_COMPUTER_VNC_VIEWONLY), and the vhd-era restart here killed the
	// very VNC connection the human was watching through, leaving them a
	// frozen last frame that accepted nothing.
	notifyLease(true, dur)

	timer := time.AfterFunc(dur, func() {
		releaseLease(desktop)
	})

	activeLeases[key] = &controlLease{
		expiresAt: expiresAt,
		timer:     timer,
	}

	return expiresAt, nil
}

// releaseLease ends the control lease and lets the agent's tools act again.
func releaseLease(desktop string) {
	key := desktopKey(desktop)
	leaseMu.Lock()
	lease, ok := activeLeases[key]
	if ok {
		lease.timer.Stop()
		delete(activeLeases, key)
	}
	leaseMu.Unlock()

	notifyLease(false, 0)
}

func notifyLease(active bool, remaining time.Duration) {
	if LeaseNotify != nil {
		LeaseNotify(active, remaining)
	}
}

// --- Input types ---

type ControlInput struct {
	Desktop  string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Duration int    `json:"duration,omitempty" jsonschema:"lease duration in seconds (default 300, max 600)"`
}

type ControlReleaseInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

// --- Registration ---

// RegisterControlTools adds the control and control_release tools.
func RegisterControlTools(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "control",
		Description: "Grant temporary interactive VNC control to a human. VNC is view-only by default; this enables input for the lease duration. Agent mutating actions are blocked while a lease is active.",
	}, controlHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "control_release",
		Description: "Release an active human control lease early. Restores VNC to view-only and re-enables agent actions.",
	}, controlReleaseHandler())
}

// --- Handlers ---

func controlHandler() func(context.Context, *mcp.CallToolRequest, ControlInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in ControlInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		expiresAt, err := grantLease(in.Desktop, in.Duration)
		if err != nil {
			return nil, nil, err
		}

		duration := in.Duration
		if duration <= 0 {
			duration = defaultLeaseDuration
		}

		result := map[string]any{
			"granted":    true,
			"expires_at": expiresAt.UTC().Format(time.RFC3339),
			"duration_s": duration,
		}
		data, _ := json.Marshal(result)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

func controlReleaseHandler() func(context.Context, *mcp.CallToolRequest, ControlReleaseInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in ControlReleaseInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		releaseLease(in.Desktop)

		result := map[string]any{"released": true}
		data, _ := json.Marshal(result)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}
