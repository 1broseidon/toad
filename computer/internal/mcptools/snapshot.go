package mcptools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	snapshotDir      = "/home/agent/.vhd/snapshots"
	homeDir          = "/home/agent"
	maxSnapshotBytes = 500 * 1024 * 1024 // 500 MB
)

// Directories excluded from snapshot archives.
var snapshotExcludes = []string{
	".cache/ms-playwright",
	".npm",
	"__pycache__",
	".vhd/snapshots", // don't nest snapshots
}

// snapshotMeta is persisted alongside each snapshot archive.
type snapshotMeta struct {
	Name       string  `json:"name"`
	SizeMB     float64 `json:"size_mb"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt string  `json:"last_used_at,omitempty"`
	HasBrowser bool    `json:"has_browser_state"`
}

// --- Input types ---

type SnapshotSaveInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Name    string `json:"name" jsonschema:"snapshot name"`
}

type SnapshotLoadInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Name    string `json:"name" jsonschema:"snapshot name to restore"`
}

type SnapshotListInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
}

type SnapshotDeleteInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Name    string `json:"name" jsonschema:"snapshot name to delete"`
}

// --- Registration ---

// RegisterSnapshotTools adds full-environment snapshot management tools.
func RegisterSnapshotTools(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "snapshot_save",
		Description: "Save the full /home/agent/ environment (files, configs, browser state) as a named snapshot. Excludes caches. Use after complex setup to avoid repeating it.",
	}, snapshotSaveHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "snapshot_load",
		Description: "Restore a saved environment snapshot. Extracts files to /home/agent/ and restores browser state. Best used on a fresh desktop before any work begins.",
	}, snapshotLoadHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "snapshot_list",
		Description: "List all saved environment snapshots with name, size, and creation date.",
	}, snapshotListHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "snapshot_delete",
		Description: "Delete a saved environment snapshot by name.",
	}, snapshotDeleteHandler())
}

// --- Handlers ---

func snapshotSaveHandler() func(context.Context, *mcp.CallToolRequest, SnapshotSaveInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in SnapshotSaveInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		// Use a temp directory for the archive.
		tmpDir, err := os.MkdirTemp("", "vhd-snapshot-*")
		if err != nil {
			return nil, nil, fmt.Errorf("create temp dir: %w", err)
		}
		defer os.RemoveAll(tmpDir)

		// 1. Capture browser state if a session is active.
		hasBrowser := false
		browserStatePath := filepath.Join(tmpDir, "browser-state.json")
		if _, err := playwrightCLI(15*time.Second, "state-save", browserStatePath); err == nil {
			hasBrowser = true
		}

		// 2. Create tar.gz of /home/agent/ excluding caches and snapshot dir.
		archivePath := filepath.Join(tmpDir, "home.tar.gz")
		if err := createHomeArchive(archivePath); err != nil {
			return nil, nil, fmt.Errorf("snapshot_save: %w", err)
		}

		// 3. Check size limit.
		info, err := os.Stat(archivePath)
		if err != nil {
			return nil, nil, fmt.Errorf("snapshot_save: stat: %w", err)
		}
		if info.Size() > maxSnapshotBytes {
			return nil, nil, fmt.Errorf("snapshot too large: %.1f MB (max %d MB)",
				float64(info.Size())/(1024*1024), maxSnapshotBytes/(1024*1024))
		}

		sizeMB := float64(info.Size()) / (1024 * 1024)

		if isCloudDesktop() {
			if err := snapshotSaveCloud(in.Name, archivePath, browserStatePath, hasBrowser, info.Size()); err != nil {
				return nil, nil, err
			}
		} else {
			// Local-only: save to filesystem.
			dir := snapshotPackDir(in.Name)
			if err := os.MkdirAll(dir, 0700); err != nil {
				return nil, nil, fmt.Errorf("create snapshot dir: %w", err)
			}

			// Move archive to final location.
			localArchive := filepath.Join(dir, "home.tar.gz")
			archiveData, err := os.ReadFile(archivePath)
			if err != nil {
				return nil, nil, fmt.Errorf("read archive: %w", err)
			}
			if err := os.WriteFile(localArchive, archiveData, 0600); err != nil {
				return nil, nil, fmt.Errorf("write archive: %w", err)
			}

			// Copy browser state if present.
			if hasBrowser {
				bsData, _ := os.ReadFile(browserStatePath)
				os.WriteFile(filepath.Join(dir, "browser-state.json"), bsData, 0600)
			}

			// Write metadata.
			meta := snapshotMeta{
				Name:       in.Name,
				SizeMB:     sizeMB,
				CreatedAt:  time.Now().UTC().Format(time.RFC3339),
				HasBrowser: hasBrowser,
			}
			metaData, _ := json.Marshal(meta)
			os.WriteFile(filepath.Join(dir, "meta.json"), metaData, 0600)
		}

		result := map[string]any{
			"saved":         true,
			"name":          in.Name,
			"size_mb":       fmt.Sprintf("%.1f", sizeMB),
			"browser_state": hasBrowser,
		}
		data, _ := json.Marshal(result)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

func snapshotLoadHandler() func(context.Context, *mcp.CallToolRequest, SnapshotLoadInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in SnapshotLoadInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		// Check for fresh desktop: fail if user files exist beyond defaults.
		if !isDesktopFresh() {
			return nil, nil, fmt.Errorf("snapshot_load requires a fresh desktop — user files already exist in /home/agent/")
		}

		var archiveData []byte
		var browserStateData []byte

		if isCloudDesktop() {
			var err error
			archiveData, browserStateData, err = snapshotLoadCloud(in.Name)
			if err != nil {
				return nil, nil, err
			}
		} else {
			// Local-only: read from filesystem.
			dir := snapshotPackDir(in.Name)
			archivePath := filepath.Join(dir, "home.tar.gz")
			var err error
			archiveData, err = os.ReadFile(archivePath)
			if err != nil {
				return nil, nil, fmt.Errorf("snapshot %q not found", in.Name)
			}
			browserStatePath := filepath.Join(dir, "browser-state.json")
			browserStateData, _ = os.ReadFile(browserStatePath)
		}

		// Write archive to temp file and extract.
		tmpDir, err := os.MkdirTemp("", "vhd-snapshot-*")
		if err != nil {
			return nil, nil, fmt.Errorf("create temp dir: %w", err)
		}
		defer os.RemoveAll(tmpDir)

		archivePath := filepath.Join(tmpDir, "home.tar.gz")
		if err := os.WriteFile(archivePath, archiveData, 0600); err != nil {
			return nil, nil, fmt.Errorf("write archive: %w", err)
		}

		// 1. Extract archive to /home/agent/.
		if err := extractHomeArchive(archivePath); err != nil {
			return nil, nil, fmt.Errorf("snapshot_load: %w", err)
		}

		// 2. Restore browser state if present.
		browserRestored := false
		if len(browserStateData) > 0 {
			bsPath := filepath.Join(tmpDir, "browser-state.json")
			if err := os.WriteFile(bsPath, browserStateData, 0600); err == nil {
				if _, err := playwrightCLI(15*time.Second, "state-load", bsPath); err == nil {
					browserRestored = true
				}
			}
		}

		// 3. Update last_used_at.
		if !isCloudDesktop() {
			updateSnapshotLastUsed(snapshotPackDir(in.Name))
		}

		result := map[string]any{
			"loaded":           true,
			"name":             in.Name,
			"browser_restored": browserRestored,
		}
		data, _ := json.Marshal(result)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

func snapshotListHandler() func(context.Context, *mcp.CallToolRequest, SnapshotListInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in SnapshotListInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}

		if isCloudDesktop() {
			resp, err := serverRequest("GET", "/api/v1/states?type=snapshot", nil)
			if err != nil {
				return nil, nil, fmt.Errorf("list snapshots: %w", err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode >= 300 {
				return nil, nil, fmt.Errorf("list snapshots: %s", strings.TrimSpace(string(body)))
			}
			var packs []json.RawMessage
			json.Unmarshal(body, &packs)
			if len(packs) == 0 {
				return okResult("no snapshots"), nil, nil
			}
			return &mcp.CallToolResult{
				Content: []mcp.Content{&mcp.TextContent{Text: string(body)}},
			}, nil, nil
		}

		// Local-only fallback.
		entries, err := os.ReadDir(snapshotDir)
		if err != nil {
			if os.IsNotExist(err) {
				return okResult("no snapshots"), nil, nil
			}
			return nil, nil, fmt.Errorf("snapshot_list: %w", err)
		}

		var snapshots []snapshotMeta
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			metaPath := filepath.Join(snapshotDir, entry.Name(), "meta.json")
			data, err := os.ReadFile(metaPath)
			if err != nil {
				continue
			}
			var meta snapshotMeta
			if err := json.Unmarshal(data, &meta); err != nil {
				continue
			}
			snapshots = append(snapshots, meta)
		}

		if len(snapshots) == 0 {
			return okResult("no snapshots"), nil, nil
		}

		sort.Slice(snapshots, func(i, j int) bool {
			return snapshots[i].CreatedAt > snapshots[j].CreatedAt
		})

		data, _ := json.Marshal(snapshots)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}

func snapshotDeleteHandler() func(context.Context, *mcp.CallToolRequest, SnapshotDeleteInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in SnapshotDeleteInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if in.Name == "" {
			return nil, nil, fmt.Errorf("name is required")
		}

		if isCloudDesktop() {
			resp, err := serverRequest("DELETE", "/api/v1/states/"+in.Name+"?type=snapshot", nil)
			if err != nil {
				return nil, nil, fmt.Errorf("delete snapshot: %w", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode >= 300 {
				return nil, nil, fmt.Errorf("snapshot %q not found", in.Name)
			}
		} else {
			dir := snapshotPackDir(in.Name)
			if _, err := os.Stat(dir); err != nil {
				return nil, nil, fmt.Errorf("snapshot %q not found", in.Name)
			}
			if err := os.RemoveAll(dir); err != nil {
				return nil, nil, fmt.Errorf("snapshot_delete: %w", err)
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

func snapshotPackDir(name string) string {
	return filepath.Join(snapshotDir, name)
}

// createHomeArchive creates a tar.gz of /home/agent/ excluding cache dirs.
func createHomeArchive(archivePath string) error {
	args := []string{
		"czf", archivePath,
		"-C", "/home",
		"--preserve-permissions",
	}
	for _, excl := range snapshotExcludes {
		args = append(args, "--exclude="+excl)
	}
	args = append(args, "agent")

	cmd := exec.Command("tar", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("tar: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// extractHomeArchive extracts a snapshot tar.gz to /home/agent/.
func extractHomeArchive(archivePath string) error {
	cmd := exec.Command("tar", "xzf", archivePath,
		"-C", "/home",
		"--preserve-permissions",
		"--overwrite",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("tar extract: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// isDesktopFresh checks if /home/agent/ looks like a fresh desktop.
// A fresh desktop has only dot-config directories and no user-created files.
func isDesktopFresh() bool {
	entries, err := os.ReadDir(homeDir)
	if err != nil {
		return true // can't read = assume fresh
	}
	for _, entry := range entries {
		name := entry.Name()
		// Skip hidden dirs/files (default config), the vhd state dir, and playwright artifacts.
		if strings.HasPrefix(name, ".") {
			continue
		}
		// Any non-hidden file or directory means the desktop has been used.
		return false
	}
	return true
}

func updateSnapshotLastUsed(dir string) {
	metaPath := filepath.Join(dir, "meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return
	}
	var meta snapshotMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return
	}
	meta.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
	updated, _ := json.Marshal(meta)
	os.WriteFile(metaPath, updated, 0600)
}

func snapshotSaveCloud(name, archivePath, browserStatePath string, hasBrowser bool, archiveSize int64) error {
	archiveData, err := os.ReadFile(archivePath)
	if err != nil {
		return fmt.Errorf("read archive: %w", err)
	}

	combined := packSnapshotBlob(archiveData, browserStatePath, hasBrowser)

	upload := map[string]any{
		"name":        name,
		"type":        "snapshot",
		"blob_base64": base64.StdEncoding.EncodeToString(combined),
		"salt":        "",
		"size_bytes":  int(archiveSize),
		"browser":     "chromium",
	}
	body, _ := json.Marshal(upload)
	resp, err := serverRequest("POST", "/api/v1/states", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("upload snapshot: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload snapshot: %s", strings.TrimSpace(string(respBody)))
	}
	return nil
}

func packSnapshotBlob(archiveData []byte, browserStatePath string, hasBrowser bool) []byte {
	if hasBrowser {
		browserData, _ := os.ReadFile(browserStatePath)
		bsLen := len(browserData)
		combined := make([]byte, 4+bsLen+len(archiveData))
		combined[0] = byte(bsLen >> 24)
		combined[1] = byte(bsLen >> 16)
		combined[2] = byte(bsLen >> 8)
		combined[3] = byte(bsLen)
		copy(combined[4:], browserData)
		copy(combined[4+bsLen:], archiveData)
		return combined
	}
	combined := make([]byte, 4+len(archiveData))
	copy(combined[4:], archiveData)
	return combined
}

func snapshotLoadCloud(name string) (archiveData, browserStateData []byte, err error) {
	resp, err := serverRequest("GET", "/api/v1/states/"+name+"?type=snapshot", nil)
	if err != nil {
		return nil, nil, fmt.Errorf("download snapshot: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, nil, serverAPIError(resp, fmt.Sprintf("snapshot %q not found", name))
	}

	var pack struct {
		BlobBase64 string `json:"blob_base64"`
		Salt       string `json:"salt"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pack); err != nil {
		return nil, nil, fmt.Errorf("decode snapshot: %w", err)
	}

	combined, err := base64.StdEncoding.DecodeString(pack.BlobBase64)
	if err != nil {
		return nil, nil, fmt.Errorf("decode blob: %w", err)
	}

	if len(combined) < 4 {
		return nil, nil, fmt.Errorf("invalid snapshot data")
	}
	bsLen := int(combined[0])<<24 | int(combined[1])<<16 | int(combined[2])<<8 | int(combined[3])
	if bsLen > 0 && len(combined) >= 4+bsLen {
		browserStateData = combined[4 : 4+bsLen]
		archiveData = combined[4+bsLen:]
	} else {
		archiveData = combined[4:]
	}
	return archiveData, browserStateData, nil
}
