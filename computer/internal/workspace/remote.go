package workspace

import (
	"bytes"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// Remote describes a remote vhd desktop endpoint.
type Remote struct {
	MCP       string `json:"mcp"`                 // e.g. "http://localhost:8788/mcp"
	VNC       string `json:"vnc"`                 // e.g. "localhost:5998"
	Container string `json:"container,omitempty"` // Docker container name, if managed by vhd
	Token     string `json:"token,omitempty"`     // Bearer token for authenticated remotes (vhd.io)
	Managed   bool   `json:"managed,omitempty"`   // true = provisioned via vhd.io, destroyable
}

// Remotes maps name → remote config.
type Remotes map[string]Remote

func remotesPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "vhd", "remotes.json")
}

// LoadRemotes reads the remote registry.
func LoadRemotes() Remotes {
	data, err := os.ReadFile(remotesPath())
	if err != nil {
		return make(Remotes)
	}
	var r Remotes
	if err := json.Unmarshal(data, &r); err != nil {
		return make(Remotes)
	}
	return r
}

// SaveRemotes writes the remote registry.
func SaveRemotes(r Remotes) error {
	path := remotesPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// AddRemote registers a remote desktop. hostPort is "host:port" for the MCP endpoint.
// vncPort overrides the discovered VNC port (0 = auto-discover from /info).
func AddRemote(name, hostPort string, vncPort int) error {
	remotes := LoadRemotes()
	mcp := fmt.Sprintf("http://%s/mcp", hostPort)

	// Extract host from hostPort.
	host := hostPort
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}

	vnc := discoverVNC(mcp, host, vncPort)
	remotes[name] = Remote{MCP: mcp, VNC: vnc}
	return SaveRemotes(remotes)
}

