package mcptools

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"toad.sh/computer/internal/workspace"
)

const (
	runReservationHeader  = "X-Vhd-Run-Reservation"
	defaultRunMaxSteps    = 10
	defaultRunWaitSeconds = 30
	defaultRunBudget      = 45 * time.Second
	defaultRunQueueDepth  = 3
	defaultRunSettleMS    = 40
	runMaxStepsEnv        = "TOAD_COMPUTER_RUN_MAX_STEPS"
	runMaxWaitSecondsEnv  = "TOAD_COMPUTER_RUN_MAX_WAIT_SECONDS"
	runBudgetSecondsEnv   = "TOAD_COMPUTER_RUN_BUDGET_SECONDS"
	runQueueDepthEnv      = "TOAD_COMPUTER_RUN_QUEUE_DEPTH"
)

type toolCallRequest struct {
	ID      any
	Name    string
	Desktop string
	Args    map[string]any
}

type runReservation struct {
	queue *runQueue
}

type runQueue struct {
	slots chan struct{}
}

type httpStatusError struct {
	status  int
	message string
}

func (e *httpStatusError) Error() string {
	return e.message
}

func (e *httpStatusError) StatusCode() int {
	return e.status
}

var (
	desktopActionLocks sync.Map
	desktopRunQueues   sync.Map
	runReservations    sync.Map
	runReservationID   atomic.Uint64
)

func desktopKey(desktop string) string {
	if desktop != "" && desktop != "local" {
		return desktop
	}
	if display := workspace.Display(); display != "" {
		return display
	}
	if display := os.Getenv("DISPLAY"); display != "" {
		return display
	}
	return ":99"
}

func lockDesktopActions(desktop string) func() {
	key := desktopKey(desktop)
	lock, _ := desktopActionLocks.LoadOrStore(key, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// lockDesktopMutating acquires the desktop lock and checks for an active
// control lease. Returns (unlock, error). If error is non-nil the lock was
// not acquired and the caller must not proceed.
func lockDesktopMutating(desktop string) (func(), error) {
	if err := checkLease(desktop); err != nil {
		return nil, err
	}
	return lockDesktopActions(desktop), nil
}

func runMaxSteps() int {
	return envInt(runMaxStepsEnv, defaultRunMaxSteps)
}

func runMaxWait() time.Duration {
	return time.Duration(envInt(runMaxWaitSecondsEnv, defaultRunWaitSeconds)) * time.Second
}

func runBudget() time.Duration {
	return time.Duration(envInt(runBudgetSecondsEnv, int(defaultRunBudget/time.Second))) * time.Second
}

func runQueueDepth() int {
	return envInt(runQueueDepthEnv, defaultRunQueueDepth)
}

func runDefaultSettle() time.Duration {
	return time.Duration(defaultRunSettleMS) * time.Millisecond
}

func RunQueueMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}

		body, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}

		req, ok := parseToolCall(body)
		if !ok || !isBatchCall(req) || (req.Desktop != "" && req.Desktop != "local") {
			r.Body = io.NopCloser(bytes.NewReader(body))
			next.ServeHTTP(w, r)
			return
		}

		token, err := reserveRunSlot(req.Desktop)
		if err != nil {
			status := http.StatusTooManyRequests
			var statusErr interface{ StatusCode() int }
			if errors.As(err, &statusErr) {
				status = statusErr.StatusCode()
			}
			http.Error(w, err.Error(), status)
			return
		}
		defer releaseRunReservation(token)

		clone := r.Clone(r.Context())
		clone.Header = r.Header.Clone()
		clone.Header.Set(runReservationHeader, token)
		clone.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(w, clone)
	})
}

func claimRunSlot(desktop string, req *mcp.CallToolRequest) (func(), error) {
	if req != nil && req.Extra != nil {
		if token := req.Extra.Header.Get(runReservationHeader); token != "" {
			if release := takeRunReservation(token); release != nil {
				return release, nil
			}
		}
	}

	token, err := reserveRunSlot(desktop)
	if err != nil {
		return nil, err
	}
	release := takeRunReservation(token)
	if release == nil {
		return nil, fmt.Errorf("run reservation missing")
	}
	return release, nil
}

// isBatchCall spots a scripted batch whichever door it came through: the
// grouped surface's input/action=batch, or the granular era's run tool.
func isBatchCall(req toolCallRequest) bool {
	if req.Name == "run" {
		return true
	}
	action, _ := req.Args["action"].(string)
	return req.Name == "input" && action == "batch"
}

func parseToolCall(body []byte) (toolCallRequest, bool) {
	var req struct {
		ID     any    `json:"id"`
		Method string `json:"method"`
		Params struct {
			Name string         `json:"name"`
			Args map[string]any `json:"arguments"`
		} `json:"params"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return toolCallRequest{}, false
	}
	if req.Method != "tools/call" {
		return toolCallRequest{}, false
	}
	desktop, _ := req.Params.Args["desktop"].(string)
	return toolCallRequest{
		ID:      req.ID,
		Name:    req.Params.Name,
		Desktop: desktop,
		Args:    req.Params.Args,
	}, true
}

func reserveRunSlot(desktop string) (string, error) {
	queue := queueForDesktop(desktop)
	select {
	case queue.slots <- struct{}{}:
	default:
		return "", &httpStatusError{
			status:  http.StatusTooManyRequests,
			message: fmt.Sprintf("run queue full for %s", desktopKey(desktop)),
		}
	}

	token := fmt.Sprintf("run-%d", runReservationID.Add(1))
	runReservations.Store(token, &runReservation{queue: queue})
	return token, nil
}

func queueForDesktop(desktop string) *runQueue {
	key := desktopKey(desktop)
	queue, _ := desktopRunQueues.LoadOrStore(key, &runQueue{
		slots: make(chan struct{}, runQueueDepth()+1),
	})
	return queue.(*runQueue)
}

func releaseRunReservation(token string) {
	if release := takeRunReservation(token); release != nil {
		release()
	}
}

func takeRunReservation(token string) func() {
	reservation, ok := runReservations.LoadAndDelete(token)
	if !ok {
		return nil
	}
	queue := reservation.(*runReservation).queue
	return func() {
		select {
		case <-queue.slots:
		default:
		}
	}
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 {
		return fallback
	}
	return n
}
