package workspace

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// Config holds user configuration for vhd.
type Config struct {
	Backend  string // "auto", "docker", or "cloud"
	Endpoint string // vhd.io API endpoint
}

// LoadConfig reads configuration from ~/.config/vhd/config (key=value),
// then overrides with environment variables. Returns sensible defaults
// if no config file exists.
func LoadConfig() Config {
	cfg := Config{
		Backend:  "auto",
		Endpoint: "https://vhd.io",
	}

	// Read config file.
	dir, err := os.UserConfigDir()
	if err == nil {
		path := filepath.Join(dir, "vhd", "config")
		if f, err := os.Open(path); err == nil {
			defer f.Close()
			scanner := bufio.NewScanner(f)
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				k, v, ok := strings.Cut(line, "=")
				if !ok {
					continue
				}
				k = strings.TrimSpace(k)
				v = strings.TrimSpace(v)
				switch k {
				case "backend":
					cfg.Backend = v
				case "endpoint":
					cfg.Endpoint = v
				}
			}
		}
	}

	// Env vars override.
	if v := os.Getenv("TOAD_COMPUTER_BACKEND"); v != "" {
		cfg.Backend = v
	}
	if v := os.Getenv("TOAD_COMPUTER_ENDPOINT"); v != "" {
		cfg.Endpoint = v
	}

	return cfg
}

// ResolveBackend returns the effective backend: "docker" or "cloud".
// Priority: TOAD_COMPUTER_BACKEND env > config file > auto-detect (credentials exist -> cloud, else docker).
func (c Config) ResolveBackend() string {
	// Explicit config wins.
	if c.Backend != "" && c.Backend != "auto" {
		return c.Backend
	}
	// Auto-detect: credentials exist -> cloud.
	if _, err := LoadCredentials(); err == nil {
		return "cloud"
	}
	return "docker"
}
