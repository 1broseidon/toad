//go:build linux

// Package screenshot captures the screen via X11 GetImage — no external tools, no focus stealing.
package screenshot

import (
	"encoding/binary"
	"fmt"
	"image"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
)

// Capture takes a screenshot of the entire X11 root window.
// Uses the X11 wire protocol directly over a Unix socket.
// No server grab, no compositor interaction, no focus changes.
func Capture() (*image.NRGBA, error) {
	display := os.Getenv("DISPLAY")
	if display == "" {
		display = ":0"
	}

	sockPath, displayNum, err := parseDisplay(display)
	if err != nil {
		return nil, err
	}

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return nil, fmt.Errorf("x11 connect: %w", err)
	}
	defer conn.Close()

	authName, authData := readXauthority(displayNum)
	if err := sendSetup(conn, authName, authData); err != nil {
		return nil, err
	}

	root, w, h, bpp, err := readSetup(conn)
	if err != nil {
		return nil, err
	}

	return getImage(conn, root, w, h, bpp)
}

// parseDisplay extracts the Unix socket path and display number from $DISPLAY.
func parseDisplay(display string) (string, int, error) {
	colonIdx := strings.LastIndex(display, ":")
	if colonIdx < 0 {
		return "", 0, fmt.Errorf("invalid DISPLAY: %s", display)
	}

	numStr := display[colonIdx+1:]
	if dotIdx := strings.Index(numStr, "."); dotIdx >= 0 {
		numStr = numStr[:dotIdx]
	}

	num, err := strconv.Atoi(numStr)
	if err != nil {
		return "", 0, fmt.Errorf("invalid display number: %s", numStr)
	}

	return fmt.Sprintf("/tmp/.X11-unix/X%d", num), num, nil
}

// readXauthority finds the MIT-MAGIC-COOKIE-1 entry for the given display.
func readXauthority(displayNum int) (name, data []byte) {
	path := os.Getenv("XAUTHORITY")
	if path == "" {
		home, _ := os.UserHomeDir()
		path = home + "/.Xauthority"
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, nil
	}
	defer f.Close()

	dispStr := strconv.Itoa(displayNum)

	for {
		var family uint16
		if err := binary.Read(f, binary.BigEndian, &family); err != nil {
			break
		}

		readXauthBytes(f) // addr (not needed for matching)
		num := readXauthBytes(f)
		aName := readXauthBytes(f)
		aData := readXauthBytes(f)

		if aName == nil {
			break
		}

		// Match by display number. Family 256=FamilyLocal, 65535=FamilyWild.
		if string(num) == dispStr || family == 65535 {
			return aName, aData
		}
	}

	return nil, nil
}

func readXauthBytes(f *os.File) []byte {
	var length uint16
	if err := binary.Read(f, binary.BigEndian, &length); err != nil {
		return nil
	}
	data := make([]byte, length)
	if _, err := io.ReadFull(f, data); err != nil {
		return nil
	}
	return data
}

// sendSetup sends the X11 connection setup request.
func sendSetup(conn net.Conn, authName, authData []byte) error {
	nameLen := len(authName)
	dataLen := len(authData)

	total := 12 + nameLen + pad4(nameLen) + dataLen + pad4(dataLen)
	buf := make([]byte, total)

	buf[0] = 'l'                                // little-endian
	binary.LittleEndian.PutUint16(buf[2:4], 11) // protocol major
	binary.LittleEndian.PutUint16(buf[6:8], uint16(nameLen))
	binary.LittleEndian.PutUint16(buf[8:10], uint16(dataLen))

	copy(buf[12:], authName)
	copy(buf[12+nameLen+pad4(nameLen):], authData)

	_, err := conn.Write(buf)
	return err
}

