// Package a11y queries the OS accessibility tree for UI element data.
package a11y

// Element represents an accessible UI element with name, role, and screen bounds.
type Element struct {
	Name   string   `json:"name"`
	Role   string   `json:"role"`
	Bounds [4]int   `json:"bounds"`           // [x, y, w, h]
	Value  string   `json:"value,omitempty"`  // text content or current value
	States []string `json:"states,omitempty"` // e.g. "checked", "selected", "focused"
}
