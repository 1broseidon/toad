//go:build linux

package dbus

import (
	"testing"
)

func TestConnectAndHello(t *testing.T) {
	conn, err := Connect("unix:path=/run/user/1000/at-spi/bus_1")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer conn.Close()

	if conn.unique == "" {
		t.Error("expected non-empty unique name after Hello")
	}
	t.Logf("unique name: %s", conn.unique)
}

func TestCallMethodOnRegistry(t *testing.T) {
	conn, err := Connect("unix:path=/run/user/1000/at-spi/bus_1")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer conn.Close()

	body, sig, err := conn.Call(
		"org.a11y.atspi.Registry",
		"/org/a11y/atspi/accessible/root",
		"org.a11y.atspi.Accessible",
		"GetChildren",
		"", nil,
	)
	if err != nil {
		t.Fatalf("GetChildren: %v", err)
	}
	if sig != "a(so)" {
		t.Errorf("unexpected sig: %q", sig)
	}
	if len(body) == 0 {
		t.Error("expected non-empty body")
	}
	t.Logf("GetChildren: %d bytes, sig=%q", len(body), sig)
}
