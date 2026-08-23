package mcptools

import (
	"context"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"toad.computer/internal/platform"
)

// The grouped tool surface: eight nouns instead of fifty verbs.
//
// Fifty tools is a real tax on the agent driving this machine — the schemas
// crowd its context, and harnesses that defer large tool sets hide them
// behind a search the agent has to guess right. Grouping by noun keeps every
// capability visible in a surface small enough to read whole: one tool to
// see, one to act, one for the browser's fast path, and one each for shell,
// files, windows, waiting, and durable state.
//
// Each grouped tool takes an `action` plus the union of its actions' fields.

// RegisterGrouped adds the grouped tool surface to the MCP server.
func RegisterGrouped(server *mcp.Server, p platform.Platform) {
	registerSee(server, p)
	registerInput(server, p)
	registerBrowser(server)
	registerShell(server)
	registerFiles(server)
	registerWindows(server, p)
	registerWait(server, p)
	registerState(server)
}

// actionError names what was asked and what exists, because the agent's
// recovery path is rereading the schema — the error should save it the trip.
func actionError(tool, got string, actions ...string) error {
	return fmt.Errorf("%s: unknown action %q (one of: %v)", tool, got, actions)
}

// --- capture -----------------------------------------------------------------

type CaptureGroupInput struct {
	Mode string `json:"mode,omitempty" jsonschema:"tree (default): screenshot + accessibility tree as structured text; png: save a raw PNG and return its path"`
	Path string `json:"path,omitempty" jsonschema:"png mode only: optional file path, auto-generated if empty"`
}

func registerSee(server *mcp.Server, p platform.Platform) {
	capture := captureHandler(p)
	png := screenshotHandler()
	mcp.AddTool(server, &mcp.Tool{
		Name:        "capture",
		Description: "See the screen — the way in for NATIVE apps (web content reads better through the browser tool's text). Default returns a screenshot plus the accessibility tree as structured text: windows, interactive elements, roles, coordinates, values, states. mode=png saves a raw image instead, for visual inspection. Frames land in your conversation, so the human sees what you see.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, in CaptureGroupInput) (*mcp.CallToolResult, any, error) {
		switch in.Mode {
		case "", "tree":
			return capture(ctx, req, CaptureInput{})
		case "png":
			return png(ctx, req, ScreenshotInput{Path: in.Path})
		default:
			return nil, nil, actionError("capture", in.Mode, "tree", "png")
		}
	})
}

// --- input -------------------------------------------------------------------

type InputGroupInput struct {
	Action string `json:"action" jsonschema:"one of: click, double_click, right_click, move, drag, scroll, type, key, paste, clipboard_read, clipboard_write, batch"`
	X      int    `json:"x,omitempty" jsonschema:"screen X (click/move/scroll; drag start)"`
	Y      int    `json:"y,omitempty" jsonschema:"screen Y (click/move/scroll; drag start)"`
	X2     int    `json:"x2,omitempty" jsonschema:"drag end X"`
	Y2     int    `json:"y2,omitempty" jsonschema:"drag end Y"`
	Clicks int    `json:"clicks,omitempty" jsonschema:"scroll amount: positive=up, negative=down"`
	Text   string `json:"text,omitempty" jsonschema:"text for type/paste/clipboard_write"`
	Combo  string `json:"combo,omitempty" jsonschema:"key combination for key, e.g. ctrl+a, Return, alt+F4"`

	// batch: a short scripted sequence under one desktop lock.
	Steps          []map[string]any `json:"steps,omitempty" jsonschema:"batch only: ordered steps (click, dclick, rclick, paste, key, type, scroll, drag, move, focus, navigate, wait)"`
	StopOnError    *bool            `json:"stop_on_error,omitempty" jsonschema:"batch only: stop after the first failed step (default true)"`
	SettleMS       *int             `json:"settle_ms,omitempty" jsonschema:"batch only: delay between steps in ms (default 40)"`
	CaptureAfter   string           `json:"capture_after,omitempty" jsonschema:"batch only: final, each, or none (default final)"`
	CaptureOnError *bool            `json:"capture_on_error,omitempty" jsonschema:"batch only: capture the screen when a step fails (default true)"`
}

