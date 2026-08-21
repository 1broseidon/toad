// Package capture takes a screenshot, runs OCR, and outputs structured results.
package capture

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math/big"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"toad.sh/computer/internal/a11y"
	"toad.sh/computer/internal/platform"
	"toad.sh/computer/internal/screenshot"
)

// Element represents a text element found on screen.
type Element struct {
	Text   string   `json:"text"`
	Role   string   `json:"role,omitempty"` // e.g. "push-button", "link" (from accessibility tree)
	Bounds [4]int   `json:"bounds"`         // [x, y, width, height]
	Conf   int      `json:"conf"`
	Center [2]int   `json:"center"`           // [x, y] click target
	Value  string   `json:"value,omitempty"`  // input text content
	States []string `json:"states,omitempty"` // e.g. "checked", "selected"
}

// WindowGroup groups elements by the window they belong to.
type WindowGroup struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Bounds   [4]int    `json:"bounds"` // [x, y, w, h]
	Elements []Element `json:"elements"`
}

// CaptureResult is the structured output agents consume.
type CaptureResult struct {
	CaptureID string        `json:"capture_id"`
	Screen    [2]int        `json:"screen"` // [width, height]
	Windows   []WindowGroup `json:"windows"`
	Ungrouped []Element     `json:"ungrouped,omitempty"`
}

const cacheDir = "/tmp/toad-computer"

// base36Chars is the character set for ID generation.
const base36Chars = "0123456789abcdefghijklmnopqrstuvwxyz"

type lineKey struct {
	block, par, line int
}

type wordInfo struct {
	text             string
	x, y, w, h, conf int
}

// RunSilent captures the screen and returns the result without writing output.
func RunSilent(p platform.Platform) (*CaptureResult, error) {
	id, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("generate capture ID: %w", err)
	}

	// Start a11y query concurrently with screenshot.
	a11yCh := make(chan map[string][]a11y.Element, 1)
	go func() {
		result, _ := a11y.QueryAll()
		a11yCh <- result
	}()

	img, err := screenshot.Capture()
	if err != nil {
		return nil, err
	}

	b := img.Bounds()
	screen := [2]int{b.Dx(), b.Dy()}

	windows, _ := p.ListWindows()
	windows = filterWindows(windows, screen)

	a11yMap := <-a11yCh

	if len(windows) == 0 {
		gray := toGrayscale(img)
		elements, _, err := ocrParseGray(gray)
		if err != nil {
			return nil, err
		}
		return &CaptureResult{CaptureID: id, Screen: screen, Ungrouped: elements}, nil
	}

	groups := captureWindows(img, windows, a11yMap)
	result := &CaptureResult{CaptureID: id, Screen: screen}
	for _, g := range groups {
		if len(g.Elements) > 0 {
			result.Windows = append(result.Windows, g)
		}
	}
	return result, nil
}

// Run captures the screen, extracts text per window in parallel, and writes output.
func Run(p platform.Platform, jsonOutput bool) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("generate capture ID: %w", err)
	}

	// Start a11y query concurrently with screenshot.
	a11yCh := make(chan map[string][]a11y.Element, 1)
	go func() {
		result, _ := a11y.QueryAll()
		a11yCh <- result
	}()

	img, err := screenshot.Capture()
	if err != nil {
		return err
	}

	b := img.Bounds()
	screen := [2]int{b.Dx(), b.Dy()}

	// Save to cache for drill command.
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}
	cachePath := fmt.Sprintf("%s/%s.png", cacheDir, id)
	savePNGAsync(cachePath, img)

	windows, _ := p.ListWindows()
	windows = filterWindows(windows, screen)

	a11yMap := <-a11yCh

	// No windows: fall back to full-image OCR.
	if len(windows) == 0 {
		gray := toGrayscale(img)
		elements, _, ocrErr := ocrParseGray(gray)
		if ocrErr != nil {
			return ocrErr
		}
		return writeOutput(CaptureResult{CaptureID: id, Screen: screen, Ungrouped: elements}, jsonOutput)
	}

	groups := captureWindows(img, windows, a11yMap)

	result := CaptureResult{
		CaptureID: id,
		Screen:    screen,
	}
	for _, g := range groups {
		if len(g.Elements) > 0 {
			result.Windows = append(result.Windows, g)
		}
	}

	return writeOutput(result, jsonOutput)
}

