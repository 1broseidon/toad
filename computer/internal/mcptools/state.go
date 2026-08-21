package mcptools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const stateDir = "/home/agent/.vhd/states"

// stateMeta is the metadata stored alongside each state pack.
type stateMeta struct {
	Name       string   `json:"name"`
	Browser    string   `json:"browser"`
	Domains    []string `json:"domains,omitempty"`
	CreatedAt  string   `json:"created_at"`
	LastUsedAt string   `json:"last_used_at,omitempty"`
}

// --- Input types ---

type StateSaveInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Name    string `json:"name" jsonschema:"name for this saved login (e.g. jira-work, github)"`
}

type StateLoadInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Name    string `json:"name" jsonschema:"name of the saved login to restore"`
}

type StateListInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type StateDeleteInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Name    string `json:"name" jsonschema:"name of the saved login to delete"`
}

// --- Registration ---

// RegisterStateTools adds browser state pack management tools.
func RegisterStateTools(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "state_save",
		Description: "Save the current browser login state (cookies, localStorage) as a named pack. Use after a human logs into a site to remember the session for future desktops.",
	}, stateSaveHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "state_load",
		Description: "Restore a previously saved browser login state. Best used on a fresh desktop before the first real navigation. Restores cookies and localStorage from the named pack.",
	}, stateLoadHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "state_list",
		Description: "List all saved browser login states.",
	}, stateListHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "state_delete",
		Description: "Delete a saved browser login state by name.",
	}, stateDeleteHandler())
}

// --- Server-side helpers ---

// serverURL returns the VHD server API base URL, or empty for local-only mode.
func serverURL() string {
	return os.Getenv("TOAD_COMPUTER_SERVER_URL")
}

// stateToken returns the dedicated token used to authenticate state API requests.
func stateToken() string {
	return os.Getenv("TOAD_COMPUTER_STATE_TOKEN")
}

// isCloudDesktop returns true if server-side persistence is available.
func isCloudDesktop() bool {
	return serverURL() != "" && stateToken() != ""
}

// serverRequest makes an authenticated HTTP request to the server API.
func serverRequest(method, path string, body io.Reader) (*http.Response, error) {
	url := serverURL() + path
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+stateToken())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return http.DefaultClient.Do(req)
}

// --- Handlers ---

