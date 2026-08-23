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
)

const (
	runReservationHeader  = "X-Computer-Run-Reservation"
	holderHeader          = "X-Computer-Holder"
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
	ID   any
	Name string
	Args map[string]any
}

type runReservation struct {
	holder string
	queue  *runQueue
}

type runQueue struct {
	slots chan struct{}
}

type httpStatusError struct {
	status  int
	message string
}

func (e *httpStatusError) Error() string   { return e.message }
func (e *httpStatusError) StatusCode() int { return e.status }

var (
	actionLock       sync.Mutex
	runQueueOnce     sync.Once
	theRunQueue      *runQueue
	runReservations  sync.Map
	runReservationID atomic.Uint64
	slotHolderMu     sync.Mutex
	slotHolder       string
)

func lockActions() func() {
	actionLock.Lock()
	return actionLock.Unlock
}

// lockMutating acquires the machine lock and checks for an active
// control lease. If error is non-nil the lock was not acquired.
func lockMutating() (func(), error) {
	if err := checkLease(); err != nil {
		return nil, err
	}
	return lockActions(), nil
}

func runMaxSteps() int { return envInt(runMaxStepsEnv, defaultRunMaxSteps) }

func runMaxWait() time.Duration {
	return time.Duration(envInt(runMaxWaitSecondsEnv, defaultRunWaitSeconds)) * time.Second
}

func runBudget() time.Duration {
	return time.Duration(envInt(runBudgetSecondsEnv, int(defaultRunBudget/time.Second))) * time.Second
}

func runQueueDepth() int { return envInt(runQueueDepthEnv, defaultRunQueueDepth) }

func runDefaultSettle() time.Duration {
	return time.Duration(defaultRunSettleMS) * time.Millisecond
}

func machineQueue() *runQueue {
	runQueueOnce.Do(func() {
		theRunQueue = &runQueue{slots: make(chan struct{}, runQueueDepth()+1)}
	})
	return theRunQueue
}

func holderOf(r *http.Request, req *mcp.CallToolRequest) string {
	if r != nil {
		if h := r.Header.Get(holderHeader); h != "" {
			return h
		}
	}
	if req != nil && req.Extra != nil && req.Extra.Header != nil {
		if h := req.Extra.Header.Get(holderHeader); h != "" {
			return h
		}
	}
	return "anonymous"
}

func RunQueueMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}

		// The SDK caps bodies too, but this runs first; read no more than it would.
		r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBodyBytes)
		body, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				http.Error(w, fmt.Sprintf("request body exceeds %d bytes", tooLarge.Limit), http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "read request body: "+err.Error(), http.StatusBadRequest)
			return
		}

		req, ok := parseToolCall(body)
		if !ok || !isBatchCall(req) {
			r.Body = io.NopCloser(bytes.NewReader(body))
			next.ServeHTTP(w, r)
			return
		}

		token, err := reserveRunSlot(holderOf(r, nil))
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

func claimRunSlot(req *mcp.CallToolRequest) (func(), error) {
	if req != nil && req.Extra != nil {
		if token := req.Extra.Header.Get(runReservationHeader); token != "" {
			if release := takeRunReservation(token); release != nil {
				return release, nil
			}
		}
	}

	token, err := reserveRunSlot(holderOf(nil, req))
	if err != nil {
		return nil, err
	}
	release := takeRunReservation(token)
	if release == nil {
		return nil, fmt.Errorf("run reservation missing")
	}
	return release, nil
}

func isBatchCall(req toolCallRequest) bool {
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
	return toolCallRequest{
		ID:   req.ID,
		Name: req.Params.Name,
		Args: req.Params.Args,
	}, true
}

func reserveRunSlot(holder string) (string, error) {
	if holder == "" {
		holder = "anonymous"
	}
	queue := machineQueue()
	select {
	case queue.slots <- struct{}{}:
	default:
		slotHolderMu.Lock()
		busy := slotHolder
		slotHolderMu.Unlock()
		if busy == "" {
			busy = "another caller"
		}
		return "", &httpStatusError{
			status:  http.StatusTooManyRequests,
			message: fmt.Sprintf("run queue full — %s holds the machine", busy),
		}
	}

	token := fmt.Sprintf("run-%d", runReservationID.Add(1))
	runReservations.Store(token, &runReservation{holder: holder, queue: queue})
	slotHolderMu.Lock()
	slotHolder = holder
	slotHolderMu.Unlock()
	return token, nil
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
	res := reservation.(*runReservation)
	return func() {
		select {
		case <-res.queue.slots:
		default:
		}
		slotHolderMu.Lock()
		if slotHolder == res.holder {
			slotHolder = ""
		}
		slotHolderMu.Unlock()
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
