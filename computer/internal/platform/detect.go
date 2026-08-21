package platform

// New returns the Platform implementation for the current OS.
func New() (Platform, error) {
	return newPlatform()
}
