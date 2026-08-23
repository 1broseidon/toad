// Package vnc provides a WebSocket-to-VNC proxy for container and API server use.
package vnc

import (
	"log"
	"net"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

// Handler returns an http.Handler that serves a WebSocket-to-VNC bridge.
// Used by the container's local MCP server. `presence` (optional) is called
// with +1 when a viewer connects and -1 when it leaves, so the machine can
// yield the agent's hands while a person is at the screen.
func Handler(targetAddr string, presence func(delta int)) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/vnc", func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		if presence != nil {
			presence(1)
			defer presence(-1)
		}

		vnc, err := net.Dial("tcp", targetAddr)
		if err != nil {
			ws.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "vnc unavailable"))
			return
		}
		defer vnc.Close()

		done := make(chan struct{})
		go func() {
			defer close(done)
			// Closing the TCP leg on the way out matters: the main loop blocks
			// in vnc.Read, and an idle screen sends nothing — without this, a
			// departed viewer counts as present until the next frame happens by.
			defer vnc.Close()
			for {
				_, msg, err := ws.ReadMessage()
				if err != nil {
					return
				}
				if _, err := vnc.Write(msg); err != nil {
					return
				}
			}
		}()

		buf := make([]byte, 32*1024)
		for {
			n, err := vnc.Read(buf)
			if n > 0 {
				if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
			select {
			case <-done:
				return
			default:
			}
		}
	})

	return mux
}

// ProxyWebSocket proxies a WebSocket connection to a remote WebSocket endpoint.
// Used by the API server to bridge a viewer → container VNC.
func ProxyWebSocket(w http.ResponseWriter, r *http.Request, targetWSURL string, headers http.Header) {
	// Upgrade client connection.
	clientWS, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer clientWS.Close()

	// Dial upstream container WebSocket.
	dialer := websocket.Dialer{}
	upstreamWS, _, err := dialer.Dial(targetWSURL, headers)
	if err != nil {
		log.Printf("vnc proxy: dial upstream: %v", err)
		clientWS.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "upstream unavailable"))
		return
	}
	defer upstreamWS.Close()

	// Bidirectional relay.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			mt, msg, err := upstreamWS.ReadMessage()
			if err != nil {
				return
			}
			if err := clientWS.WriteMessage(mt, msg); err != nil {
				return
			}
		}
	}()

	for {
		mt, msg, err := clientWS.ReadMessage()
		if err != nil {
			return
		}
		if err := upstreamWS.WriteMessage(mt, msg); err != nil {
			return
		}
		select {
		case <-done:
			return
		default:
		}
	}
}