func registerInput(server *mcp.Server, p platform.Platform) {
	click := clickHandler(p)
	dclick := doubleClickHandler(p)
	rclick := rightClickHandler(p)
	move := moveHandler(p)
	drag := dragHandler(p)
	scroll := scrollHandler(p)
	typeText := typeHandler(p)
	key := keyHandler(p)
	paste := pasteHandler(p)
	clipRead := clipboardReadHandler(p)
	clipWrite := clipboardWriteHandler(p)
	batch := runHandler(p)
	// Pointer actions run through stuck detection: the same click on the same
	// frame, three times, comes back with a warning instead of a clean ok.
	pointer := func(inner func() (*mcp.CallToolResult, any, error), sig string) (*mcp.CallToolResult, any, error) {
		result, out, err := inner()
		if err != nil {
			return result, out, err
		}
		if warning := noteInput(sig); warning != "" && result != nil {
			result.Content = append(result.Content, &mcp.TextContent{Text: warning})
		}
		return result, out, err
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "input",
		Description: "Drive the mouse, keyboard, and clipboard on the desktop — for NATIVE apps, with coordinates from capture. For anything in the web browser, prefer the browser tool instead: its text/click_ref act on the page directly and beat mousing a URL bar every time. type is per-character; paste sets the clipboard and presses Ctrl+V (use it for long text). batch runs a short scripted sequence of steps under one lock. Input is refused while a human is at the screen.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, in InputGroupInput) (*mcp.CallToolResult, any, error) {
		switch in.Action {
		case "click":
			return pointer(func() (*mcp.CallToolResult, any, error) {
				return click(ctx, req, CoordInput{X: in.X, Y: in.Y})
			}, fmt.Sprintf("click %d,%d", in.X, in.Y))
		case "double_click":
			return pointer(func() (*mcp.CallToolResult, any, error) {
				return dclick(ctx, req, CoordInput{X: in.X, Y: in.Y})
			}, fmt.Sprintf("double_click %d,%d", in.X, in.Y))
		case "right_click":
			return pointer(func() (*mcp.CallToolResult, any, error) {
				return rclick(ctx, req, CoordInput{X: in.X, Y: in.Y})
			}, fmt.Sprintf("right_click %d,%d", in.X, in.Y))
		case "move":
			return move(ctx, req, CoordInput{X: in.X, Y: in.Y})
		case "drag":
			return drag(ctx, req, DragInput{X1: in.X, Y1: in.Y, X2: in.X2, Y2: in.Y2})
		case "scroll":
			return scroll(ctx, req, ScrollInput{X: in.X, Y: in.Y, Clicks: in.Clicks})
		case "type":
			return typeText(ctx, req, TextInput{Text: in.Text})
		case "key":
			return key(ctx, req, KeyInput{Combo: in.Combo})
		case "paste":
			return paste(ctx, req, TextInput{Text: in.Text})
		case "clipboard_read":
			return clipRead(ctx, req, EmptyInput{})
		case "clipboard_write":
			return clipWrite(ctx, req, TextInput{Text: in.Text})
		case "batch":
			return batch(ctx, req, RunInput{
				Steps:          in.Steps,
				StopOnError:    in.StopOnError,
				SettleMS:       in.SettleMS,
				CaptureAfter:   in.CaptureAfter,
				CaptureOnError: in.CaptureOnError,
			})
		default:
			return nil, nil, actionError("input", in.Action,
				"click", "double_click", "right_click", "move", "drag", "scroll",
				"type", "key", "paste", "clipboard_read", "clipboard_write", "batch")
		}
	})
}

// --- browser -----------------------------------------------------------------

type BrowserGroupInput struct {
	Action  string `json:"action" jsonschema:"one of: navigate, text, links, eval, click_ref, fill, select, check, hover, tabs, tab_select, tab_new, tab_close, upload, dialog_accept, dialog_dismiss, downloads"`
	URL     string `json:"url,omitempty" jsonschema:"navigate/tab_new: URL to open"`
	JS      string `json:"js,omitempty" jsonschema:"eval: JavaScript expression to evaluate in the page"`
	Ref     string `json:"ref,omitempty" jsonschema:"element reference from a text snapshot (click_ref/fill/select/check/hover)"`
	Button  string `json:"button,omitempty" jsonschema:"click_ref: empty=left, dbl=double-click"`
	Text    string `json:"text,omitempty" jsonschema:"fill: text to enter; dialog_accept: optional prompt answer"`
	Value   string `json:"value,omitempty" jsonschema:"select: option value to choose"`
	Uncheck bool   `json:"uncheck,omitempty" jsonschema:"check: set true to uncheck instead"`
	Index   *int   `json:"index,omitempty" jsonschema:"tab_select (required) / tab_close (default: current tab)"`
	Path    string `json:"path,omitempty" jsonschema:"upload: file path to attach"`
}

