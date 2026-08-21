//go:build linux

// Package dbus implements a minimal D-Bus client for AT-SPI2 accessibility queries.
// Only supports method calls and reply parsing — no signals, properties watching, or bus ownership.
package dbus

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
)

// Conn is a minimal D-Bus connection.
type Conn struct {
	conn   net.Conn
	serial uint32
	mu     sync.Mutex
	unique string // our unique bus name
	broken bool
}

// DBusError is returned when the remote sends a D-Bus error reply.
// This is an application-level error (the connection is still usable).
type DBusError struct {
	Name    string
	Message string
}

func (e *DBusError) Error() string {
	return fmt.Sprintf("dbus error: %s: %s", e.Name, e.Message)
}

// Connect opens a connection to the D-Bus bus at the given address.
// Address format: "unix:path=/run/user/1000/at-spi/bus_1"
func Connect(addr string) (*Conn, error) {
	path, err := parseUnixPath(addr)
	if err != nil {
		return nil, err
	}

	conn, err := net.Dial("unix", path)
	if err != nil {
		return nil, fmt.Errorf("dbus connect: %w", err)
	}

	c := &Conn{conn: conn}
	if err := c.authenticate(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("dbus auth: %w", err)
	}

	unique, err := c.hello()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("dbus hello: %w", err)
	}
	c.unique = unique

	return c, nil
}

// Close closes the connection.
func (c *Conn) Close() error {
	return c.conn.Close()
}

// CallTimeout is the default per-call read deadline.
var CallTimeout = 500 * time.Millisecond

// Call invokes a D-Bus method and returns the reply body bytes and signature.
// On timeout or network error, the connection is marked broken and cannot be reused.
func (c *Conn) Call(dest, path, iface, method string, sig string, body []byte) ([]byte, string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.broken {
		return nil, "", errors.New("dbus: connection broken")
	}

	c.serial++
	serial := c.serial

	msg := buildMethodCall(serial, dest, path, iface, method, sig, body)
	if _, err := c.conn.Write(msg); err != nil {
		c.broken = true
		return nil, "", fmt.Errorf("dbus write: %w", err)
	}

	c.conn.SetReadDeadline(time.Now().Add(CallTimeout))
	b, s, err := c.readReply(serial)
	c.conn.SetReadDeadline(time.Time{})

	if err != nil {
		var dbusErr *DBusError
		if !errors.As(err, &dbusErr) {
			c.broken = true
		}
		return nil, "", err
	}
	return b, s, nil
}

// parseUnixPath extracts the socket path from a D-Bus address string.
func parseUnixPath(addr string) (string, error) {
	// Format: "unix:path=/some/path" or "unix:abstract=/some/path"
	for _, prefix := range []string{"unix:path=", "unix:abstract="} {
		if len(addr) > len(prefix) && addr[:len(prefix)] == prefix {
			return addr[len(prefix):], nil
		}
	}
	return "", fmt.Errorf("unsupported dbus address: %s", addr)
}

// authenticate performs EXTERNAL authentication (uid-based, no password).
func (c *Conn) authenticate() error {
	// Send NUL byte to initiate.
	if _, err := c.conn.Write([]byte{0}); err != nil {
		return err
	}

	uid := strconv.Itoa(os.Getuid())
	hexUID := fmt.Sprintf("%x", []byte(uid))
	authCmd := fmt.Sprintf("AUTH EXTERNAL %s\r\n", hexUID)
	if _, err := c.conn.Write([]byte(authCmd)); err != nil {
		return err
	}

	buf := make([]byte, 512)
	n, err := c.conn.Read(buf)
	if err != nil {
		return err
	}
	resp := string(buf[:n])
	if len(resp) < 2 || resp[:2] != "OK" {
		return fmt.Errorf("auth failed: %s", resp)
	}

	if _, err := c.conn.Write([]byte("BEGIN\r\n")); err != nil {
		return err
	}
	return nil
}

