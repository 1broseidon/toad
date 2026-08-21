package mcptools

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"toad.sh/computer/internal/workspace"
)

// allowedPrefix is the path prefix that file operations are restricted to.
const allowedPrefix = "/home/agent/"

// tokenTTL is how long a file token remains valid.
const tokenTTL = 60 * time.Second

// maxUploadSize is the maximum upload body size (50 MB).
const maxUploadSize = 50 << 20

// fileToken represents a pending file download or upload.
type fileToken struct {
	Path      string // absolute file path (source for download, dest for upload)
	CreatedAt time.Time
	Upload    bool // true = upload (PUT/POST), false = download (GET)
}

// fileStore holds pending file tokens with TTL cleanup.
type fileStore struct {
	mu     sync.Mutex
	tokens map[string]*fileToken
	done   chan struct{}
}

// newFileStore creates a token store and starts the cleanup ticker.
func newFileStore() *fileStore {
	fs := &fileStore{
		tokens: make(map[string]*fileToken),
		done:   make(chan struct{}),
	}
	go fs.cleanup()
	return fs
}

// add generates a new token and stores the mapping. Returns the token string.
func (fs *fileStore) add(path string, upload bool) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	token := hex.EncodeToString(b)

	fs.mu.Lock()
	fs.tokens[token] = &fileToken{
		Path:      path,
		CreatedAt: time.Now(),
		Upload:    upload,
	}
	fs.mu.Unlock()
	return token, nil
}

// take retrieves and removes a token (single-use). Returns nil if not found or expired.
func (fs *fileStore) take(token string) *fileToken {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	ft, ok := fs.tokens[token]
	if !ok {
		return nil
	}
	if time.Since(ft.CreatedAt) > tokenTTL {
		delete(fs.tokens, token)
		return nil
	}
	delete(fs.tokens, token)
	return ft
}

// cleanup removes expired tokens every 10 seconds.
func (fs *fileStore) cleanup() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			fs.mu.Lock()
			for k, ft := range fs.tokens {
				if time.Since(ft.CreatedAt) > tokenTTL {
					delete(fs.tokens, k)
				}
			}
			fs.mu.Unlock()
		case <-fs.done:
			return
		}
	}
}

// Store is the package-level file store, initialized once.
var Store = newFileStore()

// validatePath checks that a path is under the allowed prefix.
func validatePath(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("invalid path: %w", err)
	}
	if abs != strings.TrimSuffix(allowedPrefix, "/") && !strings.HasPrefix(abs, allowedPrefix) {
		return fmt.Errorf("path must be under %s", allowedPrefix)
	}
	return nil
}

// FileHandler returns an http.Handler for /files/{token} routes.
// GET serves a file download; POST/PUT accepts a file upload.
func FileHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := filepath.Base(r.URL.Path)
		if token == "" || token == "." {
			http.Error(w, "missing token", http.StatusBadRequest)
			return
		}

		ft := Store.take(token)
		if ft == nil {
			http.Error(w, "token not found or expired", http.StatusNotFound)
			return
		}

		if ft.Upload {
			handleUpload(w, r, ft)
		} else {
			handleDownload(w, r, ft)
		}
	})
}

func handleDownload(w http.ResponseWriter, r *http.Request, ft *fileToken) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	f, err := os.Open(ft.Path)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.Error(w, "stat failed", http.StatusInternalServerError)
		return
	}

	// Content-Type from extension.
	ext := filepath.Ext(ft.Path)
	ct := mime.TypeByExtension(ext)
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, filepath.Base(ft.Path)))

	http.ServeContent(w, r, filepath.Base(ft.Path), info.ModTime(), f)
}

