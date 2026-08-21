package mcptools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"toad.sh/computer/internal/workspace"
)

// playwrightCLI runs a playwright-cli command and returns its stdout.
func playwrightCLI(timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "playwright-cli", args...)
	cmd.Dir = "/home/agent"
	cmd.Env = append(cmd.Environ(), "DISPLAY="+display())
	out, err := cmd.CombinedOutput()
	if err != nil {
		return strings.TrimSpace(string(out)), fmt.Errorf("playwright-cli %s: %s", args[0], strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// display returns the DISPLAY env var, defaulting to :99.
func display() string {
	if current := workspace.Display(); current != "" {
		return current
	}
	if current := os.Getenv("DISPLAY"); current != "" {
		return current
	}
	return ":99" // container default
}

// ensureBrowser opens the headed browser if no session is active.
func ensureBrowser() error {
	out, _ := playwrightCLI(5*time.Second, "list")
	if strings.Contains(out, "no browsers") {
		_, err := playwrightCLI(15*time.Second, "open", "--headed")
		return err
	}
	return nil
}

func navigateBrowser(url string) (string, error) {
	if url == "" {
		return "", fmt.Errorf("url is required")
	}
	if err := ensureBrowser(); err != nil {
		return "", fmt.Errorf("browser: %w", err)
	}
	out, err := playwrightCLI(30*time.Second, "goto", url)
	if err != nil {
		return "", fmt.Errorf("navigate: %w", err)
	}
	return out, nil
}

// --- Input types ---

type NavigateInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	URL     string `json:"url" jsonschema:"URL to navigate to"`
}

type PageTextInput struct {
	Desktop  string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Selector string `json:"selector,omitempty" jsonschema:"CSS selector to scope text extraction (default: entire page)"`
}

type PageEvalInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	JS      string `json:"js" jsonschema:"JavaScript expression to evaluate in the page context"`
}

type PageLinksInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type SnapshotInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type ClickRefInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Ref     string `json:"ref" jsonschema:"element reference from page_text snapshot"`
	Button  string `json:"button,omitempty" jsonschema:"mouse button: empty=left, dbl=double-click"`
}

type FillInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Ref     string `json:"ref" jsonschema:"element reference from page_text snapshot"`
	Text    string `json:"text" jsonschema:"text to fill into the referenced element"`
}

type SelectOptionInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Ref     string `json:"ref" jsonschema:"element reference from page_text snapshot"`
	Value   string `json:"value" jsonschema:"option value to select"`
}

type CheckInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Ref     string `json:"ref" jsonschema:"element reference from page_text snapshot"`
	Uncheck bool   `json:"uncheck,omitempty" jsonschema:"set true to uncheck instead of check"`
}

type HoverInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Ref     string `json:"ref" jsonschema:"element reference from page_text snapshot"`
}

type TabsInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type TabSelectInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Index   *int   `json:"index" jsonschema:"tab index to select"`
}

type TabNewInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	URL     string `json:"url,omitempty" jsonschema:"optional URL to open in the new tab"`
}

type TabCloseInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Index   *int   `json:"index,omitempty" jsonschema:"optional tab index to close (default: current tab)"`
}

type UploadInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Path    string `json:"path" jsonschema:"absolute or relative file path to upload"`
}

type DialogAcceptInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Text    string `json:"text,omitempty" jsonschema:"optional prompt text to enter before accepting"`
}

type DialogDismissInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type DownloadsInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

// --- Registration ---

