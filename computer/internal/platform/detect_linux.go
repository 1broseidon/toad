//go:build linux

package platform

func newPlatform() (Platform, error) {
	return &LinuxPlatform{}, nil
}
