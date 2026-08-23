package mcptools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const stateDir = "/home/agent/.toad-computer/states"

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
	Name string `json:"name" jsonschema:"name for this saved login (e.g. jira-work, github)"`
}

type StateLoadInput struct {
	Name string `json:"name" jsonschema:"name of the saved login to restore"`
}

type StateListInput struct {
}

type StateDeleteInput struct {
	Name string `json:"name" jsonschema:"name of the saved login to delete"`
}

// --- Handlers ---

func stateSaveHandler() func(context.Context, *mcp.CallToolRequest, StateSaveInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in StateSaveInput) (*mcp.CallToolResult, any, error) {
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		// Capture browser state via playwright-cli to a temp file.
		tmpDir, err := os.MkdirTemp("", "toad-state-*")
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
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		stateData, err := os.ReadFile(filepath.Join(statePackDir(in.Name), "state.json"))
		if err != nil {
			return nil, nil, fmt.Errorf("saved login %q not found", in.Name)
		}

		// Write to temp file and restore via playwright-cli.
		tmpDir, err := os.MkdirTemp("", "toad-state-*")
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
		updateLastUsed(statePackDir(in.Name))

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
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		dir := statePackDir(in.Name)
		if _, err := os.Stat(dir); err != nil {
			return nil, nil, fmt.Errorf("saved login %q not found", in.Name)
		}
		if err := os.RemoveAll(dir); err != nil {
			return nil, nil, fmt.Errorf("state_delete: %w", err)
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
