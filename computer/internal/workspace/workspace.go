// Package workspace manages the agent's virtual headless display (Xvfb).
package workspace

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	configDir     = "/tmp/toad-computer"
	defaultWidth  = 1920
	defaultHeight = 1080
	defaultDepth  = 24
	pinDisplay    = 99
)

func displayFile() string  { return filepath.Join(configDir, "default.display") }
func pidFilePath() string  { return filepath.Join(configDir, "default.pid") }
func servePidFile() string { return filepath.Join(configDir, "default.serve.pid") }

// Display returns the DISPLAY string (e.g. ":99") if Xvfb is running.
func Display() string {
	data, err := os.ReadFile(displayFile())
	if err != nil {
		return ""
	}
	d := strings.TrimSpace(string(data))
	if d == "" || !xvfbAlive() {
		return ""
	}
	return ":" + d
}

// SetDisplay sets DISPLAY so child tools (xdotool, etc.) target this machine.
func SetDisplay() error {
	d := Display()
	if d == "" {
		return fmt.Errorf("agent display not running (run computer-agent init)")
	}
	return os.Setenv("DISPLAY", d)
}

// Init starts Xvfb on :99 (or --display N), fluxbox, and the MCP server.
func Init(opts ...string) error {
	forcedDisplay := pinDisplay
	for i := 0; i < len(opts)-1; i++ {
		if opts[i] == "--display" {
			n, err := strconv.Atoi(opts[i+1])
			if err != nil {
				return fmt.Errorf("--display must be an integer")
			}
			forcedDisplay = n
		}
	}

	if d := Display(); d != "" {
		fmt.Printf("\n  toad.computer already running on DISPLAY=%s\n\n", d)
		return nil
	}

	if _, err := exec.LookPath("Xvfb"); err != nil {
		return fmt.Errorf("xvfb not found (install xvfb)")
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}

	num := forcedDisplay
	screen := fmt.Sprintf("%dx%dx%d", defaultWidth, defaultHeight, defaultDepth)
	cmd := exec.Command("Xvfb", fmt.Sprintf(":%d", num),
		"-screen", "0", screen,
		"-nolisten", "tcp",
		"-ac",
	)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Xvfb: %w", err)
	}

	os.WriteFile(displayFile(), []byte(strconv.Itoa(num)), 0o600)
	os.WriteFile(pidFilePath(), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)

	display := fmt.Sprintf(":%d", num)
	if err := waitForDisplay(display); err != nil {
		cmd.Process.Kill()
		os.Remove(displayFile())
		os.Remove(pidFilePath())
		return err
	}

	startWM(display)
	startServe(display, 8787)

	fmt.Printf("\n  toad.computer\n\n")
	fmt.Printf("  Display:    %s\n", display)
	fmt.Printf("  Resolution: %dx%d\n", defaultWidth, defaultHeight)
	fmt.Printf("  MCP:        http://localhost:8787/mcp\n")
	fmt.Println()
	return nil
}

func startWM(display string) {
	wmPath, err := exec.LookPath("fluxbox")
	if err != nil {
		wmPath, err = exec.LookPath("openbox")
	}
	if err != nil {
		return
	}
	wm := exec.Command(wmPath)
	wm.Env = append(os.Environ(), "DISPLAY="+display)
	wm.Stdout = nil
	wm.Stderr = nil
	wm.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := wm.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: window manager failed to start: %v\n", err)
	}
}

func startServe(display string, port int) {
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "  warning: cannot find own binary: %v\n", err)
		return
	}
	if resolved, e := filepath.EvalSymlinks(self); e == nil {
		self = resolved
	}
	logPath := filepath.Join(configDir, "default.serve.log")
	logFile, _ := os.Create(logPath)
	serve := exec.Command(self, "serve", "--port", strconv.Itoa(port))
	serve.Env = append(os.Environ(), "DISPLAY="+display)
	serve.Stdout = logFile
	serve.Stderr = logFile
	serve.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := serve.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: MCP server failed to start: %v\n", err)
	} else {
		os.WriteFile(servePidFile(), []byte(strconv.Itoa(serve.Process.Pid)), 0o600)
	}
}

// Exec runs a command on the agent's display, injecting app-specific flags.
func Exec(args []string) error {
	d := Display()
	if d == "" {
		return fmt.Errorf("agent display not running (run computer-agent init)")
	}
	if len(args) == 0 {
		return fmt.Errorf("command is required")
	}

	env := append(os.Environ(), "DISPLAY="+d)
	apps := LoadApps()
	if ac, ok := apps.Lookup(args[0]); ok {
		args = ac.InjectArgs(args)
		env = ac.InjectEnv(env)
	}

	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("exec: %w", err)
	}
	fmt.Printf("  Started %s (pid %d) on %s\n", args[0], cmd.Process.Pid, d)
	return nil
}

func waitForDisplay(display string) error {
	numStr := strings.TrimPrefix(display, ":")
	sock := fmt.Sprintf("/tmp/.X11-unix/X%s", numStr)
	for range 50 {
		if _, err := os.Stat(sock); err == nil {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("xvfb failed to start (no socket at %s after 2.5s)", sock)
}

func xvfbAlive() bool {
	data, err := os.ReadFile(pidFilePath())
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}