// savePNGAsync writes an image to disk in the background for drill cache.
func savePNGAsync(path string, img image.Image) {
	go func() {
		f, err := os.Create(path)
		if err != nil {
			return
		}
		enc := png.Encoder{CompressionLevel: png.BestSpeed}
		enc.Encode(f, img)
		f.Close()
	}()
}

// windowOCRResult holds the output of a single window's OCR goroutine.
type windowOCRResult struct {
	index int
	group WindowGroup
}

// captureWindows produces elements for each window: a11y when available, OCR otherwise.
// Windows with useful a11y data (more than just the frame) skip OCR entirely.
func captureWindows(img image.Image, windows []platform.Window, a11yMap map[string][]a11y.Element) []WindowGroup {
	results := make([]WindowGroup, len(windows))
	ch := make(chan windowOCRResult, len(windows))
	var wg sync.WaitGroup

	for i, win := range windows {
		if elems := matchA11yWindow(a11yMap, win.Title); len(elems) > 1 {
			converted := convertA11yElements(elems)
			// If a11y has enough useful elements, use them; otherwise fall through to OCR.
			if len(converted) > 2 {
				offsetElements(converted, win.Bounds[0], win.Bounds[1])
				results[i] = WindowGroup{
					ID:       fmt.Sprintf("w%d", i+1),
					Title:    win.Title,
					Bounds:   win.Bounds,
					Elements: converted,
				}
				continue
			}
		}

		wg.Add(1)
		go func(idx int, w platform.Window) {
			defer wg.Done()
			ch <- windowOCRResult{index: idx, group: ocrOneWindow(img, w, idx)}
		}(i, win)
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	for r := range ch {
		results[r.index] = r.group
	}
	return results
}

// matchA11yWindow finds a11y elements for a window by title match.
func matchA11yWindow(a11yMap map[string][]a11y.Element, title string) []a11y.Element {
	if a11yMap == nil {
		return nil
	}
	if elems, ok := a11yMap[title]; ok {
		return elems
	}
	lower := strings.ToLower(title)
	for name, elems := range a11yMap {
		if strings.Contains(strings.ToLower(name), lower) || strings.Contains(lower, strings.ToLower(name)) {
			return elems
		}
	}
	return nil
}

// convertA11yElements converts accessibility elements to capture elements.
func convertA11yElements(elems []a11y.Element) []Element {
	result := make([]Element, 0, len(elems))
	for _, e := range elems {
		// Skip the window frame itself — agent already sees it in WindowGroup.
		if e.Role == "frame" {
			continue
		}
		result = append(result, Element{
			Text:   e.Name,
			Role:   e.Role,
			Bounds: e.Bounds,
			Conf:   100,
			Center: [2]int{e.Bounds[0] + e.Bounds[2]/2, e.Bounds[1] + e.Bounds[3]/2},
			Value:  e.Value,
			States: e.States,
		})
	}
	return result
}

// ocrOneWindow crops the image to window bounds, converts to grayscale, pipes PGM to tesseract.
func ocrOneWindow(img image.Image, win platform.Window, idx int) WindowGroup {
	group := WindowGroup{
		ID:     fmt.Sprintf("w%d", idx+1),
		Title:  win.Title,
		Bounds: win.Bounds,
	}

	gray := grayscaleCrop(img, win.Bounds)
	if gray == nil {
		return group
	}

	// Downscale large crops to speed up tesseract. Scale coordinates back after OCR.
	scale := 1.0
	gray, scale = downscaleIfLarge(gray)

	elements, _, err := ocrParseGray(gray)
	if err != nil {
		return group
	}

	// Scale coordinates back to original crop space, then offset to screen space.
	if scale != 1.0 {
		scaleElements(elements, scale)
	}
	offsetElements(elements, win.Bounds[0], win.Bounds[1])
	group.Elements = elements
	return group
}

// grayscaleCrop extracts a region from img and converts to grayscale.
func grayscaleCrop(img image.Image, bounds [4]int) *image.Gray {
	rect := image.Rect(bounds[0], bounds[1], bounds[0]+bounds[2], bounds[1]+bounds[3])

	type subImager interface {
		SubImage(r image.Rectangle) image.Image
	}
	si, ok := img.(subImager)
	if !ok {
		return nil
	}
	return toGrayscale(si.SubImage(rect))
}

// maxOCRWidth is the threshold above which crops are downscaled for faster tesseract.
const maxOCRWidth = 1200

// downscaleIfLarge halves a grayscale image if it exceeds maxOCRWidth, returning the scale factor.
func downscaleIfLarge(gray *image.Gray) (*image.Gray, float64) {
	b := gray.Bounds()
	if b.Dx() <= maxOCRWidth {
		return gray, 1.0
	}
	// Simple 2x2 average downscale.
	nw, nh := b.Dx()/2, b.Dy()/2
	out := image.NewGray(image.Rect(0, 0, nw, nh))
	for y := range nh {
		for x := range nw {
			sx, sy := x*2, y*2
			v := (uint16(gray.Pix[sy*gray.Stride+sx]) +
				uint16(gray.Pix[sy*gray.Stride+sx+1]) +
				uint16(gray.Pix[(sy+1)*gray.Stride+sx]) +
				uint16(gray.Pix[(sy+1)*gray.Stride+sx+1])) / 4
			out.Pix[y*out.Stride+x] = uint8(v)
		}
	}
	return out, 2.0
}

// scaleElements multiplies element coordinates by the given scale factor.
func scaleElements(elements []Element, scale float64) {
	s := int(scale)
	for i := range elements {
		elements[i].Bounds[0] *= s
		elements[i].Bounds[1] *= s
		elements[i].Bounds[2] *= s
		elements[i].Bounds[3] *= s
		elements[i].Center[0] *= s
		elements[i].Center[1] *= s
	}
}

// encodePGM encodes a grayscale image as PGM (P5 binary) into a byte buffer.
func encodePGM(gray *image.Gray) []byte {
	b := gray.Bounds()
	w, h := b.Dx(), b.Dy()
	header := fmt.Sprintf("P5\n%d %d\n255\n", w, h)

	buf := make([]byte, len(header)+w*h)
	copy(buf, header)
	off := len(header)

	// Copy pixel rows, handling stride != width.
	for y := range h {
		srcOff := y * gray.Stride
		copy(buf[off:], gray.Pix[srcOff:srcOff+w])
		off += w
	}
	return buf
}

// ocrDisabled skips OCR when a11y provides sufficient coverage.
// In Docker with curated Chromium-based apps, a11y alone handles forms,
// navigation, and content reading. OCR is only needed for non-a11y apps.
const ocrDisabled = false

// ocrParseGray pipes a grayscale image to tesseract via stdin as PGM.
func ocrParseGray(gray *image.Gray) ([]Element, [2]int, error) {
	if ocrDisabled {
		return nil, [2]int{}, nil
	}
	if _, err := exec.LookPath("tesseract"); err != nil {
		return nil, [2]int{}, fmt.Errorf("tesseract not found (install tesseract-ocr)")
	}

	pgm := encodePGM(gray)
	cmd := exec.Command("tesseract", "stdin", "stdout", "--psm", "3", "--oem", "1", "tsv")
	cmd.Stdin = bytes.NewReader(pgm)

	out, err := cmd.Output()
	if err != nil {
		return nil, [2]int{}, fmt.Errorf("tesseract failed: %w", err)
	}

	return parseTSVData(string(out))
}

// toGrayscale converts an image to grayscale using luminance weighting.
func toGrayscale(img image.Image) *image.Gray {
	b := img.Bounds()
	gray := image.NewGray(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			// Standard luminance: 0.299R + 0.587G + 0.114B (same as color.GrayModel).
			lum := (19595*r + 38470*g + 7471*bl + 1<<15) >> 24
			gray.SetGray(x-b.Min.X, y-b.Min.Y, color.Gray{Y: uint8(lum)})
		}
	}
	return gray
}

