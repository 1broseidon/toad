// Package mcptools registers MCP tool handlers that wrap existing CLI code paths.
// Each tool is a thin wrapper — all logic lives in platform, capture, and input packages.
package mcptools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"toad.sh/computer/internal/capture"
	"toad.sh/computer/internal/input"
	"toad.sh/computer/internal/names"
	"toad.sh/computer/internal/platform"
	"toad.sh/computer/internal/workspace"
)

// Register adds all vhd tools to the MCP server.
func Register(server *mcp.Server, p platform.Platform) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "capture",
		Description: "Capture the screen: screenshot + accessibility tree → structured text. Returns window list with interactive elements, their roles, coordinates, values, and states. This is the primary way to see what's on screen.",
	}, captureHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "screenshot",
		Description: "Save a raw PNG screenshot. Returns the file path. Use capture instead for structured data — screenshot is for visual inspection only.",
	}, screenshotHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "click",
		Description: "Click at screen coordinates (x, y).",
	}, clickHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "double_click",
		Description: "Double-click at screen coordinates (x, y).",
	}, doubleClickHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "right_click",
		Description: "Right-click at screen coordinates (x, y).",
	}, rightClickHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "drag",
		Description: "Click-drag from (x1, y1) to (x2, y2).",
	}, dragHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "move",
		Description: "Move mouse to (x, y) without clicking.",
	}, moveHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "scroll",
		Description: "Scroll at position (x, y). Positive clicks = up, negative = down.",
	}, scrollHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "type",
		Description: "Type a string character by character. Use paste for long text.",
	}, typeHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "key",
		Description: "Send a key combination, e.g. \"ctrl+a\", \"Return\", \"alt+F4\".",
	}, keyHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "paste",
		Description: "Set clipboard to text and press Ctrl+V. Fast and reliable for long text.",
	}, pasteHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "clipboard_read",
		Description: "Read the current clipboard text.",
	}, clipboardReadHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "clipboard_write",
		Description: "Write text to clipboard without pasting.",
	}, clipboardWriteHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "focus",
		Description: "Activate/focus a window by its ID (from capture or windows output).",
	}, focusHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "windows",
		Description: "List all visible windows on the desktop with their IDs, titles, and bounds.",
	}, windowsHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "launch",
		Description: "Launch a program on the virtual desktop. Returns the PID. App-specific flags (accessibility, profile isolation) are injected automatically.",
	}, appLaunchHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "exec",
		Description: "Run a shell command synchronously. Returns stdout, stderr, exit code, duration, and truncation status.",
	}, execHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "close",
		Description: "Close a window by its ID (from capture or windows output).",
	}, closeHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "wait",
		Description: "Poll the screen until text appears. Returns when found or after timeout. Use after exec or navigation to wait for content to load.",
	}, waitHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "run",
		Description: "Execute a small batch of desktop actions sequentially under the desktop lock. Supports click, dclick, rclick, paste, key, type, scroll, drag, move, focus, navigate, and wait.",
	}, runHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "maximize",
		Description: "Maximize a window to fill the screen. Use unmaximize=true to restore.",
	}, maximizeHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "tile",
		Description: "Auto-tile all windows. Browsers go left full-height, other apps stack on the right. Call with no args — layout is automatic.",
	}, tileHandler(p))
	mcp.AddTool(server, &mcp.Tool{
		Name:        "launch",
		Description: "Start an ephemeral desktop. Backend (Docker or cloud) is determined by configuration. Returns the desktop name for use in subsequent tool calls.",
	}, launchHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "kill",
		Description: "Tear down a desktop by name. Works regardless of backend.",
	}, killHandler())
}

// Input types — schemas are inferred automatically by the MCP SDK.
// Every input includes an optional Desktop field for gateway routing.
// When set (e.g. "browser-1"), the gateway proxies the call to that remote desktop.
// When empty or "local", the call targets the local desktop.

type CaptureInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type ScreenshotInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Path    string `json:"path,omitempty" jsonschema:"optional file path; auto-generated if empty"`
}

type CoordInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	X       int    `json:"x" jsonschema:"screen X coordinate"`
	Y       int    `json:"y" jsonschema:"screen Y coordinate"`
}

type DragInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	X1      int    `json:"x1" jsonschema:"start X"`
	Y1      int    `json:"y1" jsonschema:"start Y"`
	X2      int    `json:"x2" jsonschema:"end X"`
	Y2      int    `json:"y2" jsonschema:"end Y"`
}

type ScrollInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	X       int    `json:"x" jsonschema:"screen X coordinate"`
	Y       int    `json:"y" jsonschema:"screen Y coordinate"`
	Clicks  int    `json:"clicks" jsonschema:"scroll amount: positive=up, negative=down"`
}

type TextInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Text    string `json:"text" jsonschema:"text to type"`
}

type KeyInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Combo   string `json:"combo" jsonschema:"key combination, e.g. ctrl+a, Return, alt+F4"`
}

type FocusInput struct {
	Desktop  string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	WindowID string `json:"window_id" jsonschema:"window ID from capture or windows output"`
}

type EmptyInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type AppLaunchInput struct {
	Desktop string   `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Command string   `json:"command" jsonschema:"program to launch, e.g. firefox, brave-browser, alacritty"`
	Args    []string `json:"args,omitempty" jsonschema:"optional command arguments"`
}

type CloseInput struct {
	Desktop  string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	WindowID string `json:"window_id" jsonschema:"window ID from capture or windows output"`
}

type WaitInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Text    string `json:"text" jsonschema:"text to wait for on screen"`
	Timeout int    `json:"timeout,omitempty" jsonschema:"max seconds to wait (default 10)"`
}

type MaximizeInput struct {
	Desktop    string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	WindowID   string `json:"window_id" jsonschema:"window ID from capture or windows output"`
	Unmaximize bool   `json:"unmaximize,omitempty" jsonschema:"restore window instead of maximizing"`
}

type TileInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type LaunchInput struct {
	Name  string `json:"name,omitempty" jsonschema:"desktop name (auto-generated if empty)"`
	Image string `json:"image,omitempty" jsonschema:"container image (default per backend)"`
}

type KillInput struct {
	Name string `json:"name" jsonschema:"name of the desktop to tear down"`
}

// route checks whether a tool call should be proxied to a remote desktop.
// If desktop is non-empty and not "local", it proxies and returns the result.
// Returns (result, true) if proxied, or (nil, false) if the call should be handled locally.
func route(desktop string, req *mcp.CallToolRequest) (*mcp.CallToolResult, bool, error) {
	if desktop == "" || desktop == "local" {
		return nil, false, nil
	}
	args := make(map[string]any)
	if req.Params.Arguments != nil {
		json.Unmarshal(req.Params.Arguments, &args)
	}
	text, err := ProxyToolCall(desktop, req.Params.Name, args)
	if err != nil {
		return nil, true, err
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
	}, true, nil
}

// requirePlatform returns an error if the platform is nil (no local desktop).
func requirePlatform(p platform.Platform) error {
	if p == nil {
		return fmt.Errorf("no local desktop — start one with 'vhd launch' or target a remote with the desktop parameter")
	}
	return nil
}

// Handler constructors — each returns a closure that captures the platform.

func captureHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, CaptureInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in CaptureInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		text, err := captureText(p)
		if err != nil {
			return nil, nil, err
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: text}},
		}, nil, nil
	}
}

func screenshotHandler() func(context.Context, *mcp.CallToolRequest, ScreenshotInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in ScreenshotInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		path, err := capture.Screenshot(in.Path)
		if err != nil {
			return nil, nil, err
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: path}},
		}, nil, nil
	}
}

func clickHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, CoordInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in CoordInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.Click(p, in.X, in.Y); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("clicked %d,%d", in.X, in.Y)), nil, nil
	}
}

func doubleClickHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, CoordInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in CoordInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.DoubleClick(p, in.X, in.Y); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("double-clicked %d,%d", in.X, in.Y)), nil, nil
	}
}

func rightClickHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, CoordInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in CoordInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.RightClick(p, in.X, in.Y); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("right-clicked %d,%d", in.X, in.Y)), nil, nil
	}
}

func dragHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, DragInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in DragInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.Drag(p, in.X1, in.Y1, in.X2, in.Y2); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("dragged %d,%d → %d,%d", in.X1, in.Y1, in.X2, in.Y2)), nil, nil
	}
}

func moveHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, CoordInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in CoordInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.Move(p, in.X, in.Y); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("moved to %d,%d", in.X, in.Y)), nil, nil
	}
}

func scrollHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, ScrollInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in ScrollInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.Scroll(p, in.X, in.Y, in.Clicks); err != nil {
			return nil, nil, err
		}
		dir := "down"
		if in.Clicks > 0 {
			dir = "up"
		}
		return okResult(fmt.Sprintf("scrolled %s %d at %d,%d", dir, abs(in.Clicks), in.X, in.Y)), nil, nil
	}
}

func typeHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, TextInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in TextInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.Type(p, in.Text); err != nil {
			return nil, nil, err
		}
		return okResult("typed"), nil, nil
	}
}

func keyHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, KeyInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in KeyInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.Key(p, in.Combo); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("sent %s", in.Combo)), nil, nil
	}
}

func pasteHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, TextInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in TextInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.Paste(p, in.Text); err != nil {
			return nil, nil, err
		}
		return okResult("pasted"), nil, nil
	}
}

func clipboardReadHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, EmptyInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in EmptyInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		text, err := input.GetClipboard(p)
		if err != nil {
			return nil, nil, err
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: text}},
		}, nil, nil
	}
}

func clipboardWriteHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, TextInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in TextInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.SetClipboard(p, in.Text); err != nil {
			return nil, nil, err
		}
		return okResult("clipboard set"), nil, nil
	}
}

func focusHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, FocusInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in FocusInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.Focus(p, in.WindowID); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("focused %s", in.WindowID)), nil, nil
	}
}

func windowsHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, EmptyInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in EmptyInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		windows, err := p.ListWindows()
		if err != nil {
			return nil, nil, err
		}
		var text string
		for _, w := range windows {
			text += fmt.Sprintf("%s  %-30s  %d,%d %dx%d\n",
				w.ID, w.Title, w.Bounds[0], w.Bounds[1], w.Bounds[2], w.Bounds[3])
		}
		if text == "" {
			text = "no windows on agent desktop"
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: text}},
		}, nil, nil
	}
}

func appLaunchHandler() func(context.Context, *mcp.CallToolRequest, AppLaunchInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in AppLaunchInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		args := append([]string{in.Command}, in.Args...)
		if err := workspace.Exec(args); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("launched %s", in.Command)), nil, nil
	}
}

func closeHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, CloseInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in CloseInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if err := input.CloseWindow(p, in.WindowID); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("closed %s", in.WindowID)), nil, nil
	}
}

func waitHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, WaitInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in WaitInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		timeout := 10
		if in.Timeout > 0 {
			timeout = in.Timeout
		}
		if err := waitForText(p, in.Text, time.Duration(timeout)*time.Second); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("found: %s", in.Text)), nil, nil
	}
}

func maximizeHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, MaximizeInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in MaximizeInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		if in.Unmaximize {
			if err := p.UnmaximizeWindow(in.WindowID); err != nil {
				return nil, nil, err
			}
			return okResult(fmt.Sprintf("unmaximized %s", in.WindowID)), nil, nil
		}
		if err := p.MaximizeWindow(in.WindowID); err != nil {
			return nil, nil, err
		}
		return okResult(fmt.Sprintf("maximized %s", in.WindowID)), nil, nil
	}
}

var browserNames = []string{"Brave", "Firefox", "Chrome", "Chromium"}

func isBrowser(title string) bool {
	for _, b := range browserNames {
		if strings.Contains(title, b) {
			return true
		}
	}
	return false
}

func tileHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, TileInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in TileInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		const screenW, screenH = 1920, 1080
		const dockH = 24
		usableH := screenH - dockH

		skip := map[string]bool{"Openbox": true, "vhd-dock": true}
		windows, err := p.ListWindows()
		if err != nil {
			return nil, nil, err
		}

		var browsers, others []platform.Window
		for _, w := range windows {
			if skip[w.Title] {
				continue
			}
			if isBrowser(w.Title) {
				browsers = append(browsers, w)
			} else {
				others = append(others, w)
			}
		}

		all := append(browsers, others...)
		if len(all) == 0 {
			return okResult("no windows to tile"), nil, nil
		}

		// Single window: maximize.
		if len(all) == 1 {
			p.MaximizeWindow(all[0].ID)
			return okResult(fmt.Sprintf("maximized %s", all[0].Title)), nil, nil
		}

		var summary []string
		halfW := screenW / 2

		if len(browsers) > 0 {
			// Browsers: left half, split vertically among themselves.
			bh := usableH / len(browsers)
			for i, b := range browsers {
				p.MoveResizeWindow(b.ID, 0, i*bh, halfW, bh)
				summary = append(summary, fmt.Sprintf("L: %s", shortTitle(b.Title)))
			}
			// Others: right half, stacked.
			if len(others) > 0 {
				oh := usableH / len(others)
				for i, o := range others {
					p.MoveResizeWindow(o.ID, halfW, i*oh, halfW, oh)
					summary = append(summary, fmt.Sprintf("R: %s", shortTitle(o.Title)))
				}
			}
		} else {
			// No browsers: stack all on right halves or split evenly.
			oh := usableH / len(all)
			for i, w := range all {
				p.MoveResizeWindow(w.ID, 0, i*oh, screenW, oh)
				summary = append(summary, shortTitle(w.Title))
			}
		}
		return okResult(strings.Join(summary, " | ")), nil, nil
	}
}

func launchHandler() func(context.Context, *mcp.CallToolRequest, LaunchInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, _ *mcp.CallToolRequest, in LaunchInput) (*mcp.CallToolResult, any, error) {
		cfg := workspace.LoadConfig()
		backend := cfg.ResolveBackend()
		name := in.Name

		switch backend {
		case "docker":
			image := in.Image
			if image == "" {
				image = "vhd"
			}
			if name == "" {
				name = names.Generate()
			}
			if err := workspace.DockerInit(name, image); err != nil {
				return nil, nil, err
			}
		case "cloud":
			creds, err := workspace.LoadCredentials()
			if err != nil {
				return nil, nil, err
			}
			if err := workspace.CloudCreate(name, in.Image, creds); err != nil {
				return nil, nil, err
			}
			// Find the name that was used (may have been auto-generated).
			if name == "" {
				remotes := workspace.LoadRemotes()
				for n, r := range remotes {
					if r.Managed {
						name = n
					}
				}
			}
		default:
			return nil, nil, fmt.Errorf("unknown backend %q", backend)
		}

		// Evict any stale proxy session for this name.
		sessionsMu.Lock()
		delete(sessions, name)
		sessionsMu.Unlock()

		return okResult(fmt.Sprintf("launched desktop %q (%s) — use desktop: %q in tool calls to target it", name, backend, name)), nil, nil
	}
}

func killHandler() func(context.Context, *mcp.CallToolRequest, KillInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, _ *mcp.CallToolRequest, in KillInput) (*mcp.CallToolResult, any, error) {
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}
		msg, err := killDesktop(in.Name)
		if err != nil {
			return nil, nil, err
		}
		// Evict cached proxy session so next launch gets a fresh connection.
		sessionsMu.Lock()
		delete(sessions, in.Name)
		sessionsMu.Unlock()
		return okResult(msg), nil, nil
	}
}

func killDesktop(name string) (string, error) {
	remotes := workspace.LoadRemotes()

	// Docker desktops (local state is authoritative).
	if r, ok := remotes[name]; ok && r.Container != "" {
		if err := workspace.DockerStop(name); err != nil {
			return "", err
		}
		return fmt.Sprintf("killed desktop %q (docker)", name), nil
	}

	// Cloud: query API (authoritative) to find desktop by name.
	if msg, err := killCloudDesktop(name); msg != "" || err != nil {
		return msg, err
	}

	// Cloud via local cache (fallback if API unreachable).
	if r, ok := remotes[name]; ok && r.Managed {
		if err := workspace.CloudDestroy(name); err != nil {
			return "", err
		}
		return fmt.Sprintf("killed desktop %q (cloud)", name), nil
	}

	// Manual remotes -- just remove from registry.
	if _, ok := remotes[name]; ok {
		if err := workspace.RemoveRemote(name); err != nil {
			return "", err
		}
		return fmt.Sprintf("removed remote %q", name), nil
	}

	return "", fmt.Errorf("desktop %q not found", name)
}

func killCloudDesktop(name string) (string, error) {
	creds, err := workspace.LoadCredentials()
	if err != nil {
		return "", nil // no credentials, skip
	}
	desktops, err := workspace.CloudList(creds)
	if err != nil {
		return "", nil // API unreachable, skip
	}
	for _, d := range desktops {
		if d.Status != "running" {
			continue
		}
		if d.Name == name || d.ID == name {
			if err := workspace.CloudDestroyByID(creds, d.ID, name); err != nil {
				return "", err
			}
			return fmt.Sprintf("killed desktop %q (cloud)", name), nil
		}
	}
	return "", nil // not found in cloud
}

func shortTitle(title string) string {
	if len(title) > 25 {
		return title[:25] + ".."
	}
	return title
}

func matchText(result *capture.CaptureResult, needle string) bool {
	for _, wg := range result.Windows {
		for _, e := range wg.Elements {
			if strings.Contains(strings.ToLower(e.Text), needle) {
				return true
			}
		}
	}
	for _, e := range result.Ungrouped {
		if strings.Contains(strings.ToLower(e.Text), needle) {
			return true
		}
	}
	return false
}

func okResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
