package mcptools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	allowedPrefix = "/home/agent/"
	maxUploadSize = 50 << 20
)

type FilesGroupInput struct {
	Action   string `json:"action" jsonschema:"one of: get, put, list"`
	Path     string `json:"path" jsonschema:"absolute path on the machine, under /home/agent/"`
	Content  string `json:"content,omitempty" jsonschema:"put: file bytes as text, or base64 when encoding=base64"`
	Encoding string `json:"encoding,omitempty" jsonschema:"put: utf8 (default) or base64"`
}

func registerFiles(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "files",
		Description: "Move files across the machine boundary over MCP. get returns the file (text, or a base64 blob if it is not UTF-8). put writes content from the tool call (utf8 text or encoding=base64). list shows a directory. Paths stay under /home/agent/. Cap 50MB.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, in FilesGroupInput) (*mcp.CallToolResult, any, error) {
		switch in.Action {
		case "get":
			return fileGet(in.Path)
		case "put":
			return filePut(in.Path, in.Content, in.Encoding)
		case "list":
			return fileList(in.Path)
		default:
			return nil, nil, actionError("files", in.Action, "get", "put", "list")
		}
	})
}

func validatePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}
	if abs != strings.TrimSuffix(allowedPrefix, "/") && !strings.HasPrefix(abs, allowedPrefix) {
		return "", fmt.Errorf("path must be under %s", allowedPrefix)
	}
	return abs, nil
}

func fileGet(path string) (*mcp.CallToolResult, any, error) {
	abs, err := validatePath(path)
	if err != nil {
		return nil, nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, nil, fmt.Errorf("file not found: %s", path)
	}
	if info.IsDir() {
		return nil, nil, fmt.Errorf("path is a directory, use files action=list")
	}
	if info.Size() > maxUploadSize {
		return nil, nil, fmt.Errorf("file too large (%d bytes, max %d)", info.Size(), maxUploadSize)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, nil, err
	}
	if utf8.Valid(data) {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	}
	encoded := base64.StdEncoding.EncodeToString(data)
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{
			Text: fmt.Sprintf("encoding=base64\npath=%s\n%s", abs, encoded),
		}},
	}, nil, nil
}

func filePut(path, content, encoding string) (*mcp.CallToolResult, any, error) {
	abs, err := validatePath(path)
	if err != nil {
		return nil, nil, err
	}
	var data []byte
	switch strings.ToLower(encoding) {
	case "", "utf8", "text":
		data = []byte(content)
	case "base64":
		data, err = base64.StdEncoding.DecodeString(content)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid base64: %w", err)
		}
	default:
		return nil, nil, fmt.Errorf("encoding must be utf8 or base64")
	}
	if len(data) > maxUploadSize {
		return nil, nil, fmt.Errorf("file too large (%d bytes, max %d)", len(data), maxUploadSize)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return nil, nil, err
	}
	return okResult(fmt.Sprintf("wrote %s (%d bytes)", abs, len(data))), nil, nil
}

type fileEntry struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	IsDir    bool   `json:"is_dir"`
	Modified string `json:"modified"`
}

func fileList(path string) (*mcp.CallToolResult, any, error) {
	abs, err := validatePath(path)
	if err != nil {
		return nil, nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, nil, fmt.Errorf("cannot read directory: %s", path)
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
			Modified: info.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
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
