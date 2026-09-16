//go:build windows

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import "os/exec"

func configureClaudeCodeProcess(cmd *exec.Cmd) {
	// CommandContext terminates the native CLI. Tools and customizations are
	// disabled, so the adapter does not launch shell or MCP child processes.
}

func cleanupClaudeCodeProcess(cmd *exec.Cmd) {
	// Run has already waited for the direct child. Unlike Unix process groups,
	// this transport does not manage detached descendants on Windows.
}
