// App launch configuration: per-application flags and environment for the
// agent's virtual desktop. Browsers need special flags (e.g.
// --force-renderer-accessibility) for agent control.
//
// Config is loaded from three layers, later overriding earlier:
//  1. Built-in defaults (embedded in binary)
//  2. Project manifest: ./toad-apps.json
//  3. User config: ~/.config/toad-computer/apps.json
package workspace

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
)

// AppConfig describes how to launch an application for agent use.
type AppConfig struct {
	Match []string          `json:"match"`         // executable basenames that match this config
	Flags []string          `json:"flags"`         // CLI flags to inject
	Env   map[string]string `json:"env,omitempty"` // environment variables to set
}

// AppRegistry maps a logical app name to its launch configuration.
type AppRegistry map[string]AppConfig

// builtinAppsJSON is the default config embedded in the binary.
const builtinAppsJSON = `{
  "chromium": {
    "match": ["chromium", "chromium-browser", "google-chrome", "chrome", "brave-browser", "brave", "microsoft-edge", "msedge"],
    "flags": ["--force-renderer-accessibility", "--disable-gpu", "--no-first-run", "--no-session-restore", "--user-data-dir=/tmp/toad-computer/profiles/chromium", "--disable-background-networking", "--metrics-recording-only", "--no-default-browser-check", "--disable-breakpad"],
    "env": {}
  },
  "firefox": {
    "match": ["firefox", "firefox-esr"],
    "flags": ["-profile", "/tmp/toad-computer/profiles/firefox", "-no-remote"],
    "env": {"MOZ_ENABLE_WAYLAND": "0"}
  },
  "electron": {
    "match": ["code", "cursor", "slack", "discord", "obsidian", "signal-desktop"],
    "flags": ["--force-renderer-accessibility", "--user-data-dir=/tmp/toad-computer/profiles/electron"],
    "env": {}
  }
}`

// LoadApps reads the merged app config from all three layers.
func LoadApps() AppRegistry {
	cfg := make(AppRegistry)

	// Layer 1: built-in defaults.
	json.Unmarshal([]byte(builtinAppsJSON), &cfg)

	// Layer 2: project manifest (cwd).
	mergeAppsFromFile(cfg, "toad-apps.json")

	// Layer 3: user config.
	if home, err := os.UserHomeDir(); err == nil {
		mergeAppsFromFile(cfg, filepath.Join(home, ".config", "toad-computer", "apps.json"))
	}

	// Container mode: add --no-sandbox and --remote-debugging-port for CDP tools.
	// --test-type suppresses the "unsupported flag" infobar that --no-sandbox triggers.
	if inContainer() {
		for _, name := range []string{"chromium", "electron"} {
			if app, ok := cfg[name]; ok {
				app.Flags = append(app.Flags, "--no-sandbox", "--test-type")
				cfg[name] = app
			}
		}
		if app, ok := cfg["chromium"]; ok {
			app.Flags = append(app.Flags, "--remote-debugging-port=9222")
			cfg["chromium"] = app
		}
	}

	return cfg
}

// inContainer returns true if running inside Docker/Podman/Fly.
func inContainer() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	if os.Getenv("container") != "" {
		return true
	}
	if os.Getenv("FLY_MACHINE_ID") != "" {
		return true
	}
	return false
}

// Lookup finds the config for a given executable path.
func (r AppRegistry) Lookup(executable string) (AppConfig, bool) {
	base := filepath.Base(executable)
	for _, app := range r {
		if slices.Contains(app.Match, base) {
			return app, true
		}
	}
	return AppConfig{}, false
}

// InjectArgs prepends configured flags to args, skipping any already present.
func (ac AppConfig) InjectArgs(args []string) []string {
	if len(ac.Flags) == 0 {
		return args
	}

	existing := make(map[string]bool, len(args))
	for _, a := range args[1:] {
		existing[a] = true
	}

	result := []string{args[0]}
	for _, f := range ac.Flags {
		if !existing[f] {
			result = append(result, f)
		}
	}
	return append(result, args[1:]...)
}

// InjectEnv returns env with the app's configured variables appended.
// Existing values in env are not overwritten.
func (ac AppConfig) InjectEnv(env []string) []string {
	if len(ac.Env) == 0 {
		return env
	}

	keys := make(map[string]bool, len(env))
	for _, e := range env {
		for i := range e {
			if e[i] == '=' {
				keys[e[:i]] = true
				break
			}
		}
	}

	for k, v := range ac.Env {
		if !keys[k] {
			env = append(env, k+"="+v)
		}
	}
	return env
}

func mergeAppsFromFile(cfg AppRegistry, path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var overlay AppRegistry
	if err := json.Unmarshal(data, &overlay); err != nil {
		return
	}
	maps.Copy(cfg, overlay)
}