// RegisterBrowserTools adds browser tools backed by playwright-cli.
func RegisterBrowserTools(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "navigate",
		Description: "Navigate the browser to a URL. Opens a headed browser if none is running. Returns the page URL and title.",
	}, navigateHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "page_text",
		Description: "Get the visible text of the current page as a structured accessibility snapshot. Returns element tree with refs that can be used with click/fill. Much richer than OCR.",
	}, snapshotHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "page_eval",
		Description: "Evaluate a JavaScript expression in the browser page context. Returns the result.",
	}, pageEvalHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "page_links",
		Description: "Extract all links from the current page as a JSON array of {text, href} objects.",
	}, pageLinksHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "click_ref",
		Description: "Click a page element by page_text ref. Supports button=dbl for ref-based double-click.",
	}, clickRefHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "fill",
		Description: "Fill a form control by page_text ref.",
	}, fillHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "select_option",
		Description: "Select an option in a form control by page_text ref and option value.",
	}, selectOptionHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "check",
		Description: "Check or uncheck a checkbox by page_text ref. Set uncheck=true to clear it.",
	}, checkHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "hover",
		Description: "Hover a page element by page_text ref.",
	}, hoverHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "tabs",
		Description: "List the current browser tabs.",
	}, tabsHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "tab_select",
		Description: "Switch to a browser tab by index.",
	}, tabSelectHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "tab_new",
		Description: "Open a new browser tab, optionally at a URL.",
	}, tabNewHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "tab_close",
		Description: "Close a browser tab by index, or close the current tab if omitted.",
	}, tabCloseHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "upload",
		Description: "Upload a file to the active browser file chooser.",
	}, uploadHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "dialog_accept",
		Description: "Accept the active browser dialog, optionally providing prompt text.",
	}, dialogAcceptHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "dialog_dismiss",
		Description: "Dismiss the active browser dialog.",
	}, dialogDismissHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "downloads",
		Description: "List downloaded files captured by playwright-cli.",
	}, downloadsHandler())
}

// --- Handlers ---

func navigateHandler() func(context.Context, *mcp.CallToolRequest, NavigateInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in NavigateInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.URL == "" {
			return nil, nil, fmt.Errorf("url is required")
		}
		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()
		out, err := navigateBrowser(in.URL)
		if err != nil {
			return nil, nil, err
		}

		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: out}},
		}, nil, nil
	}
}

func snapshotHandler() func(context.Context, *mcp.CallToolRequest, SnapshotInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in SnapshotInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		out, err := playwrightCLI(15*time.Second, "snapshot")
		if err != nil {
			return nil, nil, fmt.Errorf("page_text: %w", err)
		}

		// Read the snapshot YAML inline so callers get the accessibility tree directly.
		if ymlPath := extractSnapshotPath(out); ymlPath != "" {
			abs := filepath.Join("/home/agent", ymlPath)
			if data, err := os.ReadFile(abs); err == nil {
				return &mcp.CallToolResult{
					Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
				}, nil, nil
			}
		}

		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: out}},
		}, nil, nil
	}
}

func pageEvalHandler() func(context.Context, *mcp.CallToolRequest, PageEvalInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in PageEvalInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.JS == "" {
			return nil, nil, fmt.Errorf("js is required")
		}

		out, err := playwrightCLI(15*time.Second, "eval", in.JS)
		if err != nil {
			return nil, nil, fmt.Errorf("page_eval: %w", err)
		}

		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: out}},
		}, nil, nil
	}
}

type pageLink struct {
	Text string `json:"text"`
	Href string `json:"href"`
}