// discoverVNC queries the remote's /info endpoint to find the VNC port.
// If vncPort > 0, uses that override instead.
func discoverVNC(mcpURL, host string, vncPort int) string {
	if vncPort > 0 {
		return fmt.Sprintf("%s:%d", host, vncPort)
	}

	// Query /info — derive URL from MCP URL.
	infoURL := mcpURL[:len(mcpURL)-4] + "/info"
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(infoURL)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	var info struct {
		VNCPort int `json:"vnc_port"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || info.VNCPort == 0 {
		return ""
	}
	return fmt.Sprintf("%s:%d", host, info.VNCPort)
}

// RemoveRemote removes a remote desktop from the registry.
func RemoveRemote(name string) error {
	remotes := LoadRemotes()
	if _, ok := remotes[name]; !ok {
		return fmt.Errorf("remote %q not found", name)
	}
	delete(remotes, name)
	return SaveRemotes(remotes)
}

// DockerInit starts a new Docker container running the vhd image.
// It assigns random host ports for MCP and VNC, waits for health,
// and auto-registers the container as a remote.
func DockerInit(name, image string) error {
	if image == "" {
		image = "vhd"
	}

	containerName := "vhd-" + name

	// Check if container already exists.
	out, _ := exec.Command("docker", "inspect", "-f", "{{.State.Running}}", containerName).Output()
	if strings.TrimSpace(string(out)) == "true" {
		return fmt.Errorf("container %q is already running", containerName)
	}

	// Remove stopped container with same name if it exists.
	exec.Command("docker", "rm", "-f", containerName).Run()

	// Start container with random port mappings.
	cmd := exec.Command("docker", "run", "-d",
		"-p", "0:8787", // random MCP port
		"-p", "0:5999", // random VNC port
		"--shm-size=256m", // Chrome needs >64M shared memory
		"--name", containerName,
		image,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker run: %s", strings.TrimSpace(string(out)))
	}

	// Discover assigned ports.
	mcpPort, err := dockerPort(containerName, "8787")
	if err != nil {
		return fmt.Errorf("discover MCP port: %w", err)
	}
	vncPort, err := dockerPort(containerName, "5999")
	if err != nil {
		return fmt.Errorf("discover VNC port: %w", err)
	}

	// Wait for the container's health endpoint.
	mcpURL := fmt.Sprintf("http://localhost:%d/mcp", mcpPort)
	healthURL := fmt.Sprintf("http://localhost:%d/health", mcpPort)
	if err := waitForHealth(healthURL, 15*time.Second); err != nil {
		return fmt.Errorf("container failed to start: %w", err)
	}

	// Register as remote.
	remotes := LoadRemotes()
	remotes[name] = Remote{
		MCP:       mcpURL,
		VNC:       fmt.Sprintf("localhost:%d", vncPort),
		Container: containerName,
	}
	if err := SaveRemotes(remotes); err != nil {
		return err
	}

	fmt.Printf("\n  vhd — docker desktop\n\n")
	fmt.Printf("  Name:       %s\n", name)
	fmt.Printf("  Container:  %s\n", containerName)
	fmt.Printf("  Image:      %s\n", image)
	fmt.Printf("  MCP:        http://localhost:%d/mcp\n", mcpPort)
	fmt.Printf("  VNC:        localhost:%d\n", vncPort)
	fmt.Println()
	fmt.Printf("  View:       vhd view --remote %s\n", name)
	fmt.Printf("  Kill:       vhd kill %s\n", name)
	fmt.Println()
	return nil
}

// DockerStop stops and removes a Docker-managed remote desktop.
func DockerStop(name string) error {
	remotes := LoadRemotes()
	remote, ok := remotes[name]
	if !ok {
		return fmt.Errorf("remote %q not found", name)
	}
	if remote.Container == "" {
		return fmt.Errorf("remote %q is not a Docker container (use vhd remote rm to remove)", name)
	}

	// Stop and remove the container.
	exec.Command("docker", "stop", remote.Container).Run()
	exec.Command("docker", "rm", remote.Container).Run()

	// Remove from registry.
	delete(remotes, name)
	if err := SaveRemotes(remotes); err != nil {
		return err
	}

	fmt.Printf("  Docker desktop %q stopped and removed.\n", name)
	return nil
}

// dockerPort queries Docker for the host port mapped to a container's internal port.
func dockerPort(container, internalPort string) (int, error) {
	out, err := exec.Command("docker", "port", container, internalPort).Output()
	if err != nil {
		return 0, err
	}
	// Output: "0.0.0.0:32768\n[::]:32768\n" — take first line.
	line := strings.TrimSpace(strings.Split(string(out), "\n")[0])
	if i := strings.LastIndex(line, ":"); i >= 0 {
		return strconv.Atoi(line[i+1:])
	}
	return 0, fmt.Errorf("unexpected docker port output: %s", line)
}

// waitForHealth polls a health URL until it returns 200 or times out.
func waitForHealth(url string, timeout time.Duration) error {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for %s", url)
}

// Credentials stores vhd.io API credentials.
type Credentials struct {
	Endpoint     string `json:"endpoint"`
	Token        string `json:"token"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

func credentialsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "vhd", "credentials")
}

// LoadCredentials reads stored API credentials.
// TOAD_COMPUTER_API_KEY and TOAD_COMPUTER_ENDPOINT env vars take precedence.
func LoadCredentials() (*Credentials, error) {
	creds := &Credentials{Endpoint: "https://vhd.io"}

	// Try file first.
	data, err := os.ReadFile(credentialsPath())
	if err == nil {
		json.Unmarshal(data, creds)
	}

	// Env vars override.
	if v := os.Getenv("TOAD_COMPUTER_API_KEY"); v != "" {
		creds.Token = v
	}
	if v := os.Getenv("TOAD_COMPUTER_ENDPOINT"); v != "" {
		creds.Endpoint = v
	}

	if creds.Token == "" {
		return nil, fmt.Errorf("not logged in — run `vhd login` first or set TOAD_COMPUTER_API_KEY")
	}
	return creds, nil
}

