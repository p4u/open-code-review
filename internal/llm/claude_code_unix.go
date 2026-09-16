//go:build !windows

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configureClaudeCodeProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		// Kill the group, not only the CLI: a hung child holding stdout must
		// not outlive a canceled review or its temporary working directory.
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}

func cleanupClaudeCodeProcess(cmd *exec.Cmd) {
	// WaitDelay closes inherited pipes but does not kill descendants when a
	// wrapper exits first. Kill the group before removing its working directory.
	if cmd.Process != nil {
		_ = cmd.Cancel()
	}
}
