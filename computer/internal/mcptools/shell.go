package mcptools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	defaultExecCWD       = "/home/agent"
	defaultExecTimeout   = 30
	maxExecTimeout       = 60
	defaultExecMaxOutput = 65536
	maxExecMaxOutput     = 1048576
)

type ExecInput struct {
	Desktop   string   `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Command   string   `json:"command" jsonschema:"command to run, e.g. ls, python3, bash -c '...'"`
	Args      []string `json:"args,omitempty" jsonschema:"optional command arguments"`
	Cwd       string   `json:"cwd,omitempty" jsonschema:"working directory (default /home/agent)"`
	Timeout   int      `json:"timeout,omitempty" jsonschema:"max seconds to wait (default 30, max 60)"`
	MaxOutput int      `json:"max_output,omitempty" jsonschema:"max bytes captured per stream (default 65536, max 1048576)"`
}

type ExecResult struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exit_code"`
	DurationMS int64  `json:"duration_ms"`
	Truncated  bool   `json:"truncated"`
}

func execHandler() func(context.Context, *mcp.CallToolRequest, ExecInput) (*mcp.CallToolResult, ExecResult, error) {
	return func(ctx context.Context, req *mcp.CallToolRequest, in ExecInput) (*mcp.CallToolResult, ExecResult, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, ExecResult{}, err
		}
		if in.Command == "" {
			return nil, ExecResult{}, fmt.Errorf("command is required")
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, ExecResult{}, err
		}
		defer unlock()

		result, err := executeExec(ctx, in)
		if err != nil {
			result.Stderr = err.Error()
			if result.ExitCode == 0 {
				result.ExitCode = 255
			}
		}
		return nil, result, nil
	}
}

func executeExec(ctx context.Context, in ExecInput) (ExecResult, error) {
	if in.Command == "" {
		return ExecResult{}, fmt.Errorf("command is required")
	}

	cwd := in.Cwd
	if cwd == "" {
		cwd = defaultExecCWD
	}

	timeout := in.Timeout
	if timeout <= 0 {
		timeout = defaultExecTimeout
	}
	if timeout > maxExecTimeout {
		timeout = maxExecTimeout
	}

	maxOutput := in.MaxOutput
	if maxOutput <= 0 {
		maxOutput = defaultExecMaxOutput
	}
	if maxOutput > maxExecMaxOutput {
		maxOutput = maxExecMaxOutput
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, in.Command, in.Args...)
	cmd.Dir = cwd

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	runErr := cmd.Run()
	durationMS := time.Since(start).Milliseconds()

	if runErr != nil && cmd.ProcessState == nil && stderr.Len() == 0 {
		stderr.WriteString(runErr.Error())
	}

	stdoutText, stdoutTruncated := truncateExecOutput(stdout.Bytes(), maxOutput)
	stderrText, stderrTruncated := truncateExecOutput(stderr.Bytes(), maxOutput)

	result := ExecResult{
		Stdout:     stdoutText,
		Stderr:     stderrText,
		ExitCode:   -1,
		DurationMS: durationMS,
		Truncated:  stdoutTruncated || stderrTruncated,
	}
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	}

	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return result, fmt.Errorf("exec timed out after %ds", timeout)
	}

	var exitErr *exec.ExitError
	if runErr != nil && !errors.As(runErr, &exitErr) {
		return result, runErr
	}
	return result, nil
}

func truncateExecOutput(data []byte, maxOutput int) (string, bool) {
	if len(data) <= maxOutput {
		return string(data), false
	}
	return string(data[:maxOutput]), true
}
