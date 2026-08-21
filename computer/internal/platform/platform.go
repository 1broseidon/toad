// Package platform defines the interface for OS-specific input and window operations.
package platform

// Window represents a visible window on the desktop.
type Window struct {
	ID      string
	Title   string
	Bounds  [4]int // x, y, w, h
	Desktop int    // workspace index
}

// Platform abstracts OS-specific input simulation and window enumeration.
type Platform interface {
	ListWindows() ([]Window, error)
	Click(x, y int) error
	DoubleClick(x, y int) error
	RightClick(x, y int) error
	Drag(x1, y1, x2, y2 int) error
	Move(x, y int) error
	Scroll(x, y, clicks int) error // positive = up, negative = down
	Type(text string) error
	Key(combo string) error
	Paste(text string) error        // set clipboard and Ctrl+V
	GetClipboard() (string, error)  // read clipboard text
	SetClipboard(text string) error // set clipboard without pasting
	Focus(windowID string) error
	CloseWindow(windowID string) error
	MaximizeWindow(windowID string) error
	UnmaximizeWindow(windowID string) error
	MoveResizeWindow(windowID string, x, y, w, h int) error
}
