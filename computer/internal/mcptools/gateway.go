package mcptools

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// GatewayMiddleware wraps an MCP HTTP handler and intercepts tool calls
// that include a "desktop" field, proxying them to the named remote.
// Requests without "desktop" (or desktop="local") pass through to the local handler.
func GatewayMiddleware(local http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only intercept POST requests (tool calls).
		if r.Method != http.MethodPost {
			local.ServeHTTP(w, r)
			return
		}

		// Read and buffer the body so we can peek and replay.
		body, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil {
			local.ServeHTTP(w, r)
			return
		}

		// Try to extract desktop from tool call args.
		desktop, reqID, toolName, args := extractDesktop(body)
		if desktop == "" {
			// No desktop field — replay body unchanged.
			r.Body = io.NopCloser(bytes.NewReader(body))
			local.ServeHTTP(w, r)
			return
		}
		if desktop == "local" {
			// Strip "desktop" from args so local handler accepts the request.
			r.Body = io.NopCloser(bytes.NewReader(stripDesktop(body)))
			local.ServeHTTP(w, r)
			return
		}

		// Proxy to remote.
		result, err := ProxyToolCall(desktop, toolName, args)
		if err != nil {
			writeSSEError(w, reqID, err)
			return
		}
		writeSSEResult(w, reqID, result)
	})
}

// extractDesktop peeks at a JSON-RPC request body for tools/call with a desktop arg.
// Returns (desktop, requestID, toolName, args) or ("", nil, "", nil) if not a proxied tool call.
func extractDesktop(body []byte) (string, any, string, map[string]any) {
	var req struct {
		ID     any    `json:"id"`
		Method string `json:"method"`
		Params struct {
			Name string         `json:"name"`
			Args map[string]any `json:"arguments"`
		} `json:"params"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return "", nil, "", nil
	}
	if req.Method != "tools/call" {
		return "", nil, "", nil
	}
	desktop, ok := req.Params.Args["desktop"].(string)
	if !ok || desktop == "" {
		return "", nil, "", nil
	}
	return desktop, req.ID, req.Params.Name, req.Params.Args
}

// stripDesktop removes the "desktop" field from a tools/call arguments object.
func stripDesktop(body []byte) []byte {
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		return body
	}
	params, _ := req["params"].(map[string]any)
	args, _ := params["arguments"].(map[string]any)
	delete(args, "desktop")
	out, err := json.Marshal(req)
	if err != nil {
		return body
	}
	return out
}

func writeSSEResult(w http.ResponseWriter, id any, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result": map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": text},
			},
		},
	}
	data, _ := json.Marshal(resp)
	fmt.Fprintf(w, "event: message\ndata: %s\n\n", data)
}

func writeSSEError(w http.ResponseWriter, id any, err error) {
	w.Header().Set("Content-Type", "text/event-stream")
	resp := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    -32000,
			"message": err.Error(),
		},
	}
	data, _ := json.Marshal(resp)
	fmt.Fprintf(w, "event: message\ndata: %s\n\n", data)
}
