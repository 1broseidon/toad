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

type RunInput struct {
	Steps          []map[string]any `json:"steps" jsonschema:"ordered run steps"`
	StopOnError    *bool            `json:"stop_on_error,omitempty" jsonschema:"stop after the first failed step (default true)"`
	SettleMS       *int             `json:"settle_ms,omitempty" jsonschema:"delay between steps in milliseconds (default 40)"`
	CaptureAfter   string           `json:"capture_after,omitempty" jsonschema:"capture timing: final, each, or none (default final)"`
	CaptureOnError *bool            `json:"capture_on_error,omitempty" jsonschema:"capture the screen when a step fails (default true)"`
}

type RunStepResult struct {
	Index      int    `json:"index"`
	OK         bool   `json:"ok"`
	DurationMS int64  `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
	Capture    string `json:"capture,omitempty"`
}

type RunResult struct {
	Steps           []RunStepResult `json:"steps"`
	Capture         string          `json:"capture,omitempty"`
	TotalDurationMS int64           `json:"total_duration_ms"`
}

type runOptions struct {
	stopOnError    bool
	settle         time.Duration
	captureAfter   string
	captureOnError bool
}

func runHandler(p platform.Platform) func(context.Context, *mcp.CallToolRequest, RunInput) (*mcp.CallToolResult, RunResult, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in RunInput) (*mcp.CallToolResult, RunResult, error) {
		if err := requirePlatform(p); err != nil {
			return nil, RunResult{}, err
		}

		releaseSlot, err := claimRunSlot(req)
		if err != nil {
			return nil, RunResult{}, err
		}
		defer releaseSlot()

		opts, err := normalizeRunOptions(in)
		if err != nil {
			return nil, RunResult{}, err
		}

		unlock, err := lockMutating()
		if err != nil {
			return nil, RunResult{}, err
		}
		defer unlock()

		result := executeRunSteps(p, in.Steps, opts)
		return nil, result, nil
	}
}

func executeRunSteps(p platform.Platform, steps []map[string]any, opts runOptions) RunResult {
	start := time.Now()
	result := RunResult{Steps: make([]RunStepResult, 0, len(steps))}

	for idx, step := range steps {
		if time.Since(start) >= runBudget() {
			result.Steps = append(result.Steps, RunStepResult{
				Index: idx, OK: false,
				Error: fmt.Sprintf("run budget exceeded after %dms", result.TotalDurationMS),
			})
			break
		}

		sr := runOneStep(p, idx, step, &result, opts)
		result.Steps = append(result.Steps, sr)
		result.TotalDurationMS = time.Since(start).Milliseconds()

		if sr.Error != "" && opts.stopOnError {
			break
		}
		if idx < len(steps)-1 && opts.settle > 0 {
			time.Sleep(opts.settle)
		}
	}

	if result.TotalDurationMS == 0 {
		result.TotalDurationMS = time.Since(start).Milliseconds()
	}
	if shouldCaptureFinal(result, opts) {
		if text, err := captureText(p); err == nil {
			result.Capture = text
		}
	}
	return result
}

func runOneStep(p platform.Platform, idx int, step map[string]any, result *RunResult, opts runOptions) RunStepResult {
	stepStart := time.Now()
	stepErr := executeRunStep(p, step)
	sr := RunStepResult{
		Index:      idx,
		OK:         stepErr == nil,
		DurationMS: time.Since(stepStart).Milliseconds(),
	}
	if stepErr != nil {
		sr.Error = stepErr.Error()
	}
	if opts.captureAfter == "each" {
		if text, err := captureText(p); err == nil {
			sr.Capture = text
		}
	} else if stepErr != nil && opts.captureOnError {
		if text, err := captureText(p); err == nil {
			result.Capture = text
		}
	}
	return sr
}

func normalizeRunOptions(in RunInput) (runOptions, error) {
	if len(in.Steps) == 0 {
		return runOptions{}, fmt.Errorf("steps is required")
	}
	if len(in.Steps) > runMaxSteps() {
		return runOptions{}, fmt.Errorf("too many steps: got %d, max %d", len(in.Steps), runMaxSteps())
	}

	opts := runOptions{
		stopOnError:    true,
		settle:         runDefaultSettle(),
		captureAfter:   "final",
		captureOnError: true,
	}
	if in.StopOnError != nil {
		opts.stopOnError = *in.StopOnError
	}
	if in.CaptureOnError != nil {
		opts.captureOnError = *in.CaptureOnError
	}
	if in.SettleMS != nil {
		if *in.SettleMS < 0 {
			return runOptions{}, fmt.Errorf("settle_ms must be >= 0")
		}
		opts.settle = time.Duration(*in.SettleMS) * time.Millisecond
	}
	if in.CaptureAfter != "" {
		opts.captureAfter = in.CaptureAfter
	}
	switch opts.captureAfter {
	case "final", "each", "none":
		return opts, nil
	default:
		return runOptions{}, fmt.Errorf("capture_after must be one of final, each, none")
	}
}

func executeRunStep(p platform.Platform, step map[string]any) error {
	action, err := stepAction(step)
	if err != nil {
		return err
	}

	switch action {
	case "click", "dclick", "rclick", "move":
		return executeXYStep(p, action, step)
	case "paste", "key", "type", "focus":
		return executeTextStep(p, action, step)
	case "scroll":
		return executeScrollStep(p, step)
	case "drag":
		return executeDragStep(p, step)
	case "navigate":
		return executeNavigateStep(step)
	case "click_ref", "fill", "select_option", "check", "uncheck", "hover", "tab_select", "tab_new", "tab_close", "upload", "dialog_accept", "dialog_dismiss":
		return executeBrowserRunStep(action, step)
	case "wait":
		return executeWaitStep(p, step)
	case "exec":
		return executeExecStep(step)
	case "launch":
		return executeLaunchStep(step)
	default:
		return fmt.Errorf("action %q is not allowed", action)
	}
}

func executeXYStep(p platform.Platform, action string, step map[string]any) error {
	x, y, err := stepXY(step)
	if err != nil {
		return err
	}
	switch action {
	case "click":
		return input.Click(p, x, y)
	case "dclick":
		return input.DoubleClick(p, x, y)
	case "rclick":
		return input.RightClick(p, x, y)
	case "move":
		return input.Move(p, x, y)
	}
	return nil
}

func executeTextStep(p platform.Platform, action string, step map[string]any) error {
	paramMap := map[string]string{"paste": "text", "key": "combo", "type": "text", "focus": "window_id"}
	param := paramMap[action]
	value, err := stepString(step, param)
	if err != nil {
		return err
	}
	switch action {
	case "paste":
		return input.Paste(p, value)
	case "key":
		return input.Key(p, value)
	case "type":
		return input.Type(p, value)
	case "focus":
		return input.Focus(p, value)
	}
	return nil
}

func executeScrollStep(p platform.Platform, step map[string]any) error {
	x, y, err := stepXY(step)
	if err != nil {
		return err
	}
	clicks, err := stepInt(step, "clicks")
	if err != nil {
		return err
	}
	return input.Scroll(p, x, y, clicks)
}

func executeDragStep(p platform.Platform, step map[string]any) error {
	x1, err := stepInt(step, "x1")
	if err != nil {
		return err
	}
	y1, err := stepInt(step, "y1")
	if err != nil {
		return err
	}
	x2, err := stepInt(step, "x2")
	if err != nil {
		return err
	}
	y2, err := stepInt(step, "y2")
	if err != nil {
		return err
	}
	return input.Drag(p, x1, y1, x2, y2)
}

func executeNavigateStep(step map[string]any) error {
	url, err := stepString(step, "url")
	if err != nil {
		return err
	}
	_, err = navigateBrowser(url)
	return err
}

func executeWaitStep(p platform.Platform, step map[string]any) error {
	text, err := stepString(step, "text")
	if err != nil {
		return err
	}
	timeout := 10 * time.Second
	if raw, ok := step["timeout"]; ok {
		seconds, err := stepAnyInt(raw)
		if err != nil {
			return fmt.Errorf("timeout must be an integer")
		}
		timeout = time.Duration(seconds) * time.Second
	}
	if timeout > runMaxWait() {
		return fmt.Errorf("wait timeout exceeds max of %ds", int(runMaxWait()/time.Second))
	}
	return waitForText(p, text, timeout)
}

func executeExecStep(step map[string]any) error {
	command, err := stepString(step, "command")
	if err != nil {
		return err
	}
	args, err := stepOptionalStrings(step, "args")
	if err != nil {
		return err
	}
	cwd, err := stepOptionalString(step, "cwd")
	if err != nil {
		return err
	}

	in := ExecInput{
		Command: command,
		Args:    args,
		Cwd:     cwd,
	}
	if raw, ok := step["timeout"]; ok {
		n, err := stepAnyInt(raw)
		if err != nil {
			return fmt.Errorf("timeout must be an integer")
		}
		in.Timeout = n
	}
	if raw, ok := step["max_output"]; ok {
		n, err := stepAnyInt(raw)
		if err != nil {
			return fmt.Errorf("max_output must be an integer")
		}
		in.MaxOutput = n
	}

	result, err := executeExec(context.Background(), in)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("exec exited with code %d", result.ExitCode)
	}
	return nil
}

func executeLaunchStep(step map[string]any) error {
	command, err := stepString(step, "command")
	if err != nil {
		return err
	}
	args, err := stepOptionalStrings(step, "args")
	if err != nil {
		return err
	}
	allArgs := append([]string{command}, args...)
	return workspace.Exec(allArgs)
}

func executeBrowserRunStep(action string, step map[string]any) error {
	switch action {
	case "click_ref", "fill", "select_option", "check", "uncheck", "hover":
		return executeRefRunStep(action, step)
	case "tab_select", "tab_new", "tab_close", "upload", "dialog_accept", "dialog_dismiss":
		return executeTabFileRunStep(action, step)
	}
	return fmt.Errorf("action %q is not allowed", action)
}

func executeRefRunStep(action string, step map[string]any) error {
	ref, err := stepString(step, "ref")
	if err != nil {
		return err
	}
	switch action {
	case "click_ref":
		button, err := stepOptionalString(step, "button")
		if err != nil {
			return err
		}
		command, err := clickRefCommand(button)
		if err != nil {
			return err
		}
		_, err = playwrightCLI(15*time.Second, command, ref)
		return err
	case "fill":
		text, err := stepString(step, "text")
		if err != nil {
			return err
		}
		_, err = playwrightCLI(15*time.Second, "fill", ref, text)
		return err
	case "select_option":
		value, err := stepString(step, "value")
		if err != nil {
			return err
		}
		_, err = playwrightCLI(15*time.Second, "select", ref, value)
		return err
	case "check", "uncheck":
		cmd := "check"
		if action == "uncheck" {
			cmd = "uncheck"
		} else if unc, _ := stepOptionalBool(step, "uncheck"); unc {
			cmd = "uncheck"
		}
		_, err = playwrightCLI(15*time.Second, cmd, ref)
		return err
	case "hover":
		_, err = playwrightCLI(15*time.Second, "hover", ref)
		return err
	}
	return nil
}

func executeTabFileRunStep(action string, step map[string]any) error {
	switch action {
	case "tab_select":
		index, err := stepInt(step, "index")
		if err != nil {
			return err
		}
		_, err = playwrightCLI(15*time.Second, "tab-select", fmt.Sprintf("%d", index))
		return err
	case "tab_new":
		args := []string{"tab-new"}
		if url, _ := stepOptionalString(step, "url"); url != "" {
			args = append(args, url)
		}
		_, err := playwrightCLI(15*time.Second, args...)
		return err
	case "tab_close":
		args := []string{"tab-close"}
		if raw, ok := step["index"]; ok {
			idx, err := stepAnyInt(raw)
			if err != nil {
				return fmt.Errorf("index must be an integer")
			}
			args = append(args, fmt.Sprintf("%d", idx))
		}
		_, err := playwrightCLI(15*time.Second, args...)
		return err
	case "upload":
		path, err := stepString(step, "path")
		if err != nil {
			return err
		}
		_, err = playwrightCLI(30*time.Second, "upload", path)
		return err
	case "dialog_accept":
		text, _ := stepOptionalString(step, "text")
		args := []string{"dialog-accept"}
		if text != "" {
			args = append(args, text)
		}
		_, err := playwrightCLI(15*time.Second, args...)
		return err
	case "dialog_dismiss":
		_, err := playwrightCLI(15*time.Second, "dialog-dismiss")
		return err
	}
	return nil
}

func shouldCaptureFinal(result RunResult, opts runOptions) bool {
	if opts.captureAfter == "final" {
		return true
	}
	return result.Capture == "" && opts.captureOnError && runFailed(result)
}

func runFailed(result RunResult) bool {
	for _, step := range result.Steps {
		if !step.OK {
			return true
		}
	}
	return false
}

func captureText(p platform.Platform) (string, error) {
	result, err := capture.RunSilent(p)
	if err != nil {
		return "", err
	}
	return capture.FormatText(*result), nil
}

func waitForText(p platform.Platform, text string, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	deadline := time.Now().Add(timeout)
	needle := strings.ToLower(text)
	for time.Now().Before(deadline) {
		result, err := capture.RunSilent(p)
		if err == nil && matchText(result, needle) {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("timeout: %q not found after %ds", text, int(timeout/time.Second))
}

func stepAction(step map[string]any) (string, error) {
	action, err := stepString(step, "action")
	if err != nil {
		return "", err
	}
	return strings.ToLower(action), nil
}

func stepXY(step map[string]any) (int, int, error) {
	x, err := stepInt(step, "x")
	if err != nil {
		return 0, 0, err
	}
	y, err := stepInt(step, "y")
	if err != nil {
		return 0, 0, err
	}
	return x, y, nil
}

func stepString(step map[string]any, key string) (string, error) {
	value, ok := step[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	text, ok := value.(string)
	if !ok || text == "" {
		return "", fmt.Errorf("%s must be a non-empty string", key)
	}
	return text, nil
}

func stepOptionalString(step map[string]any, key string) (string, error) {
	value, ok := step[key]
	if !ok {
		return "", nil
	}
	text, ok := value.(string)
	if !ok || text == "" {
		return "", fmt.Errorf("%s must be a non-empty string", key)
	}
	return text, nil
}

func stepInt(step map[string]any, key string) (int, error) {
	value, ok := step[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", key)
	}
	n, err := stepAnyInt(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return n, nil
}

func stepOptionalBool(step map[string]any, key string) (bool, error) {
	value, ok := step[key]
	if !ok {
		return false, nil
	}
	b, ok := value.(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return b, nil
}

func stepOptionalStrings(step map[string]any, key string) ([]string, error) {
	value, ok := step[key]
	if !ok {
		return nil, nil
	}
	switch items := value.(type) {
	case []string:
		return append([]string(nil), items...), nil
	case []any:
		out := make([]string, 0, len(items))
		for _, item := range items {
			text, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("%s must be an array of strings", key)
			}
			out = append(out, text)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
}

func stepAnyInt(value any) (int, error) {
	switch n := value.(type) {
	case float64:
		if float64(int(n)) != n {
			return 0, fmt.Errorf("not an integer")
		}
		return int(n), nil
	case int:
		return n, nil
	case int32:
		return int(n), nil
	case int64:
		return int(n), nil
	default:
		return 0, fmt.Errorf("not an integer")
	}
}