// readSetup reads the X11 connection setup reply and extracts screen info.
func readSetup(conn net.Conn) (root uint32, width, height uint16, bpp uint8, err error) {
	hdr := make([]byte, 8)
	if _, err = io.ReadFull(conn, hdr); err != nil {
		return 0, 0, 0, 0, fmt.Errorf("x11 setup read: %w", err)
	}

	if hdr[0] == 0 {
		addLen := binary.LittleEndian.Uint16(hdr[6:8])
		reason := make([]byte, int(addLen)*4)
		io.ReadFull(conn, reason)
		return 0, 0, 0, 0, fmt.Errorf("x11 auth failed: %s", strings.TrimRight(string(reason), "\x00"))
	}

	if hdr[0] != 1 {
		return 0, 0, 0, 0, fmt.Errorf("x11 unexpected status: %d", hdr[0])
	}

	addLen := binary.LittleEndian.Uint16(hdr[6:8])
	data := make([]byte, int(addLen)*4)
	if _, err = io.ReadFull(conn, data); err != nil {
		return 0, 0, 0, 0, fmt.Errorf("x11 setup data: %w", err)
	}

	vendorLen := int(binary.LittleEndian.Uint16(data[16:18]))
	numScreens := data[20]
	numFormats := int(data[21])

	if numScreens == 0 {
		return 0, 0, 0, 0, fmt.Errorf("x11: no screens")
	}

	// Navigate to first screen: skip vendor (padded) + format list.
	screenOff := 32 + vendorLen + pad4(vendorLen) + numFormats*8

	root = binary.LittleEndian.Uint32(data[screenOff : screenOff+4])
	width = binary.LittleEndian.Uint16(data[screenOff+20 : screenOff+22])
	height = binary.LittleEndian.Uint16(data[screenOff+22 : screenOff+24])
	rootDepth := data[screenOff+38]

	// Look up bits-per-pixel for root depth in format list.
	formatOff := 32 + vendorLen + pad4(vendorLen)
	bpp = 32
	for i := range numFormats {
		off := formatOff + i*8
		if data[off] == rootDepth {
			bpp = data[off+1]
			break
		}
	}

	return root, width, height, bpp, nil
}

// getImage sends a GetImage request for the root window and converts to NRGBA.
func getImage(conn net.Conn, root uint32, w, h uint16, bpp uint8) (*image.NRGBA, error) {
	req := make([]byte, 20)
	req[0] = 73 // GetImage opcode
	req[1] = 2  // format = ZPixmap
	binary.LittleEndian.PutUint16(req[2:4], 5)
	binary.LittleEndian.PutUint32(req[4:8], root)
	// x=0, y=0 already zero
	binary.LittleEndian.PutUint16(req[12:14], w)
	binary.LittleEndian.PutUint16(req[14:16], h)
	binary.LittleEndian.PutUint32(req[16:20], 0xFFFFFFFF) // all planes

	if _, err := conn.Write(req); err != nil {
		return nil, fmt.Errorf("x11 GetImage write: %w", err)
	}

	rhdr := make([]byte, 32)
	if _, err := io.ReadFull(conn, rhdr); err != nil {
		return nil, fmt.Errorf("x11 GetImage reply: %w", err)
	}

	if rhdr[0] == 0 {
		return nil, fmt.Errorf("x11 GetImage error: code %d", rhdr[1])
	}
	if rhdr[0] != 1 {
		return nil, fmt.Errorf("x11 GetImage: unexpected reply type %d", rhdr[0])
	}

	replyLen := binary.LittleEndian.Uint32(rhdr[4:8])
	pixels := make([]byte, int(replyLen)*4)
	if _, err := io.ReadFull(conn, pixels); err != nil {
		return nil, fmt.Errorf("x11 GetImage read: %w", err)
	}

	return convertPixels(pixels, int(w), int(h), int(bpp))
}

// convertPixels turns ZPixmap BGRA data into an NRGBA image.
func convertPixels(pixels []byte, width, height, bpp int) (*image.NRGBA, error) {
	bytesPerPixel := bpp / 8
	if bytesPerPixel < 3 {
		return nil, fmt.Errorf("x11: unsupported depth (bpp=%d)", bpp)
	}

	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	stride := width * bytesPerPixel

	for y := range height {
		for x := range width {
			src := y*stride + x*bytesPerPixel
			dst := y*img.Stride + x*4
			img.Pix[dst] = pixels[src+2]   // R
			img.Pix[dst+1] = pixels[src+1] // G
			img.Pix[dst+2] = pixels[src]   // B
			img.Pix[dst+3] = 255           // A
		}
	}

	return img, nil
}

func pad4(n int) int {
	r := n % 4
	if r == 0 {
		return 0
	}
	return 4 - r
}

// ScreenSize returns just the screen dimensions without capturing pixels.
func ScreenSize() ([2]int, error) {
	display := os.Getenv("DISPLAY")
	if display == "" {
		display = ":0"
	}

	sockPath, displayNum, err := parseDisplay(display)
	if err != nil {
		return [2]int{}, err
	}

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return [2]int{}, err
	}
	defer conn.Close()

	authName, authData := readXauthority(displayNum)
	if err := sendSetup(conn, authName, authData); err != nil {
		return [2]int{}, err
	}

	_, w, h, _, err := readSetup(conn)
	if err != nil {
		return [2]int{}, err
	}

	return [2]int{int(w), int(h)}, nil
}
