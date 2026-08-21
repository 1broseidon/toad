package mcptools

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"toad.sh/computer/internal/workspace"
)

// proxySession holds a persistent MCP session to a remote.
type proxySession struct {
	mcp       string // base MCP URL
	token     string // Bearer token for authenticated remotes
	sessionID string
	client    *http.Client
}

var (
	sessions   = map[string]*proxySession{}
	sessionsMu sync.Mutex
)

// getSession returns (or creates) an MCP session to a remote.
func getSession(name string, remote workspace.Remote) (*proxySession, error) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	if s, ok := sessions[name]; ok {
		return s, nil
	}

	s := &proxySession{
		mcp:    remote.MCP,
		token:  remote.Token,
		client: &http.Client{Timeout: 5 * time.Minute},
	}

	// Managed (vhd.io) remotes use stateless MCP — no init handshake needed.
	// Each request creates a temporary session server-side.
	if remote.Managed {
		sessions[name] = s
		return s, nil
	}

	// Docker/manual remotes: initialize MCP session.
	init := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": "2025-03-26",
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "vhd-proxy", "version": "0.1"},
		},
	}
	body, _ := json.Marshal(init)
	initReq, _ := http.NewRequest("POST", s.mcp, bytes.NewReader(body))
	initReq.Header.Set("Content-Type", "application/json")
	initReq.Header.Set("Accept", "application/json, text/event-stream")
	if s.token != "" {
		initReq.Header.Set("Authorization", "Bearer "+s.token)
	}
	resp, err := s.client.Do(initReq)
	if err != nil {
		return nil, fmt.Errorf("connect to remote %q: %w", name, err)
	}
	defer resp.Body.Close()

	// Extract session ID from header.
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		s.sessionID = sid
	}

	// Read the init response (SSE stream — read until double newline).
	drainSSE(resp.Body)
	resp.Body.Close()

	sessions[name] = s
	return s, nil
}

// ProxyToolCall forwards a tool call to a remote MCP server.
// Returns the text content from the remote's response.
func ProxyToolCall(remoteName, toolName string, args map[string]any) (string, error) {
	remotes := workspace.LoadRemotes()
	remote, ok := remotes[remoteName]
	if !ok {
		return "", fmt.Errorf("remote %q not found", remoteName)
	}

	sess, err := getSession(remoteName, remote)
	if err != nil {
		return "", err
	}

	// Strip the "desktop" field from args before forwarding.
	delete(args, "desktop")

	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      toolName,
			"arguments": args,
		},
	}
	body, _ := json.Marshal(req)

	httpReq, _ := http.NewRequest("POST", sess.mcp, bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	if sess.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+sess.token)
	}
	if sess.sessionID != "" {
		httpReq.Header.Set("Mcp-Session-Id", sess.sessionID)
	}

	resp, err := sess.client.Do(httpReq)
	if err != nil {
		// Session might be stale — clear and retry once.
		sessionsMu.Lock()
		delete(sessions, remoteName)
		sessionsMu.Unlock()
		return "", fmt.Errorf("remote %q: %w", remoteName, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		msg := strings.TrimSpace(string(body))
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return "", fmt.Errorf("remote %q: %s", remoteName, msg)
	}

	return parseToolResult(resp.Body, resp.Header.Get("Content-Type"))
}

// drainSSE reads an SSE stream until it gets a complete message (double newline).
func drainSSE(r io.Reader) {
	buf := make([]byte, 1024)
	var acc []byte
	for {
		n, err := r.Read(buf)
		if n > 0 {
			acc = append(acc, buf[:n]...)
		}
		if strings.Contains(string(acc), "\n\n") || err != nil {
			return
		}
	}
}

// parseToolResult extracts text content from a remote MCP response.
// Handles both SSE (text/event-stream) and plain JSON (application/json) responses.
func parseToolResult(r io.Reader, contentType string) (string, error) {
	buf, _ := io.ReadAll(r)

	// Collect JSON payloads to try: either from SSE data: lines or the whole body.
	var payloads []string
	if strings.Contains(contentType, "text/event-stream") {
		for _, line := range strings.Split(string(buf), "\n") {
			if strings.HasPrefix(line, "data: ") {
				payloads = append(payloads, strings.TrimPrefix(line, "data: "))
			}
		}
	} else {
		payloads = []string{string(buf)}
	}

	for _, payload := range payloads {
		var msg struct {
			Result struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
				StructuredContent json.RawMessage `json:"structuredContent"`
			} `json:"result"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(payload), &msg); err != nil {
			continue
		}
		if msg.Error != nil {
			return "", fmt.Errorf("remote error: %s", msg.Error.Message)
		}
		// Prefer structuredContent (exec results are serialized here).
		if len(msg.Result.StructuredContent) > 0 {
			return string(msg.Result.StructuredContent), nil
		}
		var texts []string
		for _, c := range msg.Result.Content {
			if c.Type == "text" {
				texts = append(texts, c.Text)
			}
		}
		if len(texts) > 0 {
			return strings.Join(texts, "\n"), nil
		}
	}
	return "", fmt.Errorf("no result in remote response")
}
