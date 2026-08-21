// Package names generates random two-word desktop names (adjective-noun).
package names

import (
	"fmt"
	"math/rand/v2"
)

var adjectives = []string{
	"blue", "calm", "dark", "fast", "gold",
	"green", "keen", "late", "live", "loud",
	"pale", "pink", "pure", "rare", "red",
	"safe", "slim", "soft", "warm", "wise",
}

var nouns = []string{
	"anvil", "bloom", "cedar", "cloud", "crane",
	"delta", "dusk", "ember", "frost", "grove",
	"haze", "inlet", "jade", "knoll", "lark",
	"maple", "north", "opal", "prism", "ridge",
}

// Generate returns a random name like "blue-anvil".
func Generate() string {
	a := adjectives[rand.IntN(len(adjectives))]
	n := nouns[rand.IntN(len(nouns))]
	return fmt.Sprintf("%s-%s", a, n)
}