// hello calls org.freedesktop.DBus.Hello to register on the bus.
func (c *Conn) hello() (string, error) {
	c.serial++
	msg := buildMethodCall(c.serial, "org.freedesktop.DBus", "/org/freedesktop/DBus",
		"org.freedesktop.DBus", "Hello", "", nil)
	if _, err := c.conn.Write(msg); err != nil {
		return "", err
	}

	body, _, err := c.readReply(c.serial)
	if err != nil {
		return "", err
	}

	name, _, err := ReadString(body, 0)
	return name, err
}

// --- Message building ---

const (
	msgTypeMethodCall   = 1
	msgTypeMethodReturn = 2
	msgTypeError        = 3

	fieldPath        = 1
	fieldInterface   = 2
	fieldMember      = 3
	fieldDestination = 6
	fieldSignature   = 8
)

func buildMethodCall(serial uint32, dest, path, iface, method, sig string, body []byte) []byte {
	// Build header fields array.
	var fields []byte
	fields = appendHeaderField(fields, fieldPath, 'o', path)
	fields = appendHeaderField(fields, fieldInterface, 's', iface)
	fields = appendHeaderField(fields, fieldMember, 's', method)
	if dest != "" {
		fields = appendHeaderField(fields, fieldDestination, 's', dest)
	}
	if sig != "" {
		fields = appendHeaderSig(fields, fieldSignature, sig)
	}

	bodyLen := len(body)

	// Fixed header: 12 bytes + field array length (4) + fields + padding.
	fieldArrayLen := len(fields)
	headerLen := 12 + 4 + fieldArrayLen
	headerPad := align8(headerLen) - headerLen

	total := headerLen + headerPad + bodyLen
	buf := make([]byte, total)

	// Fixed header.
	buf[0] = 'l' // little-endian
	buf[1] = msgTypeMethodCall
	buf[2] = 0 // flags
	buf[3] = 1 // protocol version
	binary.LittleEndian.PutUint32(buf[4:8], uint32(bodyLen))
	binary.LittleEndian.PutUint32(buf[8:12], serial)

	// Field array.
	binary.LittleEndian.PutUint32(buf[12:16], uint32(fieldArrayLen))
	copy(buf[16:], fields)

	// Body after header+padding.
	if bodyLen > 0 {
		copy(buf[headerLen+headerPad:], body)
	}
	return buf
}

func appendHeaderField(buf []byte, code byte, typeByte byte, value string) []byte {
	// Struct (yv) alignment: 8 bytes.
	buf = padTo(buf, 8)
	buf = append(buf, code)           // field code (BYTE)
	buf = append(buf, 1, typeByte, 0) // variant sig: len=1, type, NUL (alignment 1)
	buf = padTo(buf, 4)               // align for string/object_path value
	buf = appendString(buf, value)
	return buf
}

func appendHeaderSig(buf []byte, code byte, sig string) []byte {
	buf = padTo(buf, 8)
	buf = append(buf, code)
	buf = append(buf, 1, 'g', 0)      // variant sig = "g" (alignment 1)
	buf = append(buf, byte(len(sig))) // SIGNATURE value: length byte
	buf = append(buf, []byte(sig)...)
	buf = append(buf, 0) // NUL terminator
	return buf
}

func appendString(buf []byte, s string) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, uint32(len(s)))
	buf = append(buf, b...)
	buf = append(buf, []byte(s)...)
	buf = append(buf, 0) // NUL terminator
	return buf
}

func padTo(buf []byte, alignment int) []byte {
	rem := len(buf) % alignment
	if rem == 0 {
		return buf
	}
	pad := alignment - rem
	for range pad {
		buf = append(buf, 0)
	}
	return buf
}

func align8(n int) int {
	return (n + 7) &^ 7
}

// --- Message reading ---

