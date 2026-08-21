//go:build linux

// Package dock provides a persistent status bar at the top of the Xvfb display.
// It uses the X11 wire protocol directly to create an override-redirect window
// showing "toad | ready" with a status dot in the app's accent green.
package dock

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Colours are the app's own palette (tokens.css, resolved to sRGB), so the
// dock reads as part of Toad rather than a stowaway from another product.
const (
	dockHeight = 20
	bgColor    = 0x0c0d0f // paper-2: one step up from the wallpaper's paper
	fgColor    = 0xbcbebf // ink-2
	greenColor = 0x6bcb62 // accent: the app's signal green
	amberColor = 0xefb146 // warn: human control
	padX       = 8        // horizontal text padding
	padY       = 14       // baseline offset from top of dock
	charW      = 6        // "fixed" font character width
)

// Dock is a persistent status bar at the top of the Xvfb display.
type Dock struct {
	conn    net.Conn
	root    uint32
	screenW uint16
	screenH uint16
	wid     uint32
	gc      uint32
	gcGreen uint32
	gcAmber uint32
	idBase  uint32
	idMask  uint32
	idSeq   uint32

	done chan struct{}

	// Lease display state (updated via SetLeaseState).
	leaseMu     sync.Mutex
	leaseActive bool
	leaseExpiry time.Time
	leaseTicker *time.Ticker
}

// Start creates the dock window on the current DISPLAY and maps it.
// It runs an event loop in the background to handle redraws.
func Start() (*Dock, error) {
	display := os.Getenv("DISPLAY")
	if display == "" {
		return nil, fmt.Errorf("DISPLAY not set")
	}

	sockPath, displayNum, err := parseDisplay(display)
	if err != nil {
		return nil, err
	}

	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return nil, fmt.Errorf("x11 connect: %w", err)
	}

	authName, authData := readXauthority(displayNum)
	if err := sendSetup(conn, authName, authData); err != nil {
		conn.Close()
		return nil, err
	}

	root, screenW, screenH, idBase, idMask, err := readSetup(conn)
	if err != nil {
		conn.Close()
		return nil, err
	}

	d := &Dock{
		conn:    conn,
		root:    root,
		screenW: screenW,
		screenH: screenH,
		idBase:  idBase,
		idMask:  idMask,
		done:    make(chan struct{}),
	}

	if err := d.init(); err != nil {
		conn.Close()
		return nil, err
	}

	go d.eventLoop()
	return d, nil
}

// Close destroys the dock window and closes the connection.
func (d *Dock) Close() error {
	close(d.done)
	return d.conn.Close()
}

func (d *Dock) nextID() uint32 {
	d.idSeq++
	return d.idBase | (d.idSeq & d.idMask)
}

func (d *Dock) init() error {
	d.wid = d.nextID()
	d.gc = d.nextID()

	// CreateWindow — managed window (no override-redirect) so the WM respects struts.
	if err := d.createDockWindow(d.wid, d.root, 0, 0, d.screenW, dockHeight); err != nil {
		return fmt.Errorf("create window: %w", err)
	}

	// Set WM_NAME so capture can filter this window.
	if err := d.setWMName("toad-dock"); err != nil {
		return fmt.Errorf("set wm name: %w", err)
	}

	// Set EWMH hints before mapping. InternAtom does round-trip reads,
	// so this must happen before the event loop starts and before any
	// fire-and-forget requests (like OpenFont) that could generate errors.
	if err := d.setDockHints(); err != nil {
		return fmt.Errorf("set dock hints: %w", err)
	}

	// OpenFont — load "fixed" bitmap font (after all round-trip calls).
	fontID := d.nextID()
	if err := d.openFont(fontID, "fixed"); err != nil {
		fontID = 0
	}

	// CreateGC with foreground, background, and font.
	if err := d.createGC(d.gc, d.wid, fgColor, bgColor, fontID); err != nil {
		return fmt.Errorf("create gc: %w", err)
	}

	// Green GC for status dot.
	d.gcGreen = d.nextID()
	if err := d.createGC(d.gcGreen, d.wid, greenColor, bgColor, 0); err != nil {
		return fmt.Errorf("create green gc: %w", err)
	}

	// Amber GC for human control indicator.
	d.gcAmber = d.nextID()
	if err := d.createGC(d.gcAmber, d.wid, amberColor, bgColor, 0); err != nil {
		return fmt.Errorf("create amber gc: %w", err)
	}

	// MapWindow — make it visible.
	if err := d.mapWindow(d.wid); err != nil {
		return fmt.Errorf("map window: %w", err)
	}

	return nil
}