// SaveCredentials writes API credentials to disk with 0600 permissions.
func SaveCredentials(creds *Credentials) error {
	path := credentialsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// CloudDesktop represents a desktop returned by the vhd.io API.
type CloudDesktop struct {
	ID             string     `json:"id"`
	Name           string     `json:"name,omitempty"`
	Image          string     `json:"image"`
	Status         string     `json:"status"`
	MCPURL         string     `json:"mcp_url"`
	CreatedAt      time.Time  `json:"created_at"`
	ExpiresAt      time.Time  `json:"expires_at"`
	LastActivityAt *time.Time `json:"last_activity_at,omitempty"`
}

// CloudList queries the vhd.io API for all desktops belonging to the authenticated key.
func CloudList(creds *Credentials) ([]CloudDesktop, error) {
	req, _ := http.NewRequest("GET", creds.Endpoint+"/api/v1/desktops", nil)
	req.Header.Set("Authorization", "Bearer "+creds.Token)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connect to %s: %w", creds.Endpoint, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned %d", resp.StatusCode)
	}

	var desktops []CloudDesktop
	if err := json.NewDecoder(resp.Body).Decode(&desktops); err != nil {
		return nil, fmt.Errorf("invalid response from server")
	}
	return desktops, nil
}

// CloudDestroyByID tears down a managed vhd.io desktop by API ID and cleans up local state.
func CloudDestroyByID(creds *Credentials, desktopID, name string) error {
	req, _ := http.NewRequest("DELETE", creds.Endpoint+"/api/v1/desktops/"+desktopID, nil)
	req.Header.Set("Authorization", "Bearer "+creds.Token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", creds.Endpoint, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&errResp)
		if errResp.Error != "" {
			return fmt.Errorf("%s", errResp.Error)
		}
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}

	// Clean up local remote entry if it exists.
	if name != "" {
		remotes := LoadRemotes()
		if _, ok := remotes[name]; ok {
			delete(remotes, name)
			SaveRemotes(remotes)
		}
	}

	fmt.Printf("  destroyed desktop %q\n", name)
	return nil
}

// CloudCreate provisions a desktop on vhd.io and registers it as a managed remote.
func CloudCreate(name, image string, creds *Credentials) error {
	if image == "" {
		image = "browser"
	}

	// Auto-generate name if empty.
	if name == "" {
		remotes := LoadRemotes()
		for i := 1; ; i++ {
			candidate := fmt.Sprintf("cloud-%d", i)
			if _, exists := remotes[candidate]; !exists {
				name = candidate
				break
			}
		}
	}

	// POST /api/v1/desktops
	body, _ := json.Marshal(map[string]string{"image": image, "name": name})
	req, _ := http.NewRequest("POST", creds.Endpoint+"/api/v1/desktops", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+creds.Token)

	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", creds.Endpoint, err)
	}
	defer resp.Body.Close()

	var result struct {
		ID     string `json:"id"`
		Image  string `json:"image"`
		MCPURL string `json:"mcp_url"`
		Error  string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("invalid response from server")
	}
	if resp.StatusCode != http.StatusCreated {
		if result.Error != "" {
			return fmt.Errorf("%s", result.Error)
		}
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}

	// Register as managed remote.
	mcpURL := creds.Endpoint + result.MCPURL
	remotes := LoadRemotes()
	remotes[name] = Remote{
		MCP:     mcpURL,
		Token:   creds.Token,
		Managed: true,
	}
	if err := SaveRemotes(remotes); err != nil {
		return err
	}

	fmt.Printf("\n  vhd — cloud desktop\n\n")
	fmt.Printf("  Name:    %s\n", name)
	fmt.Printf("  Image:   %s\n", image)
	fmt.Printf("  MCP:     %s\n", mcpURL)
	fmt.Println()
	fmt.Printf("  View:    vhd view %s\n", name)
	fmt.Printf("  Kill:    vhd kill %s\n", name)
	fmt.Println()
	return nil
}

