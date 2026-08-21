package capture

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// FormatText formats a capture result as compact text for agent consumption.
func FormatText(result CaptureResult) string {
	var buf bytes.Buffer
	writeText(&buf, result)
	return buf.String()
}

// writeOutput writes the capture result in plain text or JSON format.
func writeOutput(result CaptureResult, jsonOutput bool) error {
	if jsonOutput {
		return writeJSON(os.Stdout, result)
	}
	return writeText(os.Stdout, result)
}

func writeJSON(w io.Writer, result CaptureResult) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(result)
}

func writeText(w io.Writer, result CaptureResult) error {
	fmt.Fprintf(w, "id:%s\n", result.CaptureID)
	fmt.Fprintf(w, "screen:%dx%d\n", result.Screen[0], result.Screen[1])

	for _, wg := range result.Windows {
		fmt.Fprintln(w)
		fmt.Fprintf(w, "[%s %s %d,%d %dx%d]\n",
			wg.ID, truncate(wg.Title, 60),
			wg.Bounds[0], wg.Bounds[1], wg.Bounds[2], wg.Bounds[3])
		for _, e := range wg.Elements {
			writeElement(w, e)
		}
	}

	if len(result.Ungrouped) > 0 {
		fmt.Fprintln(w)
		fmt.Fprintln(w, "[ungrouped]")
		for _, e := range result.Ungrouped {
			fmt.Fprintf(w, "%d,%d %s\n", e.Center[0], e.Center[1], truncate(e.Text, 200))
		}
	}

	return nil
}

// writeElement formats a single element to the text output.
func writeElement(w io.Writer, e Element) {
	var suffix string
	if e.Value != "" {
		suffix += fmt.Sprintf(" =%q", truncate(e.Value, 200))
	}
	if len(e.States) > 0 {
		suffix += " {" + strings.Join(e.States, ",") + "}"
	}
	if e.Role != "" {
		fmt.Fprintf(w, "%d,%d [%s] %s%s\n", e.Center[0], e.Center[1], e.Role, truncate(e.Text, 200), suffix)
	} else {
		fmt.Fprintf(w, "%d,%d %s%s\n", e.Center[0], e.Center[1], truncate(e.Text, 200), suffix)
	}
}

// truncate trims text to maxLen runes, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen-3]) + "..."
}
