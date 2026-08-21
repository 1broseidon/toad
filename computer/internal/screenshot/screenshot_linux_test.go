//go:build linux

package screenshot

import (
	"testing"
	"time"
)

func TestCapture(t *testing.T) {
	start := time.Now()
	img, err := Capture()
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("Capture: %v", err)
	}

	b := img.Bounds()
	t.Logf("captured %dx%d in %s", b.Dx(), b.Dy(), elapsed)

	if b.Dx() < 640 || b.Dy() < 480 {
		t.Errorf("image too small: %dx%d", b.Dx(), b.Dy())
	}

	// Sanity: check a few pixels aren't all black.
	nonBlack := 0
	for y := 0; y < b.Dy(); y += 100 {
		for x := 0; x < b.Dx(); x += 100 {
			r, g, bl, _ := img.At(x, y).RGBA()
			if r > 0 || g > 0 || bl > 0 {
				nonBlack++
			}
		}
	}
	t.Logf("non-black sampled pixels: %d", nonBlack)
	if nonBlack == 0 {
		t.Error("all sampled pixels are black")
	}
}

func TestScreenSize(t *testing.T) {
	size, err := ScreenSize()
	if err != nil {
		t.Fatalf("ScreenSize: %v", err)
	}
	t.Logf("screen: %dx%d", size[0], size[1])
	if size[0] < 640 || size[1] < 480 {
		t.Errorf("screen too small: %v", size)
	}
}
