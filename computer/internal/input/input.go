// Package input provides screen interaction primitives delegating to the platform backend.
package input

import "toad.sh/computer/internal/platform"

// Click moves the mouse to (x, y) and clicks.
func Click(p platform.Platform, x, y int) error {
	return p.Click(x, y)
}

// DoubleClick moves the mouse to (x, y) and double-clicks.
func DoubleClick(p platform.Platform, x, y int) error {
	return p.DoubleClick(x, y)
}

// RightClick moves the mouse to (x, y) and right-clicks.
func RightClick(p platform.Platform, x, y int) error {
	return p.RightClick(x, y)
}

// Drag moves the mouse from (x1, y1) to (x2, y2) while holding the left button.
func Drag(p platform.Platform, x1, y1, x2, y2 int) error {
	return p.Drag(x1, y1, x2, y2)
}

// Move moves the mouse to (x, y) without clicking.
func Move(p platform.Platform, x, y int) error {
	return p.Move(x, y)
}

// Scroll moves to (x, y) and scrolls by n clicks (positive=up, negative=down).
func Scroll(p platform.Platform, x, y, clicks int) error {
	return p.Scroll(x, y, clicks)
}

// Type types a string with zero inter-key delay.
func Type(p platform.Platform, text string) error {
	return p.Type(text)
}

// Key sends a key combination (e.g. "ctrl+s", "Return", "alt+F4").
func Key(p platform.Platform, combo string) error {
	return p.Key(combo)
}

// Paste sets the clipboard to text and sends Ctrl+V.
func Paste(p platform.Platform, text string) error {
	return p.Paste(text)
}

// GetClipboard reads the current clipboard text.
func GetClipboard(p platform.Platform) (string, error) {
	return p.GetClipboard()
}

// SetClipboard writes text to the clipboard without pasting.
func SetClipboard(p platform.Platform, text string) error {
	return p.SetClipboard(text)
}

// Focus activates a window by its ID.
func Focus(p platform.Platform, windowID string) error {
	return p.Focus(windowID)
}

// CloseWindow closes a window by its ID.
func CloseWindow(p platform.Platform, windowID string) error {
	return p.CloseWindow(windowID)
}