func (c *Conn) readReply(forSerial uint32) ([]byte, string, error) {
	for {
		hdr := make([]byte, 16)
		if _, err := readFull(c.conn, hdr); err != nil {
			return nil, "", fmt.Errorf("read header: %w", err)
		}

		endian := hdr[0]
		if endian != 'l' && endian != 'B' {
			return nil, "", fmt.Errorf("unexpected endian byte: %c", endian)
		}
		le := endian == 'l'

		msgType := hdr[1]
		bodyLen := readUint32(hdr[4:8], le)
		fieldArrayLen := readUint32(hdr[12:16], le)

		// Read field array + padding.
		fieldBytes := int(fieldArrayLen)
		totalFieldPadded := align8(12+4+fieldBytes) - 16
		if totalFieldPadded < fieldBytes {
			totalFieldPadded = fieldBytes
		}
		rest := make([]byte, totalFieldPadded)
		if _, err := readFull(c.conn, rest); err != nil {
			return nil, "", fmt.Errorf("read fields: %w", err)
		}

		// Read body.
		body := make([]byte, bodyLen)
		if bodyLen > 0 {
			if _, err := readFull(c.conn, body); err != nil {
				return nil, "", fmt.Errorf("read body: %w", err)
			}
		}

		// Reply serial is only in the header fields (field code 5), not in the fixed header.
		sig := extractSignature(rest[:fieldBytes], le)
		replySerial := extractReplySerial(rest[:fieldBytes], le)

		// Skip messages not for us (signals, other replies).
		if replySerial != forSerial {
			continue
		}

		if msgType == msgTypeError {
			errName := extractErrorName(rest[:fieldBytes], le)
			errMsg := ""
			if len(body) > 0 {
				errMsg, _, _ = ReadString(body, 0)
			}
			return nil, "", &DBusError{Name: errName, Message: errMsg}
		}

		if msgType == msgTypeMethodReturn {
			return body, sig, nil
		}
	}
}