func registerBrowser(server *mcp.Server) {
	navigate := navigateHandler()
	text := snapshotHandler()
	links := pageLinksHandler()
	eval := pageEvalHandler()
	clickRef := clickRefHandler()
	fill := fillHandler()
	selectOpt := selectOptionHandler()
	check := checkHandler()
	hover := hoverHandler()
	tabs := tabsHandler()
	tabSelect := tabSelectHandler()
	tabNew := tabNewHandler()
	tabClose := tabCloseHandler()
	upload := uploadHandler()
	dialogAccept := dialogAcceptHandler()
	dialogDismiss := dialogDismissHandler()
	downloads := downloadsHandler()
	mcp.AddTool(server, &mcp.Tool{
		Name:        "browser",
		Description: "The managed Chromium, semantically. text returns the page as an accessibility snapshot with element refs — far cheaper than reading pixels — and click_ref/fill/select/check/hover act on those refs. Plus navigation, tabs, uploads, dialogs, and downloads.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, in BrowserGroupInput) (*mcp.CallToolResult, any, error) {
		switch in.Action {
		case "navigate":
			return navigate(ctx, req, NavigateInput{URL: in.URL})
		case "text":
			return text(ctx, req, SnapshotInput{})
		case "links":
			return links(ctx, req, PageLinksInput{})
		case "eval":
			return eval(ctx, req, PageEvalInput{JS: in.JS})
		case "click_ref":
			return clickRef(ctx, req, ClickRefInput{Ref: in.Ref, Button: in.Button})
		case "fill":
			return fill(ctx, req, FillInput{Ref: in.Ref, Text: in.Text})
		case "select":
			return selectOpt(ctx, req, SelectOptionInput{Ref: in.Ref, Value: in.Value})
		case "check":
			return check(ctx, req, CheckInput{Ref: in.Ref, Uncheck: in.Uncheck})
		case "hover":
			return hover(ctx, req, HoverInput{Ref: in.Ref})
		case "tabs":
			return tabs(ctx, req, TabsInput{})
		case "tab_select":
			return tabSelect(ctx, req, TabSelectInput{Index: in.Index})
		case "tab_new":
			return tabNew(ctx, req, TabNewInput{URL: in.URL})
		case "tab_close":
			return tabClose(ctx, req, TabCloseInput{Index: in.Index})
		case "upload":
			return upload(ctx, req, UploadInput{Path: in.Path})
		case "dialog_accept":
			return dialogAccept(ctx, req, DialogAcceptInput{Text: in.Text})
		case "dialog_dismiss":
			return dialogDismiss(ctx, req, DialogDismissInput{})
		case "downloads":
			return downloads(ctx, req, DownloadsInput{})
		default:
			return nil, nil, actionError("browser", in.Action,
				"navigate", "text", "links", "eval", "click_ref", "fill", "select", "check",
				"hover", "tabs", "tab_select", "tab_new", "tab_close", "upload",
				"dialog_accept", "dialog_dismiss", "downloads")
		}
	})
}

// --- shell -------------------------------------------------------------------

type ShellGroupInput struct {
	Action    string   `json:"action,omitempty" jsonschema:"exec (default): run synchronously and return output; launch: start a desktop app and return its PID"`
	Command   string   `json:"command" jsonschema:"program to run, e.g. ls, python3, bash; desktop app for launch"`
	Args      []string `json:"args,omitempty" jsonschema:"command arguments (no shell parsing — use bash -c for pipelines)"`
	Cwd       string   `json:"cwd,omitempty" jsonschema:"exec: working directory (default /home/agent)"`
	Timeout   int      `json:"timeout,omitempty" jsonschema:"exec: max seconds (default 30, max 60)"`
	MaxOutput int      `json:"max_output,omitempty" jsonschema:"exec: max bytes per stream (default 65536)"`
}

func registerShell(server *mcp.Server) {
	exec := execHandler()
	launch := appLaunchHandler()
	mcp.AddTool(server, &mcp.Tool{
		Name:        "shell",
		Description: "Run commands. exec is synchronous — stdout, stderr, exit code, duration — and is the escape hatch for everything without a tool. launch starts a GUI app on the desktop (accessibility flags injected) and returns its PID.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, in ShellGroupInput) (*mcp.CallToolResult, any, error) {
		switch in.Action {
		case "", "exec":
			result, out, err := exec(ctx, req, ExecInput{Command: in.Command, Args: in.Args,
				Cwd: in.Cwd, Timeout: in.Timeout, MaxOutput: in.MaxOutput,
			})
			return result, out, err
		case "launch":
			return launch(ctx, req, AppLaunchInput{Command: in.Command, Args: in.Args})
		default:
			return nil, nil, actionError("shell", in.Action, "exec", "launch")
		}
	})
}

// --- windows -----------------------------------------------------------------

