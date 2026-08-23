package main

import "toad.computer/internal/workspace"

func runInit(args []string) error {
	return workspace.Init(args...)
}
