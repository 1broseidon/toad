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
	defaultLeaseDuration = 300
	maxLeaseDuration     = 600
)

type controlLease struct {
	holder    string
	expiresAt time.Time
	timer     *time.Timer
}

var (
	leaseMu     sync.Mutex
	activeLease *controlLease

	// LeaseNotify is called when lease state changes. The dock sets this.
	LeaseNotify func(active bool, remaining time.Duration)
)

func leaseActive() (holder string, remaining time.Duration, ok bool) {
	leaseMu.Lock()
	defer leaseMu.Unlock()
	if activeLease == nil {
		return "", 0, false
	}
	remaining = time.Until(activeLease.expiresAt)
	if remaining <= 0 {
		// Expired; its timer clears it and tells the dock.
		return "", 0, false
	}
	return activeLease.holder, remaining, true
}

var (
	humanMu        sync.Mutex
	humansAtScreen int
)

// SetHumanAtScreen tracks VNC viewer arrivals and departures (delta ±1).
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
	} else if _, remaining, ok := leaseActive(); ok {
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

func checkLease() error {
	if humanPresent() {
		return fmt.Errorf("a human is at the screen (VNC connected) — your input waits until they disconnect; watching with capture is fine")
	}
	holder, remaining, ok := leaseActive()
	if !ok {
		return nil
	}
	mins := int(remaining.Minutes())
	secs := int(remaining.Seconds()) % 60
	if holder == "" {
		holder = "a human"
	}
	return fmt.Errorf("machine under %s's control — lease expires in %dm %ds", holder, mins, secs)
}

func grantLease(holder string, duration int) (time.Time, error) {
	if holder == "" {
		holder = "human"
	}
	if duration <= 0 {
		duration = defaultLeaseDuration
	}
	if duration > maxLeaseDuration {
		return time.Time{}, fmt.Errorf("max lease duration is %d seconds", maxLeaseDuration)
	}

	leaseMu.Lock()
	defer leaseMu.Unlock()

	if activeLease != nil {
		remaining := time.Until(activeLease.expiresAt)
		if remaining > 0 {
			who := activeLease.holder
			if who == "" {
				who = "another caller"
			}
			return time.Time{}, fmt.Errorf("control lease already held by %s, expires in %ds", who, int(remaining.Seconds()))
		}
		activeLease.timer.Stop()
		activeLease = nil
	}

	dur := time.Duration(duration) * time.Second
	lease := &controlLease{holder: holder, expiresAt: time.Now().Add(dur)}
	// The timer clears only the lease it was armed for: a successor granted in
	// the window between expiry and the callback must not be clobbered.
	lease.timer = time.AfterFunc(dur, func() { expireLease(lease) })
	activeLease = lease
	notifyLease(true, dur)
	return lease.expiresAt, nil
}

func expireLease(lease *controlLease) {
	leaseMu.Lock()
	if activeLease != lease {
		leaseMu.Unlock()
		return
	}
	activeLease = nil
	leaseMu.Unlock()
	notifyLease(false, 0)
}

// releaseLease ends the lease if holder owns it. Nothing held is a no-op;
// someone else's lease is refused by name.
func releaseLease(holder string) (released bool, err error) {
	leaseMu.Lock()
	lease := activeLease
	if lease == nil || time.Until(lease.expiresAt) <= 0 {
		leaseMu.Unlock()
		return false, nil
	}
	if lease.holder != holder {
		leaseMu.Unlock()
		return false, fmt.Errorf("control lease is held by %s — only the holder can release it", lease.holder)
	}
	lease.timer.Stop()
	activeLease = nil
	leaseMu.Unlock()
	notifyLease(false, 0)
	return true, nil
}

func notifyLease(active bool, remaining time.Duration) {
	if LeaseNotify != nil {
		LeaseNotify(active, remaining)
	}
}

type ControlInput struct {
	Duration int `json:"duration,omitempty" jsonschema:"lease duration in seconds (default 300, max 600)"`
}

type ControlReleaseInput struct{}

func controlHandler() func(context.Context, *mcp.CallToolRequest, ControlInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in ControlInput) (*mcp.CallToolResult, any, error) {
		holder := holderOf(nil, req)
		expiresAt, err := grantLease(holder, in.Duration)
		if err != nil {
			return nil, nil, err
		}
		duration := in.Duration
		if duration <= 0 {
			duration = defaultLeaseDuration
		}
		result := map[string]any{
			"granted":    true,
			"holder":     holder,
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
	return func(_ context.Context, req *mcp.CallToolRequest, _ ControlReleaseInput) (*mcp.CallToolResult, any, error) {
		holder := holderOf(nil, req)
		released, err := releaseLease(holder)
		if err != nil {
			return nil, nil, err
		}
		result := map[string]any{"released": released, "holder": holder}
		if !released {
			result["detail"] = "no control lease was held"
		}
		data, _ := json.Marshal(result)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}