// generateID produces an 8-character base36 ID using crypto/rand.
func generateID() (string, error) {
	base := big.NewInt(int64(len(base36Chars)))
	buf := make([]byte, 8)
	for i := range buf {
		n, err := rand.Int(rand.Reader, base)
		if err != nil {
			return "", err
		}
		buf[i] = base36Chars[n.Int64()]
	}
	return string(buf), nil
}

// ocrParse runs tesseract on the image and returns parsed elements and screen size.
func ocrParse(imagePath string) ([]Element, [2]int, error) {
	if _, err := exec.LookPath("tesseract"); err != nil {
		return nil, [2]int{}, fmt.Errorf("tesseract not found (install tesseract-ocr)")
	}

	out, err := exec.Command("tesseract", imagePath, "stdout", "--psm", "3", "--oem", "1", "tsv").Output()
	if err != nil {
		return nil, [2]int{}, fmt.Errorf("tesseract failed: %w", err)
	}

	return parseTSVData(string(out))
}

// parseTSVData parses tesseract TSV output into elements.
func parseTSVData(tsv string) ([]Element, [2]int, error) {
	lines := strings.Split(strings.TrimSpace(tsv), "\n")
	if len(lines) < 2 {
		return nil, [2]int{}, fmt.Errorf("no OCR data returned")
	}

	screen := [2]int{}
	grouped := make(map[lineKey][]wordInfo)
	var order []lineKey

	for _, row := range lines[1:] {
		fields := strings.Split(row, "\t")
		if len(fields) < 12 {
			continue
		}
		parseRow(fields, &screen, grouped, &order)
	}

	elements := mergeWords(grouped, order)
	elements = filterGarbage(elements)
	computeCenters(elements)

	return elements, screen, nil
}

