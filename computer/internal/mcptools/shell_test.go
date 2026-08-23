package mcptools

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func needBash(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not on PATH")
	}
}

// A command that exits after leaving a grandchild holding stdout must return
// promptly with its own exit status, not block until the grandchild is done.
func TestExecReturnsWhenGrandchildHoldsStdout(t *testing.T) {
	needBash(t)
	start := time.Now()
	res, err := executeExec(context.Background(), ExecInput{
		Command: "bash", Args: []string{"-c", "sleep 5 & exit 0"}, Cwd: t.TempDir(), Timeout: 3,
	})
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d, want 0", res.ExitCode)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("took %s; Wait stalled on the grandchild's pipe", took)
	}
}

func TestExecTimeoutKillsTheTree(t *testing.T) {
	needBash(t)
	start := time.Now()
	_, err := executeExec(context.Background(), ExecInput{
		Command: "bash", Args: []string{"-c", "sleep 30 & sleep 30"}, Cwd: t.TempDir(), Timeout: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("want timeout error, got %v", err)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("took %s after a 1s timeout", took)
	}
}
