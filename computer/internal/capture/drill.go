package capture

import (
	"fmt"
	"image"
	"image/png"
	"os"

	"toad.computer/internal/platform"
)

// Drill loads a cached screenshot, crops to the target window, re-OCRs, and outputs results.
func Drill(p platform.Platform, captureID, targetID string, jsonOutput bool) error {
	path := fmt.Sprintf("%s/%s.png", cacheDir, captureID)
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("capture %q not found (looked for %s)", captureID, path)
	}

	windows, err := p.ListWindows()
	if err != nil {
		return fmt.Errorf("list windows: %w", err)
	}

	win, idx, err := findWindow(windows, targetID)
	if err != nil {
		return err
	}

	cropPath, err := cropImage(path, win.Bounds)
	if err != nil {
		return fmt.Errorf("crop image: %w", err)
	}
	defer os.Remove(cropPath)

	elements, screen, err := ocrParse(cropPath)
	if err != nil {
		return err
	}

	// Offset element coordinates back to screen space.
	offsetElements(elements, win.Bounds[0], win.Bounds[1])

	wg := WindowGroup{
		ID:       fmt.Sprintf("w%d", idx+1),
		Title:    win.Title,
		Bounds:   win.Bounds,
		Elements: elements,
	}

	result := CaptureResult{
		CaptureID: captureID,
		Screen:    screen,
		Windows:   []WindowGroup{wg},
	}

	return writeOutput(result, jsonOutput)
}

// findWindow looks up a window by its short ID (w1, w2, ...) or wmctrl hex ID.
func findWindow(windows []platform.Window, targetID string) (platform.Window, int, error) {
	// Try short ID format: w1, w2, etc.
	for i, w := range windows {
		shortID := fmt.Sprintf("w%d", i+1)
		if targetID == shortID {
			return w, i, nil
		}
	}

	// Try matching by raw window ID (e.g., 0x04a00003).
	for i, w := range windows {
		if w.ID == targetID {
			return w, i, nil
		}
	}

	return platform.Window{}, 0, fmt.Errorf("window %q not found", targetID)
}

// cropImage decodes a PNG, crops to the given bounds, and saves to a temp file.
func cropImage(srcPath string, bounds [4]int) (string, error) {
	f, err := os.Open(srcPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	img, err := png.Decode(f)
	if err != nil {
		return "", fmt.Errorf("decode png: %w", err)
	}

	rect := image.Rect(bounds[0], bounds[1], bounds[0]+bounds[2], bounds[1]+bounds[3])

	type subImager interface {
		SubImage(r image.Rectangle) image.Image
	}
	si, ok := img.(subImager)
	if !ok {
		return "", fmt.Errorf("image type %T does not support SubImage", img)
	}
	cropped := si.SubImage(rect)

	tmp, err := os.CreateTemp("", "toad-crop-*.png")
	if err != nil {
		return "", err
	}
	defer tmp.Close()

	if err := png.Encode(tmp, cropped); err != nil {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("encode cropped png: %w", err)
	}

	return tmp.Name(), nil
}

// offsetElements shifts element coordinates by dx, dy to convert from crop space to screen space.
func offsetElements(elements []Element, dx, dy int) {
	for i := range elements {
		elements[i].Bounds[0] += dx
		elements[i].Bounds[1] += dy
		elements[i].Center[0] += dx
		elements[i].Center[1] += dy
	}
}
