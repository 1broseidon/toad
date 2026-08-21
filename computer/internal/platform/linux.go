//go:build linux

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// LinuxPlatform implements Platform using xdotool and wmctrl.
type LinuxPlatform struct{}

// ListWindows enumerates visible windows using xdotool.
// We use xdotool exclusively because its coordinate space matches mousemove/click.
// wmctrl uses a different coordinate space on some compositors (e.g. Mutter reports 2x positions).
func (p *LinuxPlatform) ListWindows() ([]Window, error) {
	if err := requireTool("xdotool"); err != nil {
		return nil, err
	}
	return listWindowsXdotool()
}

func listWindowsXdotool() ([]Window, error) {
	out, err := exec.Command("xdotool", "search", "--onlyvisible", "--name", "").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("xdotool search: %s", strings.TrimSpace(string(out)))
	}
	ids := strings.Fields(strings.TrimSpace(string(out)))
	var windows []Window
	for _, id := range ids {
		w, err := xdotoolWindowInfo(id)
		if err != nil {
			continue // skip windows we cannot query
		}
		// Skip unnamed windows (root window, hidden helpers).
		if w.Title == "" {
			continue
		}
		windows = append(windows, w)
	}
	return windows, nil
}

func xdotoolWindowInfo(id string) (Window, error) {
	nameOut, err := exec.Command("xdotool", "getwindowname", id).CombinedOutput()
	if err != nil {
		return Window{}, err
	}
	geoOut, err := exec.Command("xdotool", "getwindowgeometry", "--shell", id).CombinedOutput()
	if err != nil {
		return Window{}, err
	}
	x, y, w, h := parseXdotoolGeometry(string(geoOut))
	return Window{
		ID:     id,
		Title:  strings.TrimSpace(string(nameOut)),
		Bounds: [4]int{x, y, w, h},
	}, nil
}

func parseXdotoolGeometry(output string) (x, y, w, h int) {
	for _, line := range strings.Split(output, "\n") {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		val, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
		switch strings.TrimSpace(parts[0]) {
		case "X":
			x = val
		case "Y":
			y = val
		case "WIDTH":
			w = val
		case "HEIGHT":
			h = val
		}
	}
	return
}

// Click moves the mouse to (x, y) and clicks.
func (p *LinuxPlatform) Click(x, y int) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	return run("xdotool", "mousemove", "--sync", strconv.Itoa(x), strconv.Itoa(y), "click", "1")
}

// DoubleClick moves the mouse to (x, y) and double-clicks.
func (p *LinuxPlatform) DoubleClick(x, y int) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	return run("xdotool", "mousemove", "--sync", strconv.Itoa(x), strconv.Itoa(y), "click", "--repeat", "2", "--delay", "50", "1")
}

// RightClick moves the mouse to (x, y) and right-clicks.
func (p *LinuxPlatform) RightClick(x, y int) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	return run("xdotool", "mousemove", "--sync", strconv.Itoa(x), strconv.Itoa(y), "click", "3")
}

// Drag moves the mouse from (x1, y1) to (x2, y2) while holding the left button.
func (p *LinuxPlatform) Drag(x1, y1, x2, y2 int) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	if err := run("xdotool", "mousemove", "--sync", strconv.Itoa(x1), strconv.Itoa(y1)); err != nil {
		return err
	}
	if err := run("xdotool", "mousedown", "1"); err != nil {
		return err
	}
	if err := run("xdotool", "mousemove", "--sync", strconv.Itoa(x2), strconv.Itoa(y2)); err != nil {
		return err
	}
	return run("xdotool", "mouseup", "1")
}

// Move moves the mouse to (x, y) without clicking.
func (p *LinuxPlatform) Move(x, y int) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	return run("xdotool", "mousemove", "--sync", strconv.Itoa(x), strconv.Itoa(y))
}

// Scroll moves the mouse to (x, y) and scrolls. Positive clicks = up, negative = down.
func (p *LinuxPlatform) Scroll(x, y, clicks int) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	// xdotool: button 4 = scroll up, button 5 = scroll down
	button := "5"
	n := clicks
	if clicks > 0 {
		button = "4"
	} else {
		n = -clicks
	}
	if err := run("xdotool", "mousemove", "--sync", strconv.Itoa(x), strconv.Itoa(y)); err != nil {
		return err
	}
	for range n {
		if err := run("xdotool", "click", button); err != nil {
			return err
		}
	}
	return nil
}