// CloudDestroy tears down a managed vhd.io desktop and removes the remote.
func CloudDestroy(name string) error {
	remotes := LoadRemotes()
	remote, ok := remotes[name]
	if !ok {
		return fmt.Errorf("remote %q not found", name)
	}
	if !remote.Managed {
		return fmt.Errorf("%q is not a managed desktop — use `vhd remote rm` instead", name)
	}

	// Extract desktop ID from MCP URL: .../desktops/{id}/mcp
	parts := strings.Split(strings.TrimSuffix(remote.MCP, "/mcp"), "/")
	desktopID := parts[len(parts)-1]

	// Derive base endpoint from MCP URL.
	idx := strings.Index(remote.MCP, "/api/v1/desktops/")
	if idx < 0 {
		return fmt.Errorf("cannot parse endpoint from remote MCP URL")
	}
	endpoint := remote.MCP[:idx]

	token := remote.Token
	if v := os.Getenv("TOAD_COMPUTER_API_KEY"); v != "" {
		token = v
	}

	// DELETE /api/v1/desktops/{id}
	req, _ := http.NewRequest("DELETE", endpoint+"/api/v1/desktops/"+desktopID, nil)
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", endpoint, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&errResp)
		if errResp.Error != "" {
			return fmt.Errorf("%s", errResp.Error)
		}
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}

	// Remove from registry.
	delete(remotes, name)
	if err := SaveRemotes(remotes); err != nil {
		return err
	}

	fmt.Printf("  destroyed desktop %q\n", name)
	return nil
}

// CloudVerify checks that credentials are valid by hitting the health endpoint.
func CloudVerify(creds *Credentials) error {
	req, _ := http.NewRequest("GET", creds.Endpoint+"/api/v1/health", nil)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach %s: %w", creds.Endpoint, err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %d", creds.Endpoint, resp.StatusCode)
	}
	return nil
}

// OAuthLogin performs the browser-based OAuth login flow with PKCE.
// If noBrowser is true, prints the URL for the user to open manually.
func OAuthLogin(endpoint string, noBrowser bool) (*Credentials, error) {
	// Generate PKCE verifier + challenge.
	verifier := genRandomHex(32)
	h := sha256.Sum256([]byte(verifier))
	challenge := hex.EncodeToString(h[:])
	state := genRandomHex(16)

	// Start local HTTP server to receive callback.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("bind local port: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	redirectURI := fmt.Sprintf("http://localhost:%d/callback", port)

	authURL := fmt.Sprintf("%s/oauth/authorize?redirect_uri=%s&code_challenge=%s&state=%s",
		endpoint, redirectURI, challenge, state)

	// Channel for the auth code.
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("state") != state {
			http.Error(w, "invalid state", http.StatusBadRequest)
			errCh <- fmt.Errorf("state mismatch")
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "missing code", http.StatusBadRequest)
			errCh <- fmt.Errorf("no code in callback")
			return
		}
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><body style="background:#000;color:#fafafa;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Logged in</h2><p style="color:#888">You can close this tab.</p></div></body></html>`))
		codeCh <- code
	})

	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	defer srv.Close()

	// Open browser or print URL.
	if noBrowser || !tryOpenBrowser(authURL) {
		fmt.Printf("\n  Open this URL to log in:\n\n  %s\n\n  Waiting for authentication...\n", authURL)
	} else {
		fmt.Printf("  Opening browser to log in...\n")
	}

	// Wait for callback.
	var code string
	select {
	case code = <-codeCh:
	case err := <-errCh:
		return nil, err
	case <-time.After(5 * time.Minute):
		return nil, fmt.Errorf("login timed out (5 minutes)")
	}

	// Exchange code for tokens.
	form := fmt.Sprintf("grant_type=authorization_code&code=%s&code_verifier=%s", code, verifier)
	resp, err := http.Post(endpoint+"/oauth/token", "application/x-www-form-urlencoded", strings.NewReader(form))
	if err != nil {
		return nil, fmt.Errorf("token exchange: %w", err)
	}
	defer resp.Body.Close()

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Error        string `json:"error"`
		ErrorDesc    string `json:"error_description"`
	}
	json.NewDecoder(resp.Body).Decode(&tokenResp)
	if tokenResp.Error != "" {
		return nil, fmt.Errorf("%s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}
	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("no access token in response")
	}

	return &Credentials{
		Endpoint:     endpoint,
		Token:        tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
	}, nil
}

