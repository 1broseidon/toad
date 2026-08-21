//go:build !linux

package platform

import (
	"fmt"
	"runtime"
)

func newPlatform() (Platform, error) {
	return nil, fmt.Errorf("platform %q is not supported (only linux is implemented)", runtime.GOOS)
}