func (d *Dock) redraw() {
	d.clearArea(d.wid, 0, 0, d.screenW, dockHeight)

	dotX := int16(padX)
	dotY := int16((dockHeight - 6) / 2)
	textX := dotX + 6 + 4 // dot width + small gap

	d.leaseMu.Lock()
	active := d.leaseActive
	expiry := d.leaseExpiry
	d.leaseMu.Unlock()

	if active {
		remaining := time.Until(expiry)
		if remaining < 0 {
			remaining = 0
		}
		mins := int(remaining.Minutes())
		secs := int(remaining.Seconds()) % 60
		label := fmt.Sprintf("toad | human control (%d:%02d)", mins, secs)
		d.fillRect(d.wid, d.gcAmber, dotX, dotY, 6, 6)
		d.drawText(d.wid, d.gc, textX, padY, label)
	} else {
		d.fillRect(d.wid, d.gcGreen, dotX, dotY, 6, 6)
		d.drawText(d.wid, d.gc, textX, padY, "toad | ready")
	}
}

// SetLeaseState is called by the control lease system to update the dock display.
func (d *Dock) SetLeaseState(active bool, remaining time.Duration) {
	d.leaseMu.Lock()
	d.leaseActive = active
	if active {
		d.leaseExpiry = time.Now().Add(remaining)
		// Start a ticker for countdown updates.
		if d.leaseTicker != nil {
			d.leaseTicker.Stop()
		}
		d.leaseTicker = time.NewTicker(1 * time.Second)
		go d.leaseCountdown()
	} else {
		d.leaseExpiry = time.Time{}
		if d.leaseTicker != nil {
			d.leaseTicker.Stop()
			d.leaseTicker = nil
		}
	}
	d.leaseMu.Unlock()
	d.redraw()
}

func (d *Dock) leaseCountdown() {
	d.leaseMu.Lock()
	ticker := d.leaseTicker
	d.leaseMu.Unlock()
	if ticker == nil {
		return
	}
	for range ticker.C {
		d.leaseMu.Lock()
		active := d.leaseActive
		expiry := d.leaseExpiry
		d.leaseMu.Unlock()
		if !active || time.Now().After(expiry) {
			return
		}
		d.redraw()
	}
}

func (d *Dock) eventLoop() {
	buf := make([]byte, 32)
	for {
		select {
		case <-d.done:
			return
		default:
		}

		if _, err := io.ReadFull(d.conn, buf); err != nil {
			return
		}
		eventType := buf[0] & 0x7F
		if eventType == 12 { // Expose
			d.redraw()
		}
	}
}

// --- X11 wire protocol operations ---

// createDockWindow creates a managed window (no override-redirect) suitable
// for EWMH dock hints. The window manager will respect _NET_WM_STRUT.
func (d *Dock) createDockWindow(wid, parent uint32, x, y int16, w, h uint16) error {
	// Value mask: background-pixel (bit 1) | event-mask (bit 11)
	const mask = 0x00000802
	buf := make([]byte, 40)
	buf[0] = 1 // CreateWindow opcode
	// buf[1] = 0 — depth CopyFromParent
	binary.LittleEndian.PutUint16(buf[2:4], 10) // request length
	binary.LittleEndian.PutUint32(buf[4:8], wid)
	binary.LittleEndian.PutUint32(buf[8:12], parent)
	binary.LittleEndian.PutUint16(buf[12:14], uint16(x))
	binary.LittleEndian.PutUint16(buf[14:16], uint16(y))
	binary.LittleEndian.PutUint16(buf[16:18], w)
	binary.LittleEndian.PutUint16(buf[18:20], h)
	// buf[20:22] = 0 — border width
	binary.LittleEndian.PutUint16(buf[22:24], 1) // class InputOutput
	// buf[24:28] = 0 — visual CopyFromParent
	binary.LittleEndian.PutUint32(buf[28:32], mask)
	// Values in bit order: background-pixel, event-mask
	binary.LittleEndian.PutUint32(buf[32:36], bgColor)
	binary.LittleEndian.PutUint32(buf[36:40], 0x8000) // ExposureMask
	_, err := d.conn.Write(buf)
	return err
}

