//go:build linux

package a11y

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"toad.computer/internal/dbus"
)

const (
	atspiBusDir     = "/run/user/%d/at-spi"
	atspiDest       = "org.a11y.atspi.Registry"
	atspiRoot       = "/org/a11y/atspi/accessible/root"
	atspiAccIface   = "org.a11y.atspi.Accessible"
	atspiCompIface  = "org.a11y.atspi.Component"
	atspiTextIface  = "org.a11y.atspi.Text"
	atspiValueIface = "org.a11y.atspi.Value"
	dbusPropsIface  = "org.freedesktop.DBus.Properties"
)

// AT-SPI2 role constants (subset we care about).
var roleNames = map[uint32]string{
	1: "alert", 7: "check-box", 8: "check-menu-item", 9: "menu", 10: "menu-item",
	11: "color-chooser", 12: "column-header", 13: "combo-box",
	20: "dialog", 22: "file-chooser", 23: "frame",
	24: "glass-pane", 25: "html-container", 26: "icon",
	28: "label", 30: "list", 31: "list-item",
	34: "menu-bar", 37: "option-pane", 38: "page-tab",
	39: "page-tab-list", 40: "panel", 42: "progress-bar",
	43: "push-button", 44: "radio-button", 46: "scroll-bar",
	47: "scroll-pane", 50: "slider", 51: "spin-button",
	52: "split-pane", 55: "table", 56: "table-cell",
	58: "text", 60: "toggle-button", 62: "tool-bar",
	64: "tree", 65: "tree-table", 68: "header",
	69: "footer", 70: "paragraph", 73: "section",
	79: "entry", 80: "heading", 82: "input-field", 85: "link",
	87: "entry", 95: "document-web", 100: "grouping",
	116: "static", 124: "notification",
}

// atspiRef is a D-Bus reference to an accessible object.
type atspiRef struct {
	bus  string // unique bus name, e.g. ":1.44"
	path string // object path, e.g. "/org/a11y/atspi/accessible/1"
}

// Query returns accessible elements for a given window, identified by title.
// It connects to the AT-SPI2 bus, finds the matching app/window, and walks its tree.
// Each app is queried on a fresh connection so unresponsive apps don't poison the bus.
func Query(windowTitle string) ([]Element, error) {
	conn, err := connectATSPI()
	if err != nil {
		return nil, err
	}
	apps, err := getChildren(conn, atspiDest, atspiRoot)
	conn.Close()
	if err != nil {
		return nil, fmt.Errorf("get root children: %w", err)
	}

	for _, app := range apps {
		appConn, err := connectATSPI()
		if err != nil {
			continue
		}
		wins, err := getChildren(appConn, app.bus, app.path)
		if err != nil {
			appConn.Close()
			continue
		}
		for _, win := range wins {
			name, _ := getName(appConn, win.bus, win.path)
			if name != "" && strings.Contains(name, windowTitle) {
				elements := walkTree(appConn, win, defaultMaxDepth)
				appConn.Close()
				return elements, nil
			}
		}
		appConn.Close()
	}

	return nil, fmt.Errorf("window %q not found in accessibility tree", windowTitle)
}

// QueryAll returns accessible elements for all windows on the AT-SPI2 bus.
// Each app is queried on a fresh connection so unresponsive apps are skipped cleanly.
func QueryAll() (map[string][]Element, error) {
	conn, err := connectATSPI()
	if err != nil {
		return nil, err
	}
	apps, err := getChildren(conn, atspiDest, atspiRoot)
	conn.Close()
	if err != nil {
		return nil, fmt.Errorf("get root children: %w", err)
	}

	result := make(map[string][]Element)
	for _, app := range apps {
		appConn, err := connectATSPI()
		if err != nil {
			continue
		}
		wins, err := getChildren(appConn, app.bus, app.path)
		if err != nil {
			appConn.Close()
			continue
		}
		for _, win := range wins {
			name, _ := getName(appConn, win.bus, win.path)
			if name == "" {
				continue
			}
			elements := walkTree(appConn, win, defaultMaxDepth)
			if len(elements) > 0 {
				result[name] = elements
			}
		}
		appConn.Close()
	}
	return result, nil
}