func parseRow(fields []string, screen *[2]int, grouped map[lineKey][]wordInfo, order *[]lineKey) {
	level, _ := strconv.Atoi(fields[0])

	if level == 1 {
		w, _ := strconv.Atoi(fields[8])
		h, _ := strconv.Atoi(fields[9])
		if w > 0 && h > 0 {
			*screen = [2]int{w, h}
		}
		return
	}

	if level != 5 {
		return
	}

	text := strings.TrimSpace(fields[11])
	if text == "" {
		return
	}

	conf, _ := strconv.Atoi(fields[10])
	if conf < 0 {
		return
	}

	x, _ := strconv.Atoi(fields[6])
	y, _ := strconv.Atoi(fields[7])
	w, _ := strconv.Atoi(fields[8])
	h, _ := strconv.Atoi(fields[9])

	block, _ := strconv.Atoi(fields[2])
	par, _ := strconv.Atoi(fields[3])
	ln, _ := strconv.Atoi(fields[4])
	key := lineKey{block, par, ln}

	if _, seen := grouped[key]; !seen {
		*order = append(*order, key)
	}
	grouped[key] = append(grouped[key], wordInfo{text, x, y, w, h, conf})
}

func mergeWords(grouped map[lineKey][]wordInfo, order []lineKey) []Element {
	var elements []Element
	for _, key := range order {
		words := grouped[key]
		if len(words) == 0 {
			continue
		}

		var texts []string
		minX, minY := words[0].x, words[0].y
		maxX2, maxY2 := words[0].x+words[0].w, words[0].y+words[0].h
		confSum := 0

		for _, w := range words {
			texts = append(texts, w.text)
			if w.x < minX {
				minX = w.x
			}
			if w.y < minY {
				minY = w.y
			}
			if w.x+w.w > maxX2 {
				maxX2 = w.x + w.w
			}
			if w.y+w.h > maxY2 {
				maxY2 = w.y + w.h
			}
			confSum += w.conf
		}

		elements = append(elements, Element{
			Text:   strings.Join(texts, " "),
			Bounds: [4]int{minX, minY, maxX2 - minX, maxY2 - minY},
			Conf:   confSum / len(words),
		})
	}
	return elements
}