// setDockHints sets EWMH properties so the WM treats this as a dock panel
// and reserves screen space at the top.
func (d *Dock) setDockHints() error {
	// Intern the atoms we need.
	atomType, err := d.internAtom("_NET_WM_WINDOW_TYPE")
	if err != nil {
		return err
	}
	atomDock, err := d.internAtom("_NET_WM_WINDOW_TYPE_DOCK")
	if err != nil {
		return err
	}
	atomStrut, err := d.internAtom("_NET_WM_STRUT")
	if err != nil {
		return err
	}
	atomStrutPartial, err := d.internAtom("_NET_WM_STRUT_PARTIAL")
	if err != nil {
		return err
	}
	atomState, err := d.internAtom("_NET_WM_STATE")
	if err != nil {
		return err
	}
	atomAbove, err := d.internAtom("_NET_WM_STATE_ABOVE")
	if err != nil {
		return err
	}
	atomSticky, err := d.internAtom("_NET_WM_STATE_STICKY")
	if err != nil {
		return err
	}

	// _NET_WM_WINDOW_TYPE = _NET_WM_WINDOW_TYPE_DOCK
	if err := d.changeProp32(d.wid, atomType, 4 /*ATOM*/, atomDock); err != nil {
		return err
	}

	// _NET_WM_STATE = [ABOVE, STICKY]
	if err := d.changeProp32(d.wid, atomState, 4, atomAbove, atomSticky); err != nil {
		return err
	}

	// _NET_WM_STRUT = [left, right, top, bottom]
	if err := d.changeProp32(d.wid, atomStrut, 6 /*CARDINAL*/, 0, 0, uint32(dockHeight), 0); err != nil {
		return err
	}

	// _NET_WM_STRUT_PARTIAL = [left, right, top, bottom, left_start_y, left_end_y,
	//   right_start_y, right_end_y, top_start_x, top_end_x, bottom_start_x, bottom_end_x]
	return d.changeProp32(d.wid, atomStrutPartial, 6,
		0, 0, uint32(dockHeight), 0,
		0, 0, 0, 0,
		0, uint32(d.screenW-1), 0, 0,
	)
}

// internAtom sends an InternAtom request and reads the reply to get the atom ID.
// This is a round-trip (request + reply) since we need the numeric atom.
func (d *Dock) internAtom(name string) (uint32, error) {
	nameBytes := []byte(name)
	padLen := pad4(len(nameBytes))
	reqLen := (8 + len(nameBytes) + padLen) / 4
	buf := make([]byte, reqLen*4)
	buf[0] = 16 // InternAtom opcode
	buf[1] = 0  // only_if_exists = false
	binary.LittleEndian.PutUint16(buf[2:4], uint16(reqLen))
	binary.LittleEndian.PutUint16(buf[4:6], uint16(len(nameBytes)))
	copy(buf[8:], nameBytes)
	if _, err := d.conn.Write(buf); err != nil {
		return 0, err
	}

	// Read 32-byte reply.
	reply := make([]byte, 32)
	if _, err := io.ReadFull(d.conn, reply); err != nil {
		return 0, fmt.Errorf("intern atom %q: %w", name, err)
	}
	if reply[0] != 1 { // not a Reply
		return 0, fmt.Errorf("intern atom %q: unexpected response type %d", name, reply[0])
	}
	atom := binary.LittleEndian.Uint32(reply[8:12])
	return atom, nil
}

// changeProp32 sets a 32-bit property on a window (ChangeProperty, format=32).
func (d *Dock) changeProp32(wid, prop, propType uint32, values ...uint32) error {
	nValues := len(values)
	reqLen := 6 + nValues // 6 words header + N words of data
	buf := make([]byte, reqLen*4)
	buf[0] = 18 // ChangeProperty opcode
	buf[1] = 0  // mode Replace
	binary.LittleEndian.PutUint16(buf[2:4], uint16(reqLen))
	binary.LittleEndian.PutUint32(buf[4:8], wid)
	binary.LittleEndian.PutUint32(buf[8:12], prop)
	binary.LittleEndian.PutUint32(buf[12:16], propType)
	buf[16] = 32 // format = 32 bit
	binary.LittleEndian.PutUint32(buf[20:24], uint32(nValues))
	for i, v := range values {
		binary.LittleEndian.PutUint32(buf[24+i*4:28+i*4], v)
	}
	_, err := d.conn.Write(buf)
	return err
}

func (d *Dock) openFont(fid uint32, name string) error {
	nameBytes := []byte(name)
	padLen := pad4(len(nameBytes))
	reqLen := (12 + len(nameBytes) + padLen) / 4
	buf := make([]byte, reqLen*4)
	buf[0] = 45 // OpenFont opcode
	binary.LittleEndian.PutUint16(buf[2:4], uint16(reqLen))
	binary.LittleEndian.PutUint32(buf[4:8], fid)
	binary.LittleEndian.PutUint16(buf[8:10], uint16(len(nameBytes)))
	copy(buf[12:], nameBytes)
	_, err := d.conn.Write(buf)
	return err
}