type WindowsGroupInput struct {
	Action     string `json:"action" jsonschema:"one of: list, focus, close, maximize, tile"`
	WindowID   string `json:"window_id,omitempty" jsonschema:"window ID from capture or list (focus/close/maximize)"`
	Unmaximize bool   `json:"unmaximize,omitempty" jsonschema:"maximize: restore instead"`
}

func registerWindows(server *mcp.Server, p platform.Platform) {
	list := windowsHandler(p)
	focus := focusHandler(p)
	close := closeHandler(p)
	maximize := maximizeHandler(p)
	tile := tileHandler(p)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "windows",
		Description: "Manage desktop windows: list them with IDs and bounds, focus, close, maximize (or restore), or auto-tile the lot (browser left, others stacked right).",
	}, func(ctx context.Context, req *mcp.CallToolRequest, in WindowsGroupInput) (*mcp.CallToolResult, any, error) {
		switch in.Action {
		case "list":
			return list(ctx, req, EmptyInput{})
		case "focus":
			return focus(ctx, req, FocusInput{WindowID: in.WindowID})
		case "close":
			return close(ctx, req, CloseInput{WindowID: in.WindowID})
		case "maximize":
			return maximize(ctx, req, MaximizeInput{WindowID: in.WindowID, Unmaximize: in.Unmaximize})
		case "tile":
			return tile(ctx, req, TileInput{})
		default:
			return nil, nil, actionError("windows", in.Action, "list", "focus", "close", "maximize", "tile")
		}
	})
}

// --- wait --------------------------------------------------------------------

func registerWait(server *mcp.Server, p platform.Platform) {
	// Wait keeps its own name and single purpose: it is the verify half of the
	// see→act→verify loop, and "wait" is what the agent reaches for verbatim.
	mcp.AddTool(server, &mcp.Tool{
		Name:        "wait",
		Description: "Poll the screen until text appears. Returns when found or after timeout. Use after input or navigation to confirm the screen reached the state you expect.",
	}, waitHandler(p))
}

// --- state -------------------------------------------------------------------

type StateGroupInput struct {
	Action   string `json:"action" jsonschema:"one of: control, release, login_save, login_load, login_list, login_delete, snapshot_save, snapshot_load, snapshot_list, snapshot_delete"`
	Name     string `json:"name,omitempty" jsonschema:"login/snapshot name (e.g. github, pre-upgrade)"`
	Duration int    `json:"duration,omitempty" jsonschema:"control: lease seconds (default 300, max 600)"`
}

func registerState(server *mcp.Server) {
	control := controlHandler()
	release := controlReleaseHandler()
	loginSave := stateSaveHandler()
	loginLoad := stateLoadHandler()
	loginList := stateListHandler()
	loginDelete := stateDeleteHandler()
	snapSave := snapshotSaveHandler()
	snapLoad := snapshotLoadHandler()
	snapList := snapshotListHandler()
	snapDelete := snapshotDeleteHandler()
	mcp.AddTool(server, &mcp.Tool{
		Name:        "state",
		Description: "Durable machine state. control marks the desktop as human-driven: YOUR mutating tools are refused until release or expiry, and the dock shows it — it does not summon anyone or change what the human can do. To actually ask the human to act (credentials, 2FA), call the request_human teammate tool instead, which alerts them and waits. login_* saves and restores browser logins by name. snapshot_* archives and restores the home directory.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, in StateGroupInput) (*mcp.CallToolResult, any, error) {
		switch in.Action {
		case "control":
			return control(ctx, req, ControlInput{Duration: in.Duration})
		case "release":
			return release(ctx, req, ControlReleaseInput{})
		case "login_save":
			return loginSave(ctx, req, StateSaveInput{Name: in.Name})
		case "login_load":
			return loginLoad(ctx, req, StateLoadInput{Name: in.Name})
		case "login_list":
			return loginList(ctx, req, StateListInput{})
		case "login_delete":
			return loginDelete(ctx, req, StateDeleteInput{Name: in.Name})
		case "snapshot_save":
			return snapSave(ctx, req, SnapshotSaveInput{Name: in.Name})
		case "snapshot_load":
			return snapLoad(ctx, req, SnapshotLoadInput{Name: in.Name})
		case "snapshot_list":
			return snapList(ctx, req, SnapshotListInput{})
		case "snapshot_delete":
			return snapDelete(ctx, req, SnapshotDeleteInput{Name: in.Name})
		default:
			return nil, nil, actionError("state", in.Action,
				"control", "release", "login_save", "login_load", "login_list", "login_delete",
				"snapshot_save", "snapshot_load", "snapshot_list", "snapshot_delete")
		}
	})
}