func readFull(conn net.Conn, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := conn.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func readUint32(b []byte, le bool) uint32 {
	if le {
		return binary.LittleEndian.Uint32(b)
	}
	return binary.BigEndian.Uint32(b)
}

const (
	fieldReplySerial = 5
	fieldErrorName   = 4
)

func extractReplySerial(fields []byte, le bool) uint32 {
	return extractUint32Field(fields, fieldReplySerial, le)
}

func extractErrorName(fields []byte, le bool) string {
	return extractStringField(fields, fieldErrorName, le)
}

func extractSignature(fields []byte, le bool) string {
	return extractSigField(fields, fieldSignature, le)
}

// Field parsing helpers — walk the (yv) struct array.
// Each entry is (yv): byte field code, then variant (sig + value).
// Variant has alignment 1 — signature comes immediately after field code.

func extractUint32Field(fields []byte, code byte, le bool) uint32 {
	off := 0
	for off < len(fields) {
		off = alignTo(off, 8) // struct alignment
		if off >= len(fields) {
			break
		}
		fc := fields[off]
		off++ // past field code (BYTE, alignment 1)
		if off+2 > len(fields) {
			break
		}
		sigLen := int(fields[off])
		sigByte := fields[off+1]
		off += sigLen + 2 // sig len byte + sig content + NUL

		if fc == code && sigByte == 'u' {
			off = alignTo(off, 4)
			if off+4 <= len(fields) {
				return readUint32(fields[off:off+4], le)
			}
		}
		off = skipValue(fields, off, sigByte, le)
	}
	return 0
}

func extractStringField(fields []byte, code byte, le bool) string {
	off := 0
	for off < len(fields) {
		off = alignTo(off, 8)
		if off >= len(fields) {
			break
		}
		fc := fields[off]
		off++
		if off+2 > len(fields) {
			break
		}
		sigLen := int(fields[off])
		sigByte := fields[off+1]
		off += sigLen + 2

		if fc == code && (sigByte == 's' || sigByte == 'o') {
			off = alignTo(off, 4)
			if off+4 <= len(fields) {
				sLen := int(readUint32(fields[off:off+4], le))
				off += 4
				if off+sLen <= len(fields) {
					return string(fields[off : off+sLen])
				}
			}
		}
		off = skipValue(fields, off, sigByte, le)
	}
	return ""
}

func extractSigField(fields []byte, code byte, le bool) string {
	off := 0
	for off < len(fields) {
		off = alignTo(off, 8)
		if off >= len(fields) {
			break
		}
		fc := fields[off]
		off++
		if off+2 > len(fields) {
			break
		}
		sigLen := int(fields[off])
		sigByte := fields[off+1]
		off += sigLen + 2

		if fc == code && sigByte == 'g' {
			if off < len(fields) {
				sl := int(fields[off])
				off++
				if off+sl <= len(fields) {
					return string(fields[off : off+sl])
				}
			}
		}
		off = skipValue(fields, off, sigByte, le)
	}
	return ""
}

func skipValue(buf []byte, off int, sigByte byte, le bool) int {
	switch sigByte {
	case 'y':
		return off + 1
	case 'b', 'u', 'i':
		off = alignTo(off, 4)
		return off + 4
	case 's', 'o':
		off = alignTo(off, 4)
		if off+4 > len(buf) {
			return len(buf)
		}
		sLen := int(readUint32(buf[off:off+4], le))
		return off + 4 + sLen + 1
	case 'g':
		if off >= len(buf) {
			return len(buf)
		}
		sl := int(buf[off])
		return off + 1 + sl + 1
	default:
		return len(buf) // can't parse, bail
	}
}

func alignTo(off, alignment int) int {
	rem := off % alignment
	if rem == 0 {
		return off
	}
	return off + alignment - rem
}

// --- Public body reading helpers ---

// ReadString reads a D-Bus string (uint32 length + bytes + NUL) at offset.
func ReadString(buf []byte, off int) (string, int, error) {
	off = alignTo(off, 4)
	if off+4 > len(buf) {
		return "", off, errors.New("string: buffer too short for length")
	}
	sLen := int(binary.LittleEndian.Uint32(buf[off : off+4]))
	off += 4
	if off+sLen > len(buf) {
		return "", off, errors.New("string: buffer too short for data")
	}
	s := string(buf[off : off+sLen])
	off += sLen + 1 // skip NUL
	return s, off, nil
}

// ReadUint32 reads a uint32 at offset.
func ReadUint32(buf []byte, off int) (uint32, int, error) {
	off = alignTo(off, 4)
	if off+4 > len(buf) {
		return 0, off, errors.New("uint32: buffer too short")
	}
	v := binary.LittleEndian.Uint32(buf[off : off+4])
	return v, off + 4, nil
}

// ReadInt32 reads an int32 at offset.
func ReadInt32(buf []byte, off int) (int32, int, error) {
	off = alignTo(off, 4)
	if off+4 > len(buf) {
		return 0, off, errors.New("int32: buffer too short")
	}
	v := int32(binary.LittleEndian.Uint32(buf[off : off+4]))
	return v, off + 4, nil
}

// ReadObjectPath reads an object path (same encoding as string).
func ReadObjectPath(buf []byte, off int) (string, int, error) {
	return ReadString(buf, off)
}

// ReadArrayHeader reads an array length and returns the byte count and new offset.
func ReadArrayHeader(buf []byte, off int) (int, int, error) {
	off = alignTo(off, 4)
	if off+4 > len(buf) {
		return 0, off, errors.New("array: buffer too short")
	}
	aLen := int(binary.LittleEndian.Uint32(buf[off : off+4]))
	return aLen, off + 4, nil
}

// MarshalUint32 encodes a uint32 for a method call body.
func MarshalUint32(v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return b
}

// MarshalInt32 encodes an int32 for a method call body.
func MarshalInt32(v int32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, uint32(v))
	return b
}

// MarshalString encodes a string for a method call body.
func MarshalString(s string) []byte {
	b := make([]byte, 4+len(s)+1)
	binary.LittleEndian.PutUint32(b, uint32(len(s)))
	copy(b[4:], s)
	return b
}

// AlignPad pads buf to the given alignment boundary with zero bytes.
func AlignPad(buf []byte, alignment int) []byte {
	return padTo(buf, alignment)
}