func stateSaveHandler() func(context.Context, *mcp.CallToolRequest, StateSaveInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in StateSaveInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		// Capture browser state via playwright-cli to a temp file.
		tmpDir, err := os.MkdirTemp("", "vhd-state-*")
		if err != nil {
			return nil, nil, fmt.Errorf("create temp dir: %w", err)
		}
		defer os.RemoveAll(tmpDir)

		statePath := filepath.Join(tmpDir, "state.json")
		out, err := playwrightCLI(15*time.Second, "state-save", statePath)
		if err != nil {
			return nil, nil, fmt.Errorf("state_save: %w", err)
		}

		// Extract domain info from the saved state.
		domains := extractDomainsFromState(statePath)

		// Read the state file.
		stateData, err := os.ReadFile(statePath)
		if err != nil {
			return nil, nil, fmt.Errorf("read state: %w", err)
		}

		if isCloudDesktop() {
			// Upload to server (plaintext over HTTPS for v1).
			domainsJSON, _ := json.Marshal(domains)
			upload := map[string]any{
				"name":        in.Name,
				"type":        "state",
				"blob_base64": base64.StdEncoding.EncodeToString(stateData),
				"salt":        "",
				"size_bytes":  len(stateData),
				"domains":     string(domainsJSON),
				"browser":     "chromium",
			}
			body, _ := json.Marshal(upload)
			resp, err := serverRequest("POST", "/api/v1/states", bytes.NewReader(body))
			if err != nil {
				return nil, nil, fmt.Errorf("upload state: %w", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode >= 300 {
				respBody, _ := io.ReadAll(resp.Body)
				return nil, nil, fmt.Errorf("upload state: %s", strings.TrimSpace(string(respBody)))
			}
		} else {
			// Local-only: save to filesystem.
			dir := statePackDir(in.Name)
			if err := os.MkdirAll(dir, 0700); err != nil {
				return nil, nil, fmt.Errorf("create state dir: %w", err)
			}
			if err := os.WriteFile(filepath.Join(dir, "state.json"), stateData, 0600); err != nil {
				return nil, nil, fmt.Errorf("write state: %w", err)
			}
			meta := stateMeta{
				Name:      in.Name,
				Browser:   "chromium",
				Domains:   domains,
				CreatedAt: time.Now().UTC().Format(time.RFC3339),
			}
			metaData, _ := json.Marshal(meta)
			os.WriteFile(filepath.Join(dir, "meta.json"), metaData, 0600)
		}

		result := map[string]any{
			"saved":   true,
			"name":    in.Name,
			"domains": domains,
		}
		if strings.TrimSpace(out) != "" {
			result["detail"] = strings.TrimSpace(out)
		}
		data, _ := json.Marshal(result)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

func stateLoadHandler() func(context.Context, *mcp.CallToolRequest, StateLoadInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in StateLoadInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		var stateData []byte

		if isCloudDesktop() {
			// Download from server and decrypt.
			resp, err := serverRequest("GET", "/api/v1/states/"+in.Name+"?type=state", nil)
			if err != nil {
				return nil, nil, fmt.Errorf("download state: %w", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode >= 300 {
				return nil, nil, serverAPIError(resp, fmt.Sprintf("saved login %q not found", in.Name))
			}

			var pack struct {
				BlobBase64 string `json:"blob_base64"`
				Salt       string `json:"salt"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&pack); err != nil {
				return nil, nil, fmt.Errorf("decode state: %w", err)
			}

			stateData, err = base64.StdEncoding.DecodeString(pack.BlobBase64)
			if err != nil {
				return nil, nil, fmt.Errorf("decode blob: %w", err)
			}
		} else {
			// Local-only: read from filesystem.
			dir := statePackDir(in.Name)
			statePath := filepath.Join(dir, "state.json")
			var err error
			stateData, err = os.ReadFile(statePath)
			if err != nil {
				return nil, nil, fmt.Errorf("saved login %q not found", in.Name)
			}
		}

		// Write to temp file and restore via playwright-cli.
		tmpDir, err := os.MkdirTemp("", "vhd-state-*")
		if err != nil {
			return nil, nil, fmt.Errorf("create temp dir: %w", err)
		}
		defer os.RemoveAll(tmpDir)

		statePath := filepath.Join(tmpDir, "state.json")
		if err := os.WriteFile(statePath, stateData, 0600); err != nil {
			return nil, nil, fmt.Errorf("write temp state: %w", err)
		}

		out, err := playwrightCLI(15*time.Second, "state-load", statePath)
		if err != nil {
			return nil, nil, fmt.Errorf("state_load: %w", err)
		}

		// Update last_used_at.
		if !isCloudDesktop() {
			updateLastUsed(statePackDir(in.Name))
		}

		result := map[string]any{
			"loaded": true,
			"name":   in.Name,
		}
		if strings.TrimSpace(out) != "" {
			result["detail"] = strings.TrimSpace(out)
		}
		data, _ := json.Marshal(result)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

func stateListHandler() func(context.Context, *mcp.CallToolRequest, StateListInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in StateListInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		if isCloudDesktop() {
			resp, err := serverRequest("GET", "/api/v1/states?type=state", nil)
			if err != nil {
				return nil, nil, fmt.Errorf("list states: %w", err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode >= 300 {
				return nil, nil, fmt.Errorf("list states: %s", strings.TrimSpace(string(body)))
			}
			// Parse to check if empty.
			var packs []json.RawMessage
			json.Unmarshal(body, &packs)
			if len(packs) == 0 {
				return okResult("no saved logins"), nil, nil
			}
			return &mcp.CallToolResult{
				Content: []mcp.Content{&mcp.TextContent{Text: string(body)}},
			}, nil, nil
		}

		// Local-only fallback.
		entries, err := os.ReadDir(stateDir)
		if err != nil {
			if os.IsNotExist(err) {
				return okResult("no saved logins"), nil, nil
			}
			return nil, nil, fmt.Errorf("state_list: %w", err)
		}

		var states []stateMeta
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			metaPath := filepath.Join(stateDir, entry.Name(), "meta.json")
			data, err := os.ReadFile(metaPath)
			if err != nil {
				continue
			}
			var meta stateMeta
			if err := json.Unmarshal(data, &meta); err != nil {
				continue
			}
			states = append(states, meta)
		}

		if len(states) == 0 {
			return okResult("no saved logins"), nil, nil
		}

		sort.Slice(states, func(i, j int) bool {
			return states[i].CreatedAt > states[j].CreatedAt
		})

		data, _ := json.Marshal(states)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

func stateDeleteHandler() func(context.Context, *mcp.CallToolRequest, StateDeleteInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in StateDeleteInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		if isCloudDesktop() {
			resp, err := serverRequest("DELETE", "/api/v1/states/"+in.Name+"?type=state", nil)
			if err != nil {
				return nil, nil, fmt.Errorf("delete state: %w", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode >= 300 {
				return nil, nil, fmt.Errorf("saved login %q not found", in.Name)
			}
		} else {
			dir := statePackDir(in.Name)
			if _, err := os.Stat(dir); err != nil {
				return nil, nil, fmt.Errorf("saved login %q not found", in.Name)
			}
			if err := os.RemoveAll(dir); err != nil {
				return nil, nil, fmt.Errorf("state_delete: %w", err)
			}
		}

		result := map[string]any{"deleted": true, "name": in.Name}
		data, _ := json.Marshal(result)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

// --- Helpers ---

func statePackDir(name string) string {
	return filepath.Join(stateDir, name)
}

// extractDomainsFromState reads the saved state JSON and extracts unique domains
// from cookies/localStorage entries.
func extractDomainsFromState(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var state struct {
		Cookies []struct {
			Domain string `json:"domain"`
		} `json:"cookies"`
		Origins []struct {
			Origin string `json:"origin"`
		} `json:"origins"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return nil
	}

	seen := map[string]bool{}
	for _, c := range state.Cookies {
		d := strings.TrimPrefix(c.Domain, ".")
		if d != "" {
			seen[d] = true
		}
	}
	for _, o := range state.Origins {
		// Extract domain from origin URL like "https://example.com".
		origin := o.Origin
		if idx := strings.Index(origin, "://"); idx >= 0 {
			origin = origin[idx+3:]
		}
		origin = strings.TrimSuffix(origin, "/")
		if origin != "" {
			seen[origin] = true
		}
	}

	var domains []string
	for d := range seen {
		domains = append(domains, d)
	}
	sort.Strings(domains)
	return domains
}

func updateLastUsed(dir string) {
	metaPath := filepath.Join(dir, "meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return
	}
	var meta stateMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return
	}
	meta.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
	updated, _ := json.Marshal(meta)
	os.WriteFile(metaPath, updated, 0600)
}

func serverAPIError(resp *http.Response, fallback string) error {
	body, _ := io.ReadAll(resp.Body)
	if len(body) == 0 {
		return fmt.Errorf("%s", fallback)
	}

	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err == nil && strings.TrimSpace(payload.Error) != "" {
		return fmt.Errorf("%s", payload.Error)
	}

	msg := strings.TrimSpace(string(body))
	if msg == "" {
		return fmt.Errorf("%s", fallback)
	}
	return fmt.Errorf("%s", msg)
}