func pageLinksHandler() func(context.Context, *mcp.CallToolRequest, PageLinksInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in PageLinksInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		// Use function() syntax — arrow functions break when playwright-cli shell-escapes the expression.
		const js = `JSON.stringify([].slice.call(document.querySelectorAll("a[href]")).map(function(a){return {text:a.innerText.trim(),href:a.href}}))`
		out, err := playwrightCLI(15*time.Second, "eval", js)
		if err != nil {
			return nil, nil, fmt.Errorf("page_links: %w", err)
		}

		// Extract the result value from playwright-cli output.
		// eval wraps in JSON.stringify, so result is a quoted JSON string.
		result := extractResult(out)

		// Unquote the outer JSON string layer.
		var inner string
		if err := json.Unmarshal([]byte(result), &inner); err != nil {
			// Not double-quoted — try using result directly.
			inner = result
		}

		// Validate it's a JSON array; if not, return raw.
		var links []pageLink
		if err := json.Unmarshal([]byte(inner), &links); err != nil {
			return &mcp.CallToolResult{
				Content: []mcp.Content{&mcp.TextContent{Text: inner}},
			}, nil, nil
		}

		data, _ := json.Marshal(links)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

func clickRefHandler() func(context.Context, *mcp.CallToolRequest, ClickRefInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in ClickRefInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Ref == "" {
			return nil, nil, fmt.Errorf("ref is required")
		}
		command, err := clickRefCommand(in.Button)
		if err != nil {
			return nil, nil, err
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		out, err := playwrightCLI(15*time.Second, command, in.Ref)
		if err != nil {
			return nil, nil, fmt.Errorf("click_ref: %w", err)
		}
		return browserActionResult(out, fmt.Sprintf("%s %s", command, in.Ref)), nil, nil
	}
}

func fillHandler() func(context.Context, *mcp.CallToolRequest, FillInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in FillInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Ref == "" {
			return nil, nil, fmt.Errorf("ref is required")
		}
		if in.Text == "" {
			return nil, nil, fmt.Errorf("text is required")
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		out, err := playwrightCLI(15*time.Second, "fill", in.Ref, in.Text)
		if err != nil {
			return nil, nil, fmt.Errorf("fill: %w", err)
		}
		return browserActionResult(out, fmt.Sprintf("filled %s", in.Ref)), nil, nil
	}
}

func selectOptionHandler() func(context.Context, *mcp.CallToolRequest, SelectOptionInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in SelectOptionInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Ref == "" {
			return nil, nil, fmt.Errorf("ref is required")
		}
		if in.Value == "" {
			return nil, nil, fmt.Errorf("value is required")
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		out, err := playwrightCLI(15*time.Second, "select", in.Ref, in.Value)
		if err != nil {
			return nil, nil, fmt.Errorf("select_option: %w", err)
		}
		return browserActionResult(out, fmt.Sprintf("selected %q on %s", in.Value, in.Ref)), nil, nil
	}
}

func checkHandler() func(context.Context, *mcp.CallToolRequest, CheckInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in CheckInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Ref == "" {
			return nil, nil, fmt.Errorf("ref is required")
		}

		command := "check"
		fallback := fmt.Sprintf("checked %s", in.Ref)
		if in.Uncheck {
			command = "uncheck"
			fallback = fmt.Sprintf("unchecked %s", in.Ref)
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		out, err := playwrightCLI(15*time.Second, command, in.Ref)
		if err != nil {
			return nil, nil, fmt.Errorf("check: %w", err)
		}
		return browserActionResult(out, fallback), nil, nil
	}
}

func hoverHandler() func(context.Context, *mcp.CallToolRequest, HoverInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in HoverInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Ref == "" {
			return nil, nil, fmt.Errorf("ref is required")
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		out, err := playwrightCLI(15*time.Second, "hover", in.Ref)
		if err != nil {
			return nil, nil, fmt.Errorf("hover: %w", err)
		}
		return browserActionResult(out, fmt.Sprintf("hovered %s", in.Ref)), nil, nil
	}
}

func tabsHandler() func(context.Context, *mcp.CallToolRequest, TabsInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in TabsInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		out, err := playwrightCLI(15*time.Second, "tab-list")
		if err != nil {
			return nil, nil, fmt.Errorf("tabs: %w", err)
		}
		return browserActionResult(out, "no tabs"), nil, nil
	}
}

func tabSelectHandler() func(context.Context, *mcp.CallToolRequest, TabSelectInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in TabSelectInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Index == nil {
			return nil, nil, fmt.Errorf("index is required")
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		out, err := playwrightCLI(15*time.Second, "tab-select", fmt.Sprintf("%d", *in.Index))
		if err != nil {
			return nil, nil, fmt.Errorf("tab_select: %w", err)
		}
		return browserActionResult(out, fmt.Sprintf("selected tab %d", *in.Index)), nil, nil
	}
}

func tabNewHandler() func(context.Context, *mcp.CallToolRequest, TabNewInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in TabNewInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		// playwright-cli tab-new ignores URL arg, so we open then navigate.
		out, err := playwrightCLI(15*time.Second, "tab-new")
		if err != nil {
			return nil, nil, fmt.Errorf("tab_new: %w", err)
		}
		if in.URL != "" {
			out, err = playwrightCLI(30*time.Second, "goto", in.URL)
			if err != nil {
				return nil, nil, fmt.Errorf("tab_new navigate: %w", err)
			}
			return browserActionResult(out, fmt.Sprintf("opened new tab at %s", in.URL)), nil, nil
		}
		return browserActionResult(out, "opened new tab"), nil, nil
	}
}