// Available returns true if AT-SPI2 is reachable.
func Available() bool {
	conn, err := connectATSPI()
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func connectATSPI() (*dbus.Conn, error) {
	uid := os.Getuid()
	busDir := fmt.Sprintf(atspiBusDir, uid)

	// Find the AT-SPI2 bus socket.
	entries, err := os.ReadDir(busDir)
	if err != nil {
		return nil, fmt.Errorf("at-spi2 bus dir not found: %w", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "bus") {
			addr := "unix:path=" + filepath.Join(busDir, e.Name())
			return dbus.Connect(addr)
		}
	}
	return nil, fmt.Errorf("no at-spi2 bus socket found in %s", busDir)
}

func getChildren(conn *dbus.Conn, dest, path string) ([]atspiRef, error) {
	body, _, err := conn.Call(dest, path, atspiAccIface, "GetChildren", "", nil)
	if err != nil {
		return nil, err
	}
	return parseRefArray(body)
}

func getName(conn *dbus.Conn, dest, path string) (string, error) {
	body := dbus.MarshalString(atspiAccIface)
	body = dbus.AlignPad(body, 4) // align for next string argument
	body = append(body, dbus.MarshalString("Name")...)
	resp, _, err := conn.Call(dest, path, dbusPropsIface, "Get", "ss", body)
	if err != nil {
		return "", err
	}
	// Response is a variant: signature byte(s) + value.
	// For a string variant: 1 's' 0 <string>
	if len(resp) < 4 {
		return "", fmt.Errorf("name response too short")
	}
	// Skip variant signature.
	sigLen := int(resp[0])
	off := 1 + sigLen + 1 // sigLen byte + sig + NUL
	s, _, err := dbus.ReadString(resp, off)
	return s, err
}

func getRole(conn *dbus.Conn, dest, path string) (uint32, error) {
	body, _, err := conn.Call(dest, path, atspiAccIface, "GetRole", "", nil)
	if err != nil {
		return 0, err
	}
	v, _, err := dbus.ReadUint32(body, 0)
	return v, err
}

func getExtents(conn *dbus.Conn, dest, path string) ([4]int, error) {
	// GetExtents(uint32 coordType) → (iiii) struct.
	// coordType 1 = window-relative coordinates.
	// GTK4/Wayland apps report (0,0) for screen coords, so we use window-relative
	// and let the caller offset to screen space using the window manager's geometry.
	body, _, err := conn.Call(dest, path, atspiCompIface, "GetExtents", "u", dbus.MarshalUint32(1))
	if err != nil {
		return [4]int{}, err
	}
	return parseExtents(body)
}

// Roles where we should try to read the text value.
var textRoles = map[uint32]bool{
	58: true, // text
	79: true, // entry (Chromium)
	82: true, // input-field
	87: true, // entry
	13: true, // combo-box
	51: true, // spin-button
}

// Roles where we should check checked/selected state.
var stateRoles = map[uint32]bool{
	7:  true, // check-box
	8:  true, // check-menu-item
	44: true, // radio-button
	60: true, // toggle-button
	31: true, // list-item
	38: true, // page-tab
}

// AT-SPI2 state bits (from atspi-constants.h StateType enum).
const (
	stateChecked  = 4  // STATE_CHECKED
	stateEnabled  = 8  // STATE_ENABLED
	stateFocused  = 12 // STATE_FOCUSED
	stateExpanded = 10 // STATE_EXPANDED
	statePressed  = 20 // STATE_PRESSED
	stateSelected = 23 // STATE_SELECTED
)

var stateNames = map[int]string{
	stateChecked:  "checked",
	stateFocused:  "focused",
	stateSelected: "selected",
	stateExpanded: "expanded",
	statePressed:  "pressed",
}

// getText reads the text content via the AT-SPI2 Text interface.
// Calls GetText(0, -1) to get all text. Returns empty string on failure.
func getText(conn *dbus.Conn, dest, path string) string {
	// GetText(int32 startOffset, int32 endOffset) → string
	var body []byte
	body = append(body, dbus.MarshalInt32(0)...)  // startOffset
	body = append(body, dbus.MarshalInt32(-1)...) // endOffset = -1 means all text
	resp, _, err := conn.Call(dest, path, atspiTextIface, "GetText", "ii", body)
	if err != nil {
		return ""
	}
	s, _, err := dbus.ReadString(resp, 0)
	if err != nil {
		return ""
	}
	return s
}

// getStateSet retrieves the AT-SPI2 state set as two uint32 bitmasks.
func getStateSet(conn *dbus.Conn, dest, path string) []string {
	body, sig, err := conn.Call(dest, path, atspiAccIface, "GetState", "", nil)
	if err != nil {
		return nil
	}
	_ = sig
	// Returns au (array of uint32), typically 2 elements = 64 bits of state.
	arrayLen, off, err := dbus.ReadArrayHeader(body, 0)
	if err != nil || arrayLen == 0 {
		return nil
	}
	end := off + arrayLen
	var bits []uint32
	for off < end {
		v, newOff, err := dbus.ReadUint32(body, off)
		if err != nil {
			break
		}
		bits = append(bits, v)
		off = newOff
	}
	if len(bits) == 0 {
		return nil
	}

	var states []string
	for bit, name := range stateNames {
		word := bit / 32
		pos := uint(bit % 32)
		if word < len(bits) && bits[word]&(1<<pos) != 0 {
			states = append(states, name)
		}
	}
	return states
}

func parseExtents(body []byte) ([4]int, error) {
	// (iiii) struct — 4 int32 values, struct aligned to 8.
	off := 0
	// Struct alignment.
	if off%8 != 0 {
		off += 8 - off%8
	}
	var vals [4]int
	for i := range 4 {
		v, newOff, err := dbus.ReadInt32(body, off)
		if err != nil {
			return [4]int{}, fmt.Errorf("parse extent %d: %w", i, err)
		}
		vals[i] = int(v)
		off = newOff
	}
	return vals, nil
}

func parseRefArray(body []byte) ([]atspiRef, error) {
	// Array of (so) — struct { string, object_path }
	arrayLen, off, err := dbus.ReadArrayHeader(body, 0)
	if err != nil {
		return nil, err
	}
	end := off + arrayLen
	var refs []atspiRef
	for off < end {
		// Struct alignment.
		if off%8 != 0 {
			off += 8 - off%8
		}
		bus, newOff, err := dbus.ReadString(body, off)
		if err != nil {
			break
		}
		off = newOff
		path, newOff2, err := dbus.ReadObjectPath(body, off)
		if err != nil {
			break
		}
		off = newOff2
		if path != "" && path != "/org/a11y/atspi/null" {
			refs = append(refs, atspiRef{bus: bus, path: path})
		}
	}
	return refs, nil
}

const maxElements = 200
const defaultMaxDepth = 15

// walkTree recursively collects accessible elements up to maxDepth.
func walkTree(conn *dbus.Conn, ref atspiRef, maxDepth int) []Element {
	var elements []Element
	walkTreeRec(conn, ref, maxDepth, &elements)
	return elements
}

func walkTreeRec(conn *dbus.Conn, ref atspiRef, maxDepth int, elements *[]Element) {
	if maxDepth <= 0 || len(*elements) >= maxElements {
		return
	}

	name, _ := getName(conn, ref.bus, ref.path)
	role, _ := getRole(conn, ref.bus, ref.path)
	bounds, _ := getExtents(conn, ref.bus, ref.path)

	roleName := roleNames[role]
	if roleName == "" {
		roleName = "role-" + strconv.FormatUint(uint64(role), 10)
	}

	// Only include elements with a name and visible bounds.
	if name != "" && (bounds[2] > 0 || bounds[3] > 0) {
		elem := Element{
			Name:   name,
			Role:   roleName,
			Bounds: bounds,
		}
		// Query text value for input-like roles.
		if textRoles[role] {
			if v := getText(conn, ref.bus, ref.path); v != "" && v != name {
				elem.Value = v
			}
		}
		// Query state for toggleable roles.
		if stateRoles[role] {
			elem.States = getStateSet(conn, ref.bus, ref.path)
		}
		*elements = append(*elements, elem)
	}

	children, err := getChildren(conn, ref.bus, ref.path)
	if err != nil {
		return
	}
	for _, child := range children {
		if len(*elements) >= maxElements {
			return
		}
		walkTreeRec(conn, child, maxDepth-1, elements)
	}
}
