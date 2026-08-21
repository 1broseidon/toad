// Package workspace manages the agent's virtual headless desktop (Xvfb).
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
	configDir = "/tmp/toad-computer"

	defaultWidth  = 1920
	defaultHeight = 1080
	defaultDepth  = 24
	startDisplay  = 99 // first display number to try
)

// displayFile and pidFile are derived from the desktop name.
// The default desktop is "default"; init --name creates a named one.
func displayFile(name string) string  { return fmt.Sprintf("%s/%s.display", configDir, name) }
func pidFilePath(name string) string  { return fmt.Sprintf("%s/%s.pid", configDir, name) }
func servePidFile(name string) string { return fmt.Sprintf("%s/%s.serve.pid", configDir, name) }

// ActiveName returns the desktop name to use, checking TOAD_COMPUTER_DESKTOP env then falling back to "default".
func ActiveName() string {
	if n := os.Getenv("TOAD_COMPUTER_DESKTOP"); n != "" {
		return n
	}
	return "default"
}

// extractName pulls --name from args, returning the name and remaining args.
func extractName(args []string) (string, []string) {
	name := ActiveName()
	var rest []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--name" && i+1 < len(args) {
			name = args[i+1]
			i++
		} else {
			rest = append(rest, args[i])
		}
	}
	return name, rest
}

// Display returns the DISPLAY string (e.g. ":99") if the agent desktop is running,
// or empty string if not configured.
func Display() string {
	return DisplayFor(ActiveName())
}

// DisplayFor returns the DISPLAY string for a named desktop, or empty if not running.
func DisplayFor(name string) string {
	data, err := os.ReadFile(displayFile(name))
	if err != nil {
		return ""
	}
	d := strings.TrimSpace(string(data))
	if d == "" {
		return ""
	}
	if !xvfbAliveFor(name) {
		return ""
	}
	return ":" + d
}

// Configured returns the workspace index for backward compat. Returns -1 if not running.
// In Xvfb mode this is always 0 (there's only one desktop).
func Configured() int {
	if Display() != "" {
		return 0
	}
	return -1
}

// SetDisplay sets DISPLAY in the current process so all child tools (xdotool, etc.)
// target the agent's virtual desktop.
func SetDisplay() error {
	d := Display()
	if d == "" {
		return fmt.Errorf("agent desktop not running (run computer-agent init)")
	}
	return os.Setenv("DISPLAY", d)
}

// Init starts a new Xvfb virtual desktop for the agent.
// Init starts a new Xvfb virtual desktop. Options: --name NAME, --display NUM.
func Init(opts ...string) error {
	name := ActiveName()
	forcedDisplay := -1
	for i := 0; i < len(opts)-1; i++ {
		switch opts[i] {
		case "--name":
			name = opts[i+1]
		case "--display":
			n, err := strconv.Atoi(opts[i+1])
			if err != nil {
				return fmt.Errorf("--display must be an integer")
			}
			forcedDisplay = n
		}
	}

	if d := DisplayFor(name); d != "" {
		fmt.Printf("\n  Agent desktop %q already running on DISPLAY=%s\n\n", name, d)
		return nil
	}

	if _, err := exec.LookPath("Xvfb"); err != nil {
		return fmt.Errorf("xvfb not found (install xvfb)")
	}

	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}

	num := forcedDisplay
	if num < 0 {
		num = findFreeDisplay()
	}
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

	os.WriteFile(displayFile(name), []byte(strconv.Itoa(num)), 0o600)
	os.WriteFile(pidFilePath(name), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)

	display := fmt.Sprintf(":%d", num)
	if err := waitForDisplay(display); err != nil {
		cmd.Process.Kill()
		os.Remove(displayFile(name))
		os.Remove(pidFilePath(name))
		return err
	}

	startWM(display)

	port := 8787 + num - startDisplay
	startServe(name, display, port)

	fmt.Printf("\n  toad computer\n\n")
	fmt.Printf("  Name:       %s\n", name)
	fmt.Printf("  Display:    %s\n", display)
	fmt.Printf("  Resolution: %dx%d\n", defaultWidth, defaultHeight)
	fmt.Printf("  MCP:        http://localhost:%d/mcp\n", port)
	fmt.Println()
	return nil
}

// startWM launches a lightweight window manager on the given display.
func startWM(display string) {
	wmPath, err := exec.LookPath("fluxbox")
	if err != nil {
		// Fall back to openbox for local installs.
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

// startServe launches the MCP server + dock as a background process.
func startServe(name, display string, port int) {
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "  warning: cannot find own binary: %v\n", err)
		return
	}
	if resolved, e := filepath.EvalSymlinks(self); e == nil {
		self = resolved
	}
	logPath := fmt.Sprintf("%s/%s.serve.log", configDir, name)
	logFile, _ := os.Create(logPath)
	serve := exec.Command(self, "serve", "--port", strconv.Itoa(port))
	serve.Env = append(os.Environ(), "DISPLAY="+display)
	serve.Stdout = logFile
	serve.Stderr = logFile
	serve.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := serve.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "  warning: MCP server failed to start: %v\n", err)
	} else {
		os.WriteFile(servePidFile(name), []byte(strconv.Itoa(serve.Process.Pid)), 0o600)
	}
}

// Stop kills the Xvfb and MCP server processes and cleans up config. Accepts optional --name.
func Stop(opts ...string) error {
	name, _ := extractName(opts)
	pid := readPid(name)
	if pid <= 0 {
		return fmt.Errorf("no agent desktop running")
	}

	// Kill MCP server first.
	killPidFile(servePidFile(name))

	// Kill Xvfb.
	proc, err := os.FindProcess(pid)
	if err != nil {
		cleanup(name)
		return nil
	}

	if err := proc.Signal(syscall.SIGTERM); err != nil {
		cleanup(name)
		return nil
	}

	done := make(chan struct{})
	go func() {
		proc.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		proc.Kill()
	}

	cleanup(name)
	fmt.Println("  Agent desktop stopped.")
	return nil
}

