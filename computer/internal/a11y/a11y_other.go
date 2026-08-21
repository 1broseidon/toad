//go:build !linux

package a11y

import "fmt"

// Query is not supported on this platform.
func Query(windowTitle string) ([]Element, error) {
	return nil, fmt.Errorf("accessibility tree not supported on this platform")
}

// QueryAll is not supported on this platform.
func QueryAll() (map[string][]Element, error) {
	return nil, fmt.Errorf("accessibility tree not supported on this platform")
}

// Available returns false on unsupported platforms.
func Available() bool {
	return false
}
