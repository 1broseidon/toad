// Package mcptools registers MCP tool handlers that wrap existing CLI code paths.
// Each tool is a thin wrapper — all logic lives in platform, capture, and input packages.
package mcptools

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"toad.computer/internal/capture"
	"toad.computer/internal/input"
	"toad.computer/internal/platform"
	"toad.computer/internal/workspace"
)

// Input types — schemas are inferred automatically by the MCP SDK.
type CaptureInput struct {
}

type ScreenshotInput struct {
	Path string `json:"path,omitempty" jsonschema:"optional file path; auto-generated if empty"`
}

type CoordInput struct {
	X int `json:"x" jsonschema:"screen X coordinate"`
	Y int `json:"y" jsonschema:"screen Y coordinate"`
}

type DragInput struct {
	X1 int `json:"x1" jsonschema:"start X"`
	Y1 int `json:"y1" jsonschema:"start Y"`
	X2 int `json:"x2" jsonschema:"end X"`
	Y2 int `json:"y2" jsonschema:"end Y"`
}

type ScrollInput struct {
	X      int `json:"x" jsonschema:"screen X coordinate"`
	Y      int `json:"y" jsonschema:"screen Y coordinate"`
	Clicks int `json:"clicks" jsonschema:"scroll amount: positive=up, negative=down"`
}

type TextInput struct {
	Text string `json:"text" jsonschema:"text to type"`
}

type KeyInput struct {
	Combo string `json:"combo" jsonschema:"key combination, e.g. ctrl+a, Return, alt+F4"`
}

type FocusInput struct {
	WindowID string `json:"window_id" jsonschema:"window ID from capture or windows output"`
}

type EmptyInput struct {
}

type AppLaunchInput struct {
	Command string   `json:"command" jsonschema:"program to launch, e.g. firefox, brave-browser, alacritty"`
	Args    []string `json:"args,omitempty" jsonschema:"optional command arguments"`
}

type CloseInput struct {
	WindowID string `json:"window_id" jsonschema:"window ID from capture or windows output"`
}

type WaitInput struct {
	Text    string `json:"text" jsonschema:"text to wait for on screen"`
	Timeout int    `json:"timeout,omitempty" jsonschema:"max seconds to wait (default 10)"`
}

type MaximizeInput struct {
	WindowID   string `json:"window_id" jsonschema:"window ID from capture or windows output"`
	Unmaximize bool   `json:"unmaximize,omitempty" jsonschema:"restore window instead of maximizing"`
}

type TileInput struct {
}

// requirePlatform returns an error if the platform is nil (no local desktop).
func requirePlatform(p platform.Platform) error {
	if p == nil {
		return fmt.Errorf("no local display")
	}
	return nil
}

// Handler constructors — each returns a closure that captures the platform.

func captureHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, CaptureInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in CaptureInput) (*mcp.CallToolResult, any, error) {
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
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
		if err := requirePlatform(p); err != nil {
			return nil, nil, err
		}
		unlock, err := lockMutating()
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		const screenW, screenH = 1920, 1080
		const dockH = 24
		usableH := screenH - dockH

		skip := map[string]bool{"Openbox": true, "toad-dock": true}
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
