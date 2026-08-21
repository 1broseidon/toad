package main

import "toad.sh/computer/internal/workspace"

func runInit(args []string) error {
	return workspace.Init(args...)
}