// Type types a string with zero inter-key delay.
func (p *LinuxPlatform) Type(text string) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	return run("xdotool", "type", "--delay", "0", text)
}

// Key sends a key combination.
func (p *LinuxPlatform) Key(combo string) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	return run("xdotool", "key", combo)
}

// Paste sets the X clipboard to text and sends Ctrl+V.
// xclip daemonizes to serve the selection — we start it, wait for it to
// read stdin, then send the keystroke. The daemon stays alive indefinitely
// until another process claims the clipboard.
func (p *LinuxPlatform) Paste(text string) error {
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	if err := requireTool("xclip"); err != nil {
		return fmt.Errorf("xclip required for paste")
	}

	// Write to temp file and let xclip read it via shell redirect.
	// This avoids Go pipe lifetime issues — the shell handles the pipe,
	// and xclip's daemon inherits no Go-managed file descriptors.
	f, err := os.CreateTemp("", "vhd-clip-*")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	name := f.Name()
	defer os.Remove(name)
	f.WriteString(text)
	f.Close()

	// Shell redirects file to xclip stdin. The shell exits once xclip
	// has read stdin and forked its daemon — CombinedOutput returns.
	cmd := exec.Command("bash", "-c", "xclip -selection clipboard < "+name)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("xclip: %w", err)
	}

	// Send Ctrl+V — the target app requests the selection from xclip daemon.
	return run("xdotool", "key", "--clearmodifiers", "ctrl+v")
}

// GetClipboard reads text from the X clipboard.
func (p *LinuxPlatform) GetClipboard() (string, error) {
	if err := requireTool("xclip"); err != nil {
		return "", fmt.Errorf("xclip required for clipboard read")
	}
	out, err := exec.Command("xclip", "-selection", "clipboard", "-o").Output()
	if err != nil {
		return "", fmt.Errorf("xclip: %w", err)
	}
	return string(out), nil
}

// SetClipboard writes text to the X clipboard without pasting.
func (p *LinuxPlatform) SetClipboard(text string) error {
	if err := requireTool("xclip"); err != nil {
		return fmt.Errorf("xclip required for clipboard")
	}
	cmd := exec.Command("xclip", "-selection", "clipboard")
	cmd.Stdin = strings.NewReader(text)
	return cmd.Start() // let xclip daemonize to serve the selection
}

// Focus activates a window by its wmctrl/xdotool ID.
func (p *LinuxPlatform) Focus(windowID string) error {
	if _, err := exec.LookPath("wmctrl"); err == nil {
		return run("wmctrl", "-i", "-a", windowID)
	}
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	return run("xdotool", "windowactivate", "--sync", windowID)
}

func (p *LinuxPlatform) CloseWindow(windowID string) error {
	if _, err := exec.LookPath("wmctrl"); err == nil {
		return run("wmctrl", "-i", "-c", windowID)
	}
	if err := requireTool("xdotool"); err != nil {
		return err
	}
	return run("xdotool", "windowclose", windowID)
}

// MaximizeWindow maximizes a window using wmctrl.
func (p *LinuxPlatform) MaximizeWindow(windowID string) error {
	if err := requireTool("wmctrl"); err != nil {
		return err
	}
	return run("wmctrl", "-i", "-r", windowID, "-b", "add,maximized_vert,maximized_horz")
}

// UnmaximizeWindow restores a maximized window.
func (p *LinuxPlatform) UnmaximizeWindow(windowID string) error {
	if err := requireTool("wmctrl"); err != nil {
		return err
	}
	return run("wmctrl", "-i", "-r", windowID, "-b", "remove,maximized_vert,maximized_horz")
}

// MoveResizeWindow positions and sizes a window.
func (p *LinuxPlatform) MoveResizeWindow(windowID string, x, y, w, h int) error {
	if err := requireTool("wmctrl"); err != nil {
		return err
	}
	// Unmaximize first — wmctrl move/resize is ignored on maximized windows.
	run("wmctrl", "-i", "-r", windowID, "-b", "remove,maximized_vert,maximized_horz")
	spec := fmt.Sprintf("0,%d,%d,%d,%d", x, y, w, h)
	return run("wmctrl", "-i", "-r", windowID, "-e", spec)
}

func requireTool(name string) error {
	if _, err := exec.LookPath(name); err != nil {
		return fmt.Errorf("%s not found (install %s)", name, name)
	}
	return nil
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %s", name, strings.TrimSpace(string(out)))
	}
	return nil
}