// isGarbage returns true if the text is OCR noise that should be filtered.
func isGarbage(text string) bool {
	if len([]rune(text)) < 3 {
		return true
	}

	alphanumeric := 0
	total := 0
	hasLetter := false

	for _, r := range text {
		if unicode.IsSpace(r) {
			continue
		}
		total++
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			alphanumeric++
		}
		if unicode.IsLetter(r) {
			hasLetter = true
		}
	}

	if total == 0 {
		return true
	}

	if !hasLetter {
		return true
	}

	if alphanumeric*2 < total {
		return true
	}

	return false
}

// filterGarbage removes OCR noise from elements.
func filterGarbage(elements []Element) []Element {
	var clean []Element
	for _, e := range elements {
		if !isGarbage(e.Text) {
			clean = append(clean, e)
		}
	}
	return clean
}

// computeCenters fills in the Center field for each element.
func computeCenters(elements []Element) {
	for i := range elements {
		b := elements[i].Bounds
		elements[i].Center = [2]int{b[0] + b[2]/2, b[1] + b[3]/2}
	}
}

// filterWindows removes off-screen, full-screen background, and desktop
// infrastructure windows, then sorts smallest-area-first for matching.
func filterWindows(windows []platform.Window, screen [2]int) []platform.Window {
	var visible []platform.Window
	screenArea := screen[0] * screen[1]

	for _, w := range windows {
		// Skip off-screen / other workspace windows.
		if w.Bounds[0] < 0 || w.Bounds[1] < 0 {
			continue
		}
		// Skip windows covering the entire screen (e.g. Parsec, remote desktop).
		area := w.Bounds[2] * w.Bounds[3]
		if area >= screenArea {
			continue
		}
		// Skip known desktop infrastructure.
		lower := strings.ToLower(w.Title)
		if lower == "plank" || lower == "vhd-dock" || strings.HasPrefix(lower, "conky") {
			continue
		}
		visible = append(visible, w)
	}

	// Sort smallest area first so elements match the most specific window.
	sort.Slice(visible, func(i, j int) bool {
		ai := visible[i].Bounds[2] * visible[i].Bounds[3]
		aj := visible[j].Bounds[2] * visible[j].Bounds[3]
		return ai < aj
	})

	return visible
}

// Screenshot takes a raw PNG screenshot and saves it to path.
// If path is empty, saves to /tmp/toad-computer/<id>.png.
// Returns the path where the file was saved.
func Screenshot(path string) (string, error) {
	img, err := screenshot.Capture()
	if err != nil {
		return "", err
	}
	if path == "" {
		if err := os.MkdirAll(cacheDir, 0o700); err != nil {
			return "", err
		}
		id, err := generateID()
		if err != nil {
			return "", err
		}
		path = fmt.Sprintf("%s/%s.png", cacheDir, id)
	}
	f, err := os.Create(path)
	if err != nil {
		return "", fmt.Errorf("create screenshot: %w", err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return "", fmt.Errorf("encode png: %w", err)
	}
	return path, nil
}

// Clean removes all cached screenshots.
func Clean() error {
	return os.RemoveAll(cacheDir)
}
