//go:build linux

package a11y

import (
	"testing"
	"time"
)

func TestAvailable(t *testing.T) {
	if !Available() {
		t.Skip("AT-SPI2 not available on this system")
	}
}

func TestQueryAllReturnsWithinOneSecond(t *testing.T) {
	if !Available() {
		t.Skip("AT-SPI2 not available")
	}

	start := time.Now()
	result, err := QueryAll()
	elapsed := time.Since(start)

	t.Logf("QueryAll: %d windows in %s (err=%v)", len(result), elapsed, err)

	if elapsed > 1*time.Second {
		t.Errorf("too slow: %s (want < 1s)", elapsed)
	}

	// Should find at least one window on a desktop with apps running.
	if len(result) == 0 {
		t.Error("expected at least one window with elements")
	}

	for title, elements := range result {
		t.Logf("  [%s] %d elements", title, len(elements))
		for i, e := range elements {
			if i >= 3 {
				t.Logf("    ... +%d more", len(elements)-3)
				break
			}
			t.Logf("    %s (%s) %v", e.Name, e.Role, e.Bounds)
		}
	}
}

func TestQuerySingleWindow(t *testing.T) {
	if !Available() {
		t.Skip("AT-SPI2 not available")
	}

	// Query for Brave (likely running on this machine).
	elements, err := Query("Brave")
	if err != nil {
		t.Skipf("Brave not running: %v", err)
	}

	t.Logf("Brave: %d elements", len(elements))
	if len(elements) == 0 {
		t.Error("expected elements from Brave window")
	}

	// Every element should have a name and non-zero bounds.
	for _, e := range elements {
		if e.Name == "" {
			t.Errorf("element with empty name: %+v", e)
		}
		if e.Bounds[2] == 0 && e.Bounds[3] == 0 {
			t.Errorf("element %q has zero-size bounds", e.Name)
		}
	}
}

func TestUnresponsiveAppsSkipped(t *testing.T) {
	// QueryAll must complete even if some apps on the bus don't respond.
	// This is the key reliability requirement.
	if !Available() {
		t.Skip("AT-SPI2 not available")
	}

	done := make(chan struct{})
	go func() {
		QueryAll()
		close(done)
	}()

	select {
	case <-done:
		// good
	case <-time.After(5 * time.Second):
		t.Fatal("QueryAll hung — unresponsive apps not being skipped")
	}
}
