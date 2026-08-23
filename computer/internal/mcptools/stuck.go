package mcptools

import (
	"fmt"
	"hash/fnv"
	"sync"

	"toad.computer/internal/screenshot"
)

// Stuck detection: the same click on the same frame, three times over, is a
// loop that looks like work. From inside the turn it feels like progress —
// tools return ok, time passes — so the machine itself has to say it: the
// input result grows a warning the agent reads exactly when it is looping.

const stuckAfter = 3

var (
	stuckMu   sync.Mutex
	lastSig   string
	lastFrame uint64
	sigRun    int
)

// frameHash samples the screen cheaply — every 8th pixel through FNV, RGB
// only. The fourth byte of an X11 32-bit pixel is undefined and reads back
// differently between identical frames; hashing it made every frame unique.
func frameHash() uint64 {
	img, err := screenshot.Capture()
	if err != nil {
		return 0
	}
	h := fnv.New64a()
	for i := 0; i+3 <= len(img.Pix); i += 32 { // every 8th RGBA pixel, alpha skipped
		h.Write(img.Pix[i : i+3])
	}
	return h.Sum64()
}

// noteInput records one mutating input action and returns a warning when the
// action keeps repeating and the screen has stopped answering. The action
// count and the frame check are separate on purpose: the first click moves
// the cursor into the frame, which changes it once — noise that must not buy
// a loop an extra free spin. What matters is that the action repeated and
// nothing has moved since the previous one.
//
// Call after the action ran; the hash runs before the lock so a slow capture
// can never stall the input pipeline.
func noteInput(sig string) string {
	current := frameHash()

	stuckMu.Lock()
	defer stuckMu.Unlock()

	if current == 0 || sig != lastSig {
		lastSig = sig
		lastFrame = current
		sigRun = 1
		return ""
	}
	sigRun++
	stable := current == lastFrame
	lastFrame = current
	if sigRun >= stuckAfter && stable {
		return fmt.Sprintf(
			"warning: %q has now run %d times and the screen is not changing. You are likely stuck — capture the screen, reassess, and try a different approach (or request_human if a person needs to act).",
			sig, sigRun)
	}
	return ""
}