func (d *Dock) createGC(gcID, drawable, fg, bg uint32, fontID uint32) error {
	if fontID != 0 {
		// mask: foreground (bit 2) | background (bit 3) | font (bit 14)
		const mask = 0x0000400C
		buf := make([]byte, 28)
		buf[0] = 55                                // CreateGC opcode
		binary.LittleEndian.PutUint16(buf[2:4], 7) // request length
		binary.LittleEndian.PutUint32(buf[4:8], gcID)
		binary.LittleEndian.PutUint32(buf[8:12], drawable)
		binary.LittleEndian.PutUint32(buf[12:16], mask)
		binary.LittleEndian.PutUint32(buf[16:20], fg)
		binary.LittleEndian.PutUint32(buf[20:24], bg)
		binary.LittleEndian.PutUint32(buf[24:28], fontID)
		_, err := d.conn.Write(buf)
		return err
	}
	// No font — just foreground and background.
	const mask = 0x0000000C
	buf := make([]byte, 24)
	buf[0] = 55
	binary.LittleEndian.PutUint16(buf[2:4], 6)
	binary.LittleEndian.PutUint32(buf[4:8], gcID)
	binary.LittleEndian.PutUint32(buf[8:12], drawable)
	binary.LittleEndian.PutUint32(buf[12:16], mask)
	binary.LittleEndian.PutUint32(buf[16:20], fg)
	binary.LittleEndian.PutUint32(buf[20:24], bg)
	_, err := d.conn.Write(buf)
	return err
}

func (d *Dock) setWMName(name string) error {
	nameBytes := []byte(name)
	padLen := pad4(len(nameBytes))
	reqLen := (24 + len(nameBytes) + padLen) / 4
	buf := make([]byte, reqLen*4)
	buf[0] = 18 // ChangeProperty opcode
	buf[1] = 0  // mode Replace
	binary.LittleEndian.PutUint16(buf[2:4], uint16(reqLen))
	binary.LittleEndian.PutUint32(buf[4:8], d.wid)
	binary.LittleEndian.PutUint32(buf[8:12], 39)  // WM_NAME atom
	binary.LittleEndian.PutUint32(buf[12:16], 31) // STRING atom
	buf[16] = 8                                   // format (8-bit)
	binary.LittleEndian.PutUint32(buf[20:24], uint32(len(nameBytes)))
	copy(buf[24:], nameBytes)
	_, err := d.conn.Write(buf)
	return err
}

func (d *Dock) mapWindow(wid uint32) error {
	buf := make([]byte, 8)
	buf[0] = 8 // MapWindow opcode
	binary.LittleEndian.PutUint16(buf[2:4], 2)
	binary.LittleEndian.PutUint32(buf[4:8], wid)
	_, err := d.conn.Write(buf)
	return err
}

func (d *Dock) clearArea(wid uint32, x, y, w, h uint16) {
	buf := make([]byte, 16)
	buf[0] = 61 // ClearArea opcode
	// buf[1] = 0 — no exposures
	binary.LittleEndian.PutUint16(buf[2:4], 4) // request length
	binary.LittleEndian.PutUint32(buf[4:8], wid)
	binary.LittleEndian.PutUint16(buf[8:10], x)
	binary.LittleEndian.PutUint16(buf[10:12], y)
	binary.LittleEndian.PutUint16(buf[12:14], w)
	binary.LittleEndian.PutUint16(buf[14:16], h)
	d.conn.Write(buf)
}

// fillRect draws a filled rectangle using PolyFillRectangle (opcode 70).
func (d *Dock) fillRect(drawable, gc uint32, x, y int16, w, h uint16) {
	buf := make([]byte, 20)
	buf[0] = 70                                // PolyFillRectangle opcode
	binary.LittleEndian.PutUint16(buf[2:4], 5) // request length = 3 header + 2 rect
	binary.LittleEndian.PutUint32(buf[4:8], drawable)
	binary.LittleEndian.PutUint32(buf[8:12], gc)
	binary.LittleEndian.PutUint16(buf[12:14], uint16(x))
	binary.LittleEndian.PutUint16(buf[14:16], uint16(y))
	binary.LittleEndian.PutUint16(buf[16:18], w)
	binary.LittleEndian.PutUint16(buf[18:20], h)
	d.conn.Write(buf)
}