func handleUpload(w http.ResponseWriter, r *http.Request, ft *fileToken) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	// Ensure parent directory exists.
	dir := filepath.Dir(ft.Path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		http.Error(w, "cannot create directory", http.StatusInternalServerError)
		return
	}

	f, err := os.Create(ft.Path)
	if err != nil {
		http.Error(w, "cannot create file", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	if _, err := io.Copy(f, r.Body); err != nil {
		os.Remove(ft.Path)
		http.Error(w, "upload failed", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"ok":true,"path":%q}`, ft.Path)
}

// --- MCP tool input types ---

type FileGetInput struct {
	Desktop   string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Path      string `json:"path" jsonschema:"absolute file path on the desktop, e.g. /home/agent/Downloads/report.pdf"`
	LocalPath string `json:"local_path,omitempty" jsonschema:"local destination path (default: filename in current directory)"`
}

type FilePutInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Path    string `json:"path" jsonschema:"absolute destination path on the desktop"`
}

type FileListInput struct {
	Desktop string `json:"desktop,omitempty" jsonschema:"target desktop name (omit for local)"`
	Path    string `json:"path" jsonschema:"absolute directory path to list"`
}

// --- MCP tool registrations ---

// RegisterFileTools adds file_get, file_put, and file_list tools to the MCP server.
func RegisterFileTools(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "file_get",
		Description: "Download a file from the desktop to the local machine. Returns the local file path. For remote desktops, the file is fetched automatically via a secure single-use token.",
	}, fileGetHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "file_put",
		Description: "Get an upload URL for sending a file to the desktop. Returns a single-use URL (valid 60s). POST or PUT the file content to this URL.",
	}, filePutHandler())
	mcp.AddTool(server, &mcp.Tool{
		Name:        "file_list",
		Description: "List files in a directory on the desktop. Returns JSON with name, size, is_dir, and modified for each entry.",
	}, fileListHandler())
}

func fileGetHandler() func(context.Context, *mcp.CallToolRequest, FileGetInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in FileGetInput) (*mcp.CallToolResult, any, error) {
		// Remote desktop: get token, download file, save locally.
		if in.Desktop != "" && in.Desktop != "local" {
			return fileGetRemote(in)
		}

		// Local desktop: generate token URL (for serve.go HTTP handler).
		if err := validatePath(in.Path); err != nil {
			return nil, nil, err
		}
		info, err := os.Stat(in.Path)
		if err != nil {
			return nil, nil, fmt.Errorf("file not found: %s", in.Path)
		}
		if info.IsDir() {
			return nil, nil, fmt.Errorf("path is a directory, use file_list instead")
		}
		token, err := Store.add(in.Path, false)
		if err != nil {
			return nil, nil, err
		}
		url := fmt.Sprintf("/files/%s", token)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: url}},
		}, nil, nil
	}
}

// fileGetRemote fetches a file from a remote desktop and saves it locally.
func fileGetRemote(in FileGetInput) (*mcp.CallToolResult, any, error) {
	// Step 1: call file_get on the remote to get the token URL.
	args := map[string]any{"path": in.Path}
	tokenURL, err := ProxyToolCall(in.Desktop, "file_get", args)
	if err != nil {
		return nil, nil, fmt.Errorf("remote file_get: %w", err)
	}

	// Step 2: resolve the download URL via the remote's base URL.
	remotes := workspace.LoadRemotes()
	remote, ok := remotes[in.Desktop]
	if !ok {
		return nil, nil, fmt.Errorf("remote %q not found", in.Desktop)
	}

	// tokenURL is "/files/{token}". Build full URL from the remote's MCP base.
	// For managed remotes: MCP is "https://vhd.io/api/v1/desktops/{id}/mcp"
	//   → base is "https://vhd.io/api/v1/desktops/{id}"
	// For docker remotes: MCP is "http://localhost:PORT/mcp"
	//   → base is "http://localhost:PORT"
	baseURL := strings.TrimSuffix(remote.MCP, "/mcp")
	downloadURL := baseURL + tokenURL

	httpReq, err := http.NewRequest("GET", downloadURL, nil)
	if err != nil {
		return nil, nil, err
	}
	if remote.Token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+remote.Token)
	}

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, nil, fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, nil, fmt.Errorf("download failed (%d): %s", resp.StatusCode, string(body))
	}

	// Step 3: save to local path.
	localPath := in.LocalPath
	if localPath == "" {
		localPath = filepath.Base(in.Path)
	}

	f, err := os.Create(localPath)
	if err != nil {
		return nil, nil, fmt.Errorf("create local file: %w", err)
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		os.Remove(localPath)
		return nil, nil, fmt.Errorf("save file: %w", err)
	}

	absPath, _ := filepath.Abs(localPath)
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: absPath}},
	}, nil, nil
}

func filePutHandler() func(context.Context, *mcp.CallToolRequest, FilePutInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in FilePutInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := validatePath(in.Path); err != nil {
			return nil, nil, err
		}

		token, err := Store.add(in.Path, true)
		if err != nil {
			return nil, nil, err
		}

		url := fmt.Sprintf("/files/%s", token)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: url}},
		}, nil, nil
	}
}

type fileEntry struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	IsDir    bool   `json:"is_dir"`
	Modified string `json:"modified"`
}

func fileListHandler() func(context.Context, *mcp.CallToolRequest, FileListInput) (*mcp.CallToolResult, any, error) {
	return func(_ context.Context, req *mcp.CallToolRequest, in FileListInput) (*mcp.CallToolResult, any, error) {
		if r, ok, err := route(in.Desktop, req); ok {
			return r, nil, err
		}
		if err := validatePath(in.Path); err != nil {
			return nil, nil, err
		}

		entries, err := os.ReadDir(in.Path)
		if err != nil {
			return nil, nil, fmt.Errorf("cannot read directory: %w", err)
		}

		var result []fileEntry
		for _, e := range entries {
			info, err := e.Info()
			if err != nil {
				continue
			}
			result = append(result, fileEntry{
				Name:     e.Name(),
				Size:     info.Size(),
				IsDir:    e.IsDir(),
				Modified: info.ModTime().UTC().Format(time.RFC3339),
			})
		}

		data, err := json.Marshal(result)
		if err != nil {
			return nil, nil, err
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
}