func tabCloseHandler() func(context.Context, *mcp.CallToolRequest, TabCloseInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in TabCloseInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		args := []string{"tab-close"}
		fallback := "closed current tab"
		if in.Index != nil {
			args = append(args, fmt.Sprintf("%d", *in.Index))
			fallback = fmt.Sprintf("closed tab %d", *in.Index)
		}
		out, err := playwrightCLI(15*time.Second, args...)
		if err != nil {
			return nil, nil, fmt.Errorf("tab_close: %w", err)
		}
		return browserActionResult(out, fallback), nil, nil
	}
}

func uploadHandler() func(context.Context, *mcp.CallToolRequest, UploadInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in UploadInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Path == "" {
			return nil, nil, fmt.Errorf("path is required")
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		out, err := playwrightCLI(30*time.Second, "upload", in.Path)
		if err != nil {
			return nil, nil, fmt.Errorf("upload: %w", err)
		}
		return browserActionResult(out, fmt.Sprintf("uploaded %s", in.Path)), nil, nil
	}
}

func dialogAcceptHandler() func(context.Context, *mcp.CallToolRequest, DialogAcceptInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in DialogAcceptInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		args := []string{"dialog-accept"}
		fallback := "accepted dialog"
		if in.Text != "" {
			args = append(args, in.Text)
			fallback = fmt.Sprintf("accepted dialog with %q", in.Text)
		}
		out, err := playwrightCLI(15*time.Second, args...)
		if err != nil {
			return nil, nil, fmt.Errorf("dialog_accept: %w", err)
		}
		return browserActionResult(out, fallback), nil, nil
	}
}

func dialogDismissHandler() func(context.Context, *mcp.CallToolRequest, DialogDismissInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in DialogDismissInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		unlock, err := lockDesktopMutating(in.Desktop)
		if err != nil {
			return nil, nil, err
		}
		defer unlock()

		out, err := playwrightCLI(15*time.Second, "dialog-dismiss")
		if err != nil {
			return nil, nil, fmt.Errorf("dialog_dismiss: %w", err)
		}
		return browserActionResult(out, "dismissed dialog"), nil, nil
	}
}

func downloadsHandler() func(context.Context, *mcp.CallToolRequest, DownloadsInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in DownloadsInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		entries, err := os.ReadDir("/home/agent/.playwright-cli")
		if err != nil {
			if os.IsNotExist(err) {
				return okResult("no downloads"), nil, nil
			}
			return nil, nil, fmt.Errorf("downloads: %w", err)
		}

		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if isPlaywrightArtifact(name) {
				continue
			}
			names = append(names, name)
		}
		if len(names) == 0 {
			return okResult("no downloads"), nil, nil
		}
		sort.Strings(names)
		return okResult(strings.Join(names, "\n")), nil, nil
	}
}

// extractSnapshotPath finds the YAML file path in snapshot output like:
//
//   - [Snapshot](.playwright-cli/page-2026-03-13T21-29-48-074Z.yml)
func extractSnapshotPath(out string) string {
	for _, line := range strings.Split(out, "\n") {
		if i := strings.Index(line, "[Snapshot]("); i >= 0 {
			rest := line[i+len("[Snapshot]("):]
			if j := strings.Index(rest, ")"); j >= 0 {
				return rest[:j]
			}
		}
	}
	return ""
}

// extractResult pulls the value between "### Result" and the next "###" section.
func extractResult(out string) string {
	lines := strings.Split(out, "\n")
	var result []string
	inResult := false
	for _, line := range lines {
		if strings.HasPrefix(line, "### Result") {
			inResult = true
			continue
		}
		if inResult && strings.HasPrefix(line, "###") {
			break
		}
		if inResult {
			result = append(result, line)
		}
	}
	return strings.TrimSpace(strings.Join(result, "\n"))
}

func clickRefCommand(button string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(button)) {
	case "":
		return "click", nil
	case "dbl", "double":
		return "dblclick", nil
	default:
		return "", fmt.Errorf("button must be empty, dbl, or double")
	}
}

func browserActionResult(out, fallback string) *mcp.CallToolResult {
	if strings.TrimSpace(out) == "" {
		return okResult(fallback)
	}
	return okResult(out)
}

func isPlaywrightArtifact(name string) bool {
	return strings.HasPrefix(name, "console-") && strings.HasSuffix(name, ".log") ||
		strings.HasPrefix(name, "page-") && strings.HasSuffix(name, ".yml")
}