// Exec runs a command on the agent's virtual display.
// App-specific flags and environment are injected automatically based on
// the app config (built-in defaults, toad-apps.json, ~/.config/toad-computer/apps.json).
func Exec(args []string) error {
	name, args := extractName(args)
	d := DisplayFor(name)
	if d == "" {
		return fmt.Errorf("agent desktop %q not running (run computer-agent init)", name)
	}

	env := append(os.Environ(), "DISPLAY="+d)

	// Inject app-specific flags and env from config.
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

// MoveWindow is no longer needed with Xvfb (all windows are on the agent display).
// Kept as a no-op for now.
func MoveWindow(windowID string) error {
	return fmt.Errorf("bring is not needed with virtual display (launch apps with the shell tool)")
}

// List returns all active desktops.
func List() ([]DesktopInfo, error) {
	entries, err := os.ReadDir(configDir)
	if err != nil {
		return nil, nil // no /tmp/toad-computer yet
	}
	var desktops []DesktopInfo
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".display") {
			continue
		}
		name = strings.TrimSuffix(name, ".display")
		d := DisplayFor(name)
		if d == "" {
			continue // stale file, xvfb dead
		}
		desktops = append(desktops, DesktopInfo{Name: name, Display: d})
	}
	return desktops, nil
}

// DesktopInfo describes a running virtual desktop.
type DesktopInfo struct {
	Name    string
	Display string
}

// findFreeDisplay finds an unused display number starting from startDisplay.
func findFreeDisplay() int {
	for num := startDisplay; num < startDisplay+100; num++ {
		lockFile := fmt.Sprintf("/tmp/.X%d-lock", num)
		if _, err := os.Stat(lockFile); os.IsNotExist(err) {
			return num
		}
	}
	return startDisplay
}

// waitForDisplay polls for the X11 socket to appear.
func waitForDisplay(display string) error {
	numStr := strings.TrimPrefix(display, ":")
	sock := fmt.Sprintf("/tmp/.X11-unix/X%s", numStr)

	for i := range 50 {
		_ = i
		if _, err := os.Stat(sock); err == nil {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("xvfb failed to start (no socket at %s after 2.5s)", sock)
}

func xvfbAliveFor(name string) bool {
	pid := readPid(name)
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

func readPid(name string) int {
	data, err := os.ReadFile(pidFilePath(name))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return pid
}

func killPidFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	if pid > 0 {
		if proc, err := os.FindProcess(pid); err == nil {
			proc.Signal(syscall.SIGTERM)
		}
	}
	os.Remove(path)
}

func cleanup(name string) {
	os.Remove(displayFile(name))
	os.Remove(pidFilePath(name))
	os.Remove(servePidFile(name))
}

// View opens a live view of a desktop by name.
// Resolution order: local remotes.json → cloud API (by name).
func View(args ...string) error {
	// Support legacy --remote flag: convert to positional.
	var name string
	for i := 0; i < len(args); i++ {
		if args[i] == "--remote" && i+1 < len(args) {
			name = args[i+1]
			i++
		} else if args[i] == "--name" && i+1 < len(args) {
			name = args[i+1]
			i++
		} else if name == "" {
			name = args[i]
		}
	}

	if name == "" {
		return fmt.Errorf("usage: view <desktop-name>")
	}

	// Check local remotes registry (docker, managed, manual).
	remotes := LoadRemotes()
	if _, ok := remotes[name]; ok {
		return viewRemote(name)
	}

	// Check cloud desktops by server-side name.
	if creds, err := LoadCredentials(); err == nil {
		if desktops, err := CloudList(creds); err == nil {
			for _, d := range desktops {
				dname := d.Name
				if dname == "" {
					dname = d.ID
				}
				if dname == name && d.Status == "running" {
					mcpURL := creds.Endpoint + "/api/v1/desktops/" + d.ID + "/mcp"
					return viewManaged(name, Remote{
						MCP:     mcpURL,
						Token:   creds.Token,
						Managed: true,
					})
				}
			}
		}
	}

	return fmt.Errorf("desktop %q not found", name)
}

// viewRemote connects a VNC viewer to a remote desktop's VNC endpoint.
// For managed (vhd.io) remotes, tunnels VNC through the authenticated API WebSocket.
func viewRemote(name string) error {
	remotes := LoadRemotes()
	remote, ok := remotes[name]
	if !ok {
		return fmt.Errorf("remote %q not found", name)
	}

	// Managed remotes: tunnel through WebSocket.
	if remote.Managed {
		return viewManaged(name, remote)
	}

	if remote.VNC == "" {
		return fmt.Errorf("remote %q has no VNC endpoint (re-add with --vnc-port or ensure x11vnc is running)", name)
	}

	viewerPath, err := exec.LookPath("vncviewer")
	if err != nil {
		return fmt.Errorf("vncviewer not found (install tigervnc-viewer or similar)")
	}

	viewer := exec.Command(viewerPath, remote.VNC)
	viewer.Stdout = os.Stdout
	viewer.Stderr = os.Stderr
	viewer.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := viewer.Start(); err != nil {
		return fmt.Errorf("start vncviewer: %w", err)
	}

	fmt.Printf("  Viewing remote %q at %s\n", name, remote.VNC)
	return nil
}

// SwitchTo is a no-op in Xvfb mode (there's only one desktop).
func SwitchTo(index int) error {
	return nil
}

// Save persists display config. Kept for interface compat.
func Save(index int) error {
	return nil
}
