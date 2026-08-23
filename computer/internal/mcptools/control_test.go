package mcptools

import (
	"testing"
	"time"
)

func resetLease(t *testing.T) {
	t.Helper()
	clear := func() {
		leaseMu.Lock()
		if activeLease != nil {
			activeLease.timer.Stop()
			activeLease = nil
		}
		leaseMu.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

// A lease that expired but whose timer callback has not run yet must not
// clobber the successor granted in that window.
func TestExpiredLeaseTimerLeavesSuccessorAlone(t *testing.T) {
	resetLease(t)
	if _, err := grantLease("alice", 60); err != nil {
		t.Fatal(err)
	}
	leaseMu.Lock()
	stale := activeLease
	stale.timer.Stop()
	stale.expiresAt = time.Now().Add(-time.Second)
	leaseMu.Unlock()

	if _, err := grantLease("bob", 60); err != nil {
		t.Fatalf("successor refused: %v", err)
	}
	expireLease(stale) // the late callback
	holder, _, ok := leaseActive()
	if !ok || holder != "bob" {
		t.Fatalf("want bob's lease intact, got ok=%v holder=%q", ok, holder)
	}
}

func TestReleaseIsOwnerOnly(t *testing.T) {
	resetLease(t)
	if _, err := grantLease("alice", 60); err != nil {
		t.Fatal(err)
	}
	if _, err := releaseLease("mallory"); err == nil {
		t.Fatal("mallory released alice's lease")
	}
	if holder, _, ok := leaseActive(); !ok || holder != "alice" {
		t.Fatalf("lease changed by refused release: ok=%v holder=%q", ok, holder)
	}
	if released, err := releaseLease("alice"); err != nil || !released {
		t.Fatalf("owner release: released=%v err=%v", released, err)
	}
	if released, err := releaseLease("alice"); err != nil || released {
		t.Fatalf("release with nothing held should be a no-op: released=%v err=%v", released, err)
	}
}
