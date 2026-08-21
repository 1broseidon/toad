//go:build !linux

package screenshot

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
)

// Capture takes a screenshot using platform-specific tools.
func Capture() (*image.NRGBA, error) {
	path := "/tmp/toad-computer-screenshot.png"
	defer os.Remove(path)

	if err := toolScreenshot(path); err != nil {
		return nil, err
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	img, err := png.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode screenshot: %w", err)
	}

	if nrgba, ok := img.(*image.NRGBA); ok {
		return nrgba, nil
	}

	b := img.Bounds()
	out := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			out.Set(x, y, img.At(x, y))
		}
	}
	return out, nil
}

// ScreenSize returns the screen dimensions.
func ScreenSize() ([2]int, error) {
	return [2]int{}, fmt.Errorf("screen size not implemented on this platform")
}

func toolScreenshot(path string) error {
	tools := []struct {
		name string
		args []string
	}{
		{"screencapture", []string{"-x", path}}, // macOS (-x = no sound)
		{"import", []string{"-window", "root", "-silent", path}},
		{"gnome-screenshot", []string{"-f", path}},
	}

	for _, t := range tools {
		if _, err := exec.LookPath(t.name); err == nil {
			cmd := exec.Command(t.name, t.args...)
			if out, err := cmd.CombinedOutput(); err != nil {
				return fmt.Errorf("%s failed: %s", t.name, string(out))
			}
			return nil
		}
	}
	return fmt.Errorf("no screenshot tool found")
}