func (d *Dock) drawText(drawable, gc uint32, x, y int16, text string) {
	// ImageText8 can draw at most 255 chars per call.
	s := text
	if len(s) > 255 {
		s = s[:255]
	}
	n := len(s)
	padLen := pad4(n)
	reqLen := (16 + n + padLen) / 4
	buf := make([]byte, reqLen*4)
	buf[0] = 76 // ImageText8 opcode
	buf[1] = byte(n)
	binary.LittleEndian.PutUint16(buf[2:4], uint16(reqLen))
	binary.LittleEndian.PutUint32(buf[4:8], drawable)
	binary.LittleEndian.PutUint32(buf[8:12], gc)
	binary.LittleEndian.PutUint16(buf[12:14], uint16(x))
	binary.LittleEndian.PutUint16(buf[14:16], uint16(y))
	copy(buf[16:], s)
	d.conn.Write(buf)
}

// --- X11 connection setup (same approach as screenshot package) ---

func parseDisplay(display string) (string, int, error) {
	idx := strings.LastIndex(display, ":")
	if idx < 0 {
		return "", 0, fmt.Errorf("invalid DISPLAY: %s", display)
	}
	numStr := display[idx+1:]
	if dot := strings.Index(numStr, "."); dot >= 0 {
		numStr = numStr[:dot]
	}
	num, err := strconv.Atoi(numStr)
	if err != nil {
		return "", 0, fmt.Errorf("invalid display number: %s", numStr)
	}
	return fmt.Sprintf("/tmp/.X11-unix/X%d", num), num, nil
}

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
		readBytes(f)
		num := readBytes(f)
		aName := readBytes(f)
		aData := readBytes(f)
		if aName == nil {
			break
		}
		if string(num) == dispStr || family == 65535 {
			return aName, aData
		}
	}
	return nil, nil
}

func readBytes(f *os.File) []byte {
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

func sendSetup(conn net.Conn, authName, authData []byte) error {
	nameLen := len(authName)
	dataLen := len(authData)
	total := 12 + nameLen + pad4(nameLen) + dataLen + pad4(dataLen)
	buf := make([]byte, total)
	buf[0] = 'l'
	binary.LittleEndian.PutUint16(buf[2:4], 11)
	binary.LittleEndian.PutUint16(buf[6:8], uint16(nameLen))
	binary.LittleEndian.PutUint16(buf[8:10], uint16(dataLen))
	copy(buf[12:], authName)
	copy(buf[12+nameLen+pad4(nameLen):], authData)
	_, err := conn.Write(buf)
	return err
}

// readSetup reads the X11 setup reply, extracting root window, screen size,
// and resource ID base/mask for creating new resources.
func readSetup(conn net.Conn) (root uint32, w, h uint16, idBase, idMask uint32, err error) {
	hdr := make([]byte, 8)
	if _, err = io.ReadFull(conn, hdr); err != nil {
		return 0, 0, 0, 0, 0, fmt.Errorf("x11 setup read: %w", err)
	}
	if hdr[0] == 0 {
		addLen := binary.LittleEndian.Uint16(hdr[6:8])
		reason := make([]byte, int(addLen)*4)
		io.ReadFull(conn, reason)
		return 0, 0, 0, 0, 0, fmt.Errorf("x11 auth failed: %s", string(reason))
	}
	if hdr[0] != 1 {
		return 0, 0, 0, 0, 0, fmt.Errorf("x11 unexpected status: %d", hdr[0])
	}

	addLen := binary.LittleEndian.Uint16(hdr[6:8])
	data := make([]byte, int(addLen)*4)
	if _, err = io.ReadFull(conn, data); err != nil {
		return 0, 0, 0, 0, 0, fmt.Errorf("x11 setup data: %w", err)
	}

	idBase = binary.LittleEndian.Uint32(data[4:8])
	idMask = binary.LittleEndian.Uint32(data[8:12])

	vendorLen := int(binary.LittleEndian.Uint16(data[16:18]))
	numFormats := int(data[21])

	screenOff := 32 + vendorLen + pad4(vendorLen) + numFormats*8
	root = binary.LittleEndian.Uint32(data[screenOff : screenOff+4])
	w = binary.LittleEndian.Uint16(data[screenOff+20 : screenOff+22])
	h = binary.LittleEndian.Uint16(data[screenOff+22 : screenOff+24])

	return root, w, h, idBase, idMask, nil
}

func pad4(n int) int {
	r := n % 4
	if r == 0 {
		return 0
	}
	return 4 - r
}