func genRandomHex(n int) string {
	b := make([]byte, n)
	crand.Read(b)
	return hex.EncodeToString(b)
}

func tryOpenBrowser(url string) bool {
	// Check if we have a display.
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return false
	}
	cmd := exec.Command("xdg-open", url)
	return cmd.Start() == nil
}

// viewManaged tunnels VNC for a managed (vhd.io) remote through the API WebSocket.
// It dials the server's /vnc WebSocket with Bearer auth, binds a local TCP listener,
// bridges WS↔TCP bidirectionally, and launches vncviewer.
func viewManaged(name string, remote Remote) error {
	// Derive WebSocket URL: .../desktops/{id}/mcp → .../desktops/{id}/vnc
	vncURL := strings.TrimSuffix(remote.MCP, "/mcp") + "/vnc"
	if strings.HasPrefix(vncURL, "https://") {
		vncURL = "wss://" + vncURL[len("https://"):]
	} else if strings.HasPrefix(vncURL, "http://") {
		vncURL = "ws://" + vncURL[len("http://"):]
	}

	// Bind a local TCP listener on a free port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("bind local port: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	// Dial the WebSocket with Bearer auth.
	dialer := websocket.Dialer{}
	headers := http.Header{
		"Authorization": {"Bearer " + remote.Token},
	}
	ws, _, err := dialer.Dial(vncURL, headers)
	if err != nil {
		ln.Close()
		return fmt.Errorf("connect to %s: %w", vncURL, err)
	}

	// Bridge WS↔TCP in the background.
	go bridgeWSToTCP(ln, ws)

	// Launch vncviewer.
	viewerPath, err := exec.LookPath("vncviewer")
	if err != nil {
		ln.Close()
		ws.Close()
		return fmt.Errorf("vncviewer not found (install tigervnc-viewer or similar)")
	}

	addr := fmt.Sprintf("localhost:%d", port)
	viewer := exec.Command(viewerPath, addr)
	viewer.Stdout = os.Stdout
	viewer.Stderr = os.Stderr
	if err := viewer.Start(); err != nil {
		return fmt.Errorf("start vncviewer: %w", err)
	}

	fmt.Printf("  Viewing remote %q at %s\n", name, addr)

	// Wait for vncviewer to exit — keeps the bridge goroutine alive.
	viewer.Wait()
	return nil
}

// bridgeWSToTCP accepts one TCP connection on ln and relays bidirectionally to ws.
func bridgeWSToTCP(ln net.Listener, ws *websocket.Conn) {
	defer ln.Close()
	defer ws.Close()

	conn, err := ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	ln.Close()

	// WS→TCP
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if _, err := conn.Write(msg); err != nil {
				return
			}
		}
	}()

	// TCP→WS
	buf := make([]byte, 32*1024)
	for {
		n, err := conn.Read(buf)
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
}

// RemoteHealth checks if a remote's MCP server is reachable.
func RemoteHealth(r Remote) bool {
	client := &http.Client{Timeout: 3 * time.Second}

	if r.Managed {
		// Managed remotes: GET the desktop endpoint (strip /mcp suffix).
		url := strings.TrimSuffix(r.MCP, "/mcp")
		req, _ := http.NewRequest("GET", url, nil)
		if r.Token != "" {
			req.Header.Set("Authorization", "Bearer "+r.Token)
		}
		resp, err := client.Do(req)
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}

	// Local/Docker remotes: derive /health from /mcp.
	healthURL := r.MCP[:len(r.MCP)-4] + "/health"
	resp, err := client.Get(healthURL)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
